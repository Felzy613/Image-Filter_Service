//
//  ExtensionGate.swift
//  Image-Filter_Service
//
//  The decision logic behind the extension enforcer: given a stream of readings of the
//  extension's on/off state, when must Safari be closed? No AppKit here, so it can be
//  tested with plain swiftc (scripts/test_extension_gate.sh).
//

import Foundation

struct ExtensionGate {
    enum Reading: Equatable {
        case on
        case off
        /// The state couldn't be read (error or no reply).
        case unknown
    }

    enum Reason: Equatable {
        /// The extension is switched off.
        case off
        /// The state can't be read, which is treated as off (fail closed).
        case unverifiable
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

    /// Why Safari must not be used right now, or nil if the extension is fine.
    var blockReason: Reason? {
        if offStreak >= Self.offReadingsToBlock { return .off }
        if notOnStreak >= Self.unreadableReadingsToBlock { return .unverifiable }
        return nil
    }

    var isBlocking: Bool { blockReason != nil }

    mutating func record(_ reading: Reading) {
        switch reading {
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
