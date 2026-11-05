/* Event ticketing - admin side (docs-internal/ticketing.md). Ticketing is part of Events:
   (A) Manage tickets (its own drawer, opened from an event card or the Edit Event drawer's Tickets tab): sales status and the
       Open / Pause / Resume / Close / Reopen switch, inventory, revenue, ticket categories (price, places, on/off, order), history.
   (B) Events -> "Ticket Sales" tab: orders for an event, refunds, resending tickets, attendee CSV and the door figures.
   The server decides every permission (administrators + managers manage; every role may check in at the door) - the page only hides
   what a role can't use. Plain top-level code, jQuery, window.notificationService for feedback (no alert()). */
(function () {
    'use strict';

    var STATE_LABEL = { on_sale: 'On sale', sold_out: 'Sold out', not_started: 'Not on sale yet', ended: 'Sales ended', closed: 'Closed', paused: 'Paused' };
    var STATE_BADGE = { on_sale: 'atl-badge--paid', sold_out: 'atl-badge--cancelled', not_started: 'atl-badge--pending', ended: 'atl-badge--completed', closed: 'atl-badge--completed', paused: 'atl-badge--warning' };
    var BLOCK_TEXT = {
        not_standalone: 'This event belongs to a client booking - tickets are only sold for your own shows.',
        event_cancelled: 'This event is cancelled, so nothing is on sale.', event_postponed: 'This event is postponed, so nothing is on sale.',
        event_draft: 'This event is a draft - publish it before opening ticket sales.', event_completed: 'This event is completed.',
        event_sold_out: 'This event is marked "Sold out", so nothing is on sale.', no_date: 'Give the event a date and time before selling tickets.',
        started: 'This show has already started.'
    };

    var current = { eventId: null, data: null, editing: null };

    function esc(s) {
        if (window.escHtml) return window.escHtml(s == null ? '' : s);
        return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }
    function zar(cents) {
        var n = Number(cents) || 0;
        return 'R ' + (n / 100).toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    }
    function sast(iso) {
        if (!iso) return '';
        try { return new Date(iso).toLocaleString('en-ZA', { timeZone: 'Africa/Johannesburg', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }); }
        catch (e) { return iso; }
    }
    function toast(kind, msg) { if (window.notificationService && window.notificationService[kind]) window.notificationService[kind](msg); }
    function canManage() { return !document.body.classList.contains('role-assistant'); }
    function call(method, url, body) {
        var opts = { method: method, credentials: 'same-origin', cache: 'no-store', headers: {}, bypassInterceptor: true };
        if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
        return fetch(url, opts).then(function (res) {
            return res.json().catch(function () { return {}; }).then(function (json) { return { status: res.status, ok: res.ok, json: json || {} }; });
        });
    }

    /* ───────────────────────────── (A) Manage tickets (one event) ─────────────────────────────
       The Manage Tickets drawer (#tktManageDrawer) is where places, prices, categories and the sales switch are changed - on its own, so a
       change of places never risks a change of date or venue. The Edit Event drawer's Tickets tab only summarises and points here. */

    var mg = { eventId: null, data: null, stats: null, editing: null };

    function ask(message, destructive) {
        if (window.notificationService && window.notificationService.showConfirm) return window.notificationService.showConfirm({ message: message, isDestructive: !!destructive });
        return Promise.resolve(true);
    }
    var SALES_UI = {
        open: { badge: 'atl-badge--paid', label: 'Selling' },
        sold_out: { badge: 'atl-badge--cancelled', label: 'Sold out (every category is full)' },
        marked_sold_out: { badge: 'atl-badge--cancelled', label: 'Marked as sold out' },
        paused: { badge: 'atl-badge--warning', label: 'Paused' },
        closed: { badge: 'atl-badge--completed', label: 'Sales closed' },
        not_open: { badge: 'atl-badge--pending', label: 'Opens later' },
        ended: { badge: 'atl-badge--completed', label: 'Sales window ended' },
        blocked: { badge: 'atl-badge--completed', label: 'Not selling' },
        no_categories: { badge: 'atl-badge--pending', label: 'Not set up yet' }
    };

    // ── the Edit Event drawer's Tickets tab: a summary and the way to the real screen ──
    window.tktOpenEventTickets = function (item) {
        current = { eventId: item && item.event_id, data: null, editing: null, orig: item || null };
        // Client-booking events never sell tickets: no tab at all, so nobody wonders why it is empty.
        if (!item || !item.event_id || item.booking_id) { $('#evt-tab-tickets').hide(); return; }
        $('#evt-tab-tickets').show();
        $('#tktEventMount').html('<p class="tkt-muted">Loading tickets…</p>');
        loadEventTickets();
    };

    function loadEventTickets() {
        var id = current.eventId;
        if (!id) return Promise.resolve();
        return call('GET', '/api/admin/events/' + id + '/ticketing').then(function (r) {
            if (id !== current.eventId) return;                                  // another event was opened meanwhile
            if (!r.ok) { $('#tktEventMount').html('<p class="tkt-muted">' + esc(r.json.message || 'Could not load the tickets for this event.') + '</p>'); return; }
            current.data = r.json;
            renderEventTab();
        }).catch(function () { $('#tktEventMount').html('<p class="tkt-muted">Could not load the tickets for this event.</p>'); });
    }

    function renderEventTab() {
        var d = current.data, ui = SALES_UI[d.sales.state] || SALES_UI.blocked;
        $('#tktEventMount').html(
            '<div class="tkt-head"><div><span class="atl-badge ' + ui.badge + '">' + esc(ui.label) + '</span>' +
            '<span class="tkt-totals">' + d.totals.sold + ' sold · ' + d.totals.reserved + ' held · ' + d.totals.capacity + ' places</span></div></div>' +
            '<p class="tkt-muted">Ticket prices, places, categories and the sales switch are managed on their own screen, so changing them never touches this event\'s date, venue or description.</p>' +
            '<button type="button" class="atl-btn atl-btn--primary tkt-tab-manage" id="tktTabManage"><i class="fa-solid fa-ticket"></i> Manage tickets</button>');
    }
    $(document).on('click', '#tktTabManage', function () {
        var id = current.eventId;
        if (window.closeAtlDrawer) window.closeAtlDrawer('evtDrawer');
        setTimeout(function () { openManage(id); }, 250);
    });
    $(document).on('click', '#evt-tab-tickets', function () { loadEventTickets(); });

    // Called by js/admin/events.js before an event edit is saved. Resolves true when it may go ahead. Only an event that already has
    // tickets sold or held, and a change to something a ticket holder relies on, asks first.
    window.tktConfirmEventChange = function (next) {
        var run = function () {
            var d = current.data, o = current.orig;
            if (!d || !o || !d.totals || (d.totals.sold + d.totals.reserved) === 0) return true;
            var changes = [];
            var norm = function (v) { return String(v || '').replace(' ', 'T').slice(0, 16); };
            if (String(next.event_title || '').trim() !== String(o.event_title || '').trim()) changes.push('the title');
            if (norm(next.event_datetime) !== norm(o.event_datetime)) changes.push('the date or start time');
            if (String(next.venue_name || '').trim() !== String(o.venue_name || '').trim()) changes.push('the venue');
            if (String(next.event_status || '') !== String(o.event_status || '')) changes.push('the status (' + (o.event_status || '-') + ' → ' + next.event_status + ')');
            if ((next.event_capacity || null) !== (o.event_capacity || null)) changes.push('the event capacity');
            if (!changes.length) return true;
            var who = d.totals.sold + ' ticket' + (d.totals.sold === 1 ? '' : 's') + ' already sold' + (d.totals.reserved ? ' and ' + d.totals.reserved + ' held right now' : '');
            var extra = /cancelled|postponed/.test(next.event_status) && next.event_status !== o.event_status
                ? ' Saving stops ticket sales; refunds and notices are done from Ticket Sales.' : ' Ticket holders are not e-mailed automatically.';
            return ask('This event has ' + who + '. You are changing ' + changes.join(', ') + '.' + extra + ' Save these changes?', false);
        };
        return (current.data ? Promise.resolve() : loadEventTickets()).then(run).catch(function () { return true; });
    };

    // ── open the drawer ──
    function openManage(eventId) {
        mg = { eventId: eventId, data: null, stats: null, editing: null };
        $('#tktManageDrawerBody').html('<p class="tkt-muted">Loading…</p>');
        if (window.openAtlDrawer) window.openAtlDrawer('tktManageDrawer');
        return loadManage();
    }
    window.tktOpenManage = openManage;
    $(document).on('click', '#tktManageDrawerClose, #tktManageDrawerBackdrop', function () { if (window.closeAtlDrawer) window.closeAtlDrawer('tktManageDrawer'); refreshCards(); });
    $(document).on('click', '.evt-tkt-manage', function (e) { e.preventDefault(); openManage(Number($(this).attr('data-id'))); });

    function loadManage() {
        var id = mg.eventId;
        return Promise.all([call('GET', '/api/admin/events/' + id + '/ticketing'), call('GET', '/api/admin/ticketing/events/' + id + '/stats')]).then(function (rs) {
            if (id !== mg.eventId) return;
            if (!rs[0].ok) { $('#tktManageDrawerBody').html('<p class="tkt-muted">' + esc(rs[0].json.message || 'Could not load the tickets for this event.') + '</p>'); return; }
            mg.data = rs[0].json;
            mg.stats = rs[1].ok ? rs[1].json.stats : null;
            renderManage();
            loadHistory();
        }).catch(function () { $('#tktManageDrawerBody').html('<p class="tkt-muted">Could not load the tickets - check your connection.</p>'); });
    }
    function reloadManage() { var top = $('#tktManageDrawerBody').scrollTop(); return loadManage().then(function () { $('#tktManageDrawerBody').scrollTop(top); }); }

    // ── pieces of the screen ──
    function meter(t) {
        var cap = Math.max(t.capacity, 1);
        var pct = function (n) { return Math.max(0, Math.min(100, (n / cap) * 100)).toFixed(1) + '%'; };
        return '<div class="tkt-meter" role="img" aria-label="' + t.sold + ' sold, ' + t.reserved + ' held, ' + t.remaining + ' available of ' + t.capacity + '">' +
            '<span class="tkt-meter__sold" style="width:' + pct(t.sold) + '"></span><span class="tkt-meter__held" style="width:' + pct(t.reserved) + '"></span></div>';
    }
    function when(iso) { return iso ? esc(sast(iso)) : ''; }

    function salesPanel(d, manage) {
        var o = d.sales, ui = SALES_UI[o.state] || SALES_UI.blocked, text = '', btns = [];
        var act = function (a, label, icon, cls) { return '<button type="button" class="atl-btn ' + (cls || 'atl-btn--ghost') + ' tkt-manage tkt-sales-act" data-sales-action="' + a + '"><i class="fa-solid ' + icon + '"></i> ' + label + '</button>'; };
        switch (o.state) {
            case 'no_categories': text = 'Add a ticket type below to start selling tickets for this show.'; break;
            case 'blocked': text = BLOCK_TEXT[o.reason] || 'This event cannot sell tickets right now.'; break;
            case 'marked_sold_out':
                text = 'You marked this show as sold out, so nobody can buy. That is separate from closing sales, and tickets already sold are not affected.';
                btns.push('<button type="button" class="atl-btn atl-btn--primary tkt-manage" id="tktUnmarkSoldOut"><i class="fa-solid fa-rotate-left"></i> Remove the sold-out mark</button>');
                break;
            case 'paused':
                text = 'New buyers see "sales paused". Buyers who are already paying can still finish.';
                btns.push(act('resume', 'Resume sales', 'fa-play', 'atl-btn--primary'), act('close', 'Close sales', 'fa-lock'));
                break;
            case 'closed':
                text = o.reason === 'no_enabled' ? 'Every ticket type is switched off, so nothing is on sale.' : 'Sales were closed. Your ticket types and their settings are kept.';
                btns.push(act(o.reason === 'no_enabled' ? 'open' : 'reopen', o.reason === 'no_enabled' ? 'Open sales' : 'Reopen sales', 'fa-lock-open', 'atl-btn--primary'));
                break;
            case 'not_open':
                text = 'Sales open ' + sast(o.opens_at) + '. Nobody can buy before then.';
                btns.push(act('pause', 'Pause sales', 'fa-pause'), act('close', 'Close sales', 'fa-lock'));
                break;
            case 'ended':
                text = 'The sales window ended ' + sast(o.closes_at) + '. Change the window below to sell again.';
                btns.push(act('close', 'Close sales', 'fa-lock'));
                break;
            case 'sold_out':
                text = 'Every category is full. Add places to a category to sell more - nothing was closed.';
                btns.push(act('pause', 'Pause sales', 'fa-pause'), act('close', 'Close sales', 'fa-lock'));
                break;
            default:
                text = 'Tickets are on sale on the website.';
                btns.push(act('pause', 'Pause sales', 'fa-pause'), act('close', 'Close sales', 'fa-lock'),
                    '<button type="button" class="atl-btn atl-btn--ghost tkt-manage" id="tktMarkSoldOut"><i class="fa-solid fa-ticket-slash"></i> Mark as sold out</button>');
        }
        if (o.state === 'sold_out') btns.push('<button type="button" class="atl-btn atl-btn--ghost tkt-manage" id="tktMarkSoldOut"><i class="fa-solid fa-ticket-slash"></i> Mark as sold out</button>');
        var holds = d.holds && d.holds.orders
            ? '<p class="tkt-muted tkt-holds"><i class="fa-solid fa-hourglass-half"></i> ' + d.holds.orders + ' buyer' + (d.holds.orders === 1 ? ' is' : 's are') + ' choosing or paying right now (' + d.holds.tickets + ' ticket' + (d.holds.tickets === 1 ? '' : 's') + ' held for up to ' + d.limits.hold_minutes + ' minutes).</p>' : '';
        var win = '';
        if (manage && d.tiers.length) {
            var hasWin = d.sales.opens_local || d.sales.closes_local;
            win = '<details class="tkt-window tkt-manage"' + (hasWin ? ' open' : '') + '><summary>Sales window <span class="tkt-muted">(optional)</span></summary>' +
                '<form id="tktWindowForm" class="tkt-grid" novalidate><label>Sales open<input class="um-input" type="datetime-local" name="opens_at" value="' + esc(d.sales.opens_local) + '"></label>' +
                '<label>Sales close<input class="um-input" type="datetime-local" name="closes_at" value="' + esc(d.sales.closes_local) + '"></label>' +
                '<p class="tkt-hint tkt-wide">South African time. Blank means no limit. This applies to the whole show; each ticket type can also have its own dates.</p>' +
                '<p class="tkt-form-error tkt-wide" role="alert"></p>' +
                '<div class="tkt-editor__actions tkt-wide"><button type="submit" class="atl-btn atl-btn--primary">Save window</button></div></form></details>';
        }
        return '<section class="tkt-panel" aria-labelledby="tktSalesHd"><div class="tkt-panel__head"><h6 class="tkt-h" id="tktSalesHd">Ticket sales</h6><span class="atl-badge ' + ui.badge + '">' + esc(ui.label) + '</span></div>' +
            '<p class="tkt-muted">' + esc(text) + '</p>' + holds + (btns.length ? '<div class="tkt-sales-btns">' + btns.join('') + '</div>' : '') + win + '</section>';
    }

    function inventoryPanel(d) {
        var s = mg.stats, t = (s && s.totals) || { allocated: d.totals.capacity, sold: d.totals.sold, reserved: d.totals.reserved, available: Math.max(0, d.totals.capacity - d.totals.sold - d.totals.reserved), committed_pct: 0 };
        var door = s && s.door ? s.door : { checked_in: 0, valid: 0 };
        var evCap = d.event.event_capacity;
        var alloc = evCap ? 'Event capacity ' + evCap + (t.allocated > evCap ? ' - over-allocated!' : ' · ' + (evCap - t.allocated) + ' not yet given to a ticket type') : 'No overall event limit';
        var tiles = [
            tile('fa-layer-group', 'Allocated', String(t.allocated), alloc),
            tile('fa-ticket', 'Sold', String(t.sold), (s && s.comp_tickets ? s.comp_tickets + ' complimentary' : 'verified payments only')),
            tile('fa-hourglass-half', 'Held', String(t.reserved), 'buyers paying now'),
            tile('fa-circle-check', 'Available', String(t.available), 'left to sell'),
            tile('fa-door-open', 'Checked in', door.checked_in + ' <small>of ' + door.valid + '</small>', door.valid ? Math.round(100 * door.checked_in / door.valid) + '% at the door' : 'no tickets yet')
        ];
        var bar = meter({ capacity: t.allocated, sold: t.sold, reserved: t.reserved, remaining: t.available });
        return '<section class="tkt-panel" aria-labelledby="tktInvHd"><div class="tkt-panel__head"><h6 class="tkt-h" id="tktInvHd">Ticket inventory</h6>' +
            '<span class="tkt-muted">' + (t.allocated ? t.committed_pct + '% of places sold or held' : '') + '</span></div>' +
            '<div class="tkt-stat-grid tkt-stat-grid--sm">' + tiles.join('') + '</div>' + bar + '</section>';
    }

    function revenuePanel() {
        var s = mg.stats;
        if (!s || s.gross_cents === undefined) return '';
        var tiles = [
            tile('fa-sack-dollar', 'Gross ticket sales', esc(zar(s.gross_cents)), 'every confirmed payment'),
            tile('fa-circle-check', 'Successful payments', esc(zar(s.revenue_cents + s.refund_due_cents)), s.paid_orders + ' paid order' + (s.paid_orders === 1 ? '' : 's')),
            tile('fa-hourglass-half', 'Pending payments', esc(zar(s.pending_cents)), (s.pending_payment_orders || 0) + ' waiting for PayFast'),
            tile('fa-circle-xmark', 'Failed payments', esc(zar(s.failed_cents)), (s.failed_orders || 0) + ' failed'),
            tile('fa-rotate-left', 'Refunds', esc(zar(s.refunded_cents + s.refund_due_cents)), s.refund_due_cents ? zar(s.refund_due_cents) + ' still to refund' : (s.refunded_orders || 0) + ' refunded'),
            tile('fa-scale-balanced', 'Net ticket revenue', esc(zar(s.net_cents)), 'gross − refunds')
        ];
        return '<section class="tkt-panel" aria-labelledby="tktRevHd"><div class="tkt-panel__head"><h6 class="tkt-h" id="tktRevHd">Revenue</h6></div><div class="tkt-stat-grid tkt-stat-grid--sm">' + tiles.join('') + '</div></section>';
    }

    function categoryTable(d) {
        if (!d.tiers.length) return '';
        var tot = { c: 0, s: 0, r: 0, a: 0 };
        var rows = d.tiers.map(function (t) {
            tot.c += t.capacity; tot.s += t.sold; tot.r += t.reserved; tot.a += t.remaining;
            return '<tr><th scope="row">' + esc(t.name) + (t.is_active ? '' : ' <span class="tkt-muted">(off)</span>') + '</th><td class="tkt-num">' + esc(zar(t.price_cents)) + '</td><td class="tkt-num">' + t.capacity +
                '</td><td class="tkt-num">' + t.sold + '</td><td class="tkt-num">' + t.reserved + '</td><td class="tkt-num">' + t.remaining + '</td></tr>';
        }).join('');
        return '<div class="tkt-tablewrap"><table class="table tkt-table tkt-table--cats"><caption class="tkt-sr">Ticket categories</caption><thead><tr><th scope="col">Category</th><th scope="col" class="tkt-num">Price</th><th scope="col" class="tkt-num">Allocated</th>' +
            '<th scope="col" class="tkt-num">Sold</th><th scope="col" class="tkt-num">Reserved</th><th scope="col" class="tkt-num">Available</th></tr></thead><tbody>' + rows +
            '</tbody><tfoot><tr><th scope="row">Total</th><td></td><td class="tkt-num">' + tot.c + '</td><td class="tkt-num">' + tot.s + '</td><td class="tkt-num">' + tot.r + '</td><td class="tkt-num">' + tot.a + '</td></tr></tfoot></table></div>';
    }

    function categoryCard(t, idx, n, manage) {
        var committed = t.sold + t.reserved;
        var window_ = (t.sales_start ? 'From ' + esc(sast(t.sales_start)) : 'On sale now') + (t.sales_end ? ' · until ' + esc(sast(t.sales_end)) : ' · until the show starts');
        var stateBadge = t.is_active ? '<span class="atl-badge ' + (STATE_BADGE[t.state] || '') + '">' + esc(STATE_LABEL[t.state] || t.state) + '</span>' : '<span class="atl-badge atl-badge--completed">Switched off</span>';
        var cap = manage ? '<div class="tkt-cap tkt-manage" data-id="' + t.id + '" data-orig="' + t.capacity + '" data-committed="' + committed + '">' +
            '<label class="tkt-cap__label" for="tktCap' + t.id + '">Places for sale</label><div class="tkt-cap__ctl">' +
            '<button type="button" class="atl-btn atl-btn--ghost tkt-cap-step" data-step="-10" aria-label="Remove 10 places">−10</button>' +
            '<button type="button" class="atl-btn atl-btn--ghost tkt-cap-step" data-step="-1" aria-label="Remove 1 place">−1</button>' +
            '<input id="tktCap' + t.id + '" class="um-input tkt-cap__input" type="number" inputmode="numeric" min="' + Math.max(1, committed) + '" max="' + d_max() + '" step="1" value="' + t.capacity + '">' +
            '<button type="button" class="atl-btn atl-btn--ghost tkt-cap-step" data-step="1" aria-label="Add 1 place">+1</button>' +
            '<button type="button" class="atl-btn atl-btn--ghost tkt-cap-step" data-step="10" aria-label="Add 10 places">+10</button>' +
            '<button type="button" class="atl-btn atl-btn--primary tkt-cap-save" disabled>Save places</button></div>' +
            '<p class="tkt-hint">At least ' + committed + ' (' + t.sold + ' sold' + (t.reserved ? ' + ' + t.reserved + ' held' : '') + '). Existing orders are never changed.</p></div>' : '';
        return '<li class="tkt-tier" data-id="' + t.id + '">' +
            '<div class="tkt-tier__top"><strong class="tkt-tier__name">' + esc(t.name) + '</strong><span class="tkt-price">' + zar(t.price_cents) + '</span>' + stateBadge + '</div>' +
            (t.description ? '<div class="tkt-tier__sub">' + esc(t.description) + '</div>' : '') +
            meter(t) +
            '<div class="tkt-tier__sub">' + t.sold + ' sold · ' + t.reserved + ' held · ' + t.remaining + ' available of ' + t.capacity + ' · max ' + t.max_per_order + ' per order</div>' +
            '<div class="tkt-tier__sub">' + window_ + '</div>' + cap +
            (manage ? '<div class="tkt-tier__actions tkt-manage">' +
                '<button type="button" class="atl-btn atl-btn--ghost tkt-edit" data-id="' + t.id + '"><i class="fa-solid fa-pen"></i> Edit</button>' +
                '<button type="button" class="atl-btn atl-btn--ghost tkt-toggle" data-id="' + t.id + '" data-on="' + (t.is_active ? 1 : 0) + '"><i class="fa-solid ' + (t.is_active ? 'fa-eye-slash' : 'fa-eye') + '"></i> ' + (t.is_active ? 'Switch off' : 'Switch on') + '</button>' +
                '<button type="button" class="atl-btn atl-btn--ghost tkt-move" data-dir="-1" data-id="' + t.id + '"' + (idx === 0 ? ' disabled' : '') + ' aria-label="Move ' + esc(t.name) + ' up"><i class="fa-solid fa-arrow-up"></i></button>' +
                '<button type="button" class="atl-btn atl-btn--ghost tkt-move" data-dir="1" data-id="' + t.id + '"' + (idx === n - 1 ? ' disabled' : '') + ' aria-label="Move ' + esc(t.name) + ' down"><i class="fa-solid fa-arrow-down"></i></button>' +
                (t.sold || t.reserved ? '' : '<button type="button" class="atl-btn atl-btn--ghost tkt-delete" data-id="' + t.id + '"><i class="fa-solid fa-trash"></i> Delete</button>') + '</div>' : '') +
            '<div class="tkt-editor-slot"></div></li>';
    }
    function d_max() { return (mg.data && mg.data.limits && mg.data.limits.max_capacity) || 100000; }

    function renderManage() {
        var d = mg.data, manage = canManage(), ev = d.event;
        var h = '';
        h += '<div class="tkt-evstrip"><div><h4 class="tkt-evstrip__title">' + esc(ev.title) + '</h4><p class="tkt-muted">' + esc(ev.starts_label) + (ev.venue_name ? ' · ' + esc(ev.venue_name) : '') + ' · ' + esc(ev.event_status || '') + '</p></div>' +
            '<div class="tkt-evstrip__links"><button type="button" class="atl-btn atl-btn--ghost tkt-manage" id="tktMgEditEvent"><i class="fa-solid fa-pen"></i> Edit event details</button>' +
            (ev.event_status !== 'draft' ? '<a class="atl-btn atl-btn--ghost" href="/e/' + ev.event_id + '" target="_blank" rel="noopener"><i class="fa-solid fa-arrow-up-right-from-square"></i> View on site</a>' : '') + '</div></div>';
        h += salesPanel(d, manage);
        h += inventoryPanel(d);
        h += revenuePanel();
        if (d.capacity_warning) h += '<p class="tkt-warn">' + esc(d.capacity_warning) + '</p>';
        h += '<section class="tkt-panel" aria-labelledby="tktCatHd"><div class="tkt-panel__head"><h6 class="tkt-h" id="tktCatHd">Ticket categories</h6></div>';
        if (!d.tiers.length) h += '<p class="tkt-muted">No ticket types yet. Add one (for example General, Early Bird or VIP) to sell tickets for this show on the website.</p>';
        h += categoryTable(d);
        h += '<ul class="tkt-tiers">' + d.tiers.map(function (t, i) { return categoryCard(t, i, d.tiers.length, manage); }).join('') + '</ul>';
        if (manage) h += '<div class="tkt-add tkt-manage"><button type="button" class="atl-btn atl-btn--ghost" id="tktAddTier"><i class="fa-solid fa-plus"></i> Add ticket type</button><div class="tkt-editor-slot" id="tktNewSlot"></div></div>';
        h += '</section>';
        h += '<section class="tkt-panel" aria-labelledby="tktGoHd"><div class="tkt-panel__head"><h6 class="tkt-h" id="tktGoHd">Sales, attendees and the door</h6></div><div class="tkt-sales-btns">' +
            '<button type="button" class="atl-btn atl-btn--ghost tkt-goto" data-focus="sales"><i class="fa-solid fa-chart-line"></i> View sales &amp; orders</button>' +
            '<button type="button" class="atl-btn atl-btn--ghost tkt-goto" data-focus="attendees"><i class="fa-solid fa-users"></i> Manage attendees</button>' +
            (manage ? '<a class="atl-btn atl-btn--ghost" href="/api/admin/ticketing/events/' + ev.event_id + '/attendees.csv"><i class="fa-solid fa-file-csv"></i> Attendee list (CSV)</a>' : '') +
            '<a class="atl-btn atl-btn--ghost" href="/checkin?event=' + ev.event_id + '" target="_blank" rel="noopener"><i class="fa-solid fa-qrcode"></i> Door check-in</a></div></section>';
        if (manage) h += '<section class="tkt-panel" aria-labelledby="tktHistHd"><div class="tkt-panel__head"><h6 class="tkt-h" id="tktHistHd">Ticketing change history</h6></div><ul class="tkt-list tkt-list--small" id="tktHistoryList"><li class="tkt-muted">Loading…</li></ul></section>';
        $('#tktManageDrawerTitle').text('Manage tickets');
        $('#tktManageDrawerBody').html(h);
    }

    function loadHistory() {
        var id = mg.eventId;
        if (!canManage()) return;
        call('GET', '/api/admin/events/' + id + '/ticketing-history').then(function (r) {
            if (id !== mg.eventId) return;
            var rows = r.ok ? (r.json.history || []) : [];
            $('#tktHistoryList').html(rows.length ? rows.map(function (x) {
                return '<li>' + esc(sast(String(x.at).replace(' ', 'T') + 'Z')) + ' · <strong>' + esc(x.who) + '</strong> · ' + esc(x.what) + '</li>';
            }).join('') : '<li class="tkt-muted">No ticketing changes recorded yet.</li>');
        }).catch(function () {});
    }

    // ── sales switch ──
    $(document).on('click', '#tktManageDrawer .tkt-sales-act', function () {
        var action = $(this).attr('data-sales-action');
        var holds = mg.data.holds || { orders: 0 };
        var buyers = holds.orders ? ' ' + holds.orders + ' buyer' + (holds.orders === 1 ? ' is' : 's are') + ' choosing or paying right now; they can still finish what they started, but nobody new can start.' : '';
        var q = { pause: 'Pause ticket sales? New buyers will see "sales paused" until you resume.' + buyers, close: 'Close ticket sales? New buyers will see that sales are closed until you reopen them.' + buyers }[action];
        var go = function () {
            var $b = $('#tktManageDrawer .tkt-sales-act').prop('disabled', true);
            call('POST', '/api/admin/events/' + mg.eventId + '/ticket-sales', { action: action }).then(function (r) {
                $b.prop('disabled', false);
                toast(r.ok ? 'showSuccess' : 'showError', r.json.message || (r.ok ? 'Done.' : 'Could not change ticket sales.'));
                reloadManage();
            }).catch(function () { $b.prop('disabled', false); toast('showError', 'Could not change ticket sales - check your connection.'); });
        };
        if (q) ask(q, action === 'close').then(function (ok) { if (ok) go(); }); else go();
    });
    function soldOut(mark) {
        call('POST', '/api/admin/events/' + mg.eventId + '/sold-out', { mark: mark }).then(function (r) {
            toast(r.ok ? 'showSuccess' : 'showError', r.json.message || (r.ok ? 'Done.' : 'Could not change that.'));
            reloadManage();
        });
    }
    $(document).on('click', '#tktMarkSoldOut', function () {
        ask('Mark this show as sold out? Nobody will be able to buy, and the website will say "Sold out". Tickets already sold are not affected. (To stop sales for now without saying sold out, use Close sales instead.)', true).then(function (ok) { if (ok) soldOut(true); });
    });
    $(document).on('click', '#tktUnmarkSoldOut', function () { soldOut(false); });

    $(document).on('submit', '#tktWindowForm', function (e) {
        e.preventDefault();
        var $f = $(this), $b = $f.find('button[type=submit]').prop('disabled', true);
        call('PUT', '/api/admin/events/' + mg.eventId + '/ticket-sales-window', { opens_at: $f.find('[name=opens_at]').val(), closes_at: $f.find('[name=closes_at]').val() }).then(function (r) {
            $b.prop('disabled', false);
            if (!r.ok) { $f.find('.tkt-form-error').text(r.json.message || 'Could not save the window.'); return; }
            toast('showSuccess', r.json.message);
            reloadManage();
        }).catch(function () { $b.prop('disabled', false); $f.find('.tkt-form-error').text('Could not save - check your connection.'); });
    });

    $(document).on('click', '#tktMgEditEvent', function () {
        var id = mg.eventId;
        if (window.closeAtlDrawer) window.closeAtlDrawer('tktManageDrawer');
        setTimeout(function () { if (window.openEvtEditDrawer) window.openEvtEditDrawer(id); }, 250);
    });
    $(document).on('click', '#tktManageDrawer .tkt-goto', function () {
        var id = mg.eventId, focus = $(this).attr('data-focus');
        if (window.closeAtlDrawer) window.closeAtlDrawer('tktManageDrawer');
        window.tktOpenSales(id, focus);
    });
    // From an event card (Sales / Attendees) or the Manage screen: the Ticket Sales tab with this event chosen.
    window.tktOpenSales = function (eventId, focus) {
        sales.wantEvent = eventId;
        sales.wantFocus = focus || null;
        $('#eventsAdmin [data-um-tab="evtPanelTickets"]').trigger('click');
    };

    // ── places: quick adjust ──
    function capInput($cap) { return $cap.find('.tkt-cap__input'); }
    function capDirty($cap) {
        var v = Number(capInput($cap).val()), orig = Number($cap.attr('data-orig'));
        $cap.find('.tkt-cap-save').prop('disabled', !(Number.isInteger(v) && v !== orig));
    }
    $(document).on('click', '#tktManageDrawer .tkt-cap-step', function () {
        var $cap = $(this).closest('.tkt-cap'), $in = capInput($cap);
        var min = Math.max(1, Number($cap.attr('data-committed')));
        var v = (Number($in.val()) || 0) + Number($(this).attr('data-step'));
        $in.val(Math.max(min, Math.min(d_max(), v)));
        capDirty($cap);
    });
    $(document).on('input', '#tktManageDrawer .tkt-cap__input', function () { capDirty($(this).closest('.tkt-cap')); });
    $(document).on('keydown', '#tktManageDrawer .tkt-cap__input', function (e) { if (e.key === 'Enter') { e.preventDefault(); $(this).closest('.tkt-cap').find('.tkt-cap-save:not(:disabled)').trigger('click'); } });
    $(document).on('click', '#tktManageDrawer .tkt-cap-save', function () {
        var $cap = $(this).closest('.tkt-cap'), id = Number($cap.attr('data-id')), orig = Number($cap.attr('data-orig')), next = Number(capInput($cap).val());
        var t = (mg.data.tiers || []).filter(function (x) { return x.id === id; })[0] || { name: 'this ticket type' };
        var go = function () {
            var $b = $cap.find('.tkt-cap-save').prop('disabled', true);
            call('POST', '/api/admin/ticket-types/' + id + '/capacity', { capacity: next }).then(function (r) {
                toast(r.ok ? 'showSuccess' : 'showError', r.json.message || (r.ok ? 'Saved.' : 'Could not change the places.'));
                if (r.ok) reloadManage(); else $b.prop('disabled', false);
            }).catch(function () { $b.prop('disabled', false); toast('showError', 'Could not save - check your connection.'); });
        };
        if (next < orig) ask('Reduce ' + t.name + ' from ' + orig + ' to ' + next + ' places? That is ' + (orig - next) + ' fewer tickets to sell. Tickets already sold or held are not affected.', true).then(function (ok) { if (ok) go(); });
        else go();
    });

    // ── category: switch on/off, reorder, delete ──
    $(document).on('click', '#tktManageDrawer .tkt-toggle', function () {
        var id = Number($(this).attr('data-id')), turnOn = $(this).attr('data-on') !== '1';
        var t = (mg.data.tiers || []).filter(function (x) { return x.id === id; })[0] || { name: 'This ticket type' };
        var go = function () {
            call('POST', '/api/admin/ticket-types/' + id + '/enabled', { enabled: turnOn }).then(function (r) {
                toast(r.ok ? 'showSuccess' : 'showError', r.json.message || (r.ok ? 'Done.' : 'Could not change that.'));
                reloadManage();
            });
        };
        if (turnOn) go(); else ask('Switch off "' + t.name + '"? New buyers will not see it. Orders already made, and buyers already paying for it, are not affected.', false).then(function (ok) { if (ok) go(); });
    });
    $(document).on('click', '#tktManageDrawer .tkt-move', function () {
        var id = Number($(this).attr('data-id')), dir = Number($(this).attr('data-dir'));
        var ids = (mg.data.tiers || []).map(function (t) { return t.id; });
        var i = ids.indexOf(id), j = i + dir;
        if (i < 0 || j < 0 || j >= ids.length) return;
        ids.splice(j, 0, ids.splice(i, 1)[0]);
        call('POST', '/api/admin/events/' + mg.eventId + '/ticket-types/reorder', { order: ids }).then(function (r) {
            if (!r.ok) { toast('showError', r.json.message || 'Could not save the order.'); return; }
            reloadManage().then(function () { $('#tktManageDrawer .tkt-move[data-id="' + id + '"][data-dir="' + dir + '"]:not(:disabled)').trigger('focus'); });
        });
    });
    $(document).on('click', '#tktManageDrawer .tkt-delete', function () {
        var id = Number($(this).attr('data-id'));
        var go = function () {
            call('DELETE', '/api/admin/ticket-types/' + id).then(function (r) {
                if (!r.ok) { toast('showError', r.json.message || 'Could not delete this ticket type.'); return; }
                toast('showSuccess', r.json.message || 'Deleted.');
                reloadManage();
            });
        };
        ask('Delete this ticket type? It has never been ordered, so nothing else changes.', true).then(function (ok) { if (ok) go(); });
    });

    // ── category: the full editor (name, price, description, per-order limit, dates, on/off) ──
    function editorHtml(t) {
        var v = t || { name: '', description: '', price: '', capacity: '', max_per_order: 10, sales_start_local: '', sales_end_local: '', is_active: true };
        var lim = (mg.data && mg.data.limits) || { max_per_order: 20 };
        return '<form class="tkt-editor um-form" novalidate>' +
            '<div class="tkt-grid">' +
            '<label class="tkt-wide">Name<input class="um-input" name="name" maxlength="60" required value="' + esc(v.name) + '" placeholder="e.g. General, Early Bird, VIP"></label>' +
            '<label>Price (R)<input class="um-input" name="price" inputmode="decimal" required value="' + esc(v.price) + '" placeholder="150.00"></label>' +
            '<label>Places<input class="um-input" name="capacity" type="number" min="1" step="1" required value="' + esc(v.capacity) + '"></label>' +
            '<label>Max per order<input class="um-input" name="max_per_order" type="number" min="1" max="' + lim.max_per_order + '" step="1" value="' + esc(v.max_per_order) + '"></label>' +
            '<label>Sales open<input class="um-input" name="sales_start" type="datetime-local" value="' + esc(v.sales_start_local) + '"></label>' +
            '<label>Sales close<input class="um-input" name="sales_end" type="datetime-local" value="' + esc(v.sales_end_local) + '"></label>' +
            '<label class="tkt-wide">Description (optional)<textarea class="um-input" name="description" rows="2" maxlength="300">' + esc(v.description || '') + '</textarea></label>' +
            '<label class="tkt-check tkt-wide"><input type="checkbox" name="is_active"' + (v.is_active ? ' checked' : '') + '> On sale (when the event and the dates allow)</label>' +
            '</div>' +
            '<p class="tkt-hint">Leave "Sales open" blank to sell straight away and "Sales close" blank to sell until the show starts (South African time). A price change only affects new orders - orders already made keep the price they were sold at.</p>' +
            '<p class="tkt-form-error" role="alert"></p>' +
            '<div class="tkt-editor__actions"><button type="button" class="atl-btn atl-btn--ghost tkt-cancel">Cancel</button>' +
            '<button type="submit" class="atl-btn atl-btn--primary">' + (t ? 'Save changes' : 'Add ticket type') + '</button></div></form>';
    }
    function openEditor($slot, tier) {
        $('#tktManageDrawer .tkt-editor').remove();
        mg.editing = tier ? tier.id : 'new';
        $slot.html(editorHtml(tier));
        var $first = $slot.find('input[name="name"]').trigger('focus');
        if ($slot[0] && $slot[0].scrollIntoView) $slot[0].scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        return $first;
    }
    $(document).on('click', '#tktAddTier', function () { openEditor($('#tktNewSlot'), null); });
    $(document).on('click', '#tktManageDrawer .tkt-edit', function () {
        var id = Number($(this).data('id'));
        var tier = (mg.data.tiers || []).filter(function (t) { return t.id === id; })[0];
        if (tier) openEditor($(this).closest('.tkt-tier').find('.tkt-editor-slot'), tier);
    });
    $(document).on('click', '#tktManageDrawer .tkt-cancel', function () { $(this).closest('.tkt-editor').remove(); mg.editing = null; });

    $(document).on('submit', '#tktManageDrawer .tkt-editor', function (e) {
        e.preventDefault();
        var $f = $(this);
        var body = {
            name: $f.find('[name="name"]').val(), price: $f.find('[name="price"]').val(), capacity: Number($f.find('[name="capacity"]').val()),
            max_per_order: Number($f.find('[name="max_per_order"]').val()), sales_start: $f.find('[name="sales_start"]').val(), sales_end: $f.find('[name="sales_end"]').val(),
            description: $f.find('[name="description"]').val(), is_active: $f.find('[name="is_active"]').is(':checked')
        };
        var isNew = mg.editing === 'new';
        var url = isNew ? '/api/admin/events/' + mg.eventId + '/ticket-types' : '/api/admin/ticket-types/' + mg.editing;
        var before = isNew ? null : (mg.data.tiers || []).filter(function (t) { return t.id === mg.editing; })[0];
        var save = function () {
            var $btn = $f.find('button[type="submit"]').prop('disabled', true);
            call(isNew ? 'POST' : 'PUT', url, body).then(function (r) {
                $btn.prop('disabled', false);
                if (!r.ok) { $f.find('.tkt-form-error').text(r.json.message || 'Could not save this ticket type.'); return; }
                toast('showSuccess', r.json.message || 'Saved.');
                mg.editing = null;
                return reloadManage();
            }).catch(function () { $btn.prop('disabled', false); $f.find('.tkt-form-error').text('Could not save - check your connection and try again.'); });
        };
        // A price change or a cut in places on a category people have already bought / are buying: say plainly what it does and does not do.
        var warn = [];
        if (before) {
            var newCents = Math.round(parseFloat(String(body.price).replace(/[^0-9.,]/g, '').replace(',', '.')) * 100);
            if ((before.sold || before.reserved) && Number.isFinite(newCents) && newCents !== before.price_cents) warn.push('Change the price of ' + before.name + ' from ' + zar(before.price_cents) + ' to ' + zar(newCents) + '? It applies to NEW buyers only - the ' + (before.sold + before.reserved) + ' ticket(s) already sold or held keep the old price.');
            if (body.capacity < before.capacity) warn.push((warn.length ? 'Also reduce' : 'Reduce') + ' places from ' + before.capacity + ' to ' + body.capacity + '? Tickets already sold or held are not affected.');
        }
        if (warn.length) ask(warn.join(' '), false).then(function (ok) { if (ok) save(); }); else save();
    });

    // ── event cards (Events list): Manage tickets / Sales / Attendees ──
    var cardCache = { at: 0, map: null };
    function refreshCards() { cardCache.at = 0; decorateCards(); }
    function decorateCards() {
        var $cards = $('.atl-event-card');
        if (!$cards.length) return;
        var apply = function (map) {
            $cards.each(function () {
                var id = Number($(this).attr('data-id')), e = map[id];
                var $line = $(this).find('.evt-tkt-line'), $only = $(this).find('.evt-tkt-needs');
                if (!e) { $line.prop('hidden', true).empty(); $only.prop('hidden', true); return; }
                var label = e.sales_control === 'paused' ? 'Paused' : e.sales_control === 'closed' ? 'Sales closed' : String(e.event_status).toLowerCase() === 'sold_out' ? 'Marked sold out' : (e.allocated && e.sold >= e.allocated ? 'Sold out' : '');
                $line.html('<i class="fa-solid fa-ticket"></i> <strong>' + e.sold + '</strong> of ' + e.allocated + ' sold' + (e.reserved ? ' · ' + e.reserved + ' held' : '') + (label ? ' · <span class="evt-tkt-flag">' + esc(label) + '</span>' : '')).prop('hidden', false);
                $only.prop('hidden', false);
            });
        };
        if (cardCache.map && Date.now() - cardCache.at < 15000) { apply(cardCache.map); return; }
        call('GET', '/api/admin/ticketing/events').then(function (r) {
            if (!r.ok) return;
            var map = {};
            (r.json.events || []).forEach(function (e) { map[e.event_id] = e; });
            cardCache = { at: Date.now(), map: map };
            apply(map);
        }).catch(function () {});
    }
    window.tktDecorateEventCards = decorateCards;
    $(document).on('click', '.evt-tkt-sales', function (e) { e.preventDefault(); window.tktOpenSales(Number($(this).attr('data-id')), 'sales'); });
    $(document).on('click', '.evt-tkt-attendees', function (e) { e.preventDefault(); window.tktOpenSales(Number($(this).attr('data-id')), 'attendees'); });

    /* ───────────────────────────── (B) Events -> Ticket Sales ───────────────────────────── */

    var ORDER_LABEL = { pending: 'Waiting for payment', paid: 'Paid', expired: 'Expired', failed: 'Failed', refunded: 'Refunded' };
    var ORDER_BADGE = { pending: 'atl-badge--pending', paid: 'atl-badge--paid', expired: 'atl-badge--completed', failed: 'atl-badge--cancelled', refunded: 'atl-badge--warning' };
    var sales = { eventId: null, events: [], page: 1, pages: 1, wantEvent: null, wantFocus: null, order: null };
    var pager = window.Pagination ? new window.Pagination({
        mode: 'prevnext', container: '#tktPager', prevEl: '#tktPrev', nextEl: '#tktNext', infoEl: '#tktPageInfo', pageSize: 25,
        getPage: function () { return sales.page; }, infoFormat: function (from, to, total) { return from + '–' + to + ' of ' + total + ' orders'; }
    }) : null;

    function orderBadge(o) {
        if (o.status === 'paid' && o.refund_required) return '<span class="atl-badge atl-badge--overdue">Refund needed</span>';
        if (o.complimentary) return o.status === 'refunded' ? '<span class="atl-badge atl-badge--cancelled">Cancelled</span>' : '<span class="atl-badge atl-badge--info">Complimentary</span>';
        return '<span class="atl-badge ' + (ORDER_BADGE[o.status] || '') + '">' + esc(ORDER_LABEL[o.status] || o.status) + '</span>';
    }

    // The Ticket Sales tab hides the event search bar above the tabs (it filters event cards, not orders).
    $(document).on('click', '#eventsAdmin [data-um-tab]', function () {
        var onTickets = $(this).attr('data-um-tab') === 'evtPanelTickets';
        $('#eventsAdmin').toggleClass('tkt-mode', onTickets);
        if (onTickets) loadSalesEvents();
    });

    function loadSalesEvents() {
        return call('GET', '/api/admin/ticketing/events').then(function (r) {
            if (!r.ok) { $('#tktSalesEmpty').text(r.json.message || 'Could not load the events.').prop('hidden', false); $('#tktSalesBody').prop('hidden', true); return; }
            sales.events = r.json.events || [];
            if (!sales.events.length) { $('#tktSalesEmpty').prop('hidden', false); $('#tktSalesBody').prop('hidden', true); $('#tktSalesEvent').empty(); return; }
            $('#tktSalesEmpty').prop('hidden', true);
            // default: the one asked for, else the one already shown, else the next show coming up, else the most recent
            var now = Date.now();
            var upcoming = sales.events.filter(function (e) { return e.event_datetime && Date.parse(e.event_datetime) >= now; })
                .sort(function (a, b) { return Date.parse(a.event_datetime) - Date.parse(b.event_datetime); });
            var pick = sales.wantEvent || sales.eventId || (upcoming[0] && upcoming[0].event_id) || sales.events[0].event_id;
            sales.wantEvent = null;
            $('#tktSalesEvent').html(sales.events.map(function (e) {
                return '<option value="' + e.event_id + '"' + (e.event_id === Number(pick) ? ' selected' : '') + '>' + esc(e.event_title) + (e.starts_label ? ' · ' + esc(e.starts_label) : '') + ' (' + e.sold + ' sold)</option>';
            }).join(''));
            selectEvent(Number($('#tktSalesEvent').val()));
            var focus = sales.wantFocus; sales.wantFocus = null;
            if (focus === 'attendees') setTimeout(function () { var el = document.getElementById('tktOrderSearch'); if (el) { el.scrollIntoView({ block: 'center', behavior: 'smooth' }); el.focus({ preventScroll: true }); } }, 400);
        });
    }

    function selectEvent(id) {
        sales.eventId = id;
        sales.page = 1;
        $('#tktSalesBody').prop('hidden', false);
        $('#tktCsvLink').attr('href', '/api/admin/ticketing/events/' + id + '/attendees.csv');
        $('#tktOrdersCsvLink').attr('href', '/api/admin/ticketing/events/' + id + '/orders.csv');
        $('#tktDoorLink').attr('href', '/checkin?event=' + id);
        loadStats();
        if (canManage()) { loadOrders(); $('#tktDoorPassNew').prop('hidden', true).empty(); loadDoorPasses(); }
    }
    $(document).on('change', '#tktSalesEvent', function () { selectEvent(Number($(this).val())); });
    $(document).on('click', '#tktSalesRefresh', function () { loadStats(); if (canManage()) loadOrders(); });

    function tile(icon, label, value, sub) {
        return '<div class="db-stat-card tkt-stat"><div class="db-stat-icon"><i class="fa-solid ' + icon + '"></i></div><div class="db-stat-content">' +
            '<span class="db-stat-label">' + esc(label) + '</span><span class="db-stat-value">' + value + '</span>' + (sub ? '<span class="tkt-stat__sub">' + esc(sub) + '</span>' : '') + '</div></div>';
    }

    function loadStats() {
        var id = sales.eventId;
        return call('GET', '/api/admin/ticketing/events/' + id + '/stats').then(function (r) {
            if (id !== sales.eventId) return;
            if (!r.ok) { $('#tktStatGrid').html('<p class="tkt-muted">' + esc(r.json.message || 'Could not load the figures.') + '</p>'); return; }
            var s = r.json.stats;
            sales.tiers = s.tiers;
            $('#tktCompTier').html(s.tiers.map(function (t) { return '<option value="' + t.id + '">' + esc(t.name) + ' (' + Math.max(0, t.capacity - t.sold - t.reserved) + ' left)</option>'; }).join(''));
            var sold = s.tiers.reduce(function (n, t) { return n + t.sold; }, 0);
            var cap = s.tiers.reduce(function (n, t) { return n + t.capacity; }, 0);
            var held = s.tiers.reduce(function (n, t) { return n + t.reserved; }, 0);
            var tiles = [];
            if (s.revenue_cents !== undefined) tiles.push(tile('fa-sack-dollar', 'Ticket revenue', esc(zar(s.revenue_cents)), s.refunded_cents ? zar(s.refunded_cents) + ' refunded' : 'from paid orders'));
            tiles.push(tile('fa-ticket', 'Tickets sold', sold + ' <small>of ' + cap + '</small>', (s.comp_tickets ? s.comp_tickets + ' complimentary · ' : '') + (held ? held + ' held right now' : (cap - sold) + ' left')));
            tiles.push(tile('fa-door-open', 'Checked in', s.door.checked_in + ' <small>of ' + s.door.valid + '</small>', s.door.valid ? Math.round(100 * s.door.checked_in / s.door.valid) + '% at the door' : 'no tickets yet'));
            if (s.refund_due_orders) tiles.push(tile('fa-rotate-left', 'Refund needed', String(s.refund_due_orders), 'paid after the tickets sold out'));
            $('#tktStatGrid').html(tiles.join(''));
            renderEventNotice(s);
            $('#tktTierTable').html('<table class="table tkt-table tkt-table--tiers"><thead><tr><th>Ticket type</th>' + (s.revenue_cents !== undefined ? '<th>Price</th>' : '') +
                '<th>Sold</th><th>Held</th><th>Checked in</th><th class="tkt-col-bar"><span class="tkt-sr">Sold, held and left</span></th></tr></thead><tbody>' + s.tiers.map(function (t) {
                    return '<tr><td><strong>' + esc(t.name) + '</strong>' + (t.is_active ? '' : ' <span class="tkt-muted">(closed)</span>') + '</td>' +
                        (t.price_cents !== undefined ? '<td class="tkt-num">' + esc(zar(t.price_cents)) + '</td>' : '') +
                        '<td class="tkt-num">' + t.sold + ' / ' + t.capacity + '</td><td class="tkt-num">' + t.reserved + '</td><td class="tkt-num">' + t.checked_in + ' / ' + t.sold + '</td>' +
                        '<td class="tkt-col-bar">' + meter({ capacity: t.capacity, sold: t.sold, reserved: t.reserved, remaining: Math.max(0, t.capacity - t.sold - t.reserved) }) + '</td></tr>';
                }).join('') + '</tbody></table>');
        });
    }

    // A cancelled / postponed show: what is left to do for its ticket holders, and the one button that tells them (once each).
    function renderEventNotice(s) {
        $('#tktEventNotice').remove();
        var kind = s.event_status;
        if ((kind !== 'cancelled' && kind !== 'postponed') || !s.notice || !s.notice.total) return;
        var left = s.notice.total - s.notice.sent;
        var what = kind === 'cancelled'
            ? 'This show is <strong>cancelled</strong>. Every paid order needs a refund: refund each one in the PayFast dashboard, then mark it refunded (filter the list by <em>Paid</em>) - the buyer is e-mailed when you do.'
            : 'This show is <strong>postponed</strong>. Tickets stay valid; tell the holders, and e-mail them again once the new date is set.';
        var told = s.notice.sent + ' of ' + s.notice.total + ' ticket holder' + (s.notice.total === 1 ? '' : 's') + ' told';
        $('#tktStatGrid').before('<div class="tkt-warn tkt-notice" id="tktEventNotice"><p>' + what + '</p><p class="tkt-notice__row"><span>' + told + '</span>' +
            (left > 0 && canManage() ? '<button type="button" class="atl-btn atl-btn--primary" id="tktNotifyHolders"><i class="fa-solid fa-paper-plane"></i> E-mail ' + left + ' ticket holder' + (left === 1 ? '' : 's') + '</button>' : '') +
            '</p></div>');
    }
    $(document).on('click', '#tktNotifyHolders', function () {
        var $b = $(this);
        var go = function () {
            $b.prop('disabled', true);
            call('POST', '/api/admin/ticketing/events/' + sales.eventId + '/notify-holders').then(function (r) {
                toast(r.ok ? 'showSuccess' : 'showError', r.json.message || (r.ok ? 'Sent.' : 'Could not send.'));
                loadStats();
            });
        };
        if (window.notificationService && window.notificationService.showConfirm) {
            window.notificationService.showConfirm({ message: 'E-mail every ticket holder of this show who has not been told yet? Each buyer is e-mailed once.' }).then(function (ok) { if (ok) go(); });
        } else { go(); }
    });

    function loadOrders() {
        var id = sales.eventId;
        var q = $('#tktOrderSearch').val() || '';
        var status = $('#tktOrderStatus').val() || '';
        $('#tktOrdersBody').html('<tr><td colspan="7" class="tkt-empty">Loading…</td></tr>');
        var url = '/api/admin/ticketing/orders?event_id=' + id + '&page=' + sales.page + '&page_size=25' + (status ? '&status=' + encodeURIComponent(status) : '') + (q ? '&q=' + encodeURIComponent(q) : '');
        return call('GET', url).then(function (r) {
            if (id !== sales.eventId) return;
            if (!r.ok) { $('#tktOrdersBody').html('<tr><td colspan="7" class="tkt-empty">' + esc(r.json.message || 'Could not load the orders.') + '</td></tr>'); return; }
            sales.pages = r.json.pages;
            if (pager) pager.render(r.json.total, r.json.pages);
            if (!r.json.items.length) { $('#tktOrdersBody').html('<tr><td colspan="7" class="tkt-empty">' + (q || status ? 'No orders match.' : 'No orders for this event yet.') + '</td></tr>'); return; }
            $('#tktOrdersBody').html(r.json.items.map(function (o) {
                return '<tr class="tkt-order-row" data-id="' + o.id + '"><td class="tkt-num">#' + o.id + '</td>' +
                    '<td><span class="tkt-buyer">' + esc(o.buyer_name || '-') + '</span><span class="tkt-sub">' + esc(o.buyer_email || '') + '</span></td>' +
                    '<td class="tkt-num">' + o.ticket_count + '</td><td class="tkt-num">' + esc(zar(o.total_cents)) + '</td>' +
                    '<td>' + orderBadge(o) + '</td><td class="tkt-sub">' + esc(sast(o.paid_at || o.created_at)) + '</td>' +
                    '<td><button type="button" class="atl-btn atl-btn--ghost tkt-order-open" data-id="' + o.id + '">View</button></td></tr>';
            }).join(''));
        });
    }
    var reloadOrders = window.debounce ? window.debounce(function () { sales.page = 1; loadOrders(); }, 300) : function () { sales.page = 1; loadOrders(); };
    $(document).on('input', '#tktOrderSearch', reloadOrders);
    $(document).on('change', '#tktOrderStatus', function () { sales.page = 1; loadOrders(); });
    $(document).on('click', '#tktPrev', function () { if (sales.page > 1) { sales.page--; loadOrders(); } });
    $(document).on('click', '#tktNext', function () { if (sales.page < sales.pages) { sales.page++; loadOrders(); } });

    // ── the order drawer ──
    $(document).on('click', '.tkt-order-open', function (e) { e.stopPropagation(); openOrder(Number($(this).attr('data-id'))); });
    $(document).on('click', '.tkt-order-row', function () { openOrder(Number($(this).attr('data-id'))); });
    $(document).on('click', '#tktOrderDrawerClose, #tktOrderDrawerBackdrop', function () { if (window.closeAtlDrawer) window.closeAtlDrawer('tktOrderDrawer'); });

    function openOrder(id) {
        $('#tktOrderDrawerTitle').text('Order #' + id);
        $('#tktOrderDrawerBody').html('<p class="tkt-muted">Loading…</p>');
        if (window.openAtlDrawer) window.openAtlDrawer('tktOrderDrawer');
        return call('GET', '/api/admin/ticketing/orders/' + id).then(function (r) {
            if (!r.ok) { $('#tktOrderDrawerBody').html('<p class="tkt-muted">' + esc(r.json.message || 'Could not load the order.') + '</p>'); return; }
            sales.order = r.json;
            renderOrder();
        });
    }

    function renderOrder() {
        var d = sales.order, o = d.order;
        var html = '<div class="tkt-order">';
        html += '<div class="tkt-order__head">' + orderBadge(o) + '<span class="tkt-price">' + esc(zar(o.total_cents)) + '</span></div>';
        if (o.status === 'paid' && o.refund_required) html += '<p class="tkt-warn">This payment arrived after the hold ended and the tickets had sold out - no tickets were issued. Refund it in the PayFast dashboard, then mark it refunded below.</p>';
        html += '<dl class="tkt-kv"><dt>Buyer</dt><dd>' + esc(o.buyer_name || '-') + '</dd><dt>Email</dt><dd>' + esc(o.buyer_email || '-') + '</dd><dt>Phone</dt><dd>' + esc(o.buyer_phone || '-') + '</dd>' +
            '<dt>Show</dt><dd>' + esc(d.event ? d.event.title : '') + '</dd>' +
            '<dt>Ordered</dt><dd>' + esc(sast(o.created_at)) + '</dd>' + (o.paid_at ? '<dt>' + (o.complimentary ? 'Issued' : 'Paid') + '</dt><dd>' + esc(sast(o.paid_at)) + '</dd>' : '') +
            (o.gateway_payment_id ? '<dt>PayFast id</dt><dd class="tkt-mono">' + esc(o.gateway_payment_id) + '</dd>' : '') +
            (o.tickets_emailed_at ? '<dt>Tickets emailed</dt><dd>' + esc(sast(o.tickets_emailed_at)) + '</dd>' : '') +
            (o.consent_at ? '<dt>POPIA consent</dt><dd>' + esc(sast(o.consent_at)) + ' (' + esc(o.consent_policy_version || '') + ')</dd>' : '') +
            (o.terms_version ? '<dt>Ticket terms</dt><dd class="tkt-mono">' + esc(o.terms_version) + '</dd>' : '') +
            (d.issue && d.issue.complimentary ? '<dt>Complimentary</dt><dd>' + esc(d.issue.comp_note || '') + (d.issue.issued_by_name ? ' - issued by ' + esc(d.issue.issued_by_name) : '') + '</dd>' : '') +
            (o.refunded_at ? '<dt>' + (o.complimentary ? 'Cancelled' : 'Refunded') + '</dt><dd>' + esc(sast(o.refunded_at)) + (o.refunded_by_name ? ' by ' + esc(o.refunded_by_name) : '') + (o.refund_note ? ' - ' + esc(o.refund_note) : '') + '</dd>' : '') +
            '</dl>';
        html += '<h6 class="tkt-h">Tickets</h6>' + (d.tickets.length ? '<ul class="tkt-list">' + d.tickets.map(function (t) {
            var st = t.voided_at ? '<span class="atl-badge atl-badge--cancelled">Void</span>' : t.checked_in_at ? '<span class="atl-badge atl-badge--paid">In at ' + esc(sast(t.checked_in_at)) + '</span>' : '<span class="atl-badge atl-badge--pending">Not yet in</span>';
            var undo = t.checked_in_at && !t.voided_at && canManage() ? ' <button type="button" class="tkt-linkbtn tkt-undo" data-token="' + esc(t.token) + '">Undo check-in</button>' : '';
            var canReissue = o.status === 'paid' && !o.refund_required && !t.voided_at && !t.checked_in_at && canManage();
            var reissue = canReissue ? ' <button type="button" class="tkt-linkbtn tkt-reissue" data-token="' + esc(t.token) + '" data-holder="' + esc(t.holder_name || '') + '">Void &amp; reissue</button>' : '';
            var story = (d.issue && d.issue.voids || []).filter(function (v) { return v.id === t.id; })[0];
            return '<li data-ticket-row="' + esc(t.token) + '"><strong>' + esc(t.tier_name) + '</strong> · ' + esc(t.holder_name || o.buyer_name || '') + ' ' + st + undo + reissue +
                (t.checked_in_by_name ? '<span class="tkt-sub">checked in by ' + esc(t.checked_in_by_name) + '</span>' : '') +
                (story ? '<span class="tkt-sub">voided ' + esc(sast(story.voided_at)) + (story.voided_by_name ? ' by ' + esc(story.voided_by_name) : '') + ' - ' + esc(story.void_reason) + (story.replaced_by ? ' · reissued' : '') + '</span>' : '') + '</li>';
        }).join('') + '</ul>' : '<p class="tkt-muted">No tickets were issued for this order.</p>');
        html += '<h6 class="tkt-h">Lines</h6><ul class="tkt-list">' + d.items.map(function (i) { return '<li>' + i.quantity + ' × ' + esc(i.name) + ' <span class="tkt-price">' + esc(zar(i.unit_price_cents * i.quantity)) + '</span></li>'; }).join('') + '</ul>';
        if (d.notifications.length) {
            html += '<h6 class="tkt-h">PayFast notifications</h6><ul class="tkt-list tkt-list--small">' + d.notifications.map(function (n) {
                return '<li>' + esc(sast(n.received_at)) + ' · ' + esc(n.source === 'reconcile' ? 'safety net' : 'notification') + ' · ' + esc(n.payment_status || '') + ' · <span class="' + (n.verified ? '' : 'tkt-muted') + '">' + esc(String(n.outcome || '').replace(/_/g, ' ')) + '</span></li>';
            }).join('') + '</ul>';
        }
        if (o.status === 'paid') {
            html += '<div class="tkt-order__actions">' +
                (!o.refund_required && o.buyer_email ? '<button type="button" class="atl-btn atl-btn--ghost" id="tktResend"><i class="fa-solid fa-paper-plane"></i> Resend tickets</button>' : '') +
                (!o.refund_required ? '<a class="atl-btn atl-btn--ghost" href="/api/public/ticket-orders/' + encodeURIComponent(o.public_reference) + '/tickets.pdf" target="_blank" rel="noopener"><i class="fa-solid fa-file-pdf"></i> Tickets PDF</a>' : '') +
                '<button type="button" class="atl-btn atl-btn--ghost tkt-danger" id="tktRefundStart"><i class="fa-solid fa-rotate-left"></i> ' + (o.complimentary ? 'Cancel these tickets' : 'Mark as refunded') + '</button></div>' +
                (o.complimentary
                    ? '<div class="tkt-refund" id="tktRefundBox" hidden><label for="tktRefundNote">Why are they cancelled?</label>' +
                      '<input id="tktRefundNote" class="um-input" maxlength="300" placeholder="e.g. Guest cannot come">' +
                      '<p class="tkt-hint">The codes stop working at the door and the seats are free again. Nobody is e-mailed.</p>' +
                      '<div class="tkt-editor__actions"><button type="button" class="atl-btn atl-btn--ghost" id="tktRefundCancel">Keep them</button><button type="button" class="atl-btn atl-btn--primary tkt-danger-solid" id="tktRefundGo">Cancel tickets</button></div></div>'
                    : '<div class="tkt-refund" id="tktRefundBox" hidden><label for="tktRefundNote">How was it refunded?</label>' +
                      '<input id="tktRefundNote" class="um-input" maxlength="300" placeholder="e.g. Refunded in the PayFast dashboard on 30 Oct">' +
                      '<label class="tkt-check-line"><input type="checkbox" id="tktRefundNotify" checked> E-mail the buyer that the refund was made</label>' +
                      '<p class="tkt-hint">Refund the money in the PayFast dashboard first. Marking it here makes its tickets stop working at the door and puts the places back on sale.</p>' +
                      '<div class="tkt-editor__actions"><button type="button" class="atl-btn atl-btn--ghost" id="tktRefundCancel">Cancel</button><button type="button" class="atl-btn atl-btn--primary tkt-danger-solid" id="tktRefundGo">Mark refunded</button></div></div>');
        }
        html += '</div>';
        $('#tktOrderDrawerBody').html(html);
    }

    // Undo a mistaken check-in: asks why (kept in the audit log), then the ticket can be scanned again.
    $(document).on('click', '.tkt-undo', function () {
        var token = $(this).attr('data-token');
        var ask = window.notificationService && window.notificationService.showPrompt
            ? window.notificationService.showPrompt({ title: 'Undo check-in', message: 'Why is this check-in being undone? (kept in the audit log)', placeholder: 'e.g. scanned the wrong ticket' })
            : Promise.resolve(window.prompt('Why is this check-in being undone?'));
        ask.then(function (reason) {
            if (reason == null) return;
            call('POST', '/api/admin/ticketing/tickets/' + encodeURIComponent(token) + '/undo-check-in', { reason: reason }).then(function (r) {
                toast(r.ok ? 'showSuccess' : 'showError', r.json.message || (r.ok ? 'Undone.' : 'Could not undo it.'));
                if (r.ok) { openOrder(sales.order.order.id); loadStats(); }
            });
        });
    });

    // ── door links: a per-show check-in link for a volunteer (no portal account). The link itself is shown ONCE, when made. ──
    function doorPassState(p) {
        if (p.revoked_at) return { cls: 'off', text: 'Switched off' };
        if (Date.parse(p.expires_at) <= Date.now()) return { cls: 'off', text: 'Expired' };
        return { cls: 'on', text: 'Works until ' + sast(p.expires_at) };
    }
    function loadDoorPasses() {
        var id = sales.eventId;
        return call('GET', '/api/admin/ticketing/events/' + id + '/door-passes').then(function (r) {
            if (id !== sales.eventId || !r.ok) return;
            var list = r.json.passes || [];
            $('#tktDoorPassList').html(list.length ? list.map(function (p) {
                var st = doorPassState(p);
                return '<li class="tkt-doorpass tkt-doorpass--' + st.cls + '"><div><p class="tkt-doorpass__label">' + esc(p.label) + '</p>' +
                    '<p class="tkt-muted">' + esc(st.text) + ' · ' + p.check_ins + ' checked in' + (p.last_used_at ? ' · last used ' + esc(sast(p.last_used_at)) : ' · not used yet') +
                    (p.created_by_name ? ' · made by ' + esc(p.created_by_name) : '') + '</p></div>' +
                    (st.cls === 'on' ? '<button type="button" class="atl-btn atl-btn--ghost tkt-doorpass-off" data-id="' + p.id + '" data-label="' + esc(p.label) + '"><i class="fa-solid fa-ban"></i> Switch off</button>' : '') + '</li>';
            }).join('') : '<li class="tkt-muted">No door links for this show yet.</li>');
        });
    }
    $(document).on('submit', '#tktDoorPassForm', function (e) {
        e.preventDefault();
        var $b = $(this).find('button[type=submit]').prop('disabled', true);
        call('POST', '/api/admin/ticketing/events/' + sales.eventId + '/door-passes', { label: $('#tktDoorPassLabel').val() }).then(function (r) {
            $b.prop('disabled', false);
            if (!r.ok) { toast('showError', r.json.message || 'Could not create the door link.'); return; }
            $('#tktDoorPassLabel').val('');
            $('#tktDoorPassNew').html('<div class="tkt-doorpass-new" role="status">' +
                '<p><strong>Door link for "' + esc(r.json.pass.label) + '" is ready.</strong> Send it to the volunteer now (WhatsApp is fine), or let them scan this code with their phone. ' +
                'It is shown only this once - if it is lost, switch it off and make a new one.</p>' +
                '<div class="tkt-doorpass-new__row"><img class="tkt-doorpass-new__qr" src="' + esc(r.json.qr) + '" alt="QR code that opens the door link" width="160" height="160">' +
                '<div class="tkt-doorpass-new__link"><label class="tkt-muted" for="tktDoorPassUrl">Door link</label>' +
                '<input type="text" id="tktDoorPassUrl" class="atl-input" readonly value="' + esc(r.json.link) + '">' +
                '<button type="button" class="atl-btn atl-btn--primary" id="tktDoorPassCopy"><i class="fa-regular fa-copy"></i> Copy link</button></div></div></div>').prop('hidden', false);
            loadDoorPasses();
        }).catch(function () { $b.prop('disabled', false); toast('showError', 'Could not create the door link - check your connection.'); });
    });
    $(document).on('click', '#tktDoorPassCopy', function () {
        var input = document.getElementById('tktDoorPassUrl');
        var done = function () { toast('showSuccess', 'Door link copied.'); };
        if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(input.value).then(done, function () { input.select(); });
        else { input.select(); try { document.execCommand('copy'); done(); } catch (err) {} }
    });
    $(document).on('click', '.tkt-doorpass-off', function () {
        var id = Number($(this).attr('data-id'));
        var go = function () {
            call('DELETE', '/api/admin/ticketing/events/' + sales.eventId + '/door-passes/' + id).then(function (r) {
                toast(r.ok ? 'showSuccess' : 'showError', r.json.message || (r.ok ? 'Switched off.' : 'Could not switch it off.'));
                $('#tktDoorPassNew').prop('hidden', true).empty();
                loadDoorPasses();
            });
        };
        if (window.notificationService && window.notificationService.showConfirm) {
            window.notificationService.showConfirm({ message: 'Switch off the door link "' + $(this).attr('data-label') + '"? It stops working on that phone straight away. Check-ins already made stay.', isDestructive: true }).then(function (ok) { if (ok) go(); });
        } else go();
    });

    // ── void & reissue one ticket (lost phone, forwarded QR, wrong name): a small form under the ticket ──
    $(document).on('click', '.tkt-reissue', function () {
        $('#tktReissueBox').remove();
        var token = $(this).attr('data-token');
        var o = sales.order.order;
        $(this).closest('li').append('<div class="tkt-refund tkt-reissue-box" id="tktReissueBox" data-token="' + esc(token) + '">' +
            '<label for="tktReissueReason">Why?</label><input id="tktReissueReason" class="um-input" maxlength="300" placeholder="e.g. lost phone, QR was forwarded, name change">' +
            '<label for="tktReissueName" style="margin-top:10px;">Name on the new ticket</label><input id="tktReissueName" class="um-input" maxlength="120" value="' + esc($(this).attr('data-holder')) + '">' +
            (o.buyer_email ? '<label class="tkt-check-line"><input type="checkbox" id="tktReissueSend" checked> E-mail the new ticket to ' + esc(o.buyer_email) + '</label>' : '') +
            '<p class="tkt-hint">The old code stops working at the door straight away. The seat count does not change.</p>' +
            '<p class="tkt-form-error" role="alert"></p>' +
            '<div class="tkt-editor__actions"><button type="button" class="atl-btn atl-btn--ghost" id="tktReissueCancel">Cancel</button><button type="button" class="atl-btn atl-btn--primary" id="tktReissueGo">Void &amp; reissue</button></div></div>');
        $('#tktReissueReason').trigger('focus');
    });
    $(document).on('click', '#tktReissueCancel', function () { $('#tktReissueBox').remove(); });
    $(document).on('click', '#tktReissueGo', function () {
        var $box = $('#tktReissueBox'), $b = $(this).prop('disabled', true);
        call('POST', '/api/admin/ticketing/tickets/' + encodeURIComponent($box.attr('data-token')) + '/reissue', {
            reason: $('#tktReissueReason').val(), holder_name: $('#tktReissueName').val(), send_email: $('#tktReissueSend').length ? $('#tktReissueSend').is(':checked') : false
        }).then(function (r) {
            $b.prop('disabled', false);
            if (!r.ok) { $box.find('.tkt-form-error').text(r.json.message || 'Could not reissue it.'); return; }
            toast('showSuccess', r.json.message);
            openOrder(sales.order.order.id);
        }).catch(function () { $b.prop('disabled', false); $box.find('.tkt-form-error').text('Connection problem - try again.'); });
    });

    // ── guest list: issue complimentary tickets ──
    $(document).on('submit', '#tktCompForm', function (e) {
        e.preventDefault();
        var $b = $(this).find('button[type=submit]').prop('disabled', true);
        $('#tktCompError').text('');
        call('POST', '/api/admin/ticketing/events/' + sales.eventId + '/complimentary', {
            ticket_type_id: Number($('#tktCompTier').val()), quantity: Number($('#tktCompQty').val()), guest_name: $('#tktCompName').val(),
            guest_email: $('#tktCompEmail').val(), guest_phone: $('#tktCompPhone').val(), note: $('#tktCompNote').val(), send_email: $('#tktCompSend').is(':checked')
        }).then(function (r) {
            $b.prop('disabled', false);
            if (!r.ok) { $('#tktCompError').text(r.json.message || 'Could not issue the tickets.'); return; }
            toast('showSuccess', r.json.message);
            $('#tktCompName, #tktCompEmail, #tktCompPhone, #tktCompNote').val('');
            $('#tktCompQty').val('1');
            loadStats();
            loadOrders();
        }).catch(function () { $b.prop('disabled', false); $('#tktCompError').text('Connection problem - try again.'); });
    });

    $(document).on('click', '#tktResend', function () {
        var $b = $(this).prop('disabled', true);
        call('POST', '/api/admin/ticketing/orders/' + sales.order.order.id + '/resend').then(function (r) {
            $b.prop('disabled', false);
            toast(r.ok ? 'showSuccess' : 'showError', r.json.message || (r.ok ? 'Sent.' : 'Could not resend.'));
        });
    });
    $(document).on('click', '#tktRefundStart', function () { $('#tktRefundBox').prop('hidden', false); $('#tktRefundNote').trigger('focus'); });
    $(document).on('click', '#tktRefundCancel', function () { $('#tktRefundBox').prop('hidden', true); });
    $(document).on('click', '#tktRefundGo', function () {
        var $b = $(this).prop('disabled', true);
        var id = sales.order.order.id;
        call('POST', '/api/admin/ticketing/orders/' + id + '/refund', { note: $('#tktRefundNote').val(), notify: $('#tktRefundNotify').length ? $('#tktRefundNotify').is(':checked') : false }).then(function (r) {
            $b.prop('disabled', false);
            if (!r.ok) { toast('showError', r.json.message || 'Could not mark it refunded.'); return; }
            toast('showSuccess', r.json.message);
            openOrder(id);
            loadStats();
            loadOrders();
        });
    });
})();
