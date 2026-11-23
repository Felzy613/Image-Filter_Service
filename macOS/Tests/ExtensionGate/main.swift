//
//  Tests for ExtensionGate (macOS/App/ExtensionGate.swift). Not part of any Xcode target;
//  run with scripts/test_extension_gate.sh.
//

import Foundation
import SQLite3

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
check(gate([.off, .off]).blockReason == .off([.stateAPIOff]), "two off readings in a row must block")
check(gate([.off, .off]).mustCloseSafari(now: t0), "blocked and not in setup must close Safari")

// "On" resets the run, so isolated off readings never add up.
check(!gate([.off, .on, .off]).isBlocking, "off, on, off must not block")
check(!gate([.off, .on, .off, .on, .off]).isBlocking, "isolated off readings must not add up")
check(!gate([.off, .off, .on]).isBlocking, "an on reading clears a block")

// Unreadable state: tolerated briefly, then treated as off (fail closed).
let unreadable = ExtensionGate.unreadableReadingsToBlock
check(!gate(Array(repeating: .unknown, count: unreadable - 1)).isBlocking, "a few unreadable readings must not block")
check(gate(Array(repeating: .unknown, count: unreadable)).blockReason == .unverifiable(.stateAPI), "a long run of unreadable readings must block")
check(!gate(Array(repeating: .unknown, count: unreadable - 1) + [.on] + [.unknown]).isBlocking, "an on reading resets the unreadable run")
check(gate([.off, .unknown, .off]).blockReason == .off([.stateAPIOff]), "an unreadable reading must not break a run of off readings")
check(gate(Array(repeating: .unknown, count: unreadable - 1) + [.off]).blockReason == .unverifiable(.stateAPI), "unreadable + off readings add up")

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

// MARK: - Combining the state API with Safari's settings files

typealias P = ExtensionGate.Problem
let mikeOff: ExtensionGate.SettingsReading = .problems([.turnedOff(profile: "Mike")])
let noAccess: ExtensionGate.SettingsReading = .unknown(.noFileAccess)

func combined(_ api: ExtensionGate.Reading, _ s: ExtensionGate.SettingsReading) -> ExtensionGate.Reading {
    ExtensionGate.combine(api: api, settings: s).reading
}
check(combined(.on, .fine) == .on, "API on + settings fine = on")
check(combined(.unknown, .fine) == .on, "settings fine outweigh a failed API call (it fails on about every other call)")
check(combined(.off, .fine) == .off, "API off is off even when the settings look fine")
check(combined(.on, mikeOff) == .off, "off in a profile in use is off even when the API says on (the 2026-11-23 hole)")
check(combined(.unknown, mikeOff) == .off, "a settings problem is off whatever the API says")
check(combined(.on, noAccess) == .unknown, "unreadable settings are 'can't confirm' even when the API says on")
check(combined(.off, noAccess) == .off, "API off is off even when the settings can't be read")
check(ExtensionGate.combine(api: .off, settings: mikeOff).problems == [.stateAPIOff, .turnedOff(profile: "Mike")],
      "both sources' problems are reported")

func gate(_ polls: [(ExtensionGate.Reading, ExtensionGate.SettingsReading)]) -> ExtensionGate {
    var g = ExtensionGate()
    polls.forEach { g.record($0.0, settings: $0.1) }
    return g
}
check(gate([(.on, mikeOff), (.on, mikeOff)]).blockReason == .off([.turnedOff(profile: "Mike")]),
      "two readings with a profile off block, naming the profile")
check(!gate([(.on, mikeOff)]).isBlocking, "a single settings problem doesn't block")
check(!gate([(.on, mikeOff), (.on, .fine), (.on, mikeOff)]).isBlocking, "a fine reading resets the run")
check(!gate(Array(repeating: (.unknown, .fine), count: unreadable * 2)).isBlocking,
      "with readable settings, a flapping API never blocks")
check(gate(Array(repeating: (.on, noAccess), count: unreadable)).blockReason == .unverifiable(.noFileAccess),
      "no Full Disk Access blocks after the unreadable run, and says why")
check(!gate(Array(repeating: (.on, noAccess), count: unreadable - 1)).isBlocking,
      "no Full Disk Access is tolerated as long as any unreadable state")
let unrecognised: ExtensionGate.SettingsReading = .unknown(.unrecognised("changed"))
check(gate(Array(repeating: (.on, unrecognised), count: unreadable)).blockReason == .unverifiable(.unrecognised("changed")),
      "a settings file Safari changed is 'can't confirm', not 'off'")
check(gate([(.on, mikeOff), (.on, noAccess), (.on, mikeOff)]).blockReason == .off([.turnedOff(profile: "Mike")]),
      "an unreadable reading doesn't break a run of settings problems")
var later = gate([(.on, mikeOff), (.on, .problems([.notInPrivateBrowsing]))])
check(later.blockReason == .off([.notInPrivateBrowsing]), "the notice shows the latest problems")
later.record(.on, settings: .fine)
check(!later.isBlocking, "fixing it unblocks")

// MARK: - Reading Safari's settings files (a fake Safari folder)

let fm = FileManager.default
let extensionKey = "FelzyTech.Image-Filter-Service.Extension (J97QDPV6YC)"
let forever = Date(timeIntervalSince1970: 64_092_211_200)   // 4001-01-01, what Safari stores for "for good"
let mikeUUID = "C8305832-45AF-4612-A4AE-1B8A93273E42", mikeFolder = "A6AB3358-CF17-4431-9C98-3703A1A8372B"
let jzUUID = "5E2A91A1-E79E-418E-BE20-BAF2E3EBF225", jzFolder = "4D6D4A09-AA38-400C-8699-BB4B73A5EBDF"

func entry(enabled: Any? = true, granted: Any? = ["*://*/*": forever], revoked: Any? = [String: Date](),
           privateBrowsing: Any? = nil) -> [String: Any] {
    var e: [String: Any] = ["AddedDate": t0]
    if let enabled { e["Enabled"] = enabled }
    if let granted { e["GrantedPermissionOrigins"] = granted }
    if let revoked { e["RevokedPermissionOrigins"] = revoked }
    if let privateBrowsing { e["AllowInPrivateBrowsing"] = privateBrowsing }
    return e
}
let personalOK = entry(privateBrowsing: true)

/// A Safari data folder: windows (profile IDs, nil = a row with no ProfileUUID, given by row id instead),
/// and settings per profile folder ("" = Personal). A nil entry writes no entry for the extension.
struct FakeSafari {
    let root: String
    init(windows: [String], settings: [String: [String: Any]?], rawWindows: [(Int64?, Data?)] = [],
         extraProfiles: [(String, String, String)] = []) {
        root = NSTemporaryDirectory() + "ifs-gate-tests-" + UUID().uuidString
        try! fm.createDirectory(atPath: root + "/WebExtensions", withIntermediateDirectories: true)
        var db: OpaquePointer?
        precondition(sqlite3_open(root + "/SafariTabs.db", &db) == SQLITE_OK)
        func exec(_ sql: String) { precondition(sqlite3_exec(db, sql, nil, nil, nil) == SQLITE_OK, String(cString: sqlite3_errmsg(db))) }
        // The columns read, as in Safari 27.2's schema.
        exec("CREATE TABLE bookmarks (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT, external_uuid TEXT UNIQUE, server_id TEXT, subtype INTEGER DEFAULT 0)")
        exec("CREATE TABLE windows (id INTEGER PRIMARY KEY, active_profile_id INTEGER DEFAULT NULL, extra_attributes BLOB DEFAULT NULL, is_last_session INTEGER DEFAULT 0, uuid TEXT NOT NULL UNIQUE)")
        exec("INSERT INTO bookmarks (id, title, external_uuid, server_id, subtype) VALUES (5, '', 'DefaultProfile', 'DefaultProfile', 2)")
        exec("INSERT INTO bookmarks (id, title, external_uuid, server_id, subtype) VALUES (5201, 'Mike', '\(mikeUUID)', '\(mikeFolder)', 2)")
        exec("INSERT INTO bookmarks (id, title, external_uuid, server_id, subtype) VALUES (5360, 'JZ', '\(jzUUID)', '\(jzFolder)', 2)")
        exec("INSERT INTO bookmarks (id, title, external_uuid, server_id, subtype) VALUES (22026, 'Local', 'EE8107E0-CA18-43E7-A8E2-6BE869EE19A8', NULL, 0)")
        for (uuid, title, folder) in extraProfiles {
            exec("INSERT INTO bookmarks (title, external_uuid, server_id, subtype) VALUES ('\(title)', '\(uuid)', '\(folder)', 2)")
        }
        var rows = windows.map { id -> (Int64?, Data?) in
            let attrs = try! PropertyListSerialization.data(fromPropertyList: ["ProfileUUID": id, "IsPrivateWindow": false],
                                                            format: .binary, options: 0)
            return (id == "DefaultProfile" ? 5 : nil, attrs)
        }
        rows += rawWindows
        var st: OpaquePointer?
        precondition(sqlite3_prepare_v2(db, "INSERT INTO windows (active_profile_id, extra_attributes, uuid) VALUES (?, ?, ?)", -1, &st, nil) == SQLITE_OK)
        let transient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)
        for (profileRow, attrs) in rows {
            sqlite3_reset(st)
            if let profileRow { sqlite3_bind_int64(st, 1, profileRow) } else { sqlite3_bind_null(st, 1) }
            if let attrs { _ = attrs.withUnsafeBytes { sqlite3_bind_blob(st, 2, $0.baseAddress, Int32(attrs.count), transient) } }
            else { sqlite3_bind_null(st, 2) }
            sqlite3_bind_text(st, 3, UUID().uuidString, -1, transient)
            precondition(sqlite3_step(st) == SQLITE_DONE)
        }
        sqlite3_finalize(st)
        sqlite3_close(db)

        for (folder, e) in settings {
            let dir = folder.isEmpty ? root + "/WebExtensions" : root + "/Profiles/\(folder)/WebExtensions"
            try! fm.createDirectory(atPath: dir, withIntermediateDirectories: true)
            var plist: [String: Any] = ["com.example.other (ABCDE12345)": entry(enabled: false)]
            if let e { plist[extensionKey] = e }
            try! PropertyListSerialization.data(fromPropertyList: plist, format: .binary, options: 0)
                .write(to: URL(fileURLWithPath: dir + "/Extensions.plist"))
        }
    }
    var reader: SafariProfileSettings { SafariProfileSettings(safariDataPath: root, extensionKey: extensionKey) }
    func read(now: Date = t0) -> ExtensionGate.SettingsReading { reader.read(now: now) }
    func remove() { try? fm.removeItem(atPath: root) }
}

func isUnrecognised(_ r: ExtensionGate.SettingsReading) -> Bool {
    if case .unknown(.unrecognised) = r { return true }
    return false
}

var fakes: [FakeSafari] = []
func fake(_ windows: [String], _ settings: [String: [String: Any]?], rawWindows: [(Int64?, Data?)] = [],
          extraProfiles: [(String, String, String)] = []) -> FakeSafari {
    let f = FakeSafari(windows: windows, settings: settings, rawWindows: rawWindows, extraProfiles: extraProfiles)
    fakes.append(f)
    return f
}

// The owner's rule (2026-11-23): only profiles in use count.
check(fake(["DefaultProfile"], ["": personalOK]).read() == .fine, "Personal on, all websites, private browsing: fine")
check(fake(["DefaultProfile", mikeUUID], ["": personalOK, mikeFolder: entry(enabled: false)]).read()
      == .problems([.turnedOff(profile: "Mike")]), "off in a profile with a window: a problem naming it")
check(fake(["DefaultProfile"], ["": personalOK, mikeFolder: entry(enabled: false)]).read() == .fine,
      "off in a profile without a window: fine (only profiles in use count)")
check(fake([mikeUUID], ["": personalOK, mikeFolder: entry()]).read() == .fine,
      "a profile in use other than Personal, on: fine")
check(fake([mikeUUID, mikeUUID, jzUUID], ["": personalOK, mikeFolder: entry(), jzFolder: entry(enabled: false)]).read()
      == .problems([.turnedOff(profile: "JZ")]), "several windows and profiles: each profile checked once")

// Personal is always checked: private windows aren't in SafariTabs.db and the only "Allow in
// Private Browsing" setting is Personal's.
check(fake([mikeUUID], ["": entry(enabled: false), mikeFolder: entry()]).read() == .problems([.turnedOff(profile: "Personal")]),
      "Personal off counts even with no Personal window")
check(fake([], ["": personalOK]).read() == .fine, "no windows at all: only Personal is checked")
check(fake(["DefaultProfile"], ["": entry(privateBrowsing: false)]).read() == .problems([.notInPrivateBrowsing]),
      "private browsing not allowed: a problem")
check(fake(["DefaultProfile"], ["": entry()]).read() == .problems([.notInPrivateBrowsing]),
      "no private browsing key (what Safari stores for extensions never allowed): a problem")
check(fake([mikeUUID], ["": personalOK, mikeFolder: entry()]).read() == .fine,
      "private browsing isn't asked of other profiles (their files have no such key)")

// Website access.
check(fake(["DefaultProfile"], ["": entry(granted: ["*://*.example.com/*": forever], privateBrowsing: true)]).read()
      == .problems([.notAllWebsites(profile: "Personal")]), "only some websites allowed ('Ask'): a problem")
check(fake(["DefaultProfile", mikeUUID], ["": personalOK, mikeFolder: entry(granted: [String: Date]())]).read()
      == .problems([.notAllWebsites(profile: "Mike")]), "no websites allowed: a problem")
check(fake(["DefaultProfile"], ["": entry(granted: ["*://*/*": t0.addingTimeInterval(3600)], privateBrowsing: true)]).read() == .fine,
      "all websites 'for one day', still running: fine")
check(fake(["DefaultProfile"], ["": entry(granted: ["*://*/*": t0.addingTimeInterval(-1)], privateBrowsing: true)]).read()
      == .problems([.notAllWebsites(profile: "Personal")]), "all websites, expired: a problem")
check(fake(["DefaultProfile"], ["": entry(revoked: ["*://*.example.com/*": forever], privateBrowsing: true)]).read()
      == .problems([.notAllWebsites(profile: "Personal")]), "a website denied: a problem")
check(fake(["DefaultProfile"], ["": entry(revoked: ["*://*.example.com/*": t0.addingTimeInterval(-1)], privateBrowsing: true)]).read()
      == .fine, "a denial that has expired: fine")
check(fake(["DefaultProfile", mikeUUID], ["": personalOK, mikeFolder: entry(enabled: false, granted: [String: Date]())]).read()
      == .problems([.turnedOff(profile: "Mike")]), "turned off: website access isn't reported as well")

// Anything not in the measured shape is "can't confirm", never "off" and never "fine".
check(isUnrecognised(fake([mikeUUID], ["": personalOK]).read()), "a profile in use with no settings file: can't confirm")
check(isUnrecognised(fake([mikeUUID], ["": personalOK, mikeFolder: nil]).read()), "no entry for the extension: can't confirm")
check(isUnrecognised(fake(["DefaultProfile"], ["": entry(enabled: nil, privateBrowsing: true)]).read()), "no Enabled key: can't confirm")
check(isUnrecognised(fake(["DefaultProfile"], ["": entry(enabled: "yes", privateBrowsing: true)]).read()), "Enabled of another type: can't confirm")
check(isUnrecognised(fake(["DefaultProfile"], ["": entry(granted: nil, privateBrowsing: true)]).read()), "no website grants: can't confirm")
check(isUnrecognised(fake(["DefaultProfile"], ["": entry(revoked: nil, privateBrowsing: true)]).read()), "no website denials key: can't confirm")
check(isUnrecognised(fake(["DefaultProfile"], ["": entry(granted: ["*://*/*": "forever"], privateBrowsing: true)]).read()),
      "a website grant without a date: can't confirm")
check(isUnrecognised(fake(["7A000000-0000-0000-0000-000000000000"], ["": personalOK]).read()),
      "a window in a profile Safari doesn't list: can't confirm")
check(isUnrecognised(fake([], ["": personalOK], rawWindows: [(nil, nil)]).read()), "a window with no profile at all: can't confirm")
check(isUnrecognised(fake([], ["": personalOK], extraProfiles: [("BAD00000-0000-0000-0000-000000000000", "Bad", "../../x")]).read()) == false,
      "an odd folder name in a profile that isn't in use doesn't matter")
check(isUnrecognised(fake(["BAD00000-0000-0000-0000-000000000000"], ["": personalOK],
                          extraProfiles: [("BAD00000-0000-0000-0000-000000000000", "Bad", "../../x")]).read()),
      "a profile folder that would leave the Safari folder: can't confirm")
let garbled = fake(["DefaultProfile"], ["": personalOK])
try! Data("not a plist".utf8).write(to: URL(fileURLWithPath: garbled.root + "/WebExtensions/Extensions.plist"))
check(isUnrecognised(garbled.read()), "a settings file that isn't a plist: can't confirm")
let noDB = fake(["DefaultProfile"], ["": personalOK])
try! fm.removeItem(atPath: noDB.root + "/SafariTabs.db")
check(isUnrecognised(noDB.read()), "no SafariTabs.db: can't confirm")

// A window row without ProfileUUID falls back to active_profile_id.
check(fake([], ["": personalOK, mikeFolder: entry(enabled: false)], rawWindows: [(5201, nil)]).read()
      == .problems([.turnedOff(profile: "Mike")]), "profile taken from active_profile_id when the window has no ProfileUUID")

// macOS refusing access (no Full Disk Access) is its own reason, so the notice can say what to do.
let locked = fake(["DefaultProfile"], ["": personalOK])
chmod(locked.root + "/WebExtensions/Extensions.plist", 0)
if getuid() != 0 {
    check(locked.read() == .unknown(.noFileAccess), "a settings file macOS won't let us read: no file access")
}
chmod(locked.root + "/WebExtensions/Extensions.plist", 0o644)
check(SafariProfileSettings.isPermissionError(NSError(domain: NSCocoaErrorDomain, code: NSFileReadNoPermissionError)),
      "Cocoa 'no permission' (what EPERM from the privacy check becomes) counts as no access")
check(!SafariProfileSettings.isPermissionError(NSError(domain: NSCocoaErrorDomain, code: NSFileReadNoSuchFileError)),
      "a missing file isn't a permission problem")

fakes.forEach { $0.remove() }

if failures == 0 {
    print("ExtensionGate: all checks passed")
} else {
    print("ExtensionGate: \(failures) check(s) failed")
    exit(1)
}
