// Image Filter Service - runs in the PAGE's own JavaScript world, before the page's scripts.
// Registered by background.js with scripting.registerContentScripts({ world: 'MAIN' })
// (Safari ignores "world" in the manifest).
//
//  1. Shadow DOM: every shadow root is made open (the extension's content scripts can't
//     reach closed ones) and gets the hide-until-checked styles the moment it is created,
//     before the component renders into it. Its host is tagged data-ifs-shadow so
//     content-core.js finds it and takes over (its own styles replace this stopgap sheet).
//  2. Video: page scripts can't push a <video> into native fullscreen or Picture in Picture,
//     which would show the unfiltered video (content-video.js shows filtered frames only).
//     Exception: a video content-video.js can't filter (frames unreadable, or checks
//     failing) carries data-ifs-unfiltered and plays normally, fullscreen and Picture in
//     Picture included.
//
// Both replace built-in browser functions, which bot checks look for: Cloudflare's managed
// challenge treats a page whose DOM functions aren't the browser's own as a bot (a single
// pass-through wrapper around document.createElement was enough to lock people out, KDE bug
// 487303), and forcing a closed shadow root open is exactly what captcha-solving tools do to
// Turnstile. So every replaced function is put back, exactly as it was, the moment
//   - the page adds a Cloudflare challenge script (the "Just a moment..." page, a Turnstile
//     widget): before that script runs, see watchForChallenges below; or
//   - content.js says this website is excluded from filtering (event RELEASE_EVENT), so an
//     excluded site gets a page exactly as the browser made it.
// background.js doesn't inject this file into the challenge frames themselves
// (challenges.cloudflare.com and other captcha providers; PAGE_WORLD_EXCLUDE).
(function () {
    'use strict';
    const GUARD = '__ifsPageWorld';
    if (window[GUARD]) return;
    Object.defineProperty(window, GUARD, { value: true, configurable: true });

    // Keep in sync with IFS.ELEMENT_CSS + IFS.BG_CSS in content-core.js. The first rule is a
    // marker so content-core.js can recognise (and replace) this sheet.
    const S = ':not(#_):not(#_):not(#_)';
    const P = 'data-filter-processed';
    const CSS = `
.ifs-page-world-sheet {}
img:not([${P}="true"])${S}, input[type="image" i]:not([${P}="true"])${S},
object:not([${P}="true"])${S}, embed:not([${P}="true"])${S}, svg image:not([${P}="true"])${S} {
    opacity: 0 !important; visibility: hidden !important; transition: none !important; }
svg:not([${P}="true"]):not([${P}="raster"])${S} { opacity: 0 !important; transition: none !important; }
svg[${P}="raster"]${S} > * { visibility: hidden !important; }
video:not([data-ifs-unfiltered])${S} { opacity: 0 !important; transition: none !important; }
*:not([data-ifs-probe])${S}, *:not([data-ifs-probe])${S}::before, *:not([data-ifs-probe])${S}::after {
    background-image: none !important; list-style-image: none !important; border-image-source: none !important; }
`;
    let sheet = null;
    function hideSheet() {
        if (!sheet) {
            sheet = new CSSStyleSheet();
            sheet.replaceSync(CSS);
        }
        return sheet;
    }

    // Every property replaced below, with its original descriptor (or none, if it was inherited),
    // so release() can put the prototypes back exactly as the browser made them: the same
    // function objects with the same flags.
    const replaced = [];
    function replace(target, name, value) {
        if (!(name in target)) return;
        const original = Object.getOwnPropertyDescriptor(target, name) || null;
        replaced.push({ target, name, original });
        Object.defineProperty(target, name, original
            ? { ...original, value }
            : { value, writable: true, enumerable: true, configurable: true });
    }

    const RELEASE_EVENT = 'ifs-release-page-world';
    let challengeWatch = null;
    let released = false;
    function release() {
        if (released) return;
        released = true;
        for (const { target, name, original } of replaced.reverse()) {
            try {
                if (original) Object.defineProperty(target, name, original);
                else delete target[name];
            } catch (e) { /* frozen by the page */ }
        }
        replaced.length = 0;
        if (challengeWatch) challengeWatch.disconnect();
        document.removeEventListener(RELEASE_EVENT, release, true);
        try { delete window[GUARD]; } catch (e) {}
    }

    const nativeAttachShadow = Element.prototype.attachShadow;
    if (nativeAttachShadow) {
        replace(Element.prototype, 'attachShadow', function (init) {
            const root = nativeAttachShadow.call(this, Object.assign({}, init, { mode: 'open' }));
            try {
                root.adoptedStyleSheets = [...root.adoptedStyleSheets, hideSheet()];
            } catch (e) { /* very old engine */ }
            // Not now: custom-element constructors must not add attributes.
            const host = this;
            queueMicrotask(() => {
                try { host.setAttribute('data-ifs-shadow', ''); } catch (e) {}
            });
            return root;
        });
    }

    const V = window.HTMLVideoElement && HTMLVideoElement.prototype;
    if (V) {
        const refuse = () => Promise.reject(new DOMException('Not allowed', 'NotAllowedError'));
        // A video that plays unfiltered (content-video.js marked it) behaves like any other.
        const unfiltered = el => el.hasAttribute('data-ifs-unfiltered');
        for (const name of ['webkitEnterFullscreen', 'webkitEnterFullScreen']) {
            const original = V[name];
            if (original) replace(V, name, function (...args) {
                if (unfiltered(this)) return original.apply(this, args);
            });
        }
        const requestPiP = V.requestPictureInPicture;
        if (requestPiP) replace(V, 'requestPictureInPicture', function (...args) {
            return unfiltered(this) ? requestPiP.apply(this, args) : refuse();
        });
        const setMode = V.webkitSetPresentationMode;
        if (setMode) replace(V, 'webkitSetPresentationMode', function (mode) {
            if (mode === 'inline' || unfiltered(this)) return setMode.call(this, mode);
        });
        for (const name of ['requestFullscreen', 'webkitRequestFullscreen', 'webkitRequestFullScreen']) {
            const original = Element.prototype[name];
            if (!original) continue;
            replace(Element.prototype, name, function (...args) {
                if (this instanceof HTMLVideoElement && !unfiltered(this)) {
                    return name === 'requestFullscreen' ? refuse() : undefined;
                }
                return original.apply(this, args);
            });
        }
    }

    // --- Putting the browser's functions back --------------------------------------------
    // content.js (isolated world) dispatches this on the document once it knows the site is
    // excluded. A page could dispatch it too; all it would gain is its own native fullscreen
    // and closed shadow roots — the content scripts still filter everything they can reach.
    document.addEventListener(RELEASE_EVENT, release, true);

    // Cloudflare challenge code: the "Just a moment..." page (…/cdn-cgi/challenge-platform/h/…
    // orchestrate script) and Turnstile (challenges.cloudflare.com/turnstile/…). Scripts are seen
    // here when they are added to the document — for one the parser adds, the observer runs at the
    // microtask checkpoint the parser performs before running it; one a script adds is fetched
    // first — so the functions are back before Cloudflare's code runs. Only direct additions are
    // looked at (that is how these scripts arrive), which keeps this cheap on busy pages.
    // Not included: Cloudflare's background bot detection (…/challenge-platform/scripts/jsd/),
    // which runs in a separate blank frame on ordinary pages of many sites; releasing there
    // would give up shadow-root and fullscreen protection on a large part of the web, and there
    // is no evidence it is affected. Change CHALLENGE_SRC if that turns out to be wrong.
    const CHALLENGE_SRC = /\/cdn-cgi\/challenge-platform\/h\/|\/\/challenges\.cloudflare\.com\/turnstile\//;
    function isChallengeScript(node) {
        return node.nodeType === 1 && node.localName === 'script' && CHALLENGE_SRC.test(node.src || '');
    }
    if (window.MutationObserver) {
        challengeWatch = new MutationObserver(records => {
            for (const r of records) {
                for (const n of r.addedNodes) {
                    if (isChallengeScript(n)) return release();
                }
            }
        });
        challengeWatch.observe(document, { childList: true, subtree: true });
    }
})();
