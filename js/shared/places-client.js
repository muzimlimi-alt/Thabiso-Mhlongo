/*
 * Shared browser client for location search (2026-10 Places audit) - window.TMPlaces.
 *
 * Talks ONLY to this site's own server (lib/places.js behind /api/public/places/* and /api/admin/places/*),
 * never to Google directly: no Google script, no browser API key, nothing to "wait for" before a field works.
 *
 *   TMPlaces.newSessionToken()            - groups one search + its selection into a single Google billing session
 *   TMPlaces.attach(input, opts)          - turns a plain text <input> into an accessible venue-search combobox
 *   TMPlaces.detach(input)                - removes it again (listeners + dropdown); safe to call repeatedly
 *
 * attach() opts:
 *   endpoint      base URL, e.g. '/api/admin/places' (autocomplete + details are appended)
 *   detail        'full' (default: address, coordinates, map link) or 'basic' (name + address only - cheaper)
 *   onPlace(loc)  called with the standardised location once a suggestion is picked:
 *                 { placeId, name, formattedAddress, city, state, postalCode, country, countryCode, latitude, longitude, mapUrl }
 *   onInput(e)    called when the user types - the place they picked earlier no longer describes the field, so
 *                 callers clear whatever hidden place data they hold (prevents saving a stale place id/address).
 *   minChars      characters before searching (default 3)
 *
 * Manual entry always works: the field stays an ordinary text box, and when search is unavailable the
 * dropdown says so and the user simply keeps typing.
 */
(function (global) {
    'use strict';

    var STYLE_ID = 'tm-places-style';
    var uid = 0;
    var loggedCodes = {};
    var live = [];          // every attached controller - so ones whose input was re-rendered away get cleaned up

    // Drops controllers whose <input> is no longer in the page (e.g. the Deal View re-renders its "Link a venue"
    // row): removes their dropdown and window listeners instead of leaving them behind.
    function sweep() {
        live.slice().forEach(function (c) { if (!document.body.contains(c.input)) c.destroy(); });
    }

    function newSessionToken() {
        try { if (global.crypto && global.crypto.randomUUID) return global.crypto.randomUUID().replace(/-/g, ''); } catch (e) {}
        var s = '';
        for (var i = 0; i < 32; i++) s += Math.floor(Math.random() * 16).toString(16);
        return s;
    }

    function esc(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
    }

    // Plain-language message for a failed request; the precise cause is in the server log / the admin's
    // "Test Google Places" check, not shown to the person typing.
    function messageFor(status, body) {
        var code = body && body.error && body.error.code;
        if (code && !loggedCodes[code]) { loggedCodes[code] = 1; if (global.console) console.warn('[TMPlaces] location search failed: ' + code); }
        if (status === 401) return 'Your session has expired. Sign in again to search, or type the location manually.';
        if (status === 429 || code === 'QUOTA') return 'Too many searches just now. Type the location manually or try again shortly.';
        return 'Location search isn’t available right now. Type the location manually.';
    }

    function injectStyle() {
        if (document.getElementById(STYLE_ID)) return;
        var css =
            '.tm-places-dd{position:fixed;z-index:2147483000;max-height:280px;overflow-y:auto;margin:0;padding:4px 0;list-style:none;' +
            'background:var(--atl-surface,var(--atl-paper,#1b1b1b));color:var(--atl-ink,#eee);border:1px solid var(--atl-line,#333);' +
            'border-radius:8px;box-shadow:0 12px 28px rgba(0,0,0,.35);font-size:14px;line-height:1.35;}' +
            '.tm-places-dd[hidden]{display:none;}' +
            '.tm-places-opt{padding:9px 12px;cursor:pointer;display:flex;flex-direction:column;gap:2px;}' +
            '.tm-places-opt:hover,.tm-places-opt.is-active{background:var(--atl-surface2,rgba(255,255,255,.07));}' +
            '.tm-places-opt.is-active{outline:2px solid var(--atl-amber,#d4af37);outline-offset:-2px;}' +
            '.tm-places-main{font-weight:600;color:var(--atl-ink,#eee);}' +
            '.tm-places-sec{font-size:12px;color:var(--atl-muted,#9a9a9a);}' +
            '.tm-places-msg{padding:9px 12px;font-size:13px;color:var(--atl-muted,#9a9a9a);}' +
            '.tm-places-msg.is-warn{color:var(--atl-amber,#d4af37);}' +
            '.tm-places-foot{padding:6px 12px 4px;font-size:11px;color:var(--atl-muted,#8a8a8a);text-align:right;}';
        var el = document.createElement('style');
        el.id = STYLE_ID;
        el.textContent = css;
        document.head.appendChild(el);
    }

    function attach(input, opts) {
        if (!input || input.nodeType !== 1) return null;
        if (input._tmPlaces) return input._tmPlaces;      // already attached: never double-bind listeners
        opts = opts || {};
        injectStyle();
        sweep();

        var endpoint = (opts.endpoint || '/api/public/places').replace(/\/$/, '');
        var minChars = opts.minChars || 3;
        var id = 'tmPlaces' + (++uid);
        var dd = document.createElement('ul');
        dd.className = 'tm-places-dd';
        dd.id = id + '-list';
        dd.setAttribute('role', 'listbox');
        dd.hidden = true;
        document.body.appendChild(dd);

        var state = { token: newSessionToken(), timer: null, ctrl: null, seq: 0, items: [], active: -1, cache: {}, busy: false };

        var prevAttrs = {};
        ['role', 'aria-autocomplete', 'aria-expanded', 'aria-controls', 'autocomplete'].forEach(function (a) { prevAttrs[a] = input.getAttribute(a); });
        input.setAttribute('role', 'combobox');
        input.setAttribute('aria-autocomplete', 'list');
        input.setAttribute('aria-expanded', 'false');
        input.setAttribute('aria-controls', dd.id);
        input.setAttribute('autocomplete', 'off');

        function place() {
            if (!document.body.contains(input)) { api.destroy(); return; }   // field re-rendered away
            var r = input.getBoundingClientRect();
            if (!r.width && !r.height) { close(); return; }
            var below = window.innerHeight - r.bottom;
            dd.style.left = Math.round(r.left) + 'px';
            dd.style.width = Math.round(Math.max(r.width, 220)) + 'px';
            if (below < 200 && r.top > below) { dd.style.top = 'auto'; dd.style.bottom = Math.round(window.innerHeight - r.top + 4) + 'px'; }
            else { dd.style.bottom = 'auto'; dd.style.top = Math.round(r.bottom + 4) + 'px'; }
        }
        function open() { place(); dd.hidden = false; input.setAttribute('aria-expanded', 'true'); }
        function close() {
            dd.hidden = true; state.active = -1;
            input.setAttribute('aria-expanded', 'false'); input.removeAttribute('aria-activedescendant');
        }
        function message(text, warn) {
            state.items = []; state.active = -1;
            dd.innerHTML = '<li class="tm-places-msg' + (warn ? ' is-warn' : '') + '" role="presentation">' + text + '</li>';
            open();
        }
        function render(preds) {
            state.items = preds; state.active = -1;
            if (!preds.length) { message('No matching places. Keep typing, or enter the location manually.'); return; }
            dd.innerHTML = preds.map(function (p, i) {
                return '<li class="tm-places-opt" role="option" aria-selected="false" id="' + id + '-opt' + i + '" data-i="' + i + '">' +
                    '<span class="tm-places-main">' + esc(p.main_text || p.formatted_address) + '</span>' +
                    (p.secondary_text ? '<span class="tm-places-sec">' + esc(p.secondary_text) + '</span>' : '') + '</li>';
            }).join('') + '<li class="tm-places-foot" role="presentation">Powered by Google</li>';
            open();
        }
        function setActive(i) {
            var opts2 = dd.querySelectorAll('.tm-places-opt');
            if (!opts2.length) return;
            state.active = (i + opts2.length) % opts2.length;
            for (var k = 0; k < opts2.length; k++) {
                var on = k === state.active;
                opts2[k].classList.toggle('is-active', on);
                opts2[k].setAttribute('aria-selected', on ? 'true' : 'false');
            }
            input.setAttribute('aria-activedescendant', opts2[state.active].id);
            if (opts2[state.active].scrollIntoView) opts2[state.active].scrollIntoView({ block: 'nearest' });
        }

        function fetchJson(url) {
            if (state.ctrl) { try { state.ctrl.abort(); } catch (e) {} }
            state.ctrl = global.AbortController ? new AbortController() : null;
            // bypassInterceptor: failures are shown in the dropdown, not as an extra global error toast.
            // retry: false - the admin's global fetch wrapper (js/notificationService.js) otherwise retries a failed GET
            // three times with backoff: an unavailable search sat on "Searching..." for ~7 s and hit Google 4 times.
            return fetch(url, { credentials: 'same-origin', signal: state.ctrl ? state.ctrl.signal : undefined, bypassInterceptor: true, retry: false })
                .then(function (r) {
                    return r.json().catch(function () { return null; }).then(function (b) { return { status: r.status, ok: r.ok, body: b }; });
                });
        }

        function search(q) {
            var seq = ++state.seq;
            var key = q.toLowerCase();
            if (state.cache[key]) { render(state.cache[key]); return; }
            message('Searching…');
            fetchJson(endpoint + '/autocomplete?input=' + encodeURIComponent(q) + '&sessionToken=' + state.token)
                .then(function (r) {
                    if (seq !== state.seq) return;                  // the text has moved on
                    if (!r.ok || !r.body) { message(messageFor(r.status, r.body), true); return; }
                    var preds = r.body.predictions || [];
                    state.cache[key] = preds;
                    render(preds);
                })
                .catch(function (e) {
                    if (e && e.name === 'AbortError') return;
                    if (seq === state.seq) message(messageFor(0, null), true);
                });
        }

        function choose(i) {
            var p = state.items[i];
            if (!p) return;
            close();
            state.busy = true;
            input.value = p.main_text || p.formatted_address || input.value;   // programmatic: does not fire 'input'
            var seq = ++state.seq;
            message('Getting the address…');
            var url = endpoint + '/details?place_id=' + encodeURIComponent(p.place_id) + '&sessionToken=' + state.token +
                (opts.detail === 'basic' ? '&detail=basic' : '');
            state.token = newSessionToken();                    // the session ends with this selection
            fetchJson(url).then(function (r) {
                state.busy = false;
                if (seq !== state.seq) return;
                close();
                var loc = r.body && r.body.location;
                if (!r.ok || !loc) {
                    // Keep what was picked as plain text; nothing structured is saved. Tell the user once.
                    message(messageFor(r.status, r.body).replace('Type the location manually.', 'The name was kept; check the address before saving.'), true);
                    setTimeout(close, 4000);
                    return;
                }
                if (typeof opts.onPlace === 'function') opts.onPlace(loc);
            }).catch(function (e) {
                state.busy = false;
                if (e && e.name === 'AbortError') return;
                message(messageFor(0, null), true);
                setTimeout(close, 4000);
            });
        }

        function onInput(e) {
            if (typeof opts.onInput === 'function') opts.onInput(e);
            clearTimeout(state.timer);
            state.seq++;
            var q = input.value.replace(/\s+/g, ' ').trim();
            if (q.length < minChars) { close(); return; }
            state.timer = setTimeout(function () { search(q); }, 300);
        }
        function onKey(e) {
            var isOpen = !dd.hidden && state.items.length;
            if (e.key === 'ArrowDown') { if (isOpen) { e.preventDefault(); setActive(state.active + 1); } }
            else if (e.key === 'ArrowUp') { if (isOpen) { e.preventDefault(); setActive(state.active - 1); } }
            else if (e.key === 'Enter') {
                // With the list open, Enter picks the highlighted (else first) place and must not submit the form.
                if (isOpen) { e.preventDefault(); choose(state.active < 0 ? 0 : state.active); }
            }
            else if (e.key === 'Escape') { if (!dd.hidden) { e.preventDefault(); e.stopPropagation(); close(); } }
            else if (e.key === 'Tab') close();
        }
        function onBlur() { setTimeout(function () { if (document.activeElement !== input && !state.busy) close(); }, 150); }
        function onDown(e) {
            var li = e.target.closest ? e.target.closest('.tm-places-opt') : null;
            e.preventDefault();                                 // keep focus in the input
            if (li) choose(+li.getAttribute('data-i'));
        }
        function onViewport() { if (!dd.hidden) place(); }

        input.addEventListener('input', onInput);
        input.addEventListener('keydown', onKey);
        input.addEventListener('blur', onBlur);
        dd.addEventListener('mousedown', onDown);
        window.addEventListener('resize', onViewport);
        window.addEventListener('scroll', onViewport, true);   // capture: drawers scroll inside their own panel

        var api = {
            input: input,
            close: close,
            destroy: function () {
                clearTimeout(state.timer);
                if (state.ctrl) { try { state.ctrl.abort(); } catch (e) {} }
                input.removeEventListener('input', onInput);
                input.removeEventListener('keydown', onKey);
                input.removeEventListener('blur', onBlur);
                dd.removeEventListener('mousedown', onDown);
                window.removeEventListener('resize', onViewport);
                window.removeEventListener('scroll', onViewport, true);
                if (dd.parentNode) dd.parentNode.removeChild(dd);
                Object.keys(prevAttrs).forEach(function (a) { if (prevAttrs[a] == null) input.removeAttribute(a); else input.setAttribute(a, prevAttrs[a]); });
                input.removeAttribute('aria-activedescendant');
                input._tmPlaces = null;
                var at = live.indexOf(api);
                if (at !== -1) live.splice(at, 1);
            }
        };
        input._tmPlaces = api;
        live.push(api);
        return api;
    }

    function detach(input) { if (input && input._tmPlaces) input._tmPlaces.destroy(); }

    global.TMPlaces = { attach: attach, detach: detach, newSessionToken: newSessionToken, _live: function () { return live.length; } };
})(window);
