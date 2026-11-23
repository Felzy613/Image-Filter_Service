//
//  SafariWebExtensionHandler.swift
//  Image-Filter_Service Extension
//
//  Created by Felzy730 on 1/26/26.
//
//  Safari requires a native handler for every web extension. This one has nothing to do: the
//  extension filters pictures by itself (ondevice/engine.js), with no server to start. Until
//  1.10.0 the background page sent {command: "ensureServer"} here to have the app start its
//  Python server; an extension of that age, still loaded, just gets the plain answer below.
//

import SafariServices
import os.log

class SafariWebExtensionHandler: NSObject, NSExtensionRequestHandling {

    func beginRequest(with context: NSExtensionContext) {
        let request = context.inputItems.first as? NSExtensionItem
        let message: Any?
        if #available(iOS 15.0, macOS 11.0, *) {
            message = request?.userInfo?[SFExtensionMessageKey]
        } else {
            message = request?.userInfo?["message"]
        }
        os_log(.debug, "Native message from the extension (nothing to do): %@", String(describing: message))

        let response = NSExtensionItem()
        if #available(iOS 15.0, macOS 11.0, *) {
            response.userInfo = [SFExtensionMessageKey: ["ok": true]]
        } else {
            response.userInfo = ["message": ["ok": true]]
        }
        context.completeRequest(returningItems: [response], completionHandler: nil)
    }
}
