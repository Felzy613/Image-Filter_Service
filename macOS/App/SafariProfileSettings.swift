//
//  SafariProfileSettings.swift
//  Image-Filter_Service
//
//  Reads Safari's own settings to see how the extension is set up in every Safari profile that
//  is in use. Safari's state API (SFSafariExtensionManager) takes no profile: on 2026-11-23 it
//  said "on" while the extension was off in the "Personal" profile, so that profile ran
//  unfiltered. No AppKit here, so it can be tested with plain swiftc
//  (scripts/test_extension_gate.sh).
//
//  What is read (all inside ~/Library/Containers/com.apple.Safari/Data/Library/Safari, which
//  needs Full Disk Access; without it every read fails with EPERM and no prompt):
//
//    SafariTabs.db  `windows`: one row per window Safari has open, plus the windows of the
//                   previous session (Safari may reopen them). Rows are written before the
//                   window appears on screen (measured: ~0.2 s ahead). The profile is
//                   `ProfileUUID` in `extra_attributes`, else `active_profile_id`.
//                   Private windows are never written there.
//    SafariTabs.db  `bookmarks` (subtype 2): the profiles. `external_uuid` is the profile's ID
//                   ("DefaultProfile" for Personal), `server_id` its settings folder.
//    WebExtensions/Extensions.plist                 Personal's extension settings
//    Profiles/<server_id>/WebExtensions/Extensions.plist   every other profile's
//
//  Which profiles are checked: Personal always (private windows can't be seen, and the only
//  "Allow in Private Browsing" setting is in Personal's file), every other profile while it has
//  a window in SafariTabs.db. The format is undocumented, so anything that isn't in the shape
//  measured on Safari 27.2 is "can't confirm" (`.unknown`), never "off" and never "fine".
//

import Foundation
import SQLite3

nonisolated struct SafariProfileSettings {
    /// …/Containers/com.apple.Safari/Data/Library/Safari
    let safariDataPath: String
    /// The key of the extension's entry in Extensions.plist: "<bundle id> (<team id>)".
    let extensionKey: String

    static let defaultProfileID = "DefaultProfile"
    /// Safari's name for the default profile, used when the profile has no title of its own.
    static let defaultProfileName = "Personal"
    /// The origin Safari stores for "All Websites: Allow".
    static let allWebsitesOrigin = "*://*/*"

    static var safariDataPathForCurrentUser: String {
        FileManager.default.homeDirectoryForCurrentUser.path
            + "/Library/Containers/com.apple.Safari/Data/Library/Safari"
    }

    struct Profile: Equatable {
        /// "DefaultProfile" or the profile's `external_uuid`.
        let id: String
        let name: String
        /// The settings folder under Profiles/, nil for Personal.
        let folder: String?
    }

    private struct Unsure: Error {
        let why: ExtensionGate.Uncertainty
        init(_ why: ExtensionGate.Uncertainty) { self.why = why }
    }

    // MARK: - Reading

    func read(now: Date = Date()) -> ExtensionGate.SettingsReading {
        do {
            let personal = Profile(id: Self.defaultProfileID, name: Self.defaultProfileName, folder: nil)
            // Personal first: when macOS refuses access this is the read that says so.
            var problems = try Self.problems(in: try entry(of: personal), profile: personal,
                                             checkPrivateBrowsing: true, now: now)
            for profile in try profilesWithWindows() where profile.id != personal.id {
                problems += try Self.problems(in: try entry(of: profile), profile: profile,
                                              checkPrivateBrowsing: false, now: now)
            }
            return problems.isEmpty ? .fine : .problems(problems)
        } catch let unsure as Unsure {
            return .unknown(unsure.why)
        } catch {
            return .unknown(.unrecognised("\(error)"))
        }
    }

    /// The extension's entry in a profile's Extensions.plist.
    private func entry(of profile: Profile) throws -> [String: Any] {
        let path = profile.folder.map { "\(safariDataPath)/Profiles/\($0)/WebExtensions/Extensions.plist" }
            ?? "\(safariDataPath)/WebExtensions/Extensions.plist"
        let data: Data
        do {
            data = try Data(contentsOf: URL(fileURLWithPath: path))
        } catch {
            throw Unsure(Self.isPermissionError(error)
                         ? .noFileAccess
                         : .unrecognised("can't read the settings of profile “\(profile.name)”: \(error.localizedDescription)"))
        }
        guard let plist = try? PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any] else {
            throw Unsure(.unrecognised("the settings of profile “\(profile.name)” aren't a dictionary"))
        }
        guard let entry = plist[extensionKey] as? [String: Any] else {
            throw Unsure(.unrecognised("profile “\(profile.name)” has no entry for the extension"))
        }
        return entry
    }

    static func isPermissionError(_ error: Error) -> Bool {
        let ns = error as NSError
        if ns.domain == NSCocoaErrorDomain && ns.code == NSFileReadNoPermissionError { return true }
        if let posix = ns.userInfo[NSUnderlyingErrorKey] as? NSError, posix.domain == NSPOSIXErrorDomain,
           posix.code == Int(EPERM) || posix.code == Int(EACCES) { return true }
        return ns.domain == NSPOSIXErrorDomain && (ns.code == Int(EPERM) || ns.code == Int(EACCES))
    }

    // MARK: - One profile's entry

    /// What is wrong in one profile's entry. Missing or mistyped keys throw (can't confirm).
    static func problems(in entry: [String: Any], profile: Profile, checkPrivateBrowsing: Bool,
                         now: Date) throws -> [ExtensionGate.Problem] {
        guard let enabled = entry["Enabled"] as? Bool else {
            throw Unsure(.unrecognised("profile “\(profile.name)”: no Enabled setting"))
        }
        // Off: the other settings don't matter, and Safari keeps them while it's off.
        guard enabled else { return [.turnedOff(profile: profile.name)] }

        var problems: [ExtensionGate.Problem] = []
        guard let granted = entry["GrantedPermissionOrigins"] as? [String: Any],
              let revoked = entry["RevokedPermissionOrigins"] as? [String: Any] else {
            throw Unsure(.unrecognised("profile “\(profile.name)”: no website access settings"))
        }
        // Each origin maps to the date the choice expires (4001-01-01 = for good; "Allow for One
        // Day" is a real date).
        func until(_ value: Any) throws -> Date {
            guard let date = value as? Date else {
                throw Unsure(.unrecognised("profile “\(profile.name)”: a website setting without a date"))
            }
            return date
        }
        let allWebsites = try granted[allWebsitesOrigin].map(until).map { $0 > now } ?? false
        let someWebsiteDenied = try revoked.values.contains { try until($0) > now }
        if !allWebsites || someWebsiteDenied {
            problems.append(.notAllWebsites(profile: profile.name))
        }

        if checkPrivateBrowsing {
            // Only Personal's file has this key. Extensions never allowed in Private Browsing
            // have no key at all, so a missing key is "not allowed", not "can't confirm".
            if entry["AllowInPrivateBrowsing"] as? Bool != true {
                problems.append(.notInPrivateBrowsing)
            }
        }
        return problems
    }

    // MARK: - Profiles with windows (SafariTabs.db)

    /// Every profile with a window in Safari's window table (open now or in the previous session).
    func profilesWithWindows() throws -> [Profile] {
        var db: OpaquePointer?
        let uri = "file:" + safariDataPath + "/SafariTabs.db?mode=ro"
        let rc = sqlite3_open_v2(uri, &db, SQLITE_OPEN_READONLY | SQLITE_OPEN_URI, nil)
        defer { sqlite3_close(db) }
        guard rc == SQLITE_OK else {
            if rc == SQLITE_AUTH || rc == SQLITE_PERM || errno == EPERM { throw Unsure(.noFileAccess) }
            throw Unsure(.unrecognised("can't open SafariTabs.db (\(rc))"))
        }
        sqlite3_busy_timeout(db, 200)

        var ids: [String] = []
        for row in try query(db, "SELECT active_profile_id, extra_attributes FROM windows") {
            var id: String?
            if case .blob(let data)? = row[1],
               let attributes = try? PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any] {
                id = attributes["ProfileUUID"] as? String
            }
            if id == nil, case .integer(let rowID)? = row[0] {
                id = try query(db, "SELECT external_uuid FROM bookmarks WHERE id = ?", [.integer(rowID)])
                    .first.flatMap { $0[0]?.text }
            }
            guard let found = id else { throw Unsure(.unrecognised("a window without a profile")) }
            if !ids.contains(found) { ids.append(found) }
        }

        return try ids.map { id in
            if id == Self.defaultProfileID {
                return Profile(id: id, name: Self.defaultProfileName, folder: nil)
            }
            guard let row = try query(db, "SELECT title, server_id FROM bookmarks WHERE external_uuid = ? AND subtype = 2",
                                      [.text(id)]).first,
                  let folder = row[1]?.text, !folder.isEmpty,
                  !folder.contains("/"), !folder.hasPrefix(".") else {
                throw Unsure(.unrecognised("a window in profile \(id), which Safari doesn't list"))
            }
            let title = row[0]?.text ?? ""
            return Profile(id: id, name: title.isEmpty ? id : title, folder: folder)
        }
    }

    private enum Value {
        case integer(Int64), text(String), blob(Data)
        var text: String? { if case .text(let s) = self { return s }; return nil }
    }

    private func query(_ db: OpaquePointer?, _ sql: String, _ arguments: [Value] = []) throws -> [[Value?]] {
        var statement: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &statement, nil) == SQLITE_OK else {
            throw Unsure(.unrecognised("SafariTabs.db: \(String(cString: sqlite3_errmsg(db)))"))
        }
        defer { sqlite3_finalize(statement) }
        let transient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)
        for (index, argument) in arguments.enumerated() {
            let position = Int32(index + 1)
            switch argument {
            case .integer(let value): sqlite3_bind_int64(statement, position, value)
            case .text(let value): sqlite3_bind_text(statement, position, value, -1, transient)
            case .blob: break
            }
        }
        var rows: [[Value?]] = []
        while true {
            let step = sqlite3_step(statement)
            if step == SQLITE_DONE { break }
            guard step == SQLITE_ROW else {
                throw Unsure(.unrecognised("SafariTabs.db: \(String(cString: sqlite3_errmsg(db)))"))
            }
            rows.append((0..<sqlite3_column_count(statement)).map { column in
                switch sqlite3_column_type(statement, column) {
                case SQLITE_INTEGER: return .integer(sqlite3_column_int64(statement, column))
                case SQLITE_TEXT: return .text(String(cString: sqlite3_column_text(statement, column)))
                case SQLITE_BLOB:
                    let count = Int(sqlite3_column_bytes(statement, column))
                    guard count > 0, let bytes = sqlite3_column_blob(statement, column) else { return .blob(Data()) }
                    return .blob(Data(bytes: bytes, count: count))
                default: return nil
                }
            })
        }
        return rows
    }
}
