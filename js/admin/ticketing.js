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
})();
