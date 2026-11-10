# Image Filter Service — Python server

Flask server that finds human skin in a picture with MediaPipe (`selfie_multiclass_256x256`) and greys it out. The Mac app starts it while Safari is open; it can also be hosted somewhere else for the iPhone extension's optional server mode.

## Run

From the repository root:

```bash
python3 -m venv .venv
.venv/bin/pip install -r server/requirements.txt

python3 server/start_server.py   # background (what the Mac app uses); does nothing if already running
bash server/run_server.sh        # or foreground, Ctrl-C to stop
```

It listens on port 10000. The model is downloaded to `server/models/` on first use. Logs: `server/server.log` and `server/server_error.log`.

## API

- `POST /api/filter-image` with `{"imageData": "data:image/jpeg;base64,...", "imageUrl": "<url>"}` (either one) →
  `{"success": true, "filteredImageUrl": "data:image/jpeg;base64,...", "filtered": true, "containsSkin": true, "skinRatio": 0.12}`.
  On a processing error it returns `success: true` plus an `error` field; the extension treats that as a failure and keeps the picture hidden.
- `GET /api/filter-image?url=<url>` — downloads the picture and returns the filtered image itself.
- `GET /` and `GET /uptime` — health checks.

## How it detects skin

The model only sees 256×256 pixels, so one pass over a whole photo misses people who are small in the frame. The server segments the whole picture plus overlapping tiles, takes P(body-skin) + P(face-skin) above 0.3 from any pass, dilates the mask slightly and greys it. Hair, clothes and background are left alone. Pictures with less than 0.1% skin are returned unchanged.

## Settings (environment variables)

| Variable | Default | Description |
|---|---|---|
| `PORT` | `10000` | Listen port (`python app.py` only; the scripts bind 10000) |
| `SKIN_RATIO_THRESHOLD` | `0.001` | Minimum share of skin pixels that triggers filtering |
| `SKIN_OVERLAY_ALPHA` | `1.0` | Grey overlay opacity |
| `SKIN_PROB_THRESHOLD` | `0.3` | P(body-skin) + P(face-skin) above which a pixel is greyed |
| `SKIN_COLOUR_GATE_MAX` | `256` | Images up to this size (longest side) never grey pixels whose colour can't be skin (blue/green/violet, white, vivid red/orange); `0` disables |
| `REVIEW_LOG_DIR` | `~/Library/Application Support/Image-Filter-Service/review` | Review log folder; the log is on only while this folder exists |
| `REVIEW_LOG_MAX` | `500` | Thumbnails kept in the review folder (oldest pruned) |
| `SEG_WORK_MAX` | `768` | Resolution tiles are cut from |
| `SEG_TILE` | `384` | Tile size for large pictures |
| `SEG_INTERPRETERS` | `2` | Model instances (~80 MB each) |
| `SEG_INTERPRETER_THREADS` | `min(4, (CPUs − 2) ÷ interpreters)` | Threads per model instance |
| `IMAGE_FETCH_TIMEOUT` | `10` | Timeout (s) when the server downloads a picture |
| `SEGMENTATION_MODEL_PATH` | `server/models/selfie_multiclass_256x256.tflite` | Local model path |
| `SEGMENTATION_MODEL_URL` | Google Storage URL | Where the model is downloaded from |

## Reviewing mistakes (optional)

To find out what the filter gets wrong in real browsing, turn on the review log. It is off until you create its folder:

```bash
mkdir -p "$HOME/Library/Application Support/Image-Filter-Service/review"      # on
python3 server/review_report.py                                                # build the page
open "$HOME/Library/Application Support/Image-Filter-Service/review/index.html"
rm -r "$HOME/Library/Application Support/Image-Filter-Service/review"         # off (and delete the thumbnails)
```

While it is on, every picture the server greys is also saved there as a small thumbnail. Only the **greyed** result is stored (what the browser already showed — never the original), with the site's host name, the size and the skin share; pictures with no skin are never saved. Click the thumbnails that should *not* have been greyed, press **Copy list**, and send it back. The log can only show false positives, not pictures the filter missed.

`mediapipe` is pinned (0.10.32): the server calls TFLite symbols inside it directly, and the iPhone's on-device engine uses the same version so both produce the same masks. Re-check both when upgrading.
