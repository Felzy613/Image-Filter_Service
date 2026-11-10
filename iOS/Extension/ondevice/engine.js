// On-device skin filter (iOS extension) — no server.
//
// Same model and the same maths as server/app.py, so iPhone and Mac agree:
//   detect_skin():        work on a ≤768px copy. Segment the whole image (≤320px) and, for
//                         anything larger than one tile, overlapping square tiles, so small
//                         people and wide banners get the model's full 256×256 attention.
//                         Skin probability = P(body-skin) + P(face-skin), max over all
//                         passes; on images ≤256px, zero it where the colour can't be skin
//                         (saturated blue/green/violet, white, vivid red/orange); skin
//                         where > 0.3; grow by ~2px (elliptical, radius = longest side /
//                         384); filter when ≥0.1% of pixels are skin.
//   apply_grey_overlay(): bilinear-upscale the mask and blend grey (128) over the image,
//                         alpha = SKIN_OVERLAY_ALPHA × mask (1.0 = fully grey).
// Only difference: tiles bigger than 256px are shrunk to 256 (the model's input size) on a
// canvas instead of inside MediaPipe — same masks (measured), ~15% faster.
//
// Modes (option `mode` of analyze / analyzeDataUrl / filterUrl):
//   'full' (default) — the server's tiling: 5–9 inferences for a typical 512–768px image.
//                      Use for pictures.
//   'fast'           — for video frames: the whole-image pass plus square tiles as tall as
//                      the frame, just enough to cover it (3 inferences for 16:9, 1 for a
//                      square frame). Undistorts wide frames; on 16:9 test frames it found
//                      the same skin as 'full' (≥98% of the server's), but it doesn't zoom
//                      in on small people (tiny-face crowd: 88% vs 95%).
//   'single'         — the whole-image pass only (1 inference). Fastest; misses skin on
//                      small/wide subjects (16:9 wide shot 91%, 4:1 banner 19%).
// Every inference costs about the same whatever the input size (the model always sees
// 256×256), so latency is set by the number of passes, not by the pixels sent.
//
// Loaded lazily by background.js with import(). Runs in the extension's background page;
// MediaPipe executes the model in WebAssembly (on the GPU via WebGL2 when available),
// entirely on the device.

import { ImageSegmenter } from './vision_bundle.js';

// --- detect_skin() tuning, keep in sync with server/app.py ------------------------------
export const SEG_WORK_MAX = 768;   // resolution tiles are cut from
const SEG_FULL_MAX = 320;          // the whole-image pass
const SEG_TILE = 384;              // tile size for large images
const SEG_TILE_MIN = 160;          // smallest tile for small images
const SEG_TILE_OVERLAP = 0.25;
const SEG_TILE_SKIP_MAX = 300;     // ≤ this: the whole-image pass is enough
const SEG_TILE_FLOOR = 64;         // thinner strips get the whole-image pass only
const SEG_TILE_MAX_COUNT = 16;
const SKIN_PROB_THRESHOLD = 0.3;   // P(body-skin) + P(face-skin) above this is skin
const SKIN_DILATE_PER_PX = 1 / 384;
// Images up to this size (longest side of the work copy) never grey pixels whose colour no
// skin has — tiny avatars/icons are stretched to the model's 256 and it hallucinates a head
// in a blue letter avatar (see _not_skin_colour in server/app.py). Must stay ≤ SEG_FULL_MAX:
// the pixels are read back from the whole-image canvas, which is the work copy only then.
const SKIN_COLOUR_GATE_MAX = 256;
const SKIN_RATIO_THRESHOLD = 0.001;
const MODEL_INPUT = 256;           // selfie_multiclass_256x256
// Largest picture worth sending to analyzeDataUrl(): bigger ones are shrunk to this first.
// Smaller ones lose skin on small people (see the tiling notes in server/app.py).
export const SEG_MAX = SEG_WORK_MAX;
const OUTPUT_MAX = 1280;           // load_image() max_dimension
const SVG_MIN = 300;               // rasterise vector images at least this big
export const OVERLAY_ALPHA = 1.0;  // server default (SKIN_OVERLAY_ALPHA)
const BODY_SKIN = 2;               // confidence masks: 0 background, 1 hair, 2 body-skin,
const FACE_SKIN = 3;               // 3 face-skin, 4 clothes, 5 others

let segmenterPromise = null;
let activeSegmenter = null;
const segmenterDelegates = new WeakMap();
export let delegate = null;   // 'GPU' or 'CPU', whichever loaded

// MediaPipe's WASM loader injects a <script> into document.body.
function ensureDocumentBody() {
    if (!document.body) {
        document.documentElement.appendChild(document.createElement('body'));
    }
}

// (Streaming the model in as a ReadableStream was measured to use MORE memory — ~66 MB more
// steady, ~80 MB higher peak — so the plain path is used.)
function createSegmenter(which) {
    const base = new URL('./', import.meta.url).href;
    return ImageSegmenter.createFromOptions(
        {
            // Only the SIMD build is bundled (Safari ≥ 16.4), so skip FilesetResolver.
            wasmLoaderPath: base + 'vision_wasm_internal.js',
            wasmBinaryPath: base + 'vision_wasm_internal.wasm'
        },
        {
            baseOptions: {
                modelAssetPath: base + 'selfie_multiclass_256x256.tflite',
                delegate: which
            },
            runningMode: 'IMAGE',
            outputCategoryMask: false,
            outputConfidenceMasks: true
        }
    );
}

// The first inference compiles shaders / sets up the graph (hundreds of ms to over a
// second). Do it now, while the page is still loading, instead of on the first real
// picture. Also proves the delegate works, and self-tests the GPU mask sum (below) on a
// picture whose masks aren't uniform.
function warmUp(segmenter) {
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const ctx = c.getContext('2d');
    const gradient = ctx.createLinearGradient(0, 0, 64, 64);
    gradient.addColorStop(0, '#2a4d7a');
    gradient.addColorStop(1, '#e8d2b0');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, 64, 64);
    ctx.fillStyle = '#d9a07a';
    ctx.beginPath();
    ctx.ellipse(40, 22, 14, 18, 0, 0, 2 * Math.PI);
    ctx.fill();
    segmenter.segment(c, result => {
        checkGpuSum(result.confidenceMasks);
        skinProbability(result.confidenceMasks);
    });
}

async function loadSegmenter(which) {
    const segmenter = await createSegmenter(which);
    try {
        warmUp(segmenter);
    } catch (error) {
        segmenter.close();
        throw error;
    }
    delegate = which;
    activeSegmenter = segmenter;
    segmenterDelegates.set(segmenter, which);
    return segmenter;
}

// Load WASM + model once per background-page lifetime. GPU (WebGL2) is ~5× faster per
// inference than CPU (iOS Simulator: ~30 ms vs ~180 ms, near-identical masks); if WebGL
// isn't available or fails, fall back to CPU. Concurrent callers share the promise; a
// failed load is forgotten so the next call retries.
export function init() {
    if (!segmenterPromise) {
        segmenterPromise = (async () => {
            ensureDocumentBody();
            try {
                return await loadSegmenter('GPU');
            } catch (error) {
                console.warn('[Image Filter engine] GPU delegate unavailable, using CPU:', error);
                return loadSegmenter('CPU');
            }
        })();
        segmenterPromise.catch(() => { segmenterPromise = null; });
    }
    return segmenterPromise;
}

// Free the model, the WebAssembly instance and the GPU resources. background.js calls this
// after a minute with nothing to check; the next picture loads it again (~0.3–0.6 s, started
// as soon as a page opens). Only call it with no analysis in flight.
export function release() {
    const segmenter = activeSegmenter;
    activeSegmenter = null;
    segmenterPromise = null;
    delegate = null;
    if (segmenter) {
        try { segmenter.close(); } catch { /* already gone */ }
    }
    for (const name of Object.keys(canvases)) {
        canvases[name].width = 0;
        canvases[name].height = 0;
        delete canvases[name];
    }
}

// If the GPU path breaks mid-session (e.g. WebGL context lost), rebuild on CPU once.
// Callers that hit the same broken segmenter share the replacement.
function fallBackToCpu(failed, error) {
    if (failed !== activeSegmenter) return init();
    console.warn('[Image Filter engine] GPU segmentation failed, switching to CPU:', error);
    activeSegmenter = null;
    try { failed.close(); } catch { /* already broken */ }
    segmenterPromise = loadSegmenter('CPU');
    segmenterPromise.catch(() => { segmenterPromise = null; });
    return segmenterPromise;
}

// Python's round() (half to even), so sizes match server/app.py exactly.
function pyRound(x) {
    const r = Math.round(x);
    return (r - x === 0.5 && r % 2 !== 0) ? r - 1 : r;
}

export function fitWithin(w, h, max) {
    if (w <= max && h <= max) return { w, h };
    const r = Math.min(max / w, max / h);
    return { w: Math.max(1, pyRound(w * r)), h: Math.max(1, pyRound(h * r)) };
}

// --- Tiling -------------------------------------------------------------------------------
// server/app.py _tile_origins / _tiles: square { y, x, size } windows covering an h×w
// image, or [] if the whole-image pass is enough.
function tileOrigins(length, tile, step) {
    const origins = [];
    for (let o = 0; o <= Math.max(1, length - tile); o += step) origins.push(o);
    if (origins[origins.length - 1] !== length - tile) origins.push(Math.max(0, length - tile));
    return origins;
}

export function tilesFor(h, w) {
    const longest = Math.max(h, w);
    if (longest <= SEG_TILE_SKIP_MAX) return [];
    let tile = longest >= Math.floor(SEG_TILE * 5 / 3) ? SEG_TILE
        : Math.max(SEG_TILE_MIN, pyRound(longest * 0.6));
    tile = Math.min(tile, h, w);  // banners: square tiles as tall as the image
    if (tile < SEG_TILE_FLOOR || longest <= tile * 1.15) return [];
    const step = Math.max(1, Math.floor(tile * (1 - SEG_TILE_OVERLAP)));
    const tiles = [];
    for (const y of tileOrigins(h, tile, step)) {
        for (const x of tileOrigins(w, tile, step)) tiles.push({ y, x, size: tile });
    }
    return tiles.length <= SEG_TILE_MAX_COUNT ? tiles : [];
}

// 'fast' mode: square tiles as big as the short side, just enough to span the long side
// (none when the frame is already about square).
export function frameTiles(h, w) {
    const short = Math.min(h, w), long = Math.max(h, w);
    if (short < SEG_TILE_FLOOR || long <= short * 1.15) return [];
    const n = Math.ceil(long / short), tiles = [];
    for (let i = 0; i < n; i++) {
        const o = Math.round(i * (long - short) / (n - 1));
        tiles.push(w >= h ? { y: 0, x: o, size: short } : { y: o, x: 0, size: short });
    }
    return tiles;
}

// --- Pixel helpers --------------------------------------------------------------------------
// Reused scratch canvases. Everything between `await init()` and the result is synchronous,
// so concurrent analyze() calls never interleave on them.
const canvases = {};
function scratch(name, w, h) {
    let canvas = canvases[name];
    if (!canvas) canvas = canvases[name] = document.createElement('canvas');
    if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
    }
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';  // closest to the server's INTER_AREA shrink
    return { canvas, ctx };
}

// Bilinear resize of a float map with cv2.INTER_LINEAR geometry (pixel centres aligned).
function resizeBilinear(src, sw, sh, dw, dh) {
    if (sw === dw && sh === dh) return src;
    const out = new Float32Array(dw * dh);
    const fx = sw / dw, fy = sh / dh;
    const x0s = new Int32Array(dw), x1s = new Int32Array(dw), wxs = new Float32Array(dw);
    for (let x = 0; x < dw; x++) {
        const sx = Math.max(0, (x + 0.5) * fx - 0.5);
        const x0 = Math.min(Math.floor(sx), sw - 1);
        x0s[x] = x0;
        x1s[x] = Math.min(x0 + 1, sw - 1);
        wxs[x] = sx - x0;
    }
    for (let y = 0; y < dh; y++) {
        const sy = Math.max(0, (y + 0.5) * fy - 0.5);
        const y0 = Math.min(Math.floor(sy), sh - 1);
        const r0 = y0 * sw, r1 = Math.min(y0 + 1, sh - 1) * sw;
        const wy = sy - y0, o = y * dw;
        for (let x = 0; x < dw; x++) {
            const a = src[r0 + x0s[x]], b = src[r0 + x1s[x]];
            const c = src[r1 + x0s[x]], d = src[r1 + x1s[x]];
            const top = a + (b - a) * wxs[x], bottom = c + (d - c) * wxs[x];
            out[o + x] = top + (bottom - top) * wy;
        }
    }
    return out;
}

// Dilate a 0/1 mask with OpenCV's MORPH_ELLIPSE (2r+1)×(2r+1) kernel — row dy of the kernel
// spans ±round(√(r² − dy²)) — ignoring pixels outside the image (cv2.dilate's default).
function dilateEllipse(mask, w, h, r) {
    const halves = [];
    for (let dy = -r; dy <= r; dy++) halves.push(Math.round(r * Math.sqrt((r * r - dy * dy) / (r * r))));
    // Horizontal dilation once per distinct half-width, via per-row prefix counts.
    const rows = new Map();
    const prefix = new Int32Array(w + 1);
    for (const k of new Set(halves)) {
        if (k === 0) { rows.set(0, mask); continue; }
        const out = new Uint8Array(w * h);
        for (let y = 0; y < h; y++) {
            const o = y * w;
            for (let x = 0; x < w; x++) prefix[x + 1] = prefix[x] + mask[o + x];
            for (let x = 0; x < w; x++) {
                out[o + x] = prefix[Math.min(w, x + k + 1)] - prefix[Math.max(0, x - k)] > 0 ? 1 : 0;
            }
        }
        rows.set(k, out);
    }
    const out = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
        const o = y * w;
        for (let i = 0; i < halves.length; i++) {
            const sy = y + i - r;
            if (sy < 0 || sy >= h) continue;
            const src = rows.get(halves[i]), so = sy * w;
            for (let x = 0; x < w; x++) out[o + x] |= src[so + x];
        }
    }
    return out;
}

// Pixels (1 = can't be skin) whose colour no human skin has, grown by 1px so anti-aliased
// edges go with them — _not_skin_colour() in server/app.py, same rules on OpenCV's 8-bit HSV
// (H 0..255 = 0..360°, rounded the same way):
//   saturated blue/cyan/green/violet (hue 80°–290°, S > 0.55), near-white (S ≤ 0.08, V ≥ 0.92),
//   vivid bright red/orange/pink (S > 0.8, V > 0.6).
// Browns, tans, pinks and greys are left alone: black-and-white and tinted photos must still
// be filtered.
function notSkinColour(rgba, w, h) {
    const bad = new Uint8Array(w * h);
    for (let i = 0, p = 0; i < bad.length; i++, p += 4) {
        const r = rgba[p], g = rgba[p + 1], b = rgba[p + 2];
        const v = Math.max(r, g, b), diff = v - Math.min(r, g, b);
        const s = v ? Math.round(255 * diff / v) : 0;
        let hue = 0;
        if (diff) {
            const raw = v === r ? g - b : v === g ? b - r + 2 * diff : r - g + 4 * diff;
            hue = Math.round(256 * raw / (6 * diff));
            if (hue < 0) hue += 256;
        }
        if ((s > 140 && hue >= 57 && hue <= 206) || (s <= 20 && v >= 235) || (s > 204 && v > 153)) {
            bad[i] = 1;
        }
    }
    // 3×3 box dilation (cv2.dilate with np.ones((3, 3))): rows, then columns.
    const rows = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
        const o = y * w;
        for (let x = 0; x < w; x++) {
            rows[o + x] = bad[o + x] | (x > 0 ? bad[o + x - 1] : 0) | (x < w - 1 ? bad[o + x + 1] : 0);
        }
    }
    const grown = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
        const o = y * w;
        for (let x = 0; x < w; x++) {
            grown[o + x] = rows[o + x] | (y > 0 ? rows[o - w + x] : 0) | (y < h - 1 ? rows[o + w + x] : 0);
        }
    }
    return grown;
}

// --- Reading P(skin) ----------------------------------------------------------------------
// With the GPU delegate the masks are WebGL textures, and MPMask.getAsFloat32Array() reads
// each back as RGBA float32 (16 bytes per pixel) behind its own GPU sync — two masks per
// pass made that ~60% of the time in the simulator. Instead add body + face on the GPU, in
// MediaPipe's own WebGL2 context, into one RGBA8 texture holding the sum as 16-bit fixed
// point (error ≤ 1/131070, far too small to move the 0.3 threshold), and read that once:
// ~25% faster, identical masks. The warm-up self-test compares it with the float path; on
// any mismatch or GL error the engine quietly reads floats instead.
const SUM_VS = `#version 300 es
void main() {
    vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
    gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;
const SUM_FS = `#version 300 es
precision highp float;
precision highp sampler2D;
uniform sampler2D u_body;
uniform sampler2D u_face;
out vec4 color;
void main() {
    ivec2 p = ivec2(gl_FragCoord.xy);
    float s = texelFetch(u_body, p, 0).r + texelFetch(u_face, p, 0).r;
    float v = floor(clamp(s, 0.0, 1.0) * 65535.0 + 0.5);
    float hi = floor(v / 256.0);
    color = vec4(hi, v - hi * 256.0, 0.0, 255.0) / 255.0;
}`;
let gpuSumEnabled = true;          // cleared by the self-test or any GL failure
const gpuSummers = new WeakMap();  // WebGL2 context → { program, … } or false (unusable)

function gpuSummer(gl) {
    let summer = gpuSummers.get(gl);
    if (summer !== undefined) return summer;
    summer = false;
    try {
        const program = gl.createProgram();
        for (const [type, source] of [[gl.VERTEX_SHADER, SUM_VS], [gl.FRAGMENT_SHADER, SUM_FS]]) {
            const shader = gl.createShader(type);
            gl.shaderSource(shader, source);
            gl.compileShader(shader);
            if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader));
            gl.attachShader(program, shader);
        }
        gl.linkProgram(program);
        if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program));
        summer = {
            program,
            uBody: gl.getUniformLocation(program, 'u_body'),
            uFace: gl.getUniformLocation(program, 'u_face'),
            vao: gl.createVertexArray(),
            fbo: gl.createFramebuffer(),
            tex: gl.createTexture(),
            w: 0, h: 0, pixels: null
        };
    } catch (error) {
        console.warn('[Image Filter engine] GPU mask sum unavailable:', error);
    }
    gpuSummers.set(gl, summer);
    return summer;
}

// Run fn with every piece of GL state it may touch saved and restored, so MediaPipe finds
// its context exactly as it left it.
function preservingGlState(gl, fn) {
    const caps = [gl.BLEND, gl.DEPTH_TEST, gl.SCISSOR_TEST, gl.STENCIL_TEST, gl.CULL_FACE,
        gl.DITHER, gl.RASTERIZER_DISCARD, gl.SAMPLE_ALPHA_TO_COVERAGE, gl.SAMPLE_COVERAGE];
    const saved = {
        drawFb: gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING),
        readFb: gl.getParameter(gl.READ_FRAMEBUFFER_BINDING),
        program: gl.getParameter(gl.CURRENT_PROGRAM),
        vao: gl.getParameter(gl.VERTEX_ARRAY_BINDING),
        viewport: gl.getParameter(gl.VIEWPORT),
        colorMask: gl.getParameter(gl.COLOR_WRITEMASK),
        packBuffer: gl.getParameter(gl.PIXEL_PACK_BUFFER_BINDING),
        packAlignment: gl.getParameter(gl.PACK_ALIGNMENT),
        activeTexture: gl.getParameter(gl.ACTIVE_TEXTURE),
        caps: caps.map(cap => gl.isEnabled(cap)),
        units: []
    };
    for (let i = 0; i < 2; i++) {
        gl.activeTexture(gl.TEXTURE0 + i);
        saved.units.push([gl.getParameter(gl.TEXTURE_BINDING_2D), gl.getParameter(gl.SAMPLER_BINDING)]);
    }
    try {
        caps.forEach(cap => gl.disable(cap));
        gl.colorMask(true, true, true, true);
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
        gl.pixelStorei(gl.PACK_ALIGNMENT, 4);
        return fn();
    } finally {
        saved.units.forEach(([tex, sampler], unit) => {
            gl.activeTexture(gl.TEXTURE0 + unit);
            gl.bindTexture(gl.TEXTURE_2D, tex);
            gl.bindSampler(unit, sampler);
        });
        gl.activeTexture(saved.activeTexture);
        gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, saved.drawFb);
        gl.bindFramebuffer(gl.READ_FRAMEBUFFER, saved.readFb);
        gl.useProgram(saved.program);
        gl.bindVertexArray(saved.vao);
        gl.viewport(...saved.viewport);
        gl.colorMask(...saved.colorMask);
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, saved.packBuffer);
        gl.pixelStorei(gl.PACK_ALIGNMENT, saved.packAlignment);
        caps.forEach((cap, i) => saved.caps[i] ? gl.enable(cap) : gl.disable(cap));
    }
}

// body + face summed on the GPU, as a Float32Array; null when that isn't possible.
function sumOnGpu(body, face) {
    const gl = body.canvas && body.canvas.getContext('webgl2');
    const summer = gl && !gl.isContextLost() && gpuSummer(gl);
    if (!summer) return null;
    const w = body.width, h = body.height;
    const texBody = body.getAsWebGLTexture(), texFace = face.getAsWebGLTexture();
    preservingGlState(gl, () => {
        gl.activeTexture(gl.TEXTURE0);
        gl.bindSampler(0, null);
        gl.bindSampler(1, null);
        if (summer.w !== w || summer.h !== h) {
            gl.bindTexture(gl.TEXTURE_2D, summer.tex);
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
            gl.bindFramebuffer(gl.FRAMEBUFFER, summer.fbo);
            gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, summer.tex, 0);
            summer.w = w;
            summer.h = h;
            summer.pixels = new Uint8Array(w * h * 4);
        }
        gl.bindFramebuffer(gl.FRAMEBUFFER, summer.fbo);
        // A float texture with LINEAR filtering can be "incomplete" (texelFetch then reads
        // 0), so sample the masks NEAREST and put their filters back afterwards.
        const filters = [];
        for (const [unit, tex] of [[0, texBody], [1, texFace]]) {
            gl.activeTexture(gl.TEXTURE0 + unit);
            gl.bindTexture(gl.TEXTURE_2D, tex);
            filters.push([unit, tex, gl.getTexParameter(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER),
                gl.getTexParameter(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER)]);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        }
        try {
            gl.useProgram(summer.program);
            gl.uniform1i(summer.uBody, 0);
            gl.uniform1i(summer.uFace, 1);
            gl.bindVertexArray(summer.vao);
            gl.viewport(0, 0, w, h);
            gl.drawArrays(gl.TRIANGLES, 0, 3);
            gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, summer.pixels);
        } finally {
            for (const [unit, tex, min, mag] of filters) {
                gl.activeTexture(gl.TEXTURE0 + unit);
                gl.bindTexture(gl.TEXTURE_2D, tex);
                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, min);
                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, mag);
            }
        }
    });
    const px = summer.pixels, out = new Float32Array(w * h);
    for (let i = 0, j = 0; i < out.length; i++, j += 4) out[i] = (px[j] * 256 + px[j + 1]) / 65535;
    return out;
}

function sumOnCpu(body, face) {
    const a = body.getAsFloat32Array(), b = face.getAsFloat32Array();
    const out = new Float32Array(a.length);
    for (let i = 0; i < a.length; i++) out[i] = a[i] + b[i];
    return out;
}

// P(body-skin) + P(face-skin) for one result; call inside the segment callback.
function skinProbability(masks) {
    const body = masks[BODY_SKIN], face = masks[FACE_SKIN];
    if (gpuSumEnabled && body.hasWebGLTexture() && face.hasWebGLTexture()) {
        try {
            const sum = sumOnGpu(body, face);
            if (sum) return sum;
        } catch (error) {
            console.warn('[Image Filter engine] GPU mask sum failed, reading floats:', error);
        }
        gpuSumEnabled = false;
    }
    return sumOnCpu(body, face);
}

// Self-test at warm-up: the GPU sum must match the float readback on a non-uniform mask.
function checkGpuSum(masks) {
    const body = masks[BODY_SKIN], face = masks[FACE_SKIN];
    if (!gpuSumEnabled || !body.hasWebGLTexture()) return;
    let ok = false;
    try {
        const gpu = sumOnGpu(body, face);
        const cpu = sumOnCpu(body, face);
        let maxDiff = 0, spread = 0;
        for (let i = 0; gpu && i < cpu.length; i++) {
            maxDiff = Math.max(maxDiff, Math.abs(gpu[i] - Math.min(1, Math.max(0, cpu[i]))));
            spread = Math.max(spread, Math.abs(cpu[i] - cpu[0]));
        }
        ok = !!gpu && maxDiff < 1e-3 && spread > 1e-3;
        if (!ok) console.warn('[Image Filter engine] GPU mask sum self-test failed', { maxDiff, spread });
    } catch (error) {
        console.warn('[Image Filter engine] GPU mask sum self-test failed:', error);
    }
    gpuSumEnabled = ok;
}

// --- Detection ------------------------------------------------------------------------------
// One inference on `input`; its skin probability, scaled to w×h, is max-merged into prob
// (work resolution, workW wide) at (ox, oy). The callback form of segment() reads the two
// masks in place instead of copying all six.
function segmentInto(segmenter, input, prob, workW, ox, oy, w, h) {
    let skin = null, mw = 0, mh = 0;
    try {
        segmenter.segment(input, result => {
            const masks = result.confidenceMasks;
            mw = masks[BODY_SKIN].width;
            mh = masks[BODY_SKIN].height;
            skin = skinProbability(masks);
        });
    } catch (error) {
        throw Object.assign(error instanceof Error ? error : new Error(String(error)),
            { fromSegmenter: true });
    }
    const part = resizeBilinear(skin, mw, mh, w, h);
    for (let y = 0; y < h; y++) {
        const o = (oy + y) * workW + ox, p = y * w;
        for (let x = 0; x < w; x++) {
            if (part[p + x] > prob[o + x]) prob[o + x] = part[p + x];
        }
    }
}

function detect(segmenter, source, w, h, mode) {
    const work = fitWithin(w, h, SEG_WORK_MAX);
    const W = work.w, H = work.h;
    const tiles = mode === 'single' ? [] : mode === 'fast' ? frameTiles(H, W) : tilesFor(H, W);

    // Work copy (only needed to cut tiles from); white under transparent pixels.
    let workCanvas = null;
    if (tiles.length) {
        const s = scratch('work', W, H);
        s.ctx.fillStyle = '#ffffff';
        s.ctx.fillRect(0, 0, W, H);
        s.ctx.drawImage(source, 0, 0, W, H);
        workCanvas = s.canvas;
    }
    const full = fitWithin(W, H, SEG_FULL_MAX);
    const f = scratch('full', full.w, full.h);
    f.ctx.fillStyle = '#ffffff';
    f.ctx.fillRect(0, 0, full.w, full.h);
    f.ctx.drawImage(workCanvas || source, 0, 0, full.w, full.h);

    const t0 = performance.now();
    const prob = new Float32Array(W * H);
    segmentInto(segmenter, f.canvas, prob, W, 0, 0, W, H);
    for (const { y, x, size } of tiles) {
        const side = Math.min(size, MODEL_INPUT);
        const t = scratch('tile', side, side);
        t.ctx.drawImage(workCanvas, x, y, size, size, 0, 0, side, side);
        segmentInto(segmenter, t.canvas, prob, W, x, y, size, size);
    }

    // Tiny images: zero P(skin) where the colour can't be skin. The whole-image canvas `f` is
    // the work copy here (it only shrinks above SEG_FULL_MAX ≥ SKIN_COLOUR_GATE_MAX).
    if (Math.max(W, H) <= SKIN_COLOUR_GATE_MAX) {
        const notSkin = notSkinColour(f.ctx.getImageData(0, 0, W, H).data, W, H);
        for (let i = 0; i < prob.length; i++) if (notSkin[i]) prob[i] = 0;
    }

    const t1 = performance.now();
    let mask = new Uint8Array(W * H);
    for (let i = 0; i < mask.length; i++) mask[i] = prob[i] > SKIN_PROB_THRESHOLD ? 1 : 0;
    mask = dilateEllipse(mask, W, H, Math.max(1, pyRound(Math.max(W, H) * SKIN_DILATE_PER_PX)));

    // Run-length encode (alternating runs, starting with not-skin): a few hundred numbers
    // instead of hundreds of thousands of pixels, cheap to send to the content script.
    const runs = [];
    let current = 0, length = 0, skinCount = 0;
    for (let i = 0; i < mask.length; i++) {
        const isSkin = mask[i];
        skinCount += isSkin;
        if (isSkin === current) {
            length++;
        } else {
            runs.push(length);
            current = isSkin;
            length = 1;
        }
    }
    runs.push(length);
    const skinRatio = skinCount / mask.length;
    return {
        containsSkin: skinRatio >= SKIN_RATIO_THRESHOLD,
        skinRatio,
        mask: { w: W, h: H, runs },
        passes: 1 + tiles.length,
        segmentMs: t1 - t0,
        postMs: performance.now() - t1
    };
}

// Find skin in a decoded image (canvas, ImageBitmap, <img>, …) of size w×h. The mask comes
// back at work resolution (≤768px), run-length encoded; callers upscale it bilinearly.
// options.mode: 'full' (default), 'fast' (video frames) or 'single' — see the top.
export async function analyze(source, w, h, options = {}) {
    const mode = ['fast', 'single'].includes(options.mode) ? options.mode : 'full';
    const segmenter = await init();
    try {
        return detect(segmenter, source, w, h, mode);
    } catch (error) {
        // Only a failing GPU is worth retrying on CPU (not e.g. a tainted canvas).
        if (!error.fromSegmenter || error.name === 'SecurityError' ||
            segmenterDelegates.get(segmenter) !== 'GPU') throw error;
        return detect(await fallBackToCpu(segmenter, error), source, w, h, mode);
    }
}

// Grey overlay: paint the small mask as grey with alpha, then let drawImage's bilinear
// upscale + source-over blend compute (1 − a)·image + a·grey — apply_grey_overlay().
export function paintOverlay(ctx, mask, width, height, alpha = OVERLAY_ALPHA) {
    const maskCanvas = document.createElement('canvas');
    maskCanvas.width = mask.w;
    maskCanvas.height = mask.h;
    const mctx = maskCanvas.getContext('2d');
    const pixels = mctx.createImageData(mask.w, mask.h);
    const data = pixels.data;
    const a = Math.round(255 * alpha);
    let p = 0, isSkin = false;
    for (const run of mask.runs) {
        if (isSkin) {
            for (let end = p + run; p < end; p++) {
                const o = p * 4;
                data[o] = 128; data[o + 1] = 128; data[o + 2] = 128; data[o + 3] = a;
            }
        } else {
            p += run;
        }
        isSkin = !isSkin;
    }
    mctx.putImageData(pixels, 0, 0);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(maskCanvas, 0, 0, width, height);
    maskCanvas.width = maskCanvas.height = 0;  // free now, not at the next GC
}

// --- Decoding -------------------------------------------------------------------------------
// Size of an SVG that reports none: its viewBox, else CSS's default 300×150. (Safari
// normally reports one itself: 300×150, or 150px tall at the viewBox's aspect ratio.)
async function svgSize(blob) {
    const m = /viewBox\s*=\s*["']\s*[-+\d.eE]+[\s,]+[-+\d.eE]+[\s,]+([+\d.eE]+)[\s,]+([+\d.eE]+)/
        .exec(await blob.text());
    const w = m ? parseFloat(m[1]) : 0, h = m ? parseFloat(m[2]) : 0;
    return w > 0 && h > 0 ? { w, h } : { w: 300, h: 150 };
}

// Decode to something drawImage accepts. createImageBitmap(blob) is fastest, but Safari
// rejects SVG with InvalidStateError, so fall back to an <img>, rasterised onto a canvas
// before its object URL is revoked. Vector images are drawn at least SVG_MIN px (Safari
// sizes a viewBox-only SVG 150px tall) so they aren't analysed postage-stamp small.
async function decodeBlob(blob) {
    try {
        const bitmap = await createImageBitmap(blob);
        return { source: bitmap, w: bitmap.width, h: bitmap.height, close: () => bitmap.close() };
    } catch (bitmapError) {
        const objectUrl = URL.createObjectURL(blob);
        try {
            const img = new Image();
            img.src = objectUrl;
            await img.decode();
            let w = img.naturalWidth, h = img.naturalHeight;
            const isSvg = /svg/i.test(blob.type) || !w || !h;
            if (!w || !h) ({ w, h } = await svgSize(blob));
            if (isSvg && Math.max(w, h) < SVG_MIN) {
                const scale = SVG_MIN / Math.max(w, h);
                w *= scale;
                h *= scale;
            }
            const size = fitWithin(Math.max(1, Math.round(w)), Math.max(1, Math.round(h)), OUTPUT_MAX);
            const canvas = document.createElement('canvas');
            canvas.width = size.w;
            canvas.height = size.h;
            canvas.getContext('2d').drawImage(img, 0, 0, size.w, size.h);
            return { source: canvas, w: size.w, h: size.h, close: () => {} };
        } catch (imgError) {
            throw new Error(`Cannot decode image (${blob.type || 'unknown type'}): ` +
                `${bitmapError && bitmapError.message}; ${imgError && imgError.message}`);
        } finally {
            URL.revokeObjectURL(objectUrl);
        }
    }
}

// Full pipeline for an image we only have a URL for (the page wouldn't let the content
// script read its pixels). The background page may fetch any site the extension is
// allowed on, so it downloads and filters the image itself.
export async function filterUrl(url, options = {}) {
    const t0 = performance.now();
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Image download failed: ${response.status}`);
    const image = await decodeBlob(await response.blob());
    try {
        const decodeMs = performance.now() - t0;
        const analysis = await analyze(image.source, image.w, image.h, options);
        let filteredImageUrl = null;
        if (analysis.containsSkin) {
            const out = fitWithin(image.w, image.h, OUTPUT_MAX);
            const canvas = document.createElement('canvas');
            canvas.width = out.w;
            canvas.height = out.h;
            const ctx = canvas.getContext('2d');
            ctx.fillStyle = '#ffffff';  // JPEG has no alpha
            ctx.fillRect(0, 0, out.w, out.h);
            ctx.drawImage(image.source, 0, 0, out.w, out.h);
            paintOverlay(ctx, analysis.mask, out.w, out.h);
            filteredImageUrl = canvas.toDataURL('image/jpeg', 0.9);
            canvas.width = canvas.height = 0;
        }
        return { ...analysis, mask: undefined, filteredImageUrl, decodeMs };
    } finally {
        image.close();
    }
}

// Segment a picture the content script already shrank (≤ SEG_MAX) and sent as a data URL.
// options.mode: 'full' (default), 'fast' (video frames) or 'single'.
export async function analyzeDataUrl(dataUrl, options = {}) {
    const t0 = performance.now();
    const image = await decodeBlob(await (await fetch(dataUrl)).blob());
    try {
        const decodeMs = performance.now() - t0;
        return { ...(await analyze(image.source, image.w, image.h, options)), decodeMs };
    } finally {
        image.close();
    }
}
