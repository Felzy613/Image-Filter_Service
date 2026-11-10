// Image Filter Service - Popup Script
// Three screens (main, excluded websites, activity), one `state` object, one render function
// per area. The background page owns the real settings; this only shows and changes them.

(function() {
    'use strict';

    // Every element with an id, by id (el.heroTitle, el['screen-main']…).
    const el = Object.fromEntries(
        Array.from(document.querySelectorAll('[id]'), node => [node.id, node])
    );

    const state = {
        loadFailed: false,
        configLoaded: false,
        isIos: false,            // iPhone/iPad: has an off switch, no password
        enabled: true,           // always true on the Mac
        engine: 'server',        // 'device' on iOS, 'server' (local Python server) on the Mac
        engineOk: null,          // null until the first check answers
        passwordRequired: false, // true on the Mac
        passwordSet: false,
        excludedSites: [],
        currentHost: '',         // hostname of the active tab ('' for non-web pages)
        stats: null
    };

    // Focus rings are for keyboard use (see body.keyboard in the CSS): Safari focuses the first
    // control when the popup opens, which would draw a ring on a row nobody touched.
    document.addEventListener('keydown', () => document.body.classList.add('keyboard'), { once: true });

    // --- Small helpers ------------------------------------------------------------

    // Only write text that changed: the status card is a live region, and rewriting the same
    // text on every 10 s check can make a screen reader announce it again.
    function setText(node, text) {
        if (node.textContent !== text) node.textContent = text;
    }

    let toastTimer = null;
    function toast(text, kind = 'success') {
        clearTimeout(toastTimer);
        el.toast.hidden = true;
        void el.toast.offsetWidth;  // restart the entrance animation if one is already showing
        el.toast.textContent = text;
        el.toast.dataset.kind = kind;
        el.toast.hidden = false;
        toastTimer = setTimeout(() => { el.toast.hidden = true; }, kind === 'error' ? 5000 : 2800);
    }

    function setFormError(node, message) {
        node.textContent = message || '';
        node.hidden = !message;
    }

    // --- Screens ------------------------------------------------------------------

    const screens = {
        main: el['screen-main'],
        excluded: el['screen-excluded'],
        activity: el['screen-activity']
    };
    let opener = null;  // the row that opened the current sub-screen, so Back can return focus to it

    // Slides the screen in (from the right going forward, from the left going back). The
    // animation class comes off when it ends so its compositing hints don't linger. Only this
    // screen's own end counts (animations inside it bubble an animationend too), and a timer
    // backs it up because with Reduce Motion there is no animation and so no animationend.
    let slideCount = 0;
    function showScreen(name, direction = 'forward') {
        for (const [key, node] of Object.entries(screens)) node.hidden = key !== name;
        const screen = screens[name];
        const slide = direction === 'back' ? 'slide-back' : 'slide-forward';
        const id = String(++slideCount);
        screen.classList.remove('slide-forward', 'slide-back');
        void screen.offsetWidth;  // lets the animation restart if it was still running
        screen.classList.add(slide);
        screen.dataset.slide = id;
        const clear = () => {
            clearTimeout(timer);
            screen.removeEventListener('animationend', onEnd);
            if (screen.dataset.slide === id) screen.classList.remove(slide);  // not a newer slide's
        };
        const onEnd = event => { if (event.target === screen) clear(); };
        const timer = setTimeout(clear, 400);
        screen.addEventListener('animationend', onEnd);
        const title = screen.querySelector('[data-title]');
        if (title) title.focus({ preventScroll: true });
        if (name === 'activity') loadStats();
    }

    function goTo(name, trigger) {
        opener = trigger;
        showScreen(name, 'forward');
    }

    function goBack() {
        showScreen('main', 'back');
        if (opener) opener.focus({ preventScroll: true });
    }

    el.goExcluded.addEventListener('click', () => goTo('excluded', el.goExcluded));
    el.goActivity.addEventListener('click', () => goTo('activity', el.goActivity));
    document.querySelectorAll('[data-back]').forEach(button => button.addEventListener('click', goBack));

    // --- Prompt (password / confirmation) -----------------------------------------
    // On the Mac, excluding a website needs a password. The background checks it (this popup
    // only collects it): see background.js. openDialog() resolves true once `submit` reports
    // success, false if the person cancels. With no `fields` it is a plain confirmation.

    function describeError(response) {
        switch (response && response.error) {
            case 'wrong-password': return 'Wrong password';
            case 'locked': {
                const minutes = Math.max(1, Math.ceil((response.retryAfterMs || 0) / 60000));
                return `Too many wrong attempts. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`;
            }
            case 'no-password': return 'Set a password first';
            case 'too-short': return `Use at least ${response.minLength || 6} characters`;
            case 'unavailable': return 'The password could not be saved. Try again.';
            default: return 'Could not save';
        }
    }

    function openDialog({ title, text, fields = [], confirmLabel, danger, submit }) {
        return new Promise(resolve => {
            const returnFocusTo = document.activeElement;
            el.dialogTitle.textContent = title;
            el.dialogText.textContent = text || '';
            el.dialogText.hidden = !text;
            el.dialogOk.textContent = confirmLabel || 'OK';
            el.dialogOk.className = 'btn ' + (danger ? 'btn-danger' : 'btn-primary');
            setFormError(el.dialogError, '');
            el.dialogFields.textContent = '';

            const inputs = fields.map(({ key, label, hint, isNew }) => {
                const group = document.createElement('div');
                group.className = 'form-group';
                const input = document.createElement('input');
                input.type = 'password';
                input.id = 'dialog-' + key;
                input.autocomplete = isNew ? 'new-password' : 'off';
                input.setAttribute('autocapitalize', 'off');
                input.setAttribute('autocorrect', 'off');
                const labelEl = document.createElement('label');
                labelEl.htmlFor = input.id;
                labelEl.textContent = label;
                group.append(labelEl, input);
                if (hint) {
                    const hintEl = document.createElement('p');
                    hintEl.className = 'field-hint';
                    hintEl.id = input.id + '-hint';
                    hintEl.textContent = hint;
                    input.setAttribute('aria-describedby', hintEl.id);
                    group.appendChild(hintEl);
                }
                el.dialogFields.appendChild(group);
                return { key, input };
            });

            el.app.inert = true;  // nothing behind the prompt can be reached while it is open
            el.dialog.hidden = false;
            (inputs.length ? inputs[0].input : el.dialogOk).focus();

            const close = result => {
                el.dialog.hidden = true;
                el.app.inert = false;
                el.dialogFields.textContent = '';  // drop what was typed
                el.dialogForm.onsubmit = null;
                el.dialogCancel.onclick = null;
                document.removeEventListener('keydown', onKey);
                if (returnFocusTo && returnFocusTo.isConnected) returnFocusTo.focus({ preventScroll: true });
                resolve(result);
            };
            const onKey = event => { if (event.key === 'Escape') close(false); };
            document.addEventListener('keydown', onKey);
            el.dialogCancel.onclick = () => close(false);

            el.dialogForm.onsubmit = async event => {
                event.preventDefault();
                const values = Object.fromEntries(inputs.map(({ key, input }) => [key, input.value]));
                el.dialogOk.disabled = true;
                try {
                    const result = await submit(values);
                    if (result.ok) {
                        close(true);
                        return;
                    }
                    setFormError(el.dialogError, result.error);
                    inputs.forEach(({ input }) => { input.value = ''; });
                    if (inputs.length) inputs[0].input.focus();
                } catch (error) {
                    console.error('Dialog failed:', error);
                    setFormError(el.dialogError, 'Something went wrong. Try again.');
                } finally {
                    el.dialogOk.disabled = false;
                }
            };
        });
    }

    // Create or change the exclusion password. Resolves with the new password once it is
    // saved (so the caller can use it straight away), or null if cancelled.
    async function openPasswordDialog(intro) {
        const changing = state.passwordSet;
        let saved = null;
        const ok = await openDialog({
            title: changing ? 'Change password' : 'Set a password',
            text: intro || (changing ? '' : 'You’ll need this password to stop filtering a website.'),
            fields: [
                ...(changing ? [{ key: 'current', label: 'Current password' }] : []),
                { key: 'password', label: 'New password', hint: 'At least 6 characters', isNew: true },
                { key: 'repeat', label: 'Repeat new password', isNew: true }
            ],
            confirmLabel: 'Save',
            submit: async ({ current, password, repeat }) => {
                if (password !== repeat) return { ok: false, error: 'The passwords don’t match' };
                const response = await browser.runtime.sendMessage({
                    action: 'setPassword', currentPassword: current, password
                });
                if (response && response.success) {
                    saved = password;
                    return { ok: true };
                }
                return { ok: false, error: describeError(response) };
            }
        });
        if (!ok) return null;
        state.passwordSet = true;
        renderPassword();
        toast('Password saved');
        return saved;
    }

    el.passwordButton.addEventListener('click', () => { openPasswordDialog(); });

    // --- Excluded websites --------------------------------------------------------
    // Same rules as normalizeSite() in background.js (which re-checks whatever we send):
    // "https://www.Example.com/path" -> "example.com"; '' if it isn't a hostname.
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
    const covers = (site, host) => host === site || host.endsWith('.' + site);

    // Returns the background's answer; `success === false` means it refused (wrong password…)
    // and the list is unchanged.
    async function saveExcluded(list, password) {
        const response = await browser.runtime.sendMessage({
            action: 'updateConfig', excludedSites: list, password: password
        });
        state.excludedSites = (response && response.excludedSites) || list;
        renderExcluded();
        renderSite();
        return response || { success: true };
    }

    // Adding a website: asks for the password first on the Mac, and on the very first use
    // there makes one on the spot and uses it. Resolves true if `list` was saved.
    // (iPhone/iPad have no password: it saves straight away.)
    async function saveExclusionWithPassword(list) {
        if (!state.passwordRequired) {
            await saveExcluded(list);
            return true;
        }
        if (!state.passwordSet) {
            const password = await openPasswordDialog(
                'Set a password first. You’ll need it whenever you stop filtering a website.');
            if (password === null) return false;
            const response = await saveExcluded(list, password);
            if (response.success === false) {
                toast(describeError(response), 'error');
                return false;
            }
            return true;
        }
        return openDialog({
            title: 'Password needed',
            text: 'Enter the password to stop filtering a website.',
            fields: [{ key: 'password', label: 'Password' }],
            confirmLabel: 'Exclude',
            submit: async ({ password }) => {
                const response = await saveExcluded(list, password);
                return response.success === false
                    ? { ok: false, error: describeError(response) }
                    : { ok: true };
            }
        });
    }

    el.siteToggle.addEventListener('change', async function() {
        const host = normalizeSite(state.currentHost);
        try {
            if (this.checked) {
                // Filtering back on removes every entry that covers this site (a parent domain
                // too), so the switch always does what it says. No password: it's stricter.
                await saveExcluded(state.excludedSites.filter(site => !covers(site, state.currentHost)));
                toast(`Filtering ${host} again`);
            } else {
                // Stay "on" until the exclusion is really saved (a password prompt may be
                // cancelled or refused), instead of flipping off and back.
                this.checked = true;
                if (await saveExclusionWithPassword([...state.excludedSites, host])) {
                    toast(`${host} won’t be filtered`);
                }
            }
        } catch (error) {
            console.error('Error updating excluded websites:', error);
            toast('Could not save', 'error');
        }
        renderSite();  // puts the switch back to "on" if it was cancelled or refused
    });

    el.excludeInput.addEventListener('input', () => setFormError(el.excludeError, ''));

    el.excludeForm.addEventListener('submit', async function(event) {
        event.preventDefault();
        const site = normalizeSite(el.excludeInput.value);
        if (!site) {
            setFormError(el.excludeError, 'Enter a website such as example.com');
            return;
        }
        const coveredBy = state.excludedSites.find(existing => covers(existing, site));
        if (coveredBy) {
            setFormError(el.excludeError, coveredBy === site
                ? `${site} is already excluded`
                : `${site} is already covered by ${coveredBy}`);
            return;
        }
        setFormError(el.excludeError, '');
        try {
            if (await saveExclusionWithPassword([...state.excludedSites, site])) {
                el.excludeInput.value = '';
                toast(`${site} won’t be filtered`);
            }
        } catch (error) {
            console.error('Error excluding website:', error);
            setFormError(el.excludeError, 'Could not save');
        }
    });

    // --- Rendering ----------------------------------------------------------------

    function renderHero() {
        let heroState, title, detail = '';
        if (state.loadFailed) {
            heroState = 'error';
            title = 'Couldn’t load settings';
            detail = 'Close this window and open it again.';
        } else if (!state.configLoaded) {
            heroState = 'checking';
            title = 'Checking…';
        } else if (state.isIos && !state.enabled) {
            heroState = 'off';
            title = 'Filtering is off';
            detail = 'Pictures are shown without filtering.';
        } else if (state.engineOk === null) {
            heroState = 'checking';
            title = 'Checking the filter…';
        } else if (!state.engineOk) {
            heroState = 'error';
            title = 'Filter not running';
            detail = state.isIos
                ? 'The on-device filter couldn’t start. Pictures stay hidden.'
                : 'The local filter isn’t responding. Pictures stay hidden until it’s back.';
        } else {
            heroState = 'on';
            title = 'Filtering is on';
            detail = state.isIos ? 'Running on this device' : 'Always on · local filter connected';
        }
        el.hero.dataset.state = heroState;
        setText(el.heroTitle, title);
        setText(el.heroDetail, detail);

        // The off switch is iPhone/iPad only; on the Mac filtering is always on.
        el.enableSwitch.hidden = !state.isIos || !state.configLoaded;
        el.enableToggle.checked = state.enabled;
    }

    function renderSite() {
        const host = state.currentHost;
        el.siteCard.dataset.empty = host ? 'false' : 'true';
        el.siteSwitch.hidden = !host;
        if (!host) {
            delete el.siteCard.dataset.filtered;
            el.siteHost.textContent = 'No website open';
            el.siteState.textContent = 'Open a website to choose whether its pictures are filtered.';
            return;
        }
        const coveredBy = state.excludedSites.find(site => covers(site, host));
        const first = host.replace(/^www\./, '').charAt(0);
        el.siteLetter.textContent = /[a-z0-9]/i.test(first) ? first : '•';
        el.siteCard.dataset.filtered = coveredBy ? 'false' : 'true';
        el.siteToggle.checked = !coveredBy;
        el.siteHost.textContent = host;
        el.siteState.textContent = !coveredBy
            ? 'Pictures are filtered'
            : coveredBy === normalizeSite(host)
                ? 'Not filtered'
                : `Not filtered · via ${coveredBy}`;
    }

    function renderExcluded() {
        const sites = state.excludedSites;
        el.excludedCount.textContent = sites.length ? String(sites.length) : 'None';

        el.excludedList.textContent = '';
        for (const site of sites) {
            const li = document.createElement('li');
            li.className = 'row';
            const name = document.createElement('span');
            name.className = 'row-text';
            const title = document.createElement('span');
            title.className = 'row-title';
            title.textContent = site;
            name.appendChild(title);
            li.appendChild(name);
            if (state.currentHost && covers(site, state.currentHost)) {
                const pill = document.createElement('span');
                pill.className = 'pill';
                pill.textContent = 'This site';
                li.appendChild(pill);
            }
            const remove = document.createElement('button');
            remove.type = 'button';
            remove.className = 'btn btn-quiet';
            remove.textContent = 'Remove';
            remove.setAttribute('aria-label', 'Remove ' + site + ' and filter it again');
            remove.addEventListener('click', async () => {
                try {
                    await saveExcluded(state.excludedSites.filter(s => s !== site));
                    toast(`Filtering ${site} again`);
                } catch (error) {
                    console.error('Error removing website:', error);
                    toast('Could not save', 'error');
                }
            });
            li.appendChild(remove);
            el.excludedList.appendChild(li);
        }
        el.excludedList.hidden = sites.length === 0;
        el.excludedEmpty.hidden = sites.length > 0;
    }

    function renderPassword() {
        el.passwordCard.hidden = !state.passwordRequired;
        if (!state.passwordRequired) return;
        el.passwordCard.dataset.set = state.passwordSet ? 'true' : 'false';
        el.passwordTitle.textContent = state.passwordSet ? 'Password' : 'Set a password';
        el.passwordState.textContent = state.passwordSet
            ? 'Needed to exclude a website'
            : 'Required before you can exclude a website';
        el.passwordButton.textContent = state.passwordSet ? 'Change' : 'Set password';
    }

    function renderStats() {
        const stats = state.stats || {};
        el.statProcessed.textContent = stats.processed || 0;
        el.statFiltered.textContent = stats.filtered || 0;
        el.statCached.textContent = stats.cached || 0;
        el.statFailed.textContent = stats.failed || 0;
        el.statFailed.dataset.alert = stats.failed > 0 ? 'true' : 'false';
        el.activityCount.textContent = stats.filtered ? `${stats.filtered} filtered` : '';

        const rows = [['Filter', state.engine === 'device'
            ? 'On this device' + (stats.delegate ? ` (${stats.delegate})` : '')
            : 'Local server']];
        if (stats.processed && stats.avgMs) rows.push(['Speed', `${Math.round(stats.avgMs)} ms per picture`]);
        if (stats.engineLoadMs) rows.push(['Started in', `${stats.engineLoadMs} ms`]);
        const factsKey = JSON.stringify(rows);
        if (factsKey !== el.facts.dataset.key) {  // rebuild only when it changed (polled every 5 s)
            el.facts.dataset.key = factsKey;
            el.facts.textContent = '';
            for (const [name, value] of rows) {
                const row = document.createElement('div');
                const dt = document.createElement('dt');
                dt.textContent = name;
                const dd = document.createElement('dd');
                dd.textContent = value;
                row.append(dt, dd);
                el.facts.appendChild(row);
            }
        }
        el.facts.hidden = false;
    }

    function renderAll() {
        renderHero();
        renderSite();
        renderExcluded();
        renderPassword();
        renderStats();
    }

    // --- Loading ------------------------------------------------------------------

    async function loadCurrentSite() {
        try {
            const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
            const url = tab && tab.url ? new URL(tab.url) : null;
            state.currentHost = url && /^https?:$/.test(url.protocol) ? url.hostname.toLowerCase() : '';
        } catch {
            state.currentHost = '';
        }
    }

    async function loadConfig() {
        try {
            const config = await browser.runtime.sendMessage({ action: 'getConfig' });
            if (!config) throw new Error('No answer from the background page');
            state.isIos = config.platform === 'ios';
            state.enabled = state.isIos ? config.isEnabled !== false : true;
            state.engine = config.engine === 'device' ? 'device' : 'server';
            state.passwordRequired = !!config.passwordRequired;
            state.passwordSet = !!config.passwordSet;
            state.excludedSites = Array.isArray(config.excludedSites) ? config.excludedSites : [];
            state.configLoaded = true;
        } catch (error) {
            console.error('Error loading config:', error);
            state.loadFailed = true;
        }
    }

    async function loadStats() {
        try {
            const stats = await browser.runtime.sendMessage({ action: 'getStats' });
            if (stats) {
                state.stats = stats;
                renderStats();
            }
        } catch (error) {
            console.error('Error loading stats:', error);
        }
    }

    // Can the filter run? (On iPhone this loads the on-device engine, so it is skipped while
    // filtering is switched off.)
    async function checkEngine() {
        if (!state.configLoaded || (state.isIos && !state.enabled)) return;
        try {
            const result = await browser.runtime.sendMessage({ action: 'checkServer' });
            state.engineOk = !!(result && result.connected);
            if (result && result.engine === 'device') state.engine = 'device';
        } catch (error) {
            console.error('Error checking the filter:', error);
            state.engineOk = false;
        }
        renderHero();
    }

    // --- Remaining controls -------------------------------------------------------

    el.enableToggle.addEventListener('change', async function() {
        const enabled = this.checked;
        try {
            await browser.runtime.sendMessage({ action: 'updateConfig', isEnabled: enabled });
            state.enabled = enabled;
            if (enabled) {
                state.engineOk = null;
                checkEngine();
            }
        } catch (error) {
            console.error('Error toggling service:', error);
            toast('Could not change filtering', 'error');
        }
        renderHero();
    });

    el.clearCache.addEventListener('click', async function() {
        const cleared = await openDialog({
            title: 'Clear the cache?',
            text: 'Pictures that were already checked will be checked again the next time they appear.',
            confirmLabel: 'Clear cache',
            danger: true,
            submit: async () => {
                await browser.runtime.sendMessage({ action: 'clearCache' });
                return { ok: true };
            }
        });
        if (cleared) {
            await loadStats();
            toast('Cache cleared');
        }
    });

    // The body stays blank (body.loading in the CSS) until the first answers are in, so the
    // popup opens already showing the real state instead of placeholders ("Checking…",
    // "None", "No website open") that change a moment later. Half a second at most: if the
    // background is slow, show what there is.
    let revealTimer = null;
    function reveal() {
        clearTimeout(revealTimer);
        if (!document.body.classList.contains('loading')) return;
        const body = screens.main.querySelector('.screen-body');
        body.classList.add('reveal');
        const clear = () => {
            clearTimeout(timer);
            body.removeEventListener('animationend', onEnd);
            body.classList.remove('reveal');
        };
        const onEnd = event => { if (event.target === body) clear(); };
        const timer = setTimeout(clear, 300);  // also covers Reduce Motion (no animationend)
        body.addEventListener('animationend', onEnd);
        document.body.classList.remove('loading');
    }

    async function initialize() {
        el.extensionVersion.textContent = 'v' + browser.runtime.getManifest().version;
        revealTimer = setTimeout(reveal, 500);
        renderAll();
        await Promise.all([loadCurrentSite(), loadConfig()]);
        renderAll();
        await Promise.all([loadStats(), checkEngine()]);
        reveal();

        // Keep the numbers and the status fresh while the popup is open.
        setInterval(() => { if (!document.hidden) loadStats(); }, 5000);
        setInterval(() => { if (!document.hidden) checkEngine(); }, 10000);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initialize);
    } else {
        initialize();
    }

})();
