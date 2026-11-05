/* Notification Centre - admin side (docs-internal/notifications.md).
   (A) The bell in the top bar: unread count (red when something critical is unread), a dropdown with the latest items, polled every 30 s
       while the page is visible.
   (B) Insight -> Notifications: three views - Action required (waiting for you), Attention (expiries, deadlines, degraded things) and the
       Activity feed (what happened, chronologically) - plus Preferences. Acknowledge / resolve (with a note) / archive; read is per admin
       and never resolves anything.
   (C) Security & Audit -> System Integrity: the live health of every scheduled job, the e-mail queue and open alerts.
   (D) Browser errors on this page are reported (rate-limited) so a broken screen is not discovered only by luck.

   The server decides who sees what: a role only ever receives its own categories, so nothing here hides data - it only lays it out.
   Plain top-level code, jQuery for the section hooks, window.notificationService for feedback. */
(function () {
    'use strict';

    var POLL_MS = 30000;
    var PRIORITY_LABEL = { critical: 'Critical', high: 'High', medium: 'Medium', info: 'Info' };
    var STATUS_LABEL = { open: 'Open', acknowledged: 'Acknowledged', resolved: 'Resolved', archived: 'Archived' };
    var CATEGORY_ICON = {
        finance: 'fa-sack-dollar', bookings: 'fa-calendar-check', events: 'fa-ticket', calendar: 'fa-calendar-days', customer: 'fa-address-card',
        compliance: 'fa-certificate', system: 'fa-server', subscribers: 'fa-envelope-open-text', email: 'fa-envelope', security: 'fa-shield-halved'
    };
    var VIEWS = { ntfPanelAction: 'action', ntfPanelAttention: 'attention' };
    var listState = {
        action: { filter: 'open', category: '', q: '', from: '', to: '', page: 1 },
        attention: { filter: 'open', category: '', q: '', from: '', to: '', page: 1 }
    };
    var activityState = { category: '', severity: '', actor_type: '', q: '', from: '', to: '', page: 1 };
    var meta = null;
    var pollTimer = null;
    var lastSummary = null;

    /* ───────────────────────────── helpers ───────────────────────────── */
    function esc(s) {
        if (window.escHtml) return window.escHtml(s == null ? '' : s);
        return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }
    function toast(kind, title, msg) {
        if (window.notificationService && window.notificationService[kind]) window.notificationService[kind](title, msg);
    }
    function call(method, url, body) {
        var opts = { method: method, credentials: 'same-origin', headers: {} };
        if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
        return fetch(url, opts).then(function (res) {
            if (res.status === 204) return { status: 204, ok: true, json: {} };
            return res.json().catch(function () { return {}; }).then(function (json) { return { status: res.status, ok: res.ok, json: json || {} }; });
        });
    }
    function role() { return window.currentUserRole || 'assistant'; }
    function ago(iso) {
        var t = Date.parse(iso);
        if (!t) return '';
        var s = Math.max(0, Math.floor((Date.now() - t) / 1000));
        if (s < 60) return 'just now';
        if (s < 3600) return Math.floor(s / 60) + ' min ago';
        if (s < 86400) return Math.floor(s / 3600) + ' h ago';
        if (s < 86400 * 30) return Math.floor(s / 86400) + ' d ago';
        return new Date(t).toLocaleDateString('en-ZA', { day: 'numeric', month: 'short', year: 'numeric' });
    }
    function stamp(iso) {
        var t = Date.parse(iso);
        return t ? new Date(t).toLocaleString('en-ZA', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
    }
    function qs(obj) {
        return Object.keys(obj).filter(function (k) { return obj[k] !== '' && obj[k] != null; })
            .map(function (k) { return encodeURIComponent(k) + '=' + encodeURIComponent(obj[k]); }).join('&');
    }
    function pill(priority) {
        return '<span class="ntf-pill ntf-pill--' + esc(priority) + '">' + esc(PRIORITY_LABEL[priority] || priority) + '</span>';
    }
    function icon(category) { return '<i class="fa-solid ' + (CATEGORY_ICON[category] || 'fa-bell') + '" aria-hidden="true"></i>'; }

    /* ─────────────── opening the record a notification is about ─────────────── */
    // Only what the user's role may open: the link is followed through the nav registry (admNav.go refuses a page the role cannot see).
    function canOpen(link) {
        if (!link || !link.section) return false;
        return !window.ADMIN_NAV || window.ADMIN_NAV.canAccess(role(), link.section);
    }
    var RECORD_OPENERS = {
        eft_submission: function (id) { if (window.openEftReview) window.openEftReview(id); },
        booking: function (id) { if (window.toggleBookingDetail) window.toggleBookingDetail(id, true); },
        inquiry: function (id) { if (typeof window.openInquiry === 'function') window.openInquiry(id); }
    };
    function openTarget(n) {
        var link = n && n.link;
        if (!canOpen(link)) { toast('showInfo', 'Nothing to open', 'This notification has no page you can open.'); return; }
        closeBell();
        if (window.admNav && window.admNav.go) window.admNav.go(link.section, link.tab ? { tab: link.tab } : {});
        else if (window.switchTab) window.switchTab(link.section);
        var rec = link.record;
        if (rec && RECORD_OPENERS[rec.type] && rec.id != null) setTimeout(function () { RECORD_OPENERS[rec.type](rec.id); }, 350);
    }
    function markRead(ids, read) {
        return call('POST', '/api/admin/notifications/read', { ids: ids, read: read !== false });
    }

    /* ───────────────────────────── (A) the bell ───────────────────────────── */
    function setBadge(s) {
        var badge = document.getElementById('ntfBellBadge');
        var btn = document.getElementById('ntfBellBtn');
        if (!badge || !btn) return;
        var n = s.unread || 0;
        badge.textContent = n > 99 ? '99+' : String(n);
        badge.hidden = n === 0;
        badge.classList.toggle('ntf-bell__badge--critical', (s.critical_unread || 0) > 0);
        btn.setAttribute('aria-label', n ? ('Notifications: ' + n + ' unread' + (s.critical_unread ? ', ' + s.critical_unread + ' critical' : '')) : 'Notifications');
        var side = document.getElementById('ntfNavCount');
        if (side) { side.textContent = s.action > 99 ? '99+' : String(s.action || 0); side.hidden = !s.action; }
    }
    function renderBellMenu(s) {
        var list = document.getElementById('ntfBellList');
        var counts = document.getElementById('ntfBellCounts');
        if (!list) return;
        if (counts) {
            counts.innerHTML = '<button type="button" class="ntf-chipcount" data-ntf-go="ntfPanelAction"><strong>' + (s.action || 0) + '</strong> action required</button>' +
                '<button type="button" class="ntf-chipcount" data-ntf-go="ntfPanelAttention"><strong>' + (s.attention || 0) + '</strong> attention</button>';
        }
        var items = s.latest || [];
        if (!items.length) {
            list.innerHTML = '<div class="ntf-empty"><i class="fa-regular fa-bell-slash" aria-hidden="true"></i><p>You are all caught up.</p></div>';
            return;
        }
        list.innerHTML = items.map(function (n) {
            return '<button type="button" class="ntf-bell-item' + (n.is_read ? '' : ' ntf-bell-item--unread') + '" data-ntf-id="' + n.id + '" role="menuitem">' +
                '<span class="ntf-bell-item__icon ntf-ic--' + esc(n.priority) + '">' + icon(n.category) + '</span>' +
                '<span class="ntf-bell-item__body"><span class="ntf-bell-item__title">' + esc(n.title) + '</span>' +
                '<span class="ntf-bell-item__meta">' + pill(n.priority) + ' ' + esc(n.kind === 'action' ? 'Action required' : 'Attention') + ' · ' + esc(ago(n.last_seen_at)) +
                (n.occurrence_count > 1 ? ' · ×' + n.occurrence_count : '') + '</span></span>' +
                (n.is_read ? '' : '<span class="ntf-bell-item__dot" aria-hidden="true"></span>') + '</button>';
        }).join('');
        list.querySelectorAll('.ntf-bell-item').forEach(function (btn) {
            btn.addEventListener('click', function () {
                var n = items.filter(function (x) { return String(x.id) === btn.getAttribute('data-ntf-id'); })[0];
                if (!n) return;
                markRead([n.id]).then(refreshSummary);
                openTarget(n);
            });
        });
    }
    function refreshSummary() {
        return call('GET', '/api/admin/notifications/summary').then(function (r) {
            if (!r.ok) return;
            var prev = lastSummary;
            lastSummary = r.json;
            setBadge(r.json);
            if (bellOpen()) renderBellMenu(r.json);
            // a NEW critical item while the page is open gets a toast as well as the red badge
            if (prev && (r.json.critical_unread || 0) > (prev.critical_unread || 0)) {
                var top = (r.json.latest || []).filter(function (n) { return n.priority === 'critical' && !n.is_read; })[0];
                toast('showWarning', 'Critical alert', top ? top.title : 'A critical alert needs your attention.');
            }
        }).catch(function () {});
    }
    function startPolling() {
        if (pollTimer) return;
        refreshSummary();
        pollTimer = setInterval(function () { if (document.visibilityState === 'visible') refreshSummary(); }, POLL_MS);
        document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible') refreshSummary(); });
    }

    function bellOpen() { var m = document.getElementById('ntfBellMenu'); return !!(m && m.classList.contains('open')); }
    function positionBell(menu, btn) {
        if (window.innerWidth <= 768) { menu.style.cssText = ''; return; }   // phone: CSS bottom sheet
        var rect = btn.getBoundingClientRect();
        menu.style.position = 'fixed';
        menu.style.top = (rect.bottom + 10) + 'px';
        menu.style.right = Math.max(8, document.documentElement.clientWidth - rect.right) + 'px';
        menu.style.left = 'auto';
    }
    function openBell() {
        var menu = document.getElementById('ntfBellMenu');
        var btn = document.getElementById('ntfBellBtn');
        if (!menu || !btn) return;
        menu.classList.add('open');
        btn.setAttribute('aria-expanded', 'true');
        positionBell(menu, btn);
        if (lastSummary) renderBellMenu(lastSummary);
        refreshSummary();
    }
    function closeBell() {
        var menu = document.getElementById('ntfBellMenu');
        var btn = document.getElementById('ntfBellBtn');
        if (menu) menu.classList.remove('open');
        if (btn) btn.setAttribute('aria-expanded', 'false');
    }
    function initBell() {
        var btn = document.getElementById('ntfBellBtn');
        var menu = document.getElementById('ntfBellMenu');
        if (!btn || !menu) return;
        document.body.appendChild(menu);   // out of the top bar so no ancestor clips it (same as the account menu)
        btn.addEventListener('click', function () { if (bellOpen()) closeBell(); else openBell(); });
        document.addEventListener('click', function (e) {
            if (!bellOpen()) return;
            if (menu.contains(e.target) || btn.contains(e.target)) return;
            closeBell();
        });
        document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && bellOpen()) { closeBell(); btn.focus(); } });
        window.addEventListener('resize', function () { if (bellOpen()) positionBell(menu, btn); });
        menu.addEventListener('click', function (e) {
            var go = e.target.closest('[data-ntf-go]');
            if (go) { closeBell(); goCentre(go.getAttribute('data-ntf-go')); }
        });
        var all = document.getElementById('ntfBellReadAll');
        if (all) all.addEventListener('click', function () { call('POST', '/api/admin/notifications/read-all').then(refreshSummary); });
        startPolling();
    }
    function goCentre(panel) {
        if (window.admNav && window.admNav.go) window.admNav.go('notificationsAdmin', { tab: panel || 'ntfPanelAction' });
        else if (window.switchTab) window.switchTab('notificationsAdmin');
    }

    /* ───────────────────────── (B) the Notification Centre ───────────────────────── */
    function loadMeta() {
        if (meta) return Promise.resolve(meta);
        return call('GET', '/api/admin/notifications/meta').then(function (r) {
            meta = r.ok ? r.json : { categories: [], priorities: [] };
            var opts = '<option value="">All categories</option>' + meta.categories.map(function (c) { return '<option value="' + esc(c.category) + '">' + esc(c.label) + '</option>'; }).join('');
            document.querySelectorAll('.ntf-cat-select').forEach(function (sel) { var v = sel.value; sel.innerHTML = opts; sel.value = v; });
            return meta;
        });
    }

    function itemHtml(n) {
        var acts = [];
        var primary = (n.actions && n.actions[0] && n.actions[0].label) || 'Open';
        if (canOpen(n.link)) acts.push('<button type="button" class="atl-btn atl-btn--primary atl-btn--sm" data-ntf-act="open">' + esc(primary) + '</button>');
        if (n.status === 'open') acts.push('<button type="button" class="atl-btn atl-btn--ghost atl-btn--sm" data-ntf-act="ack">Acknowledge</button>');
        if (n.status === 'open' || n.status === 'acknowledged') acts.push('<button type="button" class="atl-btn atl-btn--ghost atl-btn--sm" data-ntf-act="resolve">Resolve</button>');
        if (n.status === 'resolved' || (n.kind === 'attention' && n.status !== 'archived')) acts.push('<button type="button" class="atl-btn atl-btn--ghost atl-btn--sm" data-ntf-act="archive">Archive</button>');
        if (n.status === 'open' || n.status === 'acknowledged') acts.push('<button type="button" class="atl-btn atl-btn--ghost atl-btn--sm" data-ntf-act="' + (n.is_read ? 'unread' : 'read') + '">' + (n.is_read ? 'Mark unread' : 'Mark read') + '</button>');

        var life = [];
        life.push('First seen ' + esc(stamp(n.first_seen_at)));
        if (n.occurrence_count > 1) life.push('happened <strong>' + n.occurrence_count + '×</strong>, last ' + esc(ago(n.last_seen_at)));
        if (n.acknowledged_at) life.push('acknowledged by ' + esc(n.acknowledged_by || 'an admin') + ' ' + esc(ago(n.acknowledged_at)));
        if (n.resolved_at) life.push((n.resolved_auto ? 'resolved automatically ' : 'resolved by ' + esc(n.resolved_by || 'an admin') + ' ') + esc(ago(n.resolved_at)));
        if (n.email_delivery) life.push('e-mail ' + esc(n.email_delivery));
        if (n.reference) life.push('ref <code>' + esc(n.reference) + '</code>');

        return '<article class="ntf-item ntf-item--' + esc(n.priority) + (n.is_read ? '' : ' ntf-item--unread') + ' ntf-item--' + esc(n.status) + '" data-ntf-id="' + n.id + '">' +
            '<div class="ntf-item__icon ntf-ic--' + esc(n.priority) + '">' + icon(n.category) + '</div>' +
            '<div class="ntf-item__main">' +
                '<div class="ntf-item__top">' + pill(n.priority) + '<span class="ntf-item__cat">' + esc(n.category_label) + '</span>' +
                    '<span class="ntf-status ntf-status--' + esc(n.status) + '">' + esc(STATUS_LABEL[n.status] || n.status) + '</span>' +
                    (n.mandatory ? '<span class="ntf-item__lock" title="A security / financial-integrity / critical alert - it cannot be switched off"><i class="fa-solid fa-lock" aria-hidden="true"></i> Mandatory</span>' : '') +
                    '<span class="ntf-item__when" title="' + esc(stamp(n.last_seen_at)) + '">' + esc(ago(n.last_seen_at)) + '</span></div>' +
                '<h3 class="ntf-item__title">' + esc(n.title) + '</h3>' +
                (n.body ? '<p class="ntf-item__body">' + esc(n.body) + '</p>' : '') +
                (n.resolution_note ? '<p class="ntf-item__note"><i class="fa-solid fa-check" aria-hidden="true"></i> ' + esc(n.resolution_note) + '</p>' : '') +
                '<p class="ntf-item__life">' + life.join(' · ') + '</p>' +
                '<div class="ntf-item__actions">' + acts.join('') + '</div>' +
                '<div class="ntf-resolve" hidden><label class="um-label" for="ntfNote' + n.id + '">What was done?' + (n.kind === 'action' ? ' (required)' : '') + '</label>' +
                    '<textarea class="um-input ntf-resolve__note" id="ntfNote' + n.id + '" rows="2" maxlength="500" placeholder="e.g. Checked the bank statement - approved."></textarea>' +
                    '<div class="ntf-resolve__btns"><button type="button" class="atl-btn atl-btn--primary atl-btn--sm" data-ntf-act="resolve-confirm">Mark resolved</button>' +
                    '<button type="button" class="atl-btn atl-btn--ghost atl-btn--sm" data-ntf-act="resolve-cancel">Cancel</button></div></div>' +
            '</div></article>';
    }

    function pager(total, page, size, kind) {
        var pages = Math.max(1, Math.ceil(total / size));
        if (pages <= 1) return '<p class="ntf-count">' + total + ' item' + (total === 1 ? '' : 's') + '</p>';
        return '<div class="ntf-pager"><span class="ntf-count">' + total + ' items · page ' + page + ' of ' + pages + '</span>' +
            '<button type="button" class="atl-btn atl-btn--ghost atl-btn--sm" data-ntf-page="' + (page - 1) + '" data-ntf-kind="' + kind + '"' + (page <= 1 ? ' disabled' : '') + '>Previous</button>' +
            '<button type="button" class="atl-btn atl-btn--ghost atl-btn--sm" data-ntf-page="' + (page + 1) + '" data-ntf-kind="' + kind + '"' + (page >= pages ? ' disabled' : '') + '>Next</button></div>';
    }

    var listCache = {};
    function loadList(view) {
        var st = listState[view];
        var box = document.getElementById('ntfList-' + view);
        if (!box) return Promise.resolve();
        box.setAttribute('aria-busy', 'true');
        return call('GET', '/api/admin/notifications?' + qs({ view: view, filter: st.filter, category: st.category, q: st.q, from: st.from, to: st.to, page: st.page, pageSize: 20 })).then(function (r) {
            box.setAttribute('aria-busy', 'false');
            if (!r.ok) { box.innerHTML = '<div class="ntf-empty">' + esc(r.json.message || 'Could not load notifications.') + '</div>'; return; }
            listCache[view] = r.json.items;
            var empty = st.filter === 'open'
                ? (view === 'action' ? 'Nothing is waiting for you. Items that need a decision or an approval appear here.' : 'Nothing needs your attention right now.')
                : 'Nothing matches these filters.';
            box.innerHTML = (r.json.items.length ? r.json.items.map(itemHtml).join('') : '<div class="ntf-empty"><i class="fa-regular fa-circle-check" aria-hidden="true"></i><p>' + empty + '</p></div>') +
                pager(r.json.total, r.json.page, r.json.pageSize, view);
        }).catch(function () { box.innerHTML = '<div class="ntf-empty">Could not reach the server.</div>'; });
    }

    function findItem(id) {
        var all = [].concat(listCache.action || [], listCache.attention || []);
        return all.filter(function (n) { return String(n.id) === String(id); })[0] || null;
    }
    function viewOfPanel(el) { var p = el.closest('.um-panel'); return p ? VIEWS[p.id] : null; }

    function onListClick(e) {
        var pg = e.target.closest('[data-ntf-page]');
        if (pg) { var k = pg.getAttribute('data-ntf-kind'); if (k === 'activity') { activityState.page = +pg.getAttribute('data-ntf-page'); loadActivity(); } else { listState[k].page = +pg.getAttribute('data-ntf-page'); loadList(k); } return; }
        var btn = e.target.closest('[data-ntf-act]');
        if (!btn) return;
        var card = btn.closest('.ntf-item');
        var id = card && card.getAttribute('data-ntf-id');
        var view = viewOfPanel(btn);
        var n = findItem(id);
        var act = btn.getAttribute('data-ntf-act');
        var reload = function () { loadList(view); refreshSummary(); };
        if (act === 'open') { if (n) { markRead([n.id]).then(refreshSummary); openTarget(n); } return; }
        if (act === 'read' || act === 'unread') { markRead([+id], act === 'read').then(reload); return; }
        if (act === 'resolve') { var box = card.querySelector('.ntf-resolve'); box.hidden = false; box.querySelector('textarea').focus(); return; }
        if (act === 'resolve-cancel') { card.querySelector('.ntf-resolve').hidden = true; return; }
        var send = function (action, body) {
            btn.disabled = true;
            return call('POST', '/api/admin/notifications/' + id + '/' + action, body).then(function (r) {
                btn.disabled = false;
                if (!r.ok) { toast('showError', 'Not changed', r.json.message || 'Please try again.'); return; }
                toast('showSuccess', action === 'ack' ? 'Acknowledged' : action === 'archive' ? 'Archived' : 'Resolved', '');
                reload();
            }).catch(function () { btn.disabled = false; toast('showError', 'Not changed', 'Could not reach the server.'); });
        };
        if (act === 'ack') send('ack');
        else if (act === 'archive') send('archive');
        else if (act === 'resolve-confirm') {
            var note = card.querySelector('.ntf-resolve__note').value.trim();
            if (n && n.kind === 'action' && note.length < 3) { toast('showWarning', 'Add a note', 'Say briefly what was done, so the history makes sense later.'); return; }
            send('resolve', { note: note });
        }
    }

    function bindToolbar(panelId, view) {
        var panel = document.getElementById(panelId);
        if (!panel || panel.getAttribute('data-ntf-bound')) return;
        panel.setAttribute('data-ntf-bound', '1');
        var st = listState[view];
        var timer = null;
        panel.addEventListener('click', function (e) {
            var chip = e.target.closest('[data-ntf-filter]');
            if (chip) {
                panel.querySelectorAll('[data-ntf-filter]').forEach(function (c) { c.classList.toggle('active', c === chip); c.setAttribute('aria-pressed', c === chip ? 'true' : 'false'); });
                st.filter = chip.getAttribute('data-ntf-filter'); st.page = 1; loadList(view);
                return;
            }
            onListClick(e);
        });
        panel.querySelectorAll('[data-ntf-field]').forEach(function (inp) {
            inp.addEventListener(inp.tagName === 'SELECT' || inp.type === 'date' ? 'change' : 'input', function () {
                st[inp.getAttribute('data-ntf-field')] = inp.value; st.page = 1;
                clearTimeout(timer); timer = setTimeout(function () { loadList(view); }, 300);
            });
        });
    }

    /* Activity feed */
    function loadActivity() {
        var body = document.getElementById('ntfActivityBody');
        if (!body) return Promise.resolve();
        return call('GET', '/api/admin/activity?' + qs({ category: activityState.category, severity: activityState.severity, actor_type: activityState.actor_type, q: activityState.q, from: activityState.from, to: activityState.to, page: activityState.page, pageSize: 50 })).then(function (r) {
            if (!r.ok) { body.innerHTML = '<tr><td colspan="5" class="ntf-empty">' + esc(r.json.message || 'Could not load the activity log.') + '</td></tr>'; return; }
            var rows = r.json.items;
            body.innerHTML = rows.length ? rows.map(function (a) {
                return '<tr><td data-label="When" title="' + esc(stamp(a.occurred_at)) + '">' + esc(stamp(a.occurred_at)) + '</td>' +
                    '<td data-label="Category">' + icon(a.category) + ' ' + esc(a.category_label) + '</td>' +
                    '<td data-label="What">' + pill(a.severity) + ' ' + esc(a.summary) + (a.reference ? ' <code class="ntf-ref">' + esc(a.reference) + '</code>' : '') + '</td>' +
                    '<td data-label="Who">' + esc(a.actor_label || ({ admin: 'An admin', client: 'A client', gateway: 'Payment gateway', system: 'System' })[a.actor_type] || a.actor_type) + '</td>' +
                    '<td data-label="Record">' + (a.entity_type ? esc(a.entity_type.replace(/_/g, ' ')) + (a.entity_id ? ' #' + esc(a.entity_id) : '') : '') + '</td></tr>';
            }).join('') : '<tr><td colspan="5" class="ntf-empty">No activity matches these filters.</td></tr>';
            var pg = document.getElementById('ntfActivityPager');
            if (pg) pg.innerHTML = pager(r.json.total, r.json.page, r.json.pageSize, 'activity');
        }).catch(function () { body.innerHTML = '<tr><td colspan="5" class="ntf-empty">Could not reach the server.</td></tr>'; });
    }
    function bindActivity() {
        var panel = document.getElementById('ntfPanelActivity');
        if (!panel || panel.getAttribute('data-ntf-bound')) return;
        panel.setAttribute('data-ntf-bound', '1');
        var timer = null;
        panel.addEventListener('click', onListClick);
        panel.querySelectorAll('[data-ntf-afield]').forEach(function (inp) {
            inp.addEventListener(inp.tagName === 'SELECT' || inp.type === 'date' ? 'change' : 'input', function () {
                activityState[inp.getAttribute('data-ntf-afield')] = inp.value; activityState.page = 1;
                clearTimeout(timer); timer = setTimeout(loadActivity, 300);
            });
        });
    }

    /* Preferences (+ administrator: recipients, threshold, rules) */
    function loadPrefs() {
        var box = document.getElementById('ntfPrefsList');
        if (!box) return;
        call('GET', '/api/admin/notification-prefs').then(function (r) {
            if (!r.ok) { box.innerHTML = '<p class="ntf-empty">Could not load your preferences.</p>'; return; }
            box.innerHTML = r.json.prefs.map(function (p) {
                return '<label class="ntf-pref"><input type="checkbox" data-ntf-pref="' + esc(p.category) + '"' + (p.in_app ? ' checked' : '') + '> ' +
                    icon(p.category) + ' <span>' + esc(p.label) + '</span></label>';
            }).join('') + '<p class="um-section-desc">' + esc(r.json.note) + '</p>';
        });
        var adminBox = document.getElementById('ntfAdminSettings');
        if (adminBox) adminBox.hidden = role() !== 'administrator';
        if (role() === 'administrator') { loadSettings(); loadRules(); }
    }
    function savePrefs() {
        var prefs = [];
        document.querySelectorAll('[data-ntf-pref]').forEach(function (c) { prefs.push({ category: c.getAttribute('data-ntf-pref'), in_app: c.checked }); });
        call('PUT', '/api/admin/notification-prefs', { prefs: prefs }).then(function (r) {
            if (r.ok) { toast('showSuccess', 'Preferences saved', ''); refreshSummary(); } else toast('showError', 'Not saved', r.json.message || 'Please try again.');
        });
    }
    function loadSettings() {
        call('GET', '/api/admin/notification-settings').then(function (r) {
            if (!r.ok) return;
            var s = r.json.settings;
            var set = function (id, v) { var el = document.getElementById(id); if (el) { if (el.type === 'checkbox') el.checked = !!v; else el.value = v; } };
            set('ntfSetEnabled', s.enabled); set('ntfSetPrimary', s.primary_email); set('ntfSetBackup', (s.backup_emails || []).join(', ')); set('ntfSetMinPriority', s.email_min_priority);
            set('ntfSetLowStock', s.low_stock_threshold);
        });
    }
    function saveSettings() {
        var errBox = document.getElementById('ntfSetErrors');
        var body = {
            enabled: document.getElementById('ntfSetEnabled').checked,
            primary_email: document.getElementById('ntfSetPrimary').value.trim(),
            backup_emails: document.getElementById('ntfSetBackup').value.split(',').map(function (x) { return x.trim(); }).filter(Boolean),
            email_min_priority: document.getElementById('ntfSetMinPriority').value,
            low_stock_threshold: parseInt(document.getElementById('ntfSetLowStock').value, 10)
        };
        call('PUT', '/api/admin/notification-settings', body).then(function (r) {
            if (r.ok) { if (errBox) errBox.textContent = ''; toast('showSuccess', 'Notification settings saved', ''); return; }
            var msgs = r.json.errors ? Object.keys(r.json.errors).map(function (k) { return r.json.errors[k]; }) : [r.json.message || 'Not saved.'];
            if (errBox) errBox.textContent = msgs.join(' ');
            toast('showError', 'Not saved', msgs.join(' '));
        });
    }
    function loadRules() {
        var body = document.getElementById('ntfRulesBody');
        if (!body) return;
        call('GET', '/api/admin/notification-rules').then(function (r) {
            if (!r.ok) { body.innerHTML = '<tr><td colspan="5">Could not load the rules.</td></tr>'; return; }
            body.innerHTML = r.json.rules.map(function (x) {
                var pr = ['', 'critical', 'high', 'medium', 'info'].map(function (p) {
                    return '<option value="' + p + '"' + ((x.priority || '') === p ? ' selected' : '') + '>' + (p ? PRIORITY_LABEL[p] : 'Default (' + PRIORITY_LABEL[x.default_priority] + ')') + '</option>';
                }).join('');
                return '<tr data-ntf-rule="' + esc(x.event_type) + '"><td data-label="Event"><code>' + esc(x.event_type) + '</code>' + (x.mandatory ? ' <i class="fa-solid fa-lock ntf-muted" title="Mandatory - cannot be switched off" aria-label="mandatory"></i>' : '') + '</td>' +
                    '<td data-label="Category">' + esc(x.category_label) + ' · ' + esc(x.kind) + '</td>' +
                    '<td data-label="On"><input type="checkbox" data-ntf-rule-field="enabled"' + (x.enabled ? ' checked' : '') + (x.mandatory ? ' disabled' : '') + ' aria-label="Enabled"></td>' +
                    '<td data-label="Priority"><select class="um-input ntf-select-sm" data-ntf-rule-field="priority" aria-label="Priority">' + pr + '</select></td>' +
                    '<td data-label="E-mail">' + (x.sends_email_by_default ? '<select class="um-input ntf-select-sm" data-ntf-rule-field="email" aria-label="E-mail"' + (x.mandatory ? ' disabled' : '') + '><option value="">By priority</option><option value="1"' + (x.email === true ? ' selected' : '') + '>Always</option><option value="0"' + (x.email === false ? ' selected' : '') + '>Never</option></select>' : '<span class="ntf-muted">In-app only</span>') + '</td></tr>';
            }).join('');
        });
    }
    function onRuleChange(e) {
        var row = e.target.closest('[data-ntf-rule]');
        if (!row) return;
        var get = function (f) { var el = row.querySelector('[data-ntf-rule-field="' + f + '"]'); return el; };
        var en = get('enabled'), pr = get('priority'), em = get('email');
        var body = { enabled: en && !en.disabled ? en.checked : null, priority: pr && pr.value ? pr.value : null, email: em && !em.disabled && em.value !== '' ? em.value === '1' : null };
        call('PUT', '/api/admin/notification-rules/' + encodeURIComponent(row.getAttribute('data-ntf-rule')), body).then(function (r) {
            if (r.ok) toast('showSuccess', 'Rule saved', ''); else { toast('showError', 'Not saved', r.json.message || ''); loadRules(); }
        });
    }

    /* Expiry dates (administrators + managers; the server refuses anyone else) */
    var expiryEditing = null;
    function loadExpiry() {
        var body = document.getElementById('ntfExpiryBody');
        if (!body) return;
        call('GET', '/api/admin/compliance-items').then(function (r) {
            if (!r.ok) { body.innerHTML = '<tr><td colspan="6" class="ntf-empty">' + esc(r.json.message || 'Could not load the expiry list.') + '</td></tr>'; return; }
            renderExpiry(r.json);
        });
    }
    function renderExpiry(data) {
        var body = document.getElementById('ntfExpiryBody');
        var sel = document.getElementById('ntfExpKind');
        if (sel && !sel.options.length) sel.innerHTML = Object.keys(data.kinds || {}).map(function (k) { return '<option value="' + esc(k) + '">' + esc(data.kinds[k]) + '</option>'; }).join('');
        window._ntfExpiryItems = data.items || [];
        body.innerHTML = (data.items || []).length ? data.items.map(function (it) {
            var d = it.days_left;
            var tone = !it.is_active ? 'blue' : d < 0 ? 'clay' : d <= 30 ? 'orange' : d <= 90 ? 'blue' : 'green';
            var state = !it.is_active ? 'Not watched' : d < 0 ? 'Expired ' + Math.abs(d) + ' day(s) ago' : d === 0 ? 'Expires today' : d + ' day(s) left';
            var actions = it.read_only ? '<span class="ntf-muted">Edit in ' + esc(it.managed_in) + '</span>'
                : '<button type="button" class="atl-btn atl-btn--ghost atl-btn--sm" data-ntf-exp-edit="' + it.id + '">Edit</button>' +
                  (role() === 'administrator' ? ' <button type="button" class="atl-btn atl-btn--ghost atl-btn--sm" data-ntf-exp-del="' + it.id + '">Delete</button>' : '');
            return '<tr><td data-label="Item">' + esc(it.name) + (it.notes ? '<br><span class="ntf-muted">' + esc(it.notes) + '</span>' : '') + '</td>' +
                '<td data-label="Type">' + esc(it.kind_label) + '</td><td data-label="Reference">' + esc(it.reference || '') + '</td>' +
                '<td data-label="Expires">' + esc(it.expiry_date) + '</td><td data-label="Status"><span class="ntf-dot ntf-dot--' + tone + '"></span> ' + esc(state) + '</td>' +
                '<td data-label="">' + actions + '</td></tr>';
        }).join('') : '<tr><td colspan="6" class="ntf-empty">Nothing is being watched yet. Add your domain, SSL certificate or tax clearance below.</td></tr>';
    }
    function expiryForm(it) {
        expiryEditing = it ? it.id : null;
        document.getElementById('ntfExpName').value = it ? it.name : '';
        document.getElementById('ntfExpKind').value = it ? it.kind : 'other';
        document.getElementById('ntfExpRef').value = it ? (it.reference || '') : '';
        document.getElementById('ntfExpDate').value = it ? it.expiry_date : '';
        document.getElementById('ntfExpNotes').value = it ? (it.notes || '') : '';
        document.getElementById('ntfExpiryFormTitle').textContent = it ? 'Edit "' + it.name + '"' : 'Add an item';
        document.getElementById('ntfExpSave').textContent = it ? 'Save changes' : 'Add item';
        document.getElementById('ntfExpCancel').hidden = !it;
        document.getElementById('ntfExpErrors').textContent = '';
    }
    function saveExpiry() {
        var payload = { name: document.getElementById('ntfExpName').value, kind: document.getElementById('ntfExpKind').value, reference: document.getElementById('ntfExpRef').value,
            expiry_date: document.getElementById('ntfExpDate').value, notes: document.getElementById('ntfExpNotes').value };
        call(expiryEditing ? 'PUT' : 'POST', '/api/admin/compliance-items' + (expiryEditing ? '/' + expiryEditing : ''), payload).then(function (r) {
            if (!r.ok) { document.getElementById('ntfExpErrors').textContent = r.json.errors ? Object.keys(r.json.errors).map(function (k) { return r.json.errors[k]; }).join(' ') : (r.json.message || 'Not saved.'); return; }
            toast('showSuccess', expiryEditing ? 'Saved' : 'Added', 'Reminders will follow the new date.');
            expiryForm(null);
            renderExpiry(r.json);
            refreshSummary();
        });
    }
    function onExpiryClick(e) {
        var ed = e.target.closest('[data-ntf-exp-edit]');
        var del = e.target.closest('[data-ntf-exp-del]');
        var find = function (id) { return (window._ntfExpiryItems || []).filter(function (x) { return String(x.id) === String(id); })[0]; };
        if (ed) { expiryForm(find(ed.getAttribute('data-ntf-exp-edit'))); document.getElementById('ntfExpName').focus(); return; }
        if (del) {
            var it = find(del.getAttribute('data-ntf-exp-del'));
            var go = function () {
                call('DELETE', '/api/admin/compliance-items/' + it.id).then(function (r) {
                    if (!r.ok) { toast('showError', 'Not deleted', r.json.message || ''); return; }
                    toast('showSuccess', 'Removed', 'Its reminders have stopped.'); renderExpiry(r.json); refreshSummary();
                });
            };
            if (window.notificationService && window.notificationService.showConfirm) {
                Promise.resolve(window.notificationService.showConfirm({ message: 'Stop watching "' + it.name + '" and delete it?', isDestructive: true })).then(function (ok) { if (ok) go(); });
            } else go();
        }
    }

    /* ───────────────────────── (C) System Integrity (live) ───────────────────────── */
    var JOB_STATUS = { ok: ['Running', 'green'], waiting: ['Waiting for first run', 'blue'], failing: ['Failing', 'clay'], stale: ['Stopped', 'clay'] };
    function loadHealth() {
        var box = document.getElementById('ntfHealthPanel');
        if (!box || role() !== 'administrator') return;
        call('GET', '/api/admin/system-health').then(function (r) {
            if (!r.ok) { box.innerHTML = '<p class="ntf-empty">Could not load system health.</p>'; return; }
            var h = r.json;
            var q = h.email_queue || {};
            var open = h.open_alerts || {};
            var pf = h.integrations && h.integrations.payfast_safety_net;
            var top = '<div class="ntf-health-tiles">' +
                tile(h.overall === 'ok' ? 'All monitored tasks healthy' : 'Something needs attention', h.overall === 'ok' ? 'green' : 'clay', 'fa-heart-pulse') +
                tile(open.critical + ' critical / ' + open.high + ' high open alerts', open.critical ? 'clay' : open.high ? 'orange' : 'green', 'fa-bell') +
                tile(q.pending + ' e-mail(s) queued · ' + q.failed_last_7_days + ' failed this week', q.failed_last_7_days ? 'orange' : 'green', 'fa-envelope') +
                (pf ? tile('PayFast safety net: ' + (pf.consecutive_failures ? pf.consecutive_failures + ' failed run(s)' : 'last checked ' + (pf.last_success_at ? ago(String(pf.last_success_at).replace(' ', 'T') + (/Z$/.test(pf.last_success_at) ? '' : 'Z')) : 'never')), pf.consecutive_failures ? 'clay' : 'green', 'fa-credit-card') : '') +
                '</div>';
            var rows = (h.jobs || []).map(function (j) {
                var st = JOB_STATUS[j.status] || [j.status, 'blue'];
                var every = j.expected_interval_s >= 86400 ? 'daily' : j.expected_interval_s >= 3600 ? 'every ' + Math.round(j.expected_interval_s / 3600) + ' h' : 'every ' + Math.max(1, Math.round(j.expected_interval_s / 60)) + ' min';
                return '<tr><td data-label="Task">' + esc(j.label) + '</td><td data-label="Runs">' + esc(every) + '</td>' +
                    '<td data-label="Status"><span class="ntf-dot ntf-dot--' + st[1] + '"></span> ' + esc(st[0]) + (j.consecutive_failures ? ' (' + j.consecutive_failures + '×)' : '') + '</td>' +
                    '<td data-label="Last run">' + esc(j.last_run_at ? ago(j.last_run_at) : '-') + '</td>' +
                    '<td data-label="Last error" class="ntf-err">' + esc(j.last_error ? j.last_error : '') + '</td></tr>';
            }).join('');
            box.innerHTML = top + '<div class="ntf-table-wrap"><table class="ntf-table"><thead><tr><th>Scheduled task</th><th>Runs</th><th>Status</th><th>Last run</th><th>Last error</th></tr></thead><tbody>' +
                (rows || '<tr><td colspan="5" class="ntf-empty">No tasks have reported yet.</td></tr>') + '</tbody></table></div>' +
                '<p class="um-section-desc">Updated ' + esc(stamp(h.generated_at)) + '. A task that fails, or stops running, also raises an alert in the Notification Centre.</p>';
        });
    }
    function tile(text, color, ic) {
        return '<div class="ntf-tile ntf-tile--' + color + '"><i class="fa-solid ' + ic + '" aria-hidden="true"></i><span>' + esc(text) + '</span></div>';
    }

    /* ───────────────────────── (D) browser-error reporting ───────────────────────── */
    var reported = {};
    var reportBudget = 10;
    function report(message, source, line) {
        var key = String(message) + '|' + source + '|' + line;
        if (reported[key] || reportBudget <= 0) return;
        reported[key] = true; reportBudget--;
        try {
            call('POST', '/api/admin/client-errors', { message: String(message || '').slice(0, 300), source: String(source || '').replace(location.origin, '').slice(0, 200), line: line || null, page: location.pathname })
                .catch(function () {});
        } catch (e) { /* never let error reporting cause an error */ }
    }
    window.addEventListener('error', function (e) {
        if (!e || !e.message || /^script error/i.test(e.message)) return;   // cross-origin noise carries no detail
        report(e.message, e.filename, e.lineno);
    });
    window.addEventListener('unhandledrejection', function (e) {
        var r = e && e.reason;
        if (!r || r.name === 'AbortError') return;
        report('Unhandled promise rejection: ' + (r.message || String(r)), (r.stack || '').split('\n')[1] || '', null);
    });

    /* ───────────────────────────── wiring ───────────────────────────── */
    function onCentreShown() {
        var expBtn = document.getElementById('ntfExpiryTabBtn');
        if (expBtn) expBtn.hidden = role() === 'assistant';   // the expiry list is for administrators and managers (the API refuses others too)
        loadMeta().then(function () {
            bindToolbar('ntfPanelAction', 'action');
            bindToolbar('ntfPanelAttention', 'attention');
            bindActivity();
            var active = document.querySelector('#notificationsAdmin .um-panel.active');
            loadPanel(active ? active.id : 'ntfPanelAction');
        });
        refreshSummary();
    }
    function loadPanel(id) {
        if (id === 'ntfPanelAction') loadList('action');
        else if (id === 'ntfPanelAttention') loadList('attention');
        else if (id === 'ntfPanelActivity') loadActivity();
        else if (id === 'ntfPanelPrefs') loadPrefs();
        else if (id === 'ntfPanelExpiry') loadExpiry();
    }

    $(document).on('shown.bs.tab', 'a[href="#notificationsAdmin"]', onCentreShown);
    $(document).on('click', '#notificationsAdmin .atl-tab-btn[data-um-tab]', function () { var id = this.getAttribute('data-um-tab'); setTimeout(function () { loadMeta().then(function () { loadPanel(id); }); }, 0); });
    $(document).on('click', '#ntfRefreshBtn', function () { var a = document.querySelector('#notificationsAdmin .um-panel.active'); loadPanel(a ? a.id : 'ntfPanelAction'); refreshSummary(); });
    $(document).on('click', '#ntfPrefsSave', savePrefs);
    $(document).on('click', '#ntfExpSave', saveExpiry);
    $(document).on('click', '#ntfExpCancel', function () { expiryForm(null); });
    $(document).on('click', '#ntfExpiryBody', onExpiryClick);
    $(document).on('click', '#ntfSetSave', saveSettings);
    $(document).on('change', '#ntfRulesBody select, #ntfRulesBody input', onRuleChange);
    $(document).on('shown.bs.tab', 'a[href="#securityAdmin"]', loadHealth);
    $(document).on('click', '#securityAdmin .atl-tab-btn[data-um-tab="secPanelIntegrity"], #ntfHealthRefresh', loadHealth);

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initBell); else initBell();

    // for the tests and other modules
    window.ntfRefreshSummary = refreshSummary;
    window.ntfLoadHealth = loadHealth;
    window.ntfOpenCentre = goCentre;
})();
