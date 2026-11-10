//
//  SafariWebExtensionHandler.swift
//  Image-Filter_Service Extension
//
//  Created by Felzy730 on 1/26/26.
//

import SafariServices
import AppKit
import os.log

class SafariWebExtensionHandler: NSObject, NSExtensionRequestHandling {
    private let hostAppBundleIdentifier = "FelzyTech.Image-Filter-Service"
    private let serverOnlyLaunchArgument = "--start-server-only"

    func beginRequest(with context: NSExtensionContext) {
        let request = context.inputItems.first as? NSExtensionItem

        let profile: UUID?
        if #available(iOS 17.0, macOS 14.0, *) {
            profile = request?.userInfo?[SFExtensionProfileKey] as? UUID
        } else {
            profile = request?.userInfo?["profile"] as? UUID
        }

        let message: Any?
        if #available(iOS 15.0, macOS 11.0, *) {
            message = request?.userInfo?[SFExtensionMessageKey]
        } else {
            message = request?.userInfo?["message"]
        }

        os_log(.default, "Received message from browser.runtime.sendNativeMessage: %@ (profile: %@)",
               String(describing: message), profile?.uuidString ?? "none")

        if let payload = message as? [String: Any],
           let command = payload["command"] as? String,
           command == "ensureServer" {
            ensureServerIsRunning()
        }

        let response = NSExtensionItem()
        if #available(iOS 15.0, macOS 11.0, *) {
            response.userInfo = [SFExtensionMessageKey: ["ok": true]]
        } else {
            response.userInfo = ["message": ["ok": true]]
        }
        context.completeRequest(returningItems: [response], completionHandler: nil)
    }

    // MARK: - Server lifecycle

    private func ensureServerIsRunning() {
        // Step 1: broadcast to any already-running host-app instance.
        //   If the host app is alive, it receives this and calls startLocalServerIfNeeded().
        //   This handles the "host app running but server crashed" case without relaunching.
        DistributedNotificationCenter.default().post(
            name: NSNotification.Name("com.imagefilter.ensureServer"),
            object: nil
        )

        // Step 2: if the host app isn't running at all, launch it.
        //   It will start the server AND watch for Safari's lifecycle going forward.
        guard NSRunningApplication.runningApplications(
                withBundleIdentifier: hostAppBundleIdentifier).isEmpty else {
            os_log(.default, "Host app already running — sent ensureServer notification")
            return
        }

        os_log(.default, "Host app not running — launching in server-only mode")
        launchContainingApp()
    }

    private func launchContainingApp() {
        // The extension bundle lives at:
        //   .../Image-Filter_Service.app/Contents/PlugIns/<extension>.appex
        // Walk up three components to reach the host .app bundle.
        let containingAppURL = Bundle.main.bundleURL
            .deletingLastPathComponent()  // PlugIns/
            .deletingLastPathComponent()  // Contents/
            .deletingLastPathComponent()  // Image-Filter_Service.app

        let cfg = NSWorkspace.OpenConfiguration()
        cfg.activates = false                       // don't steal focus from Safari
        cfg.arguments = [serverOnlyLaunchArgument]  // run as invisible background agent

        NSWorkspace.shared.openApplication(at: containingAppURL, configuration: cfg) { _, error in
            if let error {
                os_log(.error, "Failed to launch host app: %@", error.localizedDescription)
            } else {
                os_log(.default, "Host app launched in server-only mode")
            }
        }
    }
}
