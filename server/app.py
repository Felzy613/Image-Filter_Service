from __future__ import annotations

import base64
import ctypes
import hashlib
import importlib.util
import io
import json
import logging
import mmap
import os
import queue
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import List, Optional, Tuple, Union
from urllib.parse import urlparse

import certifi
import cv2
import numpy as np
import requests
from flask import Flask, jsonify, request, send_file, Response
from flask_cors import CORS
from PIL import Image, ImageOps


# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
    handlers=[logging.StreamHandler(sys.stdout)]
)
logger = logging.getLogger(__name__)

app = Flask(__name__)
CORS(app)


MAX_IMAGE_BYTES = 8 * 1024 * 1024  # 8MB
SKIN_RATIO_THRESHOLD = float(os.getenv("SKIN_RATIO_THRESHOLD", "0.001"))
SKIN_OVERLAY_ALPHA = float(os.getenv("SKIN_OVERLAY_ALPHA", "1.0"))
REQUEST_TIMEOUT = int(os.getenv("IMAGE_FETCH_TIMEOUT", "10"))

MODEL_URL = os.getenv(
    "SEGMENTATION_MODEL_URL",
    "https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_multiclass_256x256/float32/1/selfie_multiclass_256x256.tflite",
)
MODEL_PATH = Path(
    os.getenv(
        "SEGMENTATION_MODEL_PATH",
        str(Path(__file__).parent / "models" / "selfie_multiclass_256x256.tflite"),
    )
)

OUTPUT_MAX = 1280  # longest side of any image we decode / return

# --- Skin detection tuning (see detect_skin) -------------------------------------
# The model only ever sees 256×256. Squeezing a whole 1280×800 photo into that loses
# people who are small in the frame (groups, crowds, wide banners): measured on test
# composites, a single pass greyed only 14–29% of the skin in a group shot and ~75%
# in a 4:1 banner. Segmenting overlapping tiles as well brings that to ~98–99%.
SEG_WORK_MAX = int(os.getenv("SEG_WORK_MAX", "768"))      # resolution tiles are cut from
SEG_FULL_MAX = 320                                         # the whole-image pass
SEG_TILE = int(os.getenv("SEG_TILE", "384"))               # tile size for large images
SEG_TILE_MIN = 160                                         # smallest tile for small images
SEG_TILE_OVERLAP = 0.25
SEG_TILE_SKIP_MAX = 300      # ≤ this: the whole-image pass is already ≥0.85× scale
SEG_TILE_FLOOR = 64          # strips thinner than this get the whole-image pass only
SEG_TILE_MAX_COUNT = 16
# Pixel is skin when P(body-skin) + P(face-skin) exceeds this. Lower than the
# model's own argmax (≈0.5) on purpose: a missed skin pixel is visible, an extra
# grey pixel on a hairline or collar costs nothing.
SKIN_PROB_THRESHOLD = float(os.getenv("SKIN_PROB_THRESHOLD", "0.3"))
# Grow the mask by ~2px (at 768px) so skin edges don't peek out from the grey.
SKIN_DILATE_PER_PX = 1 / 384
# Tiny images (avatars, icons, logos) are stretched ~4–8× to reach the model's 256×256, and
# the model then sees a head in any round blob with empty space below it: a 40px blue
# letter avatar ("D" on a disc) came back 50–70% grey. On images up to this size, pixels
# whose *colour* no skin has are never skin (see _not_skin_colour). 0 turns it off.
# Measured on 1,120 synthetic letter avatars (24–128px): blue/purple/green/teal discs
# 13–16% grey → ~0%, red/orange/crimson 5–22% → 0.3–4%; brown discs (dark-skin colour)
# are unchanged. On real photos ≤256px it removed 0.7% of the flagged pixels on average
# (hair edges, a dandelion — no face), and above this size nothing changes.
SKIN_COLOUR_GATE_MAX = int(os.getenv("SKIN_COLOUR_GATE_MAX", "256"))

# --- Review log (opt-in; see _review_submit) ------------------------------------------
# Tuning accuracy needs real examples of mistakes. While this folder EXISTS, every picture
# the server greys is also saved here as a small thumbnail so the false positives can be
# looked at (server/review_report.py builds a page to click through them). Off by default:
# no folder, no log. Turn on:  mkdir -p "<this folder>"   off:  delete the folder.
# Only the *greyed* result is saved — exactly what the browser already showed, never the
# original — plus the site's host name (not the URL), the size and the skin share.
REVIEW_DIR = Path(os.getenv(
    "REVIEW_LOG_DIR",
    str(Path.home() / "Library" / "Application Support" / "Image-Filter-Service" / "review")))
REVIEW_MAX_FILES = int(os.getenv("REVIEW_LOG_MAX", "500"))   # oldest thumbnails go first
REVIEW_THUMB_MAX = 384                                       # longest side of a saved thumbnail
REVIEW_PRUNE_EVERY = 25                                      # writes between prune passes

# --- Inference engine sizing (see _Interpreter) ------------------------------------
# Memory, not CPU, is what limits parallel inference. Each interpreter needs ~60 MB of
# float32 activations at 256×256 (one 128×128×384 tensor alone is 24 MB) plus ~16 MB of
# packed weights; one MediaPipe ImageSegmenter per thread cost ~95 MB each, 8 of them
# ~1 GB. So: few interpreters, each spreading one inference over several cores with
# XNNPACK threads. Measured on an M4 Max (inferences/s, raw model):
#   1 × 8 threads: 135     2 × 4: 206     2 × 5: 212     3 × 3: 218     8 × 1: 236
# End to end (100 extension-like requests, 10 in flight; worker RSS warm / peak):
#   1 × 8: 3.4 s, 178 / 260 MB     2 × 4: 1.9 s, 258 / 340 MB     3 × 3: 1.6 s, 337 / 426 MB
#   4 × 2: 1.5 s, 415 / 503 MB     (8 MediaPipe segmenters: 1.45 s, 914 / 1074 MB)
# Two is the default: a quarter of the memory, one request alone is faster than before
# (p50 30 vs 37 ms, its passes split over both), a burst of 10 takes ~35% longer.
SEG_INTERPRETERS = max(1, int(os.getenv("SEG_INTERPRETERS", "2")))
SEG_INTERPRETER_THREADS = max(1, int(os.getenv(
    "SEG_INTERPRETER_THREADS", str(max(1, min(4, ((os.cpu_count() or 4) - 2) // SEG_INTERPRETERS))))))


def ensure_model() -> Path:
    MODEL_PATH.parent.mkdir(parents=True, exist_ok=True)
    if not MODEL_PATH.exists():
        logger.info(f"Downloading model from {MODEL_URL}")
        response = requests.get(MODEL_URL, timeout=REQUEST_TIMEOUT)
        response.raise_for_status()
        tmp = MODEL_PATH.with_suffix(".download")
        tmp.write_bytes(response.content)
        tmp.replace(MODEL_PATH)  # atomic: concurrent workers never see half a file
        logger.info(f"Model saved to {MODEL_PATH}")
    return MODEL_PATH


# --- Segmentation: the TFLite model run directly -----------------------------------
# MediaPipe's ImageSegmenter is a thin graph around TensorFlow Lite, and its native
# library (already a dependency) exports TFLite's C API and the XNNPACK delegate. Driving
# those through ctypes instead of the Python ImageSegmenter:
#   * skips importing mediapipe's Python package (it pulls in matplotlib and
#     sounddevice: ~20 MB RSS before any model exists),
#   * shares one model mapping between interpreters and lets each interpreter use
#     several cores, so few interpreters (the memory cost) keep most of the throughput.
# Pre- and post-processing copy MediaPipe's own (ImageToTensorCalculator,
# TensorsToSegmentationCalculator); checked on 40 test images at 64–384 px: confidence
# masks agree to 1e-5, and the final skin masks are bit-identical to the MediaPipe
# version's on all 280 test scene/size combinations (1 px to 1280 px).

def _find_native_lib() -> Path:
    spec = importlib.util.find_spec("mediapipe")  # locates the package without importing it
    if spec is None or spec.origin is None:
        raise RuntimeError("mediapipe is not installed")
    lib_dir = Path(spec.origin).parent / "tasks" / "c"
    for name in ("libmediapipe.dylib", "libmediapipe.so"):
        if (lib_dir / name).exists():
            return lib_dir / name
    raise RuntimeError(f"MediaPipe native library not found in {lib_dir}")


class _XnnpackOptions(ctypes.Structure):
    # TfLiteXNNPackDelegateOptions is returned by value and its layout changes between
    # TFLite versions; only `num_threads`, its first field, is ever set here. 256 bytes
    # is far more than the real struct (56 bytes in mediapipe 0.10.32), so the callee
    # never writes past it.
    _fields_ = [("num_threads", ctypes.c_int32), ("_rest", ctypes.c_uint8 * 252)]


class _TfLite:
    """The few TFLite C API functions we need, from MediaPipe's native library."""

    def __init__(self) -> None:
        lib = ctypes.CDLL(str(_find_native_lib()))  # CDLL calls release the GIL
        p, i32, size_t = ctypes.c_void_p, ctypes.c_int32, ctypes.c_size_t

        def fn(name, restype, *argtypes):
            f = getattr(lib, name)
            f.restype, f.argtypes = restype, list(argtypes)
            return f

        self.model_create = fn("TfLiteModelCreate", p, p, size_t)
        self.options_create = fn("TfLiteInterpreterOptionsCreate", p)
        self.options_set_threads = fn("TfLiteInterpreterOptionsSetNumThreads", None, p, i32)
        self.options_add_delegate = fn("TfLiteInterpreterOptionsAddDelegate", None, p, p)
        self.options_delete = fn("TfLiteInterpreterOptionsDelete", None, p)
        self.interpreter_create = fn("TfLiteInterpreterCreate", p, p, p)
        self.allocate_tensors = fn("TfLiteInterpreterAllocateTensors", ctypes.c_int, p)
        self.invoke = fn("TfLiteInterpreterInvoke", ctypes.c_int, p)
        self.input_tensor = fn("TfLiteInterpreterGetInputTensor", p, p, i32)
        self.output_tensor = fn("TfLiteInterpreterGetOutputTensor", p, p, i32)
        self.tensor_type = fn("TfLiteTensorType", ctypes.c_int, p)
        self.tensor_num_dims = fn("TfLiteTensorNumDims", i32, p)
        self.tensor_dim = fn("TfLiteTensorDim", i32, p, i32)
        self.copy_from = fn("TfLiteTensorCopyFromBuffer", ctypes.c_int, p, p, size_t)
        self.copy_to = fn("TfLiteTensorCopyToBuffer", ctypes.c_int, p, p, size_t)
        self.xnnpack_default_options = fn("TfLiteXNNPackDelegateOptionsDefault", _XnnpackOptions)
        self.xnnpack_create = fn("TfLiteXNNPackDelegateCreate", p, ctypes.POINTER(_XnnpackOptions))

    def shape(self, tensor: int) -> Tuple[int, ...]:
        return tuple(self.tensor_dim(tensor, d) for d in range(self.tensor_num_dims(tensor)))


_TFLITE_FLOAT32 = 1  # kTfLiteFloat32
# The model's input normalisation (its metadata: mean 127.5, std 127.5), applied the
# way MediaPipe's ImageToTensorCalculator does: pixel × 2/255 − 1.
_INPUT_SCALE = np.float32(2 / 255)
_INPUT_OFFSET = np.float32(-1)


class _Model:
    """The .tflite file, mapped once and shared by every interpreter.

    XNNPACK copies all weights into its own packed buffers while building an
    interpreter and never reads the file mapping again (checked with mincore: 0 pages
    touched after warm-up), yet the 16 MB of pages it read stay resident. They are clean
    file pages, so `release_pages` drops them (msync MS_INVALIDATE) — if anything does
    read them later, they are simply faulted back in from the file.
    """

    def __init__(self, tfl: _TfLite, path: Path) -> None:
        with open(path, "rb") as f:
            self._map = mmap.mmap(f.fileno(), 0, access=mmap.ACCESS_READ)
        # np.frombuffer gives the address of a read-only buffer; ctypes can't.
        self._addr = np.frombuffer(self._map, dtype=np.uint8).ctypes.data
        self.handle = tfl.model_create(self._addr, len(self._map))
        if not self.handle:
            raise RuntimeError(f"TFLite could not load {path}")

    def release_pages(self) -> None:
        try:
            libc = ctypes.CDLL(None)
            libc.msync.argtypes = [ctypes.c_void_p, ctypes.c_size_t, ctypes.c_int]
            libc.msync(self._addr, len(self._map), 0x2)  # MS_INVALIDATE (macOS and Linux)
        except Exception:
            pass  # purely an RSS saving


class _Interpreter:
    """One TFLite interpreter with its own XNNPACK delegate (own activation workspace
    and thread pool). Not thread-safe: `_infer` lends each to one thread at a time.
    One delegate shared by several interpreters would save the packed weights, but it
    also shares one workspace, so they run one at a time
    (measured: 4 interpreters on one delegate 56 img/s, with one delegate each 151).
    Interpreters are never deleted: they live as long as the worker process."""

    def __init__(self, tfl: _TfLite, model: _Model, threads: int) -> None:
        self._tfl = tfl
        self._model = model  # the model's mapping must outlive the interpreter
        xnn_options = tfl.xnnpack_default_options()
        xnn_options.num_threads = threads  # XNNPACK's own pool: one inference over N cores
        delegate = tfl.xnnpack_create(ctypes.byref(xnn_options))
        options = tfl.options_create()
        # 1 thread for the few ops XNNPACK doesn't take (the FPN's resize ops); they're cheap and a second TFLite pool would only cost memory.
        tfl.options_set_threads(options, 1)
        tfl.options_add_delegate(options, delegate)
        self._handle = tfl.interpreter_create(model.handle, options)
        tfl.options_delete(options)
        if not self._handle or tfl.allocate_tensors(self._handle) != 0:
            raise RuntimeError("TFLite interpreter creation failed")
        self._input = tfl.input_tensor(self._handle, 0)
        self._output = tfl.output_tensor(self._handle, 0)
        in_shape, out_shape = tfl.shape(self._input), tfl.shape(self._output)
        if (len(in_shape) != 4 or in_shape[0] != 1 or in_shape[3] != 3 or len(out_shape) != 4
                or out_shape[3] != 6 or tfl.tensor_type(self._input) != _TFLITE_FLOAT32
                or tfl.tensor_type(self._output) != _TFLITE_FLOAT32):
            raise RuntimeError(f"Unexpected segmentation model: input {in_shape}, output {out_shape}")
        self.input_size = (in_shape[2], in_shape[1])  # (w, h)
        self.output_shape = out_shape[1:]

    def run(self, x: np.ndarray) -> np.ndarray:
        """float32 (h, w, 3) input → float32 (h, w, 6) logits."""
        tfl = self._tfl
        if tfl.copy_from(self._input, x.ctypes.data, x.nbytes) != 0 or tfl.invoke(self._handle) != 0:
            raise RuntimeError("TFLite inference failed")
        logits = np.empty(self.output_shape, dtype=np.float32)
        if tfl.copy_to(self._output, logits.ctypes.data, logits.nbytes) != 0:
            raise RuntimeError("TFLite output copy failed")
        return logits


_idle_interpreters: "queue.SimpleQueue[_Interpreter]" = queue.SimpleQueue()
_engine_lock = threading.Lock()
_engine_ready = False
_model_input_size = (256, 256)


def _start_engine() -> None:
    """Load the model and build SEG_INTERPRETERS interpreters (once; retried on failure)."""
    global _engine_ready, _model_input_size
    with _engine_lock:
        if _engine_ready:
            return
        tfl = _TfLite()
        model = _Model(tfl, ensure_model())
        interpreters = [_Interpreter(tfl, model, SEG_INTERPRETER_THREADS) for _ in range(SEG_INTERPRETERS)]
        warm = np.zeros((*interpreters[0].input_size[::-1], 3), dtype=np.float32)
        for interpreter in interpreters:
            interpreter.run(warm)  # XNNPACK allocates its workspace on the first run
        model.release_pages()
        _model_input_size = interpreters[0].input_size
        for interpreter in interpreters:
            _idle_interpreters.put(interpreter)
        _engine_ready = True


def _infer(x: np.ndarray) -> np.ndarray:
    interpreter = _idle_interpreters.get()
    try:
        return interpreter.run(x)
    finally:
        _idle_interpreters.put(interpreter)


# All passes run here. Twice as many threads as interpreters, so one thread's pre/post-
# processing (~1–2 ms of numpy/OpenCV per pass) overlaps another's inference instead of
# leaving an interpreter idle.
_segment_pool = ThreadPoolExecutor(max_workers=2 * SEG_INTERPRETERS, thread_name_prefix="segment")


def _skin_probability(rgb: np.ndarray) -> np.ndarray:
    """P(body-skin) + P(face-skin) per pixel, float32 at rgb's size. Runs in the pool."""
    if not _engine_ready:
        _start_engine()
    h, w = rgb.shape[:2]
    mw, mh = _model_input_size
    # Like ImageToTensorCalculator (CPU): perspective-warp the whole image onto the input
    # (aspect ratio not kept), bilinear, replicated border; then normalise.
    transform = cv2.getPerspectiveTransform(
        np.float32([[0, h], [0, 0], [w, 0], [w, h]]), np.float32([[0, mh], [0, 0], [mw, 0], [mw, mh]]))
    tensor = cv2.warpPerspective(np.ascontiguousarray(rgb), transform, (mw, mh),
                                 flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)
    tensor = tensor.astype(np.float32)
    tensor *= _INPUT_SCALE
    tensor += _INPUT_OFFSET
    # Softmax over the 6 categories (the model outputs logits; MediaPipe applies the
    # metadata's SOFTMAX). Categories: 0 background, 1 hair, 2 body-skin, 3 face-skin,
    # 4 clothes, 5 others. Done on one contiguous plane per category: same result as
    # reducing over the last axis, in half the time (0.75 vs 1.6 ms).
    planes = np.moveaxis(_infer(tensor), -1, 0).copy()
    planes -= np.maximum.reduce(planes, axis=0)
    np.exp(planes, out=planes)
    prob = (planes[2] + planes[3]) / np.add.reduce(planes, axis=0)
    if prob.shape != (h, w):
        # MediaPipe resizes each confidence mask to the input size, bilinear.
        prob = cv2.resize(prob, (w, h), interpolation=cv2.INTER_LINEAR)
    return prob


def _fit(rgb: np.ndarray, max_dim: int) -> np.ndarray:
    h, w = rgb.shape[:2]
    if max(h, w) <= max_dim:
        return rgb
    r = max_dim / max(h, w)
    return cv2.resize(rgb, (max(1, round(w * r)), max(1, round(h * r))), interpolation=cv2.INTER_AREA)


def _not_skin_colour(rgb: np.ndarray) -> np.ndarray:
    """uint8 mask (1 = can't be skin) of pixels with a colour no human skin has, grown by 1px
    so anti-aliased edges go with them:
      - saturated blue / cyan / green / violet (hue 80°–290°, S > 0.55)
      - near-white (S ≤ 0.08, V ≥ 0.92): blank margins, not highlights, are what gets hit
      - vivid bright red / orange / pink (S > 0.8, V > 0.6): flat graphics; dark skin in
        warm shade is S ≈ 0.8 too but V < 0.5, so it stays out of this rule
    Deliberately leaves browns, tans, pinks and greys alone — black-and-white and tinted
    photos must still be filtered."""
    hsv = cv2.cvtColor(np.ascontiguousarray(rgb), cv2.COLOR_RGB2HSV_FULL)  # H 0..255 = 0..360°
    hue, sat, val = hsv[..., 0], hsv[..., 1], hsv[..., 2]
    bad = ((sat > 140) & (hue >= 57) & (hue <= 206)) \
        | ((sat <= 20) & (val >= 235)) \
        | ((sat > 204) & (val > 153))
    return cv2.dilate(bad.astype(np.uint8), np.ones((3, 3), np.uint8))


def _tile_origins(length: int, tile: int, step: int) -> List[int]:
    origins = list(range(0, max(1, length - tile) + 1, step))
    if origins[-1] != length - tile:
        origins.append(max(0, length - tile))
    return origins


def _tiles(h: int, w: int) -> List[Tuple[int, int, int]]:
    """Square (y, x, size) windows covering an h×w image, or [] if one pass is enough."""
    longest = max(h, w)
    if longest <= SEG_TILE_SKIP_MAX:
        return []  # the whole-image pass already sees it at ~full scale
    tile = SEG_TILE if longest >= SEG_TILE * 5 // 3 else max(SEG_TILE_MIN, round(longest * 0.6))
    tile = min(tile, h, w)  # banners: square tiles as tall as the image
    if tile < SEG_TILE_FLOOR or longest <= tile * 1.15:
        return []  # thin strips: tiles would be too small to contain a person
    step = max(1, int(tile * (1 - SEG_TILE_OVERLAP)))
    tiles = [(y, x, tile) for y in _tile_origins(h, tile, step) for x in _tile_origins(w, tile, step)]
    return tiles if len(tiles) <= SEG_TILE_MAX_COUNT else []


def load_image(image_data: Optional[str], image_url: Optional[str]) -> Image.Image:
    if image_data:
        img = _open_bytes(_decode_data_url(image_data))
    elif image_url:
        if image_url.startswith("data:image"):
            img = _open_bytes(_decode_data_url(image_url))
        else:
            # Normally the extension sends pixels; this is the last resort.
            response = _http.get(image_url, timeout=REQUEST_TIMEOUT, verify=certifi.where())
            response.raise_for_status()
            if len(response.content) > MAX_IMAGE_BYTES:
                raise ValueError("Image payload too large")
            img = _open_bytes(response.content)
            # The browser shows photos upright per EXIF; the data URL we return has no
            # EXIF, so rotate the pixels the same way or the result displays sideways.
            img = ImageOps.exif_transpose(img)
    else:
        raise ValueError("No image data or URL provided")

    if img.mode != "RGB":
        img = img.convert("RGB")

    # Hard cap: keep memory and transfer size in check.
    # Content script encodes at display size (up to 1280px); URL-downloaded images
    # may be larger and still need to be bounded.
    if img.width > OUTPUT_MAX or img.height > OUTPUT_MAX:
        ratio = min(OUTPUT_MAX / img.width, OUTPUT_MAX / img.height)
        new_size = (max(1, int(img.width * ratio)), max(1, int(img.height * ratio)))
        img = img.resize(new_size, Image.Resampling.BILINEAR)

    return img


def _decode_data_url(data: str) -> bytes:
    if data.startswith("data:"):
        data = data.split(",", 1)[1]
    if len(data) > MAX_IMAGE_BYTES * 4 // 3 + 4:
        raise ValueError("Image payload too large")
    return base64.b64decode(data)


def _open_bytes(img_bytes: bytes) -> Image.Image:
    if len(img_bytes) > MAX_IMAGE_BYTES:
        raise ValueError("Image payload too large")
    img = Image.open(io.BytesIO(img_bytes))
    # Big JPEGs: let libjpeg decode straight to ≥OUTPUT_MAX (1/2, 1/4, 1/8 scale)
    # instead of decoding every pixel and shrinking afterwards.
    if img.format == "JPEG":
        img.draft("RGB", (OUTPUT_MAX, OUTPUT_MAX))
    return img


# Shared HTTP connection pool for the URL fallback (keep-alive across requests).
_http = requests.Session()
_http.headers.update({
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 '
                  '(KHTML, like Gecko) Version/18.0 Safari/605.1.15',
    'Accept': 'image/webp,image/png,image/jpeg,image/*;q=0.8,*/*;q=0.5',
})


def detect_skin(img: Image.Image) -> Tuple[bool, Optional[np.ndarray], float]:
    """Find skin. Returns (contains_skin, mask 0..255 at img size or None, skin_ratio).

    1. Work on a ≤SEG_WORK_MAX copy.
    2. Segment the whole image (≤320px) and, for anything larger than one tile,
       overlapping square tiles — so small people and wide banners get the model's
       full 256×256 attention — all in parallel on the segmenter pool.
    3. Skin probability = max over all passes; on tiny images, zero it where the colour
       can't be skin (SKIN_COLOUR_GATE_MAX); threshold at SKIN_PROB_THRESHOLD and
       grow by ~2px.
    """
    rgb = np.asarray(img)
    work = _fit(rgb, SEG_WORK_MAX)
    h, w = work.shape[:2]

    tiles = _tiles(h, w)
    full = _segment_pool.submit(_skin_probability, _fit(work, SEG_FULL_MAX))
    parts = [(t, _segment_pool.submit(_skin_probability, work[t[0]:t[0] + t[2], t[1]:t[1] + t[2]]))
             for t in tiles]

    prob = cv2.resize(full.result(), (w, h), interpolation=cv2.INTER_LINEAR)
    for (y, x, size), future in parts:
        np.maximum(prob[y:y + size, x:x + size], future.result(), out=prob[y:y + size, x:x + size])

    if max(h, w) <= SKIN_COLOUR_GATE_MAX:
        prob[_not_skin_colour(work) > 0] = 0

    mask = (prob > SKIN_PROB_THRESHOLD).astype(np.uint8)
    radius = max(1, round(max(h, w) * SKIN_DILATE_PER_PX))
    mask = cv2.dilate(mask, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * radius + 1, 2 * radius + 1)))

    skin_ratio = float(np.count_nonzero(mask)) / float(mask.size)
    if skin_ratio < SKIN_RATIO_THRESHOLD:
        return False, None, skin_ratio

    # Upscale to the output size; bilinear gives smooth edges (intentional).
    mask *= 255
    if (w, h) != img.size:
        mask = cv2.resize(mask, img.size, interpolation=cv2.INTER_LINEAR)
    return True, mask, skin_ratio


def apply_grey_overlay(img: Image.Image, mask: np.ndarray) -> Image.Image:
    """(1 − a)·image + a·grey with a = SKIN_OVERLAY_ALPHA × mask/255."""
    # Same integer formula as before, in uint16 and in place: the largest intermediate,
    # rgb·(255 − a) + 128·a + 127, is ≤ 65152, so it fits. The int32 version made ~50 MB
    # of temporaries for one 1280×800 image; this makes ~13 MB.
    rgb = np.asarray(img)
    alpha = mask.astype(np.uint16)
    alpha *= min(255, max(0, round(255 * SKIN_OVERLAY_ALPHA)))
    alpha //= 255
    blended = np.multiply(rgb, (255 - alpha)[:, :, None], dtype=np.uint16)
    alpha *= 128
    alpha += 127
    blended += alpha[:, :, None]
    blended //= 255
    return Image.fromarray(blended.astype(np.uint8), "RGB")


def image_to_data_url(img: Image.Image) -> str:
    buffer = io.BytesIO()
    img.save(buffer, format="JPEG", quality=90)
    encoded = base64.b64encode(buffer.getvalue()).decode("utf-8")
    return f"data:image/jpeg;base64,{encoded}"


# --- Review log ------------------------------------------------------------------------
# Requests only shrink the picture and queue it; one background thread hashes, encodes and
# writes, so the log never adds latency to a response. The queue holds small thumbnails and
# drops new ones when full rather than grow.
_review_queue: "queue.Queue[tuple]" = queue.Queue(maxsize=32)
_review_thread: Optional[threading.Thread] = None
_review_thread_lock = threading.Lock()


def _review_submit(filtered_img: Image.Image, w: int, h: int, skin_ratio: float,
                   image_url: Optional[str]) -> None:
    """Queue a greyed picture for the review log if the review folder exists. Never raises."""
    global _review_thread
    try:
        if not REVIEW_DIR.is_dir():
            return
        longest = max(filtered_img.size)
        thumb = filtered_img
        if longest > REVIEW_THUMB_MAX:
            r = REVIEW_THUMB_MAX / longest
            thumb = filtered_img.resize((max(1, round(filtered_img.width * r)),
                                         max(1, round(filtered_img.height * r))),
                                        Image.Resampling.BILINEAR)
        host = ""
        if image_url and image_url.startswith(("http://", "https://")):
            host = (urlparse(image_url).hostname or "")[:100]
        elif image_url:
            host = "(inline)"
        with _review_thread_lock:
            if _review_thread is None:
                _review_thread = threading.Thread(target=_review_worker, name="review-log", daemon=True)
                _review_thread.start()
                logger.info(f"Review log ON: saving greyed thumbnails to {REVIEW_DIR}")
        _review_queue.put_nowait((thumb, w, h, skin_ratio, host, time.time()))
    except queue.Full:
        pass
    except Exception as exc:
        logger.warning(f"Review log skipped: {exc}")


def _review_worker() -> None:
    writes = 0
    while True:
        thumb, w, h, ratio, host, ts = _review_queue.get()
        try:
            if not REVIEW_DIR.is_dir():
                continue
            # Same greyed picture → same name: icons and logos repeat constantly, keep one.
            name = hashlib.sha1(thumb.tobytes() + str(thumb.size).encode()).hexdigest()[:12] + ".jpg"
            path = REVIEW_DIR / name
            if path.exists():
                continue
            tmp = REVIEW_DIR / (name + ".tmp")
            thumb.save(tmp, "JPEG", quality=80)
            os.replace(tmp, path)
            with open(REVIEW_DIR / "index.jsonl", "a", encoding="utf-8") as f:
                f.write(json.dumps({"ts": int(ts), "file": name, "w": w, "h": h,
                                    "ratio": round(ratio, 4), "host": host}) + "\n")
            writes += 1
            if writes % REVIEW_PRUNE_EVERY == 0:
                _review_prune()
        except Exception as exc:
            logger.warning(f"Review log write failed: {exc}")
        finally:
            _review_queue.task_done()


def _review_prune() -> None:
    """Keep the newest REVIEW_MAX_FILES thumbnails and drop index lines for the rest."""
    files = sorted(REVIEW_DIR.glob("*.jpg"), key=lambda p: p.stat().st_mtime, reverse=True)
    for old in files[REVIEW_MAX_FILES:]:
        old.unlink(missing_ok=True)
    index = REVIEW_DIR / "index.jsonl"
    if index.exists():
        keep = []
        for line in index.read_text(encoding="utf-8").splitlines():
            try:
                if (REVIEW_DIR / json.loads(line)["file"]).exists():
                    keep.append(line)
            except Exception:
                continue
        tmp = REVIEW_DIR / "index.jsonl.tmp"
        tmp.write_text("\n".join(keep) + ("\n" if keep else ""), encoding="utf-8")
        os.replace(tmp, index)


@app.get("/uptime")
def health() -> Tuple[dict, int]:
    return {"status": "ok"}, 501

@app.get("/")
def home():
    return "Service Is running!", 200


@app.route("/api/filter-image", methods=["GET", "POST"])
def filter_image() -> Union[Response, Tuple[dict, int]]:
    start = time.perf_counter()
    
    # Handle GET requests with URL parameter (fastest - MB Filter approach)
    if request.method == "GET":
        image_url = request.args.get("url")
        if not image_url:
            return ({"success": False, "error": "No URL parameter provided"}, 400)
        
        try:
            img = load_image(None, image_url)
            contains_skin, mask, skin_ratio = detect_skin(img)

            filtered_img = apply_grey_overlay(img, mask) if mask is not None else img

            img_io = io.BytesIO()
            filtered_img.save(img_io, 'JPEG', quality=90)
            img_io.seek(0)

            processing_time = int((time.perf_counter() - start) * 1000)
            logger.info(f"GET filtered={contains_skin} {processing_time}ms {image_url}")

            return send_file(img_io, mimetype='image/jpeg')
            
        except Exception as e:
            logger.error(f"Error processing image: {e}")
            return ({"success": False, "error": str(e)}, 500)
    
    # Handle POST requests with JSON payload (for base64 data URLs)
    payload = request.get_json(silent=True) or {}
    image_data = payload.get("imageData")
    image_url = payload.get("imageUrl")

    try:
        img = load_image(image_data, image_url)
        w, h = img.size
        contains_skin, mask, skin_ratio = detect_skin(img)

        if mask is not None:
            filtered_img = apply_grey_overlay(img, mask)
            filtered_image_url = image_to_data_url(filtered_img)
            filtered = True
            _review_submit(filtered_img, w, h, skin_ratio, image_url)
        else:
            # Return null so the client reveals the original src URL instead of
            # round-tripping the full base64 payload back (~90% of requests).
            filtered_image_url = None
            filtered = False

        processing_time = int((time.perf_counter() - start) * 1000)
        logger.info(f"POST {w}x{h} filtered={filtered} ratio={skin_ratio:.4f} {processing_time}ms")

        return (
            {
                "success": True,
                "filteredImageUrl": filtered_image_url,
                "filtered": filtered,
                "containsSkin": contains_skin,
                "skinRatio": skin_ratio,
                "processingTime": processing_time,
            },
            200,
        )
    except Exception as exc:
        processing_time = int((time.perf_counter() - start) * 1000)
        logger.error(f"POST error {processing_time}ms: {exc}", exc_info=True)
        return (
            {
                "success": True,  # avoid error handling on the client; keep image hidden
                "error": str(exc),
                "filteredImageUrl": None,
                "filtered": False,
                "containsSkin": False,
                "skinRatio": 0.0,
                "processingTime": processing_time,
            },
            200,
        )


# Load the model when the module is imported so each Gunicorn worker has its
# interpreters built (~0.2 s) before the first real request arrives.
try:
    _t0 = time.perf_counter()
    _start_engine()
    logger.info(f"{SEG_INTERPRETERS} interpreter(s) x {SEG_INTERPRETER_THREADS} thread(s) ready "
                f"in {int((time.perf_counter() - _t0) * 1000)}ms")
except Exception as _warmup_err:
    logger.warning(f"Segmentation model warmup failed (will retry on first request): {_warmup_err}")


if __name__ == "__main__":
    logger.info("Starting Image Filter Service")
    logger.info(f"threshold={SKIN_RATIO_THRESHOLD} alpha={SKIN_OVERLAY_ALPHA} max={MAX_IMAGE_BYTES//1024//1024}MB")
    app.run(host="0.0.0.0", port=int(os.getenv("PORT", "10000")), threaded=True, debug=False)