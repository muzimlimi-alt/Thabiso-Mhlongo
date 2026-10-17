/* Admin Calendar <-> Microsoft 365 (docs-internal/calendar-m365.md): the status strip and its details panel, the sync badge on each calendar item, the
   "Microsoft 365" section of the event popup (retry / resolve a conflict / re-create / open in Outlook), the popup for an appointment that lives only in
   Outlook, and the sync filter. Loaded after js/admin/calendar.js, which calls the window.calM365* hooks defined here.

   Everything that comes from Microsoft (titles, places, what Outlook now says) is untrusted text: it is only ever put on the page through esc() or textContent.
   What a person may do is decided by the server (administrator / manager); the .cal-m365-manage / .cal-m365-admin classes only hide buttons that would be refused. */
(function () {
    'use strict';
    var API = '/api/admin/calendar-sync';
    var status = null;        // the last GET /api/admin/calendar-sync
    var lastTest = null;      // the steps of the last "Test calendar access"
    var activity = null;      // the latest sync log entries (administrator)
    var busy = false;

    function esc(s) {
        if (window.escHtml) return window.escHtml(s);
        return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return '&#' + c.charCodeAt(0) + ';'; });
    }
    function $(id) { return document.getElementById(id); }
    function role() { return window.currentUserRole || 'manager'; }
    function canManage() { return role() === 'administrator' || role() === 'manager'; }
    function isAdmin() { return role() === 'administrator'; }
    function toast(kind, msg) {
        var n = window.notificationService;
        if (n && n[kind]) n[kind](msg); else if (kind === 'showError') window.alert(msg);
    }

    function call(method, url, body) {
        return fetch(url, { method: method, headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined, credentials: 'same-origin' })
            .then(function (r) { return r.json().catch(function () { return {}; }).then(function (d) { d._status = r.status; return d; }); });
    }

    /* ---- wording ---- */
    function ago(iso) {
        if (!iso) return 'never';
        var s = Math.round((Date.now() - Date.parse(iso)) / 1000);
        if (isNaN(s)) return 'unknown';
        if (s < 45) return 'just now';
        if (s < 3600) return Math.max(1, Math.round(s / 60)) + ' min ago';
        if (s < 86400) return Math.round(s / 3600) + ' h ago';
        return Math.round(s / 86400) + ' days ago';
    }
    var REASONS = {
        permission: "The website isn't allowed to change the Microsoft 365 calendar yet. An administrator needs to grant it calendar access (Details > Test calendar access explains how).",
        auth: 'Signing in to Microsoft 365 failed. An administrator needs to check the Microsoft 365 app secret in Settings > Email.',
        config: "Microsoft 365 isn't set up for the website yet (Settings > Email).",
        connection: 'Microsoft 365 could not be reached. The website will try again automatically.',
        server: 'Microsoft 365 had a temporary problem. The website will try again automatically.',
        throttled: 'Microsoft 365 asked the website to slow down. It will try again automatically.',
        invalid: 'Microsoft 365 refused this entry. Check its date, time and venue, then retry.',
        notfound: 'This entry was deleted in Microsoft 365.',
        conflict: 'It was changed in Microsoft 365.',
        mailbox: 'The shared calendar could not be found. An administrator should check the mailbox address in Settings > Email.',
        internal: 'The sync hit an unexpected problem. It will try again automatically.'
    };
    function reason(cat) { return REASONS[cat] || 'The sync did not complete. It will try again automatically.'; }
    var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    var DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    function dayLabel(ymd) {
        var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(ymd || '');
        if (!m) return ymd || '';
        var d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
        return DAYS[d.getDay()] + ' ' + Number(m[3]) + ' ' + MONTHS[Number(m[2]) - 1];
    }
    // 'YYYY-MM-DDTHH:mm' strings are wall-clock in the business zone on both sides, so they are read as text, never through the browser's time zone
    function range(start, end, allDay) {
        if (!start) return '';
        var sd = String(start).slice(0, 10), st = String(start).slice(11, 16), ed = String(end || '').slice(0, 10), et = String(end || '').slice(11, 16);
        if (allDay || !st) return dayLabel(sd) + ' (all day)';
        if (!ed || ed === sd) return dayLabel(sd) + ', ' + st + (et ? '–' + et : '');
        return dayLabel(sd) + ' ' + st + ' → ' + dayLabel(ed) + ' ' + et;
    }

    /* ---- the status strip ---- */
    function setStrip(kind, text) {
        var strip = $('calM365Strip');
        if (!strip) return;
        strip.hidden = false;
        strip.className = 'cal-m365-strip cal-m365-strip--' + kind;
        $('calM365Text').textContent = text;
    }
    function attentionCount() {
        var l = (status && status.links) || {};
        return (l.error || 0) + (l.conflict || 0) + (l.external_deleted || 0);
    }
    function renderStrip() {
        var strip = $('calM365Strip');
        if (!strip || !status) return;
        var attn = attentionCount();
        var l = status.links || {};
        var run = $('calM365Run'), btn = $('calM365Attention');
        run.hidden = !(status.enabled && canManage());
        btn.hidden = !(status.enabled && attn > 0);
        btn.textContent = attn + (attn === 1 ? ' needs attention' : ' need attention');
        if (!status.enabled) {
            setStrip('off', 'Microsoft 365 calendar sharing is off. Bookings and events stay on the website only.');
        } else if (status.lastError && status.consecutiveFailures > 0) {
            setStrip('bad', "Microsoft 365: can't sync right now — " + reason(status.lastErrorCategory) + (status.lastSuccessAt ? ' Last good sync ' + ago(status.lastSuccessAt) + '.' : ''));
        } else if (attn > 0) {
            setStrip('warn', 'Microsoft 365: connected · synced ' + ago(status.lastSuccessAt) + '.');
        } else {
            var waiting = l.pending || 0;
            setStrip('ok', 'Microsoft 365: connected · synced ' + ago(status.lastSuccessAt) + (waiting ? ' · ' + waiting + ' waiting' : '') + '.');
        }
        // the filters only matter once the integration has been used
        var used = status.enabled || (status.upcomingExternal || 0) > 0 || Object.keys(l).length > 0;
        if ($('calFilterExternal')) $('calFilterExternal').hidden = !used;
        if ($('calSyncFilterWrap')) $('calSyncFilterWrap').hidden = !used;
        if (!$('calM365Panel').hidden) renderPanel();
    }
    function loadStatus() {
        return call('GET', API).then(function (d) {
            if (d && d.success) { status = d; renderStrip(); }
            return d;
        }).catch(function () { /* the calendar works without it */ });
    }

    /* ---- the details panel ---- */
    function stepsHtml(steps) {
        return '<ul class="cal-m365-steps">' + (steps || []).map(function (s) {
            return '<li class="' + (s.ok ? 'ok' : 'bad') + '"><i class="fa-solid ' + (s.ok ? 'fa-circle-check' : 'fa-circle-xmark') + '" aria-hidden="true"></i> <strong>' + esc(s.label) + '</strong> ' + esc(s.message) + '</li>';
        }).join('') + '</ul>';
    }
    function renderPanel() {
        var p = $('calM365Panel');
        if (!p || !status) return;
        var l = status.links || {};
        var rows = [];
        rows.push('<div><dt>Shared calendar</dt><dd>' + esc(status.mailbox || 'the booking mailbox (set in Settings > Email)') + '</dd></div>');
        rows.push('<div><dt>Time zone</dt><dd>' + esc(status.businessTimeZone || '') + '</dd></div>');
        rows.push('<div><dt>Last successful sync</dt><dd>' + esc(ago(status.lastSuccessAt)) + '</dd></div>');
        rows.push('<div><dt>Last attempt</dt><dd>' + esc(ago(status.lastRunAt)) + '</dd></div>');
        var counts = '<span class="cal-m365-count">' + (l.synced || 0) + ' synced</span><span class="cal-m365-count">' + (l.pending || 0) + ' waiting</span>' +
            '<span class="cal-m365-count' + (attentionCount() ? ' cal-m365-count--attn' : '') + '">' + attentionCount() + ' need attention</span>' +
            '<span class="cal-m365-count">' + (status.upcomingExternal || 0) + ' Microsoft 365 appointments shown</span>';
        var html = '<div class="cal-m365-panel__head"><strong><i class="fa-brands fa-microsoft" aria-hidden="true"></i> Microsoft 365 shared calendar</strong>' +
            '<button type="button" class="cal-m365-x" id="calM365Close" aria-label="Close details">&times;</button></div>' +
            '<dl class="cal-m365-dl">' + rows.join('') + '</dl><div class="cal-m365-counts">' + counts + '</div>';
        if (status.lastError) {
            html += '<div class="cal-m365-note cal-m365-note--bad" role="alert"><strong>' + (status.consecutiveFailures > 0 ? "Can't sync right now." : 'Last problem.') + '</strong> ' + esc(reason(status.lastErrorCategory)) +
                '<div class="cal-m365-fine">' + esc(status.lastError) + '</div></div>';
        }
        html += '<div class="cal-m365-admin cal-m365-admin-box"><div class="cal-m365-btnrow">' +
            '<button type="button" class="cal-m365-strip__btn" id="calM365Test"' + (busy ? ' disabled' : '') + '><i class="fa-solid fa-plug-circle-check" aria-hidden="true"></i> Test calendar access</button>' +
            '<button type="button" class="cal-m365-strip__btn" id="calM365Switch"' + (busy ? ' disabled' : '') + '>' + (status.enabled ? 'Switch sharing off' : 'Switch sharing on') + '</button></div>' +
            (lastTest ? '<div class="cal-m365-test">' + stepsHtml(lastTest.steps) + '</div>' : '') +
            '<div class="cal-m365-fine">Testing creates and removes one invisible test event dated 2001 (nobody is invited or notified). Switching on is refused unless that test passes.</div></div>';
        if (isAdmin()) {
            html += '<details class="cal-m365-help cal-m365-admin" id="calM365Activity"><summary>Recent activity</summary>' + (activity === null
                ? '<div class="cal-m365-fine">Loading&hellip;</div>'
                : activity.length === 0 ? '<div class="cal-m365-fine">Nothing has been synced yet.</div>'
                : '<ul class="cal-m365-log">' + activity.map(function (a) {
                    var what = a.action.replace(/_/g, ' ') + (a.sourceType ? ' \u00b7 ' + a.sourceType + ' #' + a.sourceId : '');
                    return '<li class="' + esc(a.outcome) + '"><span class="cal-m365-log__when">' + esc(ago(String(a.at).replace(' ', 'T') + 'Z')) + '</span> <strong>' + esc(what) + '</strong>' +
                        (a.outcome !== 'ok' ? ' <em>' + esc(a.outcome) + '</em>' : '') + (a.message ? '<div class="cal-m365-fine">' + esc(a.message) + '</div>' : '') +
                        (a.actor ? '<div class="cal-m365-fine">by ' + esc(a.actor) + '</div>' : '') + '</li>';
                }).join('') + '</ul>') + '</details>';
        }
        html += '<details class="cal-m365-help"><summary>What is shared, and what is not</summary><ul>' +
            '<li><strong>Confirmed</strong> bookings appear as busy, <strong>accepted</strong> ones as tentative. Enquiries and quotes are never shared. Cancelled bookings are removed.</li>' +
            '<li>Only the title, time, venue and a link back to the admin are shared — never the client’s e-mail, phone number or notes.</li>' +
            '<li>Changing a shared entry in Outlook does <strong>not</strong> change the booking. The entry is flagged here and an administrator or manager decides.</li>' +
            '<li>Other people’s <em>busy</em> appointments in the shared calendar block those dates on the public booking form.</li>' +
            '<li>The calendar is checked every couple of minutes, and a few seconds after a booking changes.</li></ul></details>';
        p.innerHTML = html;
        $('calM365Close').onclick = function () { togglePanel(false); };
        $('calM365Test').onclick = runTest;
        $('calM365Switch').onclick = toggleSharing;
    }
    function togglePanel(open) {
        var p = $('calM365Panel'), t = $('calM365Toggle');
        if (!p || !t) return;
        var want = typeof open === 'boolean' ? open : p.hidden;
        p.hidden = !want;
        t.setAttribute('aria-expanded', String(want));
        if (want) {
            renderPanel();
            if (isAdmin()) call('GET', API + '/log').then(function (d) { if (d && d.success) { activity = d.entries; renderPanel(); } }).catch(function () { /* optional */ });
        }
    }
    function runTest() {
        busy = true; renderPanel();
        call('POST', API + '/test').then(function (d) {
            lastTest = d && d.steps ? d : { steps: [{ ok: false, label: 'Test', message: (d && d.message) || 'The test could not be run.' }] };
        }).catch(function () {
            lastTest = { steps: [{ ok: false, label: 'Test', message: 'The website could not be reached.' }] };
        }).then(function () { busy = false; renderPanel(); });
    }
    function toggleSharing() {
        var turnOn = !status.enabled;
        var ask = window.notificationService && window.notificationService.showConfirm
            ? window.notificationService.showConfirm({
                title: turnOn ? 'Switch Microsoft 365 sharing on?' : 'Switch Microsoft 365 sharing off?',
                message: turnOn
                    ? 'The website first checks it can write to the shared calendar (one invisible test event is created and removed). Then confirmed and accepted bookings and public events are shared, and busy appointments from that calendar block dates on the booking form.'
                    : 'Bookings and events stay as they are in Microsoft 365, but nothing new is shared and nothing is read until you switch it back on.'
            })
            : Promise.resolve(window.confirm('Are you sure?'));
        Promise.resolve(ask).then(function (ok) {
            if (!ok) return;
            busy = true; renderPanel();
            call('PUT', API, { enabled: turnOn }).then(function (d) {
                if (d && d.success) {
                    lastTest = null; status = d;
                    toast('showSuccess', turnOn ? 'Microsoft 365 sharing is on.' : 'Microsoft 365 sharing is off.');
                } else {
                    if (d && d.steps) lastTest = { steps: d.steps };
                    toast('showError', (d && d.message) || 'That could not be changed.');
                }
            }).catch(function () { toast('showError', 'The website could not be reached.'); })
              .then(function () { busy = false; renderStrip(); renderPanel(); refetch(); });
        });
    }
    function runNow() {
        var b = $('calM365Run');
        if (b) b.disabled = true;
        call('POST', API + '/run').then(function (d) {
            if (d && d.success) {
                if (d.result && d.result.ok === false) toast('showError', reason(d.result.category));
                else toast('showSuccess', 'Calendar synced.');
                if (d.status) { status = d.status; }
            } else toast('showError', (d && d.message) || 'The sync could not be run.');
        }).catch(function () { toast('showError', 'The website could not be reached.'); })
          .then(function () { if (b) b.disabled = false; return loadStatus(); }).then(refetch);
    }
    function refetch() { if (typeof adminCalendar !== 'undefined' && adminCalendar) adminCalendar.refetchEvents(); if (typeof window.refreshMiniCalendar === 'function') window.refreshMiniCalendar(); }

    /* ---- sync filter (pure CSS: the badges put classes on each event) ---- */
    function applySyncFilter(mode) {
        var el = $('calendar');
        if (!el) return;
        ['synced', 'pending', 'attention', 'website'].forEach(function (m) { el.classList.remove('fc-cal--sync-' + m); });
        if (mode && mode !== 'all') el.classList.add('fc-cal--sync-' + mode);
    }

    /* ---- a badge on each calendar item ---- */
    var BADGES = {
        synced: { icon: 'fa-check', label: 'Synced with Microsoft 365', group: 'synced' },
        pending: { icon: 'fa-hourglass-half', label: 'Waiting to sync with Microsoft 365', group: 'pending' },
        error: { icon: 'fa-exclamation', label: 'Could not sync with Microsoft 365', group: 'attention' },
        conflict: { icon: 'fa-code-compare', label: 'Changed in Microsoft 365 — needs a decision', group: 'attention' },
        external_deleted: { icon: 'fa-link-slash', label: 'Deleted in Microsoft 365', group: 'attention' }
    };
    window.calM365Badge = function (arg, props) {
        var el = arg.el;
        if (props.type === 'external') {
            addBadge(el, 'fa-brands fa-microsoft', 'External', 'From the shared Microsoft 365 calendar — edit it in Outlook');
            return;
        }
        if (props.type !== 'booking' && props.type !== 'public_event') return;
        var m = props.m365;
        var b = m && BADGES[m.status];
        el.classList.add('fc-event--m365-' + (b ? b.group : 'none'));
        if (b) addBadge(el, 'fa-solid ' + b.icon, m.status, b.label);
    };
    function addBadge(el, iconClass, kind, label) {
        var host = el.querySelector('.fc-event-title') || el.querySelector('.fc-list-event-title') || el;
        var span = document.createElement('span');
        span.className = 'fc-m365-badge fc-m365-badge--' + kind;
        span.setAttribute('role', 'img');
        span.setAttribute('aria-label', label);
        span.title = label;
        var i = document.createElement('i');
        i.className = iconClass;
        i.setAttribute('aria-hidden', 'true');
        span.appendChild(i);
        // in FRONT of the title: month cells are narrow and a long title would push a trailing marker out of sight
        host.insertBefore(span, host.firstChild);
    }

    /* ---- the "Microsoft 365" section of a booking / public event popup ---- */
    function pill(kind, text) { return '<span class="cal-m365-pill cal-m365-pill--' + kind + '">' + esc(text) + '</span>'; }
    function actionBtn(act, text, cls) { return '<button type="button" class="cal-m365-strip__btn ' + (cls || '') + '" data-m365-act="' + act + '">' + esc(text) + '</button>'; }
    window.calM365PopupSection = function (props, info) {
        if (props.type !== 'booking' && props.type !== 'public_event') return null;
        var m = props.m365;
        var sec = document.createElement('div');
        sec.className = 'cal-m365-sec';
        var h = '<div class="cal-m365-sec__h"><i class="fa-brands fa-microsoft" aria-hidden="true"></i> Microsoft 365 calendar</div>';
        if (!m) {
            if (!status || !status.enabled) return null;
            if (props.m365Eligible === false) {
                h += '<div class="cal-m365-line">' + pill('none', 'Website only') + ' <span class="cal-m365-fine">' + (props.type === 'booking' ? 'Enquiries and quotes are shared only once the client has accepted.' : 'This event is not shared (draft, cancelled or tied to a booking).') + '</span></div>';
            } else {
                h += '<div class="cal-m365-line">' + pill('pending', 'Waiting to sync') + ' <span class="cal-m365-fine">It will appear in Microsoft 365 within a couple of minutes.</span></div>';
            }
            sec.innerHTML = h;
            return sec;
        }
        var open = m.webLink ? '<a class="cal-m365-strip__btn" href="' + esc(m.webLink) + '" target="_blank" rel="noopener noreferrer">Open in Outlook <i class="fa-solid fa-arrow-up-right-from-square" aria-hidden="true"></i></a>' : '';
        var actions = '';
        var websiteWhen = range(info.event.startStr, info.event.endStr || '', info.event.allDay);
        if (m.status === 'synced') {
            h += '<div class="cal-m365-line">' + pill('synced', 'Synced') + ' <span class="cal-m365-fine">Last synced ' + esc(ago(m.lastSyncedAt)) + '</span></div>';
            actions = open;
        } else if (m.status === 'pending') {
            h += '<div class="cal-m365-line">' + pill('pending', 'Waiting to sync') + '</div>' +
                (m.error ? '<div class="cal-m365-note">The last attempt did not finish. ' + esc(reason(m.errorCategory)) + '</div>' : '');
            actions = (m.error && canManage() ? actionBtn('retry', 'Retry now', 'cal-m365-manage') : '') + open;
        } else if (m.status === 'error') {
            h += '<div class="cal-m365-line">' + pill('bad', "Couldn't sync") + ' <span class="cal-m365-fine">' + m.attempts + (m.attempts === 1 ? ' try' : ' tries') + '</span></div>' +
                '<div class="cal-m365-note cal-m365-note--bad">' + esc(reason(m.errorCategory)) + (m.error ? '<div class="cal-m365-fine">' + esc(m.error) + '</div>' : '') +
                (m.nextAttemptAt ? '<div class="cal-m365-fine">Next automatic try ' + esc(m.nextAttemptAt > new Date().toISOString() ? 'in a little while' : 'shortly') + '.</div>' : '') + '</div>';
            actions = (canManage() ? actionBtn('retry', 'Retry sync', 'cal-m365-manage') : '') + open;
        } else if (m.status === 'conflict') {
            var c = m.conflict || {};
            h += '<div class="cal-m365-line">' + pill('warn', 'Changed in Microsoft 365') + '</div>' +
                '<div class="cal-m365-note cal-m365-note--warn">Someone changed this in Outlook. Nothing has been changed on the website, and the website has not overwritten Outlook either.' +
                '<div class="cal-m365-cmp"><div><span>Website</span>' + esc(websiteWhen) + '</div>' +
                '<div><span>Microsoft 365</span>' + esc(range(c.start, c.end, c.isAllDay)) + (c.subject ? '<br><em>' + esc(c.subject) + '</em>' : '') +
                (c.showAs ? '<br>Shown as ' + esc(c.showAs) : '') + '</div></div></div>';
            actions = (canManage()
                ? actionBtn('keep_website', 'Keep website version', 'cal-m365-manage') + (props.type === 'booking' ? actionBtn('accept_microsoft', 'Use Microsoft 365 time', 'cal-m365-manage') : '')
                : '') + open;
            if (props.type !== 'booking') h += '<div class="cal-m365-fine">To use the Microsoft 365 time, change the date on the Events screen, then choose Keep website version.</div>';
        } else if (m.status === 'external_deleted') {
            h += '<div class="cal-m365-line">' + pill('bad', 'Deleted in Microsoft 365') + '</div>' +
                '<div class="cal-m365-note cal-m365-note--bad">It is not put back automatically, and the ' + (props.type === 'booking' ? 'booking' : 'event') + ' itself is unaffected.</div>';
            actions = canManage() ? actionBtn('recreate', 'Re-create in Microsoft 365', 'cal-m365-manage') : '';
        } else {
            h += '<div class="cal-m365-line">' + pill('none', 'Not in Microsoft 365') + ' <span class="cal-m365-fine">Removed from the shared calendar (cancelled or no longer shared).</span></div>';
        }
        sec.innerHTML = h + (actions ? '<div class="cal-m365-actions">' + actions + '</div>' : '');
        Array.prototype.forEach.call(sec.querySelectorAll('[data-m365-act]'), function (b) {
            b.addEventListener('click', function () { doAction(b.getAttribute('data-m365-act'), m, props, info, b); });
        });
        return sec;
    };
    function closePopup() { var p = $('calEventPopup'); if (p) p.remove(); }
    function doAction(act, m, props, info, button) {
        var confirmFirst = null;
        if (act === 'keep_website') confirmFirst = { title: 'Keep the website version', message: 'This overwrites the change made in Outlook with what the website has.', isDestructive: true };
        if (act === 'accept_microsoft') {
            var c = m.conflict || {};
            confirmFirst = { title: 'Use the Microsoft 365 time', message: 'Change the booking to ' + range(c.start, c.end, c.isAllDay) + '? It is checked for clashes like any move, and the client is emailed if the date changes.' };
        }
        var go = function () {
            button.disabled = true;
            var url = API + '/entries/' + m.id + '/' + (act === 'keep_website' || act === 'accept_microsoft' ? 'resolve' : act);
            call('POST', url, act === 'keep_website' || act === 'accept_microsoft' ? { choice: act } : {}).then(function (d) {
                if (d && d.success) {
                    toast('showSuccess', act === 'retry' ? 'Retrying — it will sync in a moment.' : act === 'recreate' ? 'It will be put back in Microsoft 365 in a moment.' : act === 'keep_website' ? 'The website version will be sent to Microsoft 365 in a moment.' : 'The booking now follows the Microsoft 365 time.');
                    closePopup(); refetch(); loadStatus();
                    setTimeout(function () { refetch(); loadStatus(); }, 7000);   // the follow-up sync runs a few seconds later
                } else {
                    button.disabled = false;
                    toast('showError', (d && d.message) || 'That could not be done.');
                }
            }).catch(function () { button.disabled = false; toast('showError', 'The website could not be reached.'); });
        };
        if (!confirmFirst) return go();
        Promise.resolve(window.notificationService.showConfirm(confirmFirst)).then(function (ok) { if (ok) go(); });
    }

    /* ---- an appointment that lives only in Outlook ---- */
    var SHOW_AS = { busy: 'Busy', free: 'Free', tentative: 'Tentative', oof: 'Out of office', workingElsewhere: 'Working elsewhere' };
    window.calM365ExternalPopupHtml = function (info, props) {
        var start = info.event.startStr || '', end = info.event.endStr || '';
        return '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">' +
            '<strong style="color:var(--atl-ink);font-size:14px;"><i class="fa-brands fa-microsoft" aria-hidden="true"></i> Microsoft 365 calendar</strong>' +
            '<button onclick="document.getElementById(\'calEventPopup\').remove()" aria-label="Close" style="background:none;border:none;color:var(--atl-muted);font-size:18px;cursor:pointer;line-height:1;">&times;</button></div>' +
            '<div style="font-size:13px;line-height:1.75;color:var(--atl-ink-dim);">' +
            '<div style="margin-bottom:4px;"><strong style="color:var(--atl-ink);">' + esc(info.event.title) + '</strong></div>' +
            '<div>When: <span style="color:var(--atl-ink);">' + esc(range(start, end ? (info.event.allDay ? '' : end) : '', info.event.allDay)) + '</span></div>' +
            (props.location ? '<div>Where: <span style="color:var(--atl-muted);">' + esc(props.location) + '</span></div>' : '') +
            '<div>Shown as: <span style="color:var(--atl-ink);">' + esc(SHOW_AS[props.showAs] || props.showAs || 'Busy') + '</span></div>' +
            '<div>Blocks the booking form: <span style="color:' + (props.blocks ? 'var(--atl-clay)' : 'var(--atl-muted)') + ';font-weight:700;">' + (props.blocks ? 'Yes' : 'No') + '</span></div>' +
            (props.recurring ? '<div>Repeats: <span style="color:var(--atl-muted);">part of a series</span></div>' : '') +
            '</div><div class="cal-m365-fine" style="margin-top:8px;">This appointment lives in Outlook. Change or delete it there — the website only shows it.</div>' +
            '<div style="margin-top:12px;display:flex;gap:6px;flex-wrap:wrap;">' +
            (props.webLink ? '<a class="cal-m365-strip__btn" href="' + esc(props.webLink) + '" target="_blank" rel="noopener noreferrer">Open in Outlook <i class="fa-solid fa-arrow-up-right-from-square" aria-hidden="true"></i></a>' : '') +
            (props.joinUrl ? '<a class="cal-m365-strip__btn" href="' + esc(props.joinUrl) + '" target="_blank" rel="noopener noreferrer">Join online meeting</a>' : '') + '</div>';
    };

    /* ---- wiring ---- */
    var wired = false;
    window.calM365Init = function () {
        if (!wired && $('calM365Strip')) {
            wired = true;
            $('calM365Toggle').addEventListener('click', function () { togglePanel(); });
            $('calM365Run').addEventListener('click', runNow);
            $('calM365Attention').addEventListener('click', function () {
                var sel = $('calSyncFilter');
                if (sel) { sel.value = 'attention'; applySyncFilter('attention'); }
                var cal = $('calendar'); if (cal && cal.scrollIntoView) cal.scrollIntoView({ block: 'start', behavior: 'smooth' });
            });
            if ($('calSyncFilter')) $('calSyncFilter').addEventListener('change', function () { applySyncFilter(this.value); });
            setInterval(function () { var s = $('calM365Strip'); if (s && s.offsetParent !== null && document.visibilityState === 'visible') loadStatus(); }, 60000);
        }
        return loadStatus();
    };
    window.calM365RefreshStrip = loadStatus;
}());
