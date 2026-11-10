//
//  Tests for the self-updater (macOS/App/UpdateCore.swift, UpdateService.swift). Not part of any
//  Xcode target; run with scripts/test_update.sh, which builds the fixtures (signed test apps,
//  signed manifests) and a local server first.
//

import Foundation

nonisolated(unsafe) var failures = 0
func check(_ condition: Bool, _ message: String, line: Int = #line) {
    if !condition {
        failures += 1
        print("FAIL (line \(line)): \(message)")
    }
}

/// "badManifest" for UpdateError.badManifest("..."), so cases can be compared without their payload.
func kind(_ error: Error) -> String {
    String(String(describing: error).prefix { $0 != "(" })
}

func expectThrows(_ expected: String, _ message: String, line: Int = #line, _ body: () async throws -> Void) async {
    do {
        try await body()
        failures += 1
        print("FAIL (line \(line)): \(message): expected \(expected), but nothing was thrown")
    } catch {
        if kind(error) != expected {
            failures += 1
            print("FAIL (line \(line)): \(message): expected \(expected), got \(error)")
        }
    }
}

let env = ProcessInfo.processInfo.environment
let base = env["IFS_TEST_BASE"]!
let publicKey = env["IFS_TEST_PUB"]!
let work = URL(fileURLWithPath: env["IFS_TEST_WORK"]!)
let fixtures = URL(fileURLWithPath: env["IFS_TEST_FIXTURES"]!)
let testRequirement = #"identifier "test.ifs.app""#
let fm = FileManager.default

// MARK: - Versions

check(UpdateVersion.parse("1.8.0") == [1, 8, 0], "parses 1.8.0")
check(UpdateVersion.parse("1.8.0.1") == [1, 8, 0, 1], "parses four components")
for bad in ["", "1..2", "1.2.3.4.5", "a.b", "1.-2", "1.2 ", " 1.2", "١.٢", "1.2.3-beta", "1234567890.1"] {
    check(UpdateVersion.parse(bad) == nil, "rejects '\(bad)'")
}
check(UpdateVersion.isNewer("1.8.1", than: "1.8.0"), "1.8.1 > 1.8.0")
check(UpdateVersion.isNewer("1.10.0", than: "1.9.9"), "1.10.0 > 1.9.9 (numeric, not text)")
check(UpdateVersion.isNewer("2.0", than: "1.99.99"), "2.0 > 1.99.99")
check(!UpdateVersion.isNewer("1.8.0", than: "1.8.0"), "equal is not newer")
check(!UpdateVersion.isNewer("1.8", than: "1.8.0"), "1.8 == 1.8.0")
check(!UpdateVersion.isNewer("1.7.9", than: "1.8.0"), "older is not newer (no downgrade)")
check(!UpdateVersion.isNewer("garbage", than: "1.0.0"), "an unparsable candidate is never newer")
check(!UpdateVersion.isNewer("1.0.1", than: "garbage"), "an unparsable current version never updates")

// MARK: - Manifest validation

func manifest(_ change: (inout UpdateManifest) -> Void = { _ in }) -> UpdateManifest {
    var m = UpdateManifest(schema: 1, bundleID: "test.ifs.app", version: "1.0.1", tag: "v1.0.1",
                           asset: "App-1.0.1.zip", size: 1000, sha256: String(repeating: "a", count: 64),
                           notes: "n", published: "2026-01-01T00:00:00Z")
    change(&m)
    return m
}
func valid(_ m: UpdateManifest) -> Bool {
    (try? m.validate(expectedBundleID: "test.ifs.app", maxSize: 5000)) != nil
}
check(valid(manifest()), "a sane manifest is valid")
check(!valid(manifest { $0.schema = 2 }), "unknown schema rejected")
check(!valid(manifest { $0.bundleID = "other.app" }), "other bundle id rejected")
check(!valid(manifest { $0.version = "1.0.x" }), "bad version rejected")
check(!valid(manifest { $0.tag = "v9.9.9" }), "tag that disagrees with version rejected")
check(!valid(manifest { $0.tag = "v1.0.1/../../x" }), "tag with path tricks rejected")
for asset in ["../evil.zip", "a/b.zip", "a b.zip", ".hidden.zip", "x.zip.exe", "x..zip", "", String(repeating: "a", count: 120) + ".zip", "é.zip"] {
    check(!valid(manifest { $0.asset = asset }), "asset '\(asset.prefix(20))' rejected")
}
check(!valid(manifest { $0.size = 0 }), "zero size rejected")
check(!valid(manifest { $0.size = 6000 }), "size over the cap rejected")
check(!valid(manifest { $0.sha256 = "ABC" }), "short sha rejected")
check(!valid(manifest { $0.sha256 = String(repeating: "A", count: 64) }), "uppercase sha rejected")
check(!valid(manifest { $0.sha256 = String(repeating: "g", count: 64) }), "non-hex sha rejected")
check(!valid(manifest { $0.notes = String(repeating: "x", count: 30_000) }), "huge notes rejected")

// MARK: - Production URLs and host policy

let feed = UpdateFeed.production
check(feed.manifestURL.absoluteString == "https://github.com/\(UpdateConfig.repo)/releases/latest/download/update.json",
      "production manifest URL")
check(feed.assetURL("v1.8.1", "App-1.8.1.zip").absoluteString
      == "https://github.com/\(UpdateConfig.repo)/releases/download/v1.8.1/App-1.8.1.zip", "production asset URL")
for url in ["https://github.com/x", "https://objects.githubusercontent.com/y", "https://release-assets.githubusercontent.com/z",
            "https://api.github.com/a"] {
    check(feed.isAllowed(URL(string: url)!), "allowed: \(url)")
}
for url in ["http://github.com/x", "https://evilgithub.com/x", "https://github.com.evil.com/x", "https://githubusercontent.com.evil.io/x",
            "https://example.com", "ftp://github.com/x", "https://notgithub.com"] {
    check(!feed.isAllowed(URL(string: url)!), "blocked: \(url)")
}

// MARK: - Gate

check(UpdateGate.canInstallNow(safariRunning: false, serverSetupRunning: false), "installs when Safari is closed")
check(!UpdateGate.canInstallNow(safariRunning: true, serverSetupRunning: false), "waits while Safari is open")
check(!UpdateGate.canInstallNow(safariRunning: false, serverSetupRunning: true), "waits during first-launch setup")
let now = Date(timeIntervalSince1970: 2_000_000_000)
check(UpdateGate.checkIsDue(lastAttempt: nil, lastSucceeded: true, now: now), "first check is due")
check(!UpdateGate.checkIsDue(lastAttempt: now.addingTimeInterval(-3600), lastSucceeded: true, now: now), "not due 1 h after success")
check(UpdateGate.checkIsDue(lastAttempt: now.addingTimeInterval(-UpdateConfig.checkInterval - 1), lastSucceeded: true, now: now), "due after the interval")
check(!UpdateGate.checkIsDue(lastAttempt: now.addingTimeInterval(-600), lastSucceeded: false, now: now), "not due 10 min after a failure")
check(UpdateGate.checkIsDue(lastAttempt: now.addingTimeInterval(-UpdateConfig.retryInterval - 1), lastSucceeded: false, now: now), "retry after a failure")
check(UpdateGate.checkIsDue(lastAttempt: now.addingTimeInterval(3600), lastSucceeded: true, now: now), "a clock set back doesn't freeze updates")

// MARK: - Leftover registrations (the real pluginkit output from the live 1.9.2 -> 1.9.3 update)

let pluginkitOutput = "     FelzyTech.Image-Filter-Service.Extension(1.9.2)\t8D722CE1-757E-4167-A41E-BDF9218ED6BC\t2026-11-10 03:05:04 +0000\t/Applications/.Image-Filter_Service.app.replaced-1794281437/Contents/PlugIns/Image-Filter_Service Extension.appex\n"
    + "     FelzyTech.Image-Filter-Service.Extension(1.9.3)\tA9045415-E535-450C-83F4-D3454951B840\t2026-11-10 03:30:37 +0000\t/Applications/Image-Filter_Service.app/Contents/PlugIns/Image-Filter_Service Extension.appex\n"
    + "     FelzyTech.Image-Filter-Service.Extension(1.9.4)\tAAAAAAAA-0000-0000-0000-000000000000\t2026-11-10 04:00:00 +0000\t/Users/me/Library/Application Support/Image-Filter-Service/Updates.noindex/staged/1.9.4/Image-Filter_Service.app/Contents/PlugIns/Image-Filter_Service Extension.appex\n"
    + "     FelzyTech.Image-Filter-Service.Extension(1.9.4)\tBBBBBBBB-0000-0000-0000-000000000000\t2026-11-10 04:00:00 +0000\t/Users/me/Library/Developer/Xcode/DerivedData/x/Build/Products/Debug/Image-Filter_Service.app/Contents/PlugIns/Image-Filter_Service Extension.appex\n"
let owned = ["/Applications/.Image-Filter_Service.app.replaced-", "/Users/me/Library/Application Support/Image-Filter-Service/Updates.noindex/"]
let strays = UpdateRegistrations.strayAppexPaths(pluginkitOutput: pluginkitOutput, ownedPrefixes: owned)
check(strays.count == 2, "exactly the two leftover copies are found, got \(strays.count)")
check(strays.contains { $0.hasPrefix("/Applications/.Image-Filter_Service.app.replaced-1794281437/") }, "the hidden leftover is found")
check(strays.contains { $0.contains("/Updates.noindex/staged/1.9.4/") }, "a copy left in the updater's own folder is found")
check(!strays.contains { $0.hasPrefix("/Applications/Image-Filter_Service.app/") }, "the installed app is NEVER a stray")
check(!strays.contains { $0.contains("DerivedData") }, "another copy (a dev build) is NEVER touched")
check(UpdateRegistrations.strayAppexPaths(pluginkitOutput: "", ownedPrefixes: owned).isEmpty, "empty output gives nothing")
check(UpdateRegistrations.strayAppexPaths(pluginkitOutput: "garbage line without tabs\n", ownedPrefixes: owned).isEmpty, "malformed output gives nothing")
check(UpdateRegistrations.strayAppexPaths(pluginkitOutput: pluginkitOutput, ownedPrefixes: []).isEmpty, "no owned prefixes -> nothing is ever unregistered")
check(UpdateRegistrations.appPath(containing: strays[0]) == "/Applications/.Image-Filter_Service.app.replaced-1794281437", "app path derived from the extension path")
check(UpdateRegistrations.appPath(containing: "/x/y.appex") == nil, "a path that is not inside Contents/PlugIns has no app path")

// MARK: - Envelope (signature)

func envelope(_ scenario: String) -> Data { try! Data(contentsOf: URL(fileURLWithPath: env["IFS_TEST_SRV"]!).appendingPathComponent("\(scenario)/update.json")) }
func open(_ data: Data, key: String = publicKey) throws -> UpdateManifest {
    try UpdateEnvelope.open(data, publicKeyBase64: key, expectedBundleID: "test.ifs.app", maxSize: 400_000_000)
}
let good = try! open(envelope("ok"))
check(good.version == "1.0.1" && good.asset == "IFSTest-1.0.1.zip" && good.size > 0, "good envelope opens: \(good.version)")
check((try? open(envelope("ok"), key: env["IFS_TEST_WRONG_PUB"]!)) == nil, "a different public key rejects it")
do { _ = try open(envelope("wrongkey")); check(false, "wrong-key envelope must not open") } catch { check(kind(error) == "badSignature", "wrong key -> badSignature, got \(error)") }
do { _ = try open(Data("not json".utf8)); check(false, "garbage must not open") } catch { check(kind(error) == "badEnvelope", "garbage -> badEnvelope, got \(error)") }
do {
    // Flip one character inside the signed payload: the signature must no longer match.
    var json = try! JSONSerialization.jsonObject(with: envelope("ok")) as! [String: Any]
    var payload = Data(base64Encoded: json["payload"] as! String)!
    payload = Data(String(decoding: payload, as: UTF8.self).replacingOccurrences(of: "1.0.1", with: "9.9.9").utf8)
    json["payload"] = payload.base64EncodedString()
    let forged = try! JSONSerialization.data(withJSONObject: json)
    do { _ = try open(forged); check(false, "forged payload must not open") } catch { check(kind(error) == "badSignature", "forged payload -> badSignature, got \(error)") }
}
do { _ = try open(envelope("wrongbundle")); check(false, "other bundle id must not open") } catch { check(kind(error) == "badManifest", "other bundle -> badManifest, got \(error)") }

// MARK: - Production signing requirement, against the real installed app (skipped if absent)

let realApp = URL(fileURLWithPath: "/Applications/Image-Filter_Service.app")
if fm.fileExists(atPath: realApp.path) {
    do { try UpdateBundleCheck.checkSignature(of: realApp, requirement: UpdateBundleCheck.productionAppRequirement) }
    catch { check(false, "installed app must satisfy the production requirement: \(error)") }
    let appex = realApp.appendingPathComponent("Contents/PlugIns/Image-Filter_Service Extension.appex")
    do { try UpdateBundleCheck.checkSignature(of: appex, requirement: UpdateBundleCheck.productionExtensionRequirement) }
    catch { check(false, "installed extension must satisfy the production requirement: \(error)") }
    check((try? UpdateBundleCheck.checkSignature(of: realApp, requirement: UpdateBundleCheck.requirement(identifier: UpdateConfig.appBundleID, teamID: "AAAAAAAAAA"))) == nil,
          "the installed app must NOT satisfy a requirement naming another team")
    check((try? UpdateBundleCheck.checkSignature(of: realApp, requirement: UpdateBundleCheck.requirement(identifier: "some.other.app", teamID: UpdateConfig.teamID))) == nil,
          "the installed app must NOT satisfy a requirement naming another identifier")
    print("note: production requirement checked against \(realApp.path)")
} else {
    print("note: \(realApp.path) not installed; production requirement check skipped")
}
check((try? UpdateBundleCheck.checkSignature(of: fixtures.appendingPathComponent("old/IFSTest.app"), requirement: UpdateBundleCheck.productionAppRequirement)) == nil,
      "an ad-hoc signed app must NOT satisfy the production requirement")

// MARK: - Service, end to end against the local server

var counter = 0
func makeService(_ scenario: String, current: String = "1.0.0", requirement: String = testRequirement) -> (UpdateService, URL, URL) {
    counter += 1
    let dir = work.appendingPathComponent("case\(counter)")
    let apps = dir.appendingPathComponent("Applications")
    try! fm.createDirectory(at: apps, withIntermediateDirectories: true)
    let installed = apps.appendingPathComponent("IFSTest.app")
    let copy = Process()
    copy.executableURL = URL(fileURLWithPath: "/usr/bin/ditto")
    copy.arguments = [fixtures.appendingPathComponent("old/IFSTest.app").path, installed.path]
    try! copy.run(); copy.waitUntilExit()

    var options = UpdateService.Options()
    options.feed = UpdateFeed(
        manifestURL: URL(string: "\(base)/\(scenario)/update.json")!,
        assetURL: { tag, asset in URL(string: "\(base)/\(scenario)/download/\(tag)/\(asset)")! },
        isAllowed: { $0.host == "127.0.0.1" })
    options.publicKeyBase64 = publicKey
    options.bundleID = "test.ifs.app"
    options.appRequirement = requirement
    options.extensionRequirement = nil
    options.installedApp = installed
    options.currentVersion = current
    options.root = dir.appendingPathComponent("root")
    options.logFile = dir.appendingPathComponent("update.log")
    options.onlyInApplicationsFolder = false
    options.registerWithLaunchServices = false
    return (UpdateService(options), installed, dir)
}
func installedVersion(_ app: URL) -> String {
    (NSDictionary(contentsOf: app.appendingPathComponent("Contents/Info.plist"))?["CFBundleShortVersionString"] as? String) ?? "?"
}
func output(of app: URL) -> String {
    let p = Process(); let pipe = Pipe()
    p.executableURL = app.appendingPathComponent("Contents/MacOS/IFSTest"); p.standardOutput = pipe
    try? p.run(); p.waitUntilExit()
    return String(decoding: pipe.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
}

// Happy path: check, stage, install.
do {
    let (svc, installed, dir) = makeService("ok")
    check(svc.pendingVersion == nil, "nothing pending at the start")
    do {
        let outcome = try await svc.checkAndStage()
        check(outcome == .staged(version: "1.0.1"), "ok: staged 1.0.1, got \(outcome)")
    } catch { check(false, "ok: check failed: \(error)") }
    check(svc.pendingVersion == "1.0.1", "ok: 1.0.1 is pending")
    check(installedVersion(installed) == "1.0.0", "ok: nothing installed until installPending()")
    // A second check must not download again, and still reports the staged version.
    let again = try? await svc.checkAndStage()
    check(again == .staged(version: "1.0.1"), "ok: re-check keeps the staged update")
    do {
        let version = try svc.installPending()
        check(version == "1.0.1", "ok: installed \(version)")
    } catch { check(false, "ok: install failed: \(error)") }
    check(installedVersion(installed) == "1.0.1", "ok: installed app is 1.0.1, is \(installedVersion(installed))")
    check(output(of: installed) == "IFSTest ok", "ok: the installed app runs")
    check((try? UpdateBundleCheck.checkSignature(of: installed, requirement: testRequirement)) != nil, "ok: installed app has a valid signature")
    check(svc.pendingVersion == nil, "ok: nothing pending after the install")
    let leftovers = ((try? fm.contentsOfDirectory(atPath: installed.deletingLastPathComponent().path)) ?? []).filter { $0 != "IFSTest.app" }
    check(leftovers.isEmpty, "ok: no stray copies next to the app: \(leftovers)")
    check(!fm.fileExists(atPath: dir.appendingPathComponent("root/staged/1.0.1").path), "ok: the staged folder is gone")
    // After the restart the new version sees nothing newer.
    let (svc2, _, _) = makeService("ok", current: "1.0.1")
    check((try? await svc2.checkAndStage()) == .upToDate, "ok: up to date once on 1.0.1")
}

// Same install through the two-rename fallback (used if the atomic exchange is unavailable).
do {
    let (svc, installed, _) = makeService("ok")
    svc.forceFallbackSwap = true
    _ = try? await svc.checkAndStage()
    do { _ = try svc.installPending() } catch { check(false, "fallback: install failed: \(error)") }
    check(installedVersion(installed) == "1.0.1", "fallback: installed app is 1.0.1")
    let leftovers = ((try? fm.contentsOfDirectory(atPath: installed.deletingLastPathComponent().path)) ?? []).filter { $0 != "IFSTest.app" }
    check(leftovers.isEmpty, "fallback: no hidden leftovers: \(leftovers)")
}

// The first update after a .pkg install: the installed bundle belongs to root, so the user can
// neither move it across folders nor delete it. A read-only bundle reproduces that for a non-root user.
for forceFallback in [false, true] {
    let label = forceFallback ? "read-only old (fallback swap)" : "read-only old (atomic swap)"
    let (svc, installed, dir) = makeService("ok")
    svc.forceFallbackSwap = forceFallback
    let chmod = Process()
    chmod.executableURL = URL(fileURLWithPath: "/bin/chmod"); chmod.arguments = ["-R", "a-w", installed.path]
    try! chmod.run(); chmod.waitUntilExit()
    _ = try? await svc.checkAndStage()
    do { _ = try svc.installPending() } catch { check(false, "\(label): install failed: \(error)") }
    check(installedVersion(installed) == "1.0.1", "\(label): new version is in place, is \(installedVersion(installed))")
    check(output(of: installed) == "IFSTest ok", "\(label): the new app runs")
    check(fm.isWritableFile(atPath: installed.path), "\(label): the new bundle belongs to the user, so the NEXT update is clean")
    let apps = installed.deletingLastPathComponent().path
    let visible = ((try? fm.contentsOfDirectory(atPath: apps)) ?? []).filter { $0 != "IFSTest.app" }
    check(visible.allSatisfy { $0.hasPrefix(".") && !$0.hasSuffix(".app") },
          "\(label): anything left next to the app is hidden and not an .app: \(visible)")
    print("note: \(label): left next to the app: \(visible.isEmpty ? "nothing" : visible.joined(separator: ", ")); in Updates folder: \(((try? fm.contentsOfDirectory(atPath: dir.appendingPathComponent("root/staged").path)) ?? []).joined(separator: ","))")
}

// A user-owned old bundle with a read-only folder inside (the interim guard on a live Mac): the atomic
// exchange still works and the old copy is deleted completely, not left behind.
do {
    let (svc, installed, dir) = makeService("ok")
    let guarded = installed.appendingPathComponent("Contents/Resources")
    try! fm.createDirectory(at: guarded, withIntermediateDirectories: true)
    try! Data("x".utf8).write(to: guarded.appendingPathComponent("data.txt"))
    let chmod = Process()
    chmod.executableURL = URL(fileURLWithPath: "/bin/chmod"); chmod.arguments = ["a-w", guarded.path]
    try! chmod.run(); chmod.waitUntilExit()
    _ = try? await svc.checkAndStage()
    do { _ = try svc.installPending() } catch { check(false, "guarded old: install failed: \(error)") }
    check(installedVersion(installed) == "1.0.1", "guarded old: new version in place")
    let apps = installed.deletingLastPathComponent().path
    check(((try? fm.contentsOfDirectory(atPath: apps)) ?? []).filter { $0 != "IFSTest.app" }.isEmpty, "guarded old: nothing left beside the app")
    check(!fm.fileExists(atPath: dir.appendingPathComponent("root/staged/1.0.1").path), "guarded old: the old copy was deleted from the updates folder too")
}

// Rollback: a failure after the swap restores the old app and counts the attempt.
do {
    struct Boom: Error {}
    let (svc, installed, _) = makeService("ok")
    svc.afterSwapHook = { _ in throw Boom() }
    _ = try? await svc.checkAndStage()
    for attempt in 1...3 {
        do { _ = try svc.installPending(); check(false, "rollback: attempt \(attempt) should fail") } catch {}
        check(installedVersion(installed) == "1.0.0", "rollback: still 1.0.0 after attempt \(attempt)")
        check(output(of: installed) == "IFSTest ok", "rollback: the old app still runs after attempt \(attempt)")
        check(svc.loadState().failedInstalls["1.0.1"] == attempt, "rollback: attempt \(attempt) counted")
    }
    check(svc.pendingVersion == nil, "rollback: after \(UpdateConfig.maxInstallAttempts) failures the update is left alone")
}

// Things that must be refused.
await expectThrows("hashMismatch", "tampered archive (same size, one byte changed)") {
    let (svc, installed, _) = makeService("tampered")
    defer { check(installedVersion(installed) == "1.0.0", "tampered: installed app untouched") }
    _ = try await svc.checkAndStage()
}
await expectThrows("badSignature", "manifest signed with another key") {
    _ = try await makeService("wrongkey").0.checkAndStage()
}
await expectThrows("badManifest", "manifest for another app") {
    _ = try await makeService("wrongbundle").0.checkAndStage()
}
await expectThrows("bundleInvalid", "app whose version is not the promised one") {
    _ = try await makeService("vermismatch").0.checkAndStage()
}
await expectThrows("bundleInvalid", "app whose files changed after signing") {
    _ = try await makeService("sealbroken").0.checkAndStage()
}
await expectThrows("bundleInvalid", "app not signed as the required identity") {
    _ = try await makeService("ok", requirement: #"identifier "someone.else""#).0.checkAndStage()
}
await expectThrows("network", "redirect to a host that is not allowed") {
    _ = try await makeService("evil").0.checkAndStage()
}
await expectThrows("network", "no manifest published (HTTP 404)") {
    _ = try await makeService("does-not-exist").0.checkAndStage()
}
await expectThrows("disabled", "a copy outside Applications never updates itself") {
    let (svc, _, dir) = makeService("ok")
    var o = svc.options
    o.onlyInApplicationsFolder = true
    o.root = dir.appendingPathComponent("root2")
    _ = try await UpdateService(o).checkAndStage()
}
do {
    let (svc, _, dir) = makeService("ok")
    let held = UpdateLock(path: dir.appendingPathComponent("root/lock").path)
    check(held != nil, "lock can be taken")
    await expectThrows("busy", "a second operation while one is running") { _ = try await svc.checkAndStage() }
    held?.release()
    check((try? await svc.checkAndStage()) == .staged(version: "1.0.1"), "works again once the lock is released")
}

// Never downgrade or reinstall.
check((try? await makeService("same").0.checkAndStage()) == .upToDate, "same version -> up to date")
check((try? await makeService("older").0.checkAndStage()) == .upToDate, "older signed build replayed -> ignored")
do {
    let (svc, installed, _) = makeService("older")
    _ = try? await svc.checkAndStage()
    check(svc.pendingVersion == nil && installedVersion(installed) == "1.0.0", "older build is never staged or installed")
    do { _ = try svc.installPending(); check(false, "install with nothing staged must throw") } catch {}
}

print(failures == 0 ? "All update tests passed." : "\(failures) update test(s) failed.")
exit(failures == 0 ? 0 : 1)
