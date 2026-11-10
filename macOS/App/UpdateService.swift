//
//  UpdateService.swift
//  Image-Filter_Service
//
//  Silent self-update, in two steps that never show anything to the user:
//
//    checkAndStage()  fetch the signed manifest from GitHub, download the zip it names, and verify
//                     it (signature, size, SHA-256, then the unpacked app's own code signature).
//                     The verified app waits in Application Support.
//    installPending() swap it for the installed app (atomic exchange, rollback on any failure).
//                     The scheduler only calls this while Safari is closed, so Safari restarts on
//                     the new version; nothing is announced.
//
//  No AppKit; the trust rules live in UpdateCore.swift. Tested by scripts/test_update.sh.
//

import Darwin
import Foundation
import os.log

// MARK: - Persisted state

nonisolated struct UpdateState: Codable, Equatable {
    struct Staged: Codable, Equatable {
        var version: String
        var notes: String
        var appPath: String
        var manifestSha256: String
    }
    var lastAttempt: Date?
    var lastAttemptSucceeded: Bool
    var lastError: String?
    var staged: Staged?
    var failedInstalls: [String: Int]
    var installedVersion: String?

    static let empty = UpdateState(lastAttempt: nil, lastAttemptSucceeded: true, lastError: nil,
                                   staged: nil, failedInstalls: [:], installedVersion: nil)
}

/// One update operation at a time across processes (the watcher and the app window can both run).
nonisolated final class UpdateLock {
    private var fd: Int32

    init?(path: String) {
        fd = open(path, O_CREAT | O_RDWR, 0o600)
        guard fd >= 0 else { return nil }
        if flock(fd, LOCK_EX | LOCK_NB) != 0 {
            close(fd)
            fd = -1
            return nil
        }
    }

    func release() {
        guard fd >= 0 else { return }
        flock(fd, LOCK_UN)
        close(fd)
        fd = -1
    }

    deinit { release() }
}

/// Refuses redirects to hosts the feed doesn't allow (so a poisoned redirect can't send the
/// download somewhere else).
private final class RedirectGuard: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    let isAllowed: (URL) -> Bool
    init(isAllowed: @escaping (URL) -> Bool) { self.isAllowed = isAllowed }

    func urlSession(_ session: URLSession, task: URLSessionTask,
                    willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest,
                    completionHandler: @escaping (URLRequest?) -> Void) {
        if let url = request.url, isAllowed(url) { completionHandler(request) } else { completionHandler(nil) }
    }
}

// MARK: - Service

nonisolated final class UpdateService: @unchecked Sendable {

    enum CheckOutcome: Equatable {
        case upToDate
        case staged(version: String)
    }

    struct Options {
        var feed = UpdateFeed.production
        var publicKeyBase64 = UpdateConfig.publicKeyBase64
        var bundleID = UpdateConfig.appBundleID
        var appRequirement = UpdateBundleCheck.productionAppRequirement
        var extensionRequirement: String? = UpdateBundleCheck.productionExtensionRequirement
        var installedApp = Bundle.main.bundleURL
        var currentVersion = (Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String) ?? "0"
        var root = UpdateService.defaultRoot
        var logFile: URL? = UpdateService.defaultLogFile
        /// Dev builds (DerivedData, a Downloads folder) must never replace themselves.
        var onlyInApplicationsFolder = true
        var maxArchiveBytes = UpdateConfig.maxArchiveBytes
        var registerWithLaunchServices = true
    }

    static var defaultRoot: URL {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("Image-Filter-Service/Updates.noindex", isDirectory: true)
    }
    static var defaultLogFile: URL {
        FileManager.default.urls(for: .libraryDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("Logs/Image-Filter-Service/update.log")
    }

    static func production() -> UpdateService { UpdateService(Options()) }

    // Test seams.
    var afterSwapHook: ((URL) throws -> Void)?
    var forceFallbackSwap = false

    let options: Options
    private let logger = Logger(subsystem: "FelzyTech.Image-Filter-Service", category: "Update")
    private let stateLock = NSLock()
    private let session: URLSession
    private let redirectGuard: RedirectGuard
    private let fm = FileManager.default

    init(_ options: Options) {
        self.options = options
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 30
        config.timeoutIntervalForResource = 900
        session = URLSession(configuration: config)
        redirectGuard = RedirectGuard(isAllowed: options.feed.isAllowed)
        try? fm.createDirectory(at: options.root, withIntermediateDirectories: true)
    }

    // MARK: Public state

    var disabledReason: String? {
        guard options.onlyInApplicationsFolder else { return nil }
        let path = options.installedApp.path
        if path.hasPrefix("/Applications/") || path.hasPrefix(NSHomeDirectory() + "/Applications/") { return nil }
        return "this copy is not installed in Applications"
    }

    /// Version of a verified update that is waiting to be installed.
    var pendingVersion: String? {
        let state = loadState()
        guard let staged = state.staged,
              UpdateVersion.isNewer(staged.version, than: options.currentVersion),
              state.failedInstalls[staged.version, default: 0] < UpdateConfig.maxInstallAttempts,
              fm.fileExists(atPath: staged.appPath) else { return nil }
        return staged.version
    }

    var lastAttempt: (date: Date?, succeeded: Bool) {
        let state = loadState()
        return (state.lastAttempt, state.lastAttemptSucceeded)
    }

    // MARK: Check + stage

    func checkAndStage() async throws -> CheckOutcome {
        if let why = disabledReason { throw UpdateError.disabled(why) }
        guard let lock = UpdateLock(path: options.root.appendingPathComponent("lock").path) else { throw UpdateError.busy }
        defer { lock.release() }
        do {
            let outcome = try await performCheck()
            updateState { $0.lastAttempt = Date(); $0.lastAttemptSucceeded = true; $0.lastError = nil }
            return outcome
        } catch {
            let text = (error as? UpdateError)?.errorDescription ?? error.localizedDescription
            log("check failed: \(text)")
            updateState { $0.lastAttempt = Date(); $0.lastAttemptSucceeded = false; $0.lastError = text }
            throw error
        }
    }

    private func performCheck() async throws -> CheckOutcome {
        cleanWorkAreas()
        let manifest = try await fetchManifest()
        guard UpdateVersion.isNewer(manifest.version, than: options.currentVersion) else {
            log("up to date: running \(options.currentVersion), latest \(manifest.version)")
            return .upToDate
        }
        // Already downloaded and still valid? Nothing to do.
        if let staged = loadState().staged, staged.version == manifest.version,
           staged.manifestSha256 == manifest.sha256, fm.fileExists(atPath: staged.appPath),
           (try? validate(URL(fileURLWithPath: staged.appPath), version: manifest.version)) != nil {
            return .staged(version: manifest.version)
        }

        log("update \(manifest.version) found (running \(options.currentVersion)); downloading")
        let zip = options.root.appendingPathComponent("download", isDirectory: true).appendingPathComponent(manifest.asset)
        try fm.createDirectory(at: zip.deletingLastPathComponent(), withIntermediateDirectories: true)
        try await download(manifest, to: zip)

        let size = (try? fm.attributesOfItem(atPath: zip.path)[.size] as? Int64) ?? -1
        guard size == manifest.size else { throw UpdateError.sizeMismatch }
        guard try UpdateHash.sha256Hex(of: zip) == manifest.sha256 else { throw UpdateError.hashMismatch }

        let extractDir = options.root.appendingPathComponent("extract", isDirectory: true)
        try? fm.removeItem(at: extractDir)
        try fm.createDirectory(at: extractDir, withIntermediateDirectories: true)
        try await extract(zip, into: extractDir)
        let unpacked = try locateApp(in: extractDir)
        try validate(unpacked, version: manifest.version)

        let stagedDir = options.root.appendingPathComponent("staged/\(manifest.version)", isDirectory: true)
        try? fm.removeItem(at: stagedDir)
        try fm.createDirectory(at: stagedDir, withIntermediateDirectories: true)
        let stagedApp = stagedDir.appendingPathComponent(options.installedApp.lastPathComponent)
        try fm.moveItem(at: unpacked, to: stagedApp)
        runSync("/usr/bin/xattr", ["-dr", "com.apple.quarantine", stagedApp.path])
        try? fm.removeItem(at: zip.deletingLastPathComponent())
        try? fm.removeItem(at: extractDir)

        updateState {
            $0.staged = .init(version: manifest.version, notes: manifest.notes, appPath: stagedApp.path,
                              manifestSha256: manifest.sha256)
        }
        log("update \(manifest.version) verified and staged")
        return .staged(version: manifest.version)
    }

    private func request(_ url: URL, accept: String) -> URLRequest {
        var request = URLRequest(url: url, timeoutInterval: 30)
        request.cachePolicy = .reloadIgnoringLocalCacheData
        request.setValue("ImageFilterService/\(options.currentVersion)", forHTTPHeaderField: "User-Agent")
        request.setValue(accept, forHTTPHeaderField: "Accept")
        return request
    }

    private func fetchManifest() async throws -> UpdateManifest {
        let url = options.feed.manifestURL
        guard options.feed.isAllowed(url) else { throw UpdateError.network("blocked URL") }
        let result: (Data, URLResponse)
        do {
            result = try await session.data(for: request(url, accept: "application/octet-stream"), delegate: redirectGuard)
        } catch {
            throw UpdateError.network(error.localizedDescription)
        }
        guard let http = result.1 as? HTTPURLResponse else { throw UpdateError.network("no HTTP response") }
        guard http.statusCode == 200 else { throw UpdateError.network("HTTP \(http.statusCode)") }
        guard result.0.count <= UpdateConfig.maxManifestBytes else { throw UpdateError.badEnvelope }
        return try UpdateEnvelope.open(result.0, publicKeyBase64: options.publicKeyBase64,
                                       expectedBundleID: options.bundleID, maxSize: options.maxArchiveBytes)
    }

    private func download(_ manifest: UpdateManifest, to destination: URL) async throws {
        let url = options.feed.assetURL(manifest.tag, manifest.asset)
        guard options.feed.isAllowed(url) else { throw UpdateError.network("blocked URL") }
        let bytes: URLSession.AsyncBytes
        let response: URLResponse
        do {
            (bytes, response) = try await session.bytes(for: request(url, accept: "application/octet-stream"), delegate: redirectGuard)
        } catch {
            throw UpdateError.network(error.localizedDescription)
        }
        guard let http = response as? HTTPURLResponse else { throw UpdateError.network("no HTTP response") }
        guard http.statusCode == 200 else { throw UpdateError.network("download: HTTP \(http.statusCode)") }
        if response.expectedContentLength > 0, response.expectedContentLength != manifest.size {
            throw UpdateError.sizeMismatch
        }

        fm.createFile(atPath: destination.path, contents: nil)
        let handle = try FileHandle(forWritingTo: destination)
        defer { try? handle.close() }
        var received: Int64 = 0
        var buffer = Data(capacity: 1 << 16)
        do {
            for try await byte in bytes {
                buffer.append(byte)
                if buffer.count >= 1 << 16 {
                    received += Int64(buffer.count)
                    guard received <= manifest.size else { throw UpdateError.sizeMismatch }
                    try handle.write(contentsOf: buffer)
                    buffer.removeAll(keepingCapacity: true)
                }
            }
            received += Int64(buffer.count)
            guard received <= manifest.size else { throw UpdateError.sizeMismatch }
            try handle.write(contentsOf: buffer)
        } catch let error as UpdateError {
            throw error
        } catch {
            throw UpdateError.network(error.localizedDescription)
        }
    }

    private func extract(_ zip: URL, into directory: URL) async throws {
        let status = await withCheckedContinuation { (continuation: CheckedContinuation<Int32, Never>) in
            DispatchQueue.global(qos: .utility).async {
                continuation.resume(returning: self.runSync("/usr/bin/ditto", ["-x", "-k", zip.path, directory.path]))
            }
        }
        guard status == 0 else { throw UpdateError.extractFailed("ditto exited \(status)") }
    }

    /// Exactly one app, named like the installed one, at the top of the archive.
    private func locateApp(in directory: URL) throws -> URL {
        let entries = ((try? fm.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)) ?? [])
            .filter { !$0.lastPathComponent.hasPrefix(".") && $0.lastPathComponent != "__MACOSX" }
        guard entries.count == 1, entries[0].lastPathComponent == options.installedApp.lastPathComponent else {
            throw UpdateError.bundleInvalid("the archive does not contain exactly \(options.installedApp.lastPathComponent)")
        }
        return entries[0]
    }

    private func validate(_ app: URL, version: String) throws {
        try UpdateBundleCheck.validate(app: app, bundleID: options.bundleID, version: version,
                                       appRequirement: options.appRequirement,
                                       extensionRequirement: options.extensionRequirement)
    }

    // MARK: Install

    /// Replaces the installed app with the staged one. Returns the version now installed. The caller
    /// restarts the watcher afterwards (UpdateScheduler); this never touches running processes.
    @discardableResult
    func installPending() throws -> String {
        if let why = disabledReason { throw UpdateError.disabled(why) }
        guard let lock = UpdateLock(path: options.root.appendingPathComponent("lock").path) else { throw UpdateError.busy }
        defer { lock.release() }
        guard let staged = loadState().staged else { throw UpdateError.installFailed("nothing is staged") }
        guard UpdateVersion.isNewer(staged.version, than: options.currentVersion) else {
            updateState { $0.staged = nil }
            throw UpdateError.installFailed("\(staged.version) is not newer than \(options.currentVersion)")
        }
        do {
            try performInstall(staged)
            updateState { $0.staged = nil; $0.installedVersion = staged.version; $0.failedInstalls[staged.version] = nil }
            removeTree(options.root.appendingPathComponent("staged/\(staged.version)"))
            log("installed \(staged.version) (was \(options.currentVersion))")
            return staged.version
        } catch {
            let text = (error as? UpdateError)?.errorDescription ?? error.localizedDescription
            log("install of \(staged.version) failed: \(text)")
            updateState { $0.failedInstalls[staged.version, default: 0] += 1; $0.lastError = text }
            throw error
        }
    }

    private func performInstall(_ staged: UpdateState.Staged) throws {
        let newApp = URL(fileURLWithPath: staged.appPath)
        let installed = options.installedApp
        let parent = installed.deletingLastPathComponent()

        // The staged copy sits in a folder the user can write to, so check it again right before use.
        try validate(newApp, version: staged.version)
        guard fm.isWritableFile(atPath: parent.path) else {
            throw UpdateError.notWritable("\(parent.path) is not writable by this user")
        }

        let old = try swapIn(new: newApp, over: installed)
        do {
            // The bundle that is now in place is the one that gets checked: no gap between check and use.
            try validate(installed, version: staged.version)
            try afterSwapHook?(installed)
        } catch {
            rollback(old: old, staged: newApp, installed: installed)
            throw error
        }
        runSync("/usr/bin/xattr", ["-dr", "com.apple.quarantine", installed.path])
        if options.registerWithLaunchServices { registerWithLaunchServices(installed) }
        disposeOld(old)
        removeStaleLeftovers(beside: installed)
        removeLeftoverRegistrations()
    }

    /// Launch Services follows a registered bundle when it is renamed or moved, so the REPLACED app and
    /// its extension are registered again at their new path a moment AFTER the swap, even if they were
    /// unregistered first (measured live: two registrations of the extension, 1.9.2 at the hidden
    /// leftover and 1.9.3 in /Applications). So this runs after the swap has settled and again whenever
    /// the watcher starts. It only unregisters copies under the updater's own leftover locations.
    func removeLeftoverRegistrations() {
        let installed = options.installedApp
        let parent = installed.deletingLastPathComponent().path
        let prefixes = ["\(parent)/.\(installed.lastPathComponent).replaced-", options.root.path + "/"]
        let output = runCapture("/usr/bin/pluginkit", ["-mADv", "-i", UpdateConfig.extensionBundleID])
        for appex in UpdateRegistrations.strayAppexPaths(pluginkitOutput: output, ownedPrefixes: prefixes) {
            runSync("/usr/bin/pluginkit", ["-r", appex])
            if let app = UpdateRegistrations.appPath(containing: appex) { runSync(lsregister, ["-u", app]) }
            log("unregistered a leftover copy of the extension at \(appex)")
        }
    }

    /// The first update after a .pkg install can't delete the old bundle (it belongs to root, see
    /// disposeOld) and leaves it beside the app under a hidden name that does not end in ".app", so
    /// nothing registers or lists it. Later installs retry in case an administrator removed it or
    /// changed its owner. Only entries with this exact hidden prefix are ever touched.
    private func removeStaleLeftovers(beside installed: URL) {
        let parent = installed.deletingLastPathComponent()
        let prefix = ".\(installed.lastPathComponent).replaced-"
        for entry in (try? fm.contentsOfDirectory(at: parent, includingPropertiesForKeys: nil)) ?? []
        where entry.lastPathComponent.hasPrefix(prefix) {
            removeTree(entry)
        }
    }

    /// Puts the new bundle at the installed path and returns where the old one ended up.
    private func swapIn(new: URL, over installed: URL) throws -> URL {
        if !forceFallbackSwap {
            // One atomic exchange: there is no moment at which the app is missing.
            if renamex_np(new.path, installed.path, UInt32(RENAME_SWAP)) == 0 { return new }
            log("atomic exchange unavailable (errno \(errno)); using two renames")
        }
        let aside = installed.deletingLastPathComponent()
            .appendingPathComponent(".\(installed.lastPathComponent).replaced-\(Int(Date().timeIntervalSince1970))")
        guard rename(installed.path, aside.path) == 0 else {
            throw UpdateError.notWritable("could not move the installed app aside (errno \(errno))")
        }
        guard rename(new.path, installed.path) == 0 else {
            let code = errno
            _ = rename(aside.path, installed.path)
            throw UpdateError.installFailed("could not move the new version into place (errno \(code))")
        }
        return aside
    }

    private func rollback(old: URL, staged: URL, installed: URL) {
        if old.path == staged.path {
            _ = renamex_np(old.path, installed.path, UInt32(RENAME_SWAP))
        } else {
            _ = rename(installed.path, staged.path)
            _ = rename(old.path, installed.path)
        }
        log("rolled back to the previous version")
    }

    private func registerWithLaunchServices(_ app: URL) {
        runSync(lsregister, ["-f", app.path])
    }

    /// The replaced bundle is an unregistered copy by now (its old path belongs to the new bundle).
    /// Unregister it by its own path anyway, then delete it. A bundle installed by the .pkg is owned
    /// by root and can't be deleted by the user; it is then left in Application Support, where
    /// nothing scans for apps.
    private func disposeOld(_ old: URL) {
        // A bundle we own may contain read-only folders (e.g. server/ made read-only by hand to stop the
        // server writing into it), which would stop the files inside from being deleted. Not our files to
        // protect any more: make them writable first. For a root-owned bundle this simply fails.
        runSync("/bin/chmod", ["-R", "u+w", old.path])
        let plugIns = old.appendingPathComponent("Contents/PlugIns")
        for appex in ((try? fm.contentsOfDirectory(at: plugIns, includingPropertiesForKeys: nil)) ?? [])
        where appex.pathExtension == "appex" {
            runSync("/usr/bin/pluginkit", ["-r", appex.path])
        }
        runSync(lsregister, ["-u", old.path])
        do { try fm.removeItem(at: old); return } catch {}
        var trashed: NSURL?
        do { try fm.trashItem(at: old, resultingItemURL: &trashed); return } catch {}
        log("previous version left at \(old.path) (cannot be deleted by this user)")
    }

    private let lsregister =
        "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"

    // MARK: Housekeeping

    private func cleanWorkAreas() {
        removeTree(options.root.appendingPathComponent("download"))
        removeTree(options.root.appendingPathComponent("extract"))
        // Staged copies that are no longer needed (installed, or older than what is running).
        let keep = loadState().staged?.version
        let stagedRoot = options.root.appendingPathComponent("staged", isDirectory: true)
        for entry in (try? fm.contentsOfDirectory(at: stagedRoot, includingPropertiesForKeys: nil)) ?? [] {
            let version = entry.lastPathComponent
            if version != keep || !UpdateVersion.isNewer(version, than: options.currentVersion) {
                removeTree(entry)
            }
        }
        updateState { state in
            if let staged = state.staged, !self.fm.fileExists(atPath: staged.appPath)
                || !UpdateVersion.isNewer(staged.version, than: self.options.currentVersion) {
                state.staged = nil
            }
        }
    }

    // MARK: State + log

    private var stateURL: URL { options.root.appendingPathComponent("state.json") }

    func loadState() -> UpdateState {
        stateLock.lock(); defer { stateLock.unlock() }
        return readState()
    }

    private func readState() -> UpdateState {
        guard let data = try? Data(contentsOf: stateURL) else { return .empty }
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return (try? decoder.decode(UpdateState.self, from: data)) ?? .empty
    }

    private func updateState(_ change: (inout UpdateState) -> Void) {
        stateLock.lock(); defer { stateLock.unlock() }
        var state = readState()
        change(&state)
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        if let data = try? encoder.encode(state) { try? data.write(to: stateURL, options: .atomic) }
    }

    private func log(_ message: String) {
        logger.info("\(message, privacy: .public)")
        guard let file = options.logFile else { return }
        try? fm.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
        if let size = (try? fm.attributesOfItem(atPath: file.path)[.size] as? Int), size > 256 * 1024 {
            try? fm.removeItem(at: file)
        }
        let line = Data("\(ISO8601DateFormatter().string(from: Date())) \(message)\n".utf8)
        if let handle = try? FileHandle(forWritingTo: file) {
            _ = try? handle.seekToEnd()
            try? handle.write(contentsOf: line)
            try? handle.close()
        } else {
            try? line.write(to: file)
        }
    }

    /// Deletes a folder we own, including read-only folders inside it: an owner can always make its own
    /// folders writable first (this simply fails for a bundle that belongs to root).
    private func removeTree(_ url: URL) {
        runSync("/bin/chmod", ["-R", "u+w", url.path])
        try? fm.removeItem(at: url)
    }

    private func runCapture(_ path: String, _ arguments: [String]) -> String {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: path)
        process.arguments = arguments
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = FileHandle.nullDevice
        do { try process.run() } catch { return "" }
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        return String(decoding: data, as: UTF8.self)
    }

    @discardableResult
    private func runSync(_ path: String, _ arguments: [String]) -> Int32 {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: path)
        process.arguments = arguments
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        do { try process.run() } catch { return -1 }
        process.waitUntilExit()
        return process.terminationStatus
    }
}
