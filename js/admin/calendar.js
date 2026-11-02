/* Phase 6 (HOUSEKEEPING-NOTES.md): relocated from admin.html verbatim — the "Unified Calendar
   Logic" block (adminCalendar/_calFilterState state, window._calSwitchToList,
   window.handleRemoveHold, showCalEventPopup, initAdminCalendar, initMiniCalendar/
   refreshEventDots/window.refreshMiniCalendar, renderWorkingSchedule, and the Refresh Calendar
   button handler).

   CORRECTION (see HOUSEKEEPING-NOTES.md): this code was first assumed to be plain top-level
   code with no enclosing IIFE. It actually sits inside a large ANONYMOUS
   (function() {...})(); closure (admin.html:24485-26348) that also wraps the core admin-shell
   (toggleSidebar/switchTab/dropdowns/breadcrumb/profile-display, before this block) and
   Bookings' Manual Booking modal (after it) — the same "mega-closure housing multiple
   sections" pattern as initUserManagement/initFinanceManagement, just unnamed. A first attempt
   using a same-position <script> split broke that closure into two unparseable halves; caught
   immediately, reverted, and redone with the reunite-and-relocate pattern instead (the closure
   stays whole, this file's <script src> tag sits before the whole thing).

   Genuine cross-references exist in both directions with code that stays in admin.html —
   Bookings' own booking-creation/edit success handlers (inside the SAME mega-closure) and
   Working Hours (a DIFFERENT closure, inside initFinanceManagement) both call
   adminCalendar.refetchEvents()/renderWorkingSchedule()/adminCalendar.setOption(...). None of
   these needed a new window attachment: with adminCalendar/renderWorkingSchedule/
   initAdminCalendar now declared at this file's own top level (no wrapping IIFE here), loaded
   via <script src> before the mega-closure's own tag, they join the shared global lexical
   environment that every classic <script> tag's scope chain ultimately falls through to —
   reachable from both the reunited mega-closure's remaining code and from
   initFinanceManagement's separate closure, exactly as they need to be. (This is the opposite,
   always-safe direction from the auditState/updateBrandPreview bugs, which needed unreachable
   INWARD access from global scope into a closure — this is normal OUTWARD/upward scope
   resolution from inside a function to its enclosing global scope.) One consequence: Working
   Hours' adminCalendar.setOption('businessHours', ...) call — previously silently inert, since
   it could never reach adminCalendar across the closure boundary — will likely start working
   as an incidental side effect of this move, the same pattern as prior sections' discovered
   dead-code fixes. */

/* ---- Unified Calendar Logic ---- */
let adminCalendar = null;

// Calendar filter state — controls which event types are visible
var _calFilterState = { bookings: true, holds: true, events: true, milestones: true, external: true };

/* Global helper used by inline onclick — switches main calendar to list view */
window._calSwitchToList = function() {
    if (adminCalendar) adminCalendar.changeView('listMonth');
};

function _applyCalFilter() {
    var el = document.getElementById('calendar');
    if (!el) return;
    el.classList.toggle('fc-cal--hide-bookings',  !_calFilterState.bookings);
    el.classList.toggle('fc-cal--hide-holds',     !_calFilterState.holds);
    el.classList.toggle('fc-cal--hide-events',    !_calFilterState.events);
    el.classList.toggle('fc-cal--hide-milestones',!_calFilterState.milestones);
    el.classList.toggle('fc-cal--hide-external',  !_calFilterState.external);
}

/* Text that did not come from this site (a title read from a Google / Microsoft calendar) must never reach innerHTML as markup. escHtml decodes the stored form first. */
function _esc(s) {
    if (window.escHtml) return window.escHtml(s);
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return '&#' + c.charCodeAt(0) + ';'; });
}

window.handleRemoveHold = async function(dbId) {
    if (!(await window.notificationService.showConfirm({ title: "Remove Hold", message: "Remove this hold?", isDestructive: true }))) return;
    try {
        const r = await fetch('/api/admin/calendar/hold/' + dbId, { method: 'DELETE' });
        const d = await r.json();
        if (d.success) {
            if (adminCalendar) adminCalendar.refetchEvents();
            const popup = document.getElementById('calEventPopup');
            if (popup) popup.remove();
            window.notificationService.showSuccess('Hold removed successfully.');
        } else {
            window.notificationService.showError(d.message || 'Failed to remove hold.');
        }
    } catch(e) {
        window.notificationService.showError('Network error while removing hold.');
    }
};

/* ── Calendar item details ───────────────────────────────────────────────────────────────────────────────────────────────
   Clicking ANY calendar item (booking, hold, payment milestone, public event, Outlook appointment) opens this one detail view.
   Viewing is separate from managing: nothing is removed, cancelled or changed by the click itself - the actions sit in the footer,
   and the ones that destroy something (Remove hold) still ask for confirmation. On a phone the view is a bottom sheet; on a larger
   screen it sits next to the item, kept inside the window, and scrolls inside itself when the content is taller than the screen. */
function _calMoney(n) { return 'R ' + Number(n).toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
function _calDay(iso) {
    if (!iso) return '';
    var d = new Date(String(iso).slice(0, 10) + 'T00:00:00');
    return isNaN(d) ? String(iso).slice(0, 10) : d.toLocaleDateString('en-ZA', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
}
function _calClock(hhmm) {
    var m = /^(\d{1,2}):(\d{2})/.exec(hhmm || '');
    if (!m) return '';
    var h = +m[1], ap = h >= 12 ? 'PM' : 'AM';
    return ((h % 12) || 12) + ':' + m[2] + ' ' + ap;
}
function _calSpan(mins) {
    if (!(mins > 0)) return '';
    var h = Math.floor(mins / 60), m = mins % 60;
    return (h ? h + ' h' : '') + (h && m ? ' ' : '') + (m ? m + ' min' : '');
}
/* the date, the start / end time and the length of an item, from what FullCalendar holds */
function _calWhen(ev) {
    var s = ev.startStr || '', e = ev.endStr || '';
    var timed = !ev.allDay && s.length > 10;
    var out = { date: s.slice(0, 10), allDay: !timed, start: timed ? s.slice(11, 16) : '', end: '', minutes: 0 };
    if (timed && e.length > 10) {
        out.end = e.slice(11, 16);
        if (ev.start && ev.end) out.minutes = Math.round((ev.end - ev.start) / 60000);
    }
    return out;
}
function _calOpenBooking(id) {
    switchTab('bookingsAdmin');
    $('#bookingStatusFilter').val('All').trigger('change');
    setTimeout(function () {
        var el = document.getElementById('bookingDetail-' + id);
        if (el) { $(el).collapse('show'); el.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
    }, 300);
}
function _calOpenEvent(id) {
    switchTab('eventsAdmin');
    setTimeout(function () {
        if (typeof window.openEvtEditDrawer === 'function') {
            window.openEvtEditDrawer(id);
            var $c = $('.atl-event-card[data-id="' + id + '"]');
            if ($c.length) $('html,body').animate({ scrollTop: $c.offset().top - 70 }, 400);
        }
    }, 300);
}
function _calClosePopup(returnTo) {
    var p = document.getElementById('calEventPopup');
    if (p) p.remove();
    if (returnTo && document.body.contains(returnTo) && returnTo.focus) { try { returnTo.focus({ preventScroll: true }); } catch (e) { /* focus is a courtesy */ } }
}
function _calRow(label, valueHtml) { return valueHtml ? '<dt>' + label + '</dt><dd>' + valueHtml + '</dd>' : ''; }
function _calChip(text) { return '<span class="cal-pop__chip">' + text + '</span>'; }

/* what each kind of item shows: { icon, label, tone, title, status, statusTone, chips, rows, text, note, actions } */
function _calDetails(info) {
    var ev = info.event, props = ev.extendedProps || {}, w = _calWhen(ev);
    var timeText = w.allDay ? 'All day' : _calClock(w.start) + (w.end ? ' – ' + _calClock(w.end) : '');
    var d = { icon: 'fa-calendar', label: 'Calendar item', tone: 'var(--atl-blue)', title: _esc(ev.title), rows: '', actions: [] };

    if (props.type === 'booking') {
        var sMap = { NEW: 'var(--atl-muted)', PENDING: 'var(--atl-muted)', QUOTED: 'var(--atl-orange)', ACCEPTED: 'var(--atl-blue)', CONFIRMED: 'var(--atl-amber)', COMPLETED: 'var(--atl-sage)', CANCELLED: 'var(--atl-clay)', EXPIRED: 'var(--atl-clay)' };
        var contact = [props.clientEmail, props.clientPhone].filter(Boolean).map(_esc).join('<br>');
        var outstanding = props.amountOutstanding != null && props.amountOutstanding > 0 ? _calMoney(props.amountOutstanding) : null;
        d.icon = 'fa-calendar-check'; d.label = 'Booking'; d.tone = 'var(--atl-amber)';
        d.status = props.status || null; d.statusTone = sMap[(props.status || '').toUpperCase()] || 'var(--atl-amber-hover)';
        d.rows = _calRow('Client', props.clientName ? '<strong>' + _esc(props.clientName) + '</strong>' + (contact ? '<br>' + contact : '') : contact) +
            _calRow('Date', _esc(_calDay(w.date))) +
            _calRow('Time', _esc(timeText) + (w.minutes ? ' <span class="cal-pop__muted">(' + _esc(_calSpan(w.minutes)) + ')</span>' : '')) +
            _calRow('Venue', props.venueName ? _esc(props.venueName + (props.city ? ', ' + props.city : '')) : '') +
            _calRow('Payment', props.payment ? _esc(props.payment) : '') +
            _calRow('Agreed total', props.bookingTotal != null ? _calMoney(props.bookingTotal) : '') +
            _calRow('Paid so far', props.amountPaid != null ? _calMoney(props.amountPaid) : '') +
            _calRow('Outstanding', outstanding ? '<strong style="color:var(--atl-clay)">' + outstanding + '</strong>' : '') +
            _calRow('Quote expires', props.quoteExpiryDate && String(props.status).toUpperCase() === 'QUOTED' ? _esc(_calDay(props.quoteExpiryDate)) : '');
        d.chips = (props.isCalSynced ? _calChip('📅 Cal') : '') + (props.isAccepted ? _calChip('✓ Accepted') : '') + (props.isPopiaDone ? _calChip('🔒 POPIA') : '') + (props.hasAttachments ? _calChip('📁 Brief') : '');
        d.actions.push({ label: 'View booking', icon: 'fa-eye', kind: 'primary', run: function () { _calOpenBooking(props.dbId); } });
        if (props.clientPhone) d.actions.push({ label: 'Copy phone', icon: 'fa-phone', run: function () { navigator.clipboard.writeText(String(props.clientPhone)).then(function () { window.notificationService && window.notificationService.showSuccess('Phone copied'); }); }, keepOpen: true });
    } else if (props.type === 'hold') {
        var bt = (props.blockType || props.block_type || '').toLowerCase();
        var tones = { travel: 'var(--atl-sage)', personal: 'var(--atl-blue)', maintenance: 'var(--atl-orange)' };
        var kinds = { travel: 'Hold: Travel', personal: 'Hold: Personal', maintenance: 'Hold: Maintenance', calendar_sync: 'Hold: Google Calendar' };
        var fromGoogle = props.source === 'google';
        d.icon = 'fa-ban'; d.label = kinds[bt] || 'Hold / Unavailable'; d.tone = tones[bt] || 'var(--atl-clay)';
        d.title = _esc(props.description || ev.title || 'Blocked');
        d.status = 'Active'; d.statusTone = 'var(--atl-clay)';
        d.rows = _calRow('Date', _esc(_calDay(w.date))) +
            _calRow('Starts', w.allDay ? 'All day' : _esc(_calClock(w.start))) +
            _calRow('Ends', w.allDay ? '' : _esc(_calClock(w.end))) +
            _calRow('Duration', w.allDay ? 'The whole day' : _esc(_calSpan(w.minutes))) +
            _calRow('Source', fromGoogle ? 'Imported from Google Calendar' : 'Added in the admin portal') +
            _calRow('Linked event', props.linkedEvent ? _esc(props.linkedEvent) : '') +
            _calRow('Booking', props.bookingId ? '#' + _esc(props.bookingId) : '') +
            _calRow('Created', props.createdAt ? _esc(String(props.createdAt).slice(0, 16).replace('T', ' ')) + (props.createdBy ? ' by ' + _esc(props.createdBy) : '') : (props.createdBy ? 'By ' + _esc(props.createdBy) : '')) +
            _calRow('Expires', props.expiresAt ? _esc(String(props.expiresAt).slice(0, 16).replace('T', ' ')) : '');
        d.note = fromGoogle ? 'This hold comes from your Google Calendar. Removing it here does not delete the Google entry, and the next sync can bring it back - change or delete it in Google Calendar to stop it blocking the date.' : '';
        d.actions.push({ label: 'Remove hold', icon: 'fa-trash', kind: 'danger', run: function () { window.handleRemoveHold(props.dbId, ev); }, keepOpen: true });
    } else if (props.type === 'milestone') {
        var quote = props.milestoneType === 'quote_expiry', overdue = !!props.isOverdue;
        d.icon = quote ? 'fa-file-invoice' : 'fa-circle-dollar-to-slot'; d.label = quote ? 'Quote expiry' : 'Payment due'; d.tone = overdue ? 'var(--atl-clay)' : 'var(--atl-orange)';
        d.status = overdue ? 'Overdue' : (quote ? 'Quote expires' : ((props.paymentStatus || 'pending').charAt(0).toUpperCase() + (props.paymentStatus || 'pending').slice(1)));
        d.statusTone = d.tone;
        d.rows = _calRow(quote ? 'Expires' : 'Due date', _esc(_calDay(w.date))) +
            _calRow('Amount', props.amount != null && props.amount > 0 ? '<strong style="color:' + d.tone + '">' + _calMoney(props.amount) + '</strong>' : '') +
            _calRow('Payment', !quote ? _esc((props.paymentStatus || 'pending').replace(/^./, function (c) { return c.toUpperCase(); })) : '') +
            _calRow('Description', props.description ? _esc(props.description) : '') +
            _calRow('Client', props.clientName ? _esc(props.clientName) : '') +
            _calRow('Booking', props.bookingName ? _esc(props.bookingName) + (props.dbId ? ' <span class="cal-pop__muted">#' + _esc(props.dbId) + '</span>' : '') : (props.dbId ? '#' + _esc(props.dbId) : '')) +
            _calRow('Event date', props.eventDate ? _esc(_calDay(props.eventDate)) : '');
        if (props.dbId) d.actions.push({ label: 'View booking', icon: 'fa-eye', kind: 'primary', run: function () { _calOpenBooking(props.dbId); } });
    } else if (props.type === 'public_event') {
        d.icon = 'fa-star'; d.label = 'Public event'; d.tone = 'var(--atl-blue)';
        d.title = _esc(String(ev.title || '').replace('[EVENT] ', ''));
        d.rows = _calRow('Date', _esc(_calDay(w.date))) + _calRow('Time', _esc(timeText)) + (w.minutes ? _calRow('Duration', _esc(_calSpan(w.minutes))) : '') + _calRow('Venue', props.venue ? _esc(props.venue) : '');
        d.actions.push({ label: 'Edit event', icon: 'fa-pen-to-square', kind: 'primary', run: function () { _calOpenEvent(props.dbId); } });
    } else {
        d.rows = _calRow('Date', _esc(_calDay(w.date))) + _calRow('Time', _esc(timeText));
    }
    return d;
}

function showCalEventPopup(info) {
    var props = info.event.extendedProps || {};
    _calClosePopup();

    var popup = document.createElement('div');
    popup.id = 'calEventPopup';
    popup.className = 'cal-pop';
    popup.setAttribute('role', 'dialog');
    popup.setAttribute('tabindex', '-1');
    var opener = info.el;

    if (props.type === 'external' && window.calM365ExternalPopupHtml) {
        /* an Outlook appointment: its own view (js/admin/calendar-m365.js), shown inside the same scrolling, window-safe frame */
        popup.className += ' cal-pop--bare';
        popup.setAttribute('aria-label', 'Microsoft 365 appointment');
        popup.innerHTML = '<div class="cal-pop__body">' + window.calM365ExternalPopupHtml(info, props) + '</div>';
    } else {
        var d = _calDetails(info);
        popup.setAttribute('aria-label', d.label + ' details');
        popup.innerHTML =
            '<div class="cal-pop__head"><span class="cal-pop__kind" style="--cal-tone:' + d.tone + '"><i class="fa-solid ' + d.icon + '" aria-hidden="true"></i> ' + _esc(d.label) + '</span>' +
            '<button type="button" class="cal-pop__close" aria-label="Close details">&times;</button></div>' +
            '<div class="cal-pop__body">' +
                '<div class="cal-pop__title">' + d.title + '</div>' +
                (d.status ? '<span class="cal-pop__pill" style="--cal-tone:' + d.statusTone + '">' + _esc(d.status) + '</span>' : '') +
                (d.chips ? '<div class="cal-pop__chips">' + d.chips + '</div>' : '') +
                (d.rows ? '<dl class="cal-pop__rows">' + d.rows + '</dl>' : '') +
                (d.note ? '<p class="cal-pop__note">' + _esc(d.note) + '</p>' : '') +
            '</div>' +
            (d.actions.length ? '<div class="cal-pop__foot"></div>' : '');
        var foot = popup.querySelector('.cal-pop__foot');
        d.actions.forEach(function (a) {
            var b = document.createElement('button');
            b.type = 'button';
            b.className = 'cal-pop__btn' + (a.kind ? ' cal-pop__btn--' + a.kind : '');
            b.innerHTML = '<i class="fa-solid ' + a.icon + '" aria-hidden="true"></i> ' + _esc(a.label);
            b.addEventListener('click', function () { if (!a.keepOpen) _calClosePopup(); a.run(); });
            foot.appendChild(b);
        });
        popup.querySelector('.cal-pop__close').addEventListener('click', function () { _calClosePopup(opener); });
    }

    if (window.calM365PopupSection) {
        try { var m365Sec = window.calM365PopupSection(props, info); if (m365Sec) popup.querySelector('.cal-pop__body').appendChild(m365Sec); }
        catch (secErr) { console.error('Microsoft 365 section failed:', secErr); }
    }

    popup.style.visibility = 'hidden';
    document.body.appendChild(popup);

    /* a bottom sheet on phones (CSS); beside the item elsewhere - below it when it fits, above it otherwise, always inside the window */
    if (window.innerWidth >= 768) {
        var rect = opener.getBoundingClientRect(), pad = 12;
        var w = popup.offsetWidth, h = popup.offsetHeight, vw = window.innerWidth, vh = window.innerHeight;
        var left = Math.max(pad, Math.min(rect.left, vw - w - pad));
        var top = rect.bottom + 6;
        if (top + h > vh - pad) top = rect.top - h - 6 >= pad ? rect.top - h - 6 : Math.max(pad, vh - h - pad);
        popup.style.left = left + 'px';
        popup.style.top = top + 'px';
    }
    popup.style.visibility = '';
    // opened from the keyboard (Enter / Space on the item): move focus into the view; with the mouse a focus ring round the whole view would only be noise
    if (info.jsEvent && info.jsEvent.detail === 0) { try { popup.querySelector('.cal-pop__close, button, a').focus({ preventScroll: true }); } catch (e) { /* focus is a courtesy */ } }

    setTimeout(function () {
        document.addEventListener('click', function dismiss(e) {
            if (!document.body.contains(popup)) { document.removeEventListener('click', dismiss); return; }
            if (!popup.contains(e.target)) { popup.remove(); document.removeEventListener('click', dismiss); }
        });
    }, 50);
    document.addEventListener('keydown', function esc(e) {
        if (!document.body.contains(popup)) { document.removeEventListener('keydown', esc); return; }
        if (e.key === 'Escape') { _calClosePopup(opener); document.removeEventListener('keydown', esc); }
    });
    var openedAt = window.innerWidth;   // a rotation / window resize makes the item's position stale; a phone's address bar showing or hiding is not a resize
    window.addEventListener('resize', function onResize() {
        if (!document.body.contains(popup)) { window.removeEventListener('resize', onResize); return; }
        if (window.innerWidth !== openedAt) { window.removeEventListener('resize', onResize); popup.remove(); }
    });
}

function initAdminCalendar() {
    var calendarEl = document.getElementById('calendar');
    if (!calendarEl) return;

    if (!adminCalendar) {
        adminCalendar = new FullCalendar.Calendar(calendarEl, {
            // Month-grid cells are too narrow on phones to show more than a truncated
            // sliver of an event title - list view reads correctly at any width.
            initialView: window.innerWidth < 576 ? 'listMonth' : 'dayGridMonth',
            headerToolbar: {
                left: 'prev,next today',
                center: 'title',
                right: 'dayGridMonth,timeGridWeek,listMonth'
            },
            events: function(info, successCb, failureCb) {
                var url = '/api/admin/calendar/events';
                if (typeof _calFilterState !== 'undefined' && _calFilterState.milestones) url += '?include=milestones';
                fetch(url).then(function(r) { return r.json(); }).then(function(data) {
                    var result = (data || []).slice();
                    (data || []).forEach(function(ev) {
                        var t = ev.extendedProps && ev.extendedProps.type;
                        /* For all-day bookings/holds: add a timed background fill that spans the full day column */
                        if (ev.allDay && (t === 'booking' || t === 'hold')) {
                            var d = (ev.start || '').split('T')[0];
                            if (d) {
                                var next = new Date(d);
                                next.setDate(next.getDate() + 1);
                                var nextStr = next.toISOString().split('T')[0];
                                result.push({
                                    id: ev.id + '_bgfill',
                                    start: d + 'T00:00:00',
                                    end: nextStr + 'T00:00:00',
                                    allDay: false,
                                    display: 'background',
                                    extendedProps: {
                                        type: t,
                                        isBgFill: true,
                                        status: ev.extendedProps.status,
                                        blockType: ev.extendedProps.blockType
                                    }
                                });
                            }
                        }
                    });
                    successCb(result);
                }).catch(failureCb);
            },
            editable: true,
            eventStartEditable: true,
            eventDurationEditable: false, // no eventResize handler exists; drag-to-resize would silently discard on refetch
            eventResourceEditable: false,
            eventAllow: function(dropInfo, draggedEvent) {
                const t = draggedEvent && draggedEvent.extendedProps && draggedEvent.extendedProps.type;
                const isBg = draggedEvent && draggedEvent.extendedProps && draggedEvent.extendedProps.isBgFill;
                // 'public_event' has a full eventDrop branch (PATCH /api/admin/events/:id/date) and
                // server-side support already built, but was never allowed to actually start a drag.
                return !isBg && (t === 'booking' || t === 'hold' || t === 'public_event');
            },
            eventClick: function(info) {
                const props = info.event.extendedProps || {};
                if (props.isBgFill) return;
                showCalEventPopup(info);
            },
            eventDrop: async function(info) {
                var props = info.event.extendedProps;
                if (!props || props.isBgFill) { info.revert(); return; }
                var newDate = info.event.startStr.split('T')[0];

                // Dragging a booking moves its real date/time and — on success — the server emails
                // the client that their event date changed (sendDateChangedEmail), with no
                // confirmation step before this fired. An accidental drag used to reschedule a
                // real booking and notify the client instantly.
                if (props.type === 'booking') {
                    const confirmed = await window.notificationService.showConfirm({
                        title: 'Reschedule booking',
                        message: `Move this booking to ${newDate}? The client will be emailed that their event date changed.`
                    });
                    if (!confirmed) { info.revert(); return; }
                }

                if (props.type === 'hold') {
                    fetch('/api/admin/calendar/hold/' + props.dbId + '/date', {
                        method: 'PATCH',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ date: newDate })
                    }).then(r => r.json()).then(d => {
                        if (!d.success) { info.revert(); window.notificationService && window.notificationService.showError('Could not move hold.'); }
                        else { renderWorkingSchedule(); }
                    }).catch(() => { info.revert(); window.notificationService && window.notificationService.showError('Network error. Hold not moved.'); });
                    return;
                }

                if (props.type === 'public_event') {
                    const confirmedEvt = await window.notificationService.showConfirm({
                        title: 'Reschedule event',
                        message: `Move this public event to ${newDate}? Its Google Calendar entry and ticket page date will both need to be checked afterward.`
                    });
                    if (!confirmedEvt) { info.revert(); return; }
                    var startStr = info.event.startStr;
                    var newTime = startStr.includes('T') ? startStr.substring(11, 16) : undefined;
                    var body = { date: newDate };
                    if (newTime) body.time = newTime;
                    fetch('/api/admin/events/' + props.dbId + '/date', {
                        method: 'PATCH',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(body)
                    }).then(r => r.json()).then(d => {
                        if (!d.success) { info.revert(); window.notificationService && window.notificationService.showError('Could not move event: ' + (d.message || 'unknown error')); }
                        else { renderWorkingSchedule(); if (typeof renderEventsList === 'function') renderEventsList(); }
                    }).catch(() => { info.revert(); window.notificationService && window.notificationService.showError('Network error. Event date not updated.'); });
                    return;
                }

                if (props.type !== 'booking') { info.revert(); return; }
                var startStr = info.event.startStr;
                var newTime = startStr.includes('T') ? startStr.substring(11, 16) : undefined;
                var body = { date: newDate };
                if (newTime) body.time = newTime;
                fetch('/api/admin/bookings/' + props.dbId + '/date', {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(body)
                }).then(r => r.json()).then(d => {
                    if (!d.success) { info.revert(); window.notificationService && window.notificationService.showError('Could not update booking: ' + (d.message || 'unknown error')); }
                    else { renderWorkingSchedule(); }
                }).catch(() => { info.revert(); window.notificationService && window.notificationService.showError('Network error. Booking date not updated.'); });
            },
            selectable: true,
            selectMirror: true,
            select: function(info) {
                // Only open the modal for multi-day drag-selections; ignore single-cell clicks
                const msSpan = new Date(info.end) - new Date(info.start);
                if (msSpan > 86400000) {
                    openBlockOutModal(info.startStr, info.endStr);
                }
                adminCalendar.unselect();
            },
            eventTimeFormat: { hour: 'numeric', minute: '2-digit', meridiem: 'short' },
            eventDidMount: function(arg) {
                var props = arg.event.extendedProps || {};
                var type  = props.type;
                if (type) arg.el.classList.add('fc-event--type-' + type);
                if (window.calM365Badge && !props.isBgFill) { try { window.calM365Badge(arg, props); } catch (badgeErr) { /* a badge must never break the calendar */ } }
                if (window.calGoogleBadge && !props.isBgFill) { try { window.calGoogleBadge(arg, props); } catch (badgeErr) { /* the Google filter marker must never break the calendar */ } }
                var color = null;
                if (type === 'booking') {
                    var s = (props.status || '').toUpperCase();
                    if      (s === 'NEW' || s === 'PENDING') color = 'var(--atl-muted)';
                    else if (s === 'QUOTED')                 color = 'var(--atl-orange)';
                    else if (s === 'ACCEPTED')               color = 'var(--atl-blue)';
                    else if (s === 'CONFIRMED')              color = 'var(--atl-amber)';
                    else if (s === 'COMPLETED')              color = 'var(--atl-sage)';
                    else if (s === 'CANCELLED' || s === 'EXPIRED') color = 'var(--atl-clay)';
                    else                                     color = 'var(--atl-amber)';
                } else if (type === 'hold') {
                    var bt = (props.blockType || props.block_type || '').toLowerCase();
                    if      (bt === 'travel')      color = 'var(--atl-sage)';
                    else if (bt === 'personal')    color = 'var(--atl-blue)';
                    else if (bt === 'maintenance') color = 'var(--atl-orange)';
                    else                           color = 'var(--atl-clay)';
                } else if (type === 'milestone') {
                    color = props.isOverdue ? 'var(--atl-clay)' : 'var(--atl-orange)';
                } else if (type === 'external') {
                    color = 'var(--atl-m365, #7a93b8)';
                }
                if (color) {
                    arg.el.style.setProperty('background-color', color);
                    if (props.isBgFill) {
                        /* background fill — just set opacity and stop */
                        arg.el.style.setProperty('opacity', '0.15');
                        return;
                    }
                    arg.el.style.setProperty('border-left-color', color);
                    /* CSS class covers all descendants — beats any FC inline color */
                    arg.el.classList.add('fc-event--dark-text');
                    var dot = arg.el.querySelector('.fc-daygrid-event-dot, .fc-list-event-dot');
                    if (dot) dot.style.setProperty('border-color', color);
                }
            },
        });
        adminCalendar.render();
    } else {
        adminCalendar.render();
    }

    // Initialize sidebar enhancements
    initMiniCalendar();
    renderWorkingSchedule();
    if (typeof window.loadWorkingHours === 'function') window.loadWorkingHours();
    if (window.calM365Init) window.calM365Init();
}

/* ---- Calendar sidebar tab switching ---- */
(function() {
    document.querySelectorAll('.cal-sidebar-tab').forEach(function(btn) {
        btn.addEventListener('click', function() {
            var target = this.dataset.tab;
            document.querySelectorAll('.cal-sidebar-tab').forEach(function(b) {
                b.classList.remove('active');
                b.setAttribute('aria-selected', 'false');
            });
            document.querySelectorAll('.cal-tab-panel').forEach(function(p) {
                p.classList.remove('active');
            });
            this.classList.add('active');
            this.setAttribute('aria-selected', 'true');
            var panel = document.getElementById(target);
            if (panel) panel.classList.add('active');
            if (target === 'cal-upcoming') renderWorkingSchedule();
        });
    });
})();

// Filter bar button click handlers
document.querySelectorAll('.cal-filter-btn').forEach(function(btn) {
    btn.addEventListener('click', function() {
        var filter = this.dataset.filter;
        _calFilterState[filter] = !_calFilterState[filter];
        this.classList.toggle('active', _calFilterState[filter]);
        this.setAttribute('aria-pressed', String(_calFilterState[filter]));
        _applyCalFilter();
        // Milestones toggled ON need a refetch — API includes them only when ?include=milestones
        if (filter === 'milestones' && _calFilterState.milestones) {
            if (adminCalendar) adminCalendar.refetchEvents();
        }
    });
});

/* ---- Mini Calendar Logic ---- */
let miniCalDate = new Date();
let miniCalEventDates = new Set(); // YYYY-MM-DD strings with events
function initMiniCalendar() {
    const body = document.getElementById('miniCalendarBody');
    const display = document.getElementById('miniMonthYearDisplay');
    const prev = document.getElementById('prevMiniMonth');
    const next = document.getElementById('nextMiniMonth');
    if (!body || !display) return;

    function render() {
        body.innerHTML = '';
        const year = miniCalDate.getFullYear();
        const month = miniCalDate.getMonth();
        const monthNames = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
        display.textContent = monthNames[month] + ' ' + year;

        const firstDay = new Date(year, month, 1).getDay();
        const daysInMonth = new Date(year, month + 1, 0).getDate();
        const today = new Date();

        let row = document.createElement('tr');
        for (let i = 0; i < firstDay; i++) {
            row.appendChild(document.createElement('td'));
        }

        for (let day = 1; day <= daysInMonth; day++) {
            if (row.children.length === 7) {
                body.appendChild(row);
                row = document.createElement('tr');
            }
            const cell = document.createElement('td');
            cell.textContent = day;
            const dateStr = year + '-' + String(month + 1).padStart(2, '0') + '-' + String(day).padStart(2, '0');
            const hasEvent = miniCalEventDates.has(dateStr);
            if (year === today.getFullYear() && month === today.getMonth() && day === today.getDate()) {
                cell.classList.add('current-day');
            }
            if (hasEvent) {
                cell.classList.add('has-event');
            }
            cell.style.cursor = 'pointer';
            cell.title = 'Click to block out this day';
            cell.tabIndex = 0;
            cell.setAttribute('role', 'button');
            cell.setAttribute('aria-label', 'Block out ' + monthNames[month] + ' ' + day + ', ' + year + (hasEvent ? ' (has event)' : ''));
            const activateCell = () => {
                if (adminCalendar) adminCalendar.gotoDate(new Date(year, month, day));
                openBlockOutModal(dateStr);
            };
            cell.onclick = activateCell;
            cell.onkeydown = (e) => {
                if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activateCell(); }
            };
            row.appendChild(cell);
        }
        while (row.children.length < 7) {
            row.appendChild(document.createElement('td'));
        }
        body.appendChild(row);
    }

    async function refreshEventDots() {
        try {
            const res = await fetch('/api/admin/calendar/events');
            const events = await res.json();
            miniCalEventDates = new Set((events || []).map(ev => (ev.start || '').split('T')[0]).filter(Boolean));
        } catch(e) { /* non-critical */ }
        render();
    }

    prev.onclick = () => { miniCalDate.setMonth(miniCalDate.getMonth() - 1); render(); };
    next.onclick = () => { miniCalDate.setMonth(miniCalDate.getMonth() + 1); render(); };
    window.refreshMiniCalendar = refreshEventDots;
    render();            // render immediately so the header is never stuck on "Loading..."
    refreshEventDots();  // then async-fetch event dots and re-render with them
}

/* ---- Working Schedule List ---- */
async function renderWorkingSchedule() {
    const listContainer = document.getElementById('upcomingScheduleList');
    if (!listContainer) return;

    try {
        const res = await fetch('/api/admin/calendar/events');
        const events = await res.json();
        
        if (!events || events.length === 0) {
            listContainer.innerHTML = '<li style="color: var(--atl-muted); padding: 20px; text-align: center;">No upcoming events.</li>';
            return;
        }

        const todayStart = new Date();
        todayStart.setHours(0, 0, 0, 0);

        // Filter for events starting today or in the future
        const upcoming = events.filter(ev => {
            if (!ev.start) return false;
            const evDate = new Date(ev.start);
            return !isNaN(evDate) && evDate >= todayStart;
        });

        // Sort chronologically ascending
        upcoming.sort((a, b) => new Date(a.start) - new Date(b.start));

        if (upcoming.length === 0) {
            listContainer.innerHTML = '<li style="color: var(--atl-muted); padding: 20px; text-align: center;">No upcoming events.</li>';
            return;
        }

        // Slice to show only next 6 events
        const limitedUpcoming = upcoming.slice(0, 6);
        listContainer.innerHTML = limitedUpcoming.map(ev => {
            const date = new Date(ev.start);
            const dateStr = date.toLocaleDateString('en-ZA', { month: 'short', day: 'numeric' });
            const timeStr = date.toLocaleTimeString('en-ZA', { hour: '2-digit', minute: '2-digit' });
            
            // Mirrors the main calendar's eventDidMount color mapping so the same booking/hold
            // reads as the same color everywhere, instead of collapsing every status to one dot.
            let dotColor = 'var(--atl-amber)'; // Default gold
            let isClickable = false;
            let onclickAttr = '';

            if (ev.extendedProps) {
                if (ev.extendedProps.type === 'booking') {
                    var s = (ev.extendedProps.status || '').toUpperCase();
                    if      (s === 'NEW' || s === 'PENDING')       dotColor = 'var(--atl-muted)';
                    else if (s === 'QUOTED')                       dotColor = 'var(--atl-orange)';
                    else if (s === 'ACCEPTED')                     dotColor = 'var(--atl-blue)';
                    else if (s === 'CONFIRMED')                    dotColor = 'var(--atl-amber)';
                    else if (s === 'COMPLETED')                    dotColor = 'var(--atl-sage)';
                    else if (s === 'CANCELLED' || s === 'EXPIRED') dotColor = 'var(--atl-clay)';
                    else                                           dotColor = 'var(--atl-amber)';
                    isClickable = true;
                    onclickAttr = `onclick="switchTab('bookingsAdmin'); $('#bookingStatusFilter').val('All').trigger('change'); setTimeout(() => { if (typeof window.toggleBookingDetail === 'function') window.toggleBookingDetail(${ev.extendedProps.dbId}, true); }, 300);"`;
                } else if (ev.extendedProps.type === 'hold') {
                    var bt = (ev.extendedProps.blockType || ev.extendedProps.block_type || '').toLowerCase();
                    if      (bt === 'travel')      dotColor = 'var(--atl-sage)';
                    else if (bt === 'personal')    dotColor = 'var(--atl-blue)';
                    else if (bt === 'maintenance') dotColor = 'var(--atl-orange)';
                    else                           dotColor = 'var(--atl-clay)';
                } else if (ev.extendedProps.type === 'event' || ev.extendedProps.type === 'public_event') {
                    dotColor = 'var(--atl-blue)';
                } else if (ev.extendedProps.type === 'external') {
                    dotColor = 'var(--atl-m365, #7a93b8)';
                } else if (ev.extendedProps.type === 'milestone') {
                    dotColor = ev.extendedProps.isOverdue ? 'var(--atl-clay)' : 'var(--atl-orange)';
                }
            }

            return `
                <li class="schedule-item ${isClickable ? 'clickable' : ''}" ${onclickAttr}>
                    <div class="schedule-item-header">
                        <span class="schedule-item-dot" style="background: ${dotColor};"></span>
                        <span class="schedule-item-title">${_esc(ev.title)}</span>
                    </div>
                    <div class="schedule-item-time">${dateStr} • ${timeStr}</div>
                    <div class="schedule-item-meta">${ev.extendedProps ? (ev.extendedProps.type === 'external' ? 'MICROSOFT 365' : (ev.extendedProps.type || 'Event').toUpperCase()) : 'EVENT'}</div>
                </li>
            `;
        }).join('');

        if (upcoming.length > 6) {
            listContainer.innerHTML += `<li style="padding:10px 0;text-align:center;border-top:1px solid var(--atl-line);margin-top:4px;list-style:none;">
                <a href="#" onclick="event.preventDefault(); window._calSwitchToList && window._calSwitchToList();"
                   style="font-family:'Outfit',sans-serif;font-size:12px;color:var(--atl-amber);text-decoration:none;font-weight:600;">
                    View all ${upcoming.length} upcoming →
                </a>
            </li>`;
        }

    } catch (err) {
        console.error('Error fetching schedule:', err);
        listContainer.innerHTML = '<li style="color: var(--atl-muted); padding: 20px; text-align: center;">Error loading events.</li>';
    }
}

// Refresh Calendar handler
const btnRefreshCalendar = document.getElementById('btnRefreshCalendar');
if (btnRefreshCalendar) {
    btnRefreshCalendar.onclick = async () => {
        const icon = btnRefreshCalendar.querySelector('i');
        if (icon) icon.classList.add('fa-spin');
        btnRefreshCalendar.disabled = true;
        if (typeof adminCalendar !== 'undefined' && adminCalendar) {
            adminCalendar.refetchEvents();
        }
        if (typeof window.refreshMiniCalendar === 'function') {
            await window.refreshMiniCalendar();
        }
        if (typeof renderWorkingSchedule === 'function') {
            await renderWorkingSchedule();
        }
        if (window.calM365RefreshStrip) window.calM365RefreshStrip();
        if (icon) icon.classList.remove('fa-spin');
        btnRefreshCalendar.disabled = false;
    };
}
