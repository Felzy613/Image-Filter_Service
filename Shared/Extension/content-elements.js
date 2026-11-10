// Image Filter Service - pictures that aren't <img>: inline <svg>, <svg><image>,
// <input type=image>, and <object>/<embed> showing an image.
//
// All of these are hidden by content-core.js's CSS until marked data-filter-processed="true"
// (or "raster" for an inline <svg> shown as a filtered raster).
//
// Inline <svg> is drawn by the page, not loaded from a URL, so we rasterise it as it appears
// (computed colours inlined, <use> references resolved), check the raster, and then either
// show the live SVG (no skin) or show the filtered raster in its place — the <svg>'s own
// children are hidden and the raster becomes its background. Identical SVGs (icon sets)
// are checked once. A photo inside an SVG (<image>) is checked separately, like an <img>.
(function () {
    'use strict';

    const IFS = globalThis.__ifs;
    if (!IFS) return;

    const STATE = IFS.STATE;
    const APPROVED = 'data-filter-approved';
    const ORIGINAL = 'data-filter-original';
    const SVG_NS = 'http://www.w3.org/2000/svg';
    const XLINK_NS = 'http://www.w3.org/1999/xlink';
    const IMAGE_EXT = /\.(jpe?g|png|gif|webp|avif|svg|bmp|ico|heic|heif|tiff?)(?:[?#]|$)/i;
    const SINGLE_SELECTOR = 'input[type="image" i], object, embed, svg image';

    const retry = new Map();  // el -> { at, delay }
    function failedLater(el) {
        const prev = retry.get(el);
        const delay = prev ? Math.min(prev.delay * 2, 60000) : 5000;
        retry.set(el, { at: Date.now() + delay, delay });
    }

    function abs(url) {
        try { return new URL(url, document.baseURI).href; } catch { return url; }
    }

    // --- Single-URL elements -------------------------------------------------------------
    function kindOf(el) {
        const tag = el.tagName.toLowerCase();
        if (tag === 'input') return (el.getAttribute('type') || '').toLowerCase() === 'image' ? 'input' : null;
        if (tag === 'object' || tag === 'embed') return tag;
        if (tag === 'image' && el.namespaceURI === SVG_NS) return 'svgimage';
        return null;
    }
    function rawUrl(el, kind) {
        if (kind === 'object') return el.getAttribute('data');
        if (kind === 'svgimage') return el.getAttribute('href') || el.getAttributeNS(XLINK_NS, 'href');
        return el.getAttribute('src');
    }
    function setUrl(el, kind, url) {
        if (kind === 'object') el.setAttribute('data', url);
        else if (kind === 'svgimage') {
            el.setAttribute('href', url);
            if (el.hasAttributeNS(XLINK_NS, 'href')) el.setAttributeNS(XLINK_NS, 'xlink:href', url);
        } else el.setAttribute('src', url);
    }
    function isPicture(el, kind, url) {
        if (kind === 'input' || kind === 'svgimage') return true;
        const type = (el.getAttribute('type') || '').toLowerCase();
        return type.startsWith('image/') || url.startsWith('data:image/') || IMAGE_EXT.test(url);
    }

    function processSingle(el) {
        const kind = kindOf(el);
        if (!kind || !IFS.enabled) return;
        const raw = rawUrl(el, kind);
        const url = raw ? abs(raw) : '';
        if (!url || !isPicture(el, kind, url)) {
            // Nothing to show, or not a picture (e.g. a PDF): nothing for us to check.
            el.setAttribute(APPROVED, url);
            el.setAttribute(STATE, 'true');
            return;
        }
        const round = IFS.newRound(el);
        el.removeAttribute(APPROVED);
        el.setAttribute(STATE, 'processing');
        IFS.checkUrl(url).then(r => {
            if (!IFS.enabled || !IFS.isCurrent(el, round)) return;
            if (r.failed) {
                el.setAttribute(STATE, 'failed');
                failedLater(el);
                return;
            }
            retry.delete(el);
            const target = r.dataUrl || url;
            el.setAttribute(APPROVED, target);
            if (target === url) {
                // It already points at the checked picture.
                el.setAttribute(STATE, 'true');
                return;
            }
            // Show it only once the element has loaded the filtered version.
            el.addEventListener('load', () => {
                if (IFS.isCurrent(el, round) && el.getAttribute(APPROVED) === target) el.setAttribute(STATE, 'true');
            }, { once: true });
            if (!el.hasAttribute(ORIGINAL)) el.setAttribute(ORIGINAL, raw);
            setUrl(el, kind, target);
        });
    }

    function recheckSingle(el) {
        el.removeAttribute(STATE);  // hidden again before the next paint
        el.removeAttribute(APPROVED);
        IFS.newRound(el);
        processSingle(el);
    }

    // --- Inline <svg> ----------------------------------------------------------------------
    function isOuterSvg(el) {
        return el.namespaceURI === SVG_NS && el.tagName.toLowerCase() === 'svg' &&
            !(el.parentElement && el.parentElement.closest('svg'));
    }
    function outerSvgOf(node) {
        let el = node.nodeType === 1 ? node : node.parentElement;
        let outer = null;
        while (el) {
            if (el.namespaceURI === SVG_NS && el.tagName.toLowerCase() === 'svg') outer = el;
            el = el.parentElement;
        }
        return outer;
    }

    const PAINT_PROPS = ['fill', 'fill-opacity', 'fill-rule', 'stroke', 'stroke-opacity', 'stroke-width',
        'stroke-linecap', 'stroke-linejoin', 'stroke-dasharray', 'stroke-dashoffset', 'stroke-miterlimit',
        'opacity', 'display', 'visibility', 'stop-color', 'stop-opacity', 'flood-color', 'flood-opacity',
        'lighting-color', 'color', 'font-family', 'font-size', 'font-weight', 'font-style', 'letter-spacing',
        'text-anchor', 'dominant-baseline', 'transform', 'transform-origin', 'transform-box', 'clip-path',
        'clip-rule', 'mask', 'filter', 'mix-blend-mode', 'paint-order', 'marker-start', 'marker-mid', 'marker-end'];
    const OWN_ATTRS = [IFS.STATE, APPROVED, ORIGINAL, 'data-ifs-pid', 'data-ifs-bg', 'data-ifs-probe'];

    // Copy `source` with each element's computed paint properties inlined, so the picture
    // looks as it does on the page (page CSS doesn't apply inside an SVG drawn as an image).
    function styledCopy(source, skipDisplayOnRoot) {
        const copy = source.cloneNode(true);
        const src = [source, ...source.querySelectorAll('*')];
        const dst = [copy, ...copy.querySelectorAll('*')];
        const inline = src.length <= 3000;  // huge charts: skip (slow); geometry still rasterises
        for (let i = 0; i < src.length; i++) {
            for (const a of OWN_ATTRS) dst[i].removeAttribute(a);
            if (!inline) continue;
            const cs = getComputedStyle(src[i]);
            let decl = '';
            for (const p of PAINT_PROPS) {
                if (p === 'display' && i === 0 && skipDisplayOnRoot) continue;
                const v = cs.getPropertyValue(p);
                if (v) decl += `${p}:${v};`;
            }
            dst[i].setAttribute('style', decl);
            // Undo our own hiding (unchecked <svg>/<image> are hidden by content-core.js).
            const tag = src[i].tagName.toLowerCase();
            if (tag === 'svg' || tag === 'image') {
                dst[i].style.opacity = '1';
                dst[i].style.visibility = 'visible';
            }
        }
        return copy;
    }

    function serializeSvg(svg, rect) {
        const copy = styledCopy(svg, false);
        // <foreignObject> would taint the canvas; HTML inside it is checked as normal elements.
        for (const fo of copy.querySelectorAll('foreignObject')) fo.remove();
        // <use href="#id"> often points outside this <svg> (an icon sprite): bring it along.
        const root = svg.getRootNode();
        const defs = document.createElementNS(SVG_NS, 'defs');
        for (const use of copy.querySelectorAll('use')) {
            const href = use.getAttribute('href') || use.getAttributeNS(XLINK_NS, 'href') || '';
            if (!href.startsWith('#')) continue;
            const id = href.slice(1);
            try {
                if (copy.querySelector('#' + CSS.escape(id)) || defs.querySelector('#' + CSS.escape(id))) continue;
            } catch {
                continue;
            }
            const ref = root.getElementById ? root.getElementById(id) : document.getElementById(id);
            if (ref) defs.appendChild(styledCopy(ref, true));
        }
        if (defs.childNodes.length) copy.insertBefore(defs, copy.firstChild);
        copy.setAttribute('width', String(rect.width));
        copy.setAttribute('height', String(rect.height));
        return new XMLSerializer().serializeToString(copy);
    }

    function hash(str) {
        let h = 0x811c9dc5;
        for (let i = 0; i < str.length; i++) {
            h ^= str.charCodeAt(i);
            h = Math.imul(h, 0x01000193);
        }
        return (h >>> 0).toString(36) + ':' + str.length;
    }

    async function rasteriseAndCheck(markup, rect) {
        const image = await IFS.loadImage('data:image/svg+xml;charset=utf-8,' + encodeURIComponent(markup), false);
        const dpr = window.devicePixelRatio || 1;
        const out = IFS.fit(rect.width * dpr, rect.height * dpr, 1280);
        const picture = IFS.drawToCanvas(image, out.w, out.h, null);       // keeps transparency
        const forModel = IFS.drawToCanvas(picture, out.w, out.h);           // white below
        let r;
        try {
            r = await IFS.checkCanvas(forModel);
        } finally {
            IFS.releaseCanvas(forModel);
        }
        if (r.mask) {
            IFS.paintMask(picture.getContext('2d'), r.mask, out.w, out.h);
            return { raster: await IFS.canvasToUrl(picture, 'image/png') };  // releases it
        }
        IFS.releaseCanvas(picture);
        if (r.failed) return { failed: true };
        if (r.clean) return { clean: true };
        if (r.filteredImageUrl) return { raster: r.filteredImageUrl };
        return { failed: true };
    }

    // markup hash -> Promise<{clean}|{raster}|{failed}>; bounded, rasters freed when unused.
    const svgCache = IFS.boundedCache(200, pending => pending.then(r => r && r.raster));
    const ownSvgStyle = new WeakMap();
    const RASTER_PROPS = ['background-image', 'background-size', 'background-repeat', 'background-position'];

    function showRaster(svg, raster) {
        svg.style.setProperty('background-image', `url("${raster}")`, 'important');
        svg.style.setProperty('background-size', '100% 100%', 'important');
        svg.style.setProperty('background-repeat', 'no-repeat', 'important');
        svg.style.setProperty('background-position', 'center', 'important');
        ownSvgStyle.set(svg, svg.getAttribute('style'));
        svg.setAttribute(STATE, 'raster');
    }
    function clearRaster(svg) {
        if (!ownSvgStyle.has(svg)) return;
        for (const p of RASTER_PROPS) svg.style.removeProperty(p);
        ownSvgStyle.delete(svg);
    }
    function showLive(svg) {
        clearRaster(svg);
        svg.setAttribute(STATE, 'true');
        for (const inner of svg.querySelectorAll('svg')) inner.setAttribute(STATE, 'true');
    }

    // Zero-size SVGs (sprites, collapsed menus) can't show anything; check them once they
    // get a size.
    const sizeWatch = new ResizeObserver(entries => {
        for (const e of entries) {
            if (e.contentRect.width >= 1 && e.contentRect.height >= 1 && e.target.getAttribute(STATE) === 'empty') {
                sizeWatch.unobserve(e.target);
                processSvg(e.target);
            }
        }
    });

    function processSvg(svg, { keepShowing = false } = {}) {
        if (!IFS.enabled || !svg.isConnected) return;
        const rect = svg.getBoundingClientRect();
        if (rect.width < 1 || rect.height < 1) {
            clearRaster(svg);
            svg.setAttribute(STATE, 'empty');
            sizeWatch.observe(svg);
            return;
        }
        const round = IFS.newRound(svg);
        const shown = svg.getAttribute(STATE) === 'true' || svg.getAttribute(STATE) === 'raster';
        if (!(keepShowing && shown)) {
            clearRaster(svg);
            svg.setAttribute(STATE, 'processing');
        }
        let markup;
        try {
            markup = serializeSvg(svg, rect);
        } catch (error) {
            IFS.log('Could not read inline SVG:', error && error.message);
            svg.setAttribute(STATE, 'failed');
            failedLater(svg);
            return;
        }
        const key = hash(markup);
        let pending = svgCache.get(key);
        if (!pending) {
            pending = rasteriseAndCheck(markup, rect).catch(() => ({ failed: true }));
            svgCache.set(key, pending);
            pending.then(r => { if (r.failed) svgCache.delete(key); });
        }
        pending.then(r => {
            if (!IFS.enabled || !IFS.isCurrent(svg, round)) return;
            if (r.failed) {
                clearRaster(svg);
                svg.setAttribute(STATE, 'failed');
                failedLater(svg);
            } else if (r.clean) {
                retry.delete(svg);
                showLive(svg);
            } else {
                retry.delete(svg);
                showRaster(svg, r.raster);
            }
        });
    }

    // Changes inside an approved <svg>: new elements hide it until re-checked; other changes
    // (attributes) are re-checked while it stays visible — batched per SVG.
    const pendingSvgs = new Map();  // svg -> { hide }
    let svgTimer = null;
    function scheduleSvg(svg, hide) {
        const entry = pendingSvgs.get(svg) || { hide: false };
        entry.hide = entry.hide || hide;
        pendingSvgs.set(svg, entry);
        if (hide && (svg.getAttribute(STATE) === 'true' || svg.getAttribute(STATE) === 'raster')) {
            clearRaster(svg);
            svg.setAttribute(STATE, 'processing');  // hidden before the next paint
        }
        if (!svgTimer) {
            svgTimer = setTimeout(() => {
                svgTimer = null;
                const batch = [...pendingSvgs];
                pendingSvgs.clear();
                for (const [s, e] of batch) processSvg(s, { keepShowing: !e.hide });
            }, hide ? 0 : 200);
        }
    }

    const UNHANDLED_SINGLE = SINGLE_SELECTOR.split(',').map(s => `${s.trim()}:not([${STATE}])`).join(', ');
    // New SVGs are already hidden by CSS, so checking them needn't happen inside the page's
    // mutation: do it in small batches with a rendered frame in between (icon-heavy pages).
    const svgQueue = new Set();
    let svgQueueTimer = null;
    function queueSvg(svg) {
        svgQueue.add(svg);
        if (!svgQueueTimer) svgQueueTimer = setTimeout(drainSvgQueue, 0);
    }
    function drainSvgQueue() {
        svgQueueTimer = null;
        const batch = [...svgQueue].slice(0, 40);
        for (const svg of batch) {
            svgQueue.delete(svg);
            if (!svg.hasAttribute(STATE) || svg.getAttribute(STATE) === 'processing') processSvg(svg);
        }
        if (svgQueue.size) svgQueueTimer = setTimeout(() => requestAnimationFrame(drainSvgQueue), 0);
    }

    function scanTree(root) {
        if (!IFS.enabled) return;
        for (const el of root.querySelectorAll(UNHANDLED_SINGLE)) processSingle(el);
        for (const svg of root.querySelectorAll(`svg:not([${STATE}])`)) {
            if (isOuterSvg(svg) && !svgQueue.has(svg)) queueSvg(svg);
        }
    }

    IFS.addModule({
        scanRoot: scanTree,

        onMutations(added, attrs) {
            if (!IFS.enabled) return;
            for (const n of added) {
                const outer = outerSvgOf(n.parentElement || n);
                if (outer && outer !== n) {
                    scheduleSvg(outer, true);  // new content inside an approved SVG
                } else if (isOuterSvg(n)) {
                    queueSvg(n);
                }
                if (kindOf(n)) processSingle(n);
                for (const el of n.querySelectorAll(SINGLE_SELECTOR)) processSingle(el);
                for (const svg of n.querySelectorAll('svg')) if (isOuterSvg(svg) && svg !== n) queueSvg(svg);
            }
            for (const r of attrs) {
                const el = r.target;
                const kind = kindOf(el);
                if (kind && ['src', 'data', 'href', 'type'].includes(r.attributeName)) {
                    const raw = rawUrl(el, kind);
                    if (abs(raw || '') !== el.getAttribute(APPROVED)) recheckSingle(el);
                    continue;
                }
                const outer = outerSvgOf(el);
                if (!outer) continue;
                if (el === outer && r.attributeName === 'style' && el.getAttribute('style') === ownSvgStyle.get(el)) continue;
                scheduleSvg(outer, false);
            }
        },

        tick() {
            if (!IFS.enabled) return;
            const now = Date.now();
            for (const [el, r] of retry) {
                if (!el.isConnected) {
                    retry.delete(el);
                } else if (r.at <= now) {
                    retry.set(el, { at: Infinity, delay: r.delay });  // failedLater doubles it
                    if (kindOf(el)) recheckSingle(el);
                    else processSvg(el);
                }
            }
            // xlink:href changes aren't reported to MutationObservers with a filter.
            for (const el of IFS.queryAll(`svg image[${STATE}="true"]`)) {
                if (abs(rawUrl(el, 'svgimage') || '') !== el.getAttribute(APPROVED)) recheckSingle(el);
            }
            for (const root of IFS.allRoots()) scanTree(root);
        },

        onEngineChange() {
            svgCache.clear();
        },

        setEnabled(on) {
            if (on) return;  // core rescans every root
            for (const el of IFS.queryAll(`[${STATE}]`)) {
                const kind = kindOf(el);
                if (kind && el.hasAttribute(ORIGINAL)) {
                    setUrl(el, kind, el.getAttribute(ORIGINAL));
                    el.removeAttribute(ORIGINAL);
                }
                if (el.namespaceURI === SVG_NS) clearRaster(el);
                if (kind || el.namespaceURI === SVG_NS) {
                    el.removeAttribute(STATE);
                    el.removeAttribute(APPROVED);
                }
            }
            retry.clear();
            svgCache.clear();
        }
    });
})();
