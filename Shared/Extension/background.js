// Image Filter Service - Background Script
// Filters every picture inside the extension itself: MediaPipe in WebAssembly, on the GPU when
// WebGL2 is available (ondevice/engine.js). Mac and iPhone/iPad alike — there is no server.
// (Until 1.10 the Mac sent pictures to a local Python server; see CLAUDE.md, "Serverless".)

(function() {
    'use strict';

    // Configuration
    const config = {
        enableLogging: true,
        isEnabled: true,
        // Always 'device' (kept in the config the popup and content scripts read).
        engine: 'device',
        platform: null,
        // Hostnames the user chose not to filter (no "www.", lowercase). An entry also
        // covers its subdomains. Matched against the top-level page in content.js.
        excludedSites: []
    };

    // "https://www.Example.com/path" -> "example.com". Returns '' if it isn't a hostname.
    function normalizeSite(value) {
        let host = String(value || '').trim().toLowerCase();
        if (!host) return '';
        try {
            host = new URL(/^[a-z][a-z0-9+.-]*:\/\//.test(host) ? host : 'http://' + host).hostname;
        } catch {
            return '';
        }
        host = host.replace(/^\*\./, '').replace(/^www\./, '').replace(/\.$/, '');
        return /^[a-z0-9-]+(\.[a-z0-9-]+)*$/.test(host) || /^\[[0-9a-f:.]+\]$/.test(host) ? host : '';
    }
    function normalizeSiteList(list) {
        return Array.isArray(list)
            ? [...new Set(list.map(normalizeSite).filter(Boolean))].sort()
            : [];
    }

    // Statistics
    const stats = {
        processed: 0,
        filtered: 0,
        failed: 0,
        cached: 0,
        avgMs: 0   // moving average of per-image filtering time in this page (on-device engine)
    };

    // URL-keyed response cache: stores the final response object keyed by original image URL
    const responseCache = new Map();
    const CACHE_EXPIRY = 3600000; // 1 hour
    const RESPONSE_CACHE_MAX = 300;

    // In-flight deduplication: same URL in flight → return same promise, not a second request
    const inflightRequests = new Map();
    
    function log(...args) {
        if (config.enableLogging) {
            console.log('[Image Filter Background]', ...args);
        }
    }

    // Resolved once. Anything other than iOS is treated as macOS (also the fallback
    // if the API is missing), so the Mac's lock-down applies.
    let platformOsPromise = null;
    function getPlatformOs() {
        if (!platformOsPromise) {
            platformOsPromise = (typeof browser.runtime.getPlatformInfo === 'function'
                ? browser.runtime.getPlatformInfo().then(info => info.os)
                : Promise.resolve('mac')
            ).catch(() => 'mac');
        }
        return platformOsPromise;
    }

    // --- macOS lock-down -------------------------------------------------------------
    // On the Mac, filtering can't be switched off and a website can only be excluded with the
    // exclusion password. iPhone/iPad keep their own switch. Enforced here, not just in the
    // popup: whatever the popup — or a stale stored value — says, this decides.
    function isLockedDown() {
        return config.platform !== 'ios';
    }

    // The exclusion password is stored only as a salted PBKDF2 hash, kept apart from
    // `config` (which getConfig hands to the popup and the content scripts).
    const PASSWORD_MIN_LENGTH = 6;
    const PBKDF2_ITERATIONS = 200000;
    const MAX_PASSWORD_FAILURES = 5;
    const LOCKOUT_MS = 5 * 60 * 1000;
    // { salt, hash, iterations } (base64) or null; failures / lockedUntil persist so
    // restarting the background page doesn't reset the lockout.
    let passwordRecord = null;
    let passwordFailures = 0;
    let passwordLockedUntil = 0;
    // If storage couldn't be read, "no password" may be wrong — never let a new one replace it.
    let passwordLoadFailed = false;

    const toBase64 = bytes => btoa(String.fromCharCode(...new Uint8Array(bytes)));
    const fromBase64 = text => Uint8Array.from(atob(text), c => c.charCodeAt(0));

    async function derivePasswordHash(password, salt, iterations) {
        const key = await crypto.subtle.importKey(
            'raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
        return toBase64(await crypto.subtle.deriveBits(
            { name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256));
    }

    async function makePasswordRecord(password) {
        const salt = crypto.getRandomValues(new Uint8Array(16));
        return {
            salt: toBase64(salt),
            iterations: PBKDF2_ITERATIONS,
            hash: await derivePasswordHash(password, salt, PBKDF2_ITERATIONS)
        };
    }

    // Constant-time comparison of two base64 strings.
    function sameHash(a, b) {
        if (a.length !== b.length) return false;
        let diff = 0;
        for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
        return diff === 0;
    }

    // Checks a password against the stored one. Throttled: MAX_PASSWORD_FAILURES wrong
    // guesses in a row lock it for LOCKOUT_MS (a correct password during the lock is
    // not accepted either). Returns { ok } or { ok: false, error, retryAfterMs? }.
    async function checkPassword(password) {
        if (!passwordRecord) return { ok: false, error: 'no-password' };
        const now = Date.now();
        if (passwordLockedUntil > now) {
            return { ok: false, error: 'locked', retryAfterMs: passwordLockedUntil - now };
        }
        let matches = false;
        try {
            const computed = await derivePasswordHash(
                String(password || ''), fromBase64(passwordRecord.salt), passwordRecord.iterations);
            matches = sameHash(computed, passwordRecord.hash);
        } catch (error) {
            log('Password check failed:', error && error.message);
        }
        if (matches) {
            if (passwordFailures) {
                passwordFailures = 0;
                passwordLockedUntil = 0;
                await savePasswordState();
            }
            return { ok: true };
        }
        passwordFailures++;
        if (passwordFailures >= MAX_PASSWORD_FAILURES) {
            passwordLockedUntil = Date.now() + LOCKOUT_MS;
            passwordFailures = 0;
        }
        await savePasswordState();
        return passwordLockedUntil > Date.now()
            ? { ok: false, error: 'locked', retryAfterMs: passwordLockedUntil - Date.now() }
            : { ok: false, error: 'wrong-password' };
    }

    async function savePasswordState() {
        try {
            await browser.storage.local.set({ passwordFailures, passwordLockedUntil });
        } catch (error) {
            log('Error saving password state:', error);
        }
    }

    // Sites in `next` that `current` doesn't cover — what the password guards. (Taking a
    // site off the list makes filtering stricter, so that never asks for it.)
    function addedSites(current, next) {
        return next.filter(site => !current.includes(site));
    }

    // Load configuration from storage
    async function loadConfig() {
        config.platform = await getPlatformOs();
        try {
            const result = await browser.storage.local.get([
                'isEnabled', 'excludedSites', 'serverUrl', 'engine', 'tabCheckLog', 'reopenedTabs',
                'passwordRecord', 'passwordFailures', 'passwordLockedUntil'
            ]);
            // On the Mac a stored "off" (from before the switch was removed) is ignored and put
            // back. The platform is also written down so the content scripts, which read storage
            // directly, know whether `isEnabled` counts (see content.js).
            if (isLockedDown()) {
                config.isEnabled = true;
                if (result.isEnabled === false) await browser.storage.local.set({ isEnabled: true });
            } else if (result.isEnabled !== undefined) {
                config.isEnabled = result.isEnabled;
            }
            // Left over from the server days, and from the tab reopening in 1.11.1-1.11.3 (which
            // noted the sites it touched): nothing reads them any more.
            const leftovers = ['serverUrl', 'engine', 'tabCheckLog', 'reopenedTabs']
                .filter(key => result[key] !== undefined);
            if (leftovers.length) browser.storage.local.remove(leftovers).catch(() => {});
            browser.storage.local.set({ platform: config.platform }).catch(() => {});
            config.excludedSites = normalizeSiteList(result.excludedSites);
            passwordRecord = result.passwordRecord && result.passwordRecord.hash ? result.passwordRecord : null;
            passwordFailures = Number(result.passwordFailures) || 0;
            passwordLockedUntil = Number(result.passwordLockedUntil) || 0;
        } catch (error) {
            log('Error loading config:', error);
            passwordLoadFailed = true;
            if (isLockedDown()) config.isEnabled = true;
        }
    }

    // Save configuration to storage
    async function saveConfig() {
        try {
            await browser.storage.local.set({
                isEnabled: config.isEnabled,
                excludedSites: config.excludedSites
            });
        } catch (error) {
            log('Error saving config:', error);
        }
    }

    // Resolves once the persisted settings are loaded. Safari unloads this page when it is idle,
    // and the message that wakes it is delivered immediately — before storage has been read —
    // so anything that depends on config must wait for this first, or it runs against the
    // built-in defaults (ignoring the "disabled" toggle on iOS, an empty excluded list).
    const configReady = loadConfig();

    // --- The filter engine ---------------------------------------------------------
    // Loaded on first use and kept while there is work. Loading compiles ~11 MB of WebAssembly
    // and reads a 16 MB model (~0.6 s measured in Safari 27.2 on a Mac, GPU), so it is started
    // as soon as this page wakes (see the end of this file) rather than when the first image
    // arrives.
    let deviceEnginePromise = null;
    let deviceBusy = 0;           // analyses in flight
    let deviceLastUse = 0;
    let engineLoadFailed = false; // the last load failed: tell the tabs when one works
    function loadDeviceEngine() {
        if (!deviceEnginePromise) {
            const started = performance.now();
            deviceEnginePromise = import(browser.runtime.getURL('ondevice/engine.js'))
                .then(async engine => {
                    await engine.init();
                    stats.engineLoadMs = Math.round(performance.now() - started);
                    stats.delegate = engine.delegate;  // 'GPU' or 'CPU'
                    log(`Filter engine ready (${stats.delegate}) in ${stats.engineLoadMs}ms`);
                    if (engineLoadFailed) {
                        engineLoadFailed = false;
                        notifyTabsFilterReady();
                    }
                    return engine;
                });
            deviceEnginePromise.catch(error => {
                log('Filter engine failed to load:', error && error.message);
                engineLoadFailed = true;
                deviceEnginePromise = null;  // retry on the next request
            });
        }
        return deviceEnginePromise;
    }

    // Everything that failed while the engine couldn't load is checked again now, in every tab
    // (content.js for <img>, content-core.js for every other kind of picture), instead of each
    // waiting out its own back-off of up to 60 s.
    async function notifyTabsFilterReady() {
        try {
            for (const tab of await browser.tabs.query({})) {
                browser.tabs.sendMessage(tab.id, { action: 'filterReady' }).catch(() => {});
            }
        } catch { /* no tabs API here */ }
    }

    // imageData is a ≤768px JPEG from content.js: return the skin mask (run-length encoded)
    // and let content.js paint the grey at full resolution — it already has the decoded
    // image, so nothing large crosses between page and background. Without imageData (the
    // page wouldn't let content.js read the pixels) we download and filter the URL here.
    async function _filterOnDevice(imageUrl, imageData, { countStats = true, mode } = {}) {
        const started = performance.now();
        deviceBusy++;
        try {
            const engine = await loadDeviceEngine();
            let result;
            if (imageData) {
                const analysis = await engine.analyzeDataUrl(imageData, mode ? { mode } : undefined);
                result = {
                    success: true,
                    filtered: analysis.containsSkin,
                    containsSkin: analysis.containsSkin,
                    skinRatio: analysis.skinRatio,
                    mask: analysis.containsSkin ? analysis.mask : null,
                    filteredImageUrl: null
                };
            } else {
                const analysis = await engine.filterUrl(imageUrl);
                result = {
                    success: true,
                    filtered: analysis.containsSkin,
                    containsSkin: analysis.containsSkin,
                    skinRatio: analysis.skinRatio,
                    filteredImageUrl: analysis.filteredImageUrl
                };
            }
            const ms = performance.now() - started;
            if (countStats) {
                stats.avgMs = stats.processed === 0 ? ms : stats.avgMs * 0.9 + ms * 0.1;
                stats.processed++;
                if (result.filtered) stats.filtered++;
            }
            return result;
        } catch (error) {
            log('On-device filtering failed:', error && error.message);
            stats.failed++;
            // Fail closed: content.js keeps the image hidden and retries it later.
            return { success: true, filtered: false, filteredImageUrl: null,
                     error: (error && error.message) || 'On-device filtering failed', fallback: true };
        } finally {
            deviceBusy--;
            deviceLastUse = Date.now();
        }
    }

    // The engine (model + WebAssembly + GPU) is most of this page's memory (measured in Safari
    // 27.2 on a Mac: ~230 MB idle, ~350 MB after a burst, ~160 MB once released). Release it after
    // a while with nothing to check; a page opening loads it again (~0.6 s, warm-up below).
    // iOS gives an extension's background page far less memory than the phone has: one minute
    // there. A Mac can hold it longer, which spares a reload delay after every pause in browsing.
    const ENGINE_IDLE_MS = () => (config.platform === 'ios' ? 60000 : 10 * 60000);
    setInterval(async () => {
        if (!deviceEnginePromise || deviceBusy || Date.now() - deviceLastUse < ENGINE_IDLE_MS()) return;
        try {
            const engine = await deviceEnginePromise;
            if (deviceBusy || Date.now() - deviceLastUse < ENGINE_IDLE_MS()) return;
            engine.release();
            deviceEnginePromise = null;
            log('Filter engine released (idle)');
        } catch { /* failed load: nothing to release */ }
    }, 15000);

    // Public entry point: checks the cache, deduplicates in-flight checks, then filters.
    async function checkImage(imageUrl, imageData) {
        await configReady;
        if (!config.isEnabled) {
            return { success: false, error: 'Service is disabled' };
        }

        // imageUrl is always the original URL (content.js always sends it)
        const cacheKey = imageUrl || null;

        // Cache lookup
        if (cacheKey) {
            const cached = responseCache.get(cacheKey);
            if (cached && Date.now() - cached.timestamp < CACHE_EXPIRY) {
                stats.cached++;
                log('Cache hit:', cacheKey);
                return cached.response;
            }
            responseCache.delete(cacheKey);
        }

        // In-flight deduplication: if the same URL is already being checked, attach to that
        // promise instead of checking it twice.
        if (cacheKey && inflightRequests.has(cacheKey)) {
            log('Dedup in-flight:', cacheKey);
            return inflightRequests.get(cacheKey);
        }

        const promise = _filterOnDevice(imageUrl, imageData);

        if (cacheKey) {
            inflightRequests.set(cacheKey, promise);
        }

        let result;
        try {
            result = await promise;
        } finally {
            if (cacheKey) inflightRequests.delete(cacheKey);
        }

        // Cache successful (non-fallback) results keyed by original URL. Bounded: entries can
        // hold whole filtered images (data URLs), and this page's memory is limited on iOS.
        if (cacheKey && result.success && !result.fallback) {
            responseCache.set(cacheKey, { response: result, timestamp: Date.now() });
            while (responseCache.size > RESPONSE_CACHE_MAX) {
                responseCache.delete(responseCache.keys().next().value);  // oldest first
            }
        }

        log('Image processed:', { url: imageUrl, filtered: result.filtered, containsSkin: result.containsSkin });
        return result;
    }
    
    // Handle messages from content script
    browser.runtime.onMessage.addListener((request, sender, sendResponse) => {
        if (request.action === 'analyzeFrame') {
            configReady.then(() => {
                if (!config.isEnabled) return { success: false, error: 'Service is disabled' };
                return _filterOnDevice(null, request.imageData, { countStats: false, mode: request.mode });
            }).then(sendResponse, error => sendResponse({ success: false, error: error && error.message }));
            return true;
        }

        log('Received request:', request.action);
        
        if (request.action === 'filterImage') {
            checkImage(request.imageUrl, request.imageData)
                .then(response => sendResponse(response))
                .catch(error => {
                    log('Error in filterImage handler:', error);
                    sendResponse({ success: false, error: error.message });
                });
            
            // Return true to indicate async response
            return true;
        }
        
        if (request.action === 'getStats') {
            sendResponse(stats);
            return false;
        }
        
        if (request.action === 'updateConfig') {
            // Wait for the initial load so it can't overwrite what we set here afterwards.
            configReady.then(async () => {
                if (request.excludedSites !== undefined) {
                    const next = normalizeSiteList(request.excludedSites);
                    // On the Mac, excluding a website needs the password. Nothing in this
                    // request is applied if it's wrong.
                    if (isLockedDown() && addedSites(config.excludedSites, next).length > 0) {
                        const check = await checkPassword(request.password);
                        if (!check.ok) {
                            sendResponse({ success: false, error: check.error,
                                           retryAfterMs: check.retryAfterMs,
                                           excludedSites: config.excludedSites });
                            return;
                        }
                    }
                    config.excludedSites = next;
                }
                // The Mac has no off switch: filtering is always on.
                if (request.isEnabled !== undefined && !isLockedDown()) {
                    config.isEnabled = request.isEnabled;
                }
                saveConfig();

                // Notify all tabs about config update
                browser.tabs.query({}).then(tabs => {
                    tabs.forEach(tab => {
                        browser.tabs.sendMessage(tab.id, {
                            action: 'updateConfig',
                            isEnabled: config.isEnabled,
                            excludedSites: config.excludedSites
                        }).catch(() => {
                            // Tab might not have content script
                        });
                    });
                });

                sendResponse({ success: true, excludedSites: config.excludedSites });
            }).catch(error => sendResponse({ success: false, error: error && error.message,
                                             excludedSites: config.excludedSites }));
            return true; // Will respond asynchronously
        }

        if (request.action === 'getConfig') {
            configReady.then(() => sendResponse({
                ...config,
                // Never the hash itself: just whether the Mac's password gate exists.
                passwordRequired: isLockedDown(),
                passwordSet: !!passwordRecord
            }));
            return true; // Will respond asynchronously
        }

        // Create the exclusion password, or change it (which needs the current one).
        if (request.action === 'setPassword') {
            configReady.then(async () => {
                const next = String(request.password || '');
                if (next.length < PASSWORD_MIN_LENGTH) {
                    sendResponse({ success: false, error: 'too-short', minLength: PASSWORD_MIN_LENGTH });
                    return;
                }
                if (passwordLoadFailed) {
                    sendResponse({ success: false, error: 'unavailable' });
                    return;
                }
                if (passwordRecord) {
                    const check = await checkPassword(request.currentPassword);
                    if (!check.ok) {
                        sendResponse({ success: false, error: check.error, retryAfterMs: check.retryAfterMs });
                        return;
                    }
                }
                passwordRecord = await makePasswordRecord(next);
                try {
                    await browser.storage.local.set({ passwordRecord });
                } catch (error) {
                    log('Error saving password:', error);
                    sendResponse({ success: false, error: 'unavailable' });
                    return;
                }
                sendResponse({ success: true });
            }).catch(error => sendResponse({ success: false, error: error && error.message }));
            return true; // Will respond asynchronously
        }

        // The popup's status card: can the filter run? (Loads the engine if it isn't loaded.)
        // 'checkServer' is the action's name from when the Mac had a server.
        if (request.action === 'checkFilter' || request.action === 'checkServer') {
            configReady.then(() => loadDeviceEngine())
                .then(() => sendResponse({ connected: true, engine: 'device', loadMs: stats.engineLoadMs }))
                .catch(error => sendResponse({ connected: false, engine: 'device',
                                               error: error && error.message }));
            return true; // Will respond asynchronously
        }
        
        if (request.action === 'clearCache') {
            responseCache.clear();
            stats.cached = 0;
            log('Cache cleared');
            sendResponse({ success: true });
            return false;
        }
    });
    
    // Initialize
    configReady.then(() => {
        log('Background script initialized; filtering', config.isEnabled ? 'on' : 'off', 'on', config.platform);
        // Warm up now: this page was most likely just woken by a page load, and its images are
        // about to arrive (the first check would otherwise wait for the engine to load).
        if (config.isEnabled) loadDeviceEngine().catch(() => {});
    });



    // page-world.js must run in the page's own JavaScript world (shadow roots, video
    // presentation). Safari ignores "world" in manifest content_scripts but supports it here.
    // Registrations persist, so an existing one is kept only if it matches this definition
    // (an older version registered without the exclusions below).
    //
    // Not in bot-check frames: page-world.js replaces built-in DOM functions, which those
    // checks treat as a bot (see page-world.js), and these frames have no shadow-DOM pictures
    // or videos to protect. Their pictures (a captcha's photo grid) are still filtered by the
    // content scripts. Cloudflare's frame has no pictures at all, so the content scripts skip it
    // too (manifest "exclude_matches").
    const PAGE_WORLD_EXCLUDE = [
        '*://challenges.cloudflare.com/*',
        '*://*.hcaptcha.com/*',
        '*://www.google.com/recaptcha/*',
        '*://www.recaptcha.net/recaptcha/*',
        '*://recaptcha.google.com/recaptcha/*',
        '*://*.arkoselabs.com/*',
        '*://*.funcaptcha.com/*',
        '*://geo.captcha-delivery.com/*'
    ];
    const PAGE_WORLD_SCRIPT = {
        id: 'ifs-page-world',
        js: ['page-world.js'],
        matches: ['<all_urls>'],
        excludeMatches: PAGE_WORLD_EXCLUDE,
        runAt: 'document_start',
        allFrames: true,
        world: 'MAIN'
    };
    // Bump when PAGE_WORLD_SCRIPT changes: the stored number says which definition is registered
    // (a registration's fields aren't reliably reported back), so it is replaced exactly once.
    const PAGE_WORLD_VERSION = 2;
    async function registerPageWorldScript() {
        let existing = null;
        let registeredVersion = 0;
        try {
            [existing] = await browser.scripting.getRegisteredContentScripts({ ids: [PAGE_WORLD_SCRIPT.id] });
            registeredVersion = (await browser.storage.local.get('pageWorldVersion')).pageWorldVersion || 0;
        } catch (e) { /* fall through and try to register */ }
        if (existing && registeredVersion === PAGE_WORLD_VERSION) return;
        try {
            if (existing) {
                await browser.scripting.unregisterContentScripts({ ids: [PAGE_WORLD_SCRIPT.id] });
            }
            try {
                await browser.scripting.registerContentScripts([PAGE_WORLD_SCRIPT]);
            } catch (error) {
                // Never leave pages without it: fall back to the old definition (no exclusions).
                log('Page-world registration with exclusions failed, registering without:', error && error.message);
                const { excludeMatches, ...plain } = PAGE_WORLD_SCRIPT;
                await browser.scripting.registerContentScripts([plain]);
                return;  // not recorded as current: tried again on the next start
            }
            await browser.storage.local.set({ pageWorldVersion: PAGE_WORLD_VERSION });
            log(existing ? 'Updated page-world script registration' : 'Registered page-world script');
        } catch (error) {
            log('Could not register page-world script:', error && error.message);
        }
    }
    registerPageWorldScript();

    // Periodic cache cleanup
    setInterval(() => {
        const now = Date.now();
        let cleaned = 0;
        for (const [key, value] of responseCache.entries()) {
            if (now - value.timestamp > CACHE_EXPIRY) {
                responseCache.delete(key);
                cleaned++;
            }
        }
        if (cleaned > 0) log(`Cleaned ${cleaned} expired cache entries`);
    }, 300000);

})();
