/* Event ticketing - admin side (docs-internal/ticketing.md). Ticketing is part of Events:
   (A) the event drawer's "Tickets" tab: this event's ticket types (tiers), what is sold / held / left, and the Open / Close sales switch.
   (B) Events -> "Ticket Sales" tab: orders for an event, refunds, resending tickets, attendee CSV and the door figures.
   The server decides every permission (administrators + managers manage; every role may check in at the door) - the page only hides
   what a role can't use. Plain top-level code, jQuery, window.notificationService for feedback (no alert()). */
(function () {
    'use strict';

    var STATE_LABEL = { on_sale: 'On sale', sold_out: 'Sold out', not_started: 'Not on sale yet', ended: 'Sales ended', closed: 'Closed' };
    var STATE_BADGE = { on_sale: 'atl-badge--paid', sold_out: 'atl-badge--cancelled', not_started: 'atl-badge--pending', ended: 'atl-badge--completed', closed: 'atl-badge--completed' };
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

    /* ───────────────────────────── (A) the event drawer's Tickets tab ───────────────────────────── */

    // Called by js/admin/events.js applyEventToEditor() for every event opened in the drawer.
    window.tktOpenEventTickets = function (item) {
        current = { eventId: item && item.event_id, data: null, editing: null };
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
            renderEventTickets();
        }).catch(function () { $('#tktEventMount').html('<p class="tkt-muted">Could not load the tickets for this event.</p>'); });
    }

    function meter(t) {
        var cap = Math.max(t.capacity, 1);
        var pct = function (n) { return Math.max(0, Math.min(100, (n / cap) * 100)).toFixed(1) + '%'; };
        return '<div class="tkt-meter" role="img" aria-label="' + t.sold + ' sold, ' + t.reserved + ' held, ' + t.remaining + ' left of ' + t.capacity + '">' +
            '<span class="tkt-meter__sold" style="width:' + pct(t.sold) + '"></span><span class="tkt-meter__held" style="width:' + pct(t.reserved) + '"></span></div>';
    }

    function renderEventTickets() {
        var d = current.data;
        var manage = canManage();
        var html = '';
        html += '<div class="tkt-head">' +
            '<div><span class="atl-badge ' + (d.sales_open && d.can_sell ? 'atl-badge--paid' : 'atl-badge--completed') + '">' + (d.sales_open && d.can_sell ? 'Sales open' : 'Sales closed') + '</span>' +
            '<span class="tkt-totals">' + d.totals.sold + ' sold · ' + d.totals.reserved + ' held · ' + d.totals.capacity + ' places</span></div>' +
            (manage && d.tiers.length ? '<button type="button" class="atl-btn ' + (d.sales_open ? 'atl-btn--ghost' : 'atl-btn--primary') + ' tkt-manage" id="tktSalesToggle"' + (!d.can_sell && !d.sales_open ? ' disabled' : '') + '>' +
                (d.sales_open ? '<i class="fa-solid fa-lock"></i> Close sales' : '<i class="fa-solid fa-lock-open"></i> Open sales') + '</button>' : '') +
            '</div>';
        if (d.block_reason) html += '<p class="tkt-warn">' + esc(BLOCK_TEXT[d.block_reason] || 'This event cannot sell tickets right now.') + '</p>';
        if (d.capacity_warning) html += '<p class="tkt-warn">' + esc(d.capacity_warning) + '</p>';

        if (!d.tiers.length) {
            html += '<p class="tkt-muted">No ticket types yet. Add one (for example General, Early Bird or VIP) to sell tickets for this show on the website.</p>';
        }
        html += '<ul class="tkt-tiers">' + d.tiers.map(function (t) {
            var window_ = (t.sales_start ? 'From ' + esc(sast(t.sales_start)) : 'On sale now') + (t.sales_end ? ' · until ' + esc(sast(t.sales_end)) : ' · until the show starts');
            return '<li class="tkt-tier" data-id="' + t.id + '">' +
                '<div class="tkt-tier__top"><strong class="tkt-tier__name">' + esc(t.name) + '</strong><span class="tkt-price">' + zar(t.price_cents) + '</span>' +
                '<span class="atl-badge ' + (STATE_BADGE[t.state] || '') + '">' + esc(STATE_LABEL[t.state] || t.state) + '</span></div>' +
                meter(t) +
                '<div class="tkt-tier__sub">' + t.sold + ' sold · ' + t.reserved + ' held · ' + t.remaining + ' left of ' + t.capacity + ' · max ' + t.max_per_order + ' per order</div>' +
                '<div class="tkt-tier__sub">' + window_ + '</div>' +
                (manage ? '<div class="tkt-tier__actions tkt-manage"><button type="button" class="atl-btn atl-btn--ghost tkt-edit" data-id="' + t.id + '"><i class="fa-solid fa-pen"></i> Edit</button>' +
                    (t.sold || t.reserved ? '' : '<button type="button" class="atl-btn atl-btn--ghost tkt-delete" data-id="' + t.id + '"><i class="fa-solid fa-trash"></i> Delete</button>') + '</div>' : '') +
                '<div class="tkt-editor-slot"></div></li>';
        }).join('') + '</ul>';
        if (manage) html += '<div class="tkt-add tkt-manage"><button type="button" class="atl-btn atl-btn--ghost" id="tktAddTier"><i class="fa-solid fa-plus"></i> Add ticket type</button><div class="tkt-editor-slot" id="tktNewSlot"></div></div>';
        if (d.tiers.length) html += '<button type="button" class="atl-btn atl-btn--ghost tkt-view-orders" id="tktViewOrders"><i class="fa-solid fa-list"></i> View orders &amp; attendees</button>';
        $('#tktEventMount').html(html);
    }

    function editorHtml(t) {
        var v = t || { name: '', description: '', price: '', capacity: '', max_per_order: 10, sales_start_local: '', sales_end_local: '', is_active: true };
        var lim = (current.data && current.data.limits) || { max_per_order: 20 };
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
            '<p class="tkt-hint">Leave "Sales open" blank to sell straight away and "Sales close" blank to sell until the show starts (South African time). A price change only affects new orders.</p>' +
            '<p class="tkt-form-error" role="alert"></p>' +
            '<div class="tkt-editor__actions"><button type="button" class="atl-btn atl-btn--ghost tkt-cancel">Cancel</button>' +
            '<button type="submit" class="atl-btn atl-btn--primary">' + (t ? 'Save' : 'Add') + '</button></div></form>';
    }

    function openEditor($slot, tier) {
        $('#tktEventMount .tkt-editor').remove();
        current.editing = tier ? tier.id : 'new';
        $slot.html(editorHtml(tier));
        $slot.find('input[name="name"]').trigger('focus');
    }

    $(document).on('click', '#tktAddTier', function () { openEditor($('#tktNewSlot'), null); });
    $(document).on('click', '#tktEventMount .tkt-edit', function () {
        var id = Number($(this).data('id'));
        var tier = (current.data.tiers || []).filter(function (t) { return t.id === id; })[0];
        if (tier) openEditor($(this).closest('.tkt-tier').find('.tkt-editor-slot'), tier);
    });
    $(document).on('click', '#tktEventMount .tkt-cancel', function () { $(this).closest('.tkt-editor').remove(); current.editing = null; });

    $(document).on('submit', '#tktEventMount .tkt-editor', function (e) {
        e.preventDefault();
        var $f = $(this);
        var body = {
            name: $f.find('[name="name"]').val(), price: $f.find('[name="price"]').val(), capacity: Number($f.find('[name="capacity"]').val()),
            max_per_order: Number($f.find('[name="max_per_order"]').val()), sales_start: $f.find('[name="sales_start"]').val(), sales_end: $f.find('[name="sales_end"]').val(),
            description: $f.find('[name="description"]').val(), is_active: $f.find('[name="is_active"]').is(':checked')
        };
        var isNew = current.editing === 'new';
        var url = isNew ? '/api/admin/events/' + current.eventId + '/ticket-types' : '/api/admin/ticket-types/' + current.editing;
        var $btn = $f.find('button[type="submit"]').prop('disabled', true);
        call(isNew ? 'POST' : 'PUT', url, body).then(function (r) {
            $btn.prop('disabled', false);
            if (!r.ok) { $f.find('.tkt-form-error').text(r.json.message || 'Could not save this ticket type.'); return; }
            toast('showSuccess', r.json.message || 'Saved.');
            current.editing = null;
            return loadEventTickets();
        }).catch(function () { $btn.prop('disabled', false); $f.find('.tkt-form-error').text('Could not save - check your connection and try again.'); });
    });

    $(document).on('click', '#tktEventMount .tkt-delete', function () {
        var id = Number($(this).data('id'));
        var go = function () {
            call('DELETE', '/api/admin/ticket-types/' + id).then(function (r) {
                if (!r.ok) { toast('showError', r.json.message || 'Could not delete this ticket type.'); return; }
                toast('showSuccess', r.json.message || 'Deleted.');
                loadEventTickets();
            });
        };
        if (window.notificationService && window.notificationService.showConfirm) {
            window.notificationService.showConfirm({ message: 'Delete this ticket type? It has never been ordered, so nothing else changes.', isDestructive: true }).then(function (ok) { if (ok) go(); });
        } else { go(); }
    });

    $(document).on('click', '#tktSalesToggle', function () {
        var open = !current.data.sales_open;
        var $b = $(this).prop('disabled', true);
        call('POST', '/api/admin/events/' + current.eventId + '/ticket-sales', { open: open }).then(function (r) {
            $b.prop('disabled', false);
            if (!r.ok) { toast('showError', r.json.message || 'Could not change ticket sales.'); return; }
            toast('showSuccess', r.json.message);
            loadEventTickets();
        });
    });

    // Re-read the counts whenever the Tickets tab is shown (a sale may have happened since the drawer opened).
    $(document).on('click', '#evt-tab-tickets', function () { loadEventTickets(); });

    // From an event's Tickets tab straight to its orders.
    $(document).on('click', '#tktViewOrders', function () {
        var id = current.eventId;
        if (window.closeAtlDrawer) window.closeAtlDrawer('evtDrawer');
        sales.wantEvent = id;
        $('#eventsAdmin [data-um-tab="evtPanelTickets"]').trigger('click');
    });

    /* ───────────────────────────── (B) Events -> Ticket Sales ───────────────────────────── */

    var ORDER_LABEL = { pending: 'Waiting for payment', paid: 'Paid', expired: 'Expired', failed: 'Failed', refunded: 'Refunded' };
    var ORDER_BADGE = { pending: 'atl-badge--pending', paid: 'atl-badge--paid', expired: 'atl-badge--completed', failed: 'atl-badge--cancelled', refunded: 'atl-badge--warning' };
    var sales = { eventId: null, events: [], page: 1, pages: 1, wantEvent: null, order: null };
    var pager = window.Pagination ? new window.Pagination({
        mode: 'prevnext', container: '#tktPager', prevEl: '#tktPrev', nextEl: '#tktNext', infoEl: '#tktPageInfo', pageSize: 25,
        getPage: function () { return sales.page; }, infoFormat: function (from, to, total) { return from + '–' + to + ' of ' + total + ' orders'; }
    }) : null;

    function orderBadge(o) {
        if (o.status === 'paid' && o.refund_required) return '<span class="atl-badge atl-badge--overdue">Refund needed</span>';
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
        });
    }

    function selectEvent(id) {
        sales.eventId = id;
        sales.page = 1;
        $('#tktSalesBody').prop('hidden', false);
        $('#tktCsvLink').attr('href', '/api/admin/ticketing/events/' + id + '/attendees.csv');
        $('#tktDoorLink').attr('href', '/checkin?event=' + id);
        loadStats();
        if (canManage()) loadOrders();
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
            var sold = s.tiers.reduce(function (n, t) { return n + t.sold; }, 0);
            var cap = s.tiers.reduce(function (n, t) { return n + t.capacity; }, 0);
            var held = s.tiers.reduce(function (n, t) { return n + t.reserved; }, 0);
            var tiles = [];
            if (s.revenue_cents !== undefined) tiles.push(tile('fa-sack-dollar', 'Ticket revenue', esc(zar(s.revenue_cents)), s.refunded_cents ? zar(s.refunded_cents) + ' refunded' : 'from paid orders'));
            tiles.push(tile('fa-ticket', 'Tickets sold', sold + ' <small>of ' + cap + '</small>', held ? held + ' held right now' : (cap - sold) + ' left'));
            tiles.push(tile('fa-door-open', 'Checked in', s.door.checked_in + ' <small>of ' + s.door.valid + '</small>', s.door.valid ? Math.round(100 * s.door.checked_in / s.door.valid) + '% at the door' : 'no tickets yet'));
            if (s.refund_due_orders) tiles.push(tile('fa-rotate-left', 'Refund needed', String(s.refund_due_orders), 'paid after the tickets sold out'));
            $('#tktStatGrid').html(tiles.join(''));
            $('#tktTierTable').html('<table class="table tkt-table tkt-table--tiers"><thead><tr><th>Ticket type</th>' + (s.revenue_cents !== undefined ? '<th>Price</th>' : '') +
                '<th>Sold</th><th>Held</th><th>Checked in</th><th class="tkt-col-bar"></th></tr></thead><tbody>' + s.tiers.map(function (t) {
                    return '<tr><td><strong>' + esc(t.name) + '</strong>' + (t.is_active ? '' : ' <span class="tkt-muted">(closed)</span>') + '</td>' +
                        (t.price_cents !== undefined ? '<td class="tkt-num">' + esc(zar(t.price_cents)) + '</td>' : '') +
                        '<td class="tkt-num">' + t.sold + ' / ' + t.capacity + '</td><td class="tkt-num">' + t.reserved + '</td><td class="tkt-num">' + t.checked_in + ' / ' + t.sold + '</td>' +
                        '<td class="tkt-col-bar">' + meter({ capacity: t.capacity, sold: t.sold, reserved: t.reserved, remaining: Math.max(0, t.capacity - t.sold - t.reserved) }) + '</td></tr>';
                }).join('') + '</tbody></table>');
        });
    }

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
                    '<td><span class="tkt-buyer">' + esc(o.buyer_name || '—') + '</span><span class="tkt-sub">' + esc(o.buyer_email || '') + '</span></td>' +
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
        $('#tktOrderDrawerTitle').html('<i class="fa-solid fa-ticket"></i> Order #' + id);
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
        html += '<dl class="tkt-kv"><dt>Buyer</dt><dd>' + esc(o.buyer_name || '—') + '</dd><dt>Email</dt><dd>' + esc(o.buyer_email || '—') + '</dd><dt>Phone</dt><dd>' + esc(o.buyer_phone || '—') + '</dd>' +
            '<dt>Show</dt><dd>' + esc(d.event ? d.event.title : '') + '</dd>' +
            '<dt>Ordered</dt><dd>' + esc(sast(o.created_at)) + '</dd>' + (o.paid_at ? '<dt>Paid</dt><dd>' + esc(sast(o.paid_at)) + '</dd>' : '') +
            (o.gateway_payment_id ? '<dt>PayFast id</dt><dd class="tkt-mono">' + esc(o.gateway_payment_id) + '</dd>' : '') +
            (o.tickets_emailed_at ? '<dt>Tickets emailed</dt><dd>' + esc(sast(o.tickets_emailed_at)) + '</dd>' : '') +
            (o.consent_at ? '<dt>POPIA consent</dt><dd>' + esc(sast(o.consent_at)) + ' (' + esc(o.consent_policy_version || '') + ')</dd>' : '') +
            (o.refunded_at ? '<dt>Refunded</dt><dd>' + esc(sast(o.refunded_at)) + (o.refunded_by_name ? ' by ' + esc(o.refunded_by_name) : '') + (o.refund_note ? ' - ' + esc(o.refund_note) : '') + '</dd>' : '') +
            '</dl>';
        html += '<h6 class="tkt-h">Tickets</h6>' + (d.tickets.length ? '<ul class="tkt-list">' + d.tickets.map(function (t) {
            var st = t.voided_at ? '<span class="atl-badge atl-badge--cancelled">Void</span>' : t.checked_in_at ? '<span class="atl-badge atl-badge--paid">In at ' + esc(sast(t.checked_in_at)) + '</span>' : '<span class="atl-badge atl-badge--pending">Not yet in</span>';
            return '<li><strong>' + esc(t.tier_name) + '</strong> · ' + esc(t.holder_name || o.buyer_name || '') + ' ' + st + (t.checked_in_by_name ? '<span class="tkt-sub">checked in by ' + esc(t.checked_in_by_name) + '</span>' : '') + '</li>';
        }).join('') + '</ul>' : '<p class="tkt-muted">No tickets were issued for this order.</p>');
        html += '<h6 class="tkt-h">Lines</h6><ul class="tkt-list">' + d.items.map(function (i) { return '<li>' + i.quantity + ' × ' + esc(i.name) + ' <span class="tkt-price">' + esc(zar(i.unit_price_cents * i.quantity)) + '</span></li>'; }).join('') + '</ul>';
        if (d.notifications.length) {
            html += '<h6 class="tkt-h">PayFast notifications</h6><ul class="tkt-list tkt-list--small">' + d.notifications.map(function (n) {
                return '<li>' + esc(sast(n.received_at)) + ' · ' + esc(n.source === 'reconcile' ? 'safety net' : 'notification') + ' · ' + esc(n.payment_status || '') + ' · <span class="' + (n.verified ? '' : 'tkt-muted') + '">' + esc(String(n.outcome || '').replace(/_/g, ' ')) + '</span></li>';
            }).join('') + '</ul>';
        }
        if (o.status === 'paid') {
            html += '<div class="tkt-order__actions">' +
                (!o.refund_required ? '<button type="button" class="atl-btn atl-btn--ghost" id="tktResend"><i class="fa-solid fa-paper-plane"></i> Resend tickets</button>' : '') +
                '<button type="button" class="atl-btn atl-btn--ghost tkt-danger" id="tktRefundStart"><i class="fa-solid fa-rotate-left"></i> Mark as refunded</button></div>' +
                '<div class="tkt-refund" id="tktRefundBox" hidden><label for="tktRefundNote">How was it refunded?</label>' +
                '<input id="tktRefundNote" class="um-input" maxlength="300" placeholder="e.g. Refunded in the PayFast dashboard on 30 Oct">' +
                '<label class="tkt-check-line"><input type="checkbox" id="tktRefundNotify" checked> E-mail the buyer that the refund was made</label>' +
                '<p class="tkt-hint">Refund the money in the PayFast dashboard first. Marking it here makes its tickets stop working at the door and puts the places back on sale.</p>' +
                '<div class="tkt-editor__actions"><button type="button" class="atl-btn atl-btn--ghost" id="tktRefundCancel">Cancel</button><button type="button" class="atl-btn atl-btn--primary tkt-danger-solid" id="tktRefundGo">Mark refunded</button></div></div>';
        }
        html += '</div>';
        $('#tktOrderDrawerBody').html(html);
    }

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
        call('POST', '/api/admin/ticketing/orders/' + id + '/refund', { note: $('#tktRefundNote').val(), notify: $('#tktRefundNotify').is(':checked') }).then(function (r) {
            $b.prop('disabled', false);
            if (!r.ok) { toast('showError', r.json.message || 'Could not mark it refunded.'); return; }
            toast('showSuccess', r.json.message);
            openOrder(id);
            loadStats();
            loadOrders();
        });
    });
})();
