/* Door check-in for event ticketing (docs-internal/ticketing.md). Runs on two pages:
   (1) /t/<token> - the page a ticket's QR code opens. Anyone sees only "Valid ticket for <show>". If the person holding the phone is
       signed in to the admin portal, the admin API answers (same-origin request, so the session cookie goes with it) and the page
       becomes the staff view: holder, ticket type, status and a big Check In button. Opening the page never checks anyone in.
   (2) /checkin - the scanner: the phone camera reads QR codes (the browser's BarcodeDetector where it exists, else the bundled jsQR),
       or a ticket is found by name / e-mail / order number / code; a tap on Check In admits.
   Check-in is always a POST to the admin API, which runs ONE atomic update - of two phones scanning the same ticket, exactly one admits. */
(function () {
    'use strict';

    var TOKEN = /^[A-Za-z0-9_-]{24}$/;

    function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'); }
    function call(method, url) {
        return fetch(url, { method: method, credentials: 'same-origin', cache: 'no-store', headers: { Accept: 'application/json' } }).then(function (res) {
            return res.json().catch(function () { return {}; }).then(function (json) { return { status: res.status, ok: res.ok, json: json || {} }; });
        });
    }
    function $(id) { return document.getElementById(id); }
    function buzz(ok) { try { if (navigator.vibrate) navigator.vibrate(ok ? 60 : [80, 60, 80]); } catch (e) {} }

    // A scanned QR is normally this site's /t/<token> link; a bare 24-character code (typed or printed) works too.
    function tokenFrom(text) {
        var s = String(text || '').trim();
        var m = s.match(/\/t\/([A-Za-z0-9_-]{24})(?:[/?#]|$)/);
        if (m) return m[1];
        var bare = s.replace(/\s+/g, '');
        return TOKEN.test(bare) ? bare : null;
    }

    // The ticket card + its result banner. t: the admin API's door view of a ticket.
    function ticketCard(t, result, message) {
        var cls = result === 'admitted' ? 'ok' : (result === 'already' || result === 'void' || result === 'invalid' || result === 'wrong_event') ? 'bad' : t && t.status === 'valid' ? 'ready' : 'bad';
        var head = message ? '<p class="ck-banner ck-banner--' + cls + '" role="status">' + esc(message) + '</p>' : '';
        if (!t) return head;
        var status = t.status === 'void' ? 'Not valid (refunded / cancelled)' : t.status === 'checked_in' ? 'Checked in at ' + esc(t.checked_in_label) + (t.checked_in_by ? ' by ' + esc(t.checked_in_by) : '') : 'Valid - not yet in';
        return head + '<div class="ck-ticket ck-ticket--' + cls + '">' +
            '<p class="ck-ticket__holder">' + esc(t.holder || 'Ticket holder') + '</p>' +
            '<p class="ck-ticket__tier">' + esc(t.tier) + ' · order #' + esc(t.order_id) + '</p>' +
            '<p class="ck-ticket__event">' + esc(t.event_title) + (t.when ? ' · ' + esc(t.when) : '') + '</p>' +
            '<p class="ck-ticket__status">' + status + '</p></div>';
    }

    function checkInButton(token) {
        return '<button type="button" class="ck-btn ck-btn--gold ck-btn--huge" data-checkin="' + esc(token) + '"><i class="fa-solid fa-door-open" aria-hidden="true"></i> Check In</button>';
    }

    // ── "did MY check-in go through?" ── A tap whose answer is lost (signal drops at the door) may still have reached the server. The
    // phone remembers which tickets it just tried to admit; if a recheck shows the ticket checked in AFTER this phone's attempt (by the
    // server's own "seconds ago", so the phone's clock does not matter), that check-in was this phone's: the guest is in - not "already
    // scanned". Any other phone (a copied QR code) has no such attempt and still gets the red "Already scanned".
    // An attempt is remembered ONLY while its answer is missing: any answer that arrives - and a recheck that confirms it - forgets it, so
    // scanning the same ticket again on this phone afterwards is the ordinary red "Already scanned", never a second green.
    var attempts = {};                                              // token -> Date.now() when this phone pressed Check In
    function noteAttempt(token) { attempts[token] = Date.now(); }
    function forgetAttempt(token) { delete attempts[token]; }
    function wasMine(t) {
        var at = t && attempts[t.token];
        if (!at || t.status !== 'checked_in' || t.checked_in_seconds_ago == null) return false;
        var sinceAttempt = (Date.now() - at) / 1000;
        var mine = sinceAttempt < 300 && t.checked_in_seconds_ago <= sinceAttempt + 10;
        forgetAttempt(t.token);                                     // answered now, either way
        return mine;
    }
    function lostMessage(token) {
        return '<p class="ck-banner ck-banner--bad" role="alert">Connection lost - the check-in may not have gone through.</p>' +
            '<p class="ck-line">Check this ticket again before letting the guest in.</p>' +
            '<button type="button" class="ck-btn ck-btn--gold" data-recheck="' + esc(token) + '">Check again</button>';
    }
    var MINE = 'Admitted - this phone\'s check-in went through';

    function messageFor(r) {
        if (r.result === 'admitted') return 'Admitted';
        if (r.result === 'already') return r.json && r.json.message ? r.json.message : 'Already scanned';
        if (r.result === 'void') return 'This ticket is no longer valid';
        return 'Invalid ticket';
    }

    // ---------------------------------------------------------------- (1) the /t/<token> page

    var main = $('ckMain');
    if (main && main.getAttribute('data-token')) {
        var token = main.getAttribute('data-token');
        var staff = $('ckStaff');
        var showStaff = function (t, result, message, counts) {
            staff.innerHTML = '<p class="ck-eyebrow">Door check-in · staff view</p>' + ticketCard(t, result, message) +
                (t && t.status === 'valid' && result !== 'admitted' ? checkInButton(t.token) : '') +
                (counts ? '<p class="ck-count">' + counts.checked_in + ' of ' + counts.valid + ' checked in</p>' : '') +
                '<a class="ck-btn" href="/checkin' + (t && t.event_id ? '?event=' + encodeURIComponent(t.event_id) : '') + '">Open the scanner</a>';
            staff.hidden = false;
            $('ckPublic').hidden = true;
        };
        var lookupStaff = function () {
            return call('GET', '/api/admin/ticketing/tickets/' + encodeURIComponent(token)).then(function (r) {
                if (!r.ok) return;                                  // 401 / 403 (not signed in) or 404: the public view stays as rendered
                var t = r.json.ticket;
                if (wasMine(t)) { buzz(true); showStaff(t, 'admitted', MINE, r.json.counts); return; }
                showStaff(t, null, null, r.json.counts);            // signed-in staff: the door controls
            });
        };
        if (TOKEN.test(token)) lookupStaff().catch(function () {});
        document.addEventListener('click', function (e) {
            var re = e.target.closest && e.target.closest('[data-recheck]');
            if (re) { re.disabled = true; lookupStaff().catch(function () { re.disabled = false; }); return; }
            var b = e.target.closest && e.target.closest('[data-checkin]');
            if (!b) return;
            b.disabled = true;
            noteAttempt(b.getAttribute('data-checkin'));
            call('POST', '/api/admin/ticketing/tickets/' + encodeURIComponent(b.getAttribute('data-checkin')) + '/check-in').then(function (r) {
                var res = { result: r.json.result || (r.status === 404 ? 'invalid' : 'error'), json: r.json };
                if (r.status === 401 || r.status === 403) { b.disabled = false; return; }
                if (res.result === 'already' && wasMine(r.json.ticket)) { res.result = 'admitted'; res.mine = true; }
                forgetAttempt(b.getAttribute('data-checkin'));          // an answer arrived
                buzz(res.result === 'admitted');
                showStaff(r.json.ticket, res.result, res.mine ? MINE : messageFor(res), r.json.counts);
            }).catch(function () {
                // the answer never came back: say so - never leave the button silently re-enabled
                staff.innerHTML = '<p class="ck-eyebrow">Door check-in · staff view</p>' + lostMessage(b.getAttribute('data-checkin'));
            });
        });
        return;
    }

    // ---------------------------------------------------------------- (2) the /checkin scanner

    var scanner = $('ckScanner');
    if (!scanner) return;
    var params = new URLSearchParams(window.location.search);
    var state = { eventId: null, stream: null, scanning: false, detector: null, lastText: '', lastAt: 0, busy: false, timer: null };

    function setCounts(c) { if (c) $('ckCount').textContent = c.checked_in + ' of ' + c.valid + ' checked in'; }
    function refreshCounts() {
        if (!state.eventId) return;
        call('GET', '/api/admin/ticketing/events/' + state.eventId + '/door').then(function (r) { if (r.ok) setCounts(r.json.counts); });
    }

    function showResult(html) { var box = $('ckResult'); box.innerHTML = html; box.hidden = false; box.scrollIntoView({ block: 'nearest' }); }
    function nextButton() { return '<button type="button" class="ck-btn" id="ckNext">Next ticket</button>'; }

    // A token from the camera or the search: look it up (a GET changes nothing) and offer Check In.
    function lookup(token) {
        state.busy = true;
        pauseScan();
        call('GET', '/api/admin/ticketing/tickets/' + encodeURIComponent(token)).then(function (r) {
            if (r.status === 401 || r.status === 403) return needSignIn();
            if (!r.ok) { buzz(false); showResult(ticketCard(null, 'invalid', 'Invalid ticket') + nextButton()); return; }
            var t = r.json.ticket;
            if (state.eventId && Number(t.event_id) !== Number(state.eventId)) {
                buzz(false);
                showResult(ticketCard(t, 'wrong_event', 'Wrong show - this ticket is for ' + t.event_title + (t.when ? ' (' + t.when + ')' : '')) + nextButton());
                return;
            }
            if (t.status === 'checked_in' && wasMine(t)) { buzz(true); showResult(ticketCard(t, 'admitted', MINE) + nextButton()); return; }
            if (t.status === 'checked_in') { buzz(false); showResult(ticketCard(t, 'already', 'Already scanned at ' + t.checked_in_label) + nextButton()); return; }
            if (t.status === 'void') { buzz(false); showResult(ticketCard(t, 'void', 'This ticket is no longer valid') + nextButton()); return; }
            showResult(ticketCard(t, null, null) + checkInButton(t.token) + nextButton());
            var b = document.querySelector('#ckResult [data-checkin]');
            if (b) b.focus();
        }).catch(function () { showResult('<p class="ck-banner ck-banner--bad">Connection problem - try again.</p>' + nextButton()); });
    }

    document.addEventListener('click', function (e) {
        var re = e.target.closest && e.target.closest('[data-recheck]');
        if (re) { lookup(re.getAttribute('data-recheck')); return; }
        var b = e.target.closest && e.target.closest('[data-checkin]');
        if (b) {
            var tok = b.getAttribute('data-checkin');
            b.disabled = true;
            noteAttempt(tok);
            call('POST', '/api/admin/ticketing/tickets/' + encodeURIComponent(tok) + '/check-in').then(function (r) {
                if (r.status === 401 || r.status === 403) return needSignIn();
                var res = { result: r.json.result || 'invalid', json: r.json };
                if (res.result === 'already' && wasMine(r.json.ticket)) { res.result = 'admitted'; res.mine = true; }   // a retry of this phone's own tap
                forgetAttempt(tok);                                         // an answer arrived
                buzz(res.result === 'admitted');
                showResult(ticketCard(r.json.ticket, res.result, res.mine ? MINE : messageFor(res)) + nextButton());
                setCounts(r.json.counts);
                var n = $('ckNext'); if (n) n.focus();
                if (res.result === 'admitted' && state.stream) setTimeout(function () { if (!state.scanning && state.stream) next(); }, 1600);   // keep the queue moving
            }).catch(function () {
                // the answer never came back: say so - never leave the button silently re-enabled
                buzz(false);
                showResult(lostMessage(tok) + nextButton());
            });
            return;
        }
        if (e.target.closest && e.target.closest('#ckNext')) next();
    });

    function next() {
        $('ckResult').hidden = true;
        $('ckResult').innerHTML = '';
        state.busy = false;
        state.lastText = '';
        if (state.stream) resumeScan();
    }

    function needSignIn() {
        stopCamera();
        ['ckCameraBox', 'ckManual', 'ckResult'].forEach(function (id) { $(id).hidden = true; });
        $('ckSignin').hidden = false;
        $('ckEvent').hidden = true;
    }

    // ── the event this door is for ──
    function loadEvents() {
        return call('GET', '/api/admin/ticketing/events').then(function (r) {
            if (r.status === 401 || r.status === 403) return needSignIn();
            var events = (r.json.events || []);
            var sel = $('ckEvent');
            if (!events.length) { sel.innerHTML = '<option>No ticketed events yet</option>'; sel.disabled = true; return; }
            var now = Date.now();
            var soon = events.filter(function (e) { return e.event_datetime && Date.parse(e.event_datetime) >= now - 12 * 3600 * 1000; })
                .sort(function (a, b) { return Date.parse(a.event_datetime) - Date.parse(b.event_datetime); });
            var want = Number(params.get('event')) || (soon[0] && soon[0].event_id) || events[0].event_id;
            sel.innerHTML = events.map(function (e) {
                return '<option value="' + e.event_id + '"' + (e.event_id === want ? ' selected' : '') + '>' + esc(e.event_title) + (e.starts_label ? ' · ' + esc(e.starts_label) : '') + '</option>';
            }).join('');
            state.eventId = Number(sel.value);
            $('ckCameraBox').hidden = false;
            $('ckManual').hidden = false;
            refreshCounts();
            setInterval(refreshCounts, 30000);                         // other phones at other doors
        });
    }
    $('ckEvent').addEventListener('change', function () { state.eventId = Number(this.value); $('ckFound').innerHTML = ''; next(); refreshCounts(); });

    // ── camera ──
    function startCamera() {
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
            showResult('<p class="ck-banner ck-banner--bad">This browser cannot use the camera here. Use the search below, or the phone\'s own camera app to open the ticket link.</p>');
            return;
        }
        navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false }).then(function (stream) {
            state.stream = stream;
            var v = $('ckVideo');
            v.srcObject = stream;
            v.play();
            $('ckStart').hidden = true;
            $('ckStop').hidden = false;
            $('ckVideoWrap').classList.add('ck-live');
            if ('BarcodeDetector' in window) {
                try { state.detector = new window.BarcodeDetector({ formats: ['qr_code'] }); } catch (e) { state.detector = null; }
            }
            resumeScan();
        }).catch(function (err) {
            showResult('<p class="ck-banner ck-banner--bad">' + (err && err.name === 'NotAllowedError'
                ? 'Camera permission was refused. Allow the camera for this site in the browser settings, or use the search below.'
                : 'The camera could not start. Use the search below, or the phone\'s own camera app to open the ticket link.') + '</p>');
        });
    }
    function stopCamera() {
        pauseScan();
        if (state.stream) state.stream.getTracks().forEach(function (t) { t.stop(); });
        state.stream = null;
        $('ckStart').hidden = false;
        $('ckStop').hidden = true;
        $('ckVideoWrap').classList.remove('ck-live');
    }
    function pauseScan() { state.scanning = false; if (state.timer) { clearTimeout(state.timer); state.timer = null; } }
    function resumeScan() { if (!state.stream) return; state.scanning = true; tick(); }

    function found(text) {
        var now = Date.now();
        if (text === state.lastText && now - state.lastAt < 3000) return;          // the same code still in front of the camera
        state.lastText = text; state.lastAt = now;
        var t = tokenFrom(text);
        if (!t) { $('ckVideoHint').textContent = 'That QR code is not a ticket'; return; }
        lookup(t);
    }

    function tick() {
        if (!state.scanning || state.busy) return;
        var v = $('ckVideo');
        var again = function () { if (state.scanning) state.timer = setTimeout(tick, 200); };
        if (v.readyState < 2) return again();
        if (state.detector) {
            state.detector.detect(v).then(function (codes) { if (codes && codes.length) found(codes[0].rawValue); again(); }).catch(function () { state.detector = null; again(); });
            return;
        }
        if (typeof window.jsQR !== 'function') return again();
        var c = $('ckCanvas');
        var w = Math.min(640, v.videoWidth), h = Math.round(v.videoHeight * (w / v.videoWidth));
        if (!w || !h) return again();
        c.width = w; c.height = h;
        var ctx = c.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(v, 0, 0, w, h);
        var code = window.jsQR(ctx.getImageData(0, 0, w, h).data, w, h, { inversionAttempts: 'dontInvert' });
        if (code && code.data) found(code.data);
        again();
    }

    $('ckStart').addEventListener('click', startCamera);
    $('ckStop').addEventListener('click', stopCamera);

    // ── search: a ticket code goes straight to the lookup; anything else searches this event's tickets ──
    $('ckSearchForm').addEventListener('submit', function (e) {
        e.preventDefault();
        var q = $('ckSearch').value.trim();
        if (!q) return;
        var t = tokenFrom(q);
        if (t) { lookup(t); return; }
        call('GET', '/api/admin/ticketing/events/' + state.eventId + '/door?q=' + encodeURIComponent(q)).then(function (r) {
            if (r.status === 401 || r.status === 403) return needSignIn();
            var list = (r.json.results || []);
            $('ckFound').innerHTML = list.length ? list.map(function (t) {
                return '<li class="ck-found__row"><div><p class="ck-ticket__holder">' + esc(t.holder) + '</p><p class="ck-ticket__tier">' + esc(t.tier) + ' · order #' + esc(t.order_id) +
                    (t.status === 'checked_in' ? ' · <strong>in at ' + esc(t.checked_in_label) + '</strong>' : '') + '</p></div>' +
                    (t.status === 'valid' ? '<button type="button" class="ck-btn ck-btn--gold" data-checkin="' + esc(t.token) + '">Check In</button>' : '') + '</li>';
            }).join('') : '<li class="ck-found__none">No valid ticket matches "' + esc(q) + '" for this show.</li>';
        });
    });

    loadEvents();
})();
