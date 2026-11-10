//
//  SafariWebExtensionHandler.swift
//  Image-Filter_Service iOS Extension
//
//  iOS counterpart of the macOS handler. An iPhone cannot spawn the Python
//  filtering server (no subprocesses, no host-app launching), so there is
//  nothing to start here: the extension talks to a server that is already
//  reachable over the network. We still answer native messages so a stray
//  `browser.runtime.sendNativeMessage` never leaves a request hanging.
//

import SafariServices
import os.log

class SafariWebExtensionHandler: NSObject, NSExtensionRequestHandling {

    func beginRequest(with context: NSExtensionContext) {
        let request = context.inputItems.first as? NSExtensionItem
        let message = request?.userInfo?[SFExtensionMessageKey]

        os_log(.default, "Received message from browser.runtime.sendNativeMessage: %@",
               String(describing: message))

        let response = NSExtensionItem()
        response.userInfo = [SFExtensionMessageKey: ["ok": true, "platform": "ios"]]
        context.completeRequest(returningItems: [response], completionHandler: nil)
    }
}
