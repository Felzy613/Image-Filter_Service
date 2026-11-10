// Image Filter Service - CSS background, list-style and border images (incl. ::before/::after).
//
// content-core.js suppresses every CSS-supplied picture on every element (IFS.BG_CSS), so
// nothing here can ever show early. This module:
//   1. reads what the page intends for an element ("probe": lift the suppression with
//      data-ifs-probe, read the computed style, put it back — all in one synchronous task, so
//      nothing is painted in between);
//   2. checks each picture in that value (IFS.checkUrl: cached, same engine as <img>);
//   3. pins the approved value back — inline `!important` for elements (beats the
//      suppression rule), a per-element rule for pseudo-elements — with filtered pictures
//      swapped in.
// A later change by the page can only show the previous approved value, or nothing, until the
// new value has been checked. Gradients (no pictures) are pinned straight away.
(function () {
    'use strict';

    const IFS = globalThis.__ifs;
    if (!IFS) return;

    const PROBE = 'data-ifs-probe';
    const PINNED = 'data-ifs-bg';
    const PROPS = ['background-image', 'list-style-image', 'border-image-source'];
    const PSEUDOS = ['before', 'after'];
    const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'LINK', 'META', 'HEAD', 'TITLE', 'NOSCRIPT',
        'TEMPLATE', 'BR', 'WBR', 'SOURCE', 'TRACK', 'PARAM', 'BASE']);
    const SVG_NS = 'http://www.w3.org/2000/svg';
    // --- Keeping the work per mutation small -----------------------------------------------------
    // Every picture is suppressed by CSS until it has been probed and checked, so WHEN an element is
    // re-read is only a question of latency, never of leaking. What must stay cheap is the probe
    // itself (it flips an attribute on each element and forces a style recalculation), because a page
    // can mutate hundreds of times a second (animations, carousels, SPAs toggling classes).
    //  - an inline-style change is only re-probed if the old or new style text mentions something that
    //    can supply a picture (background, list-style, border-image, content, url(), a custom property,
    //    or `all`); transform/opacity/left/... animations cost nothing;
    //  - a class/id change re-probes the element and at most DESC_CAP descendants; bigger subtrees go
    //    to the chunked sweep;
    //  - attribute-driven probes are throttled (leading edge now, then at most one batch per ATTR_GAP);
    //  - a batch probes SYNC_MAX elements at once and the rest in chunks across later frames.
    const IMAGE_STYLE_RE = /background|list-style|border-image|content|url\(|--|\ball\b/i;
    const DESC_CAP = 40;
    const SYNC_MAX = 200;
    const ATTR_GAP = 120;
    const REPROBE_QUIET_MS = 30000;   // the safety-net sweep skips elements probed this recently
    const lastProbe = new WeakMap();  // el -> performance.now() of its last probe
    const later = fn => {             // next frame, or soon after if frames aren't running (hidden)
        let done = false;
        const run = () => { if (!done) { done = true; fn(); } };
        requestAnimationFrame(run);
        setTimeout(run, 50);
    };
    const URL_RE = /url\(\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|([^)\s]*))\s*\)/g;

    // el -> { pins: {prop: {value, source}}, page: {prop: {value, priority}}, pseudo: {before, after} }
    let records = new WeakMap();
    const ownStyle = new WeakMap();  // el -> its style attribute as we last left it
    const retry = new Map();         // el -> { at, delay }: a check failed; probe again later

    function urlsIn(value) {
        const urls = [];
        if (!value || !value.includes('url(')) return urls;
        for (const m of value.matchAll(URL_RE)) {
            const u = (m[1] ?? m[2] ?? m[3] ?? '').replace(/\\(.)/g, '$1');
            if (u && !urls.includes(u)) urls.push(u);
        }
        return urls;
    }

    function replaceUrls(value, map) {
        return value.replace(URL_RE, (match, a, b, c) => {
            const to = map.get((a ?? b ?? c ?? '').replace(/\\(.)/g, '$1'));
            return to ? `url("${to.replace(/(["\\])/g, '\\$1')}")` : match;
        });
    }

    function isCandidate(el) {
        if (el.nodeType !== 1 || SKIP_TAGS.has(el.tagName) || IFS.isOwnElement(el)) return false;
        // Elements inside an <svg> have no CSS boxes; the outermost <svg> does.
        if (el.namespaceURI === SVG_NS) {
            if (el.tagName.toLowerCase() !== 'svg') return false;
            if (el.parentElement && el.parentElement.namespaceURI === SVG_NS) return false;
            // An inline <svg> showing a filtered raster is managed by content-elements.js.
            if (el.getAttribute(IFS.STATE) === 'raster') return false;
        }
        return true;
    }

    function record(el) {
        let rec = records.get(el);
        if (!rec) records.set(el, (rec = { pins: {}, page: {}, pseudo: {} }));
        return rec;
    }

    function noteOwnStyle(el) {
        ownStyle.set(el, el.getAttribute('style'));
    }

    function setInline(el, prop, saved) {
        if (saved && saved.value) el.style.setProperty(prop, saved.value, saved.priority);
        else el.style.removeProperty(prop);
    }

    // Pin `value` (approved) inline. The page's own inline value is remembered so a probe —
    // and disabling the extension — can put it back.
    function pinValue(el, prop, value, source) {
        const rec = record(el);
        if (!rec.pins[prop]) {
            rec.page[prop] = { value: el.style.getPropertyValue(prop), priority: el.style.getPropertyPriority(prop) };
        }
        el.style.setProperty(prop, value, 'important');
        rec.pins[prop] = { value: el.style.getPropertyValue(prop), source };
        if (!el.hasAttribute(PINNED)) el.setAttribute(PINNED, '');
        noteOwnStyle(el);
    }

    function unpin(el, rec, prop) {
        setInline(el, prop, rec.page[prop]);
        delete rec.pins[prop];
        delete rec.page[prop];
        if (!Object.keys(rec.pins).length) el.removeAttribute(PINNED);
        noteOwnStyle(el);
    }

    // Put the page's inline values back for the probe. If the page has overwritten one of our
    // pins since, that is now the page's value and our pin is gone.
    function liftPins(el, rec) {
        for (const prop of Object.keys(rec.pins)) {
            const pin = rec.pins[prop];
            if (el.style.getPropertyValue(prop) === pin.value && el.style.getPropertyPriority(prop) === 'important') {
                setInline(el, prop, rec.page[prop]);
            } else {
                rec.page[prop] = { value: el.style.getPropertyValue(prop), priority: el.style.getPropertyPriority(prop) };
                delete rec.pins[prop];
            }
        }
    }

    function applyPins(el, rec) {
        for (const prop of Object.keys(rec.pins)) {
            el.style.setProperty(prop, rec.pins[prop].value, 'important');
        }
        if (!Object.keys(rec.pins).length) el.removeAttribute(PINNED);
        noteOwnStyle(el);
    }

    // Read what the page intends for each element. Synchronous: no paint can happen while the
    // suppression is lifted.
    function probe(els) {
        for (const el of els) {
            const rec = records.get(el);
            if (rec && Object.keys(rec.pins).length) liftPins(el, rec);
            el.setAttribute(PROBE, '');
        }
        const out = [];
        for (const el of els) {
            const cs = getComputedStyle(el);
            const props = {};
            for (const p of PROPS) props[p] = cs.getPropertyValue(p);
            const pseudo = {};
            for (const ps of PSEUDOS) {
                const pcs = getComputedStyle(el, '::' + ps);
                const content = pcs.getPropertyValue('content');
                // No content -> the pseudo-element doesn't exist, whatever its background.
                pseudo[ps] = content && content !== 'none' && content !== 'normal'
                    ? { bg: pcs.getPropertyValue('background-image'), content } : null;
            }
            out.push({ el, props, pseudo });
        }
        const stamp = performance.now();
        for (const el of els) {
            lastProbe.set(el, stamp);
            el.removeAttribute(PROBE);
            const rec = records.get(el);
            if (rec && (Object.keys(rec.pins).length || el.hasAttribute(PINNED))) applyPins(el, rec);
        }
        return out;
    }

    // A page's inline `!important` beats the suppression stylesheet, so such a picture would show at
    // once. Cover it before the next paint with the last approved value (or nothing). This only reads
    // the element's inline style (no style recalculation), so it runs synchronously for every element
    // that changed or arrived, however much of the real probing is deferred or throttled.
    function coverInlineImportant(el) {
        const st = el.style;
        if (!st || !st.length) return;
        for (const prop of PROPS) {
            if (st.getPropertyPriority(prop) !== 'important') continue;
            const value = st.getPropertyValue(prop);
            if (!value || value === 'none') continue;
            const rec = records.get(el);
            const pin = rec && rec.pins[prop];
            if (pin && value === pin.value) continue;   // our own approved pin
            pinValue(el, prop, pin ? pin.value : 'none', pin ? pin.source : null);
        }
    }

    // Output resolution: what the element can show (its box × devicePixelRatio).
    function displaySize(el) {
        const r = el.getBoundingClientRect();
        return Math.max(r.width, r.height) * (window.devicePixelRatio || 1);
    }
    function checkAll(urls, el) {
        const size = displaySize(el);
        return Promise.all(urls.map(u => IFS.checkUrl(u, size)));
    }

    function failed(el) {
        const prev = retry.get(el);
        const delay = prev ? Math.min(prev.delay * 2, 60000) : 5000;
        retry.set(el, { at: Date.now() + delay, delay });
    }

    function handleProp(el, prop, intended) {
        const rec = records.get(el);
        const pin = rec && rec.pins[prop];
        if (!intended || intended === 'none') {
            if (pin) unpin(el, rec, prop);
            return;
        }
        if (pin && pin.source === intended) return;        // unchanged and already approved
        const urls = urlsIn(intended);
        if (!urls.length) {                                 // gradients only: nothing to check
            pinValue(el, prop, intended, intended);
            return;
        }
        // A page's inline `!important` beats the suppression rule: cover it right now (we run
        // before the next paint) with the last approved value, or nothing.
        if (el.style.getPropertyPriority(prop) === 'important' && !(pin && el.style.getPropertyValue(prop) === pin.value)) {
            pinValue(el, prop, pin ? pin.value : 'none', pin ? pin.source : null);
        }
        const round = IFS.newRound(el, prop);
        checkAll(urls, el).then(results => {
            if (!IFS.enabled || !IFS.isCurrent(el, round, prop)) return;
            if (results.some(r => r.failed)) return failed(el);
            retry.delete(el);
            const map = new Map(urls.map((u, i) => [u, results[i].dataUrl || u]));
            pinValue(el, prop, replaceUrls(intended, map), intended);
        });
    }

    function handlePseudo(el, ps, info) {
        const rec = records.get(el);
        const key = info ? info.bg + '\n' + info.content : '';
        if (key === ((rec && rec.pseudo[ps]) || '')) return;
        if (!info) {
            IFS.setPseudoRule(el, ps, null);
            if (rec) delete rec.pseudo[ps];
            return;
        }
        const bg = info.bg && info.bg !== 'none' ? info.bg : null;
        const bgUrls = urlsIn(bg);
        const contentUrls = urlsIn(info.content);
        if (!bgUrls.length && !contentUrls.length) {
            IFS.setPseudoRule(el, ps, bg ? `background-image: ${bg} !important;` : null);
            record(el).pseudo[ps] = key;
            return;
        }
        // Pictures in `content:` aren't covered by the suppression rule: hide this
        // pseudo-element now, before the next paint, until they're checked.
        if (contentUrls.length) IFS.setPseudoRule(el, ps, 'visibility: hidden !important;');
        const urls = [...new Set([...bgUrls, ...contentUrls])];
        const round = IFS.newRound(el, ps);
        record(el).pseudo[ps] = key;
        checkAll(urls, el).then(results => {
            if (!IFS.enabled || !IFS.isCurrent(el, round, ps)) return;
            if (results.some(r => r.failed)) {
                delete record(el).pseudo[ps];
                return failed(el);
            }
            const map = new Map(urls.map((u, i) => [u, results[i].dataUrl || u]));
            const decl = [];
            if (bg) decl.push(`background-image: ${replaceUrls(bg, map)} !important`);
            if (contentUrls.length) decl.push(`content: ${replaceUrls(info.content, map)} !important`);
            IFS.setPseudoRule(el, ps, decl.join('; ') + ';');
        });
    }

    function process(els, { skipHovered = false } = {}) {
        if (!IFS.enabled || !els.length) return;
        if (skipHovered) {
            // A hover-only picture would otherwise get pinned and stay after the hover ends.
            els = els.filter(el => !el.matches(':hover'));
        }
        for (const { el, props, pseudo } of probe(els)) {
            for (const p of PROPS) handleProp(el, p, props[p]);
            for (const ps of PSEUDOS) handlePseudo(el, ps, pseudo[ps]);
        }
    }

    function collect(root, into) {
        if (root.nodeType === 1 && isCandidate(root)) into.push(root);
        for (const el of root.querySelectorAll('*')) if (isCandidate(el)) into.push(el);
        return into;
    }

    // A batch: the first SYNC_MAX elements now (before the next paint), the rest in chunks.
    function processBatch(els, opts) {
        process(els.slice(0, SYNC_MAX), opts);
        if (els.length <= SYNC_MAX) return;
        let i = SYNC_MAX;
        const step = () => {
            if (!IFS.enabled) return;
            process(els.slice(i, i + CHUNK).filter(el => el.isConnected), opts);
            i += CHUNK;
            if (i < els.length) later(step);
        };
        later(step);
    }

    // Attribute-driven re-probes: the first one runs at once; more arriving within ATTR_GAP are
    // merged into a single trailing batch.
    const pendingAttr = new Set();
    let attrTimer = null;
    let lastAttrFlush = -Infinity;
    function queueAttr(els) {
        for (const el of els) pendingAttr.add(el);
        const wait = ATTR_GAP - (performance.now() - lastAttrFlush);
        if (wait <= 0) flushAttr();
        else if (!attrTimer) attrTimer = setTimeout(flushAttr, wait);
    }
    function flushAttr() {
        if (attrTimer) {
            clearTimeout(attrTimer);
            attrTimer = null;
        }
        lastAttrFlush = performance.now();
        const els = [...pendingAttr].filter(el => el.isConnected);
        pendingAttr.clear();
        if (IFS.enabled && els.length) processBatch(els);
    }

    // A class/id change on an element with many descendants: re-read just that subtree (chunked), not
    // the whole page, and not more than once a second per element (toggling a class on a big container
    // is usually UI state). Descendants stay suppressed meanwhile, so this is latency only.
    const SUBTREE_GAP = 1000;
    const pendingSubtrees = new Set();
    let subtreeTimer = null;
    let lastSubtreeFlush = -Infinity;
    function queueSubtree(root) {
        pendingSubtrees.add(root);
        const wait = SUBTREE_GAP - (performance.now() - lastSubtreeFlush);
        if (wait <= 0) flushSubtrees();
        else if (!subtreeTimer) subtreeTimer = setTimeout(flushSubtrees, wait);
    }
    function flushSubtrees() {
        if (subtreeTimer) {
            clearTimeout(subtreeTimer);
            subtreeTimer = null;
        }
        lastSubtreeFlush = performance.now();
        const roots = [...pendingSubtrees].filter(r => r.isConnected);
        pendingSubtrees.clear();
        if (!IFS.enabled || !roots.length) return;
        const all = new Set();
        for (const r of roots) for (const el of collect(r, [])) all.add(el);
        const now = performance.now();
        const stale = [...all].filter(el => now - (lastProbe.get(el) || -Infinity) > SUBTREE_GAP);
        if (stale.length) processBatch(stale);
    }

    // Re-read in chunks (stylesheet loaded, viewport resized, periodic safety net). Latency
    // only: anything new stays suppressed until then. Small chunks with a rendered frame in
    // between, so a long page never stalls (a full read of 5,000 elements is ~0.4 s of work).
    const CHUNK = 200;
    let sweepTimer = null;
    let sweeping = false;
    let sweepAgain = false;
    function scheduleSweep(delay = 150, nearViewportOnly = false) {
        if (sweeping) {
            if (!nearViewportOnly) sweepAgain = true;
            return;
        }
        if (sweepTimer) return;
        sweepTimer = setTimeout(() => sweep(nearViewportOnly), delay);
    }
    function sweep(nearViewportOnly) {
        sweepTimer = null;
        if (!IFS.enabled) return;
        sweeping = true;
        const els = [];
        for (const root of IFS.allRoots()) collect(root, els);
        let i = 0;
        const step = () => {
            if (!IFS.enabled) {
                sweeping = false;
                return;
            }
            let slice = els.slice(i, i + CHUNK).filter(el => el.isConnected);
            if (nearViewportOnly) {
                const now = performance.now();
                slice = slice.filter(el => now - (lastProbe.get(el) || -Infinity) > REPROBE_QUIET_MS && IFS.isNearViewport(el));
            }
            process(slice, { skipHovered: true });
            i += CHUNK;
            if (i < els.length) {
                requestAnimationFrame(() => setTimeout(step, 0));  // let a frame render first
            } else {
                sweeping = false;
                if (sweepAgain) {
                    sweepAgain = false;
                    scheduleSweep();
                }
            }
        };
        step();
    }

    IFS.addModule({
        // A new root (or the document): read everything in it now, before it paints.
        scanRoot(root) {
            if (IFS.enabled) process(collect(root, []));
        },

        onMutations(added, attrs) {
            const addedEls = [];   // new nodes: nothing is known about them yet
            const attrEls = [];    // existing nodes whose class/id/style changed
            const seen = new Set();
            const add = (list, el) => {
                if (!seen.has(el) && isCandidate(el)) {
                    seen.add(el);
                    list.push(el);
                }
            };
            let sheetsChanged = false;
            for (const n of added) {
                if (n.tagName === 'STYLE' || (n.tagName === 'LINK' && /stylesheet/i.test(n.rel))) sheetsChanged = true;
                add(addedEls, n);
                for (const d of n.querySelectorAll('*')) add(addedEls, d);
            }
            for (const r of attrs) {
                const el = r.target;
                if (r.attributeName === 'style') {
                    if (el.getAttribute('style') === ownStyle.get(el)) continue;
                    // Animations rewrite transform/opacity/left... all the time; none of that can change a picture.
                    if (!IMAGE_STYLE_RE.test(r.oldValue || '') && !IMAGE_STYLE_RE.test(el.getAttribute('style') || '')) continue;
                    coverInlineImportant(el);
                    add(attrEls, el);
                } else if (r.attributeName === 'class' || r.attributeName === 'id') {
                    add(attrEls, el);
                    // Descendant selectors (".dark .hero") change children too: a few are re-probed
                    // with the element, a bigger subtree is re-read separately (throttled, chunked).
                    const desc = el.getElementsByTagName('*');
                    if (desc.length <= DESC_CAP) {
                        for (const d of desc) add(attrEls, d);
                    } else {
                        queueSubtree(el);
                    }
                }
            }
            for (const el of addedEls) coverInlineImportant(el);
            if (addedEls.length) processBatch(addedEls);
            if (attrEls.length) queueAttr(attrEls);
            if (sheetsChanged) scheduleSweep();
        },

        tick() {
            const now = Date.now();
            const due = [];
            for (const [el, r] of retry) {
                if (!el.isConnected) retry.delete(el);
                else if (r.at <= now) due.push(el);
            }
            if (due.length) process(due);
        },

        setEnabled(on) {
            if (on) {
                scheduleSweep(0);
                return;
            }
            for (const el of IFS.queryAll(`[${PINNED}]`)) {
                const rec = records.get(el);
                if (rec) for (const prop of Object.keys(rec.pins)) setInline(el, prop, rec.page[prop]);
                el.removeAttribute(PINNED);
            }
            for (const el of IFS.queryAll('[data-ifs-pid]')) el.removeAttribute('data-ifs-pid');
            records = new WeakMap();
            retry.clear();
        }
    });

    // Stylesheets that finish loading, and viewport changes (media queries), can change what
    // the page intends; anything new stays suppressed until the sweep reads it.
    document.addEventListener('load', e => {
        if (e.target && e.target.tagName === 'LINK') scheduleSweep();
    }, true);
    window.addEventListener('resize', () => scheduleSweep(200), { passive: true });
    window.addEventListener('load', () => scheduleSweep(0));
    // Safety net for changes nothing tells us about (rules inserted through the CSSOM, …):
    // only what's on or near the screen.
    let lastSweepActivity = -1;
    let lastSweepAt = -Infinity;
    setInterval(() => {
        if (document.hidden) return;
        const now = performance.now();
        if (IFS.activity === lastSweepActivity && now - lastSweepAt < 60000) return;  // nothing happened
        lastSweepActivity = IFS.activity;
        lastSweepAt = now;
        scheduleSweep(0, true);
    }, 10000);
})();
