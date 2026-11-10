#!/bin/bash
# Unit tests for the decision logic of the macOS extension enforcer
# (macOS/App/ExtensionGate.swift). Plain swiftc, no Xcode project needed.
set -euo pipefail
cd "$(dirname "$0")/.."
OUT="$(mktemp -d)"
trap 'rm -rf "$OUT"' EXIT
swiftc -o "$OUT/extension_gate_tests" \
    macOS/App/ExtensionGate.swift macOS/Tests/ExtensionGate/main.swift
"$OUT/extension_gate_tests"
