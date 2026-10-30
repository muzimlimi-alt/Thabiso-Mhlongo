/* Event tickets - the public "Get Tickets" drawer (docs-internal/ticketing.md).
   Built on the site's EXISTING drawer system (js/admin/components/drawer.js openAtlDrawer/closeAtlDrawer with data-atl-modal: focus trap,
   inert page, Esc / backdrop close, focus back to the opener via js/overlay-stack.js) and paid through the EXISTING PayFast hand-off
   (window.tmPostToPayfast in index.html, shared with the booking tracker). On phones the drawer is a full-height bottom sheet
   (.atl-drawer--sheet, css/public/drawer.css).

   Two short steps: (1) choose tickets -> Continue RESERVES them for 10 minutes; (2) your details + POPIA consent, with a countdown -> Pay.
   Back from PayFast (?tickets=<ref>&payment=success|cancel) the drawer reopens on the order and asks the SERVER for its status - the
   return itself proves nothing; only PayFast's notification (or the safety net) makes an order paid.
   All money arrives from the server in integer cents; nothing here computes a price the server relies on. */
(function () {
    'use strict';

    var DRAWER = 'ticketDrawer';
    var STORE = 'tmTicketOrder';                       // sessionStorage: { ref, eventId } of the order on its way to PayFast
    var state = { eventId: null, data: null, qty: {}, order: null, skew: 0, timer: null, poll: null, notice: '', namesOpen: false };

    // ---------------------------------------------------------------- helpers

    function esc(s) {
        return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }
    function zar(cents) {
        var n = Math.max(0, Math.round(Number(cents) || 0));
        return 'R ' + String(Math.floor(n / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ') + '.' + String(n % 100).padStart(2, '0');
    }
    function sast(iso) {
        if (!iso) return '';
        try { return new Date(iso).toLocaleString('en-ZA', { timeZone: 'Africa/Johannesburg', weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }); }
        catch (e) { return ''; }
    }
    function store(v) { try { if (v) sessionStorage.setItem(STORE, JSON.stringify(v)); else sessionStorage.removeItem(STORE); } catch (e) {} }
    function stored() { try { return JSON.parse(sessionStorage.getItem(STORE) || 'null'); } catch (e) { return null; } }
    // bypassInterceptor: this drawer shows its own messages (js/notificationService.js would otherwise toast every non-OK answer too)
    function call(method, url, body) {
        var opts = { method: method, headers: {}, cache: 'no-store', bypassInterceptor: true };
        if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
        return fetch(url, opts).then(function (res) {
            return res.json().catch(function () { return {}; }).then(function (json) { return { status: res.status, ok: res.ok, json: json || {} }; });
        });
    }
    function body(html) { $('#ticketDrawerBody').html(html); }
    function title(t) { $('#ticketDrawerTitle').text(t); }
    function stopTimers() {
        if (state.timer) { clearInterval(state.timer); state.timer = null; }
        if (state.poll) { clearTimeout(state.poll); state.poll = null; }
    }
    function noteSkew(serverNow) { if (serverNow) state.skew = Date.parse(serverNow) - Date.now(); }
    function msLeft(until) { return Date.parse(until) - (Date.now() + state.skew); }
    function open() { if (window.openAtlDrawer && !$('#' + DRAWER).hasClass('atl-drawer--open')) window.openAtlDrawer(DRAWER); }
    function focusFirst(sel) { setTimeout(function () { var el = document.querySelector('#' + DRAWER + ' ' + sel); if (el) el.focus(); }, 60); }

    // The show's poster, so the buyer can see at a glance which show they are buying for. Stored paths are site-relative
    // ("images/events/x.jpg") or a data: URL; a poster that fails to load is simply removed.
    function posterSrc(p) {
        var s = String(p || '').trim();
        if (!s) return '';
        if (/^(data:image\/|https?:\/\/|\/)/i.test(s)) return s;
        return '/' + s.replace(/^\.?\//, '');
    }

    function eventHead(ev) {
        if (!ev) return '';
        var poster = posterSrc(ev.poster_image_path);
        return '<div class="tk-event">' +
            (poster ? '<div class="tk-event__poster"><img src="' + esc(poster) + '" alt="Poster for ' + esc(ev.title) + '" onerror="this.parentNode.remove()"></div>' : '') +
            '<p class="tk-event__title">' + esc(ev.title) + '</p>' +
            '<p class="tk-event__meta">' + esc([ev.starts_label, ev.venue_name].filter(Boolean).join(' · ')) + '</p></div>';
    }
    function messageBox(kind, text) { return text ? '<div class="tk-msg tk-msg--' + kind + '" role="' + (kind === 'error' ? 'alert' : 'status') + '">' + text + '</div>' : ''; }
    function loading(text) { body('<div class="tk-loading" role="status"><i class="fa-solid fa-circle-notch fa-spin" aria-hidden="true"></i> ' + esc(text) + '</div>'); }

    // ---------------------------------------------------------------- the Events section: the card / modal buttons

    // Called by js/myscript.js for every event card. Returns the card's ticket area, or null when the event has no ticket types
    // (the card then keeps its external ticket link exactly as before).
    window.tmTicketCta = function (item, safeTitle) {
        var t = item && item.ticketing;
        if (!t) return null;
        if (item.event_datetime && new Date(item.event_datetime).getTime() < Date.now()) return '';      // a past show: nothing to sell
        if (t.state === 'on_sale') {
            return '<div class="ev-card__ticket-cta"><button type="button" class="ev-card__ticket-btn tk-open" data-ticket-event="' + Number(item.event_id) + '" aria-label="Get tickets for ' + (safeTitle || '') + '">' +
                '<i class="fa-solid fa-ticket" style="margin-right:6px;"></i>Get Tickets' + (t.from_cents ? ' <span class="tk-from">from ' + zar(t.from_cents) + '</span>' : '') +
                '<i class="fa-solid fa-arrow-right" style="margin-left:4px;font-size:10px;"></i></button></div>';
        }
        var label = t.state === 'sold_out' ? 'Sold Out' : (t.state === 'not_started' && t.opens_at ? 'On sale ' + sast(t.opens_at) : 'Sales Closed');
        return '<div class="ev-card__ticket-cta"><span class="tk-state tk-state--' + esc(t.state) + '">' + esc(label) + '</span></div>';
    };

    // Called by js/myscript.js when the event details modal opens. Returns true when it set the modal's ticket button itself.
    window.tmTicketModalCta = function (item, $btn) {
        var t = item && item.ticketing;
        $btn.removeAttr('data-ticket-event').removeClass('tk-open tk-modal-state').attr('target', '_blank');
        if (!t) return false;
        var past = item.event_datetime && new Date(item.event_datetime).getTime() < Date.now();
        if (past) { $btn.hide(); return true; }
        if (t.state === 'on_sale') {
            $btn.attr({ href: '#', 'data-ticket-event': Number(item.event_id) }).removeAttr('target').addClass('tk-open')
                .html('<i class="fas fa-ticket-alt"></i>Get Tickets').show();
        } else {
            $btn.attr('href', '#').removeAttr('target').addClass('tk-modal-state')
                .html(t.state === 'sold_out' ? 'Sold Out' : 'Sales Closed').show();
        }
        return true;
    };

    $(document).on('click', '.tk-open[data-ticket-event]', function (e) {
        e.preventDefault();
        e.stopPropagation();                                         // the card itself opens the details modal
        var id = Number($(this).attr('data-ticket-event'));
        var fromModal = $(this).closest('.modal').length;
        if (fromModal) {
            // close the details modal first, then open the drawer (focus returns to the event card's own button)
            $('#eventDetailsModal').one('hidden.bs.modal', function () { openForEvent(id); }).modal('hide');
        } else {
            openForEvent(id);
        }
    });
    $(document).on('click', '.tk-modal-state', function (e) { e.preventDefault(); });

    // ---------------------------------------------------------------- step 1: choose tickets

    function openForEvent(eventId) {
        stopTimers();
        state = { eventId: eventId, data: null, qty: {}, order: null, skew: 0, timer: null, poll: null, notice: '', namesOpen: false };
        title('Get Tickets');
        open();
        // a hold for this show that is still alive (the buyer closed the drawer mid-way): carry on with it
        var s = stored();
        if (s && s.eventId === eventId && s.ref) { return loadOrder(s.ref, null); }
        loadTiers();
    }

    function loadTiers(notice) {
        loading('Loading tickets…');
        return call('GET', '/api/public/events/' + state.eventId + '/tickets').then(function (r) {
            if (!r.ok) { body(messageBox('error', esc(r.json.message || 'Tickets for this show are not available online.'))); return; }
            noteSkew(r.json.server_now);
            state.data = r.json;
            state.notice = notice || '';
            renderChoose();
        }).catch(function () { body(messageBox('error', 'We could not load the tickets. Check your connection and try again.') + retryButton()); });
    }
    function retryButton() { return '<div class="tk-actions"><button type="button" class="btn-bk-nav btn-bk-next tk-retry">Try again</button></div>'; }
    $(document).on('click', '#' + DRAWER + ' .tk-retry', function () { loadTiers(); });

    function totals() {
        var n = 0, cents = 0;
        (state.data ? state.data.tiers : []).forEach(function (t) { var q = state.qty[t.id] || 0; n += q; cents += q * t.price_cents; });
        return { n: n, cents: cents };
    }

    function renderChoose(highlight) {
        var d = state.data;
        title('Get Tickets');
        var html = eventHead(d.event) + messageBox('warn', state.notice ? esc(state.notice) : '');
        html += '<ul class="tk-tiers" aria-label="Ticket types">';
        d.tiers.forEach(function (t) {
            var q = state.qty[t.id] || 0;
            var max = Math.min(t.max_per_order, t.remaining);
            var left = t.state === 'on_sale' ? (t.remaining <= 10 ? 'Only ' + t.remaining + ' left' : t.remaining + ' left') :
                t.state === 'sold_out' ? 'Sold out' : t.state === 'not_started' ? 'On sale ' + sast(t.sales_start) : 'Not on sale';
            var gone = (highlight || []).indexOf(t.id) !== -1;
            html += '<li class="tk-tier' + (t.state !== 'on_sale' ? ' tk-tier--off' : '') + (gone ? ' tk-tier--gone' : '') + '">' +
                '<div class="tk-tier__info"><p class="tk-tier__name">' + esc(t.name) + '</p>' +
                (t.description ? '<p class="tk-tier__desc">' + esc(t.description) + '</p>' : '') +
                '<p class="tk-tier__left">' + esc(left) + (t.state === 'on_sale' ? ' · max ' + t.max_per_order + ' per order' : '') + '</p></div>' +
                '<div class="tk-tier__buy"><p class="tk-price">' + zar(t.price_cents) + '</p>' +
                (t.state === 'on_sale' ?
                    '<div class="tk-stepper" role="group" aria-label="' + esc(t.name) + ' tickets">' +
                    '<button type="button" class="tk-step" data-tier="' + t.id + '" data-d="-1" aria-label="One fewer ' + esc(t.name) + ' ticket"' + (q <= 0 ? ' disabled' : '') + '>−</button>' +
                    '<output class="tk-qty" aria-live="polite" aria-label="' + esc(t.name) + ' tickets chosen">' + q + '</output>' +
                    '<button type="button" class="tk-step" data-tier="' + t.id + '" data-d="1" aria-label="One more ' + esc(t.name) + ' ticket"' + (q >= max ? ' disabled' : '') + '>+</button></div>' : '') +
                '</div></li>';
        });
        html += '</ul>';
        var tot = totals();
        html += '<p class="tk-fine">Tickets are held for ' + (d.hold_minutes || 10) + ' minutes while you pay.</p>';
        html += '<div class="tk-actions">' +
            '<p class="tk-total" aria-live="polite"><span>' + (tot.n ? tot.n + ' ticket' + (tot.n === 1 ? '' : 's') : 'Choose your tickets') + '</span><strong class="tk-price">' + zar(tot.cents) + '</strong></p>' +
            '<button type="button" class="btn-bk-nav btn-bk-next tk-continue"' + (tot.n ? '' : ' disabled') + '>Continue <i class="fa-solid fa-arrow-right"></i></button></div>';
        body(html);
    }

    $(document).on('click', '#' + DRAWER + ' .tk-step', function () {
        var id = Number($(this).attr('data-tier'));
        var t = state.data.tiers.filter(function (x) { return x.id === id; })[0];
        if (!t) return;
        var q = Math.max(0, Math.min(Math.min(t.max_per_order, t.remaining), (state.qty[id] || 0) + Number($(this).attr('data-d'))));
        state.qty[id] = q;
        var refocus = $(this).attr('data-d');
        renderChoose();
        var btn = document.querySelector('#' + DRAWER + ' .tk-step[data-tier="' + id + '"][data-d="' + refocus + '"]');
        if (btn && !btn.disabled) btn.focus(); else { var other = document.querySelector('#' + DRAWER + ' .tk-step[data-tier="' + id + '"]:not([disabled])'); if (other) other.focus(); }
    });

    $(document).on('click', '#' + DRAWER + ' .tk-continue', function () {
        var items = Object.keys(state.qty).filter(function (k) { return state.qty[k] > 0; }).map(function (k) { return { ticket_type_id: Number(k), quantity: state.qty[k] }; });
        if (!items.length) return;
        var $b = $(this).prop('disabled', true).html('<i class="fa-solid fa-circle-notch fa-spin"></i> Holding your tickets…');
        call('POST', '/api/public/ticket-orders', { event_id: state.eventId, items: items }).then(function (r) {
            if (r.status === 201) {
                state.order = r.json.order;
                noteSkew(state.order.server_now);
                store({ ref: state.order.reference, eventId: state.eventId });
                renderDetails();
                return;
            }
            if (r.status === 409 && r.json.tiers) {
                // sold out mid-checkout: fresh counts, the gone tiers highlighted, quantities trimmed to what is left
                state.data.tiers = r.json.tiers;
                state.data.tiers.forEach(function (t) { state.qty[t.id] = Math.min(state.qty[t.id] || 0, t.state === 'on_sale' ? Math.min(t.max_per_order, t.remaining) : 0); });
                state.notice = r.json.message + ' The numbers below are up to date - please choose again.';
                renderChoose(r.json.sold_out);
                return;
            }
            state.notice = r.json.message || 'We could not hold those tickets. Please try again.';
            renderChoose();
        }).catch(function () { $b.prop('disabled', false).html('Continue <i class="fa-solid fa-arrow-right"></i>'); state.notice = 'Connection problem - please try again.'; renderChoose(); });
    });

    // ---------------------------------------------------------------- step 2: your details + countdown

    function ticketCount() { return (state.order.items || []).reduce(function (n, i) { return n + i.quantity; }, 0); }

    function countdownHtml() { return '<p class="tk-hold" id="tkHold" role="timer" aria-live="off"><i class="fa-regular fa-clock" aria-hidden="true"></i> Tickets held for <strong class="tk-hold__time">--:--</strong></p>'; }
    function startCountdown(onExpire) {
        if (state.timer) clearInterval(state.timer);
        var tick = function () {
            var ms = msLeft(state.order.reserved_until);
            var $h = $('#tkHold');
            if (ms <= 0) { clearInterval(state.timer); state.timer = null; onExpire(); return; }
            var s = Math.ceil(ms / 1000);
            $h.find('.tk-hold__time').text(Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'));
            $h.toggleClass('tk-hold--low', s <= 120);
            // say it once at two minutes for screen-reader users, not every second
            if (s === 120) $h.attr('aria-live', 'polite'); else if (s < 118) $h.attr('aria-live', 'off');
        };
        tick();
        state.timer = setInterval(tick, 1000);
    }

    function field(id, label, type, ico, attrs, value) {
        return '<div class="tk-field"><label class="tk-label" for="' + id + '">' + label + ' <span aria-hidden="true">*</span></label>' +
            '<div class="bk-field"><i class="fa-solid ' + ico + ' bk-field-ico" aria-hidden="true"></i>' +
            '<input id="' + id + '" type="' + type + '" class="bk-input form-control bk-ico-input" ' + attrs + ' value="' + esc(value || '') + '" aria-describedby="' + id + 'Err"></div>' +
            '<div class="bk-step-err" id="' + id + 'Err" role="alert"></div></div>';
    }

    function renderDetails(error) {
        var o = state.order;
        title('Your details');
        var lines = (o.items || []).map(function (i) { return '<li><span>' + i.quantity + ' × ' + esc(i.name) + '</span><span class="tk-price">' + zar(i.quantity * i.unit_price_cents) + '</span></li>'; }).join('');
        var keep = state.form || {};
        var n = ticketCount();
        var names = '';
        for (var i = 0; i < n; i++) {
            names += '<div class="tk-field"><label class="tk-label" for="tkHolder' + i + '">Ticket ' + (i + 1) + ' name</label>' +
                '<input id="tkHolder' + i + '" class="bk-input form-control tk-holder" maxlength="100" autocomplete="off" placeholder="Leave blank for your own name" value="' + esc((keep.holders || [])[i] || '') + '"></div>';
        }
        body(eventHead(o.event) + countdownHtml() + messageBox('error', error ? esc(error) : '') +
            '<ul class="tk-summary">' + lines + '<li class="tk-summary__total"><span>Total</span><span class="tk-price">' + zar(o.total_cents) + '</span></li></ul>' +
            '<button type="button" class="tk-link tk-change"><i class="fa-solid fa-arrow-left" aria-hidden="true"></i> Change tickets</button>' +
            '<form id="tkBuyer" novalidate>' +
            field('tkName', 'Full name', 'text', 'fa-user', 'autocomplete="name" maxlength="100" required', keep.buyer_name) +
            field('tkEmail', 'Email', 'email', 'fa-envelope', 'autocomplete="email" inputmode="email" maxlength="254" required', keep.buyer_email) +
            field('tkPhone', 'Phone', 'tel', 'fa-phone', 'autocomplete="tel" inputmode="tel" maxlength="20" required', keep.buyer_phone) +
            '<p class="tk-fine">Your tickets are emailed to this address.</p>' +
            (n > 1 ? '<button type="button" class="tk-link tk-names-toggle" aria-expanded="' + (state.namesOpen ? 'true' : 'false') + '" aria-controls="tkNames">' +
                (state.namesOpen ? '− Hide ticket names' : '+ Add a name to each ticket') + ' <span class="tk-muted">(optional)</span></button>' +
                '<div id="tkNames" class="tk-names"' + (state.namesOpen ? '' : ' hidden') + '>' + names + '</div>' : '') +
            '<div class="tk-field"><label class="bk-checkbox-label tk-consent"><input type="checkbox" id="tkPopia" class="bk-checkbox"' + (keep.popia ? ' checked' : '') + ' aria-describedby="tkPopiaErr">' +
            '<span class="bk-checkbox-text">I agree to the <a href="/privacy" data-toggle="modal" data-target="#privacyModal">Privacy Policy</a> and consent to my details being used to issue and deliver these tickets, in line with POPIA.</span></label>' +
            '<div class="bk-step-err" id="tkPopiaErr" role="alert"></div></div>' +
            '<p class="tk-fine">You will be taken to PayFast to pay. Your tickets are confirmed once PayFast confirms the payment.</p>' +
            '<div class="tk-actions"><button type="submit" class="btn-bk-nav btn-bk-next tk-pay"><i class="fa-solid fa-lock" aria-hidden="true"></i> Pay ' + zar(o.total_cents) + ' securely</button></div>' +
            '</form>');
        startCountdown(function () { renderExpired(); });
        focusFirst(error ? '.tk-msg' : '#tkName');
    }

    function readForm() {
        var holders = [];
        $('#' + DRAWER + ' .tk-holder').each(function () { holders.push($(this).val()); });
        state.form = { buyer_name: $('#tkName').val(), buyer_email: $('#tkEmail').val(), buyer_phone: $('#tkPhone').val(), holders: holders, popia: $('#tkPopia').is(':checked') };
        return state.form;
    }

    $(document).on('click', '#' + DRAWER + ' .tk-names-toggle', function () {
        readForm();
        state.namesOpen = !state.namesOpen;
        $('#tkNames').prop('hidden', !state.namesOpen);
        $(this).attr('aria-expanded', state.namesOpen ? 'true' : 'false').html((state.namesOpen ? '− Hide ticket names' : '+ Add a name to each ticket') + ' <span class="tk-muted">(optional)</span>');
        if (state.namesOpen) focusFirst('#tkHolder0');
    });

    // the Privacy Policy opens in place (the site's existing pop-up, stacked above the drawer); without it the link goes to /privacy
    $(document).on('click', '#' + DRAWER + ' a[data-target="#privacyModal"]', function (e) {
        if ($('#privacyModal').length && $.fn.modal) { e.preventDefault(); $('#privacyModal').modal('show'); }
    });

    function showErrors(errors) {
        var map = { buyer_name: 'tkName', buyer_email: 'tkEmail', buyer_phone: 'tkPhone', popia_consent: 'tkPopia', holder_names: 'tkHolder0' };
        $('#' + DRAWER + ' .bk-step-err').removeClass('show').text('');
        $('#' + DRAWER + ' .bk-input').removeClass('bk-input--err').removeAttr('aria-invalid');
        var first = null;
        Object.keys(errors || {}).forEach(function (k) {
            var id = map[k];
            if (!id) return;
            if (k === 'holder_names' && !state.namesOpen) { state.namesOpen = true; $('#tkNames').prop('hidden', false); }
            $('#' + id).addClass('bk-input--err').attr('aria-invalid', 'true');
            $('#' + id + 'Err').text(errors[k]).addClass('show');
            if (!first) first = id;
        });
        if (first) document.getElementById(first).focus();
    }

    // a field's error goes away as soon as the buyer changes that field (it used to stay red until the next Pay)
    $(document).on('input change', '#tkBuyer input', function () {
        var id = this.id && /^tkHolder/.test(this.id) ? 'tkHolder0' : this.id;
        $(this).removeClass('bk-input--err').removeAttr('aria-invalid');
        $('#' + id + 'Err').removeClass('show').text('');
    });

    $(document).on('submit', '#tkBuyer', function (e) {
        e.preventDefault();
        var f = readForm();
        var local = {};
        if (String(f.buyer_name || '').trim().length < 2) local.buyer_name = 'Please enter your full name.';
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(f.buyer_email || '').trim())) local.buyer_email = 'Please enter a valid email address - your tickets are sent there.';
        if (String(f.buyer_phone || '').replace(/[^\d]/g, '').length < 9) local.buyer_phone = 'Please enter a valid phone number.';
        if (!f.popia) local.popia_consent = 'Please agree to the Privacy Policy so we can send your tickets.';
        if (Object.keys(local).length) { showErrors(local); return; }
        var $b = $('#' + DRAWER + ' .tk-pay').prop('disabled', true).html('<i class="fa-solid fa-circle-notch fa-spin"></i> Taking you to PayFast…');
        call('POST', '/api/public/ticket-orders/' + encodeURIComponent(state.order.reference) + '/checkout', {
            buyer_name: f.buyer_name, buyer_email: f.buyer_email, buyer_phone: f.buyer_phone, holder_names: state.namesOpen ? f.holders : [], popia_consent: true
        }).then(function (r) {
            if (r.ok && r.json.pfData) {
                stopTimers();
                if (window.tmPostToPayfast) window.tmPostToPayfast(r.json.pfHost, r.json.pfData);
                return;
            }
            $b.prop('disabled', false).html('<i class="fa-solid fa-lock"></i> Pay ' + zar(state.order.total_cents) + ' securely');
            if (r.status === 400 && r.json.errors) { showErrors(r.json.errors); return; }
            if (r.status === 409 && r.json.order_status === 'expired') { renderExpired(); return; }
            renderDetails(r.json.message || 'We could not start the payment. Please try again.');
        }).catch(function () {
            $b.prop('disabled', false).html('<i class="fa-solid fa-lock"></i> Pay ' + zar(state.order.total_cents) + ' securely');
            renderDetails('Connection problem - please try again.');
        });
    });

    // "Change tickets": give this hold back at once and go back to step 1
    $(document).on('click', '#' + DRAWER + ' .tk-change', function () {
        var ref = state.order && state.order.reference;
        stopTimers();
        store(null);
        state.order = null;
        if (ref) call('POST', '/api/public/ticket-orders/' + encodeURIComponent(ref) + '/release').catch(function () {});
        loadTiers();
    });

    function renderExpired() {
        stopTimers();
        store(null);
        title('Get Tickets');
        body(eventHead(state.order && state.order.event) +
            messageBox('warn', 'Your 10-minute hold ended, so those tickets went back on sale. Nothing was charged.') +
            '<div class="tk-actions"><button type="button" class="btn-bk-nav btn-bk-next tk-again">Choose tickets again</button></div>');
        focusFirst('.tk-again');
    }
    $(document).on('click', '#' + DRAWER + ' .tk-again', function () {
        var ev = state.order && state.order.event && state.order.event.event_id;
        if (ev) state.eventId = ev;
        state.order = null;
        state.qty = {};
        loadTiers();
    });

    // ---------------------------------------------------------------- back from PayFast: the order view

    // payment: 'success' | 'cancel' | null. Polls the SERVER for the truth; asks the safety net to check with PayFast at 0, 35 and 90 s.
    function loadOrder(ref, payment) {
        stopTimers();
        state.returnedAt = payment === 'success' ? Date.now() : null;
        state.checks = 0;
        loading(payment === 'success' ? 'Confirming your payment…' : 'Loading your order…');
        fetchOrder(ref, payment);
    }

    function fetchOrder(ref, payment) {
        call('GET', '/api/public/ticket-orders/' + encodeURIComponent(ref)).then(function (r) {
            if (!r.ok) { store(null); title('Your tickets'); body(messageBox('error', esc(r.json.message || 'We could not find that order.'))); return; }
            var o = r.json.order;
            noteSkew(o.server_now);
            state.order = o;
            state.eventId = o.event && o.event.event_id;
            route(o, ref, payment);
        }).catch(function () {
            body(messageBox('error', 'Connection problem while checking your order.') + '<div class="tk-actions"><button type="button" class="btn-bk-nav btn-bk-next tk-recheck">Check again</button></div>');
            state.recheck = function () { fetchOrder(ref, payment); };
        });
    }
    $(document).on('click', '#' + DRAWER + ' .tk-recheck', function () { if (state.recheck) state.recheck(); });

    function route(o, ref, payment) {
        if (o.status === 'paid' && o.refund_required) { store(null); return renderRefundDue(o); }
        if (o.status === 'paid') { store(null); return renderTickets(o); }
        if (o.status === 'refunded') { store(null); title('Your order'); return body(eventHead(o.event) + messageBox('warn', 'This order was refunded, so its tickets are no longer valid.')); }
        if (o.status === 'failed') { store(null); return renderFailed(o); }
        if (o.status === 'expired') {
            store(null);
            if (payment === 'success' || o.checkout_started && state.returnedAt) return confirming(o, ref);   // paid but the hold ended: the payment can still arrive
            return renderExpired();
        }
        // pending
        if (payment === 'success' || state.returnedAt) return confirming(o, ref);
        if (payment === 'cancel') return renderCancelled(o);
        // the buyer is back mid-way (closed the drawer during step 2): carry on with their details
        return renderDetails();
    }

    // Waiting for PayFast's notification: poll every 3 s for up to 2 minutes, and ask the safety net to look at 0 / 35 / 90 s.
    function confirming(o, ref) {
        title('Confirming payment');
        body(eventHead(o.event) + '<div class="tk-loading" role="status"><i class="fa-solid fa-circle-notch fa-spin" aria-hidden="true"></i> Confirming your payment with PayFast…</div>' +
            '<p class="tk-fine">This usually takes a few seconds. Please keep this page open.</p>');
        var elapsed = Date.now() - state.returnedAt;
        var checkAt = [0, 35000, 90000];
        if (state.checks < checkAt.length && elapsed >= checkAt[state.checks]) {
            state.checks++;
            call('POST', '/api/public/ticket-orders/' + encodeURIComponent(ref) + '/payment-check').catch(function () {});
        }
        if (elapsed > 120000) {
            title('Payment being confirmed');
            body(eventHead(o.event) + messageBox('warn', 'PayFast has not confirmed your payment yet. If you paid, your tickets will be emailed' + (o.email_hint ? ' to ' + esc(o.email_hint) : '') + ' as soon as it does - you can close this page.') +
                '<div class="tk-actions"><button type="button" class="btn-bk-nav btn-bk-next tk-recheck">Check again</button></div>');
            state.recheck = function () { state.returnedAt = Date.now(); state.checks = 0; fetchOrder(ref, 'success'); };
            return;
        }
        state.poll = setTimeout(function () { fetchOrder(ref, 'success'); }, 3000);
    }

    function renderCancelled(o) {
        title('Payment cancelled');
        var alive = msLeft(o.reserved_until) > 0;
        if (!alive) return renderExpired();
        body(eventHead(o.event) + messageBox('warn', 'Your payment was cancelled - nothing was charged. Your tickets are still held:') + countdownHtml() +
            '<div class="tk-actions"><button type="button" class="btn-bk-nav btn-bk-next tk-retry-pay">Try paying again</button>' +
            '<button type="button" class="btn-bk-nav btn-bk-back tk-change">Release my tickets</button></div>');
        startCountdown(function () { renderExpired(); });
        focusFirst('.tk-retry-pay');
    }
    $(document).on('click', '#' + DRAWER + ' .tk-retry-pay', function () { renderDetails(); });

    function renderFailed(o) {
        title('Payment failed');
        body(eventHead(o.event) + messageBox('error', 'PayFast could not take the payment, so nothing was charged and the tickets went back on sale.') +
            '<div class="tk-actions"><button type="button" class="btn-bk-nav btn-bk-next tk-again">Start again</button></div>');
        focusFirst('.tk-again');
    }

    function renderRefundDue(o) {
        title('About your payment');
        body(eventHead(o.event) + messageBox('warn', 'We received your payment, but it arrived after your hold ended and the tickets had sold out. <strong>A full refund is on its way</strong> to your original payment method - no action is needed.'));
    }

    function renderTickets(o) {
        title('Your tickets');
        var html = eventHead(o.event) + messageBox('ok', '<i class="fa-solid fa-circle-check" aria-hidden="true"></i> Payment received' + (o.email_hint ? ' - your tickets were also emailed to ' + esc(o.email_hint) : '') + '.');
        html += '<ol class="tk-tickets">' + (o.tickets || []).map(function (t, i) {
            return '<li class="tk-ticket"><img class="tk-ticket__qr" src="' + esc(t.qr) + '" width="160" height="160" alt="QR code for ticket ' + (i + 1) + '">' +
                '<div class="tk-ticket__info"><p class="tk-ticket__tier">' + esc(t.tier_name) + '</p><p class="tk-ticket__name">' + esc(t.holder_name || '') + '</p>' +
                '<p class="tk-code" aria-label="Ticket code">' + esc(String(t.code).match(/.{1,4}/g).join(' ')) + '</p>' +
                (t.checked_in ? '<p class="tk-ticket__used">Used at the door</p>' : '') + '</div></li>';
        }).join('') + '</ol>';
        html += '<p class="tk-fine">Show the QR code at the door (on your phone or printed). Each code lets one person in, once - please don\'t share it.</p>';
        html += '<div class="tk-actions"><a class="btn-bk-nav btn-bk-next tk-pdf" href="/api/public/ticket-orders/' + encodeURIComponent(o.reference) + '/tickets.pdf" download>' +
            '<i class="fa-solid fa-file-pdf" aria-hidden="true"></i> Download PDF tickets</a></div>';
        body(html);
        focusFirst('.tk-msg');
    }

    // ---------------------------------------------------------------- the drawer closing; arriving from PayFast

    document.addEventListener('atl:drawerClosed', function (e) {
        if (!e.detail || e.detail.id !== DRAWER) return;
        stopTimers();                                                // the hold itself stays (sessionStorage) and runs out on its own
    });

    $(function () {
        var params = new URLSearchParams(window.location.search);
        var ref = params.get('tickets');
        if (!ref) return;
        var payment = params.get('payment');
        // tidy the address bar (the reference stays in the buyer's e-mail and this tab's session only)
        try { params.delete('tickets'); params.delete('payment'); history.replaceState(null, '', window.location.pathname + (params.toString() ? '?' + params : '') + window.location.hash); } catch (err) {}
        stopTimers();
        state = { eventId: null, data: null, qty: {}, order: null, skew: 0, timer: null, poll: null, notice: '', namesOpen: false };
        title(payment === 'success' ? 'Confirming payment' : 'Your tickets');
        // the drawer system is loaded after this file; open on the next tick
        setTimeout(function () { open(); loadOrder(ref, payment === 'success' || payment === 'cancel' ? payment : null); }, 0);
    });
})();
