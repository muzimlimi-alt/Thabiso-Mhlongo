/* Phase 6 (HOUSEKEEPING-NOTES.md): relocated from admin.html verbatim — the "4. Events Logic
   (Database API Driven)" block (Upcoming Events tab: list rendering, search, bulk-selection
   actions, the #evtDrawer create/edit form, and the Google Maps Places Autocomplete venue
   lookup). window.atlActivateDrawerTab, uploadFileToServer, openAtlDrawer/closeAtlDrawer are
   called from inside this block but NOT moved — shared verbatim by other sections, Phase 7
   "Shared candidates".

   A generic, cross-cutting date/time-picker helper block (_fpDate/_fpTime/_fpDateTime/
   window.initAdminDateTimePickers, used by Financials/Services/Security/Contracts/Bookings and
   more) was physically sandwiched between this section's two pieces in admin.html and was NOT
   moved — it stays there untouched, and this file's two pieces are simply concatenated in their
   original relative order around that gap.

   New window attachments added: renderEventsList (called from 3 external script blocks — the
   standard refresh-everything pattern) and cancelEventEdit (referenced from a static
   onclick="cancelEventEdit();" in the evtDrawer markup, per this plan's on*= reachability rule
   — both were plain function declarations in the original source).

   Pre-existing developer comment preserved as-is, not resolved: a comment a few lines above
   window.initEventsMap's definition claims it "was defined but never called anywhere... a
   complete dead end", immediately next to code that DOES conditionally call it — an apparent
   inconsistency in the original comment, left byte-identical (a Phase 8 question, not this
   pass's to resolve). */

// ==========================================
// 4. Events Logic (Database API Driven)
// ==========================================
async function getEventsData() {
    try {
        var data = await apiCall('/api/admin/events');
        return Array.isArray(data) ? data : [];
    } catch(e) {
        console.error('[getEventsData]', e);
        return null; // distinct from [] to signal a fetch failure vs. an empty list
    }
}

async function renderEventsList(highlightId) {
    closeAtlDrawer('evtDrawer');
    var data = await getEventsData();
    var $upcomingList = $('#adminUpcomingEventsList');
    var $pastList = $('#adminPastEventsList');

    $upcomingList.empty();
    $pastList.empty();

    if (data === null) {
        // Network / API failure — distinct from an empty list
        var errState = '<div class="um-empty-state" style="padding: 40px 20px; text-align:center;"><i class="fa-solid fa-triangle-exclamation" style="font-size:28px;color:var(--atl-clay);display:block;margin-bottom:10px;"></i><p style="color:var(--atl-muted);margin:0;">Failed to load events — please refresh.</p></div>';
        $upcomingList.append(errState);
        $pastList.append(errState);
        window.notificationService.showError('Could not load events — please check your connection and refresh.');
        return;
    }

    if (data.length === 0) {
        $upcomingList.append('<div class="um-empty-state" style="padding: 40px 20px; text-align:center;"><i class="fa-solid fa-calendar-xmark" style="font-size:28px;color:var(--atl-muted-dim);display:block;margin-bottom:10px;"></i><p style="color:var(--atl-muted);margin:0;">No upcoming events found.</p></div>');
        $pastList.append('<div class="um-empty-state" style="padding: 40px 20px; text-align:center;"><i class="fa-solid fa-calendar-xmark" style="font-size:28px;color:var(--atl-muted-dim);display:block;margin-bottom:10px;"></i><p style="color:var(--atl-muted);margin:0;">No past events found.</p></div>');
        return;
    }

    var now = new Date().getTime();
    var upcomingCount = 0;
    var pastCount = 0;

    data.forEach(function (item) {
        var posterUrl = item.poster_image_path || 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
        var isVideo = posterUrl.includes('youtube') || posterUrl.includes('vimeo');
        var safeThumb = isVideo ? 'https://placehold.co/320x180/111/fff?text=Video+Poster' : posterUrl;

        var displayDateStr = item.event_datetime;
        var itemTime = 0;
        if (item.event_datetime) {
            try {
                var d = new Date(item.event_datetime);
                if (!isNaN(d)) {
                    itemTime = d.getTime();
                    displayDateStr = d.toLocaleString('en-US', { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
                }
            } catch(e) {}
        }

        var displayTitle = item.event_title || 'No Event Name';
        var displayVenue = item.venue_name || 'No Venue specified';
        var encodedItem = encodeURIComponent(JSON.stringify(item));
        var isUpcoming = itemTime >= now || !itemTime;
        var cardIdx = isUpcoming ? upcomingCount : pastCount;

        var statusBadgeMap = {
            draft:     '<span class="evt-badge evt-badge--muted"><i class="fa-solid fa-file-pen"></i> <span>Draft</span></span>',
            sold_out:  '<span class="evt-badge evt-badge--warn"><i class="fa-solid fa-ticket-slash"></i> <span>Sold Out</span></span>',
            postponed: '<span class="evt-badge evt-badge--warn"><i class="fa-solid fa-clock-rotate-left"></i> <span>Postponed</span></span>',
            completed: '<span class="evt-badge evt-badge--muted"><i class="fa-solid fa-flag-checkered"></i> <span>Completed</span></span>',
            cancelled: '<span class="evt-badge evt-badge--danger"><i class="fa-solid fa-ban"></i> <span>Cancelled</span></span>',
            live:      '<span class="evt-badge evt-badge--sage"><i class="fa-solid fa-circle-dot"></i> <span>Live</span></span>'
        };
        var badgeTimeline = isUpcoming
            ? '<span class="evt-badge evt-badge--amber"><i class="fa-solid fa-bolt"></i> <span>Upcoming</span></span>'
            : '<span class="evt-badge evt-badge--muted"><i class="fa-solid fa-clock-rotate-left"></i> <span>Past</span></span>';
        var badgeDraft = (statusBadgeMap[item.event_status] && item.event_status !== 'upcoming') ? statusBadgeMap[item.event_status] : '';
        var badgeLinked = item.booking_id
            ? '<span class="evt-badge evt-badge--amber-dim"><i class="fa-solid fa-link"></i> <span>Booking #' + item.booking_id + '</span></span>'
            : '';
        var badgeGcal = item.google_calendar_event_id
            ? '<span class="evt-badge evt-badge--blue"><i class="fa-brands fa-google"></i> <span>GCal</span></span>'
            : '';
        var badgeVideo = isVideo
            ? '<span class="evt-badge evt-badge--red"><i class="fa-brands fa-youtube"></i> <span>Video</span></span>'
            : '';
        var badgeCategory = item.event_type
            ? '<span class="evt-badge evt-badge--muted"><i class="fa-solid fa-tag"></i> <span>' + item.event_type + '</span></span>'
            : '';

        var html = `
        <article class="atl-edit-card atl-event-card" data-id="${item.event_id}" data-payload="${encodedItem}" style="animation-delay:${cardIdx * 40}ms">
          <label class="evt-select-cb-wrap"><input type="checkbox" class="evt-select-cb" data-id="${item.event_id}" aria-label="Select ${displayTitle}"></label>
          <div class="atl-card-inner">
            <div class="atl-edit-card__header">
              <div class="atl-edit-card__thumb">
                <img src="${safeThumb}" alt="${displayTitle}" onerror="this.onerror=null;this.src='https://placehold.co/72x100/1a1a1a/D4AF37?text=No+Image';">
              </div>
              <div style="flex:1; min-width:0;">
                <div style="display:flex; align-items:center; gap:6px; flex-wrap:wrap; margin-bottom:6px;">
                  <span class="atl-booking-id">#${item.event_id}</span>
                  ${badgeTimeline}${badgeDraft}${badgeLinked}${badgeGcal}${badgeVideo}${badgeCategory}
                </div>
                <h3 class="atl-edit-card__title">${displayTitle}</h3>
                <p class="atl-edit-card__subtitle" style="margin-bottom:2px;"><i class="fa-regular fa-calendar-check" style="color:var(--atl-amber);"></i> ${displayDateStr}</p>
                <p class="atl-edit-card__subtitle"><i class="fa-solid fa-location-dot" style="color:var(--atl-amber);"></i> ${displayVenue}</p>
              </div>
              <div style="display:flex; flex-direction:column; align-items:flex-end; gap:6px; flex-shrink:0;">
                <button type="button" class="atl-btn atl-btn--ghost um-btn--sm" onclick="window.openEvtEditDrawer(${item.event_id})" title="Edit event" aria-label="Edit event: ${displayTitle}">
                  <i class="fa-solid fa-pen"></i>
                </button>
                <button type="button" class="atl-btn atl-btn--ghost um-btn--sm evt-duplicate-btn" data-id="${item.event_id}" title="Duplicate event as draft" aria-label="Duplicate event: ${displayTitle} as draft">
                  <i class="fa-regular fa-copy"></i>
                </button>
                <button type="button" class="um-btn um-btn--danger um-btn--sm remove-events-action" data-id="${item.event_id}" title="Delete event" aria-label="Delete event: ${displayTitle}">
                  <i class="fa-solid fa-trash-can"></i>
                </button>
              </div>
            </div>
          </div>
        </article>`;

        if (isUpcoming) {
            $upcomingList.append(html);
            upcomingCount++;
        } else {
            $pastList.append(html);
            pastCount++;
        }
    });

    if (upcomingCount === 0) $upcomingList.append('<div class="um-empty-state" style="padding:30px;border:1px dashed var(--atl-line);border-radius:12px;text-align:center;"><p style="color:var(--atl-muted);margin:0;">No upcoming events.</p></div>');
    if (pastCount === 0) $pastList.append('<div class="um-empty-state" style="padding:30px;border:1px dashed var(--atl-line);border-radius:12px;text-align:center;"><p style="color:var(--atl-muted);margin:0;">No past events recorded.</p></div>');

    // Update count badges
    $('#evtCountUpcoming').text(upcomingCount || '');
    $('#evtCountPast').text(pastCount || '');

    // Re-apply search filter if active
    var q = ($('#eventsSearchInput').val() || '').trim().toLowerCase();
    if (q) eventsApplySearch(q);

    // CSS handles re-show of checkboxes via .evt-card-selectable .evt-select-cb-wrap
    
    if (highlightId) {
        setTimeout(function() {
            var $card = $('.atl-event-card[data-id="' + highlightId + '"]');
            if ($card.length) {
                $card[0].scrollIntoView({ behavior: 'smooth', block: 'center' });
                $card.css({
                    'transition': 'all 0.5s ease',
                    'box-shadow': '0 0 15px var(--atl-amber)',
                    'border-color': 'var(--atl-amber)'
                });
                setTimeout(function() {
                    $card.css({
                        'box-shadow': '',
                        'border-color': ''
                    });
                }, 3000);
            }
        }, 100);
    }
}
window.renderEventsList = renderEventsList;

$(document).on('click', '.remove-events-action', async function (e) {
    e.preventDefault();
    if (await window.notificationService.showConfirm({ message: "Are you sure you want to permanently delete this event?", isDestructive: true })) {
        var eventId = $(this).data('id');
        var res = await apiCall('/api/admin/events/' + eventId, 'DELETE');
        if (res && res.success) {
            renderEventsList();
        } else {
            window.notificationService.showError('Error deleting event: ' + (res ? res.error : 'Unknown error'));
        }
    }
});

// ── Event Duplication ────────────────────────────────────────────────
$(document).on('click', '.evt-duplicate-btn', async function(e) {
    e.stopPropagation();
    var eventId = $(this).data('id');
    var $btn = $(this);
    $btn.prop('disabled', true).html('<i class="fa-solid fa-spinner fa-spin"></i>');
    var res = await apiCall('/api/admin/events/' + eventId + '/duplicate', 'POST', {});
    $btn.prop('disabled', false).html('<i class="fa-regular fa-copy"></i>');
    if (res && res.success) {
        window.notificationService.showSuccess('Event duplicated as draft (ID #' + res.id + ').');
        renderEventsList(res.id);
    } else {
        window.notificationService.showError('Duplication failed: ' + (res ? res.error || res.message : 'Unknown error'));
    }
});

// ── Events Search (client-side) ──────────────────────────────────────
function eventsApplySearch(q) {
    $('.atl-event-card').each(function() {
        var title = ($(this).find('.atl-edit-card__title').text() || '').toLowerCase();
        var meta  = ($(this).find('.atl-edit-card__subtitle').text() || '').toLowerCase();
        $(this).toggle(!q || title.includes(q) || meta.includes(q));
    });
}
$('#eventsSearchInput').on('input', function() {
    eventsApplySearch($(this).val().trim().toLowerCase());
});

// ── Bulk Selection Mode ──────────────────────────────────────────────
function evtGetSelectedIds() {
    return $('.evt-select-cb:checked').map(function() { return $(this).data('id'); }).get();
}
function evtUpdateBulkBar() {
    var ids = evtGetSelectedIds();
    $('#evtBulkCount').text(ids.length + ' selected');
    if (ids.length > 0) $('#evtBulkBar').show();
    else $('#evtBulkBar').hide();
}

$('#evtBulkToggle').on('click', function() {
    var $section = $('#eventsAdmin');
    var entering = !$section.hasClass('evt-card-selectable');
    $section.toggleClass('evt-card-selectable', entering);
    $(this).toggleClass('atl-btn--primary', entering).attr('aria-pressed', String(entering));
    if (!entering) {
        $('.evt-select-cb').prop('checked', false);
        $('.atl-event-card').removeClass('evt-selected');
        $('#evtBulkBar').hide();
    }
});

$(document).on('change', '.evt-select-cb', function() {
    $(this).closest('.atl-event-card').toggleClass('evt-selected', this.checked);
    evtUpdateBulkBar();
});

// Prevent card expand when clicking checkbox
$(document).on('click', '.evt-select-cb', function(e) { e.stopPropagation(); });

$('#evtBulkCancel').on('click', function() {
    $('.evt-select-cb').prop('checked', false);
    $('.atl-event-card').removeClass('evt-selected');
    $('#eventsAdmin').removeClass('evt-card-selectable');
    $('#evtBulkToggle').removeClass('atl-btn--primary').attr('aria-pressed', 'false');
    $('#evtBulkBar').hide();
});

$('#evtBulkPublish').on('click', async function() {
    var ids = evtGetSelectedIds();
    if (!ids.length) return;
    var failed = 0;
    for (var i = 0; i < ids.length; i++) {
        try {
            var card = $('.atl-event-card[data-id="' + ids[i] + '"]');
            var payload = JSON.parse(decodeURIComponent(card.attr('data-payload') || '{}'));
            payload.event_status = 'upcoming';
            await apiCall('/api/admin/events/' + ids[i], 'PUT', payload);
        } catch(e) { console.error('[evtBulkPublish]', e); failed++; }
    }
    if (failed > 0) window.notificationService.showError(failed + ' of ' + ids.length + ' event(s) could not be published.');
    else window.notificationService.showSuccess(ids.length + ' event(s) published.');
    renderEventsList();
    $('#evtBulkCancel').trigger('click');
});

$('#evtBulkUnpublish').on('click', async function() {
    var ids = evtGetSelectedIds();
    if (!ids.length) return;
    var failed = 0;
    for (var i = 0; i < ids.length; i++) {
        try {
            var card = $('.atl-event-card[data-id="' + ids[i] + '"]');
            var payload = JSON.parse(decodeURIComponent(card.attr('data-payload') || '{}'));
            payload.event_status = 'draft';
            await apiCall('/api/admin/events/' + ids[i], 'PUT', payload);
        } catch(e) { console.error('[evtBulkUnpublish]', e); failed++; }
    }
    if (failed > 0) window.notificationService.showError(failed + ' of ' + ids.length + ' event(s) could not be set to draft.');
    else window.notificationService.showSuccess(ids.length + ' event(s) set to draft.');
    renderEventsList();
    $('#evtBulkCancel').trigger('click');
});

$('#evtBulkDelete').on('click', async function() {
    var ids = evtGetSelectedIds();
    if (!ids.length) return;
    if (!await window.notificationService.showConfirm({ message: 'Delete ' + ids.length + ' event(s)? This cannot be undone.', isDestructive: true })) return;
    var failed = 0;
    for (var i = 0; i < ids.length; i++) {
        try {
            await apiCall('/api/admin/events/' + ids[i], 'DELETE');
        } catch(e) { console.error('[evtBulkDelete]', e); failed++; }
    }
    if (failed > 0) window.notificationService.showError(failed + ' of ' + ids.length + ' event(s) could not be deleted.');
    else window.notificationService.showSuccess(ids.length + ' event(s) deleted.');
    renderEventsList();
    $('#evtBulkCancel').trigger('click');
});

$('#evtBulkCancelEvt').on('click', async function() {
    var ids = evtGetSelectedIds();
    if (!ids.length) return;
    if (!await window.notificationService.showConfirm({ message: 'Cancel ' + ids.length + ' event(s)?', isDestructive: true })) return;
    var failed = 0;
    for (var i = 0; i < ids.length; i++) {
        try {
            var card = $('.atl-event-card[data-id="' + ids[i] + '"]');
            var payload = JSON.parse(decodeURIComponent(card.attr('data-payload') || '{}'));
            payload.event_status = 'cancelled'; payload.sync_to_gcal = false;
            await apiCall('/api/admin/events/' + ids[i], 'PUT', payload);
        } catch(e) { console.error('[evtBulkCancelEvt]', e); failed++; }
    }
    if (failed > 0) window.notificationService.showError(failed + ' of ' + ids.length + ' event(s) could not be cancelled.');
    else window.notificationService.showSuccess(ids.length + ' event(s) cancelled.');
    renderEventsList();
    $('#evtBulkCancel').trigger('click');
});

$('#evtBulkPostpone').on('click', async function() {
    var ids = evtGetSelectedIds();
    if (!ids.length) return;
    var failed = 0;
    for (var i = 0; i < ids.length; i++) {
        try {
            var card = $('.atl-event-card[data-id="' + ids[i] + '"]');
            var payload = JSON.parse(decodeURIComponent(card.attr('data-payload') || '{}'));
            payload.event_status = 'postponed';
            await apiCall('/api/admin/events/' + ids[i], 'PUT', payload);
        } catch(e) { console.error('[evtBulkPostpone]', e); failed++; }
    }
    if (failed > 0) window.notificationService.showError(failed + ' of ' + ids.length + ' event(s) could not be postponed.');
    else window.notificationService.showSuccess(ids.length + ' event(s) postponed.');
    renderEventsList();
    $('#evtBulkCancel').trigger('click');
});

$('#evtBulkComplete').on('click', async function() {
    var ids = evtGetSelectedIds();
    if (!ids.length) return;
    var failed = 0;
    for (var i = 0; i < ids.length; i++) {
        try {
            var card = $('.atl-event-card[data-id="' + ids[i] + '"]');
            var payload = JSON.parse(decodeURIComponent(card.attr('data-payload') || '{}'));
            payload.event_status = 'completed';
            await apiCall('/api/admin/events/' + ids[i], 'PUT', payload);
        } catch(e) { console.error('[evtBulkComplete]', e); failed++; }
    }
    if (failed > 0) window.notificationService.showError(failed + ' of ' + ids.length + ' event(s) could not be marked complete.');
    else window.notificationService.showSuccess(ids.length + ' event(s) marked complete.');
    renderEventsList();
    $('#evtBulkCancel').trigger('click');
});

window.openCancelEventModal = function(eventId, eventTitle) {
    $('#cancelEventId').val(eventId);
    $('#cancelEventLabel').text('Cancel "' + eventTitle + '"? This sets the event status to Cancelled.');
    $('#cancelEventReason').val('');
    $('#cancelEventModal').modal('show');
};

// Delegated — #cancelEventConfirmBtn lives in a modal defined after this script runs.
$(document).on('click', '#cancelEventConfirmBtn', async function() {
    var eventId = $('#cancelEventId').val();
    var reason = $('#cancelEventReason').val().trim();
    if (!reason) { window.notificationService.showError('Please enter a cancellation reason.'); return; }
    var $card = $('.atl-event-card[data-id="' + eventId + '"]');
    var payload = $card.length ? JSON.parse(decodeURIComponent($card.attr('data-payload') || '{}')) : {};
    payload.event_status = 'cancelled';
    payload.cancellation_reason = reason;
    payload.sync_to_gcal = false;
    var res = await apiCall('/api/admin/events/' + eventId, 'PUT', payload);
    if (res && res.success !== false) {
        window.notificationService.showSuccess('Event cancelled.');
        $('#cancelEventModal').modal('hide');
        renderEventsList();
        cancelEventEdit();
    } else {
        window.notificationService.showError((res && res.message) || 'Failed to cancel event.');
    }
});

// ── EVENT EDITOR CONTROLLER ─────────────────────────────────────────────
// #eventsForm lives permanently inside the evtDrawer (see #eventsFormHomeMount) - it is the
// single editing surface for both creating and updating events, mirroring the Banner Library's
// drawer-only pattern (openBnrCreateDrawer/openBnrEditDrawer above). No inline accordion.

function applyEventToEditor(item) {
    $('#eventsId').val(item.event_id);
    $('#eventsTitle').val(item.event_title || '');
    $('#eventsDesc').val(item.event_description || '');

    if (item.event_datetime) {
        try {
            var d = new Date(item.event_datetime);
            if (!isNaN(d)) {
                var dtStr = d.toISOString().substring(0, 16);
                $('#eventsDate').val(dtStr);
                if ($('#eventsDate')[0]._flatpickr) $('#eventsDate')[0]._flatpickr.setDate(dtStr, false);
            } else {
                $('#eventsDate').val(item.event_datetime);
            }
        } catch(e2) { $('#eventsDate').val(item.event_datetime); }
    } else {
        $('#eventsDate').val('');
        if ($('#eventsDate')[0]._flatpickr) $('#eventsDate')[0]._flatpickr.clear();
    }

    $('#eventsVenue').val(item.venue_name || '');
    $('#eventsVenueMapLink').val(item.venue_map_link || '');
    $('#eventsCapacity').val(item.event_capacity || '');
    $('#eventsTicketUrl').val(item.ticket_sales_link || '');
    $('#eventsFallbackUrl').val(item.poster_image_path || '');
    if (item.poster_image_path) {
        $('#evtPosterPreviewImg').attr('src', item.poster_image_path);
        $('#evtPosterPreview').show();
    } else {
        $('#evtPosterPreview').hide(); $('#evtPosterPreviewImg').attr('src', '');
    }
    $('#eventsBookingId').val(item.booking_id || '');
    $('#eventsStatus').val(item.event_status || 'upcoming');
    $('#eventsType').val(item.event_type || '');
    if (item.event_end_time) {
        var endVal = item.event_end_time;
        // Migrate legacy H:i-only format to a full datetime using the event date
        if (/^\d{2}:\d{2}$/.test(endVal) && item.event_datetime) {
            endVal = item.event_datetime.split('T')[0] + 'T' + endVal;
        }
        if ($('#eventsEndTime')[0]._flatpickr) $('#eventsEndTime')[0]._flatpickr.setDate(endVal, false);
        else $('#eventsEndTime').val(endVal);
    } else {
        if ($('#eventsEndTime')[0]._flatpickr) $('#eventsEndTime')[0]._flatpickr.clear();
        else $('#eventsEndTime').val('');
    }

    if (item.booking_id) {
        $('#eventsLinkedBookingBadge').show();
        $('#eventsLinkedBookingLink').off('click.evtLink').on('click.evtLink', function(e) {
            e.preventDefault();
            switchTab('bookingsAdmin');
            setTimeout(function() {
                if (typeof window.toggleBookingDetail === 'function') window.toggleBookingDetail(item.booking_id, true);
            }, 300);
        });
        $('#eventsConflictResolutionGroup').hide();
        $('#eventsBlockType').val('none');
    } else {
        $('#eventsLinkedBookingBadge').hide();
        $('#eventsConflictResolutionGroup').show();
    }

    if (item.google_calendar_event_id) {
        $('#eventsGcalLink').attr('href', 'https://calendar.google.com/calendar/r/eventedit/' + item.google_calendar_event_id);
        $('#eventsGcalLinkBadge').show();
    } else {
        $('#eventsGcalLinkBadge').hide();
    }
    $('#eventsGcalSync').prop('checked', true);
    $('#evtDrawerTitle').html('<i class="fa-solid fa-pen-to-square"></i> Edit Event');
    $('#eventsSubmitBtn').html('<i class="fa-solid fa-pen-to-square"></i> Update Event');
    if (item.event_status !== 'cancelled') {
        $('#evtCancelEventBtn').show().off('click.evtcancel').on('click.evtcancel', function() {
            window.openCancelEventModal(item.event_id, item.event_title);
        });
    } else {
        $('#evtCancelEventBtn').hide();
    }

    $('#evt-tab-history').show();
    if (window.loadChangeHistoryCard) window.loadChangeHistoryCard('evtChangeHistoryList', 'events', item.event_id);
}

// Blank slate shared by "New Event" and the pre-populate step of "Edit Event" — mirrors
// resetBnrForm() in the Banner Library above.
function resetEventForm() {
    $('#eventsForm')[0].reset();
    $('#eventsId').val('');
    $('#eventsFallbackUrl').val('');
    // form.reset() only touches native form controls, not this preview <img>/<div>.
    $('#evtPosterPreview').hide(); $('#evtPosterPreviewImg').attr('src', '');
    $('#eventsGcalLinkBadge').hide();
    $('#eventsLinkedBookingBadge').hide();
    $('#eventsConflictResolutionGroup').show();
    if ($('#eventsEndTime')[0]._flatpickr) $('#eventsEndTime')[0]._flatpickr.clear();
    if ($('#eventsDate')[0]._flatpickr) $('#eventsDate')[0]._flatpickr.clear();
    $('#eventsSubmitBtn').prop('disabled', false).html('<i class="fa-solid fa-calendar-check"></i> Add Event');
    $('#evtCancelEventBtn').hide();
    $('#evt-tab-history').hide();
    window.atlActivateDrawerTab('evtDrawer', 'evt-tab-edit');
    $('#evtDrawerTitle').html('<i class="fa-solid fa-calendar-plus"></i> New Event');
}

// Add New Event button — Create mode
window.openEvtCreateDrawer = function() {
    resetEventForm();
    openAtlDrawer('evtDrawer');
    $('#eventsTitle').focus();
};
$('#eventsAddNewBtn').on('click', function() { window.openEvtCreateDrawer(); });

// Card "Edit" button — Edit mode. openAtlDrawer() dispatches atl:drawerOpened synchronously,
// which initializes the Flatpickr date pickers before applyEventToEditor() sets their values.
window.openEvtEditDrawer = function(eventId) {
    var payload = $('.atl-event-card[data-id="' + eventId + '"]').attr('data-payload');
    if (!payload) return;
    resetEventForm();
    openAtlDrawer('evtDrawer');
    applyEventToEditor(JSON.parse(decodeURIComponent(payload)));
};

function cancelEventEdit() {
    resetEventForm();
    closeAtlDrawer('evtDrawer');
}
window.cancelEventEdit = cancelEventEdit;

// Close event drawer handler
$(document).on('click', '#evtDrawerClose, #evtDrawerBackdrop', function() {
    cancelEventEdit();
});

// Legacy deep-link entry point (calendar popup, etc.)
$(document).on('click', '.edit-events-action', function(e) {
    e.preventDefault();
    var id = $(this).data('id');
    if (id) {
        window.openEvtEditDrawer(id);
        var $c = $('.atl-event-card[data-id="' + id + '"]');
        if ($c.length) $('html,body').animate({ scrollTop: $c.offset().top - 70 }, 400);
    }
});

// Delegated — #eventsForm lives in the drawer, parsed after this script runs.
$(document).on('submit', '#eventsForm', async function (e) {
    e.preventDefault();

    var eventId = ($('#eventsId').val() || '').trim();
    var titleInput = ($('#eventsTitle').val() || '').trim();
    var descInput = ($('#eventsDesc').val() || '').trim();
    var dateInput = ($('#eventsDate').val() || '').trim();
    var endTimeInput = ($('#eventsEndTime').val() || '').trim();
    var eventTypeInput = ($('#eventsType').val() || '').trim();
    var venueInput = ($('#eventsVenue').val() || '').trim();
    var venueMapLink = ($('#eventsVenueMapLink').val() || '').trim();
    var ticketUrl = ($('#eventsTicketUrl').val() || '').trim();
    
    var bookingId = ($('#eventsBookingId').val() || '').trim();
    var blockType = ($('#eventsBlockType').val() || 'none').trim();
    var fallbackUrl = ($('#eventsFallbackUrl').val() || '').trim();
    var file = $('#eventsFile')[0].files[0];
    var $btn = $('#eventsSubmitBtn');

    // Force 30 minute validation one last time on submit just in case
    if (dateInput) {
        var d = new Date(dateInput);
        var m = d.getMinutes();
        if (m !== 0 && m !== 30) {
            window.notificationService.showError("Please select a start time in 30-minute intervals (e.g., 18:00 or 18:30).");
            $btn.prop('disabled', false);
            return;
        }
    }

    if (endTimeInput) {
        var endTimePart = endTimeInput.includes('T') ? endTimeInput.split('T')[1] : endTimeInput;
        var timeParts = endTimePart.split(':');
        if (timeParts.length === 2) {
            var endM = parseInt(timeParts[1], 10);
            if (endM !== 0 && endM !== 30) {
                window.notificationService.showError("Please select an end time in 30-minute intervals (e.g., 19:00 or 19:30).");
                $btn.prop('disabled', false);
                return;
            }
        }
    }

    if (dateInput && endTimeInput) {
        var startDate = new Date(dateInput);
        var endDate = new Date(endTimeInput);
        if (endDate <= startDate) {
            window.notificationService.showError("Event end time must be after the start time.");
            $btn.prop('disabled', false);
            return;
        }
    }

    var isEdit = !!eventId;
    var origBtnHtml = $btn.html();

    var submitAPIEvent = async function(finalMediaUrl) {
        var payload = {
            event_title: titleInput,
            event_description: descInput,
            event_datetime: dateInput,
            event_end_time: endTimeInput || null,
            event_type: eventTypeInput || null,
            venue_name: venueInput,
            venue_map_link: venueMapLink,
            ticket_sales_link: ticketUrl,
            poster_image_path: finalMediaUrl,
            event_status: $('#eventsStatus').val() || 'upcoming',
            event_capacity: parseInt($('#eventsCapacity').val()) || null,
            booking_id: bookingId || null,
            block_type: blockType,
            sync_to_gcal: $('#eventsGcalSync').is(':checked')
        };

        try {
            let res = isEdit
                ? await apiCall('/api/admin/events/' + eventId, 'PUT', payload)
                : await apiCall('/api/admin/events', 'POST', payload);

            if(res && res.success) {
                // Single editing surface: same close/reset/reload/toast workflow as the
                // Banner Library's #bnrForm submit handler above.
                closeAtlDrawer('evtDrawer');
                resetEventForm();
                renderEventsList();

                if (payload.sync_to_gcal) {
                    if (res.gcal_synced) window.notificationService.showSuccess((isEdit ? 'Event updated' : 'Event created') + ' and synced to Google Calendar.');
                    else window.notificationService.showError((isEdit ? 'Event updated' : 'Event created') + ', but Google Calendar sync failed.');
                } else {
                    window.notificationService.showSuccess(isEdit ? 'Event updated.' : 'Event created.');
                }
            } else {
                window.notificationService.showError('Error saving event: ' + (res && res.error));
                $btn.prop('disabled', false).html(origBtnHtml);
            }
        } catch(err) {
            window.notificationService.showError('Save failed: ' + ((err && err.message) || 'Unknown error'));
            $btn.prop('disabled', false).html(origBtnHtml);
        }
    };

    $btn.prop('disabled', true).html('<i class="fa-solid fa-spinner fa-spin"></i> Saving...');

    // 1. File Input handling
    if (file) {
        if (file.type.startsWith('video/')) {
            $('#eventVideoWarning').show();
            $btn.prop('disabled', false).html(origBtnHtml);
            return; // block videos right away
        } else {
            $('#eventVideoWarning').hide();
        }

        uploadFileToServer(file, 'events').then(filePath => {
            if (filePath) {
                submitAPIEvent(filePath);
            } else {
                // Safe fallback ONLY if API offline
                var reader = new FileReader();
                reader.onload = function(event) {
                    var img = new Image();
                    img.onload = function() {
                        var canvas = document.createElement('canvas');
                        var MAX_WIDTH = 800;
                        var MAX_HEIGHT = 800;
                        var width = img.width;
                        var height = img.height;
                        if (width > height) {
                            if (width > MAX_WIDTH) { height *= MAX_WIDTH / width; width = MAX_WIDTH; }
                        } else {
                            if (height > MAX_HEIGHT) { width *= MAX_HEIGHT / height; height = MAX_HEIGHT; }
                        }
                        canvas.width = width;
                        canvas.height = height;
                        var ctx = canvas.getContext("2d");
                        ctx.drawImage(img, 0, 0, width, height);
                        var dataUrl = canvas.toDataURL("image/jpeg", 0.7);
                        submitAPIEvent(dataUrl);
                    };
                    img.src = event.target.result;
                };
                reader.readAsDataURL(file);
            }
        }).catch(err => {
            window.notificationService.showError('Upload failed: ' + err.message);
            $btn.prop('disabled', false).html(origBtnHtml);
        });
    } 
    // 2. Fallback to existing poster (Used mostly during edit!)
    else if (fallbackUrl) {
        submitAPIEvent(fallbackUrl);
    }
    // 3. Default dummy poster otherwise
    else {
        submitAPIEvent('images/events/1.jpg');
    }
});

$(document).on('change', '#eventsFile', function() {
    var file = this.files[0];
    var text = document.getElementById('eventsUploadText');
    if (text) {
        text.textContent = file ? file.name : 'Select or drop event poster';
    }
    if (file && file.type.startsWith('video/')) {
        $('#eventVideoWarning').show();
        $('#evtPosterPreview').hide();
        $('#evtPosterPreviewImg').attr('src', '');
    } else if (file && file.type.startsWith('image/')) {
        $('#eventVideoWarning').hide();
        var reader = new FileReader();
        reader.onload = function(e) {
            $('#evtPosterPreviewImg').attr('src', e.target.result);
            $('#evtPosterPreview').show();
        };
        reader.readAsDataURL(file);
    } else {
        $('#eventVideoWarning').hide();
        $('#evtPosterPreview').hide();
        $('#evtPosterPreviewImg').attr('src', '');
    }
});

// Drag-and-drop highlight for the events upload zone (bound after ready; element persists through docking)
$(function () {
    const zone = document.getElementById('eventsUploadZone');
    if (!zone) return;
    ['dragenter','dragover'].forEach(function(ev){ zone.addEventListener(ev, function(e){ e.preventDefault(); e.stopPropagation(); zone.classList.add('um-upload-zone--dragging'); if (ev === 'dragenter') { var t = document.getElementById('eventsUploadText'); if (t) t.textContent = 'Drop poster here'; } }); });
    ['dragleave','drop'].forEach(function(ev){ zone.addEventListener(ev, function(e){ e.preventDefault(); e.stopPropagation(); zone.classList.remove('um-upload-zone--dragging'); }); });
    zone.addEventListener('drop', function(e){
        var dropped = e.dataTransfer && e.dataTransfer.files;
        if (dropped && dropped.length) { var input = document.getElementById('eventsFile'); try { input.files = dropped; } catch(err){} $('#eventsFile').trigger('change'); }
    });
});

// Date/time 30-minute restrictor (Flatpickr). #eventsDate/#eventsEndTime live in the drawer,
// which is parsed after this script runs — so init lazily/idempotently (guarded by !_flatpickr)
// and trigger it on drawer-open and on inline-edit card expand.
window.initEventsPickers = function() {
    if (typeof flatpickr === 'undefined') return;
    var dateEl = document.getElementById('eventsDate');
    if (dateEl && !dateEl._flatpickr) {
        flatpickr(dateEl, {
            enableTime: true,
            dateFormat: "Y-m-d\\TH:i",
            altInput: true,
            altFormat: "D, M j, Y · H:i",
            time_24hr: true,
            minuteIncrement: 30,
            monthSelectorType: "static",
            placeholder: "Select Date and Time"
        });
    }
    var endEl = document.getElementById('eventsEndTime');
    if (endEl && !endEl._flatpickr) {
        flatpickr(endEl, {
            enableTime: true,
            dateFormat: "Y-m-d\\TH:i",
            altInput: true,
            altFormat: "D, M j, Y · H:i",
            time_24hr: true,
            minuteIncrement: 30,
            monthSelectorType: "static",
            placeholder: "Select End Date & Time"
        });
    }
};
$(function() { initEventsPickers(); if (typeof window.initEventsMap === 'function') window.initEventsMap(); });   // in case the drawer is already in the DOM by ready
document.addEventListener('atl:drawerOpened', function(e) {
    if (e.detail && e.detail.id === 'evtDrawer') {
        initEventsPickers();
        // initEventsMap was defined but never called anywhere - the "Venue Search (Google
        // Maps)" field was a complete dead end, identical to the earlier-documented booking
        // venue-search dead-end, but worse (this one never even attempted to initialize).
        if (typeof window.initEventsMap === 'function') window.initEventsMap();
    }
});

// Google Maps Places Autocomplete Integration for Venue
window.initEventsMap = function() {
    var searchInput = document.getElementById('eventsVenueSearch');
    if(searchInput && !searchInput._placesInited && window.google && window.google.maps && window.google.maps.places) {
        searchInput._placesInited = true;
        var autocomplete = new google.maps.places.Autocomplete(searchInput);
        autocomplete.addListener('place_changed', function() {
            var place = autocomplete.getPlace();
            if (place) {
                if (place.url) {
                    $('#eventsVenueMapLink').val(place.url); // Capture maps link
                } else if (place.geometry && place.geometry.location) {
                    var lat = place.geometry.location.lat();
                    var lng = place.geometry.location.lng();
                    $('#eventsVenueMapLink').val('https://maps.google.com/?q=' + lat + ',' + lng);
                }
                
                if (place.name) {
                    $('#eventsVenue').val(place.name); // Auto-fill the required venue name box
                }
            }
        });
    }
};
