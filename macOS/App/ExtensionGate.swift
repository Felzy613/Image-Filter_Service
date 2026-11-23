//
//  ExtensionGate.swift
//  Image-Filter_Service
//
//  The decision logic behind the extension enforcer: given a stream of readings of the
//  extension's state, when must Safari be closed? No AppKit here, so it can be tested with
//  plain swiftc (scripts/test_extension_gate.sh).
//
//  Each poll has two sources: Safari's state API (SFSafariExtensionManager, which takes no
//  profile) and Safari's own settings files for the profiles in use (SafariProfileSettings).
//  `combine` turns them into one reading; the streak rules below are the same for both.
//

import Foundation

nonisolated struct ExtensionGate {
    enum Reading: Equatable {
        case on
        case off
        /// The state couldn't be read (error or no reply).
        case unknown
    }

    /// A setting that leaves pictures unfiltered.
    enum Problem: Equatable {
        /// Safari's state API said the extension is off.
        case stateAPIOff
        /// The extension is switched off in this profile.
        case turnedOff(profile: String)
        /// Website access in this profile isn't "All Websites: Allow", or some websites are denied.
        case notAllWebsites(profile: String)
        /// "Allow in Private Browsing" is off.
        case notInPrivateBrowsing
    }

    /// Why the state can't be confirmed.
    enum Uncertainty: Equatable {
        /// The state API failed (and nothing else answered).
        case stateAPI
        /// macOS refused to let the watcher read Safari's settings: it needs Full Disk Access.
        case noFileAccess
        /// A settings file was readable but not in the expected form (missing, or Safari changed it).
        /// The text is for the log.
        case unrecognised(String)
    }

    /// What Safari's settings files say about the profiles in use.
    enum SettingsReading: Equatable {
        case fine
        /// Never empty.
        case problems([Problem])
        case unknown(Uncertainty)
    }

    enum Reason: Equatable {
        /// The extension is off, or set up so that some pages are unfiltered.
        case off([Problem])
        /// The state can't be read, which is treated as off (fail closed).
        case unverifiable(Uncertainty)
    }

    /// Consecutive "off" readings (one per second) before Safari is closed. Two, so a single
    /// stray reading can't close a Safari session that is fine.
    static let offReadingsToBlock = 2
    /// Consecutive readings that were not "on" before an unreadable state counts as off.
    /// Long because the API can fail for a few seconds right after login or wake.
    static let unreadableReadingsToBlock = 15
    /// How long Safari may stay open after the user asked to turn the extension on.
    static let setupDuration: TimeInterval = 120

    private(set) var offStreak = 0
    private(set) var notOnStreak = 0
    private(set) var setupUntil: Date?
    /// What the most recent "off" reading found wrong, and why the most recent unreadable one
    /// couldn't be confirmed: shown in the notice once the streak blocks.
    private(set) var lastProblems: [Problem] = [.stateAPIOff]
    private(set) var lastUncertainty: Uncertainty = .stateAPI

    /// Why Safari must not be used right now, or nil if the extension is fine.
    var blockReason: Reason? {
        if offStreak >= Self.offReadingsToBlock { return .off(lastProblems) }
        if notOnStreak >= Self.unreadableReadingsToBlock { return .unverifiable(lastUncertainty) }
        return nil
    }

    var isBlocking: Bool { blockReason != nil }

    /// One reading from both sources.
    ///
    /// - Anything wrong in either source is "off".
    /// - Settings files fine and the API not saying "off" is "on": the files are what Safari itself
    ///   goes by, and the API fails on about every other call.
    /// - Settings files unreadable is "unknown" even when the API says "on": the API takes no
    ///   profile, so it can't vouch for the profiles in use.
    static func combine(api: Reading, settings: SettingsReading)
        -> (reading: Reading, problems: [Problem], uncertainty: Uncertainty?) {
        var problems: [Problem] = api == .off ? [.stateAPIOff] : []
        switch settings {
        case .problems(let found):
            problems += found
            return (.off, problems, nil)
        case .fine:
            return problems.isEmpty ? (.on, [], nil) : (.off, problems, nil)
        case .unknown(let why):
            return problems.isEmpty ? (.unknown, [], why) : (.off, problems, why)
        }
    }

    /// Records one poll. `settings` nil means only the state API was asked.
    mutating func record(_ api: Reading, settings: SettingsReading? = nil) {
        let combined: (reading: Reading, problems: [Problem], uncertainty: Uncertainty?)
            = settings.map { Self.combine(api: api, settings: $0) }
            ?? (api, api == .off ? [.stateAPIOff] : [], api == .unknown ? .stateAPI : nil)
        if !combined.problems.isEmpty { lastProblems = combined.problems }
        if let why = combined.uncertainty { lastUncertainty = why }

        switch combined.reading {
        case .on:
            offStreak = 0
            notOnStreak = 0
            setupUntil = nil
        case .off:
            offStreak += 1
            notOnStreak += 1
        case .unknown:
            // An unreadable reading doesn't break a run of "off" readings.
            notOnStreak += 1
        }
    }

    /// The user asked to turn the extension on: Safari may stay open for `setupDuration`.
    mutating func beginSetup(now: Date) {
        setupUntil = now.addingTimeInterval(Self.setupDuration)
    }

    mutating func endSetup() {
        setupUntil = nil
    }

    /// Safari was just opened: forget the readings of the previous session. Without this, a block
    /// left over from last time closes Safari again on its very first reading (usually "unreadable",
    /// because Safari is still starting), so it could never reach the "on" reading that clears the
    /// block. A setup period that was started before Safari opened is kept.
    mutating func startNewSession() {
        offStreak = 0
        notOnStreak = 0
    }

    /// Seconds left of the setup period, or nil when there is none (or it has run out).
    func setupRemaining(now: Date) -> TimeInterval? {
        guard let until = setupUntil, until > now else { return nil }
        return until.timeIntervalSince(now)
    }

    /// True when Safari has to be closed: the extension is off and no setup period is running.
    func mustCloseSafari(now: Date) -> Bool {
        isBlocking && setupRemaining(now: now) == nil
    }
}
