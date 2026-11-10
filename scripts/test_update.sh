#!/bin/bash
# Tests for the macOS self-updater (macOS/App/UpdateCore.swift, UpdateService.swift) and the CI
# signing tool (scripts/update/sign_update.swift). Plain swiftc, no Xcode project needed.
#
# Builds throw-away signed test apps (ad-hoc signed, bundle id test.ifs.app), signs manifests for
# them with throw-away keys, serves them from a local server that redirects downloads the way
# GitHub does, and runs the real UpdateService against it. If /Applications/Image-Filter_Service.app
# exists it is also used (read-only) to check the production signing requirement. Nothing is
# installed, registered or sent anywhere.
set -euo pipefail
cd "$(dirname "$0")/.."
OUT="$(mktemp -d)"
SERVER_PID=""
cleanup() {
    [ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null || true
    chmod -R u+w "$OUT" 2>/dev/null || true      # some tests leave read-only bundles behind
    rm -rf "$OUT"
}
trap cleanup EXIT

SIGN="$OUT/sign_update"
swiftc -O -o "$SIGN" scripts/update/sign_update.swift 2>&1 | grep -v "^$" || true

# Keys: the real one for the "ok" signatures, a second one for the wrong-key case.
gen() { "$SIGN" generate; }
KEYS="$(gen)";  PRIV=$(sed -n 's/^private=//p' <<<"$KEYS");  PUB=$(sed -n 's/^public=//p' <<<"$KEYS")
KEYS2="$(gen)"; PRIV2=$(sed -n 's/^private=//p' <<<"$KEYS2"); PUB2=$(sed -n 's/^public=//p' <<<"$KEYS2")

# A tiny program that prints a line, wrapped as IFSTest.app of a given version.
FX="$OUT/fx"; mkdir -p "$FX"
echo 'print("IFSTest ok")' > "$FX/tiny.swift"
swiftc -O -o "$FX/IFSTest" "$FX/tiny.swift"
make_app() { # dir version
    local dir="$1" version="$2"
    rm -rf "$dir/IFSTest.app"; mkdir -p "$dir/IFSTest.app/Contents/MacOS"
    cp "$FX/IFSTest" "$dir/IFSTest.app/Contents/MacOS/IFSTest"
    cat > "$dir/IFSTest.app/Contents/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>test.ifs.app</string>
<key>CFBundleExecutable</key><string>IFSTest</string>
<key>CFBundleName</key><string>IFSTest</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>$version</string>
<key>CFBundleVersion</key><string>1</string>
<key>LSMinimumSystemVersion</key><string>13.0</string>
</dict></plist>
EOF
    codesign --force --sign - "$dir/IFSTest.app" >/dev/null 2>&1
}
zip_app() { ditto -c -k --sequesterRsrc --keepParent "$1/IFSTest.app" "$2"; }   # dir zipfile

mkdir -p "$FX/old" "$FX/new" "$FX/ver2" "$FX/broken" "$FX/v0" "$FX/v09"
make_app "$FX/old" 1.0.0
make_app "$FX/new" 1.0.1
make_app "$FX/ver2" 1.0.2
make_app "$FX/v0" 1.0.0
make_app "$FX/v09" 0.9.0
make_app "$FX/broken" 1.0.1
printf '\n<!-- changed after signing -->\n' >> "$FX/broken/IFSTest.app/Contents/Info.plist"   # breaks the seal

SRV="$OUT/srv"
# scenario  appdir  zipname  version  key  [extra sign args]
publish() {
    local name="$1" appdir="$2" zipname="$3" version="$4" key="$5"; shift 5
    mkdir -p "$SRV/$name/cdn"
    zip_app "$appdir" "$SRV/$name/cdn/$zipname"
    echo "notes for $version" > "$OUT/notes.md"
    UPDATE_SIGNING_KEY="$key" "$SIGN" sign --version "$version" --asset "$SRV/$name/cdn/$zipname" \
        --notes-file "$OUT/notes.md" --out "$SRV/$name/update.json" "$@" --bundle-id test.ifs.app >/dev/null
}
publish ok          "$FX/new"    IFSTest-1.0.1.zip 1.0.1 "$PRIV"
publish wrongkey    "$FX/new"    IFSTest-1.0.1.zip 1.0.1 "$PRIV2"
publish wrongbundle "$FX/new"    IFSTest-1.0.1.zip 1.0.1 "$PRIV" --bundle-id other.app
publish vermismatch "$FX/ver2"   IFSTest-1.0.1.zip 1.0.1 "$PRIV"     # zip holds 1.0.2, manifest promises 1.0.1
publish sealbroken  "$FX/broken" IFSTest-1.0.1.zip 1.0.1 "$PRIV"
publish same        "$FX/v0"     IFSTest-1.0.0.zip 1.0.0 "$PRIV"
publish older       "$FX/v09"    IFSTest-0.9.0.zip 0.9.0 "$PRIV"
# tampered: the signed manifest is the genuine one, but the served zip has one byte flipped (same size).
mkdir -p "$SRV/tampered/cdn" "$SRV/evil"
cp "$SRV/ok/update.json" "$SRV/tampered/update.json"
python3 - "$SRV/ok/cdn/IFSTest-1.0.1.zip" "$SRV/tampered/cdn/IFSTest-1.0.1.zip" <<'PY'
import sys
data = bytearray(open(sys.argv[1], "rb").read())
data[len(data) // 2] ^= 0xFF
open(sys.argv[2], "wb").write(data)
PY
cp "$SRV/ok/update.json" "$SRV/evil/update.json"       # its download redirects to a host that isn't allowed

# Local server: /<scenario>/download/<tag>/<file> answers with a redirect, like GitHub's release CDN.
cat > "$OUT/server.py" <<'PY'
import functools, http.server, sys
root, port_file = sys.argv[1], sys.argv[2]
class Handler(http.server.SimpleHTTPRequestHandler):
    def do_GET(self):
        parts = self.path.split("?")[0].strip("/").split("/")
        if len(parts) == 4 and parts[1] == "download":
            self.send_response(302)
            self.send_header("Location", "http://127.0.0.2:1/x" if parts[0] == "evil" else f"/{parts[0]}/cdn/{parts[3]}")
            self.end_headers()
            return
        super().do_GET()
    def log_message(self, *args): pass
server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), functools.partial(Handler, directory=root))
open(port_file, "w").write(str(server.server_address[1]))
server.serve_forever()
PY
python3 "$OUT/server.py" "$SRV" "$OUT/port" & SERVER_PID=$!
for _ in $(seq 1 50); do [ -s "$OUT/port" ] && break; sleep 0.1; done
[ -s "$OUT/port" ] || { echo "local test server did not start"; exit 1; }

# The server must keep Python's bytecode out of the app bundle (see start_server.py).
grep -q "PYTHONPYCACHEPREFIX" server/start_server.py \
    || { echo "FAIL: server/start_server.py no longer sets PYTHONPYCACHEPREFIX (a user-owned bundle would get __pycache__ and a broken signature)"; exit 1; }

grep -q "os.nice" server/start_server.py \
    || { echo "FAIL: server/start_server.py no longer lowers the server's priority (a burst of image checks could starve Safari)"; exit 1; }

# The CI "verify" step must accept the good file and refuse the bad ones.
"$SIGN" verify "$SRV/ok/update.json" --public-key "$PUB" --asset "$SRV/ok/cdn/IFSTest-1.0.1.zip" >/dev/null \
    || { echo "FAIL: sign_update verify rejected a good manifest"; exit 1; }
"$SIGN" verify "$SRV/ok/update.json" --public-key "$PUB2" >/dev/null 2>&1 \
    && { echo "FAIL: sign_update verify accepted the wrong key"; exit 1; }
"$SIGN" verify "$SRV/tampered/update.json" --public-key "$PUB" --asset "$SRV/tampered/cdn/IFSTest-1.0.1.zip" >/dev/null 2>&1 \
    && { echo "FAIL: sign_update verify accepted a tampered archive"; exit 1; }

swiftc -swift-version 5 -o "$OUT/update_tests" \
    macOS/App/UpdateConfig.swift macOS/App/UpdateCore.swift macOS/App/UpdateService.swift \
    macOS/Tests/Update/main.swift

mkdir -p "$OUT/work"
IFS_TEST_BASE="http://127.0.0.1:$(cat "$OUT/port")" IFS_TEST_PUB="$PUB" IFS_TEST_WRONG_PUB="$PUB2" \
IFS_TEST_WORK="$OUT/work" IFS_TEST_FIXTURES="$FX" IFS_TEST_SRV="$SRV" \
    "$OUT/update_tests"
