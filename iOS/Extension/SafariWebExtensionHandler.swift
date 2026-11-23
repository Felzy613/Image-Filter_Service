//
//  SafariWebExtensionHandler.swift
//  Image-Filter_Service iOS Extension
//
//  Safari requires a native handler for every web extension. This one has nothing to do: the
//  extension filters pictures by itself (ondevice/engine.js). It still answers, so a stray
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
