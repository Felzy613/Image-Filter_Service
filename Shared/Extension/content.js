// Image Filter Service - Content Script
// Intercepts all images on web pages and sends them for filtering

(function() {
    'use strict';

    // Inject CSS to hide images by default until filtered.
    // Keep a reference so we can remove it when the extension is disabled.
    //  - transition: none — hiding must be instant. (A fade-out would show a newly
    //    swapped-in picture for 0.3s.) Only revealing fades in, via the inline style.
    //  - visibility as well as opacity, and :not(#_) ×3 for ID-level specificity, so page
    //    CSS like `.loaded { opacity: 1 !important }` can't un-hide an unchecked image.
    const hideAllStyle = document.createElement('style');
    hideAllStyle.textContent = `
        img:not([data-filter-processed="true"]):not(#_):not(#_):not(#_) {
            opacity: 0 !important;
            visibility: hidden !important;
            transition: none !important;
        }
    `;
    function ensureHideStyle() {
        if (config.isEnabled && !hideAllStyle.isConnected) {
            (document.head || document.documentElement).appendChild(hideAllStyle);
        }
    }
    (document.head || document.documentElement).appendChild(hideAllStyle);



    // Configuration
    const config = {
        serverUrl: 'http://127.0.0.1:10000/api/filter-image',
        isEnabled: true, // loaded from storage below; start optimistically enabled
        enableLogging: true,
        processedAttribute: 'data-filter-processed',
        originalSrcAttribute: 'data-original-src',
        cacheTimeout: 3600000 // 1 hour in milliseconds
    };
    
    // The exact URL an <img> was approved to display (see pinSource / revealWhenShowing).
    const APPROVED = 'data-filter-approved';

    // Each check of an <img> is a numbered round. If the page changes the image while a
    // check is in flight, a new round starts; the old round's result is discarded — never
    // pinned or shown (it would revert the page's change, or show the wrong picture).
    const rounds = new WeakMap();
    function newRound(img) {
        const round = (rounds.get(img) || 0) + 1;
        rounds.set(img, round);
        return round;
    }
    function isCurrent(img, round) {
        return rounds.get(img) === round;
    }

    // URL-keyed cache: null = no skin (reveal original src), string = filtered image URL.
    // Bounded (an endless feed would otherwise keep every filtered image); see content-core.js.
    const imageCache = globalThis.__ifs && globalThis.__ifs.boundedCache
        ? globalThis.__ifs.boundedCache(200, entry => entry && entry.filteredUrl)
        : new Map();
    const CACHE_TTL = 3600000; // 1 hour

    // Queue to handle images being processed
    const processingQueue = new Set();
    const MAX_CONCURRENT = 10; // Limit concurrent requests - server now has multi-threading
    const MAX_CONCURRENT_DEVICE = 4;

    // Canvas encoding size bounds.
    // Min ensures MediaPipe always gets enough pixels for reliable detection.
    // Max caps memory/bandwidth. The actual size is driven by the element's
    // rendered display size (see encodeImageToJpeg).
    const MIN_ENCODE_DIM = 320;
    const MAX_ENCODE_DIM = 1280;
    
    // Placeholder for blocked images (grey square)
    const PLACEHOLDER = 'data:image/svg+xml;base64,' + btoa(
        '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100">' +
        '<rect width="100" height="100" fill="#c0c0c0"/>' +
        '</svg>'
    );
    
    // The document plus every open shadow root (see content-core.js).
    function allRoots() {
        return globalThis.__ifs && globalThis.__ifs.allRoots ? globalThis.__ifs.allRoots() : [document];
    }
    function queryAllRoots(selector) {
        const out = [];
        for (const root of allRoots()) out.push(...root.querySelectorAll(selector));
        return out;
    }

    function log(...args) {
        if (config.enableLogging) {
            console.log('[Image Filter Service]', ...args);
        }
    }

    // Restore and reveal all images that were intercepted by this content script.
    // Called when the extension is disabled so pages look completely normal.
    function revealAllImages() {
        // Put back the srcset of images / <picture> sources we pinned (see pinSource).
        queryAllRoots('[data-filter-srcset]').forEach(el => {
            el.setAttribute('srcset', el.getAttribute('data-filter-srcset'));
            el.removeAttribute('data-filter-srcset');
        });
        queryAllRoots(`img[${APPROVED}]`).forEach(img => img.removeAttribute(APPROVED));
        queryAllRoots(`img[${config.processedAttribute}]`).forEach(img => {
            // Restore original src if we replaced it with a filtered version
            const originalSrc = img.getAttribute(config.originalSrcAttribute);
            if (originalSrc) {
                img.src = originalSrc;
                img.removeAttribute(config.originalSrcAttribute);
            }
            img.removeAttribute(config.processedAttribute);
            img.style.opacity = '';
            img.style.transition = '';
        });
        // Also un-hide any images hidden by CSS before they entered the queue
        queryAllRoots('img').forEach(img => {
            img.style.opacity = '';
            img.style.transition = '';
        });
    }

    // Enable or disable interception. Toggling off removes the hiding CSS and
    // reveals everything; toggling on re-injects the CSS and rescans.
    function setEnabled(enabled) {
        if (config.isEnabled === enabled) return; // no-op
        config.isEnabled = enabled;
        if (globalThis.__ifs && globalThis.__ifs.setEnabled) globalThis.__ifs.setEnabled(enabled);
        log('Extension enabled:', enabled);
        if (!enabled) {
            // Stop hiding images — remove the CSS rule
            if (hideAllStyle.parentNode) {
                hideAllStyle.parentNode.removeChild(hideAllStyle);
            }
            revealAllImages();
        } else {
            // Re-inject the hiding CSS before we rescan
            if (!hideAllStyle.parentNode) {
                (document.head || document.documentElement).appendChild(hideAllStyle);
            }
            scanAndProcessImages();
        }
    }

    // --- Excluded websites ---------------------------------------------------------
    // The popup's list of sites not to filter. What counts is the site in the address bar
    // (the top-level page), so frames on an excluded site are left alone too, while an
    // excluded site embedded in another page is still filtered. If a frame can't tell
    // which page it's in, it filters (fail closed).
    let globalEnabled = true;
    let excludedSites = [];

    function topLevelHostname() {
        try {
            if (window.top === window) return location.hostname;
        } catch { /* fall through */ }
        try {
            const ancestors = location.ancestorOrigins;
            if (ancestors && ancestors.length) return new URL(ancestors[ancestors.length - 1]).hostname;
        } catch { /* fall through */ }
        try {
            return window.top.location.hostname;  // same-origin parent only
        } catch {
            return '';
        }
    }

    function isExcludedSite(sites) {
        const host = topLevelHostname().toLowerCase().replace(/\.$/, '');
        if (!host) return false;
        return sites.some(site => host === site || host.endsWith('.' + site));
    }

    function applyEnabled() {
        const excluded = globalEnabled && isExcludedSite(excludedSites);
        if (excluded && config.isEnabled) log('This website is excluded from filtering');
        setEnabled(globalEnabled && !excluded);
    }

    // Function to check if an image should be processed
    function shouldProcessImage(img) {
        // Never intercept when the extension is disabled
        if (!config.isEnabled) return false;
        // Don't process if already processed
        if (img.hasAttribute(config.processedAttribute)) {
            return false;
        }
        
        // Don't process SVGs or data URLs with SVG
        const src = img.src || img.currentSrc;
        const srcsetFirst = img.srcset ? img.srcset.split(',')[0].trim().split(/\s+/)[0] : '';
        const dataSrc = (img.dataset && (img.dataset.src || img.dataset.lazySrc || img.dataset.lazy || img.dataset.original)) || '';
        const effectiveSrc = src || srcsetFirst || dataSrc;
        if (!effectiveSrc) return false;

        // Don't process placeholder
        if (effectiveSrc === PLACEHOLDER) return false;

        // Don't process if already in queue
        if (processingQueue.has(effectiveSrc)) return false;
        
        // Don't skip any images - filter everything including favicons and small icons
        // Religious compliance requires all images to be filtered, regardless of size
        
        return true;
    }
    
    // Encode an already-loaded img element to a JPEG data URL.
    // Target size = the element's rendered display size × devicePixelRatio, so
    // thumbnails stay small/fast while large displayed images encode at full display
    // quality. Bounds: MIN_ENCODE_DIM (good enough for detection) .. MAX_ENCODE_DIM.
    // White background handles transparent pixels — server converts to RGB anyway.
    // Server engine sends at least 512px (when the image has it): the server segments
    // overlapping tiles, so extra pixels let it find small people in thumbnails
    // (measured: group shots 93% → 96% of skin covered, ~2 ms more per image).
    const SERVER_MIN_ENCODE_DIM = 512;
    function encodeImageToJpeg(img, displayHint) {
        const { w, h } = outputSize(img, displayHint, SERVER_MIN_ENCODE_DIM);
        const canvas = drawToCanvas(img, w, h);
        try {
            return canvas.toDataURL('image/jpeg', 0.85);
        } finally {
            releaseCanvas(canvas);
        }
    }

    // Free a canvas's memory now (iOS caps a page's total canvas memory; see content-core.js).
    function releaseCanvas(canvas) {
        canvas.width = 0;
        canvas.height = 0;
    }

    // Longest side to encode at: display size × devicePixelRatio, bounded to
    // minDim .. MAX_ENCODE_DIM (see above).
    function encodeMaxDim(displayHint, minDim = MIN_ENCODE_DIM) {
        const dpr = window.devicePixelRatio || 1;
        const dispMax = displayHint
            ? Math.max(displayHint.w * dpr, displayHint.h * dpr, minDim)
            : minDim;
        return Math.min(dispMax, MAX_ENCODE_DIM);
    }

    function outputSize(img, displayHint, minDim = MIN_ENCODE_DIM) {
        return fitWithin(img, encodeMaxDim(displayHint, minDim));
    }

    function fitWithin(img, maxDim) {
        let w = img.naturalWidth || img.width || 300;   // SVG without intrinsic size: 0
        let h = img.naturalHeight || img.height || 150;
        if (w > maxDim || h > maxDim) {
            const ratio = Math.min(maxDim / w, maxDim / h);
            w = Math.max(1, Math.round(w * ratio));
            h = Math.max(1, Math.round(h * ratio));
        }
        return { w, h };
    }

    // White background handles transparent pixels (JPEG has no alpha).
    function drawToCanvas(img, w, h) {
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, w, h);
        ctx.drawImage(img, 0, 0, w, h);
        return canvas;
    }

    // --- On-device engine (iPhone/iPad) -----------------------------------------
    // The background page filters with MediaPipe on the device itself, with the server's
    // tiled detection (ondevice/engine.js): it gets a ≤768px copy — small people need the
    // pixels — and returns the skin mask; the grey is painted here at full resolution from the image we already
    // decoded. So the common case — no skin — costs one tiny JPEG encode on this page
    // instead of a display-size one, and nothing large crosses to the background.
    const SEG_MAX = 768;  // keep in sync with ondevice/engine.js (tiled detection needs the pixels)

    // Which engine the background uses ('server' | 'device'). Asking also wakes the
    // background page, which starts loading the on-device engine before our images arrive.
    let engine = null;
    const engineReady = browser.runtime.sendMessage({ action: 'getConfig' })
        .then(cfg => { engine = (cfg && cfg.engine) || 'server'; })
        .catch(() => { engine = 'server'; });

    // Load with CORS so the pixels are readable; rejects if the site doesn't allow it
    // (the background page then downloads the image itself).
    // decode() decodes off the main thread, so the drawImage calls below don't stall the
    // page; it rejects if the image can't load (including a CORS refusal).
    async function loadReadableImage(url) {
        const image = new Image();
        image.crossOrigin = 'anonymous';
        image.src = url;
        try {
            await image.decode();
        } catch {
            throw new Error('Image not readable');
        }
        return image;
    }

    // Same maths as server/app.py apply_grey_overlay() and ondevice/engine.js paintOverlay():
    // the mask (run-length encoded, alternating not-skin/skin runs) becomes grey pixels with
    // alpha; drawImage's bilinear upscale + source-over blend gives (1 − a)·image + a·grey.
    function paintFilteredImage(image, mask, displayHint) {
        const { w, h } = outputSize(image, displayHint);
        const canvas = drawToCanvas(image, w, h);
        const maskCanvas = document.createElement('canvas');
        maskCanvas.width = mask.w;
        maskCanvas.height = mask.h;
        const mctx = maskCanvas.getContext('2d');
        const pixels = mctx.createImageData(mask.w, mask.h);
        const data = pixels.data;
        let p = 0, isSkin = false;
        for (const run of mask.runs) {
            if (isSkin) {
                for (const end = p + run; p < end; p++) {
                    const o = p * 4;
                    data[o] = 128; data[o + 1] = 128; data[o + 2] = 128; data[o + 3] = 255;
                }
            } else {
                p += run;
            }
            isSkin = !isSkin;
        }
        mctx.putImageData(pixels, 0, 0);
        const ctx = canvas.getContext('2d');
        ctx.imageSmoothingEnabled = true;
        ctx.drawImage(maskCanvas, 0, 0, w, h);
        releaseCanvas(maskCanvas);
        // Async encode + blob: URL (see IFS.canvasToUrl in content-core.js).
        return globalThis.__ifs && globalThis.__ifs.canvasToUrl
            ? globalThis.__ifs.canvasToUrl(canvas)
            : Promise.resolve(canvas.toDataURL('image/jpeg', 0.9)).finally(() => releaseCanvas(canvas));
    }

    function encodeForSegmentation(image) {
        const { w, h } = fitWithin(image, SEG_MAX);
        const canvas = drawToCanvas(image, w, h);
        try {
            return canvas.toDataURL('image/jpeg', 0.85);  // throws if tainted
        } finally {
            releaseCanvas(canvas);
        }
    }

    async function requestOnDevice(src, pageImg) {
        let image = null, imageData = null;
        // Fast path: the page already downloaded this image. If its pixels are readable
        // (same-origin or CORS-enabled), use it instead of fetching and decoding a copy.
        // Only when already loaded — waiting on a lazy image would stall the queue.
        if (pageImg.complete && pageImg.naturalWidth > 0 && (pageImg.currentSrc || pageImg.src) === src) {
            try {
                imageData = encodeForSegmentation(pageImg);
                image = pageImg;
            } catch {
                // Cross-origin without CORS (tainted) — try a CORS copy below.
            }
        }
        if (!imageData) {
            try {
                image = await loadReadableImage(src);
                imageData = encodeForSegmentation(image);
            } catch (error) {
                image = null;
                log('Pixels not readable here; background will download the image:', error.message);
            }
        }
        const response = await browser.runtime.sendMessage({
            action: 'filterImage',
            imageUrl: src,
            imageData: imageData
        });
        return { response, image };
    }

    // Encode an image URL to a JPEG data URL for the server.
    // displayHint: {w, h} of the page <img> element's CSS display size, used to
    // choose an appropriate encoding resolution (see encodeImageToJpeg).
    //  - Fast path: the page already downloaded and decoded this exact image; if its
    //    pixels are readable (same-origin or CORS), encode that — no second download.
    //  - Otherwise load a CORS copy. If the site doesn't allow CORS this rejects and the
    //    background page fetches the image itself (a non-CORS copy would only taint the
    //    canvas, so it isn't worth downloading).
    //  - blob: URLs belong to this page, so they go through the canvas too (the server
    //    can't open them).
    async function downloadImageAsBase64(url, displayHint, pageImg) {
        if (url.startsWith('data:')) return url;
        if (pageImg && pageImg.complete && pageImg.naturalWidth > 0 &&
            (pageImg.currentSrc || pageImg.src) === url) {
            try {
                return encodeImageToJpeg(pageImg, displayHint);
            } catch {
                // Cross-origin without CORS (tainted canvas) — try a CORS copy below.
            }
        }
        return encodeImageToJpeg(await loadReadableImage(url), displayHint);
    }
    
    // Function to process a single image
    async function processImage(img) {
        // The URL this element will display. With srcset / <picture> sources the browser
        // picks (currentSrc); otherwise the src attribute decides — use it directly, since
        // currentSrc can still be the previous picture right after the page swapped src.
        const parent = img.parentElement;
        const browserPicks = img.hasAttribute('srcset') ||
            (parent && parent.tagName === 'PICTURE' && parent.querySelector('source[srcset]'));
        let src = browserPicks ? (img.currentSrc || img.src) : (img.src || img.currentSrc);
        if (!src || src.startsWith('data:')) {
            // No real src — fall back to srcset first entry or data-* lazy attributes
            src = (img.srcset ? img.srcset.split(',')[0].trim().split(/\s+/)[0] : '') ||
                  (img.dataset && (img.dataset.src || img.dataset.lazySrc || img.dataset.lazy || img.dataset.original)) ||
                  src;
        }
        if (!src) return;

        // On-device the engine checks one image at a time; more in flight only means more
        // decoded copies held in memory (iOS limits it). The server works in parallel.
        if (processingQueue.size >= (engine === 'device' ? MAX_CONCURRENT_DEVICE : MAX_CONCURRENT)) {
            return; // Will be picked up on next scan
        }

        // Check URL cache before any server work
        if (imageCache.has(src)) {
            const entry = imageCache.get(src);
            if (Date.now() - entry.ts < CACHE_TTL) {
                // IMMEDIATELY hide, then apply result from cache
                img.setAttribute(config.originalSrcAttribute, src);
                img.removeAttribute(APPROVED);
                img.style.opacity = '0';
                img.setAttribute(config.processedAttribute, 'processing');
                // No skin: show the original; skin: show the filtered version.
                revealWhenShowing(img, entry.filteredUrl === null ? src : entry.filteredUrl, newRound(img));
                return;
            }
            imageCache.delete(src);
        }

        // IMMEDIATELY hide the image before processing - critical for religious compliance
        img.setAttribute(config.originalSrcAttribute, src);
        img.removeAttribute(APPROVED);
        img.style.opacity = '0';
        const round = newRound(img);
        img.style.transition = 'opacity 0.3s';

        processingQueue.add(src);
        img.setAttribute(config.processedAttribute, 'processing');

        let response, image = null;
        try {
            log('Processing image:', src);
            await engineReady;

            // Rendered size, so output is encoded at display quality.
            // clientWidth/clientHeight are the CSS layout pixels (pre-DPR).
            const displayHint = { w: img.clientWidth || 0, h: img.clientHeight || 0 };

            if (engine === 'device') {
                ({ response, image } = await requestOnDevice(src, img));
            } else {
                let imageData = null;
                try {
                    imageData = await downloadImageAsBase64(src, displayHint, img);
                } catch (downloadError) {
                    log('Pixels not readable here; background will fetch the image:', downloadError.message);
                }

                response = await browser.runtime.sendMessage({
                    action: 'filterImage',
                    imageUrl: src,       // Always send original URL — used as cache key in background
                    imageData: imageData,
                    // Size to encode at if the background has to fetch the image itself.
                    maxDim: encodeMaxDim(displayHint, SERVER_MIN_ENCODE_DIM),
                    dimensions: {
                        width: img.naturalWidth || img.width,
                        height: img.naturalHeight || img.height
                    }
                });
            }

            // The page changed this image while we were checking it: a newer round owns it.
            if (!isCurrent(img, round)) return;

            if (response && response.success && !response.error && !response.fallback) {
                if (response.filtered === false) {
                    // Successfully processed — no skin found. Show exactly the original
                    // we checked (pinned, so the browser can't swap in another candidate).
                    imageCache.set(src, { filteredUrl: null, ts: Date.now() });
                    revealWhenShowing(img, src, round);
                    log('No skin, revealing original:', src);
                } else if (response.mask && image) {
                    // Skin found on-device — paint the grey here at display resolution.
                    const filteredUrl = await paintFilteredImage(image, response.mask, displayHint);
                    if (!isCurrent(img, round)) return;  // changed while encoding
                    imageCache.set(src, { filteredUrl, ts: Date.now() });
                    revealWhenShowing(img, filteredUrl, round);
                    log('Skin filtered on-device:', src);
                } else if (response.filteredImageUrl) {
                    // Skin found — show the filtered version.
                    imageCache.set(src, { filteredUrl: response.filteredImageUrl, ts: Date.now() });
                    revealWhenShowing(img, response.filteredImageUrl, round);
                    log('Skin filtered:', src);
                } else {
                    // Unexpected: success=true but no filteredImageUrl and filtered!=false
                    img.setAttribute(config.processedAttribute, 'failed');
                }
            } else {
                // Server error or unavailable — keep image hidden for religious compliance.
                // Do NOT cache: allow retry on next scan.
                log('Filter failed (server error or unavailable):', response?.error || 'unknown');
                img.setAttribute(config.processedAttribute, 'failed');
            }

        } catch (error) {
            log('Error processing image (server may be unavailable):', error);
            if (isCurrent(img, round)) img.setAttribute(config.processedAttribute, 'failed');
        } finally {
            processingQueue.delete(src);
            // Our own decoded copy (not the page's <img>): let it go now rather than at GC.
            if (image && image !== img) image.src = '';
        }
    }
    
    // Function to apply filtered image
    // --- Showing an image: only ever the exact pixels that were checked ----------
    // An <img> may be visible only while it displays the URL we approved: the original
    // (no skin) or our filtered data URL. Anything that could make it display something
    // else is removed (pinSource), and any later change hides it again (observer below).

    function absoluteUrl(url) {
        try { return new URL(url, document.baseURI).href; } catch { return url; }
    }

    // Make the element display exactly `url`:
    //  - drop srcset — the browser may otherwise switch to another candidate on resize,
    //    zoom or rotation;
    //  - in a <picture>, disable the <source>s — they take precedence over img.src, so the
    //    filtered version would never be shown, and a media query (rotation) could swap
    //    in a different picture (art direction).
    // Originals are kept in data-filter-srcset so disabling the extension restores them.
    function pinSource(img, url) {
        img.setAttribute(APPROVED, url);
        const parent = img.parentElement;
        if (parent && parent.tagName === 'PICTURE') {
            parent.querySelectorAll('source[srcset]').forEach(source => {
                source.setAttribute('data-filter-srcset', source.getAttribute('srcset'));
                source.removeAttribute('srcset');
            });
        }
        if (img.hasAttribute('srcset')) {
            img.setAttribute('data-filter-srcset', img.getAttribute('srcset'));
            img.removeAttribute('srcset');
        }
        // Only if it differs: rewriting a relative src to the same absolute URL would make
        // the browser reload it and delay the reveal for nothing.
        if (absoluteUrl(img.getAttribute('src') || '') !== url) {
            img.setAttribute('src', url);
        }
    }

    // Pin the approved URL; the image stays 'processing' (hidden) until tryReveal sees the
    // element has finished loading exactly that URL. Results from a stale round are dropped.
    function revealWhenShowing(img, url, round) {
        if (!isCurrent(img, round)) return;
        const check = () => tryReveal(img);
        img.addEventListener('load', check, { once: true });
        img.addEventListener('error', check, { once: true });
        pinSource(img, absoluteUrl(url));
        setTimeout(check, 0);  // already showing that URL: no load event may follow
    }

    // Reveal a pending image once the element is fully showing its approved URL — not
    // before (the previous picture, or a half-switched one, must never be visible).
    // Called on the element's load/error and from every scan as a safety net.
    function tryReveal(img) {
        const target = img.getAttribute(APPROVED);
        if (!target || img.getAttribute(config.processedAttribute) !== 'processing') return;
        if (!img.complete || absoluteUrl(img.currentSrc) !== target) return;
        if (img.naturalWidth === 0) {
            img.setAttribute(config.processedAttribute, 'failed');  // broken: nothing to show
            return;
        }
        img.setAttribute(config.processedAttribute, 'true');
        img.style.transition = 'opacity 0.3s';
        img.style.opacity = '1';
    }

    // Hide again and re-check (the page changed what this element would display).
    function recheck(img) {
        img.removeAttribute(config.processedAttribute);   // hide rule applies immediately
        img.removeAttribute(config.originalSrcAttribute);
        img.removeAttribute(APPROVED);
        newRound(img);                                    // anything in flight is now stale
        // Next task: lets the browser settle which picture it will show (srcset/<picture>).
        setTimeout(() => {
            if (config.isEnabled && !img.hasAttribute(config.processedAttribute)) processImage(img);
        }, 0);
    }
    
    // Function to check if element is in viewport or near it
    function isNearViewport(el) {
        const rect = el.getBoundingClientRect();
        const windowHeight = window.innerHeight || document.documentElement.clientHeight;
        const windowWidth = window.innerWidth || document.documentElement.clientWidth;
        
        // Consider images within 2x viewport height/width
        const margin = windowHeight;
        return rect.bottom >= -margin && rect.top <= windowHeight + margin &&
               rect.right >= 0 && rect.left <= windowWidth;
    }
    
    // Function to scan and process all images
    function scanAndProcessImages() {
        if (!config.isEnabled) return; // do nothing when disabled
        ensureHideStyle();
        queryAllRoots(`img[${config.processedAttribute}="processing"][${APPROVED}]`).forEach(tryReveal);

        // Only images not yet handled (processing/true/failed are skipped by the selector,
        // so long pages don't re-walk every image every 250ms).
        const images = queryAllRoots(`img:not([${config.processedAttribute}])`);
        
        // Prioritize visible images first
        const visibleImages = [];
        const invisibleImages = [];
        
        images.forEach(img => {
            if (shouldProcessImage(img)) {
                if (isNearViewport(img)) {
                    visibleImages.push(img);
                } else {
                    invisibleImages.push(img);
                }
            }
        });
        
        // Process visible images first, then invisible ones
        visibleImages.forEach(img => processImage(img));
        invisibleImages.forEach(img => processImage(img));
    }
    
    // CSS background images: content-backgrounds.js.

    // Observer to watch for dynamically added images
    // A <source> inside a <picture> overrides the <img>'s own src.
    function pictureImgOf(source) {
        const parent = source.parentElement;
        return parent && parent.tagName === 'PICTURE' ? parent.querySelector('img') : null;
    }

    const IMG_ATTRIBUTES = ['src', 'srcset', 'data-src', 'data-lazy', 'data-original', 'data-lazy-src'];

    // Also called by content-core.js for mutations inside shadow roots (its observer reports
    // more attributes, e.g. style/class, which are not ours to act on here).
    function handleImgMutations(mutations) {
        mutations.forEach((mutation) => {
            if (mutation.type === 'attributes' && !IMG_ATTRIBUTES.includes(mutation.attributeName)) return;
            // Check added nodes
            mutation.addedNodes.forEach((node) => {
                if (node.nodeType === 1) { // Element node
                    if (node.tagName === 'SOURCE') {
                        // New <source> in a <picture> could change what its <img> shows.
                        const img = pictureImgOf(node);
                        if (img && img.hasAttribute(config.processedAttribute)) recheck(img);
                    } else if (node.tagName === 'IMG') {
                        if (shouldProcessImage(node)) {
                            processImage(node);
                        }
                    } else {
                        // Check for images within the added node
                        const imgs = node.querySelectorAll('img');
                        imgs.forEach(img => {
                            if (shouldProcessImage(img)) {
                                processImage(img);
                            }
                        });
                    }
                }
            });
            
            // Check for attribute changes on src / srcset / lazy-load attributes
            if (mutation.type === 'attributes') {
                const el = mutation.target;
                if (el.tagName === 'SOURCE') {
                    // Page (re)set a <source>'s srcset — our own pinning only removes them.
                    const img = pictureImgOf(el);
                    if (img && el.getAttribute('srcset') && img.hasAttribute(config.processedAttribute)) recheck(img);
                    return;
                }
                if (el.tagName !== 'IMG') return;
                const newVal = el.getAttribute(mutation.attributeName) || '';
                // Removing src/srcset can't introduce a new picture once pinned.
                if (!newVal) return;
                // Our own pinning (or a no-op rewrite of the approved URL).
                if (absoluteUrl(newVal) === el.getAttribute(APPROVED)) return;
                // Anything else — a new URL, or an inline data: photo — hide and re-check.
                recheck(el);
            }
        });
    }

    const observer = new MutationObserver((mutations) => {
        // A page script removed our hiding stylesheet: put it back before the next paint.
        ensureHideStyle();
        handleImgMutations(mutations);
    });

    // Let content-core.js hand us <img>s inside shadow roots.
    if (globalThis.__ifs) {
        globalThis.__ifs.img = {
            handleMutations: handleImgMutations,
            scanRoot(root) {
                if (!config.isEnabled) return;
                root.querySelectorAll(`img:not([${config.processedAttribute}])`).forEach(img => {
                    if (shouldProcessImage(img)) processImage(img);
                });
            }
        };
    }

    // Start observing
    observer.observe(document.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['src', 'srcset', 'data-src', 'data-lazy', 'data-original', 'data-lazy-src']  // on <img> and <source>
    });
    
    // Initial scan
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', scanAndProcessImages);
    } else {
        scanAndProcessImages();
    }
    
    // Rescan frequently for lazy-loaded images - critical for religious compliance
    // 250 ms while the page is active; once it has been still for a few seconds, once a second; never
    // in a hidden tab (content-core.js IFS.shouldPoll). Images are hidden by CSS until checked, so this
    // only affects how soon a lazy image is picked up, not whether it is hidden.
    setInterval(() => {
        const ifs = globalThis.__ifs;
        if (!ifs || !ifs.shouldPoll || ifs.shouldPoll('img', 1000)) scanAndProcessImages();
    }, 250);
    
    // Scan on scroll to catch images before they become visible
    let scrollTimeout;
    window.addEventListener('scroll', () => {
        clearTimeout(scrollTimeout);
        scrollTimeout = setTimeout(scanAndProcessImages, 30);
    }, { passive: true });
    
    // Put every image whose filtering failed back in line for another attempt. They stay
    // hidden (opacity 0) throughout; the next 250ms scan picks them up. Returns the count.
    function requeueFailedImages() {
        let reset = 0;
        queryAllRoots(`img[${config.processedAttribute}="failed"]`).forEach(img => {
            img.removeAttribute(config.processedAttribute);
            img.removeAttribute(config.originalSrcAttribute);
            img.removeAttribute(APPROVED);
            reset++;
        });
        return reset;
    }

    // Self-healing retry. The background page's "serverOnline" push (below) is only
    // reliable on macOS — Safari on iOS suspends the background page, and a hosted server
    // can cold-start for a minute — so also retry on our own, backing off while the
    // server stays unreachable (5s → 60s) so a dead server isn't hammered.
    const RETRY_MIN_MS = 5000;
    const RETRY_MAX_MS = 60000;
    let retryDelay = RETRY_MIN_MS;
    function retryFailedImages() {
        if (config.isEnabled && requeueFailedImages() > 0) {
            log(`Retrying failed images (next check in ${Math.min(retryDelay * 2, RETRY_MAX_MS) / 1000}s if they fail again)`);
            retryDelay = Math.min(retryDelay * 2, RETRY_MAX_MS);
        } else {
            retryDelay = RETRY_MIN_MS;
        }
        setTimeout(retryFailedImages, retryDelay);
    }
    setTimeout(retryFailedImages, retryDelay);

    // Listen for messages from background script
    browser.runtime.onMessage.addListener((request, sender, sendResponse) => {
        if (request.action === 'updateConfig') {
            if (request.engine && request.engine !== engine) {
                engine = request.engine;
                imageCache.clear();
                retryDelay = RETRY_MIN_MS;
                requeueFailedImages();
            }
            if (request.serverUrl) {
                const changed = request.serverUrl !== config.serverUrl;
                config.serverUrl = request.serverUrl;
                log('Server URL updated to:', config.serverUrl);
                // New server, new chance: retry anything that failed against the old one.
                if (changed) {
                    retryDelay = RETRY_MIN_MS;
                    requeueFailedImages();
                }
            }
            // Respond to enable/disable toggle from the popup (iOS only; the background
            // always reports `true` on the Mac)
            if (request.isEnabled !== undefined) globalEnabled = request.isEnabled !== false;
            if (Array.isArray(request.excludedSites)) excludedSites = request.excludedSites;
            if (request.isEnabled !== undefined || Array.isArray(request.excludedSites)) applyEnabled();
        }

        if (request.action === 'serverOnline') {
            // Server came back up after a cold start — reset failed images so the
            // 250ms scan picks them up and reprocesses them.
            const reset = requeueFailedImages();
            retryDelay = RETRY_MIN_MS;
            if (reset > 0) log(`Server online — queued ${reset} failed image(s) for retry`);
        }
    });

    // Load the persisted enabled/serverUrl state so the content script starts in
    // the correct mode — especially important if the user previously disabled the
    // extension and then navigates to a new page.
    // Same for excluded websites: on one, everything is revealed as soon as this resolves.
    browser.storage.local.get(['serverUrl', 'isEnabled', 'excludedSites', 'platform']).then(result => {
        if (result.serverUrl) {
            config.serverUrl = result.serverUrl;
        }
        // Only the iPhone/iPad extension has an off switch. On the Mac a stored "off" (left
        // over from before it was removed) must not count — and an unknown platform fails
        // closed the same way (background.js writes `platform` each time it loads).
        globalEnabled = result.platform === 'ios' ? result.isEnabled !== false : true;
        excludedSites = Array.isArray(result.excludedSites) ? result.excludedSites : [];
        applyEnabled();
    }).catch(err => {
        log('Failed to load initial config:', err);
    });

    log('Image Filter Service initialized');
})();
