#!/bin/bash
# Unit tests for the decision logic of the macOS extension enforcer
# (macOS/App/ExtensionGate.swift) and the reader of Safari's per-profile settings
# (macOS/App/SafariProfileSettings.swift, tested against a fake Safari folder in a temp dir).
# Plain swiftc, no Xcode project needed.
set -euo pipefail
cd "$(dirname "$0")/.."
OUT="$(mktemp -d)"
trap 'rm -rf "$OUT"' EXIT
swiftc -o "$OUT/extension_gate_tests" \
    macOS/App/ExtensionGate.swift macOS/App/SafariProfileSettings.swift \
    macOS/Tests/ExtensionGate/main.swift -lsqlite3
"$OUT/extension_gate_tests"
