//
//  UpdateScheduler.swift
//  Image-Filter_Service
//
//  Runs the self-updater inside the always-on LaunchAgent watcher (`--start-server-only`).
//
//  It is invisible on purpose: no window, no notice, no sound, no Dock icon. The only trace of an
//  update is that the version number shown in the extension's popup goes up. So:
//    - checking and downloading happen quietly in the background, whenever;
//    - the verified update is only INSTALLED while no Safari window and no Safari web app is open
//      (UpdateGate), which means Safari restarts on the new version and no page is ever swapped out
//      from under the user. If Safari is open for days, the update just waits;
//    - installing ends with the watcher being restarted by launchd (its KeepAlive), now running
//      from the new app. That takes a moment and shows nothing.
//

import Cocoa
import os.log

final class UpdateScheduler {
    private let logger = Logger(subsystem: "FelzyTech.Image-Filter-Service", category: "UpdateScheduler")
    private let service: UpdateService
    private let safariRunning: () -> Bool
    private let serverSetupRunning: () -> Bool
    private let prepareForRestart: () -> Void

    private var timer: Timer?
    private var working = false
    private let startedAt = Date()
    private var nextInstallAttempt = Date.distantPast

    init(service: UpdateService,
         safariRunning: @escaping () -> Bool,
         serverSetupRunning: @escaping () -> Bool,
         prepareForRestart: @escaping () -> Void) {
        self.service = service
        self.safariRunning = safariRunning
        self.serverSetupRunning = serverSetupRunning
        self.prepareForRestart = prepareForRestart
    }

    func start() {
        if let why = service.disabledReason {
            logger.info("Self-update is off: \(why, privacy: .public)")
            return
        }
        // One cheap tick a minute (a clock comparison and a small file read) covers every case:
        // a check that is due, an install that was waiting for Safari to close, a retry.
        let timer = Timer(timeInterval: 60, repeats: true) { [weak self] _ in self?.tick() }
        timer.tolerance = 10
        RunLoop.main.add(timer, forMode: .common)
        self.timer = timer
        // The watcher that starts right after an update sweeps away the replaced copy's registrations.
        let service = self.service
        Task.detached(priority: .utility) {
            try? await Task.sleep(nanoseconds: 20_000_000_000)
            service.removeLeftoverRegistrations()
        }
        // An update staged earlier may be installable right now (Safari is often closed at login).
        DispatchQueue.main.asyncAfter(deadline: .now() + 15) { [weak self] in self?.tick() }
        logger.info("Self-update scheduler started")
    }

    /// The last Safari window / web app just quit: the moment a waiting update can go in.
    func safariDidClose() {
        DispatchQueue.main.asyncAfter(deadline: .now() + 3) { [weak self] in self?.tick() }
    }

    private func tick() {
        guard !working else { return }
        if service.pendingVersion != nil, canInstallNow(), Date() >= nextInstallAttempt {
            install()
            return
        }
        guard Date().timeIntervalSince(startedAt) >= UpdateConfig.firstCheckDelay else { return }
        let last = service.lastAttempt
        if UpdateGate.checkIsDue(lastAttempt: last.date, lastSucceeded: last.succeeded, now: Date()) {
            check()
        }
    }

    private func canInstallNow() -> Bool {
        UpdateGate.canInstallNow(safariRunning: safariRunning(), serverSetupRunning: serverSetupRunning())
    }

    private func check() {
        working = true
        let service = self.service
        Task.detached(priority: .utility) {
            _ = try? await service.checkAndStage()     // failures are logged and retried by the service state
            await MainActor.run { [weak self] in
                self?.working = false
                self?.tick()                           // install right away if Safari happens to be closed
            }
        }
    }

    private func install() {
        working = true
        let service = self.service
        Task.detached(priority: .utility) {
            do {
                _ = try service.installPending()
                // Launch Services re-registers the renamed old bundle a moment later: sweep once it has
                // settled, before this process is replaced.
                try? await Task.sleep(nanoseconds: 4_000_000_000)
                service.removeLeftoverRegistrations()
                await MainActor.run { [weak self] in self?.restartIntoNewVersion() }
            } catch {
                await MainActor.run { [weak self] in
                    self?.working = false
                    self?.nextInstallAttempt = Date().addingTimeInterval(15 * 60)
                }
            }
        }
    }

    /// The app on disk is the new version; this process is still the old one. Stop the filter server
    /// (the new watcher starts a fresh one when Safari opens) and let launchd start the new copy.
    private func restartIntoNewVersion() {
        // Safari opened during the swap? Starting a new watcher is still right: it picks the server up.
        prepareForRestart()
        let appURL = Bundle.main.bundleURL

        let kick = Process()
        kick.executableURL = URL(fileURLWithPath: "/bin/launchctl")
        kick.arguments = ["kickstart", "-k", "gui/\(getuid())/\(UpdateConfig.launchAgentLabel)"]
        kick.standardOutput = FileHandle.nullDevice
        kick.standardError = FileHandle.nullDevice
        do { try kick.run(); kick.waitUntilExit() } catch { logger.error("launchctl failed: \(error.localizedDescription, privacy: .public)") }

        if kick.terminationStatus != 0 {
            // Not running under launchd (started by hand): start the new copy ourselves.
            let configuration = NSWorkspace.OpenConfiguration()
            configuration.arguments = ["--start-server-only"]
            configuration.createsNewApplicationInstance = true
            configuration.activates = false
            configuration.addsToRecentItems = false
            NSWorkspace.shared.openApplication(at: appURL, configuration: configuration) { _, _ in exit(0) }
        }
        // launchd normally replaces this process before we get here.
        DispatchQueue.main.asyncAfter(deadline: .now() + 5) { exit(0) }
    }
}
