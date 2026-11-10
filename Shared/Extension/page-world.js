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
(function () {
    'use strict';
    if (window.__ifsPageWorld) return;
    Object.defineProperty(window, '__ifsPageWorld', { value: true });

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

    const attachShadow = Element.prototype.attachShadow;
    if (attachShadow) {
        Object.defineProperty(Element.prototype, 'attachShadow', {
            configurable: true,
            writable: true,
            value: function (init) {
                const root = attachShadow.call(this, Object.assign({}, init, { mode: 'open' }));
                try {
                    root.adoptedStyleSheets = [...root.adoptedStyleSheets, hideSheet()];
                } catch (e) { /* very old engine */ }
                // Not now: custom-element constructors must not add attributes.
                const host = this;
                queueMicrotask(() => {
                    try { host.setAttribute('data-ifs-shadow', ''); } catch (e) {}
                });
                return root;
            }
        });
    }

    const V = window.HTMLVideoElement && HTMLVideoElement.prototype;
    if (V) {
        const refuse = () => Promise.reject(new DOMException('Not allowed', 'NotAllowedError'));
        // A video that plays unfiltered (content-video.js marked it) behaves like any other.
        const unfiltered = el => el.hasAttribute('data-ifs-unfiltered');
        for (const name of ['webkitEnterFullscreen', 'webkitEnterFullScreen']) {
            const original = V[name];
            if (original) V[name] = function (...args) {
                if (unfiltered(this)) return original.apply(this, args);
            };
        }
        const requestPiP = V.requestPictureInPicture;
        if (requestPiP) V.requestPictureInPicture = function (...args) {
            return unfiltered(this) ? requestPiP.apply(this, args) : refuse();
        };
        if (V.webkitSetPresentationMode) {
            const setMode = V.webkitSetPresentationMode;
            V.webkitSetPresentationMode = function (mode) {
                if (mode === 'inline' || unfiltered(this)) return setMode.call(this, mode);
            };
        }
        for (const name of ['requestFullscreen', 'webkitRequestFullscreen', 'webkitRequestFullScreen']) {
            const original = Element.prototype[name];
            if (!original) continue;
            Element.prototype[name] = function (...args) {
                if (this instanceof HTMLVideoElement && !unfiltered(this)) {
                    return name === 'requestFullscreen' ? refuse() : undefined;
                }
                return original.apply(this, args);
            };
        }
    }
})();
