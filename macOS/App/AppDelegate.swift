//
//  AppDelegate.swift
//  Image-Filter_Service
//
//  Created by Felzy730 on 1/26/26.
//
//  Two ways to run:
//   - opened normally: the setup window (ViewController) that sends the user to Safari Settings;
//   - with `--start-server-only` (the LaunchAgent, macOS/com.imagefilter.server.plist): the
//     always-on background watcher. It keeps the Safari extension switched on (ExtensionEnforcer)
//     and installs updates while Safari is closed (UpdateScheduler).
//
//  Pictures are filtered inside the Safari extension itself (Shared/Extension/ondevice/engine.js).
//  Until 1.10.0 this watcher also ran a Python filter server while Safari was open; the argument
//  name is kept from then so the LaunchAgents already installed keep working. On start it removes
//  what that server left behind (LegacyServerCleanup).
//

import Cocoa
import Foundation
import os.log
import Darwin // for kill()

@main
class AppDelegate: NSObject, NSApplicationDelegate {
    private let logger = Logger(subsystem: "FelzyTech.Image-Filter-Service", category: "Watcher")
    private let backgroundAgentArgument = "--start-server-only"

    private var isBackgroundAgent = false
    private var extensionEnforcer: ExtensionEnforcer?
    private var updateScheduler: UpdateScheduler?

    // MARK: - App lifecycle

    func applicationWillFinishLaunching(_ notification: Notification) {
        isBackgroundAgent = ProcessInfo.processInfo.arguments.contains(backgroundAgentArgument)
        if isBackgroundAgent {
            NSApp.setActivationPolicy(.accessory)
        }
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        guard isBackgroundAgent else { return }

        setupSafariLifecycleWatcher()
        // Safari is closed while the extension is off (see ExtensionEnforcer).
        let enforcer = ExtensionEnforcer()
        enforcer.start()
        extensionEnforcer = enforcer
        // Silent self-update: checks GitHub in the background and installs a verified update only
        // while Safari is closed (see UpdateScheduler).
        let updater = UpdateScheduler(
            service: UpdateService.production(),
            safariRunning: { [weak self] in self?.isSafariRunning() ?? true })
        updater.start()
        updateScheduler = updater

        let logger = self.logger
        DispatchQueue.global(qos: .utility).async { LegacyServerCleanup.run(logger: logger) }
        logger.info("Running as the background watcher")
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        return !isBackgroundAgent
    }

    // MARK: - Safari lifecycle

    private func setupSafariLifecycleWatcher() {
        NSWorkspace.shared.notificationCenter.addObserver(
            self, selector: #selector(appDidTerminate(_:)),
            name: NSWorkspace.didTerminateApplicationNotification, object: nil)
    }

    @objc private func appDidTerminate(_ notification: Notification) {
        guard let app = notification.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication,
              SafariFamily.contains(bundleID: app.bundleIdentifier),
              !isSafariRunning(excluding: app) else { return }
        updateScheduler?.safariDidClose()   // a waiting update installs now, before Safari restarts
    }

    // Safari itself, plus "Add to Dock" web apps: each web app runs as its own process with bundle
    // ID com.apple.Safari.WebApp.<UUID> and loads the extension.
    private func isSafariRunning(excluding excluded: NSRunningApplication? = nil) -> Bool {
        NSWorkspace.shared.runningApplications.contains {
            SafariFamily.contains(bundleID: $0.bundleIdentifier) && !$0.isTerminated
                && $0.processIdentifier != excluded?.processIdentifier
        }
    }
}

// MARK: - What the Python server left behind (versions before 1.10.0)

/// Runs at every watcher start; a no-op once everything is gone. Touches only the server's own
/// files in this user's Application Support and Caches folders, never the logs, the update state
/// (`Updates.noindex`) or the opt-in review folder (`review/`, the user's own thumbnails).
enum LegacyServerCleanup {
    static func run(logger: Logger) {
        let fm = FileManager.default
        let support = fm.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("Image-Filter-Service", isDirectory: true)
        let caches = fm.urls(for: .cachesDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("Image-Filter-Service", isDirectory: true)

        // A server the old watcher started and nothing stopped (an install while Safari was open).
        // Identified by its own PID file and checked to really be gunicorn before it is stopped:
        // other Python servers on this Mac are none of our business.
        let pidFile = support.appendingPathComponent("gunicorn.pid")
        if let raw = try? String(contentsOf: pidFile, encoding: .utf8),
           let pid = Int32(raw.trimmingCharacters(in: .whitespacesAndNewlines)), pid > 1 {
            if commandLine(of: pid)?.contains("gunicorn") == true {
                kill(-pid, SIGTERM)  // gunicorn runs in its own process group
                logger.info("Stopped the old filter server (pid \(pid))")
            }
        }
        for url in [pidFile,
                    support.appendingPathComponent("venv", isDirectory: true),  // ~0.5–1 GB of Python packages
                    caches.appendingPathComponent("pycache", isDirectory: true)]
        where fm.fileExists(atPath: url.path) {
            do {
                try fm.removeItem(at: url)
                logger.info("Removed \(url.lastPathComponent, privacy: .public) left by the old filter server")
            } catch {
                logger.error("Could not remove \(url.path, privacy: .public): \(error.localizedDescription, privacy: .public)")
            }
        }
    }

    private static func commandLine(of pid: Int32) -> String? {
        let ps = Process()
        ps.executableURL = URL(fileURLWithPath: "/bin/ps")
        ps.arguments = ["-p", String(pid), "-o", "command="]
        let out = Pipe()
        ps.standardOutput = out
        ps.standardError = FileHandle.nullDevice
        guard (try? ps.run()) != nil else { return nil }
        ps.waitUntilExit()
        guard ps.terminationStatus == 0 else { return nil }
        return String(data: out.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8)
    }
}
