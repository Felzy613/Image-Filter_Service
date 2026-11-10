//
//  ExtensionEnforcer.swift
//  Image-Filter_Service
//
//  Keeps the Safari extension switched on. Safari has no API for an app to turn an
//  extension on, so enforcement means: while Safari (or a Safari web app) is open, read
//  the extension's state every second; if it is off, close Safari and show a notice with
//  a button that opens Safari Settings, and give the user a short setup period (see
//  ExtensionGate) to turn it back on. Runs inside the always-on LaunchAgent watcher
//  (`--start-server-only`), which launchd keeps alive.
//
//  Nothing here can be switched off from the app: there is deliberately no quit item or
//  bypass.
//

import Cocoa
import SafariServices
import os.log

/// Which running apps count as "Safari": Safari itself plus "Add to Dock" web apps, which
/// are separate processes (`com.apple.Safari.WebApp.<UUID>`) that load the extension too.
enum SafariFamily {
    static func contains(bundleID: String?) -> Bool {
        guard let id = bundleID else { return false }
        return id == "com.apple.Safari" || id.hasPrefix("com.apple.Safari.WebApp.")
    }
}

#if DEBUG
/// Test hooks, compiled into Debug builds only, so tests never have to touch a real Safari
/// session. Both are independent:
///   IFS_ENFORCER_TARGET=<bundle id>   close this app (e.g. Calculator) instead of Safari;
///                                     "Turn On" then doesn't open Safari Settings
///   IFS_ENFORCER_STATE_FILE=<path>    read the extension state (on, off, unknown) from this
///                                     file instead of asking Safari
enum EnforcerTestMode {
    static let targetBundleID = ProcessInfo.processInfo.environment["IFS_ENFORCER_TARGET"]
    static let stateFile = ProcessInfo.processInfo.environment["IFS_ENFORCER_STATE_FILE"]

    static func readStateFile(_ path: String) -> ExtensionGate.Reading {
        let text = (try? String(contentsOfFile: path, encoding: .utf8)) ?? ""
        switch text.trimmingCharacters(in: .whitespacesAndNewlines) {
        case "on": return .on
        case "off": return .off
        default: return .unknown
        }
    }
}
#endif

final class ExtensionEnforcer: NSObject {
    private let logger = Logger(subsystem: "FelzyTech.Image-Filter-Service", category: "Enforcer")
    private let pollInterval: TimeInterval = 1
    /// How long a reading may take before it counts as "unknown".
    private let readTimeout: TimeInterval = 3
    /// Grace before an app that ignored the quit request is force-quit.
    private let forceQuitDelay: TimeInterval = 2

    private var gate = ExtensionGate()
    private var lastReading: ExtensionGate.Reading?
    private var lastFailure: String?
    private var timer: Timer?
    private var readInFlight = false
    private var quitRequested = Set<pid_t>()
    private let notice = EnforcementNotice()

    func start() {
        let nc = NSWorkspace.shared.notificationCenter
        nc.addObserver(self, selector: #selector(appsChanged(_:)),
                       name: NSWorkspace.didLaunchApplicationNotification, object: nil)
        nc.addObserver(self, selector: #selector(appsChanged(_:)),
                       name: NSWorkspace.didTerminateApplicationNotification, object: nil)
        notice.onTurnOn = { [weak self] in self?.beginSetup() }
        logger.info("Extension enforcer started")
        updatePolling()
    }

    // MARK: - Watching Safari

    private func isGuarded(_ app: NSRunningApplication) -> Bool {
        #if DEBUG
        if let target = EnforcerTestMode.targetBundleID { return app.bundleIdentifier == target }
        #endif
        return SafariFamily.contains(bundleID: app.bundleIdentifier)
    }

    private func guardedApps() -> [NSRunningApplication] {
        NSWorkspace.shared.runningApplications.filter { isGuarded($0) && !$0.isTerminated }
    }

    @objc private func appsChanged(_ notification: Notification) {
        guard let app = notification.userInfo?[NSWorkspace.applicationUserInfoKey]
                as? NSRunningApplication, isGuarded(app) else { return }
        updatePolling()
    }

    /// Polls only while Safari is open: the state matters only then, and an idle watcher
    /// should cost nothing.
    private func updatePolling() {
        if !guardedApps().isEmpty {
            guard timer == nil else { return }
            logger.info("Safari is open — checking the extension every \(self.pollInterval, privacy: .public) s")
            gate.startNewSession()
            lastReading = nil
            let t = Timer(timeInterval: pollInterval, repeats: true) { [weak self] _ in self?.poll() }
            t.tolerance = 0.2
            RunLoop.main.add(t, forMode: .common)   // .common: keeps firing while menus are open
            timer = t
            poll()
        } else if timer != nil {
            logger.info("Safari closed — pausing checks")
            timer?.invalidate()
            timer = nil
            // A setup period belongs to the Safari session it was started for.
            gate.endSetup()
            if let reason = gate.blockReason { notice.show(.blocked(reason)) } else { notice.hide() }
        }
    }

    // MARK: - Reading the state

    private func poll() {
        guard !readInFlight else { return }
        readInFlight = true
        readState { [weak self] first in
            guard let self else { return }
            if first == .unknown {
                // Measured on the installed app: the state API fails on about every other call
                // (SFErrorNoExtensionFound straight after a success). A second call at once is
                // the cheapest way to get a real answer.
                self.readState { [weak self] second in self?.finishPoll(second) }
            } else {
                self.finishPoll(first)
            }
        }
    }

    private func finishPoll(_ reading: ExtensionGate.Reading) {
        readInFlight = false
        apply(reading)
    }

    /// Delivers exactly one reading on the main queue, even if Safari never answers.
    private func readState(_ completion: @escaping (ExtensionGate.Reading) -> Void) {
        #if DEBUG
        if let file = EnforcerTestMode.stateFile {
            completion(EnforcerTestMode.readStateFile(file))
            return
        }
        #endif

        let once = Once(completion)
        SFSafariExtensionManager.getStateOfSafariExtension(
            withIdentifier: extensionBundleIdentifier) { [weak self] state, error in
            let reading: ExtensionGate.Reading
            if let state, error == nil {
                reading = state.isEnabled ? .on : .off
            } else {
                reading = .unknown
            }
            let failure = error.map { "\($0)" }
            DispatchQueue.main.async {
                if let failure { self?.noteReadFailure(failure) }
                once.fire(reading)
            }
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + readTimeout) { once.fire(.unknown) }
    }

    /// Logs a failed read once per distinct error, so a flapping API doesn't flood the log.
    private func noteReadFailure(_ description: String) {
        guard description != lastFailure else { return }
        lastFailure = description
        logger.info("Reading the extension state failed: \(description, privacy: .public)")
    }

    private final class Once {
        private var completion: ((ExtensionGate.Reading) -> Void)?
        init(_ completion: @escaping (ExtensionGate.Reading) -> Void) { self.completion = completion }
        func fire(_ reading: ExtensionGate.Reading) {
            guard let completion else { return }
            self.completion = nil
            completion(reading)
        }
    }

    // MARK: - Acting on it

    private func apply(_ reading: ExtensionGate.Reading) {
        let before = gate.blockReason
        gate.record(reading)
        let now = Date()

        // Log meaningful changes only: a healthy session writes one line, not one per second.
        // A single unreadable reading is noise (see poll()); log it only once it persists.
        let changedState = reading != .unknown && reading != lastReading
        let unreadableForAWhile = reading == .unknown && gate.notOnStreak == 5
        if changedState || unreadableForAWhile || gate.blockReason != before {
            if reading != .unknown { lastReading = reading }
            logger.info("Extension state: \(String(describing: reading), privacy: .public) — blocking: \(String(describing: self.gate.blockReason), privacy: .public)")
        }

        guard let reason = gate.blockReason else {
            notice.hide()
            return
        }
        if let remaining = gate.setupRemaining(now: now) {
            notice.show(.setup(remaining: remaining))
        } else {
            closeSafari(reason)
            notice.show(.blocked(reason))
        }
    }

    private func closeSafari(_ reason: ExtensionGate.Reason) {
        for app in guardedApps() where !quitRequested.contains(app.processIdentifier) {
            let pid = app.processIdentifier
            logger.info("Closing \(app.bundleIdentifier ?? "?", privacy: .public) (pid \(pid)) — \(String(describing: reason), privacy: .public)")
            quitRequested.insert(pid)
            app.terminate()
            DispatchQueue.main.asyncAfter(deadline: .now() + forceQuitDelay) { [weak self] in
                if !app.isTerminated {
                    self?.logger.info("pid \(pid) ignored the quit request — force quitting")
                    app.forceTerminate()
                }
                self?.quitRequested.remove(pid)
            }
        }
    }

    private func beginSetup() {
        gate.beginSetup(now: Date())
        notice.show(.setup(remaining: ExtensionGate.setupDuration))
        logger.info("Setup period started (\(Int(ExtensionGate.setupDuration), privacy: .public) s)")

        #if DEBUG
        if EnforcerTestMode.targetBundleID != nil {
            // A test target stands in for Safari, so there is no Settings window to open.
            updatePolling()
            return
        }
        #endif
        SFSafariApplication.showPreferencesForExtension(
            withIdentifier: extensionBundleIdentifier) { [weak self] error in
            if let error {
                self?.logger.error("Could not open Safari Settings: \(error.localizedDescription, privacy: .public)")
                // The extension can't be found (for example Safari isn't loading it yet), so there is
                // no Settings pane to jump to. Open Safari itself, so the person can get there.
                if let safari = NSWorkspace.shared.urlForApplication(withBundleIdentifier: "com.apple.Safari") {
                    NSWorkspace.shared.openApplication(at: safari, configuration: NSWorkspace.OpenConfiguration()) { _, _ in }
                }
            }
        }
    }
}

// MARK: - Notice window

/// The small floating window shown while Safari is blocked. It never activates the app, so
/// it doesn't take focus from whatever the user is doing.
final class EnforcementNotice: NSObject {
    enum Content {
        case blocked(ExtensionGate.Reason)
        case setup(remaining: TimeInterval)
    }

    var onTurnOn: (() -> Void)?

    private var panel: NSPanel?
    private let titleLabel = NSTextField(labelWithString: "")
    private let bodyLabel = NSTextField(wrappingLabelWithString: "")
    private let button = NSButton(title: "", target: nil, action: nil)

    func show(_ content: Content) {
        let panel = self.panel ?? makePanel()
        self.panel = panel

        switch content {
        case .blocked(.off):
            titleLabel.stringValue = "Safari was closed"
            bodyLabel.stringValue = "The Image Filter Service extension is turned off, so Safari can’t be used. Turn it back on to continue."
            button.title = "Turn On in Safari Settings…"
        case .blocked(.unverifiable):
            titleLabel.stringValue = "Safari was closed"
            bodyLabel.stringValue = "Image Filter Service can’t confirm that its Safari extension is on, so Safari can’t be used. Open Safari Settings and check that it is turned on."
            button.title = "Open Safari Settings…"
        case .setup(let remaining):
            let seconds = Int(remaining.rounded(.up))
            titleLabel.stringValue = "Turn on the extension"
            bodyLabel.stringValue = "In Safari Settings, open Extensions and turn on Image Filter Service. Safari closes again in \(seconds / 60):\(String(format: "%02d", seconds % 60)) if it is still off."
            button.title = "Open Safari Settings Again"
        }

        panel.contentView?.layoutSubtreeIfNeeded()
        if let fitting = panel.contentView?.fittingSize { panel.setContentSize(fitting) }
        if !panel.isVisible {
            // Top-right corner: Safari Settings opens in the middle of the screen, and this
            // window must not cover the checkbox the user has to click.
            if let area = (NSScreen.main ?? NSScreen.screens.first)?.visibleFrame {
                panel.setFrameOrigin(NSPoint(x: area.maxX - panel.frame.width - 24,
                                             y: area.maxY - panel.frame.height - 24))
            } else {
                panel.center()
            }
            panel.orderFrontRegardless()
        }
    }

    func hide() {
        panel?.orderOut(nil)
    }

    @objc private func turnOnTapped() {
        onTurnOn?()
    }

    private func makePanel() -> NSPanel {
        let panel = NSPanel(contentRect: NSRect(x: 0, y: 0, width: 440, height: 140),
                            styleMask: [.titled, .closable, .nonactivatingPanel],
                            backing: .buffered, defer: false)
        panel.title = "Image Filter Service"
        panel.level = .floating
        panel.isFloatingPanel = true
        panel.hidesOnDeactivate = false      // this app is never "active" (accessory mode)
        panel.isReleasedWhenClosed = false
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]

        let icon = NSImageView(image: NSApp.applicationIconImage)
        icon.widthAnchor.constraint(equalToConstant: 64).isActive = true
        icon.heightAnchor.constraint(equalToConstant: 64).isActive = true

        titleLabel.font = .boldSystemFont(ofSize: 15)
        bodyLabel.font = .systemFont(ofSize: 13)
        bodyLabel.widthAnchor.constraint(equalToConstant: 300).isActive = true
        button.bezelStyle = .rounded
        button.keyEquivalent = "\r"
        button.target = self
        button.action = #selector(turnOnTapped)

        let text = NSStackView(views: [titleLabel, bodyLabel, button])
        text.orientation = .vertical
        text.alignment = .leading
        text.spacing = 8

        let row = NSStackView(views: [icon, text])
        row.orientation = .horizontal
        row.alignment = .top
        row.spacing = 16
        row.edgeInsets = NSEdgeInsets(top: 20, left: 20, bottom: 20, right: 20)

        panel.contentView = row
        return panel
    }
}
