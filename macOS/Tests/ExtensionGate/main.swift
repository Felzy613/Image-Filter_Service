//
//  Tests for ExtensionGate (macOS/App/ExtensionGate.swift). Not part of any Xcode target;
//  run with scripts/test_extension_gate.sh.
//

import Foundation

var failures = 0
func check(_ condition: Bool, _ message: String, line: Int = #line) {
    if !condition {
        failures += 1
        print("FAIL (line \(line)): \(message)")
    }
}

let t0 = Date(timeIntervalSince1970: 1_000_000)

func gate(_ readings: [ExtensionGate.Reading]) -> ExtensionGate {
    var g = ExtensionGate()
    readings.forEach { g.record($0) }
    return g
}

// A fresh gate lets Safari be.
check(!ExtensionGate().isBlocking, "fresh gate must not block")
check(!ExtensionGate().mustCloseSafari(now: t0), "fresh gate must not close Safari")

// One stray "off" doesn't close Safari; two in a row do.
check(!gate([.off]).isBlocking, "a single off reading must not block")
check(gate([.off, .off]).blockReason == .off, "two off readings in a row must block")
check(gate([.off, .off]).mustCloseSafari(now: t0), "blocked and not in setup must close Safari")

// "On" resets the run, so isolated off readings never add up.
check(!gate([.off, .on, .off]).isBlocking, "off, on, off must not block")
check(!gate([.off, .on, .off, .on, .off]).isBlocking, "isolated off readings must not add up")
check(!gate([.off, .off, .on]).isBlocking, "an on reading clears a block")

// Unreadable state: tolerated briefly, then treated as off (fail closed).
let unreadable = ExtensionGate.unreadableReadingsToBlock
check(!gate(Array(repeating: .unknown, count: unreadable - 1)).isBlocking, "a few unreadable readings must not block")
check(gate(Array(repeating: .unknown, count: unreadable)).blockReason == .unverifiable, "a long run of unreadable readings must block")
check(!gate(Array(repeating: .unknown, count: unreadable - 1) + [.on] + [.unknown]).isBlocking, "an on reading resets the unreadable run")
check(gate([.off, .unknown, .off]).blockReason == .off, "an unreadable reading must not break a run of off readings")
check(gate(Array(repeating: .unknown, count: unreadable - 1) + [.off]).blockReason == .unverifiable, "unreadable + off readings add up")

// Setup period: Safari may stay open for setupDuration, then must close again.
var g = gate([.off, .off])
g.beginSetup(now: t0)
check(g.isBlocking, "setup doesn't clear the block")
check(!g.mustCloseSafari(now: t0), "Safari may stay open at the start of setup")
check(!g.mustCloseSafari(now: t0.addingTimeInterval(ExtensionGate.setupDuration - 1)), "Safari may stay open until setup runs out")
check(g.mustCloseSafari(now: t0.addingTimeInterval(ExtensionGate.setupDuration)), "Safari must close when setup runs out")
check(g.setupRemaining(now: t0.addingTimeInterval(30)) == ExtensionGate.setupDuration - 30, "remaining time counts down")
check(g.setupRemaining(now: t0.addingTimeInterval(ExtensionGate.setupDuration + 1)) == nil, "no remaining time after setup")

// Turning the extension on ends setup and the block; turning it off again blocks again.
g.record(.on)
check(!g.isBlocking && g.setupUntil == nil, "on clears block and setup")
g.record(.off); g.record(.off)
check(g.mustCloseSafari(now: t0.addingTimeInterval(1)), "after setup ended by 'on', a new off run must close Safari")

// Closing Safari ends the setup period but keeps the block.
var h = gate([.off, .off])
h.beginSetup(now: t0)
h.endSetup()
check(h.mustCloseSafari(now: t0), "endSetup must put the block back in force")

// A new Safari session starts fresh: a block left over from last time must not close Safari again on
// its first (usually unreadable) reading.
var stale = gate(Array(repeating: .unknown, count: unreadable))
check(stale.isBlocking, "setup for the test: a long unreadable run blocks")
stale.startNewSession()
check(!stale.isBlocking, "a new session must not start blocked")
stale.record(.unknown)
check(!stale.isBlocking && !stale.mustCloseSafari(now: t0), "the first unreadable reading of a new session must not close Safari")
var staleOff = gate([.off, .off])
staleOff.startNewSession()
staleOff.record(.unknown)
check(!staleOff.isBlocking, "an old 'off' run must not carry into a new session")
staleOff.record(.off); staleOff.record(.off)
check(staleOff.mustCloseSafari(now: t0), "two fresh off readings in the new session still close Safari")

// ...but a setup period started before Safari opened survives it (the button opens Safari afterwards).
var pending = gate([.off, .off])
pending.beginSetup(now: t0)
pending.startNewSession()
check(pending.setupRemaining(now: t0) == ExtensionGate.setupDuration, "startNewSession keeps a setup period that is running")
pending.record(.off); pending.record(.off)
check(!pending.mustCloseSafari(now: t0.addingTimeInterval(1)), "Safari stays open during the setup period even after fresh off readings")

if failures == 0 {
    print("ExtensionGate: all checks passed")
} else {
    print("ExtensionGate: \(failures) check(s) failed")
    exit(1)
}
