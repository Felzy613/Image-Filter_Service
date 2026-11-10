// Image Filter Service - <video>.
//
// A <video> is never shown (content-core.js keeps it at opacity 0 — it keeps playing, with
// sound). In its place an overlay <canvas> shows only frames that have been checked: each
// frame is copied, checked, greyed with ITS OWN mask, and only then drawn. So motion can't
// expose skin between checks; the picture just updates at the rate frames can be checked.
//   - Before the first frame: the poster, checked like any image (or black).
//   - A video that can't be filtered is NOT blocked: it is played as the page made it (the
//     overlay is hidden, `data-ifs-unfiltered` lifts the hide rule, the page's own
//     presentation attributes come back). Two cases:
//       · Cross-origin video without CORS (or DRM): frames can't be read. Stays unfiltered
//         until a new source (`emptied`), which is tried again from scratch.
//       · Checks keep failing (server / engine down, timeouts) for FAIL_GRACE_MS while the
//         video plays: unfiltered too, but it probes every PROBE_MS and goes back to
//         filtered frames as soon as a check works.
//   - Native fullscreen / Picture in Picture / AirPlay would show the raw video, so while a
//     video is being filtered they are blocked here and in page-world.js; `playsinline` keeps
//     iPhone from going fullscreen. An unfiltered video gets them back.
//   - Videos with native controls (hidden along with the video) get a tap-to-play overlay.
(function () {
    'use strict';

    const IFS = globalThis.__ifs;
    if (!IFS) return;

    const OVERLAY = 'data-ifs-overlay';
    const UNFILTERED = 'data-ifs-unfiltered';  // keep in sync with IFS.ELEMENT_CSS and page-world.js
    // What lockPresentation() changes; saved so an unfiltered video can get the page's values back.
    const PRESENTATION_ATTRS = ['playsinline', 'webkit-playsinline', 'disablepictureinpicture', 'x-webkit-airplay'];
    // Checks that keep failing (server/engine down, timeouts) this long, while the video plays,
    // release it to play unfiltered; while released, one check every PROBE_MS to see whether
    // filtering works again.
    const FAIL_GRACE_MS = 2000;
    const PROBE_MS = 2000;
    const players = new Map();  // video -> Player

    const visibility = new IntersectionObserver(entries => {
        for (const e of entries) {
            const p = players.get(e.target);
            if (!p) continue;
            p.visible = e.isIntersecting;
            if (p.visible) p.render();
        }
    }, { rootMargin: '200px' });
    const sizes = new ResizeObserver(entries => {
        for (const e of entries) {
            const p = players.get(e.target);
            if (p) p.redraw();
        }
    });

    class Player {
        constructor(video) {
            this.video = video;
            this.canvas = document.createElement('canvas');
            this.canvas.setAttribute(OVERLAY, '');
            this.canvas.setAttribute('aria-hidden', 'true');
            this.ctx = this.canvas.getContext('2d');
            this.work = document.createElement('canvas');  // the frame being checked
            this.shown = document.createElement('canvas'); // last checked frame (for redraws)
            this.hasFrame = false;
            this.busy = false;
            this.unreadable = false;   // frames can't be read: unfiltered until a new source
            this.unfiltered = false;   // shown as is (unreadable, or checks have been failing)
            this.failingSince = 0;     // start of the current run of failed checks
            this.lastProbe = 0;
            this.visible = true;
            this.posterUrl = null;
            this.looping = false;
            this.interactive = video.hasAttribute('controls');
            this.cleanup = [];

            // A stale marker (an earlier player, or the page) must not show this video unchecked.
            video.removeAttribute(UNFILTERED);
            this.original = {};
            for (const name of PRESENTATION_ATTRS) this.original[name] = video.getAttribute(name);
            this.originalRemote = video.disableRemotePlayback;
            this.lockPresentation();
            video.after(this.canvas);

            const on = (target, type, fn) => {
                target.addEventListener(type, fn);
                this.cleanup.push(() => target.removeEventListener(type, fn));
            };
            on(video, 'play', () => this.loop());
            on(video, 'playing', () => this.loop());
            for (const type of ['loadeddata', 'seeked', 'pause', 'ended']) on(video, type, () => this.render());
            on(video, 'emptied', () => this.reset());
            // Native presentation shows the raw video: refuse it.
            // (An unfiltered video is shown as is, so there is nothing to protect.)
            on(video, 'webkitbeginfullscreen', () => {
                if (this.unfiltered) return;
                try { video.webkitExitFullscreen(); } catch {}
                video.pause();
            });
            on(video, 'webkitpresentationmodechanged', () => {
                if (this.unfiltered) return;
                if (video.webkitPresentationMode && video.webkitPresentationMode !== 'inline') {
                    try { video.webkitSetPresentationMode('inline'); } catch {}
                    video.pause();
                }
            });
            on(video, 'enterpictureinpicture', () => {
                if (this.unfiltered) return;
                if (document.exitPictureInPicture) document.exitPictureInPicture().catch(() => {});
                video.pause();
            });
            if (this.interactive) {
                on(this.canvas, 'click', e => {
                    e.preventDefault();
                    if (video.paused) video.play().catch(() => {});
                    else video.pause();
                });
            }

            visibility.observe(video);
            sizes.observe(video);
            this.render();
            if (!video.paused) this.loop();
        }

        lockPresentation() {
            const v = this.video;
            v.setAttribute('playsinline', '');
            v.setAttribute('webkit-playsinline', '');
            v.setAttribute('disablepictureinpicture', '');
            v.setAttribute('x-webkit-airplay', 'deny');
            try { v.disableRemotePlayback = true; } catch {}
        }

        // This video can't be filtered, so show it as the page made it. Overlay off, hide rule
        // lifted, presentation attributes (inline playback, PiP, AirPlay) back to the page's
        // values. reason 'unreadable': its frames can't be read (cross-origin without CORS, DRM)
        // — stays so until a new source. reason 'failed': checks keep failing (server or engine
        // down) — render() keeps probing and resumeFiltering() takes over once a check works.
        releaseVideo(reason) {
            const v = this.video;
            const wasUnfiltered = this.unfiltered;
            this.unfiltered = true;
            if (reason === 'unreadable') this.unreadable = true;
            v.setAttribute(UNFILTERED, '');
            for (const name of PRESENTATION_ATTRS) {
                if (this.original[name] === null) v.removeAttribute(name);
                else v.setAttribute(name, this.original[name]);
            }
            try { v.disableRemotePlayback = this.originalRemote; } catch {}
            this.place();  // hides the overlay
            // (A probing video keeps its work canvas.)
            for (const c of this.unreadable ? [this.canvas, this.work, this.shown] : [this.canvas, this.shown]) {
                IFS.releaseCanvas(c);
            }
            this.hasFrame = false;
            if (!wasUnfiltered) {
                IFS.log(reason === 'unreadable'
                    ? 'Video can\'t be filtered (frames not readable): playing it unfiltered'
                    : 'Video can\'t be filtered right now (checks failing): playing it unfiltered');
            }
        }

        // A check worked again: hide the video, show checked frames. The caller draws the
        // checked frame in the same task, so the overlay is up before the next paint.
        resumeFiltering() {
            const v = this.video;
            this.unfiltered = false;
            this.failingSince = 0;
            v.removeAttribute(UNFILTERED);
            this.lockPresentation();
            this.lastCss = null;
            // Fullscreen / PiP entered while it was unfiltered would still show the raw video.
            try {
                if (v.webkitPresentationMode && v.webkitPresentationMode !== 'inline') v.webkitSetPresentationMode('inline');
            } catch {}
            try {
                if (document.pictureInPictureElement === v) document.exitPictureInPicture().catch(() => {});
                if (document.fullscreenElement === v) document.exitFullscreen().catch(() => {});
            } catch {}
            IFS.log('Video can be filtered again: filtering resumed');
        }

        // A check failed. After FAIL_GRACE_MS of failures in a row, a playing video is released.
        noteFailure() {
            const now = Date.now();
            if (!this.failingSince) this.failingSince = now;
            const v = this.video;
            if (!this.unfiltered && now - this.failingSince >= FAIL_GRACE_MS && !v.paused && !v.ended) {
                this.releaseVideo('failed');
            }
        }

        destroy() {
            this.video.removeAttribute(UNFILTERED);
            for (const fn of this.cleanup) fn();
            visibility.unobserve(this.video);
            sizes.unobserve(this.video);
            this.canvas.remove();
            for (const c of [this.canvas, this.work, this.shown]) IFS.releaseCanvas(c);
            players.delete(this.video);
        }

        // A new source: hidden and filtered again until its frames have been tried.
        reset() {
            if (this.unfiltered) {
                this.video.removeAttribute(UNFILTERED);
                this.lockPresentation();
                this.lastCss = null;
            }
            this.hasFrame = false;
            this.unreadable = false;
            this.unfiltered = false;
            this.failingSince = 0;
            this.posterUrl = null;
            this.render();
        }

        // Cover exactly the video's box.
        place() {
            const v = this.video;
            const c = this.canvas;
            if (this.unfiltered) {  // unfiltered video: no overlay
                if (this.lastCss !== 'none') {
                    c.style.cssText = 'display:none !important';
                    this.lastCss = 'none';
                }
                return false;
            }
            if (!c.isConnected || c.previousSibling !== v) v.after(c);
            const cs = getComputedStyle(v);
            if (cs.display === 'none' || !v.offsetParent && cs.position !== 'fixed') {
                if (this.lastCss !== 'none') {
                    c.style.cssText = 'display:none !important';
                    this.lastCss = 'none';
                }
                return false;
            }
            let left = v.offsetLeft, top = v.offsetTop, position = 'absolute';
            if (cs.position === 'fixed') {
                const r = v.getBoundingClientRect();
                left = r.left;
                top = r.top;
                position = 'fixed';
            }
            const css =
                `display:block !important; position:${position} !important; left:${left}px !important;` +
                `top:${top}px !important; width:${v.offsetWidth}px !important; height:${v.offsetHeight}px !important;` +
                'margin:0 !important; padding:0 !important; border:0 !important; transform:none !important;' +
                'max-width:none !important; max-height:none !important; opacity:1 !important;' +
                'visibility:visible !important; background:#000 !important; box-sizing:border-box !important;' +
                `border-radius:${cs.borderRadius} !important; z-index:${cs.zIndex} !important;` +
                `pointer-events:${this.interactive ? 'auto' : 'none'} !important;` +
                (this.interactive ? 'cursor:pointer !important;' : '');
            if (css !== this.lastCss) {
                c.style.cssText = css;
                this.lastCss = css;
            }
            return true;
        }

        // Draw `source` (a checked picture) into the overlay like the video would (object-fit).
        draw(source) {
            if (!this.place()) return;
            const v = this.video;
            const dpr = window.devicePixelRatio || 1;
            const W = Math.max(1, Math.round(v.offsetWidth * dpr));
            const H = Math.max(1, Math.round(v.offsetHeight * dpr));
            const c = this.canvas;
            if (c.width !== W || c.height !== H) {
                c.width = W;
                c.height = H;
            }
            const ctx = this.ctx;
            ctx.fillStyle = '#000';
            ctx.fillRect(0, 0, W, H);
            if (source) {
                const sw = source.width, sh = source.height;
                const fit = getComputedStyle(v).objectFit;
                let dw = W, dh = H;
                if (fit !== 'fill') {
                    let s = fit === 'cover' ? Math.max(W / sw, H / sh) : Math.min(W / sw, H / sh);
                    if (fit === 'none' || (fit === 'scale-down' && s > 1)) s = Math.min(s, dpr);
                    dw = sw * s;
                    dh = sh * s;
                }
                ctx.drawImage(source, (W - dw) / 2, (H - dh) / 2, dw, dh);
            }
            if (this.interactive && v.paused) this.drawPlay();
        }

        drawPlay() {
            const ctx = this.ctx, W = this.canvas.width, H = this.canvas.height;
            const r = Math.min(W, H) / 8;
            ctx.fillStyle = 'rgba(0,0,0,0.5)';
            ctx.beginPath();
            ctx.arc(W / 2, H / 2, r, 0, Math.PI * 2);
            ctx.fill();
            ctx.fillStyle = '#fff';
            ctx.beginPath();
            ctx.moveTo(W / 2 - r * 0.35, H / 2 - r * 0.5);
            ctx.lineTo(W / 2 - r * 0.35, H / 2 + r * 0.5);
            ctx.lineTo(W / 2 + r * 0.55, H / 2);
            ctx.closePath();
            ctx.fill();
        }

        redraw() {
            this.draw(this.hasFrame ? this.shown : this.posterImage || null);
        }

        async showPoster() {
            const raw = this.video.getAttribute('poster');
            const url = raw ? new URL(raw, document.baseURI).href : '';
            if (url === this.posterUrl) return this.redraw();
            this.posterUrl = url;
            this.posterImage = null;
            if (!url) return this.redraw();
            const round = IFS.newRound(this.video, 'poster');
            const r = await IFS.checkUrl(url);
            if (!IFS.isCurrent(this.video, round, 'poster') || this.hasFrame || r.failed) {
                if (r.failed) this.posterUrl = null;  // try again on the next render
                return;
            }
            try {
                // Only drawn, never read: no CORS needed for the original.
                this.posterImage = await IFS.loadImage(r.dataUrl || url, false);
            } catch {
                return;
            }
            if (IFS.isCurrent(this.video, round, 'poster') && !this.hasFrame) this.redraw();
        }

        async render() {
            if (this.busy || this.unreadable || !IFS.enabled || !players.has(this.video)) return;
            const v = this.video;
            if (v.readyState < 2 || !v.videoWidth) {
                if (this.unfiltered) return;
                if (!this.hasFrame) return this.showPoster();
                return this.redraw();
            }
            if (this.unfiltered) {  // released because checks failed: only probe now and then
                const now = Date.now();
                if (!this.visible || now - this.lastProbe < PROBE_MS) return;
                this.lastProbe = now;
            } else if (!this.visible && this.hasFrame) {
                return;
            }
            this.busy = true;
            try {
                const dpr = window.devicePixelRatio || 1;
                // ≤768: the engine's input size, so checkCanvas uses this canvas as is (no
                // per-frame copy — a new canvas every frame adds up fast on iOS).
                const max = Math.min(768, Math.max(v.offsetWidth, v.offsetHeight, 160) * dpr);
                const size = IFS.fit(v.videoWidth, v.videoHeight, max);
                const work = this.work;
                if (work.width !== size.w || work.height !== size.h) {
                    work.width = size.w;
                    work.height = size.h;
                }
                const wctx = work.getContext('2d');
                wctx.drawImage(v, 0, 0, size.w, size.h);
                let r;
                try {
                    r = await IFS.checkCanvas(work, { mode: 'fast' });
                } catch (error) {
                    // Cross-origin without CORS, or DRM: we can't see the frames, so this video
                    // can't be filtered. Play it as is. Any other error (timeout…): a failed
                    // check, like r.failed below.
                    if (error && error.name === 'SecurityError') this.releaseVideo('unreadable');
                    else this.noteFailure();
                    return;
                }
                if (r.failed) {  // until released, keep showing the last checked frame
                    this.noteFailure();
                    return;
                }
                this.failingSince = 0;
                if (r.mask) {
                    IFS.paintMask(wctx, r.mask, size.w, size.h);
                } else if (r.filteredImageUrl) {
                    wctx.drawImage(await IFS.loadImage(r.filteredImageUrl, false), 0, 0, size.w, size.h);
                }
                // `work` now holds a checked frame: keep it and show it.
                const shown = this.shown;
                if (shown.width !== size.w || shown.height !== size.h) {
                    shown.width = size.w;
                    shown.height = size.h;
                }
                shown.getContext('2d').drawImage(work, 0, 0);
                this.hasFrame = true;
                if (this.unfiltered && !this.unreadable) this.resumeFiltering();
                this.draw(shown);
            } finally {
                this.busy = false;
            }
        }

        loop() {
            if (this.looping || this.unreadable) return;
            this.looping = true;
            const v = this.video;
            const step = () => {
                if (!players.has(v) || !IFS.enabled || v.paused || v.ended || this.unreadable) {
                    this.looping = false;
                    this.render();
                    return;
                }
                if (this.visible && !this.busy) this.render();
                if (v.requestVideoFrameCallback) v.requestVideoFrameCallback(step);
                else requestAnimationFrame(step);
            };
            step();
        }
    }

    function adopt(video) {
        if (!IFS.enabled || players.has(video) || !video.isConnected) return;
        players.set(video, new Player(video));
    }

    function scan(root) {
        for (const v of root.querySelectorAll('video')) adopt(v);
    }

    IFS.addModule({
        scanRoot: scan,

        onMutations(added, attrs) {
            if (!IFS.enabled) return;
            for (const n of added) {
                if (n.tagName === 'VIDEO') adopt(n);
                else for (const v of n.querySelectorAll('video')) adopt(v);
            }
            for (const r of attrs) {
                const p = players.get(r.target);
                if (p && r.attributeName === 'poster' && !p.hasFrame) {
                    p.posterUrl = null;
                    p.render();
                }
                if (p && r.attributeName === 'src') p.reset();
            }
        },

        tick() {
            for (const [video, p] of players) {
                if (!video.isConnected) p.destroy();
                else if (!p.busy) p.place();
            }
            if (IFS.enabled) for (const root of IFS.allRoots()) scan(root);
        },

        setEnabled(on) {
            if (!on) for (const p of [...players.values()]) p.destroy();
        }
    });
})();
