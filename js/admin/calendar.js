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
var _calFilterState = { bookings: true, holds: true, events: true, milestones: true };

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

function showCalEventPopup(info) {
    var props = info.event.extendedProps;
    var existing = document.getElementById('calEventPopup');
    if (existing) existing.remove();

    var rect = info.el.getBoundingClientRect();
    var popup = document.createElement('div');
    popup.id = 'calEventPopup';
    popup.style.cssText = 'position:fixed;z-index:9999;background: var(--atl-card);border:1px solid var(--atl-line);border-radius:10px;padding:18px 20px;min-width:260px;max-width:320px;box-shadow:0 8px 30px rgba(0,0,0,0.6);';
    popup.style.top = Math.min(rect.bottom + 6, window.innerHeight - 220) + 'px';
    popup.style.left = Math.min(rect.left, window.innerWidth - 340) + 'px';

    if (props.type === 'booking') {
        var sMap = { NEW:'var(--atl-muted)', PENDING:'var(--atl-muted)', QUOTED:'var(--atl-orange)', ACCEPTED:'var(--atl-blue)', CONFIRMED:'var(--atl-amber)', COMPLETED:'var(--atl-sage)', CANCELLED:'var(--atl-clay)', EXPIRED:'var(--atl-clay)' };
        var statusColor = sMap[(props.status || '').toUpperCase()] || 'var(--atl-amber-hover)';
        var outstanding = (props.amountOutstanding != null && props.amountOutstanding > 0) ? 'R ' + Number(props.amountOutstanding).toLocaleString('en-ZA', {minimumFractionDigits:2, maximumFractionDigits:2}) : null;
        popup.innerHTML = '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">' +
            '<strong style="color: var(--atl-amber);font-size:14px;"><i class="fa-solid fa-calendar-check"></i> Booking</strong>' +
            '<button onclick="document.getElementById(\'calEventPopup\').remove()" style="background:none;border:none;color:var(--atl-muted);font-size:18px;cursor:pointer;line-height:1;">&times;</button>' +
            '</div>' +
            '<div style="font-size:13px;line-height:1.75;color:var(--atl-ink-dim);">' +
            '<div style="margin-bottom:4px;"><strong style="color:var(--atl-ink);">' + info.event.title + '</strong></div>' +
            '<div>Date: <span style="color:var(--atl-ink);">' + (info.event.startStr || '').split('T')[0] + '</span></div>' +
            '<div>Status: <span style="color:' + statusColor + ';font-weight:700;">' + (props.status || '—') + '</span></div>' +
            '<div>Payment: <span style="color:var(--atl-muted);">' + (props.payment || '—') + '</span></div>' +
            (outstanding ? '<div>Outstanding: <span style="color:var(--atl-clay);font-weight:700;">' + outstanding + '</span></div>' : '') +
            (props.venueName ? '<div>Venue: <span style="color:var(--atl-muted);">' + props.venueName + (props.city ? ', ' + props.city : '') + '</span></div>' : '') +
            '</div>' +
            (props.isCalSynced || props.isAccepted || props.isPopiaDone || props.hasAttachments ? (
                '<div style="display:flex;flex-wrap:wrap;gap:4px;margin-top:8px;">' +
                (props.isCalSynced    ? '<span style="background:var(--atl-amber-dim);color:var(--atl-amber);border:1px solid var(--atl-amber-border);border-radius:999px;font-size:10px;font-weight:700;padding:2px 8px;">📅 Cal</span>' : '') +
                (props.isAccepted     ? '<span style="background:var(--atl-amber-dim);color:var(--atl-amber);border:1px solid var(--atl-amber-border);border-radius:999px;font-size:10px;font-weight:700;padding:2px 8px;">✓ Accepted</span>' : '') +
                (props.isPopiaDone    ? '<span style="background:var(--atl-amber-dim);color:var(--atl-amber);border:1px solid var(--atl-amber-border);border-radius:999px;font-size:10px;font-weight:700;padding:2px 8px;">🔒 POPIA</span>' : '') +
                (props.hasAttachments ? '<span style="background:var(--atl-amber-dim);color:var(--atl-amber);border:1px solid var(--atl-amber-border);border-radius:999px;font-size:10px;font-weight:700;padding:2px 8px;">📁 Brief</span>' : '') +
                '</div>'
            ) : '') +
            '<div style="margin-top:14px;display:flex;gap:6px;flex-wrap:wrap;">' +
            '<button onclick="switchTab(\'bookingsAdmin\'); $(\'#bookingStatusFilter\').val(\'All\').trigger(\'change\'); setTimeout(() => { const el = document.getElementById(\'bookingDetail-\' + \'' + props.dbId + '\'); if(el) { $(el).collapse(\'show\'); el.scrollIntoView({behavior:\'smooth\',block:\'center\'}); } }, 300); document.getElementById(\'calEventPopup\').remove();" style="flex:1;min-width:80px;background:var(--atl-amber);color:var(--atl-on-amber);border:none;border-radius:6px;padding:7px 10px;font-size:12px;font-weight:700;cursor:pointer;"><i class="fa-solid fa-eye"></i> View</button>' +
            (props.clientPhone ? '<button onclick="navigator.clipboard.writeText(\'' + props.clientPhone.replace(/'/g, '') + '\').then(function(){window.notificationService&&window.notificationService.showSuccess(\'Phone copied\')});" style="background:var(--atl-surface2);color:var(--atl-muted);border:1px solid var(--atl-line);border-radius:6px;padding:7px 10px;font-size:12px;cursor:pointer;" title="Copy client phone"><i class="fa-solid fa-phone"></i></button>' : '') +
            '</div>';
    } else if (props.type === 'milestone') {
        var isOverdue = !!props.isOverdue;
        var mColor = isOverdue ? 'var(--atl-clay)' : 'var(--atl-orange)';
        var mIcon  = props.milestoneType === 'quote_expiry' ? 'fa-file-invoice' : 'fa-circle-dollar-to-slot';
        var mLabel = props.milestoneType === 'quote_expiry' ? 'Quote Expiry' : 'Payment Due';
        var mAmount = (props.amount != null && props.amount > 0) ? 'R ' + Number(props.amount).toLocaleString('en-ZA', {minimumFractionDigits:2, maximumFractionDigits:2}) : null;
        popup.innerHTML = '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">' +
            '<strong style="color:' + mColor + ';font-size:14px;"><i class="fa-solid ' + mIcon + '"></i> ' + mLabel + '</strong>' +
            '<button onclick="document.getElementById(\'calEventPopup\').remove()" style="background:none;border:none;color:var(--atl-muted);font-size:18px;cursor:pointer;line-height:1;">&times;</button>' +
            '</div>' +
            '<div style="font-size:13px;line-height:1.75;color:var(--atl-ink-dim);">' +
            '<div style="margin-bottom:4px;"><strong style="color:var(--atl-ink);">' + info.event.title + '</strong></div>' +
            '<div>Date: <span style="color:' + (isOverdue ? 'var(--atl-clay)' : 'var(--atl-ink)') + ';font-weight:' + (isOverdue ? '700' : 'normal') + ';">' + (info.event.startStr || '').split('T')[0] + (isOverdue ? ' — OVERDUE' : '') + '</span></div>' +
            (mAmount ? '<div>Amount: <span style="color:' + mColor + ';font-weight:700;">' + mAmount + '</span></div>' : '') +
            '</div>' +
            (props.dbId ? '<div style="margin-top:14px;"><button onclick="switchTab(\'bookingsAdmin\'); $(\'#bookingStatusFilter\').val(\'All\').trigger(\'change\'); setTimeout(() => { const el = document.getElementById(\'bookingDetail-' + props.dbId + '\'); if(el) { $(el).collapse(\'show\'); el.scrollIntoView({behavior:\'smooth\',block:\'center\'}); } }, 300); document.getElementById(\'calEventPopup\').remove();" style="width:100%;background:var(--atl-amber);color:var(--atl-on-amber);border:none;border-radius:6px;padding:7px;font-size:12px;font-weight:700;cursor:pointer;"><i class="fa-solid fa-eye"></i> View Booking</button></div>' : '');
    } else if (props.type === 'public_event') {
        popup.innerHTML = '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">' +
            '<strong style="color:var(--atl-blue);font-size:14px;"><i class="fa-solid fa-star"></i> Public Event</strong>' +
            '<button onclick="document.getElementById(\'calEventPopup\').remove()" style="background:none;border:none;color:var(--atl-muted);font-size:18px;cursor:pointer;line-height:1;">&times;</button>' +
            '</div>' +
            '<div style="font-size:13px;line-height:1.75;color:var(--atl-ink-dim);">' +
            '<div style="margin-bottom:4px;"><strong style="color:var(--atl-ink);">' + info.event.title.replace('[EVENT] ', '') + '</strong></div>' +
            '<div>Date: <span style="color:var(--atl-ink);">' + (info.event.startStr || '').split('T')[0] + '</span></div>' +
            (props.venue ? '<div>Venue: <span style="color:var(--atl-muted);">' + props.venue + '</span></div>' : '') +
            '</div>' +
            '<div style="margin-top:14px;">' +
            '<button onclick="switchTab(\'eventsAdmin\'); setTimeout(() => { if(typeof window.openEvtEditDrawer===\'function\'){ window.openEvtEditDrawer(' + props.dbId + '); var $c=$(\'.atl-event-card[data-id=&quot;' + props.dbId + '&quot;]\'); if($c.length) $(\'html,body\').animate({scrollTop:$c.offset().top-70},400); } document.getElementById(\'calEventPopup\').remove(); }, 300);" style="width:100%;background:var(--atl-amber);color:var(--atl-on-amber);border:none;border-radius:6px;padding:7px;font-size:12px;font-weight:700;cursor:pointer;"><i class="fa-solid fa-pen-to-square"></i> Edit Event</button>' +
            '</div>';
    } else {
        popup.innerHTML = '<div style="display:flex;justify-content:space-between;align-items:center;">' +
            '<strong style="color:var(--atl-blue);font-size:13px;">' + info.event.title + '</strong>' +
            '<button onclick="document.getElementById(\'calEventPopup\').remove()" style="background:none;border:none;color:var(--atl-muted);font-size:18px;cursor:pointer;line-height:1;">&times;</button>' +
            '</div>';
    }

    document.body.appendChild(popup);
    setTimeout(() => { document.addEventListener('click', function dismiss(e) { if (!popup.contains(e.target)) { popup.remove(); document.removeEventListener('click', dismiss); } }); }, 50);
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
                if (props.type === 'hold') {
                    window.handleRemoveHold(props.dbId, info.event);
                    return;
                }
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
                    }).catch(() => { info.revert(); window.notificationService && window.notificationService.showError('Network error — hold not moved.'); });
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
                    }).catch(() => { info.revert(); window.notificationService && window.notificationService.showError('Network error — event date not updated.'); });
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
                }).catch(() => { info.revert(); window.notificationService && window.notificationService.showError('Network error — booking date not updated.'); });
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
                } else if (ev.extendedProps.type === 'milestone') {
                    dotColor = ev.extendedProps.isOverdue ? 'var(--atl-clay)' : 'var(--atl-orange)';
                }
            }

            return `
                <li class="schedule-item ${isClickable ? 'clickable' : ''}" ${onclickAttr}>
                    <div class="schedule-item-header">
                        <span class="schedule-item-dot" style="background: ${dotColor};"></span>
                        <span class="schedule-item-title">${ev.title}</span>
                    </div>
                    <div class="schedule-item-time">${dateStr} • ${timeStr}</div>
                    <div class="schedule-item-meta">${ev.extendedProps ? (ev.extendedProps.type || 'Event').toUpperCase() : 'EVENT'}</div>
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
        if (icon) icon.classList.remove('fa-spin');
        btnRefreshCalendar.disabled = false;
    };
}
