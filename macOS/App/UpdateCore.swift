//
//  UpdateCore.swift
//  Image-Filter_Service
//
//  The trust rules of the self-updater, with no AppKit and no network, so they can be tested with
//  plain swiftc (scripts/test_update.sh):
//
//    1. The manifest is an Ed25519-signed envelope. Nothing in it is believed before the signature
//       (made by scripts/update/sign_update.swift in CI) verifies against UpdateConfig.publicKeyBase64.
//    2. The signed manifest pins the archive's exact size and SHA-256, so GitHub (or anyone between
//       GitHub and the Mac) can't swap the file.
//    3. The unpacked app must be signed by our Apple team, carry our bundle ID, and have the version
//       the manifest promised (so an old signed build can't be replayed as a new one).
//    4. Only a strictly newer version is ever installed (no downgrades).
//

import CryptoKit
import Foundation
import Security

// MARK: - Errors

nonisolated enum UpdateError: Error, Equatable, LocalizedError {
    case disabled(String)
    case busy
    case network(String)
    case badEnvelope
    case badSignature
    case badManifest(String)
    case sizeMismatch
    case hashMismatch
    case extractFailed(String)
    case bundleInvalid(String)
    case notWritable(String)
    case installFailed(String)

    var errorDescription: String? {
        switch self {
        case .disabled(let why): return "updates are off for this copy: \(why)"
        case .busy: return "another update operation is running"
        case .network(let m): return "network: \(m)"
        case .badEnvelope: return "the update manifest is not in the expected format"
        case .badSignature: return "the update manifest is not signed by our key"
        case .badManifest(let m): return "invalid update manifest: \(m)"
        case .sizeMismatch: return "the download has the wrong size"
        case .hashMismatch: return "the download does not match the signed SHA-256"
        case .extractFailed(let m): return "could not unpack the update: \(m)"
        case .bundleInvalid(let m): return "the update app failed verification: \(m)"
        case .notWritable(let m): return "cannot replace the installed app: \(m)"
        case .installFailed(let m): return "install failed: \(m)"
        }
    }
}

// MARK: - Versions

nonisolated enum UpdateVersion {
    /// Strict dotted-number parse ("1.8.0"): 1 to 4 components of 1 to 9 ASCII digits.
    static func parse(_ text: String) -> [Int]? {
        let parts = text.split(separator: ".", omittingEmptySubsequences: false)
        guard (1...4).contains(parts.count) else { return nil }
        var numbers: [Int] = []
        for part in parts {
            guard !part.isEmpty, part.count <= 9, part.allSatisfy({ $0.isASCII && $0.isNumber }),
                  let n = Int(part) else { return nil }
            numbers.append(n)
        }
        return numbers
    }

    /// <0, 0 or >0 like a three-way compare; missing components count as 0 ("1.8" == "1.8.0").
    static func compare(_ a: [Int], _ b: [Int]) -> Int {
        for i in 0..<max(a.count, b.count) {
            let x = i < a.count ? a[i] : 0
            let y = i < b.count ? b[i] : 0
            if x != y { return x < y ? -1 : 1 }
        }
        return 0
    }

    /// True only if both parse and `candidate` is strictly newer.
    static func isNewer(_ candidate: String, than current: String) -> Bool {
        guard let c = parse(candidate), let cur = parse(current) else { return false }
        return compare(c, cur) > 0
    }
}

// MARK: - Manifest and signed envelope

nonisolated struct UpdateManifest: Codable, Equatable {
    var schema: Int
    var bundleID: String
    var version: String
    var tag: String
    /// File name of the zip in the same release.
    var asset: String
    var size: Int64
    /// Lowercase hex SHA-256 of the zip.
    var sha256: String
    var notes: String
    var published: String

    /// Everything here is used to build a URL or a path, so it is checked character by character.
    func validate(expectedBundleID: String, maxSize: Int64) throws {
        guard schema == 1 else { throw UpdateError.badManifest("unknown schema \(schema)") }
        guard bundleID == expectedBundleID else { throw UpdateError.badManifest("made for \(bundleID)") }
        guard UpdateVersion.parse(version) != nil else { throw UpdateError.badManifest("bad version") }
        guard tag == "v\(version)" else { throw UpdateError.badManifest("tag does not match version") }
        guard Self.isSafeFileName(asset), asset.hasSuffix(".zip") else { throw UpdateError.badManifest("bad asset name") }
        guard size > 0, size <= maxSize else { throw UpdateError.badManifest("bad size") }
        guard sha256.count == 64, sha256.allSatisfy({ $0.isASCII && ($0.isNumber || ("a"..."f").contains($0)) })
        else { throw UpdateError.badManifest("bad sha256") }
        guard notes.count <= 20_000, published.count <= 40 else { throw UpdateError.badManifest("fields too long") }
    }

    /// [A-Za-z0-9._-], 1 to 100 characters, no leading dot and no "..": usable as a URL path part.
    static func isSafeFileName(_ name: String) -> Bool {
        guard (1...100).contains(name.count), !name.hasPrefix("."), !name.contains("..") else { return false }
        return name.allSatisfy { $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "." || $0 == "-" || $0 == "_") }
    }
}

nonisolated enum UpdateEnvelope {
    private struct Raw: Decodable {
        var format: Int
        var payload: String
        var signature: String
    }

    /// Verifies the signature first, and only then reads the manifest it covers.
    static func open(_ data: Data, publicKeyBase64: String, expectedBundleID: String, maxSize: Int64) throws -> UpdateManifest {
        guard let raw = try? JSONDecoder().decode(Raw.self, from: data), raw.format == 1,
              let payload = Data(base64Encoded: raw.payload),
              let signature = Data(base64Encoded: raw.signature), signature.count == 64,
              let keyData = Data(base64Encoded: publicKeyBase64),
              let key = try? Curve25519.Signing.PublicKey(rawRepresentation: keyData)
        else { throw UpdateError.badEnvelope }
        guard key.isValidSignature(signature, for: payload) else { throw UpdateError.badSignature }
        guard let manifest = try? JSONDecoder().decode(UpdateManifest.self, from: payload) else {
            throw UpdateError.badManifest("unreadable")
        }
        try manifest.validate(expectedBundleID: expectedBundleID, maxSize: maxSize)
        return manifest
    }
}

// MARK: - Where the files come from

/// The three URLs the updater uses, and which hosts it will talk to. In production everything is
/// https on github.com (and GitHub's CDN, which Releases redirect to); tests point it at localhost.
nonisolated struct UpdateFeed {
    var manifestURL: URL
    var assetURL: (_ tag: String, _ asset: String) -> URL
    /// Applied to every request URL and to every redirect target.
    var isAllowed: (URL) -> Bool

    static var production: UpdateFeed {
        let releases = "https://github.com/\(UpdateConfig.repo)/releases"
        return UpdateFeed(
            manifestURL: URL(string: "\(releases)/latest/download/update.json")!,
            assetURL: { tag, asset in URL(string: "\(releases)/download/\(tag)/\(asset)")! },
            isAllowed: { url in
                guard url.scheme == "https", let host = url.host?.lowercased() else { return false }
                return host == "github.com" || host.hasSuffix(".github.com") || host.hasSuffix(".githubusercontent.com")
            })
    }
}

// MARK: - Hashing

nonisolated enum UpdateHash {
    static func sha256Hex(of url: URL) throws -> String {
        let handle = try FileHandle(forReadingFrom: url)
        defer { try? handle.close() }
        var hasher = SHA256()
        while case let chunk = handle.readData(ofLength: 1 << 20), !chunk.isEmpty {
            hasher.update(data: chunk)
        }
        return hasher.finalize().map { String(format: "%02x", $0) }.joined()
    }
}

// MARK: - The unpacked app

nonisolated enum UpdateBundleCheck {
    /// "Signed by our team, with our bundle ID." `certificate leaf[subject.OU]` is the Team ID in the
    /// signing certificate, which is the same for Apple Development and Developer ID certificates and
    /// survives yearly certificate renewals (the certificate's name does not).
    static func requirement(identifier: String, teamID: String) -> String {
        "anchor apple generic and identifier \"\(identifier)\" and certificate leaf[subject.OU] = \"\(teamID)\""
    }

    static var productionAppRequirement: String {
        requirement(identifier: UpdateConfig.appBundleID, teamID: UpdateConfig.teamID)
    }
    static var productionExtensionRequirement: String {
        requirement(identifier: UpdateConfig.extensionBundleID, teamID: UpdateConfig.teamID)
    }

    /// Seal intact (every file hashes as signed, nested code included) and the requirement met.
    static func checkSignature(of url: URL, requirement text: String) throws {
        var code: SecStaticCode?
        guard SecStaticCodeCreateWithPath(url as CFURL, [], &code) == errSecSuccess, let code else {
            throw UpdateError.bundleInvalid("cannot read the code signature of \(url.lastPathComponent)")
        }
        var requirement: SecRequirement?
        guard SecRequirementCreateWithString(text as CFString, [], &requirement) == errSecSuccess, let requirement else {
            throw UpdateError.bundleInvalid("bad signing requirement")
        }
        let flags = SecCSFlags(rawValue: UInt32(kSecCSCheckAllArchitectures | kSecCSCheckNestedCode | kSecCSStrictValidate))
        var error: Unmanaged<CFError>?
        let status = SecStaticCodeCheckValidityWithErrors(code, flags, requirement, &error)
        guard status == errSecSuccess else {
            let reason = error?.takeRetainedValue().localizedDescription ?? "OSStatus \(status)"
            throw UpdateError.bundleInvalid("signature check failed for \(url.lastPathComponent): \(reason)")
        }
    }

    /// Everything that must hold before an unpacked app may replace the installed one.
    static func validate(
        app: URL,
        bundleID: String,
        version: String,
        appRequirement: String,
        extensionRequirement: String?,
        osVersion: OperatingSystemVersion = ProcessInfo.processInfo.operatingSystemVersion
    ) throws {
        let plistURL = app.appendingPathComponent("Contents/Info.plist")
        guard let info = NSDictionary(contentsOf: plistURL) as? [String: Any] else {
            throw UpdateError.bundleInvalid("no Info.plist")
        }
        guard info["CFBundleIdentifier"] as? String == bundleID else {
            throw UpdateError.bundleInvalid("wrong bundle identifier")
        }
        guard info["CFBundleShortVersionString"] as? String == version else {
            throw UpdateError.bundleInvalid("the app's version is not the version the manifest promised")
        }
        if let minimum = info["LSMinimumSystemVersion"] as? String, let wanted = UpdateVersion.parse(minimum) {
            let have = [osVersion.majorVersion, osVersion.minorVersion, osVersion.patchVersion]
            guard UpdateVersion.compare(have, wanted) >= 0 else {
                throw UpdateError.bundleInvalid("needs macOS \(minimum) or newer")
            }
        }
        guard let executable = info["CFBundleExecutable"] as? String,
              FileManager.default.isExecutableFile(atPath: app.appendingPathComponent("Contents/MacOS/\(executable)").path)
        else { throw UpdateError.bundleInvalid("no executable") }

        try checkSignature(of: app, requirement: appRequirement)

        if let extensionRequirement {
            let plugIns = app.appendingPathComponent("Contents/PlugIns")
            let appexes = ((try? FileManager.default.contentsOfDirectory(at: plugIns, includingPropertiesForKeys: nil)) ?? [])
                .filter { $0.pathExtension == "appex" }
            guard !appexes.isEmpty else { throw UpdateError.bundleInvalid("the Safari extension is missing") }
            for appex in appexes { try checkSignature(of: appex, requirement: extensionRequirement) }
        }
    }
}

// MARK: - When to act

nonisolated enum UpdateGate {
    /// An update is installed only while no Safari window or Safari web app is open, so the filter
    /// is never swapped out from under a page that is being shown. It is queued until Safari has
    /// been closed (and so restarts on the new version).
    static func canInstallNow(safariRunning: Bool, serverSetupRunning: Bool) -> Bool {
        !safariRunning && !serverSetupRunning
    }

    static func checkIsDue(lastAttempt: Date?, lastSucceeded: Bool, now: Date) -> Bool {
        guard let lastAttempt else { return true }
        let wait = lastSucceeded ? UpdateConfig.checkInterval : UpdateConfig.retryInterval
        // A clock set back must not freeze updates for months.
        return now >= lastAttempt.addingTimeInterval(wait) || now < lastAttempt
    }
}
