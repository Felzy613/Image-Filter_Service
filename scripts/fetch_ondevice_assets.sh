#!/bin/bash
# Re-create the iOS extension's on-device filtering assets from their official sources
# (pinned versions, checksum-verified):
#   - MediaPipe Tasks Vision web runtime (npm @mediapipe/tasks-vision)
#   - the selfie_multiclass_256x256 segmentation model the server also uses
#
# Usage: scripts/fetch_ondevice_assets.sh [output-dir]
#        (default: "iOS/Extension/ondevice")
#
# To upgrade MediaPipe: change VERSION, run with VERIFY=0, test in the iOS Simulator,
# then paste the new checksums below.
set -euo pipefail

VERSION="0.10.32"   # keep in step with mediapipe in server/requirements.txt
MODEL_URL="https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_multiclass_256x256/float32/1/selfie_multiclass_256x256.tflite"
VERIFY="${VERIFY:-1}"

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="${1:-$ROOT/iOS/Extension/ondevice}"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

echo "Fetching @mediapipe/tasks-vision@$VERSION"
curl -fsSL "https://registry.npmjs.org/@mediapipe/tasks-vision/-/tasks-vision-$VERSION.tgz" -o "$WORK/pkg.tgz"
tar -xzf "$WORK/pkg.tgz" -C "$WORK"

echo "Fetching segmentation model"
curl -fsSL "$MODEL_URL" -o "$WORK/selfie_multiclass_256x256.tflite"

mkdir -p "$OUT"
# Served as .js: Safari isn't guaranteed to give .mjs a JavaScript MIME type.
grep -v '^//# sourceMappingURL=' "$WORK/package/vision_bundle.mjs" > "$OUT/vision_bundle.js"
cp "$WORK/package/wasm/vision_wasm_internal.js" "$WORK/package/wasm/vision_wasm_internal.wasm" "$OUT/"
cp "$WORK/selfie_multiclass_256x256.tflite" "$OUT/"

if [ "$VERIFY" = "1" ]; then
    (cd "$OUT" && shasum -a 256 -c - <<'SUMS'
b9fe6ea36127908fb8a99ba7fc9f5841f871d3854dbb1929d2a497a5ac7579b9  vision_bundle.js
6f6b86509cf9e163ea1cfec7edc8cf53732699c04781e4c21c557c1ba402310e  vision_wasm_internal.js
cb3ec20026a9aecc2a81a93c25630ceb5389297ddb7a5f0bd61dd09cde606b9b  vision_wasm_internal.wasm
c6748b1253a99067ef71f7e26ca71096cd449baefa8f101900ea23016507e0e0  selfie_multiclass_256x256.tflite
SUMS
    )
else
    (cd "$OUT" && shasum -a 256 vision_bundle.js vision_wasm_internal.js vision_wasm_internal.wasm selfie_multiclass_256x256.tflite)
fi
echo "Assets written to $OUT"
