// Image Filter Service - content script core.
//
// Loaded before every other content script (see manifest "content_scripts" order). They
// all share one object in the extension's isolated world: globalThis.__ifs.
//
//   content.js              <img> (and <picture>)
//   content-elements.js     inline <svg>, <svg><image>, <input type=image>, <object>/<embed>
//   content-backgrounds.js  CSS background / list / border images, incl. ::before/::after
//   content-video.js        <video> — only filtered frames are drawn (a video whose frames
//                           can't be read, or whose checks fail, plays unfiltered)
//
// The rule everything follows: a picture is never visible until the exact pixels shown have
// been checked. Hiding is done by CSS that is in place before the page paints, in the
// document and in every shadow root; showing happens only after a check.
(function () {
    'use strict';

    const IFS = (globalThis.__ifs = globalThis.__ifs || {});
    const SPEC = ':not(#_):not(#_):not(#_)';  // ID-level specificity: page CSS can't override
    const STATE = 'data-filter-processed';
    IFS.SPEC = SPEC;
    IFS.STATE = STATE;
    IFS.enabled = true;  // set from storage by content.js -> IFS.setEnabled
    IFS.log = (...args) => console.log('[Image Filter Service]', ...args);

    // --- Activity: keeps the periodic safety nets cheap ------------------------------------
    // Hiding is done by CSS, so a scan only decides WHEN a picture gets shown, never whether it is
    // hidden. The polls therefore run at full speed only while the page is changing (a mutation, a
    // load, scrolling, resizing, the tab being shown), slow down once it has been still for a few
    // seconds, and stop in a hidden tab, where nothing is visible (the first poll after the tab is
    // shown again runs at full speed). An idle, background or finished page costs almost nothing.
    const ACTIVE_MS = 3000;
    let lastActive = performance.now();
    const lastPoll = {};
    IFS.activity = 0;
    IFS.touch = function () {
        IFS.activity++;
        lastActive = performance.now();
    };
    IFS.shouldPoll = function (key, idleEveryMs, activeEveryMs = 0) {
        if (document.hidden) return false;
        const now = performance.now();
        if (now - lastActive <= ACTIVE_MS) {
            if (now - (lastPoll[key] || 0) < activeEveryMs) return false;
            lastPoll[key] = now;
            return true;
        }
        if (now - (lastPoll[key] || 0) >= idleEveryMs) {
            lastPoll[key] = now;
            return true;
        }
        return false;
    };
    document.addEventListener('visibilitychange', () => { if (!document.hidden) IFS.touch(); });
    document.addEventListener('load', IFS.touch, true);
    window.addEventListener('scroll', IFS.touch, { passive: true, capture: true });
    window.addEventListener('resize', IFS.touch, { passive: true });

    // --- What is hidden until checked ------------------------------------------------
    // Hiding is instant (transition: none). Videos keep playing at opacity 0 (WebKit pauses
    // a muted autoplay video under visibility:hidden), and are not shown — their filtered
    // frames are drawn on an overlay — except a video that can't be filtered (frames
    // unreadable: cross-origin without CORS, DRM; or checks failing): content-video.js marks
    // it data-ifs-unfiltered and it plays as the page made it. An inline <svg> showing a
    // filtered raster ("raster") hides its own children and shows the raster as its background.
    // Keep in sync with the copy in page-world.js.
    IFS.ELEMENT_CSS = `
img:not([${STATE}="true"])${SPEC},
input[type="image" i]:not([${STATE}="true"])${SPEC},
object:not([${STATE}="true"])${SPEC},
embed:not([${STATE}="true"])${SPEC},
svg image:not([${STATE}="true"])${SPEC} {
    opacity: 0 !important; visibility: hidden !important; transition: none !important;
}
svg:not([${STATE}="true"]):not([${STATE}="raster"])${SPEC} {
    opacity: 0 !important; transition: none !important;
}
svg[${STATE}="raster"]${SPEC} > * { visibility: hidden !important; }
video:not([data-ifs-unfiltered])${SPEC} { opacity: 0 !important; transition: none !important; }
`;

    // Every CSS-supplied picture is suppressed for every element and pseudo-element; the
    // approved value is then pinned back per element (inline !important for elements, a
    // per-element rule for pseudo-elements). data-ifs-probe lifts this for an instant while
    // content-backgrounds.js reads what the page intends (never across a paint).
    IFS.BG_CSS = `
*:not([data-ifs-probe])${SPEC},
*:not([data-ifs-probe])${SPEC}::before,
*:not([data-ifs-probe])${SPEC}::after {
    background-image: none !important;
    list-style-image: none !important;
    border-image-source: none !important;
}
`;

    // --- Stylesheets: document + every shadow root -----------------------------------
    function styleElement(css, name) {
        const s = document.createElement('style');
        s.setAttribute('data-ifs-style', name);
        s.textContent = css;
        return s;
    }
    const docStyles = {
        elements: styleElement(IFS.ELEMENT_CSS, 'elements'),
        backgrounds: styleElement(IFS.BG_CSS, 'backgrounds'),
        pseudo: styleElement('', 'pseudo')
    };
    // A page script may remove our <style>s; the observer puts them back before the next paint.
    IFS.ensureDocumentStyles = function () {
        if (!IFS.enabled) return;
        const parent = document.head || document.documentElement;
        if (!parent) return;
        for (const s of Object.values(docStyles)) {
            if (!s.isConnected) parent.appendChild(s);
        }
    };
    IFS.ensureDocumentStyles();

    // Shadow roots can't see document styles; they get constructed sheets (shared objects,
    // adopted by every root). DOM changes inside a root can't remove adopted sheets.
    let rootSheets = null;
    function getRootSheets() {
        if (!rootSheets) {
            const make = css => {
                const sheet = new CSSStyleSheet();
                sheet.replaceSync(css);
                return sheet;
            };
            rootSheets = {
                elements: make(IFS.ELEMENT_CSS),
                backgrounds: make(IFS.BG_CSS),
                pseudo: make('')
            };
        }
        return rootSheets;
    }
    // page-world.js adopts a stopgap copy the instant a root is created; replace it with ours.
    function isPageWorldSheet(sheet) {
        try {
            return sheet.cssRules.length > 0 && sheet.cssRules[0].selectorText === '.ifs-page-world-sheet';
        } catch {
            return false;
        }
    }
    function ensureRootStyles(root) {
        const ours = Object.values(getRootSheets());
        const current = Array.from(root.adoptedStyleSheets);
        const stopgap = current.some(isPageWorldSheet);
        const others = current.filter(s => !isPageWorldSheet(s) && !ours.includes(s));
        if (IFS.enabled) {
            if (stopgap || ours.some(s => !current.includes(s))) root.adoptedStyleSheets = [...others, ...ours];
        } else if (stopgap || ours.some(s => current.includes(s))) {
            root.adoptedStyleSheets = others;
        }
    }

    // --- Per-element rules for ::before / ::after --------------------------------------
    // Pseudo-elements can't take inline styles, so an approved value becomes a rule keyed by
    // data-ifs-pid. :not([data-ifs-probe]) so a probe reads the page's value, not ours.
    let nextPid = 1;
    const pseudoRules = new Map();  // `${pid}:${pseudo}` -> { sheet, rule }
    IFS.setPseudoRule = function (el, pseudo, declarations) {
        let pid = el.getAttribute('data-ifs-pid');
        if (!pid && !declarations) return;
        if (!pid) {
            pid = String(nextPid++);
            el.setAttribute('data-ifs-pid', pid);
        }
        const key = pid + ':' + pseudo;
        const old = pseudoRules.get(key);
        if (old) {
            const i = Array.prototype.indexOf.call(old.sheet.cssRules, old.rule);
            if (i >= 0) old.sheet.deleteRule(i);
            pseudoRules.delete(key);
        }
        if (!declarations || !IFS.enabled) return;
        const sheet = el.getRootNode() === document ? docStyles.pseudo.sheet : getRootSheets().pseudo;
        if (!sheet) return;
        const selector = `[data-ifs-pid="${pid}"]:not([data-ifs-probe])${SPEC}:not(#_)::${pseudo}`;
        const i = sheet.insertRule(`${selector} { ${declarations} }`, sheet.cssRules.length);
        pseudoRules.set(key, { sheet, rule: sheet.cssRules[i] });
    };
    function clearPseudoRules() {
        pseudoRules.clear();
        docStyles.pseudo.textContent = '';
        if (rootSheets) rootSheets.pseudo.replaceSync('');
    }

    // --- Shadow roots -------------------------------------------------------------------
    // page-world.js makes every shadow root open (so we can reach it) and tags its host with
    // data-ifs-shadow. Open roots are found by walking added subtrees as well.
    const roots = new Set();
    IFS.allRoots = function () {
        for (const r of roots) {
            if (!r.host || !r.host.isConnected) roots.delete(r);
        }
        return [document, ...roots];
    };
    IFS.queryAll = function (selector) {
        const out = [];
        for (const root of IFS.allRoots()) {
            for (const el of root.querySelectorAll(selector)) out.push(el);
        }
        return out;
    };

    const modules = [];
    IFS.addModule = function (module) {
        modules.push(module);
        if (document.documentElement && module.scanRoot) {
            for (const root of IFS.allRoots()) module.scanRoot(root);
        }
    };

    const OBSERVE = {
        childList: true,
        subtree: true,
        attributes: true,
        attributeOldValue: true,  // lets content-backgrounds.js ignore inline-style changes that can't affect a picture
        // (Namespaced attributes such as xlink:href are never reported with a filter; the
        // periodic scan re-checks those.)
        attributeFilter: ['style', 'class', 'id', 'src', 'srcset', 'href', 'poster', 'data', 'type',
                          'data-src', 'data-lazy', 'data-original', 'data-lazy-src', 'data-ifs-shadow']
    };

    function registerRoot(root) {
        if (roots.has(root)) return;
        roots.add(root);
        ensureRootStyles(root);
        observer.observe(root, OBSERVE);
        if (IFS.enabled) {
            if (IFS.img && IFS.img.scanRoot) IFS.img.scanRoot(root);
            for (const m of modules) if (m.scanRoot) m.scanRoot(root);
        }
        discoverRoots(root);
    }

    function discoverRoots(node) {
        if (node.nodeType === 1 && node.shadowRoot) registerRoot(node.shadowRoot);
        if (node.querySelectorAll) {
            for (const el of node.querySelectorAll('*')) {
                if (el.shadowRoot) registerRoot(el.shadowRoot);
            }
        }
    }

    // Our own elements (video overlays) are ignored by every module.
    IFS.isOwnElement = el => el.nodeType === 1 && el.hasAttribute('data-ifs-overlay');

    const observer = new MutationObserver(records => {
        if (!IFS.enabled) return;
        IFS.touch();
        IFS.ensureDocumentStyles();
        const added = [];
        const attrs = [];
        const shadowRecords = [];
        for (const r of records) {
            if (r.target.getRootNode() !== document) shadowRecords.push(r);
            if (r.type === 'childList') {
                for (const n of r.addedNodes) {
                    if (n.nodeType === 1 && !IFS.isOwnElement(n)) added.push(n);
                }
            } else {
                attrs.push(r);
            }
        }
        for (const n of added) discoverRoots(n);
        if (added.length) discoverDirty = true;
        for (const r of attrs) {
            if (r.attributeName === 'data-ifs-shadow' && r.target.shadowRoot) registerRoot(r.target.shadowRoot);
        }
        // <img> inside shadow roots: content.js observes only the document itself.
        if (shadowRecords.length && IFS.img) IFS.img.handleMutations(shadowRecords);
        for (const m of modules) if (m.onMutations) m.onMutations(added, attrs);
    });
    observer.observe(document, OBSERVE);

    // The whole-document walk for shadow roots is a safety net (added nodes are walked as they arrive,
    // and page-world.js tags every shadow host, which the observer reports): it runs when nodes were
    // added, and otherwise at most every 2 s.
    let discoverDirty = true;
    let lastDiscover = 0;
    function scanAll() {
        if (!IFS.enabled || !IFS.shouldPoll('core', 2000, 500)) return;
        const now = performance.now();
        if (discoverDirty || now - lastDiscover > 2000) {
            discoverDirty = false;
            lastDiscover = now;
            discoverRoots(document);
        }
        for (const root of IFS.allRoots()) {
            if (root !== document) ensureRootStyles(root);
        }
        for (const m of modules) if (m.tick) m.tick();
    }
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => { IFS.touch(); scanAll(); });
    }
    setInterval(scanAll, 250);

    // --- Enable / disable (driven by content.js setEnabled) ----------------------------
    IFS.setEnabled = function (on) {
        if (IFS.enabled === on) return;
        IFS.enabled = on;
        if (on) {
            IFS.ensureDocumentStyles();
        } else {
            for (const s of Object.values(docStyles)) s.remove();
            clearPseudoRules();
        }
        for (const root of roots) ensureRootStyles(root);
        for (const m of modules) if (m.setEnabled) m.setEnabled(on);
        if (on) {
            for (const root of IFS.allRoots()) {
                if (IFS.img && IFS.img.scanRoot && root !== document) IFS.img.scanRoot(root);
                for (const m of modules) if (m.scanRoot) m.scanRoot(root);
            }
        }
    };

    // --- Check rounds (see content.js): a newer check makes older results stale -------
    const rounds = new WeakMap();
    IFS.newRound = function (el, key = '') {
        let map = rounds.get(el);
        if (!map) rounds.set(el, (map = new Map()));
        const n = (map.get(key) || 0) + 1;
        map.set(key, n);
        return n;
    };
    IFS.isCurrent = (el, round, key = '') => (rounds.get(el)?.get(key) || 0) === round;

    // --- Engine --------------------------------------------------------------------------
    IFS.engine = null;
    IFS.engineReady = browser.runtime.sendMessage({ action: 'getConfig' })
        .then(cfg => { IFS.engine = (cfg && cfg.engine) || 'server'; })
        .catch(() => { IFS.engine = 'server'; });
    browser.runtime.onMessage.addListener(request => {
        if (request.action === 'updateConfig' && request.engine && request.engine !== IFS.engine) {
            IFS.engine = request.engine;
            pictureCache.clear();
            for (const m of modules) if (m.onEngineChange) m.onEngineChange();
        }
    });

    const SEG_MAX = 768;           // on-device input: tiled detection needs the pixels (ondevice/engine.js)
    const MIN_OUT = 320;
    const SERVER_MIN = 512;        // server segments tiles; more pixels find small people
    const OUTPUT_MAX = 1280;

    IFS.fit = function (w, h, max) {
        w = w || 300;
        h = h || 150;
        if (w > max || h > max) {
            const r = Math.min(max / w, max / h);
            return { w: Math.max(1, Math.round(w * r)), h: Math.max(1, Math.round(h * r)) };
        }
        return { w: Math.max(1, Math.round(w)), h: Math.max(1, Math.round(h)) };
    };
    IFS.sizeOf = source => ({
        w: source.naturalWidth || source.videoWidth || source.width || 300,
        h: source.naturalHeight || source.videoHeight || source.height || 150
    });

    // Draw onto a canvas; white underneath for the model (JPEG has no alpha).
    IFS.drawToCanvas = function (source, w, h, background = '#ffffff') {
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        if (background) {
            ctx.fillStyle = background;
            ctx.fillRect(0, 0, w, h);
        }
        ctx.drawImage(source, 0, 0, w, h);
        return canvas;
    };

    // Same maths as server/app.py apply_grey_overlay(): the run-length mask (alternating
    // not-skin/skin) becomes grey pixels; drawImage's bilinear upscale + source-over blend.
    IFS.paintMask = function (ctx, mask, w, h) {
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
        ctx.imageSmoothingEnabled = true;
        ctx.drawImage(maskCanvas, 0, 0, w, h);
        IFS.releaseCanvas(maskCanvas);
    };

    // iOS Safari caps the memory of a page's canvases in total; past it, creating a canvas
    // fails (and the picture would stay hidden). Canvases we're done with are shrunk to 0×0
    // right away instead of waiting for garbage collection.
    IFS.releaseCanvas = function (canvas) {
        if (canvas) {
            canvas.width = 0;
            canvas.height = 0;
        }
    };

    // Encode off the main thread (toBlob) and hand out a short blob: URL. A data: URL means a
    // synchronous JPEG encode on the page's main thread and a 0.3–0.6 MB string copied around
    // (inline styles, attribute reads) — enough to stall long pages.
    // The canvas is released once encoded.
    IFS.canvasToUrl = function (canvas, type = 'image/jpeg', quality = 0.9) {
        return new Promise(resolve => {
            const done = url => {
                IFS.releaseCanvas(canvas);
                resolve(url);
            };
            try {
                canvas.toBlob(blob => done(blob ? URL.createObjectURL(blob) : canvas.toDataURL(type, quality)), type, quality);
            } catch {
                done(canvas.toDataURL(type, quality));
            }
        });
    };

    // Is a URL we handed out still shown anywhere? (Before revoking a blob: URL.)
    IFS.urlInUse = function (url) {
        const v = url.replace(/["\\]/g, '\\$&');
        const selector = `[src="${v}"], [href="${v}"], [data="${v}"], [style*="${v}"]`;
        for (const root of IFS.allRoots()) {
            if (root.querySelector(selector)) return true;
        }
        for (const { rule } of pseudoRules.values()) {
            if (rule.cssText.includes(url)) return true;
        }
        return false;
    };

    // A bounded cache of filtered pictures: beyond `max`, the oldest entries are dropped and
    // their blob: URLs freed — unless something on the page still shows them.
    IFS.boundedCache = function (max, urlOf) {
        const map = new Map();
        return {
            map,
            get: key => map.get(key),
            has: key => map.has(key),
            delete: key => map.delete(key),
            clear: () => map.clear(),
            set(key, value) {
                map.delete(key);
                map.set(key, value);
                if (map.size <= max) return;
                for (const [k, v] of map) {
                    if (map.size <= max) break;
                    if (k === key) continue;
                    Promise.resolve(urlOf(v)).then(url => {
                        if (url && url.startsWith('blob:') && !IFS.urlInUse(url)) URL.revokeObjectURL(url);
                    }, () => {});
                    map.delete(k);
                }
            }
        };
    };

    IFS.loadImage = async function (url, cors = true) {
        const image = new Image();
        if (cors) image.crossOrigin = 'anonymous';
        image.src = url;
        await image.decode();
        return image;
    };

    // At most a few checks in flight from this frame (the background works one at a time).
    let active = 0;
    const waiting = [];
    async function limited(task) {
        if (active >= (IFS.engine === 'device' ? 3 : 6)) await new Promise(resolve => waiting.push(resolve));
        active++;
        try {
            return await task();
        } finally {
            active--;
            const next = waiting.shift();
            if (next) next();
        }
    }

    // A check that never gets an answer (background page killed mid-request, network stall)
    // must not leave a picture hidden forever: give up after a while; callers retry.
    const CHECK_TIMEOUT_MS = 20000;
    function withTimeout(promise, ms = CHECK_TIMEOUT_MS) {
        let timer;
        return Promise.race([
            promise,
            new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Check timed out')), ms); })
        ]).finally(() => clearTimeout(timer));
    }

    function send(message) {
        return withTimeout(browser.runtime.sendMessage(message));
    }
    const isOk = r => r && r.success && !r.error && !r.fallback;

    // Check a picture by URL. Resolves to { clean: true } (show the original),
    // { dataUrl } (show this filtered version) or { failed: true } (keep it hidden).
    // Cached per URL for the page's lifetime; failures are not cached.
    // Values are promises of check results ({ dataUrl } holds a blob: URL when we encoded it).
    const pictureCache = IFS.boundedCache(200, pending => pending.then(r => r && r.dataUrl));
    IFS.checkUrl = function (url, maxOut = OUTPUT_MAX) {
        maxOut = Math.min(OUTPUT_MAX, Math.max(MIN_OUT, Math.round(maxOut)));
        const key = url + '|' + (maxOut > 640 ? 'L' : 'S');
        let pending = pictureCache.get(key);
        if (!pending) {
            pending = limited(() => withTimeout(checkUrlNow(url, maxOut), CHECK_TIMEOUT_MS * 2))
                .catch(() => ({ failed: true }));
            pictureCache.set(key, pending);
            pending.then(r => { if (r.failed) pictureCache.delete(key); });
        }
        return pending;
    };

    async function checkUrlNow(url, maxOut) {
        await IFS.engineReady;
        const device = IFS.engine === 'device';
        let image = null, imageData = null;
        try {
            image = await IFS.loadImage(url);
            const { w, h } = IFS.sizeOf(image);
            const size = IFS.fit(w, h, device ? SEG_MAX : Math.min(Math.max(maxOut, SERVER_MIN), OUTPUT_MAX));
            const encode = IFS.drawToCanvas(image, size.w, size.h);
            imageData = encode.toDataURL('image/jpeg', 0.85);
            IFS.releaseCanvas(encode);
        } catch {
            image = null;  // not readable here (CORS): the background downloads it itself
        }
        const response = await send({ action: 'filterImage', imageUrl: url, imageData, maxDim: maxOut });
        if (!isOk(response)) return { failed: true };
        if (response.filtered === false) return { clean: true };
        if (response.mask && image) {
            const { w, h } = IFS.sizeOf(image);
            const out = IFS.fit(w, h, maxOut);
            const canvas = IFS.drawToCanvas(image, out.w, out.h);
            image.src = '';  // our decoded copy: done with it
            IFS.paintMask(canvas.getContext('2d'), response.mask, out.w, out.h);
            return { dataUrl: await IFS.canvasToUrl(canvas) };
        }
        if (image) image.src = '';
        if (response.filteredImageUrl) return { dataUrl: response.filteredImageUrl };
        return { failed: true };
    }

    // Check pixels we drew ourselves (a video frame, a rasterised inline SVG). Never cached
    // by the background. Resolves to { clean }, { mask } (device), { filteredImageUrl }
    // (server) or { failed }. Throws if the canvas is tainted (cross-origin video).
    // mode (on-device engine): 'full' (default, the server's tiling) or 'fast' (video frames:
    // whole frame + frame-height tiles, ~3 passes for 16:9 — see ondevice/engine.js).
    IFS.checkCanvas = async function (canvas, { mode } = {}) {
        await IFS.engineReady;
        const device = IFS.engine === 'device';
        const size = IFS.fit(canvas.width, canvas.height, device ? SEG_MAX : Math.max(SERVER_MIN, Math.min(canvas.width, OUTPUT_MAX)));
        const small = size.w === canvas.width && size.h === canvas.height
            ? canvas : IFS.drawToCanvas(canvas, size.w, size.h);
        const imageData = small.toDataURL('image/jpeg', device ? 0.8 : 0.85);
        if (small !== canvas) IFS.releaseCanvas(small);
        const response = await send({ action: 'analyzeFrame', imageData, mode });
        if (!isOk(response)) return { failed: true };
        if (response.filtered === false) return { clean: true };
        if (response.mask) return { mask: response.mask };
        if (response.filteredImageUrl) return { filteredImageUrl: response.filteredImageUrl };
        return { failed: true };
    };

    IFS.isNearViewport = function (el) {
        const rect = el.getBoundingClientRect();
        const h = window.innerHeight || document.documentElement.clientHeight;
        const w = window.innerWidth || document.documentElement.clientWidth;
        return rect.bottom >= -h && rect.top <= 2 * h && rect.right >= 0 && rect.left <= w;
    };
})();
