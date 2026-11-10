// Image Filter Service - Background Script
// Filters images either through the filtering server (macOS) or on the device itself
// (iPhone/iPad: MediaPipe in WebAssembly, see ondevice/engine.js in the iOS extension).

(function() {
    'use strict';

    // Configuration
    // The server that ships with the Mac app. On the Mac this is the only server (see isLockedDown).
    const DEFAULT_SERVER_URL = 'http://127.0.0.1:10000/api/filter-image';

    const config = {
        serverUrl: DEFAULT_SERVER_URL,
        enableLogging: true,
        timeout: 8000,  // 8 seconds — local server should never need more
        retryAttempts: 2,
        isEnabled: true,
        // 'server' (POST to serverUrl) or 'device' (filter in this extension, no server).
        // 'device' only exists on iOS, where it is the default; resolved in loadConfig().
        engine: 'server',
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

    // --- Where is the server? -------------------------------------------------
    // The macOS app can start the Python server on this Mac. An iPhone can't (no
    // subprocesses), and a server hosted elsewhere is none of our business — so
    // auto-start and the health polling that supports it only apply to macOS
    // talking to a server on this machine.

    function isLocalServerUrl(url) {
        try {
            const host = new URL(url).hostname;
            return host === '127.0.0.1' || host === 'localhost' || host === '[::1]';
        } catch {
            return false;
        }
    }

    // Resolved once. Anything other than iOS is treated as macOS (also the fallback
    // if the API is missing) so desktop behaviour is unchanged.
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

    async function canAutoStartLocalServer() {
        return (await getPlatformOs()) !== 'ios' && isLocalServerUrl(config.serverUrl);
    }

    // Root of whichever server is configured (the health-check endpoint lives at "/").
    function serverRootUrl() {
        try {
            return new URL('/', config.serverUrl).href;
        } catch {
            return 'http://127.0.0.1:10000/';
        }
    }

    async function requestNativeServerStartup() {
        if (!await canAutoStartLocalServer()) {
            return;
        }
        if (typeof browser.runtime.sendNativeMessage !== 'function') {
            log('Native messaging is unavailable in this context');
            return;
        }

        try {
            await browser.runtime.sendNativeMessage('FelzyTech.Image-Filter-Service', {
                command: 'ensureServer'
            });
            log('Requested native server startup');
        } catch (error) {
            log('Failed to request native server startup:', error.message);
        }
    }
    
    // --- macOS lock-down -------------------------------------------------------------
    // On the Mac, filtering can't be switched off, a website can only be excluded with the
    // exclusion password, and the server is always the local one (a different server could
    // simply answer "no skin"). iPhone/iPad keep their own switch and server URL. Enforced
    // here, not just in the popup: whatever the popup — or a stale stored value — says,
    // this decides.
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
                'serverUrl', 'isEnabled', 'excludedSites',
                'passwordRecord', 'passwordFailures', 'passwordLockedUntil'
            ]);
            // On the Mac a stored "off" or a custom server URL (from before those options were
            // removed) is ignored and put back. The platform is also written down so the
            // content scripts, which read storage directly, know whether `isEnabled` counts
            // (see content.js).
            if (isLockedDown()) {
                config.isEnabled = true;
                config.serverUrl = DEFAULT_SERVER_URL;
                const reset = {};
                if (result.isEnabled === false) reset.isEnabled = true;
                if (result.serverUrl && result.serverUrl !== DEFAULT_SERVER_URL) reset.serverUrl = DEFAULT_SERVER_URL;
                if (Object.keys(reset).length) await browser.storage.local.set(reset);
            } else {
                if (result.serverUrl) {
                    config.serverUrl = result.serverUrl;
                    log('Loaded server URL from storage:', config.serverUrl);
                }
                if (result.isEnabled !== undefined) {
                    config.isEnabled = result.isEnabled;
                }
            }
            browser.storage.local.set({ platform: config.platform }).catch(() => {});
            config.engine = resolveEngine();
            config.excludedSites = normalizeSiteList(result.excludedSites);
            passwordRecord = result.passwordRecord && result.passwordRecord.hash ? result.passwordRecord : null;
            passwordFailures = Number(result.passwordFailures) || 0;
            passwordLockedUntil = Number(result.passwordLockedUntil) || 0;
        } catch (error) {
            log('Error loading config:', error);
            config.engine = resolveEngine();
            passwordLoadFailed = true;
            if (isLockedDown()) {
                config.isEnabled = true;
                config.serverUrl = DEFAULT_SERVER_URL;
            }
        }
    }

    // The on-device engine's files ship only in the iOS extension: macOS always uses the server,
    // iPhone/iPad always filter on the device. There is no setting for it (the popup's
    // "Filter on this device" switch and Server URL field were removed), so a stored 'server'
    // from before can't leave an iPhone stuck on an address it can't reach.
    function resolveEngine() {
        return config.platform === 'ios' ? 'device' : 'server';
    }

    // Save configuration to storage
    async function saveConfig() {
        try {
            await browser.storage.local.set({
                serverUrl: config.serverUrl,
                isEnabled: config.isEnabled,
                engine: config.engine,
                excludedSites: config.excludedSites
            });
        } catch (error) {
            log('Error saving config:', error);
        }
    }

    // Resolves once the persisted settings are loaded. Safari on iOS unloads this page
    // aggressively, and the message that wakes it is delivered immediately — before storage
    // has been read — so anything that depends on config must wait for this first, or it runs
    // against the built-in defaults (wrong server URL, ignoring the "disabled" toggle).
    const configReady = loadConfig();

    // --- On-device engine (iOS) -------------------------------------------------
    // Loaded on first use and kept for the life of this background page. Loading compiles
    // ~11 MB of WebAssembly and reads a 16 MB model, so it is started as soon as the page
    // wakes (see the end of this file) rather than when the first image arrives.
    let deviceEnginePromise = null;
    let deviceBusy = 0;           // analyses in flight
    let deviceLastUse = 0;
    function loadDeviceEngine() {
        if (!deviceEnginePromise) {
            const started = performance.now();
            deviceEnginePromise = import(browser.runtime.getURL('ondevice/engine.js'))
                .then(async engine => {
                    await engine.init();
                    stats.engineLoadMs = Math.round(performance.now() - started);
                    stats.delegate = engine.delegate;  // 'GPU' or 'CPU'
                    log(`On-device engine ready (${stats.delegate}) in ${stats.engineLoadMs}ms`);
                    return engine;
                });
            deviceEnginePromise.catch(error => {
                log('On-device engine failed to load:', error && error.message);
                deviceEnginePromise = null;  // retry on the next request
            });
        }
        return deviceEnginePromise;
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
            // Same contract as a server failure: content.js keeps the image hidden.
            return { success: true, filtered: false, filteredImageUrl: null,
                     error: (error && error.message) || 'On-device filtering failed', fallback: true };
        } finally {
            deviceBusy--;
            deviceLastUse = Date.now();
        }
    }

    // iOS gives an extension's background page far less memory than the phone has. The engine
    // (model + WebAssembly + GPU) is most of this page's memory, so release it after a minute
    // with nothing to check; a page opening loads it again (warm-up below).
    const ENGINE_IDLE_MS = 60000;
    setInterval(async () => {
        if (!deviceEnginePromise || deviceBusy || Date.now() - deviceLastUse < ENGINE_IDLE_MS) return;
        try {
            const engine = await deviceEnginePromise;
            if (deviceBusy || Date.now() - deviceLastUse < ENGINE_IDLE_MS) return;
            engine.release();
            deviceEnginePromise = null;
            log('On-device engine released (idle)');
        } catch { /* failed load: nothing to release */ }
    }, 15000);

    // Core HTTP request with retry. Does not touch the cache or inflight map.
    async function _fetchFromServer(imageUrl, imageData, dimensions, retryCount) {
        try {
            const payload = { imageUrl, imageData };
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), config.timeout);

            const response = await fetch(config.serverUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
                signal: controller.signal
            });
            clearTimeout(timeoutId);

            if (!response.ok) {
                throw new Error(`Server returned ${response.status}: ${response.statusText}`);
            }

            const result = await response.json();
            if (!result.success) throw new Error(result.error || 'Unknown server error');
            if (result.error) {
                // The server is up but couldn't check this image (e.g. a format it can't
                // decode). It answers success:true so pages don't break — but the image was
                // NOT checked, so it must stay hidden: fail closed. No retry / server start
                // here; content.js re-queues failed images with backoff.
                log('Server could not check image:', result.error);
                stats.failed++;
                return { success: true, filteredImageUrl: null, filtered: false,
                         error: result.error, fallback: true };
            }

            stats.processed++;
            if (result.filtered) stats.filtered++;

            // For non-filtered images the server returns filteredImageUrl: null — the client
            // will reveal the original src directly, avoiding a large base64 round-trip.
            return {
                success: true,
                filteredImageUrl: result.filtered ? result.filteredImageUrl : null,
                filtered: result.filtered,
                containsSkin: result.containsSkin
            };

        } catch (error) {
            log('Error sending image to server:', error.message);

            if (retryCount === 0) {
                await requestNativeServerStartup();
            }

            if (retryCount < config.retryAttempts) {
                const delay = retryCount === 0 ? 200 : 500; // tight retries for local server
                log(`Retrying in ${delay}ms (attempt ${retryCount + 1}/${config.retryAttempts})`);
                await new Promise(resolve => setTimeout(resolve, delay));
                return _fetchFromServer(imageUrl, imageData, dimensions, retryCount + 1);
            }

            stats.failed++;
            return {
                success: true,  // avoid breaking the page on total failure
                filteredImageUrl: null,
                filtered: false,
                error: error.message,
                fallback: true
            };
        }
    }

    // content.js couldn't read the pixels (cross-origin image without CORS). This page
    // can: host permissions let it fetch any site, and Safari decodes every format the
    // page can show (AVIF, HEIC, …), from its own cache, with the site's cookies — so the
    // server gets exactly the picture the page displays, instead of downloading it again
    // itself (slower, and hotlink-protected or unsupported formats fail there).
    // Returns a JPEG data URL at most maxDim (≤1280) on its longest side.
    async function fetchAsJpegDataUrl(url, maxDim) {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), config.timeout);
        let bitmap;
        try {
            const response = await fetch(url, { credentials: 'include', signal: controller.signal });
            if (!response.ok) throw new Error(`Image download failed: ${response.status}`);
            bitmap = await decodeImageBlob(await response.blob());
        } finally {
            clearTimeout(timeoutId);
        }
        try {
            const max = Math.min(maxDim || 1280, 1280);
            const r = Math.min(1, max / Math.max(bitmap.width, bitmap.height));
            const w = Math.max(1, Math.round(bitmap.width * r));
            const h = Math.max(1, Math.round(bitmap.height * r));
            const canvas = typeof document !== 'undefined'
                ? Object.assign(document.createElement('canvas'), { width: w, height: h })
                : new OffscreenCanvas(w, h);
            const ctx = canvas.getContext('2d');
            ctx.fillStyle = '#ffffff';  // JPEG has no alpha
            ctx.fillRect(0, 0, w, h);
            ctx.drawImage(bitmap, 0, 0, w, h);
            if (canvas.toDataURL) return canvas.toDataURL('image/jpeg', 0.85);
            const bytes = new Uint8Array(await (await canvas.convertToBlob(
                { type: 'image/jpeg', quality: 0.85 })).arrayBuffer());
            let binary = '';
            for (let i = 0; i < bytes.length; i += 0x8000) {
                binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
            }
            return 'data:image/jpeg;base64,' + btoa(binary);
        } finally {
            bitmap.close();
        }
    }

    // createImageBitmap, or — for SVG, which Safari's createImageBitmap rejects — an <img>.
    // Either way the result is drawable and has width, height and close().
    async function decodeImageBlob(blob) {
        try {
            return await createImageBitmap(blob);
        } catch (error) {
            if (typeof document === 'undefined') throw error;
            const url = URL.createObjectURL(blob);
            const img = new Image();
            img.src = url;
            try {
                await img.decode();
            } catch (e) {
                URL.revokeObjectURL(url);
                throw error;
            }
            return Object.assign(img, {
                width: img.naturalWidth || 300,   // SVG without intrinsic size
                height: img.naturalHeight || 150,
                close: () => URL.revokeObjectURL(url)
            });
        }
    }

    async function _filterOnServer(imageUrl, imageData, maxDim, dimensions) {
        if (!imageData && /^https?:/i.test(imageUrl || '')) {
            try {
                imageData = await fetchAsJpegDataUrl(imageUrl, maxDim);
            } catch (error) {
                log('Background fetch failed, server will download the image:', error.message);
            }
        }
        return _fetchFromServer(imageUrl, imageData, dimensions, 0);
    }

    // Public entry point: checks cache, deduplicates in-flight requests, then delegates to _fetchFromServer.
    async function sendImageToServer(imageUrl, imageData, dimensions, maxDim) {
        await configReady;
        if (!config.isEnabled) {
            return { success: false, error: 'Service is disabled' };
        }

        // imageUrl is always the original HTTP URL (content.js now always sends it)
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

        // In-flight deduplication: if another request for the same URL is already
        // in flight, attach to that promise instead of starting a second server request.
        if (cacheKey && inflightRequests.has(cacheKey)) {
            log('Dedup in-flight:', cacheKey);
            return inflightRequests.get(cacheKey);
        }

        const promise = config.engine === 'device'
            ? _filterOnDevice(imageUrl, imageData)
            : _filterOnServer(imageUrl, imageData, maxDim, dimensions);

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
                return config.engine === 'device'
                    ? _filterOnDevice(null, request.imageData, { countStats: false, mode: request.mode })
                    : _fetchFromServer(null, request.imageData, null, 0);
            }).then(sendResponse, error => sendResponse({ success: false, error: error && error.message }));
            return true;
        }

        log('Received request:', request.action);
        
        if (request.action === 'filterImage') {
            sendImageToServer(request.imageUrl, request.imageData, request.dimensions, request.maxDim)
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
                // The Mac always uses its local server.
                if (request.serverUrl && !isLockedDown()) {
                    config.serverUrl = request.serverUrl;
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
                            serverUrl: config.serverUrl,
                            isEnabled: config.isEnabled,
                            engine: config.engine,
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

        if (request.action === 'checkServer') {
            configReady.then(() => {
                if (config.engine === 'device') {
                    loadDeviceEngine()
                        .then(() => sendResponse({ connected: true, engine: 'device', loadMs: stats.engineLoadMs }))
                        .catch(error => sendResponse({ connected: false, engine: 'device',
                                                       error: error && error.message }));
                    return;
                }
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), 2000);
                fetch(config.serverUrl, {
                    method: 'HEAD',
                    signal: controller.signal
                })
                .then(() => {
                    clearTimeout(timeoutId);
                    sendResponse({ connected: true });
                })
                .catch(() => {
                    clearTimeout(timeoutId);
                    sendResponse({ connected: false });
                });
            });
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
    // --- Server health tracking ---

    let serverWasDown = false;
    let recoveryPoll = null;

    // Health polling exists to auto-start the server on this Mac: only for the server
    // engine, pointed at localhost, and never on iOS (nothing there can start it).
    function shouldPollLocalServer() {
        return config.platform !== 'ios' && config.engine === 'server'
            && isLocalServerUrl(config.serverUrl);
    }

    async function pingServer() {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 2000);
        try {
            const r = await fetch(serverRootUrl(), { method: 'GET', signal: controller.signal });
            clearTimeout(timeoutId);
            return r.ok;
        } catch {
            clearTimeout(timeoutId);
            return false;
        }
    }

    async function notifyContentScriptsServerOnline() {
        const tabs = await browser.tabs.query({});
        tabs.forEach(tab => {
            browser.tabs.sendMessage(tab.id, { action: 'serverOnline' }).catch(() => {});
        });
    }

    function startRecoveryPolling() {
        if (recoveryPoll) return;
        log('Server down — fast-polling every 500ms until online');
        recoveryPoll = setInterval(async () => {
            if (!shouldPollLocalServer()) {
                // Pointed elsewhere meanwhile (remote server / on-device) — stop polling.
                clearInterval(recoveryPoll);
                recoveryPoll = null;
                return;
            }
            if (await pingServer()) {
                clearInterval(recoveryPoll);
                recoveryPoll = null;
                serverWasDown = false;
                log('Server back online — notifying content scripts');
                notifyContentScriptsServerOnline();
            }
        }, 500);
    }

    // Steady-state health check — every 5 seconds.
    // If the server drops, kicks off fast recovery polling at 500ms.
    // Only for a server on this Mac: it exists to auto-start that server. For a remote
    // server (always the case on iPhone) content.js retries failed images by itself.
    setInterval(async () => {
        if (!shouldPollLocalServer()) return;
        if (recoveryPoll) return; // fast poll already running
        if (!await pingServer()) {
            if (!serverWasDown) {
                serverWasDown = true;
                await requestNativeServerStartup();
            }
            startRecoveryPolling();
        }
    }, 5000);

    // Initialize: request startup, then immediately begin fast polling if server is down.
    configReady.then(async () => {
        log('Background script initialized');
        log('Server URL:', config.serverUrl);
        log('Service enabled:', config.isEnabled);
        log('Engine:', config.engine);
        if (config.engine === 'device') {
            // Warm up now: this page was most likely just woken by a page load, and its
            // images are about to arrive.
            if (config.isEnabled) loadDeviceEngine();
            return;
        }
        if (!shouldPollLocalServer()) return;
        await requestNativeServerStartup();
        if (!await pingServer()) {
            serverWasDown = true;
            startRecoveryPolling();
        }
    });



    // page-world.js must run in the page's own JavaScript world (shadow roots, video
    // presentation). Safari ignores "world" in manifest content_scripts but supports it here.
    // Registrations persist; register once.
    async function registerPageWorldScript() {
        try {
            const existing = await browser.scripting.getRegisteredContentScripts({ ids: ['ifs-page-world'] });
            if (existing && existing.length) return;
        } catch (e) { /* fall through and try to register */ }
        try {
            await browser.scripting.registerContentScripts([{
                id: 'ifs-page-world',
                js: ['page-world.js'],
                matches: ['<all_urls>'],
                runAt: 'document_start',
                allFrames: true,
                world: 'MAIN'
            }]);
            log('Registered page-world script');
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
