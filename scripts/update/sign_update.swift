// sign_update.swift — builds and checks the signed update manifest the in-app updater trusts.
//
// Run with the Swift interpreter (no dependencies beyond the Xcode toolchain):
//
//   swift scripts/update/sign_update.swift generate
//       Makes a new Ed25519 key pair. Prints `private=<base64>` and `public=<base64>`.
//       The private half goes into the GitHub secret UPDATE_SIGNING_KEY (and a safe backup),
//       the public half into UpdateConfig.publicKeyBase64.
//
//   UPDATE_SIGNING_KEY=<base64 private> swift scripts/update/sign_update.swift sign \
//       --version 1.7.2 --asset Image-Filter-Service-1.7.2.zip --notes-file notes.md --out update.json
//       Writes the signed envelope (format 1): {"format":1,"payload":"<b64 manifest>","signature":"<b64>"}
//       The signature covers the exact payload bytes, so nothing about the manifest (version, size,
//       SHA-256 of the zip, release notes) can be changed without the private key.
//
//   swift scripts/update/sign_update.swift verify update.json --public-key <base64> [--asset file.zip]
//       Checks the signature (and, with --asset, the zip's size and SHA-256). Exit status 0 = valid.
//
// The manifest layout must stay in step with `UpdateManifest` in macOS/App/UpdateCore.swift.

import CryptoKit
import Foundation

struct Manifest: Codable {
    var schema = 1
    var bundleID: String
    var version: String
    var tag: String
    var asset: String
    var size: Int64
    var sha256: String
    var notes: String
    var published: String
}

func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data((message + "\n").utf8))
    exit(1)
}

let arguments = Array(CommandLine.arguments.dropFirst())
guard let command = arguments.first else {
    fail("usage: sign_update.swift generate | sign --version V --asset FILE [--notes-file F] --out FILE | verify FILE --public-key B64 [--asset FILE]")
}

func option(_ name: String) -> String? {
    guard let i = arguments.firstIndex(of: name), i + 1 < arguments.count else { return nil }
    return arguments[i + 1]
}

func sha256Hex(of path: String) -> (hex: String, size: Int64) {
    guard let handle = FileHandle(forReadingAtPath: path) else { fail("cannot read \(path)") }
    defer { try? handle.close() }
    var hasher = SHA256()
    var size: Int64 = 0
    while case let chunk = handle.readData(ofLength: 1 << 20), !chunk.isEmpty {
        hasher.update(data: chunk)
        size += Int64(chunk.count)
    }
    return (hasher.finalize().map { String(format: "%02x", $0) }.joined(), size)
}

switch command {
case "generate":
    let key = Curve25519.Signing.PrivateKey()
    print("private=\(key.rawRepresentation.base64EncodedString())")
    print("public=\(key.publicKey.rawRepresentation.base64EncodedString())")

case "sign":
    guard let keyText = ProcessInfo.processInfo.environment["UPDATE_SIGNING_KEY"],
          let keyData = Data(base64Encoded: keyText.trimmingCharacters(in: .whitespacesAndNewlines)),
          let key = try? Curve25519.Signing.PrivateKey(rawRepresentation: keyData)
    else { fail("UPDATE_SIGNING_KEY is missing or is not a base64 Ed25519 private key") }
    guard let version = option("--version"), let assetPath = option("--asset"), let out = option("--out")
    else { fail("sign needs --version, --asset and --out") }
    let notes = option("--notes-file").flatMap { try? String(contentsOfFile: $0, encoding: .utf8) } ?? ""
    let (hex, size) = sha256Hex(of: assetPath)
    let manifest = Manifest(
        bundleID: option("--bundle-id") ?? "FelzyTech.Image-Filter-Service",
        version: version,
        tag: option("--tag") ?? "v\(version)",
        asset: URL(fileURLWithPath: assetPath).lastPathComponent,
        size: size,
        sha256: hex,
        notes: String(notes.trimmingCharacters(in: .whitespacesAndNewlines).prefix(8000)),
        published: ISO8601DateFormatter().string(from: Date()))
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys]
    let payload = try encoder.encode(manifest)
    let signature = try key.signature(for: payload)
    let envelope: [String: Any] = [
        "format": 1,
        "payload": payload.base64EncodedString(),
        "signature": signature.base64EncodedString(),
    ]
    let data = try JSONSerialization.data(withJSONObject: envelope, options: [.sortedKeys])
    try data.write(to: URL(fileURLWithPath: out))
    print("signed \(manifest.asset): \(size) bytes, sha256 \(hex), version \(version)")

case "verify":
    guard arguments.count >= 2, let keyText = option("--public-key"),
          let keyData = Data(base64Encoded: keyText),
          let key = try? Curve25519.Signing.PublicKey(rawRepresentation: keyData)
    else { fail("verify needs a file and --public-key <base64>") }
    guard let file = try? Data(contentsOf: URL(fileURLWithPath: arguments[1])),
          let raw = try? JSONSerialization.jsonObject(with: file) as? [String: Any],
          raw["format"] as? Int == 1,
          let payload = (raw["payload"] as? String).flatMap({ Data(base64Encoded: $0) }),
          let signature = (raw["signature"] as? String).flatMap({ Data(base64Encoded: $0) })
    else { fail("not a format-1 update envelope") }
    guard key.isValidSignature(signature, for: payload) else { fail("BAD SIGNATURE: not signed by this public key") }
    guard let manifest = try? JSONDecoder().decode(Manifest.self, from: payload) else { fail("manifest is not readable") }
    if let assetPath = option("--asset") {
        let (hex, size) = sha256Hex(of: assetPath)
        guard hex == manifest.sha256, size == manifest.size else {
            fail("the archive does not match the signed manifest (sha256/size differ)")
        }
    }
    print("signature OK: \(manifest.asset) version \(manifest.version), \(manifest.size) bytes")

default:
    fail("unknown command \(command)")
}
