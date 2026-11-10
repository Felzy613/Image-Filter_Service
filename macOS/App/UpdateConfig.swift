//
//  UpdateConfig.swift
//  Image-Filter_Service
//
//  What the self-updater trusts and where it looks. See CLAUDE.md, "Auto-update (macOS)".
//  No AppKit here, so the update logic can be tested with plain swiftc (scripts/test_update.sh).
//

import Foundation

nonisolated enum UpdateConfig {
    /// GitHub repository whose Releases carry the updates. It must be PUBLIC: the app holds no
    /// credentials, so a private repository answers every request with 404 (no update, no harm).
    static let repo = "Felzy613/Image-Filter_Service"

    static let appBundleID = "FelzyTech.Image-Filter-Service"
    static let extensionBundleID = "FelzyTech.Image-Filter-Service.Extension"
    /// An update is only installed if its code signature was made by this Apple team.
    static let teamID = "J97QDPV6YC"

    /// Ed25519 public key (32 raw bytes, base64) that every update manifest must be signed with.
    /// The private half lives only in the GitHub secret UPDATE_SIGNING_KEY (and the maintainer's
    /// Keychain). CI checks that the signature it makes verifies against THIS value, so the secret
    /// and this constant can never silently drift apart. To rotate: ship a release signed with the
    /// old key that contains the new key here.
    static let publicKeyBase64 = "tCsCM51T/pwRGr2EEoDPDf7ceFNdY6PzibOrwu3BvmE="

    /// launchd label of the always-on watcher (macOS/com.imagefilter.server.plist).
    static let launchAgentLabel = "com.imagefilter.server"

    /// First check, after the watcher starts (let login settle).
    static let firstCheckDelay: TimeInterval = 120
    /// Time between checks.
    static let checkInterval: TimeInterval = 6 * 3600
    /// Time before trying again after a failed check.
    static let retryInterval: TimeInterval = 30 * 60

    static let maxArchiveBytes: Int64 = 400 * 1024 * 1024
    static let maxManifestBytes = 256 * 1024
    /// An update that fails to install this many times is left alone until a newer one appears.
    static let maxInstallAttempts = 3
}
