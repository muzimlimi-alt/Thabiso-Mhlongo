/* Google Calendar connection (docs-internal/google-calendar.md): the Bookings > Calendar > Settings card (OAuth client ID + secret, Connect Google, Test connection, Disconnect) and the
   status strip on the admin Calendar. Loaded after js/admin/system-settings.js, which calls window.loadGoogleCalendarCard() once the settings are loaded, and wraps
   window.calM365Init so the strip refreshes whenever the calendar opens.

   What a person may do is decided by the server (administrator only); hiding the card and buttons here only avoids offering what would be refused.
   Everything that comes from Google (the account address, error text) is untrusted: it is only ever put on the page with textContent. */
(function () {
    'use strict';
    var API = '/api/admin/google-calendar';
    var status = null;     // the last GET /api/admin/google-calendar
    var busy = false;
    var CLIENT_ID_RE = /^\d{6,}-[a-z0-9_-]{8,}\.apps\.googleusercontent\.com$/i;

    function $(id) { return document.getElementById(id); }
    function isAdmin() { return window.currentUserRole === 'administrator'; }
    function notify(kind, a, b) { var n = window.notificationService; if (n && n[kind]) { if (b === undefined) n[kind](a); else n[kind](a, b); } }
    function call(method, url, body) {
        return fetch(url, { method: method, headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined, credentials: 'same-origin', cache: 'no-store' })
            .then(function (r) { return r.json().catch(function () { return {}; }).then(function (d) { d._status = r.status; return d; }); });
    }
    function when(iso) { var t = Date.parse(iso); return isNaN(t) ? 'earlier' : new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }); }

    function ago(iso) {
        var s = Math.round((Date.now() - Date.parse(iso)) / 1000);
        if (!iso || isNaN(s)) return 'never';
        if (s < 45) return 'just now';
        if (s < 3600) return Math.max(1, Math.round(s / 60)) + ' min ago';
        if (s < 86400) return Math.round(s / 3600) + ' h ago';
        return Math.round(s / 86400) + ' days ago';
    }
    var DOUBLE_ENTRY = "Both Google Calendar and Microsoft 365 sharing are switched on, so each confirmed booking and public event is copied to BOTH calendars. That is fine if they are separate calendars for different people; if anyone views both together (for example both added to one phone calendar), bookings will appear twice. Consider keeping just one of them switched on.";
    function canSync() { return window.currentUserRole === 'administrator' || window.currentUserRole === 'manager'; }
    // How the last syncs went, in the words the server recorded (plain language, no credentials).
    function syncSentence(s) {
        var y = s && s.sync;
        if (!y) return '';
        if (y.healthy === false && y.lastError) return ' Problem: ' + y.lastError + (y.lastOkAt ? ' Last good sync ' + ago(y.lastOkAt) + '.' : '');
        return y.lastOkAt ? ' Google was last reached ' + ago(y.lastOkAt) + '.' : '';
    }

    /* ---- wording ---- */
    // What the page says after Google sends the administrator back (the server redirects with one word from a fixed list).
    var OUTCOMES = {
        connected: 'Google Calendar is connected.',
        state: 'That Google sign-in could not be confirmed: the link had expired (it lasts ten minutes) or had already been used. Press "Connect Google" again.',
        denied: 'Access was not granted on the Google screen, so nothing was connected.',
        google: 'Google did not complete the sign-in. Please try again.',
        exchange: 'Google would not accept the sign-in. Check the client ID and secret, then try again.',
        no_refresh_token: 'Google did not give the website lasting access. Remove the website at myaccount.google.com/permissions, then connect again.',
        client: 'Google rejected the client ID or client secret. Copy them again from Google Cloud > APIs & Services > Credentials.',
        redirect: 'Google does not know the redirect address shown in the card. Add it under "Authorized redirect URIs" on the OAuth client in Google Cloud, wait a minute, then connect again.',
        api: 'The Google Calendar API is switched off for this Google Cloud project. Enable it under APIs & Services > Library > Google Calendar API, then connect again.',
        permission: 'That Google account cannot change its calendar. Sign in with the account that owns it.',
        calendar: 'Connected to Google, but its calendar could not be read. Please try again.',
        auth: 'Google refused the sign-in. Please try again.',
        connection: 'Could not reach Google. Check the server\'s internet access and try again.',
        throttled: 'Google asked us to slow down. Try again in a minute.',
        server: 'Google had a temporary problem. Try again in a minute.',
        internal: 'Something went wrong on the server. Please try again.'
    };
    function statusText(s) {
        if (!s) return 'The Google Calendar status could not be loaded. Reload the page.';
        if (s.problems && s.problems.length) return s.problems.join('. ') + '.';
        if (s.state === 'connected') {
            if (s.tokenSource === 'environment') return 'Connected using the credentials supplied by the server environment. Press "Reconnect Google" to replace them with a sign-in saved here.';
            return 'Connected' + (s.account ? ' as ' + s.account : '') + (s.connectedAt ? ' since ' + when(s.connectedAt) : '') + '. Bookings and public events are kept in step with this calendar.' + syncSentence(s);
        }
        if (s.state === 'incomplete') {
            return s.secretSet ? 'The OAuth client is saved but Google is not connected yet. Press "Connect Google" and sign in with the Google account that owns the calendar.'
                : 'The client secret is missing. Enter it and press "Save & connect Google".';
        }
        return 'Not set up. Enter the OAuth client from your Google Cloud project and press "Save & connect Google". The one-time Google Cloud steps are under About.';
    }

    /* ---- the Bookings > Calendar > Settings card ---- */
    function fieldError(id, msg) { var e = $(id); if (e) { e.textContent = msg || ''; e.style.display = msg ? 'block' : 'none'; } }
    function result(text, kind) {
        var el = $('stGoogleResult');
        if (!el) return;
        el.textContent = text || '';
        el.style.color = kind === 'ok' ? 'var(--atl-sage)' : kind === 'bad' ? 'var(--atl-clay)' : '';
    }
    function renderCard(s) {
        var card = $('stGoogleCard');
        if (!card) return;
        if (!isAdmin() || !s || s.canManage === false) { card.style.display = 'none'; return; }
        card.style.display = '';
        $('stGoogleStatus').textContent = statusText(s);
        $('stGoogleStatus').style.color = (s.problems && s.problems.length) || (s.sync && s.sync.healthy === false && s.state === 'connected') ? 'var(--atl-clay)' : '';
        $('stGoogleClientId').value = s.clientId || '';
        // Never render a secret - only a masked hint so the administrator knows one is saved (blank = keep it)
        var secret = $('stGoogleSecret');
        secret.value = '';
        secret.setAttribute('placeholder', s.secretSet ? '••••••••  (saved — leave blank to keep)' : 'GOCSPX-…');
        $('stGoogleRedirect').value = s.redirectUri || '';
        renderButtons(s);
    }
    // The buttons only (never the fields: a failed save must not wipe what the administrator typed).
    function renderButtons(s) {
        if (!$('stGoogleCard') || !s) return;
        var label = s.state === 'connected' ? 'Reconnect Google' : (s.state === 'incomplete' && s.secretSet ? 'Connect Google' : 'Save & connect Google');
        $('stGoogleConnectBtn').querySelector('span').textContent = label;
        $('stGoogleConnectBtn').disabled = busy;
        $('stGoogleTestBtn').disabled = busy || s.state === 'none';
        $('stGoogleDisconnectBtn').disabled = busy || s.tokenSource !== 'settings';
    }
    function setBusy(on) {
        busy = on;
        renderButtons(status);
    }
    window.loadGoogleCalendarCard = function () {
        if (!$('stGoogleCard') || !isAdmin()) return Promise.resolve();
        return call('GET', API).then(function (d) {
            if (d && d.success) { status = d; renderCard(d); renderStrip(d); }
            else if (d && d._status === 403) { $('stGoogleCard').style.display = 'none'; }
            else { $('stGoogleCard').style.display = ''; $('stGoogleStatus').textContent = statusText(null); }
        }).catch(function () { $('stGoogleCard').style.display = ''; $('stGoogleStatus').textContent = statusText(null); });
    };

    function onConnect() {
        if (busy) return;
        var id = $('stGoogleClientId').value.trim();
        var secret = $('stGoogleSecret').value;   // native value: exactly as typed
        fieldError('errStGoogleClient', ''); fieldError('errStGoogleSecret', ''); result('');
        var bad = false;
        var savedId = status && status.clientId ? status.clientId : '';
        if (!id && !savedId) { fieldError('errStGoogleClient', 'Enter the OAuth client ID.'); bad = true; }
        else if (id && !CLIENT_ID_RE.test(id)) { fieldError('errStGoogleClient', 'That does not look like an OAuth client ID. It ends in .apps.googleusercontent.com.'); bad = true; }
        if (secret && /^[[{]/.test(secret.trim())) { fieldError('errStGoogleSecret', 'Paste only the client secret, not the downloaded JSON file.'); bad = true; }
        else if (secret && (/\s/.test(secret) || secret.length < 8)) { fieldError('errStGoogleSecret', 'The client secret has no spaces or line breaks.'); bad = true; }
        if (bad) { notify('showError', 'Please fix the highlighted fields.'); return; }

        var changed = (id && id.toLowerCase() !== savedId.toLowerCase()) || !!secret;
        setBusy(true);
        result('Opening Google…');
        var step = changed ? call('PUT', API + '/credentials', { clientId: id || savedId, clientSecret: secret }) : Promise.resolve({ success: true });
        step.then(function (d) {
            if (!d.success) { result(d.message || 'The Google settings were not saved.', 'bad'); notify('showError', d.message || 'The Google settings were not saved.'); setBusy(false); return null; }
            if (changed && d.state) status = Object.assign({}, status, d);   // saved: the next render shows it; Google is opened right away
            return call('POST', API + '/connect');
        }).then(function (c) {
            if (c === null) return;
            if (c && c.success && c.url) { window.location.assign(c.url); return; }   // the Google consent screen; Google sends the browser back to the admin
            result((c && c.message) || 'Could not start the Google sign-in.', 'bad');
            notify('showError', (c && c.message) || 'Could not start the Google sign-in.');
            setBusy(false);
        }).catch(function () { result('Could not reach the server. Please try again.', 'bad'); setBusy(false); });
    }

    function onTest() {
        if (busy) return;
        var btn = $('stGoogleTestBtn'), orig = btn.innerHTML;
        setBusy(true);
        btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Testing...';
        result('');
        call('POST', API + '/test').then(function (d) {
            if (!d.success) { result(d.message || 'The check could not run.', 'bad'); return; }
            var lines = (d.steps || []).map(function (s) { return (s.ok ? '✓ ' : '✗ ') + s.label + ': ' + s.message; });
            result(lines.join('\n'), d.ok ? 'ok' : 'bad');
        }).catch(function () { result('The check could not reach the server. Please try again.', 'bad'); })
            .then(function () { btn.innerHTML = orig; setBusy(false); });
    }

    function onDisconnect() {
        if (busy) return;
        var ask = window.notificationService && window.notificationService.showConfirm;
        var go = ask ? window.notificationService.showConfirm({ message: 'Disconnect Google Calendar? New and changed bookings and events will stop being copied to it, and its appointments will stop blocking times here. The client ID and secret stay saved, so you can reconnect in one click.', confirmText: 'Disconnect', isDestructive: true }) : Promise.resolve(window.confirm('Disconnect Google Calendar?'));
        Promise.resolve(go).then(function (yes) {
            if (!yes) return null;
            setBusy(true);
            return call('DELETE', API);
        }).then(function (d) {
            if (d === null || d === undefined) return;
            if (!d.success) { result(d.message || 'Could not disconnect.', 'bad'); return; }
            status = Object.assign({}, status, d); renderCard(status); renderStrip(status);
            result(d.stillConnectedViaEnvironment ? 'The saved sign-in was removed. The server still has its own Google sign-in in its environment settings, so the calendar stays connected through that.' : (d.revoked ? 'Disconnected, and Google was asked to revoke the website’s access.' : 'Disconnected.'), 'ok');
        }).catch(function () { result('Could not reach the server. Please try again.', 'bad'); })
            .then(function () { setBusy(false); });
    }

    function onCopy() {
        var v = $('stGoogleRedirect').value;
        if (!v) return;
        var done = function () { notify('showSuccess', 'Redirect address copied.'); };
        if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(v).then(done, function () { fallbackCopy(done); });
        else fallbackCopy(done);
    }
    function fallbackCopy(done) {
        var el = $('stGoogleRedirect');
        el.focus(); el.select();
        try { if (document.execCommand('copy')) done(); } catch (e) { /* the box stays selected for ctrl+C */ }
    }

    /* ---- the Calendar strip ---- */
    function renderStrip(s) {
        var strip = $('calGoogleStrip');
        if (!strip || !s) return;
        var admin = isAdmin();
        var connected = s.state === 'connected';
        strip.hidden = false;
        var failing = connected && !!s.sync && s.sync.healthy === false && !!s.sync.lastError;
        strip.className = 'cal-m365-strip cal-m365-strip--' + (failing ? 'bad' : connected ? (s.doubleEntryRisk ? 'warn' : 'ok') : (s.state === 'incomplete' ? 'warn' : 'off'));
        var text;
        if (failing) text = "Google Calendar: can't sync right now \u2014 " + s.sync.lastError + (s.sync.lastOkAt ? ' Last good sync ' + ago(s.sync.lastOkAt) + '.' : '');
        else if (connected) text = 'Google Calendar: connected' + (s.account ? ' as ' + s.account : '') + (s.sync && s.sync.lastOkAt ? ' \u00b7 read ' + ago(s.sync.lastOkAt) : '') + '. Bookings and public events are kept in step with it.';
        else if (s.state === 'incomplete') text = 'Google Calendar: set up but not connected. Bookings and events are not being copied to it.' + (admin ? '' : ' An administrator needs to finish connecting it.');
        else text = 'Google Calendar is not connected. Bookings and events are not copied to it, and its appointments do not block times here.' + (admin ? '' : ' An administrator can connect it.');
        $('calGoogleText').textContent = text;
        var warn = $('calGoogleWarn');
        if (warn) { warn.hidden = !(connected && s.doubleEntryRisk); warn.textContent = connected && s.doubleEntryRisk ? DOUBLE_ENTRY : ''; }
        var runBtn = $('calGoogleRun');
        if (runBtn) runBtn.hidden = !(connected && canSync());
        var fw = $('calGoogleFilterWrap');
        if (fw) {
            fw.hidden = !connected;
            if (!connected && $('calGoogleFilter') && $('calGoogleFilter').value !== 'all') { $('calGoogleFilter').value = 'all'; applyGoogleFilter('all'); }
        }
        var btn = $('calGoogleSetup');
        btn.hidden = !admin;
        var tabBtn = $('calSettingsTabBtn');   // the Settings tab is for administrators only
        if (tabBtn) tabBtn.style.display = admin ? '' : 'none';
        btn.querySelector('span').textContent = connected ? 'Settings' : (s.state === 'none' ? 'Set up' : 'Connect');
    }
    function loadStrip() {
        if (!$('calGoogleStrip') || !window.currentUserRole) return Promise.resolve();
        return call('GET', API).then(function (d) {
            if (d && d.success) { status = Object.assign({}, status, d); renderStrip(d); renderButtons(status); }
        }).catch(function () { /* the calendar works without it */ });
    }
    // "Sync now": read Google's calendar into the website right away (the same pull that runs every 15 minutes).
    function onRunNow() {
        var btn = $('calGoogleRun');
        if (!btn || btn.disabled) return;
        var orig = btn.innerHTML;
        btn.disabled = true;
        btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin" aria-hidden="true"></i> Syncing\u2026';
        call('POST', API + '/sync').then(function (d) {
            if (d && d.success && d.ok) {
                notify('showSuccess', 'Google Calendar was read just now.');
                if (typeof adminCalendar !== 'undefined' && adminCalendar) adminCalendar.refetchEvents();
            } else notify('showError', 'Google Calendar sync', (d && d.message) || 'The sync could not be run.');
        }).catch(function () { notify('showError', 'Google Calendar sync', 'Could not reach the server. Please try again.'); })
            .then(function () { btn.disabled = false; btn.innerHTML = orig; return loadStrip(); });
    }

    // The Google filter: every booking / public event is marked by calGoogleBadge; CSS hides the ones that do not match.
    function applyGoogleFilter(mode) {
        var el = $('calendar');
        if (!el) return;
        el.classList.remove('fc-cal--g-on', 'fc-cal--g-off');
        if (mode === 'on' || mode === 'off') el.classList.add('fc-cal--g-' + mode);
    }
    window.calGoogleBadge = function (arg, props) {
        if (props.type !== 'booking' && props.type !== 'public_event') return;
        arg.el.classList.add(props.isCalSynced ? 'fc-event--gcal-yes' : 'fc-event--gcal-no');
    };

    function openSettings() {
        if (window.admNav) window.admNav.go('calendarAdmin', { tab: 'calPanelSettings' });
        setTimeout(function () {
            var card = $('stGoogleCard');
            if (!card) return;
            window.loadGoogleCalendarCard();
            if (card.scrollIntoView) card.scrollIntoView({ block: 'start', behavior: 'smooth' });
        }, 400);
    }

    /* ---- coming back from Google ---- */
    function handleReturn() {
        var m = /[?&]google=([a-z_]+)/.exec(window.location.search || '');
        if (!m) return;
        var outcome = m[1];
        try { window.history.replaceState({}, '', window.location.pathname + (window.location.search || '').replace(/([?&])google=[a-z_]+&?/, '$1').replace(/[?&]$/, '') + (window.location.hash || '')); } catch (e) { /* cosmetic */ }
        var waited = 0;
        var timer = setInterval(function () {
            waited += 300;
            if (waited > 30000) { clearInterval(timer); return; }
            if (typeof window.switchTab !== 'function' || !window.currentUserRole) return;   // still loading, or signing in
            clearInterval(timer);
            var sentence = OUTCOMES[outcome] || OUTCOMES.google;
            window.admNav.go('calendarAdmin', { tab: 'calPanelSettings' });
            setTimeout(function () {
                window.loadGoogleCalendarCard().then(function () {
                    result(sentence, outcome === 'connected' ? 'ok' : 'bad');
                    var card = $('stGoogleCard');
                    if (card && card.scrollIntoView) card.scrollIntoView({ block: 'start', behavior: 'smooth' });
                });
                if (outcome === 'connected') notify('showSuccess', sentence); else notify('showError', 'Google Calendar was not connected', sentence);
            }, 400);
        }, 300);
    }

    /* ---- wiring ---- */
    document.addEventListener('click', function (ev) {
        var t = ev.target && ev.target.closest ? ev.target.closest('#stGoogleConnectBtn, #stGoogleTestBtn, #stGoogleDisconnectBtn, #stGoogleCopyBtn, #calGoogleSetup, #calGoogleRun') : null;
        if (!t) return;
        if (t.id === 'stGoogleConnectBtn') onConnect();
        else if (t.id === 'stGoogleTestBtn') onTest();
        else if (t.id === 'stGoogleDisconnectBtn') onDisconnect();
        else if (t.id === 'stGoogleCopyBtn') onCopy();
        else if (t.id === 'calGoogleSetup') openSettings();
        else if (t.id === 'calGoogleRun') onRunNow();
    });
    document.addEventListener('change', function (ev) { if (ev.target && ev.target.id === 'calGoogleFilter') applyGoogleFilter(ev.target.value); });
    var prevInit = window.calM365Init;
    window.calM365Init = function () {
        var r = typeof prevInit === 'function' ? prevInit.apply(this, arguments) : undefined;
        loadStrip();
        if (isAdmin()) window.loadGoogleCalendarCard();   // the Settings tab's card lives on this page now
        return r;
    };
    setInterval(function () { var s = $('calGoogleStrip'); if (s && s.offsetParent !== null && document.visibilityState === 'visible') loadStrip(); }, 60000);
    window.calGoogleRefreshStrip = loadStrip;
    handleReturn();
}());
