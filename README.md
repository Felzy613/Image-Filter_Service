# Image Filter Service

A Safari extension (Manifest v3) that automatically intercepts web images and greys out human skin regions — designed for religious compliance (kosher browsing).

## How It Works

```
Web Page → content.js (canvas → base64) → background.js → Flask server (MediaPipe)
                                                                    ↓
Web Page ← content.js (replaces img.src) ← background.js ← filtered base64 JPEG
```

Images are hidden immediately at page load (`opacity: 0`), sent to a local Python server for skin detection, then revealed with skin areas covered by a grey overlay. **Images remain hidden if the server is unavailable** — this is intentional, not a bug.

An image is only ever shown once the exact picture it displays has been checked: if a page later swaps in a different picture (carousels, lazy loading, `<picture>` sources, screen rotation), it is hidden again instantly and re-checked. This covers `<img>`/`<picture>`, CSS background images (including `::before`/`::after`), SVG (as images, backgrounds, and inline `<svg>`), images inside web components' shadow DOM (also closed ones), and video — a video is never shown directly: an overlay plays only frames that have each been checked and greyed, and native fullscreen / Picture in Picture are blocked. **Not covered:** pictures a page draws itself on a `<canvas>` (maps, editors), and any page the extension isn't running on.

## Features

- Intercepts `<img>`/`<picture>`, CSS background images, SVG, shadow-DOM images and video
- Handles dynamically loaded / lazy-loaded images via `MutationObserver` + 250 ms polling
- MediaPipe `selfie_multiclass_256x256` model detects face-skin and body-skin regions
- Grey overlay applied over detected skin pixels; hair, clothes, and background untouched
- Concurrent request limit (10) prevents saturating the local server
- Popup UI (iPhone/iPad: enable/disable; Mac: always on, local server, password to exclude a website)
- Native messaging integration: the extension can auto-start the server via the host macOS app
- Also runs in Safari on iPhone and iPad, filtering on the phone itself — no server (see [iPhone / iPad](#iphone--ipad))

## Requirements

- macOS 13+ (or iOS 16.4+ for iPhone/iPad)
- Safari 16+
- Xcode 15+ (to build the extension)
- Python 3.11+ (for the Flask server)

## Setup

### 1. Start the local server

```bash
# Clone the repo, then create a virtual environment
cd Image-Filter_Service
python3 -m venv .venv
source .venv/bin/activate
pip install -r server/requirements.txt

# Start the server in the background (checks if already running first)
python3 server/start_server.py
```

The server listens on `http://127.0.0.1:10000`. On first start it downloads the MediaPipe model (~10 MB) to `server/models/`.

**Or run it in the foreground** (same Gunicorn settings, Ctrl-C stops it):
```bash
bash server/run_server.sh
```

### 2. Build the Safari extension

```bash
open Image-Filter_Service.xcodeproj
# In Xcode: select your development team, then ⌘R
```

After building, Safari opens automatically. If it doesn't load the extension, quit and reopen Safari.

### 3. Enable the extension

1. Safari → Settings → Extensions → enable **Image Filter Service**
2. Grant access to all websites when prompted
3. Click the toolbar icon and confirm it says "Always on" and "Server: Connected" (the Mac always uses the local server at `http://127.0.0.1:10000`)

Once installed with the `.pkg`, the app keeps the extension on: if it is switched off while Safari or a Safari web app is open, Safari is closed and a notice offers to open Safari Settings. Safari can be used again as soon as the extension is back on (you get two minutes to turn it on after clicking the button).

## iPhone / iPad

The same extension runs in Safari on iPhone and iPad through two extra Xcode targets in this project: **Image-Filter_Service iOS** (a small host app with setup steps) and **Image-Filter_Service iOS Extension**. The extension's JavaScript is shared with macOS — it lives once, in `Shared/Extension/`.

**No server needed on iPhone.** The extension filters images on the phone itself: it runs the same MediaPipe model as the server (`selfie_multiclass_256x256`, same skin categories, threshold and grey overlay) in WebAssembly inside the extension's background page, on the GPU (WebGL) with a CPU fallback, including the server's tiled detection that finds people who are small in the frame. Nothing leaves the phone. The model and runtime ship in the app (`iOS/Extension/ondevice/`, about 28 MB; re-create them with `scripts/fetch_ondevice_assets.sh`).

Measured in the iOS Simulator (iPhone 17 Pro; a real phone will differ): engine loads in ~0.3–0.6 s when Safari wakes the extension; a large photo takes ~200 ms (8 large photos fully filtered in ~2 s), small images much less; video plays filtered at ~7 fps; and the phone greys 95–99.9% of the skin the server does on every test image (80% on a crowd of tiny faces).

Memory: the on-device engine takes roughly 115–145 MB while it's in use (measured in the Simulator) and is released after a minute with nothing to check; pages themselves carry little extra. iOS gives Safari's processes far less than the phone's RAM, so check memory on a real iPhone on image-heavy sites.

### Build and run

1. `open Image-Filter_Service.xcodeproj`, choose the **Image-Filter_Service iOS** scheme and your iPhone (or a simulator), set your Team under *Signing & Capabilities*, then ⌘R. Requires iOS 16.4+.
2. On the phone: **Settings → Apps → Safari → Extensions** (iOS 16–17: **Settings → Safari → Extensions**), turn on **Image Filter Service** and set **All Websites** to **Allow**. Allowing *all* websites matters: pages often load pictures from other sites, and the extension can only download and check those if it's allowed there — otherwise they stay hidden.

As on macOS, images stay hidden until they've been checked; if checking fails they stay hidden and are retried automatically (5 s, backing off to 60 s).

## Auto-start at login

The `.pkg` installer from the [Releases](../../releases) page sets this up for you: it installs a LaunchAgent that keeps a small watcher running, which starts the server whenever Safari (or a Safari web app) is open and stops it when Safari quits.

To set it up by hand after copying the app to `/Applications`:

```bash
cp macOS/com.imagefilter.server.plist ~/Library/LaunchAgents/
launchctl load -w ~/Library/LaunchAgents/com.imagefilter.server.plist
```

Remove it with `launchctl unload ~/Library/LaunchAgents/com.imagefilter.server.plist` and delete the file. The installed app's server logs are in `~/Library/Logs/Image-Filter-Service/`.

## Configuration

### Extension (stored in `browser.storage.local`)

| Key | Default | Description |
|---|---|---|
| `serverUrl` | `http://127.0.0.1:10000/api/filter-image` | Full API endpoint URL. No popup field: the Mac always uses this local default; iPhone/iPad filter on the device and ignore it |
| `isEnabled` | `true` | Whether filtering is active. iPhone/iPad only: on the Mac filtering is always on and this is ignored |
| `excludedSites` | `[]` | Websites that are not filtered (each entry covers its subdomains). On the Mac, adding one needs the exclusion password |
| `passwordRecord` | — | Mac only: salted PBKDF2 hash of the exclusion password (set from the popup) |
| `engine` | `device` on iPhone/iPad, `server` on Mac | Where pictures are checked. Fixed by platform, not a setting |

### Server (environment variables)

| Variable | Default | Description |
|---|---|---|
| `PORT` | `10000` | Listen port |
| `SKIN_RATIO_THRESHOLD` | `0.001` | Min skin-pixel ratio to trigger filtering (0.1%) |
| `SKIN_OVERLAY_ALPHA` | `1.0` | Grey overlay opacity (1.0 = fully opaque) |
| `IMAGE_FETCH_TIMEOUT` | `10` | HTTP timeout when server downloads images |
| `SEGMENTATION_MODEL_PATH` | `server/models/selfie_multiclass_256x256.tflite` | Local model path |
| `SEGMENTATION_MODEL_URL` | Google Storage URL | Where to download model if missing |

## Server API

### `POST /api/filter-image`

**Request:**
```json
{ "imageData": "data:image/jpeg;base64,..." }
```

**Response:**
```json
{
  "success": true,
  "filteredImageUrl": "data:image/jpeg;base64,...",
  "filtered": true,
  "containsSkin": true,
  "skinRatio": 0.12
}
```

On error the server returns `success: true` with an `error` field. The extension treats that as a failure: the image stays hidden and is retried.

## Project Structure

```
Image-Filter_Service/
├── Shared/Extension/                   # The web extension, used by both Mac and iPhone/iPad
│   ├── manifest.json
│   ├── content-core.js, content.js, content-elements.js,
│   │   content-backgrounds.js, content-video.js   # Hide every picture until it has been checked
│   ├── page-world.js                   # Runs in the page: opens shadow roots, blocks video fullscreen/PiP
│   ├── background.js                   # Sends pictures to the server or the on-device engine
│   └── popup.html / popup.js / popup.css
├── macOS/
│   ├── App/                            # Mac host app: starts/stops the server while Safari is open
│   ├── Extension/                      # Mac native handler (server auto-start), Info.plist, entitlements
│   └── com.imagefilter.server.plist    # LaunchAgent for setting up auto-start by hand
├── iOS/
│   ├── App/                            # iPhone/iPad host app (setup instructions only)
│   └── Extension/                      # iOS Info.plist, no-op native handler,
│       └── ondevice/                   #   on-device engine: engine.js + MediaPipe WASM + model
├── server/                             # Python filter server (run by the Mac app, or hosted)
│   ├── app.py                          # Flask + MediaPipe skin detection
│   ├── start_server.py                 # Starts it in the background (used by the Mac app)
│   ├── run_server.sh                   # Runs it in the foreground
│   └── requirements.txt
├── scripts/fetch_ondevice_assets.sh    # Re-creates iOS/Extension/ondevice/ (pinned, checksummed)
├── Image-Filter_Service.xcodeproj      # All four targets (Mac app + extension, iOS app + extension)
└── .github/                            # Release workflow: builds the Mac .pkg on every push to main
```

## Debugging

**Content script:** Right-click any page → Inspect Element → Console (filter by `[Image Filter Service]`)

**Background script:** Safari → Develop → Web Extension Background Pages → select the extension

**Server:** `tail -f server/server.log`

## Key Design Decisions

- **No caching** — intentionally disabled. Base64 responses vary per processing run; caching would serve stale data.
- **Images stay hidden on failure** — `data-filter-processed="failed"` means an image is never revealed. Required for religious compliance.
- **Base64 POST instead of URL redirect** — Safari's `declarativeNetRequest` support is limited; converting to base64 via canvas avoids SSL certificate issues on the local Python server.
- **MediaPipe categories** — only categories 2 (body-skin) and 3 (face-skin) are overlaid. Categories 0 (background), 1 (hair), 4 (clothes), 5 (others) are left untouched.

## License

MIT
