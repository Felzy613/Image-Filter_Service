# Image Filter Service

A Safari extension (Manifest v3, Mac and iPhone/iPad) that automatically intercepts web images and greys out human skin regions — designed for religious compliance (kosher browsing).

## How It Works

```
Web Page → content.js (≤768px JPEG) → background.js → ondevice/engine.js (MediaPipe in WebAssembly, on the GPU)
Web Page ← content.js paints grey over the full-size picture ← skin mask ← background.js
```

Images are hidden immediately at page load (`opacity: 0`), checked by a skin-detection model that runs **inside the extension itself**, then revealed with skin areas covered by a grey overlay. Nothing is sent anywhere: there is no server (the Mac used a local Python server until version 1.10.0). **Images remain hidden if they can't be checked** — this is intentional, not a bug.

An image is only ever shown once the exact picture it displays has been checked: if a page later swaps in a different picture (carousels, lazy loading, `<picture>` sources, screen rotation), it is hidden again instantly and re-checked. This covers `<img>`/`<picture>`, CSS background images (including `::before`/`::after`), SVG (as images, backgrounds, and inline `<svg>`), images inside web components' shadow DOM (also closed ones), and video — a video is never shown directly: an overlay plays only frames that have each been checked and greyed, and native fullscreen / Picture in Picture are blocked. **Not covered:** pictures a page draws itself on a `<canvas>` (maps, editors), and any page the extension isn't running on.

## Features

- Intercepts `<img>`/`<picture>`, CSS background images, SVG, shadow-DOM images and video
- Handles dynamically loaded / lazy-loaded images via `MutationObserver` + 250 ms polling
- MediaPipe `selfie_multiclass_256x256` model detects face-skin and body-skin regions, with tiled detection that finds people who are small in the frame
- Grey overlay applied over detected skin pixels; hair, clothes, and background untouched
- Runs entirely in Safari: the model and runtime (~27 MB) ship inside the extension, on the GPU (WebGL2) with a CPU fallback
- Popup UI (iPhone/iPad: enable/disable; Mac: always on, password to exclude a website)
- On the Mac, a small background app keeps the extension switched on and installs updates silently

## Requirements

- macOS 26.2+ (or iOS 16.4+ for iPhone/iPad)
- Xcode 27 (to build)

## Setup (Mac)

The `.pkg` installer from the [Releases](../../releases) page sets everything up: it installs the app in `/Applications` and a LaunchAgent that keeps a small background watcher running.

To build it yourself:

```bash
open Image-Filter_Service.xcodeproj
# In Xcode: select your development team, then ⌘R
```

Then:

1. Safari → Settings → Extensions → enable **Image Filter Service**
2. Grant access to all websites when prompted (pages load pictures from other sites; the extension can only check those if it's allowed there — otherwise they stay hidden)
3. Click the toolbar icon and confirm it says "Always on"

Once installed with the `.pkg`, the app keeps the extension on: if it is switched off while Safari or a Safari web app is open, Safari is closed and a notice offers to open Safari Settings. Safari can be used again as soon as the extension is back on (you get two minutes to turn it on after clicking the button).

Every Xcode or `xcodebuild` build registers its own copy of the extension; with several copies Safari may switch it off. After a build, remove the build's copies (`pluginkit -r <appex>`, `lsregister -u <app>`) — see `CLAUDE.md`, *Extension enforcement*.

**Measured in Safari on a Mac** (Safari 27.2, GPU): the same filter decision as the old server on 34/34 test pictures, 97–99.9% of its skin pixels greyed on photos of people; a photo of people takes ~110 ms, a graphic ~25 ms; the engine loads in ~0.6 s.

## iPhone / iPad

The same extension runs in Safari on iPhone and iPad through two extra Xcode targets in this project: **Image-Filter_Service iOS** (a small host app with setup steps) and **Image-Filter_Service iOS Extension**. The extension's JavaScript and engine are shared with macOS — they live once, in `Shared/Extension/`.

Measured in the iOS Simulator (iPhone 17 Pro; a real phone will differ): engine loads in ~0.3–0.6 s when Safari wakes the extension; a large photo takes ~200 ms (8 large photos fully filtered in ~2 s), small images much less; video plays filtered at ~7 fps.

Memory: the engine takes roughly 115–145 MB while it's in use (measured in the Simulator) and is released after a minute with nothing to check; pages themselves carry little extra. iOS gives Safari's processes far less than the phone's RAM, so check memory on a real iPhone on image-heavy sites.

### Build and run

1. `open Image-Filter_Service.xcodeproj`, choose the **Image-Filter_Service iOS** scheme and your iPhone (or a simulator), set your Team under *Signing & Capabilities*, then ⌘R. Requires iOS 16.4+.
2. On the phone: **Settings → Apps → Safari → Extensions** (iOS 16–17: **Settings → Safari → Extensions**), turn on **Image Filter Service** and set **All Websites** to **Allow**.

Images stay hidden until they've been checked; if checking fails they stay hidden and are retried automatically (5 s, backing off to 60 s).

## The background watcher (Mac)

The LaunchAgent (`com.imagefilter.server` — the name is from when it also ran the server) keeps the app running in the background as a watcher: no window, no Dock icon. It closes Safari while the extension is switched off, and installs verified updates from this repository's releases while Safari is closed. After upgrading from a version that had the server, it removes the server's leftovers (its Python environment) once.

To set it up by hand after copying the app to `/Applications`:

```bash
cp macOS/com.imagefilter.server.plist ~/Library/LaunchAgents/
launchctl load -w ~/Library/LaunchAgents/com.imagefilter.server.plist
```

Remove it with `launchctl unload ~/Library/LaunchAgents/com.imagefilter.server.plist` and delete the file. Logs are in `~/Library/Logs/Image-Filter-Service/`.

## Configuration (stored in `browser.storage.local`)

| Key | Default | Description |
|---|---|---|
| `isEnabled` | `true` | Whether filtering is active. iPhone/iPad only: on the Mac filtering is always on and this is ignored |
| `excludedSites` | `[]` | Websites that are not filtered (each entry covers its subdomains). On the Mac, adding one needs the exclusion password |
| `passwordRecord` | — | Mac only: salted PBKDF2 hash of the exclusion password (set from the popup) |

## Project Structure

```
Image-Filter_Service/
├── Shared/Extension/                   # The web extension, used by both Mac and iPhone/iPad
│   ├── manifest.json
│   ├── content-core.js, content.js, content-elements.js,
│   │   content-backgrounds.js, content-video.js   # Hide every picture until it has been checked
│   ├── page-world.js                   # Runs in the page: opens shadow roots, blocks video fullscreen/PiP
│   ├── background.js                   # Runs each picture through the engine
│   ├── ondevice/                       # The engine: engine.js + MediaPipe WASM + model
│   └── popup.html / popup.js / popup.css
├── macOS/
│   ├── App/                            # Mac host app: setup window, background watcher, updater
│   ├── Extension/                      # Mac native handler, Info.plist, entitlements
│   └── com.imagefilter.server.plist    # LaunchAgent for setting up the watcher by hand
├── iOS/
│   ├── App/                            # iPhone/iPad host app (setup instructions only)
│   └── Extension/                      # iOS Info.plist, native handler
├── scripts/fetch_ondevice_assets.sh    # Re-creates Shared/Extension/ondevice/ (pinned, checksummed)
├── Image-Filter_Service.xcodeproj      # All four targets (Mac app + extension, iOS app + extension)
└── .github/                            # Release workflow: builds the Mac .pkg on every push to main
```

## Debugging

**Content script:** Right-click any page → Inspect Element → Console (filter by `[Image Filter Service]`)

**Background script:** Safari → Develop → Web Extension Background Pages → select the extension

## Key Design Decisions

- **Images stay hidden on failure** — `data-filter-processed="failed"` means an image is never revealed. Required for religious compliance.
- **Pixels, not URL redirects** — Safari's `declarativeNetRequest` support is limited, and only pixels can be checked: each picture is read through a canvas on the page (or downloaded by the background page when the site won't allow that) and checked inside the extension.
- **MediaPipe categories** — only categories 2 (body-skin) and 3 (face-skin) are overlaid. Categories 0 (background), 1 (hair), 4 (clothes), 5 (others) are left untouched.

## License

MIT
