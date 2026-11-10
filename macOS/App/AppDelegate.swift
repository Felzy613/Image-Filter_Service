//
//  AppDelegate.swift
//  Image-Filter_Service
//
//  Created by Felzy730 on 1/26/26.
//

import Cocoa
import Foundation
import os.log
import Darwin // for kill()

@main
class AppDelegate: NSObject, NSApplicationDelegate {
    private let logger = Logger(subsystem: "FelzyTech.Image-Filter-Service", category: "ServerStartup")
    private let serverOnlyLaunchArgument = "--start-server-only"

    private var isServerOnlyMode = false
    private var healthCheckTimer: Timer?
    private var setupInProgress = false
    private var extensionEnforcer: ExtensionEnforcer?
    private var updateScheduler: UpdateScheduler?

    // MARK: - Path resolution
    //
    // Release: server files (incl. start_server.py) are bundled inside Contents/Resources/server/.
    // Dev:     server files live at the hardcoded repo location; fall through
    //          to the dev path when the bundle copy is absent.

    private var serverResourcesURL: URL {
        let bundled = Bundle.main.resourceURL!.appendingPathComponent("server")
        if FileManager.default.fileExists(atPath: bundled.appendingPathComponent("app.py").path) {
            return bundled
        }
        return URL(fileURLWithPath: NSHomeDirectory())
            .appendingPathComponent(
                "Documents/Software Development/Coding/Random/Image-Filter_Service/server",
                isDirectory: true)
    }

    private var startScriptURL: URL {
        serverResourcesURL.appendingPathComponent("start_server.py")
    }

    private var appSupportURL: URL {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)
            .first!.appendingPathComponent("Image-Filter-Service", isDirectory: true)
    }

    private var logsURL: URL {
        FileManager.default.urls(for: .libraryDirectory, in: .userDomainMask)
            .first!.appendingPathComponent("Logs/Image-Filter-Service", isDirectory: true)
    }

    // Prefer the installed venv in Application Support; fall back to dev .venv.
    private var venvURL: URL {
        let installed = appSupportURL.appendingPathComponent("venv")
        if FileManager.default.fileExists(
            atPath: installed.appendingPathComponent("bin/gunicorn").path) {
            return installed
        }
        return URL(fileURLWithPath: NSHomeDirectory())
            .appendingPathComponent(
                "Documents/Software Development/Coding/Random/Image-Filter_Service/.venv",
                isDirectory: true)
    }

    // Where venv is created during first-launch setup.
    private var preferredVenvURL: URL {
        appSupportURL.appendingPathComponent("venv")
    }

    private var pidFileURL: URL {
        appSupportURL.appendingPathComponent("gunicorn.pid")
    }

    // MARK: - App lifecycle

    func applicationWillFinishLaunching(_ notification: Notification) {
        isServerOnlyMode = ProcessInfo.processInfo.arguments.contains(serverOnlyLaunchArgument)
        if isServerOnlyMode {
            NSApp.setActivationPolicy(.accessory)
        }
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        DistributedNotificationCenter.default().addObserver(
            self,
            selector: #selector(handleEnsureServer(_:)),
            name: NSNotification.Name("com.imagefilter.ensureServer"),
            object: nil)

        if isServerOnlyMode {
            setupSafariLifecycleWatcher()
            setupServerHealthCheck()
            // The always-on watcher also keeps the Safari extension switched on:
            // Safari is closed while the extension is off (see ExtensionEnforcer).
            let enforcer = ExtensionEnforcer()
            enforcer.start()
            extensionEnforcer = enforcer
            // Silent self-update: checks GitHub in the background and installs a verified update
            // only while Safari is closed (see UpdateScheduler).
            let updater = UpdateScheduler(
                service: UpdateService.production(),
                safariRunning: { [weak self] in self?.isSafariRunning() ?? true },
                serverSetupRunning: { [weak self] in self?.setupInProgress ?? true },
                prepareForRestart: { [weak self] in self?.stopServer() })
            updater.start()
            updateScheduler = updater
            logger.info("Running in server-only background-agent mode")
        }

        // Start the server only if Safari is already running. If Safari is closed,
        // the agent stays idle (negligible footprint) and waits for the
        // appDidLaunch notification to start the server on demand.
        if isSafariRunning() {
            startLocalServerIfNeeded()
        } else {
            logger.info("Safari not running at launch — agent idle until Safari opens")
        }
    }

    func applicationWillTerminate(_ notification: Notification) {
        healthCheckTimer?.invalidate()
        if isServerOnlyMode {
            stopServer()
        }
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        return !isServerOnlyMode
    }

    // MARK: - Distributed notification

    @objc private func handleEnsureServer(_ notification: Notification) {
        logger.info("Received ensureServer notification from extension")
        startLocalServerIfNeeded()
    }

    // MARK: - Safari lifecycle

    private func setupSafariLifecycleWatcher() {
        let nc = NSWorkspace.shared.notificationCenter
        nc.addObserver(self,
                       selector: #selector(appDidTerminate(_:)),
                       name: NSWorkspace.didTerminateApplicationNotification,
                       object: nil)
        nc.addObserver(self,
                       selector: #selector(appDidLaunch(_:)),
                       name: NSWorkspace.didLaunchApplicationNotification,
                       object: nil)
    }

    @objc private func appDidTerminate(_ notification: Notification) {
        guard let app = safariApp(in: notification) else { return }
        // Quitting Safari while a Dock web app is still open (or vice versa) must not
        // stop the server — it stays up until the last Safari-family app is gone.
        guard !isSafariRunning(excluding: app) else {
            logger.info("\(app.bundleIdentifier ?? "?", privacy: .public) terminated — other Safari apps still open, keeping server")
            return
        }
        logger.info("Safari terminated — stopping server; agent stays alive watching for next launch")
        stopServer()
        updateScheduler?.safariDidClose()   // a waiting update installs now, before Safari restarts
    }

    @objc private func appDidLaunch(_ notification: Notification) {
        guard let app = safariApp(in: notification) else { return }
        logger.info("\(app.bundleIdentifier ?? "?", privacy: .public) launched — ensuring server is running")
        startLocalServerIfNeeded()
    }

    // Safari itself, plus "Add to Dock" web apps: each web app runs as its own
    // process with bundle ID com.apple.Safari.WebApp.<UUID> and loads the extension,
    // so it needs the server even when Safari proper is closed.
    private func isSafariFamily(_ app: NSRunningApplication) -> Bool {
        SafariFamily.contains(bundleID: app.bundleIdentifier)
    }

    private func safariApp(in notification: Notification) -> NSRunningApplication? {
        guard let app = notification.userInfo?[NSWorkspace.applicationUserInfoKey]
                as? NSRunningApplication, isSafariFamily(app) else { return nil }
        return app
    }

    private func isSafariRunning(excluding excluded: NSRunningApplication? = nil) -> Bool {
        NSWorkspace.shared.runningApplications.contains {
            isSafariFamily($0) && !$0.isTerminated
                && $0.processIdentifier != excluded?.processIdentifier
        }
    }

    // MARK: - Health check

    private func setupServerHealthCheck() {
        DispatchQueue.main.async {
            self.healthCheckTimer = Timer.scheduledTimer(
                withTimeInterval: 10, repeats: true) { [weak self] _ in
                // No-ops when Safari is closed (guard inside startLocalServerIfNeeded);
                // restarts the server within ~10s if it crashes while Safari is open.
                self?.startLocalServerIfNeeded()
            }
        }
    }

    // MARK: - Server start

    private func startLocalServerIfNeeded() {
        guard !setupInProgress else { return }

        // Foolproof invariant: the heavy server only ever runs while Safari (or a
        // Safari web app) is open. Every entry point (launch, health check,
        // ensureServer notification) funnels through here, so this single guard
        // guarantees the server is never running when Safari is closed.
        guard isSafariRunning() else {
            logger.info("Safari and Safari web apps not running — skipping server start")
            return
        }

        var request = URLRequest(url: URL(string: "http://127.0.0.1:10000/")!)
        request.timeoutInterval = 1.0

        URLSession.shared.dataTask(with: request) { [weak self] _, response, error in
            guard let self else { return }

            if let http = response as? HTTPURLResponse, http.statusCode == 200 {
                self.logger.info("Server already running on port 10000")
                return
            }
            if let error {
                self.logger.info("Server check: \(error.localizedDescription, privacy: .public)")
            }

            self.ensureDirectories()

            guard self.isVenvReady() else {
                self.logger.info("venv not ready — running first-launch setup in background")
                self.setupInProgress = true
                self.runVenvSetup { [weak self] success in
                    guard let self else { return }
                    self.setupInProgress = false
                    if success {
                        self.logger.info("First-launch setup complete — starting server")
                        self.launchServerBootstrapScript()
                    } else {
                        self.logger.error("First-launch setup failed — server cannot start")
                    }
                }
                return
            }

            self.logger.info("Server not reachable — launching bootstrap script")
            self.launchServerBootstrapScript()
        }.resume()
    }

    private func ensureDirectories() {
        try? FileManager.default.createDirectory(at: appSupportURL, withIntermediateDirectories: true)
        try? FileManager.default.createDirectory(at: logsURL, withIntermediateDirectories: true)
    }

    private func isVenvReady() -> Bool {
        FileManager.default.fileExists(
            atPath: venvURL.appendingPathComponent("bin/gunicorn").path)
    }

    private func findPython3() -> URL? {
        ["/opt/homebrew/bin/python3", "/usr/local/bin/python3", "/usr/bin/python3"]
            .map { URL(fileURLWithPath: $0) }
            .first { FileManager.default.isExecutableFile(atPath: $0.path) }
    }

    private func runVenvSetup(completion: @escaping (Bool) -> Void) {
        guard let python = findPython3() else {
            logger.error("python3 not found — cannot install server dependencies")
            completion(false)
            return
        }

        let target = preferredVenvURL
        let reqPath = Bundle.main.resourceURL!.appendingPathComponent("requirements.txt")

        DispatchQueue.global(qos: .utility).async { [weak self] in
            guard let self else { return }

            self.logger.info("Creating venv at \(target.path, privacy: .public)")
            let create = Process()
            create.executableURL = python
            create.arguments = ["-m", "venv", target.path]
            guard (try? create.run()) != nil else { completion(false); return }
            create.waitUntilExit()
            guard create.terminationStatus == 0 else {
                self.logger.error("python -m venv exited \(create.terminationStatus)")
                completion(false)
                return
            }

            self.logger.info("Installing Python dependencies (this may take a few minutes)…")
            let pip = Process()
            pip.executableURL = target.appendingPathComponent("bin/pip")
            pip.arguments = ["install", "--quiet", "-r", reqPath.path]
            guard (try? pip.run()) != nil else { completion(false); return }
            pip.waitUntilExit()

            if pip.terminationStatus != 0 {
                self.logger.error("pip install exited \(pip.terminationStatus)")
            }
            completion(pip.terminationStatus == 0)
        }
    }

    private func launchServerBootstrapScript() {
        let script = startScriptURL
        guard FileManager.default.fileExists(atPath: script.path) else {
            logger.error("start_server.py not found: \(script.path, privacy: .public)")
            return
        }
        guard let python = findPython3() else {
            logger.error("python3 not found — cannot launch server")
            return
        }

        let process = Process()
        process.executableURL = python
        process.arguments = [
            script.path,
            "--venv",       venvURL.path,
            "--server-dir", serverResourcesURL.path,
            "--log-dir",    logsURL.path,
            "--pid-file",   pidFileURL.path,
        ]
        process.currentDirectoryURL = serverResourcesURL
        process.terminationHandler = { [weak self] p in
            self?.logger.info("Bootstrap exited with status \(p.terminationStatus)")
        }

        do {
            try process.run()
            logger.info("Bootstrap script launched")
        } catch {
            logger.error("Could not launch bootstrap: \(error.localizedDescription, privacy: .public)")
        }
    }

    // MARK: - Server stop

    private func stopServer() {
        logger.info("Stopping gunicorn server…")

        if let raw = try? String(contentsOf: pidFileURL, encoding: .utf8),
           let pid = Int32(raw.trimmingCharacters(in: .whitespacesAndNewlines)),
           pid > 0 {
            logger.info("Sending SIGTERM to gunicorn process group (master PID \(pid))")
            kill(-pid, SIGTERM)
            try? FileManager.default.removeItem(at: pidFileURL)
            return
        }

        logger.info("PID file not found — falling back to pkill")
        let pkill = Process()
        pkill.executableURL = URL(fileURLWithPath: "/usr/bin/pkill")
        pkill.arguments = ["-f", "gunicorn.*app:app"]
        try? pkill.run()
        pkill.waitUntilExit()
        logger.info("pkill exited with status \(pkill.terminationStatus)")
    }
}
