/* Phase 6 (HOUSEKEEPING-NOTES.md): relocated from admin.html verbatim — Newsletter: Subscribers
   list/search/filter/sort/pagination/bulk actions/CSV import-export, Birthday Automation
   settings with its own Quill editor, Campaign composition with merge fields/audience
   targeting/attachments, Drafts, Scheduled sends, and Campaign delivery-log/reuse/edit/delete.

   Verified no enclosing IIFE before this move: a full scan of the whole range for
   (function/})(); patterns found only two self-contained, same-line pagination-button IIFEs
   (the usual "capture loop variable" idiom), not spanning wrappers; the range parses standalone.

   Zero new window attachments needed. window.toggleSubscriberSort/subscribersData/
   birthdayBodyQuill/loadBirthdaySettings were already explicitly attached. window.newsletterQuill
   is read here but assigned elsewhere (a separate Quill-init block, after Quill itself loads) —
   already safe via existing window prefixing on both ends. Every other name is a plain
   top-level function/let declaration with no wrapping IIFE — already globally reachable exactly
   as before, including 5 external bare calls (loadDraftsList/loadScheduledList/
   loadSubscriberStats/refreshAudienceCount/renderSubscribersList) from a "refresh everything"
   handler just after this range, inside the same giant non-IIFE script tag. */

// --- Subscribers ---
let subscribersData = [];      // current page only (server-paginated)
let subscribersPage = 1;
let subscribersSortCol = 'subscribed_at';
let subscribersSortOrder = 'DESC';
let subscribersSearchTerm = '';
let subscribersTotalPages = 1;

function subscribersEmptyState(iconClass, message) {
    return `<i class="${iconClass}" style="font-size:28px;color:var(--atl-muted-dim);display:block;margin-bottom:10px;"></i><p style="color:var(--atl-muted);margin:0;">${message}</p>`;
}

/* Phase 7 Component 1 (HOUSEKEEPING-NOTES.md "#10"): renderSubscribersList is now a DataTable
   instance (sibling-el render mode — the <table> is hidden while #subscriberListEmpty carries the
   state, fed by subscribersEmptyState). subscribersPage/SortCol/SortOrder/SearchTerm/Data/
   TotalPages, subscribersEmptyState, injectSubscribers, updateSortIconsSubscribers,
   renderSubscribersPaginationNumbered, toggleSubscriberSort are UNCHANGED. window.DataTable comes
   from js/admin/components/data-table.js (loaded before this file). */
const subscribersTable = new DataTable({
    body:  '#subscriberListBody',
    table: $('#subscriberListBody').closest('table'),      // jQuery obj; resolveEl unwraps .jquery
    colspan: 6,
    states: {
        idiom: 'sibling-el',
        siblingEl: '#subscriberListEmpty',
        siblingMode: 'render',
        searchActive: function () { return !!subscribersSearchTerm; },
        siblingRender: function (ctx) { return subscribersEmptyState(ctx.icon, ctx.message); },
        loading: { icon: 'fa-solid fa-circle-notch fa-spin', message: 'Loading subscribers…' },
        empty:   { icon: 'fa-solid fa-inbox', message: 'No subscribers found.', altMessage: 'No subscribers match your search.' }
        // no `error` — the wrapper owns both error messages ("Could not load..." / "An error occurred...")
    },
    server: {
        pageSize: 50,
        fetch: async function () {
            $('#subscribersPagination').hide();                // mirrors the original's pre-fetch hide
            const params = new URLSearchParams({ page: subscribersPage, limit: 50, sort: subscribersSortCol, order: subscribersSortOrder });
            if (subscribersSearchTerm) params.set('search', subscribersSearchTerm);
            let data;
            try {
                data = await apiCall('/api/admin/newsletter/subscribers?' + params.toString());
            } catch (err) {
                $('#subscriberCount').text('0');
                window.notificationService.showError('Unexpected error loading subscribers.');
                $('#subscriberListEmpty').html(subscribersEmptyState('fa-solid fa-triangle-exclamation', 'An error occurred. Please refresh.')).show();
                return DataTable.ABORT;
            }
            if (!data || !data.success || !Array.isArray(data.subscribers)) {
                $('#subscriberCount').text('0');
                window.notificationService.showError('Could not load subscribers — please refresh and try again.');
                $('#subscriberListEmpty').html(subscribersEmptyState('fa-solid fa-triangle-exclamation', 'Could not load subscribers.')).show();
                subscribersData = [];
                return DataTable.ABORT;
            }
            // If a deletion emptied the current page (but earlier pages still have rows), step back.
            if (data.subscribers.length === 0 && subscribersPage > 1 && (data.total || 0) > 0) {
                subscribersPage--; renderSubscribersList(); return DataTable.ABORT;
            }
            subscribersData = data.subscribers;
            window.subscribersData = data.subscribers;
            $('#subscriberCount').text(data.total);
            $('#subscriberCountLabel').text(subscribersSearchTerm ? 'Matching Subscribers' : 'Total Subscribers');
            subscribersTotalPages = data.pages || 1;
            return { rows: data.subscribers, total: data.total || 0, totalPages: data.pages || 1 };
        }
    },
    renderRow:  function () { return ''; },                 // injectSubscribers fills the tbody in onRender
    onRender:   function (bodyEl, rows) { injectSubscribers(rows); updateSortIconsSubscribers(); },
    pagination: function (info) { renderSubscribersPaginationNumbered(info.totalPages); }
});

function renderSubscribersList(resetPage) {
    if (resetPage) subscribersPage = 1;
    return subscribersTable.setPage(subscribersPage);
}

function renderSubscribersPaginationNumbered(totalPages) {
    var container = document.getElementById('subscribersPagination');
    if (!container) return;
    container.innerHTML = '';
    container.style.display = totalPages > 1 ? 'flex' : 'none';
    if (totalPages <= 1) return;

    var prev = document.createElement('button');
    prev.className = 'um-btn um-btn--ghost um-btn--sm' + (subscribersPage === 1 ? ' disabled' : '');
    prev.innerHTML = '<i class="fa fa-chevron-left"></i>';
    prev.onclick = function() { if (subscribersPage > 1) { subscribersPage--; renderSubscribersList(); } };
    container.appendChild(prev);

    for (var i = 1; i <= totalPages; i++) {
        if (totalPages > 7 && i > 5 && i < totalPages) {
            if (i === 6) { var sp = document.createElement('span'); sp.textContent = '…'; sp.style.color = 'var(--atl-muted)'; sp.style.padding = '0 4px'; container.appendChild(sp); }
            continue;
        }
        var b = document.createElement('button');
        b.className = 'um-btn um-btn--sm ' + (subscribersPage === i ? 'um-btn--primary' : 'um-btn--ghost');
        b.textContent = i;
        (function(p) { b.onclick = function() { subscribersPage = p; renderSubscribersList(); }; })(i);
        container.appendChild(b);
    }

    var next = document.createElement('button');
    next.className = 'um-btn um-btn--ghost um-btn--sm' + (subscribersPage === totalPages ? ' disabled' : '');
    next.innerHTML = '<i class="fa fa-chevron-right"></i>';
    next.onclick = function() { if (subscribersPage < totalPages) { subscribersPage++; renderSubscribersList(); } };
    container.appendChild(next);
}

window.toggleSubscriberSort = function(col) {
    if (subscribersSortCol === col) {
        subscribersSortOrder = (subscribersSortOrder === 'ASC') ? 'DESC' : 'ASC';
    } else {
        subscribersSortCol = col;
        subscribersSortOrder = (col === 'subscribed_at') ? 'DESC' : 'ASC';
    }
    subscribersPage = 1;
    renderSubscribersList();
};

function updateSortIconsSubscribers() {
    $('.um-th-sort i').each(function() {
        if (this.id && this.id.indexOf('subsort-') === 0) { this.className = 'fa-solid fa-sort'; this.style.opacity = '0.5'; }
    });
    var active = document.getElementById('subsort-' + subscribersSortCol);
    if (active) { active.className = (subscribersSortOrder === 'ASC') ? 'fa-solid fa-sort-up' : 'fa-solid fa-sort-down'; active.style.opacity = '1'; }
}

async function loadSubscriberStats() {
    try {
        const res = await apiCall('/api/admin/newsletter/subscribers/stats');
        if (res && res.success) {
            $('#subKpiTotal').text(res.stats.total);
            $('#subKpiActive').text(res.stats.active);
            $('#subKpiNew7d').text(res.stats.new_7d);
        }
    } catch (err) { console.error('Error loading subscriber stats:', err); }
}

function injectSubscribers(dataArray) {
    var $tbody = $('#subscriberListBody');
    $tbody.empty();
    
    var MONTH_ABBR = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    dataArray.forEach(function (sub) {
        var d = new Date(sub.subscribed_at);

        var safeEmail = $('<span>').text(sub.email || '').html();
        var safeEmailLower = $('<span>').text((sub.email || '').toLowerCase()).html();
        var safeName = sub.first_name ? $('<span>').text(sub.first_name).html() : '<span style="color:var(--atl-muted);">—</span>';
        var birthdayHtml = (sub.birthday_day && sub.birthday_month)
            ? sub.birthday_day + ' ' + MONTH_ABBR[sub.birthday_month - 1]
            : '<span style="color:var(--atl-muted);">—</span>';
        var isActive = sub.status === 'active';
        var isPending = sub.status === 'pending_confirmation';
        var statusHtml = isActive
            ? '<span class="atl-badge atl-badge--confirmed">Active</span>'
            : isPending
                ? '<span class="atl-badge atl-badge--pending">Pending Confirmation</span>'
                : '<span class="atl-badge atl-badge--unpaid">Inactive</span>';

        var toggleAction = isActive ? '<i class="fa-solid fa-ban"></i>' : '<i class="fa-solid fa-check"></i>';
        var toggleTitle = isActive ? 'Deactivate' : (isPending ? 'Confirm & Activate' : 'Activate');

        var html = `
            <tr style="border-bottom: 1px solid var(--atl-line); background-color: transparent;" data-email="${safeEmailLower}">
                <td style="vertical-align: middle; border: none; width:40px;">
                    <input type="checkbox" class="subscriber-checkbox" data-id="${sub.subscriber_id}" style="accent-color: var(--atl-amber); cursor:pointer;">
                </td>
                <td style="font-size: 12px; vertical-align: middle; border: none;">
                    ${safeName}
                </td>
                <td style="font-family: monospace; font-size: 12px; vertical-align: middle; border: none; word-break: break-all;">
                    ${safeEmail}
                </td>
                <td style="font-size: 11px; color: var(--atl-muted); vertical-align: middle; border: none; white-space: nowrap;">
                    ${d.toLocaleDateString()}<br>${d.toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})}
                </td>
                <td style="font-size: 12px; vertical-align: middle; border: none; white-space: nowrap;">${birthdayHtml}</td>
                <td style="vertical-align: middle; border: none;">${statusHtml}</td>
                <td style="vertical-align: middle; border: none; text-align: right; white-space: nowrap;">
                    <button class="atl-btn atl-btn--ghost edit-subscriber-btn" data-id="${sub.subscriber_id}" title="Edit">
                        <i class="fa-solid fa-pen"></i>
                    </button>
                    <button class="atl-btn atl-btn--ghost toggle-subscriber-btn" data-id="${sub.subscriber_id}" data-current-status="${sub.status}" title="${toggleTitle}">
                        ${toggleAction}
                    </button>
                    <button class="atl-btn atl-btn--danger delete-subscriber-btn" data-id="${sub.subscriber_id}" title="Delete">
                        <i class="fa-solid fa-trash"></i>
                    </button>
                </td>
            </tr>
        `;
        $tbody.append(html);
    });
}

// Subscriber Search — server-side (matches email or first name), debounced
let subscriberSearchDebounce = null;
$('#subscriberSearch').on('input', function() {
    var val = $(this).val().trim();
    clearTimeout(subscriberSearchDebounce);
    subscriberSearchDebounce = setTimeout(function() {
        subscribersSearchTerm = val;
        renderSubscribersList(true);
    }, 300);
});

// Toggle select all
$('#selectAllSubscribers').on('change', function() {
    $('.subscriber-checkbox').prop('checked', this.checked);
    updateBulkBar();
});

// Update bulk bar on any checkbox change
$(document).on('change', '.subscriber-checkbox', function() {
    updateBulkBar();
});

function updateBulkBar() {
    const checked = $('.subscriber-checkbox:checked');
    const count = checked.length;
    $('#bulkSelectedCount').text(count + ' selected');
    if (count > 0) {
        $('#subscriberBulkBar').slideDown(200);
    } else {
        $('#subscriberBulkBar').slideUp(200);
    }
}

// Bulk set active
$('#bulkSetActiveBtn').on('click', async function() {
    const ids = getCheckedIds();
    if (!ids.length) return;
    if (!(await window.notificationService.showConfirm({
        title: 'Activate Subscribers',
        message: `Set ${ids.length} subscriber${ids.length !== 1 ? 's' : ''} to active?`,
        confirmText: 'Activate', isDestructive: false
    }))) return;
    try {
        await apiCall('/api/admin/newsletter/subscribers/bulk-status', 'PUT', { ids, status: 'active' });
        renderSubscribersList();
    } catch(e) { window.notificationService.showError('Could not update subscribers. Please try again.'); }
});

// Bulk set inactive
$('#bulkSetInactiveBtn').on('click', async function() {
    const ids = getCheckedIds();
    if (!ids.length) return;
    if (!(await window.notificationService.showConfirm({
        title: 'Deactivate Subscribers',
        message: `Set ${ids.length} subscriber${ids.length !== 1 ? 's' : ''} to inactive?`,
        confirmText: 'Deactivate', isDestructive: false
    }))) return;
    try {
        await apiCall('/api/admin/newsletter/subscribers/bulk-status', 'PUT', { ids, status: 'inactive' });
        renderSubscribersList();
    } catch(e) { window.notificationService.showError('Could not update subscribers. Please try again.'); }
});

// Bulk delete
$('#bulkDeleteBtn').on('click', async function() {
    const ids = getCheckedIds();
    if (!ids.length) return;
    if (!(await window.notificationService.showConfirm({
        title: 'Delete Subscribers',
        message: `Permanently delete ${ids.length} subscriber${ids.length !== 1 ? 's' : ''}? This cannot be undone.`,
        confirmText: 'Delete', isDestructive: true
    }))) return;
    try {
        await apiCall('/api/admin/newsletter/subscribers/bulk-delete', 'POST', { ids });
        renderSubscribersList();
    } catch(e) { window.notificationService.showError('Could not delete subscribers. Please try again.'); }
});

// Export selected as CSV
$('#bulkExportSelectedBtn').on('click', function() {
    const ids = getCheckedIds();
    if (!ids.length) {
        window.notificationService.showWarning('No subscribers selected');
        return;
    }
    // Build CSV on the client from the already-loaded data
    const selectedData = window.subscribersData.filter(s => ids.includes(s.subscriber_id));
    if (!selectedData.length) return;
    exportSubscribersCSV(selectedData);
});

function getCheckedIds() {
    return $('.subscriber-checkbox:checked').map(function() { return $(this).data('id'); }).get();
}

// Browsers block programmatic .files assignment, so track the selected file here
let pendingImportFile = null;

function _setImportFile(file) {
    pendingImportFile = file || null;
    if (file) {
        $('#importFileName').text(file.name);
        $('#startImportBtn').prop('disabled', false);
    } else {
        $('#importFileName').text('Drag & drop or click to select a CSV file');
        $('#startImportBtn').prop('disabled', true);
    }
}

function _resetImportModal() {
    pendingImportFile = null;
    $('#csvFileInput').val('');
    $('#importFileName').text('Drag & drop or click to select a CSV file');
    $('#startImportBtn').prop('disabled', true).html('Import');
    $('#importProgress').hide();
    $('#importProgressBar').css('width', '0%');
    $('#importStatus').text('');
    $('#importResult').hide();
}

// Import CSV button — previously had no handler at all, so the modal could never be
// opened from the UI. Reset to a clean slate on each open (the Atelier modal system this
// now routes through doesn't fire Bootstrap's show.bs.modal event, so reset happens here
// directly rather than via that now-inert listener).
$('#importSubscribersBtn').on('click', function() {
    _resetImportModal();
    $('#importSubscribersModal').modal('show');
});

// File input — click-to-select path (delegated)
$(document).on('change', '#csvFileInput', function() {
    _setImportFile(this.files[0] || null);
});

$(document).on('click', '#startImportBtn', async function() {
    const file = pendingImportFile || $('#csvFileInput')[0].files[0];
    if (!file) return;
    const formData = new FormData();
    formData.append('csv', file);
    const $btn = $(this);
    const original = $btn.html();
    $btn.prop('disabled', true).html('<i class="fa fa-spinner fa-spin"></i> Importing…');
    $('#importResult').hide();
    $('#importProgress').show();
    $('#importProgressBar').css('width', '40%');
    $('#importStatus').text('Uploading…');
    try {
        const res = await fetch('/api/admin/newsletter/subscribers/import', {
            method: 'POST',
            body: formData,
            credentials: 'include',
            headers: { 'ngrok-skip-browser-warning': 'true' }
        });
        const data = await res.json();
        $('#importProgressBar').css('width', '100%');
        $('#importStatus').text('Done.');
        if (data.success) {
            setTimeout(() => $('#importProgress').hide(), 600);
            window.notificationService.showSuccess('Import complete', data.message);
            _resetImportModal();
            $('#importSubscribersModal').modal('hide');
            renderSubscribersList();
        } else {
            setTimeout(() => $('#importProgress').hide(), 600);
            window.notificationService.showError('Import failed', data.message || 'Could not import the file.');
            $btn.prop('disabled', false).html(original);
        }
    } catch(e) {
        $('#importProgress').hide();
        window.notificationService.showError('Import failed', 'Network error — check your connection and try again.');
        $btn.prop('disabled', false).html(original);
    }
});

// Drag-and-drop on the upload zone
$('#importSubscribersModal .um-upload-zone').on('dragover dragenter', function(e) {
    e.preventDefault();
    $(this).addClass('um-upload-zone--active');
}).on('dragleave dragend drop', function(e) {
    e.preventDefault();
    $(this).removeClass('um-upload-zone--active');
}).on('drop', function(e) {
    const files = e.originalEvent.dataTransfer.files;
    if (files.length) {
        _setImportFile(files[0]);
    }
});

// Toggle Subscriber Status
$(document).on('click', '.toggle-subscriber-btn', async function(e) {
    e.preventDefault();
    const id = $(this).data('id');
    const currentStatus = $(this).data('current-status');
    const newStatus = currentStatus === 'active' ? 'inactive' : 'active';
    
    $(this).prop('disabled', true).text('Working...');
    
    const res = await apiCall(`/api/admin/newsletter/subscribers/${id}/status`, 'PUT', { status: newStatus });
    if(res && res.success) {
        renderSubscribersList();
    } else {
        window.notificationService.showError(res.message || 'Error updating status');
        $(this).prop('disabled', false).text(currentStatus === 'active' ? 'Deactivate' : 'Activate');
    }
});

// Delete Subscriber
$(document).on('click', '.delete-subscriber-btn', async function(e) {
    e.preventDefault();
    const id = $(this).data('id');
    const row = $(this).closest('tr');
    const email = row.data('email') || 'this subscriber';
    
    if (!(await window.notificationService.showConfirm({ message: `Are you sure you want to permanently delete ${email} from the mailing list?`, isDestructive: true }))) {
        return;
    }
    
    $(this).prop('disabled', true).html('<i class="fa fa-spinner fa-spin"></i>');
    
    try {
        const res = await apiCall(`/api/admin/newsletter/subscribers/${id}`, 'DELETE');
        if (res && res.success) {
            renderSubscribersList();
        } else {
            window.notificationService.showError(res.message || 'Error deleting subscriber');
            $(this).prop('disabled', false).html('<i class="fa-solid fa-trash"></i>');
        }
    } catch (err) {
        console.error("Delete Subscriber Error:", err);
        window.notificationService.showError("Network error. Could not delete.");
        $(this).prop('disabled', false).html('<i class="fa-solid fa-trash"></i>');
    }
});

// Refactor the existing CSV export function to accept an optional data array
function exportSubscribersCSV(dataArray) {
    const list = dataArray || window.subscribersData;
    if (!list.length) return;
    let csv = "data:text/csv;charset=utf-8,ID,First Name,Email,Status,Date Subscribed,Birthday,Tags,Internal Notes,IP Address,User Agent,Source\r\n";
    list.forEach(row => {
        const escapedEmail = row.email.replace(/"/g, '""');
        const escapedName = (row.first_name || '').replace(/"/g, '""');
        const escapedUA = (row.user_agent || '').replace(/"/g, '""');
        const escapedNotes = (row.internal_notes || '').replace(/"/g, '""');
        const birthday = (row.birthday_day && row.birthday_month)
            ? String(row.birthday_month).padStart(2, '0') + '-' + String(row.birthday_day).padStart(2, '0')
            : '';
        let tags = [];
        try { tags = row.tags ? JSON.parse(row.tags) : []; } catch (e) {}
        const escapedTags = (Array.isArray(tags) ? tags.join(';') : '').replace(/"/g, '""');
        csv += [row.subscriber_id, `"${escapedName}"`, `"${escapedEmail}"`, row.status, row.subscribed_at, birthday, `"${escapedTags}"`, `"${escapedNotes}"`, row.ip_address || '', `"${escapedUA}"`, row.source || ''].join(",") + "\r\n";
    });
    const link = document.createElement('a');
    link.href = encodeURI(csv);
    link.download = 'subscribers.csv';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
}

// Export ALL subscribers — fetch the full list (not just the loaded page) before building the CSV.
$('#exportSubscribersBtn').off('click').on('click', async function() {
    const $btn = $(this);
    const original = $btn.html();
    $btn.prop('disabled', true).html('<i class="fa fa-spinner fa-spin"></i> Exporting…');
    try {
        const params = new URLSearchParams({ page: 1, limit: 100000, sort: subscribersSortCol, order: subscribersSortOrder });
        if (subscribersSearchTerm) params.set('search', subscribersSearchTerm);
        const data = await apiCall('/api/admin/newsletter/subscribers?' + params.toString());
        const list = (data && data.success && Array.isArray(data.subscribers)) ? data.subscribers : [];
        if (!list.length) { window.notificationService.showWarning('No subscribers to export.'); return; }
        exportSubscribersCSV(list);
    } catch (e) {
        window.notificationService.showError('Could not export subscribers. Please try again.');
    } finally {
        $btn.prop('disabled', false).html(original);
    }
});

// Add Subscriber manually
$('#addSubscriberForm').on('submit', async function(e) {
    e.preventDefault();
    const email = $('#newSubscriberEmail').val().trim();
    const firstName = $('#newSubscriberFirstName').val().trim();
    if (!email) return;

    const $btn = $(this).find('button[type="submit"]');
    $btn.prop('disabled', true).text('Adding...');

    try {
        const res = await apiCall('/api/admin/newsletter/subscribers', 'POST', { email: email, first_name: firstName });
        if (res && res.success) {
            $('#newSubscriberEmail').val('');
            $('#newSubscriberFirstName').val('');
            window.notificationService.showSuccess("Subscriber added successfully!");
            renderSubscribersList();
        } else if (res && res.message && res.message.includes('already subscribed')) {
            window.notificationService.showInfo('This email is already subscribed!');
        } else {
            window.notificationService.showError(res.message || 'Error adding subscriber');
        }
    } catch (err) {
        console.error("Error adding subscriber manually:", err);
        window.notificationService.showError("An error occurred. Please try again.");
    } finally {
        $btn.prop('disabled', false).text('Add');
    }
});

// Edit Subscriber drawer — populate Day/Month select options once. Deferred to
// document.ready: this script block (lines ~11418-22865) runs before the drawer's own
// markup (~line 24519) is parsed, so $('#editSubscriberBirthdayDay') would otherwise match
// nothing yet and .append() would silently no-op, leaving only the static placeholder option.
$(function populateSubscriberBirthdaySelects() {
    const $day = $('#editSubscriberBirthdayDay');
    for (let d = 1; d <= 31; d++) $day.append(`<option value="${d}">${d}</option>`);
    const months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
    const $month = $('#editSubscriberBirthdayMonth');
    months.forEach((name, i) => $month.append(`<option value="${i + 1}">${name}</option>`));
});

// Open the Edit Subscriber drawer, pre-filled from the already-fetched subscribersData
// (client-side lookup — no need for a separate GET-by-id endpoint).
$(document).on('click', '.edit-subscriber-btn', function() {
    const id = $(this).data('id');
    const sub = (subscribersData || []).find(s => String(s.subscriber_id) === String(id));
    if (!sub) return;

    $('#editSubscriberId').val(sub.subscriber_id);
    $('#editSubscriberEmail').val(sub.email || '');
    $('#editSubscriberFirstName').val(sub.first_name || '');
    $('#editSubscriberBirthdayDay').val(sub.birthday_day || '');
    $('#editSubscriberBirthdayMonth').val(sub.birthday_month || '');
    let tags = [];
    try { tags = sub.tags ? JSON.parse(sub.tags) : []; } catch (e) {}
    $('#editSubscriberTags').val(Array.isArray(tags) ? tags.join(', ') : '');
    $('#editSubscriberNotes').val(sub.internal_notes || '');
    $('#errEditSubscriberBirthday').hide();
    $('#editSubscriberFeedback').text('');

    openAtlDrawer('editSubscriberDrawer');
});

// Deferred to document.ready for the same reason as populateSubscriberBirthdaySelects()
// above: this script block runs before the drawer's own <form id="editSubscriberForm">
// markup is parsed, so a direct (non-delegated) $('#editSubscriberForm') selector matches
// nothing at bind time and .on('submit', ...) silently attaches to zero elements. The real
// form, once parsed, then has no submit handler at all — clicking Save falls through to the
// browser's native form submission (no action= attribute, so it just reloads the page),
// which is exactly the "blinks and doesn't save" symptom this fixes.
$(function() {
$('#editSubscriberForm').on('submit', async function(e) {
    e.preventDefault();
    const id = $('#editSubscriberId').val();
    const day = $('#editSubscriberBirthdayDay').val();
    const month = $('#editSubscriberBirthdayMonth').val();
    $('#errEditSubscriberBirthday').hide();
    if ((day && !month) || (!day && month)) {
        $('#errEditSubscriberBirthday').text('Please select both a day and a month.').show();
        return;
    }

    const tags = $('#editSubscriberTags').val().split(',').map(t => t.trim()).filter(Boolean);
    const payload = {
        first_name: $('#editSubscriberFirstName').val().trim(),
        birthday_day: day || null,
        birthday_month: month || null,
        tags: tags,
        internal_notes: $('#editSubscriberNotes').val()
    };

    const $btn = $('#editSubscriberSubmit');
    $btn.prop('disabled', true);

    try {
        const res = await apiCall('/api/admin/newsletter/subscribers/' + id, 'PUT', payload);
        if (res && res.success) {
            window.notificationService.showSuccess('Subscriber updated.');
            closeAtlDrawer('editSubscriberDrawer');
            renderSubscribersList();
        } else {
            window.notificationService.showError((res && res.message) || 'Could not update subscriber.');
        }
    } catch (err) {
        console.error('Error updating subscriber:', err);
        window.notificationService.showError('An error occurred. Please try again.');
    } finally {
        $btn.prop('disabled', false);
    }
});
});


// ─── Birthday Automation ───
function initBirthdayBodyQuill() {
    if (window.birthdayBodyQuill) return;
    var toolbar = [['bold', 'italic', 'underline'], [{ list: 'ordered' }, { list: 'bullet' }], ['link'], ['clean']];
    window.birthdayBodyQuill = new Quill('#bdayBodyEditor', { theme: 'snow', placeholder: 'Wishing you a wonderful day, {{first_name}}!...', modules: { toolbar: toolbar } });
}

function collectBirthdayFormData() {
    var fd = new FormData();
    fd.append('birthday_email_subject', $('#bdaySubject').val().trim());
    fd.append('birthday_email_heading', $('#bdayHeading').val().trim());
    fd.append('birthday_email_body', window.birthdayBodyQuill ? window.birthdayBodyQuill.root.innerHTML : '');
    fd.append('birthday_email_cta_label', $('#bdayCtaLabel').val().trim());
    fd.append('birthday_email_cta_url', $('#bdayCtaUrl').val().trim());
    fd.append('birthday_email_footer_note', $('#bdayFooterNote').val().trim());
    fd.append('birthday_test_recipient', $('#bdayTestRecipient').val().trim());
    return fd;
}

window.loadBirthdaySettings = async function() {
    initBirthdayBodyQuill();
    try {
        const res = await apiCall('/api/admin/newsletter/birthday-settings');
        if (!res || !res.success) throw new Error((res && res.message) || 'Failed to load');
        const s = res.settings;
        $('#bdayEnabled').prop('checked', s.birthday_automation_enabled === '1');
        $('#bdayTestMode').prop('checked', s.birthday_test_mode === '1');
        $('#bdaySendTime').val(s.birthday_send_time);
        $('#bdayTestRecipient').val(s.birthday_test_recipient);
        $('#bdaySubject').val(s.birthday_email_subject);
        $('#bdayHeading').val(s.birthday_email_heading);
        $('#bdayCtaLabel').val(s.birthday_email_cta_label);
        $('#bdayCtaUrl').val(s.birthday_email_cta_url);
        $('#bdayFooterNote').val(s.birthday_email_footer_note);
        window.birthdayBodyQuill.root.innerHTML = s.birthday_email_body || '';
    } catch (err) {
        console.error('Error loading birthday settings:', err);
        window.notificationService.showError('Could not load birthday automation settings.');
    }
    loadBirthdayRecentSends();
};

async function loadBirthdayRecentSends() {
    var $list = $('#bdayRecentSendsList');
    var $empty = $('#bdayRecentSendsEmpty');
    try {
        const res = await apiCall('/api/admin/email-logs?search=' + encodeURIComponent('Newsletter: Birthday') + '&limit=10&sort=sent_at&order=DESC');
        const logs = (res && res.success && Array.isArray(res.logs)) ? res.logs : [];
        $list.empty();
        if (!logs.length) { $empty.show(); return; }
        $empty.hide();
        logs.forEach(function(log) {
            var isTest = (log.trigger_event || '').includes('Test');
            var statusBadge = log.status === 'success'
                ? '<span class="atl-badge atl-badge--confirmed">Sent</span>'
                : (log.status === 'failed' ? '<span class="atl-badge atl-badge--cancelled">Failed</span>' : '<span class="atl-badge atl-badge--unpaid">' + escHtml(log.status || '') + '</span>');
            var d = new Date(log.sent_at);
            $list.append(
                '<div style="display:flex; align-items:center; justify-content:space-between; gap:10px; padding:8px 10px; background:var(--atl-card); border:1px solid var(--atl-line); border-radius:6px; font-size:12px;">' +
                    '<span style="color:var(--atl-ink-dim); word-break:break-all;">' + escHtml(log.recipient_email) + (isTest ? ' <span style="color:var(--atl-muted-dim);">(test)</span>' : '') + '</span>' +
                    '<span style="display:flex; align-items:center; gap:8px; white-space:nowrap;"><span style="color:var(--atl-muted);">' + d.toLocaleString() + '</span>' + statusBadge + '</span>' +
                '</div>'
            );
        });
    } catch (err) {
        console.error('Error loading birthday recent sends:', err);
    }
}

$('#birthdaySettingsForm').on('submit', async function(e) {
    e.preventDefault();
    const $btn = $('#bdaySaveBtn');
    $btn.prop('disabled', true);
    try {
        const payload = {
            birthday_automation_enabled: $('#bdayEnabled').is(':checked'),
            birthday_test_mode: $('#bdayTestMode').is(':checked'),
            birthday_send_time: $('#bdaySendTime').val(),
            birthday_test_recipient: $('#bdayTestRecipient').val().trim(),
            birthday_email_subject: $('#bdaySubject').val().trim(),
            birthday_email_heading: $('#bdayHeading').val().trim(),
            birthday_email_body: window.birthdayBodyQuill ? window.birthdayBodyQuill.root.innerHTML : '',
            birthday_email_cta_label: $('#bdayCtaLabel').val().trim(),
            birthday_email_cta_url: $('#bdayCtaUrl').val().trim(),
            birthday_email_footer_note: $('#bdayFooterNote').val().trim()
        };
        const res = await fetch('/api/admin/newsletter/birthday-settings', {
            method: 'PUT', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify(payload)
        });
        const result = await res.json();
        if (!res.ok || !result.success) throw new Error(result.message || 'Save failed');
        window.notificationService.showSuccess('Birthday automation settings saved.');
    } catch (err) {
        console.error('Error saving birthday settings:', err);
        window.notificationService.showError(err.message || 'Could not save settings.');
    } finally {
        $btn.prop('disabled', false);
    }
});

$('#bdayPreviewBtn').on('click', async function() {
    const $btn = $(this);
    $btn.prop('disabled', true).html('<i class="fa fa-spinner fa-spin"></i> Loading...');
    try {
        const res = await fetch('/api/admin/newsletter/birthday-settings/preview', { method: 'POST', body: collectBirthdayFormData(), credentials: 'same-origin' });
        const result = await res.json();
        if (!res.ok || !result.success) throw new Error(result.message || 'Preview failed');
        document.getElementById('newsletterPreviewFrame').srcdoc = result.html;
        $('#newsletterPreviewModal').modal('show');
    } catch (err) {
        window.notificationService.showError('Could not load preview: ' + (err.message || 'Unknown error'));
    } finally {
        $btn.prop('disabled', false).html('<i class="fa-solid fa-eye"></i> Preview');
    }
});

$('#bdaySendTestBtn').on('click', async function() {
    const $btn = $(this);
    if (!$('#bdayTestRecipient').val().trim()) {
        window.notificationService.showWarning('Set a test recipient email first.');
        return;
    }
    $btn.prop('disabled', true).html('<i class="fa fa-spinner fa-spin"></i> Sending...');
    try {
        const res = await fetch('/api/admin/newsletter/birthday-settings/send-test', { method: 'POST', body: collectBirthdayFormData(), credentials: 'same-origin' });
        const result = await res.json();
        if (!res.ok || !result.success) throw new Error(result.message || 'Send failed');
        window.notificationService.showSuccess(result.message || 'Test email sent.');
        loadBirthdayRecentSends();
    } catch (err) {
        window.notificationService.showError('Could not send test email: ' + (err.message || 'Unknown error'));
    } finally {
        $btn.prop('disabled', false).html('<i class="fa-solid fa-paper-plane"></i> Send Test Email');
    }
});

// ─── Merge-field token picker (Compose + Birthday subject/body) ───
var MERGE_FIELDS = [
    { token: '{{first_name}}', label: "Subscriber's first name" },
    { token: '{{email}}', label: 'Subscriber email address' },
    { token: '{{birthday}}', label: 'Formatted birthday, e.g. "15 July"' },
    { token: '{{subscription_date}}', label: 'Date they subscribed' },
    { token: '{{unsubscribe_link}}', label: 'Unsubscribe URL (auto-inserted if omitted)' },
];
function insertMergeField(token, targetInputId, quillVarName) {
    var quill = quillVarName ? window[quillVarName] : null;
    if (quill) {
        var sel = quill.getSelection(true);
        quill.insertText(sel.index, token, 'user');
        quill.setSelection(sel.index + token.length);
    } else if (targetInputId) {
        var el = document.getElementById(targetInputId);
        if (!el) return;
        var start = el.selectionStart != null ? el.selectionStart : el.value.length;
        var end = el.selectionEnd != null ? el.selectionEnd : el.value.length;
        el.value = el.value.slice(0, start) + token + el.value.slice(end);
        el.selectionStart = el.selectionEnd = start + token.length;
        el.focus();
    }
}
$('.merge-field-menu').each(function() {
    var $menu = $(this);
    MERGE_FIELDS.forEach(function(f) {
        var $item = $('<a href="#" class="merge-field-item"></a>')
            .attr('data-token', f.token)
            .css({ color: 'var(--atl-ink)', padding: '8px 14px', display: 'block' })
            .html('<code style="color:var(--atl-amber);">' + f.token + '</code><br><span style="font-size:11px; color:var(--atl-muted);">' + f.label + '</span>');
        $menu.append($('<li></li>').append($item));
    });
});
$(document).on('click', '.merge-field-item', function(e) {
    e.preventDefault();
    var $btn = $(this).closest('.dropdown').find('.merge-field-btn');
    insertMergeField($(this).data('token'), $btn.data('target-input'), $btn.data('quill-var'));
});

// Dispatch Newsletter
// ─── Audience segmentation ───
function getSelectedAudience() {
    const segment = $('#newsletterAudienceSelect').val();
    let value = '';
    if (segment === 'birthday_month') value = $('#newsletterAudienceMonth').val();
    else if (segment === 'has_tag') value = $('#newsletterAudienceTag').val().trim();
    else if (segment === 'source') value = $('#newsletterAudienceSource').val();
    else if (segment === 'dormant') value = $('#newsletterAudienceDays').val();
    return { segment, value };
}
function audienceLabel() {
    const map = { all: 'all active subscribers', new_30d: 'new subscribers (last 30 days)', birthday_month: 'subscribers born in the selected month', has_tag: 'subscribers with the selected tag', source: 'subscribers from the selected source', booking_clients: 'booking clients', dormant: 'dormant subscribers' };
    return map[$('#newsletterAudienceSelect').val()] || 'the selected audience';
}
function updateAudienceValueVisibility() {
    const segment = $('#newsletterAudienceSelect').val();
    $('#newsletterAudienceMonth, #newsletterAudienceTag, #newsletterAudienceSource, #newsletterAudienceDays').hide();
    const needsValue = segment === 'birthday_month' || segment === 'has_tag' || segment === 'source' || segment === 'dormant';
    $('#newsletterAudienceValueWrap').toggle(needsValue);
    const iconMap = { birthday_month: 'fa-calendar-days', has_tag: 'fa-tag', source: 'fa-globe', dormant: 'fa-hourglass-half' };
    $('#newsletterAudienceValueIcon').attr('class', 'fa-solid ' + (iconMap[segment] || 'fa-calendar-days') + ' um-input-icon');
    if (segment === 'birthday_month') $('#newsletterAudienceMonth').show();
    else if (segment === 'has_tag') $('#newsletterAudienceTag').show();
    else if (segment === 'source') $('#newsletterAudienceSource').show();
    else if (segment === 'dormant') $('#newsletterAudienceDays').show();
}
async function refreshAudienceCount() {
    const { segment, value } = getSelectedAudience();
    if (segment === 'has_tag' && !value) { $('#newsletterAudienceCount').text(''); return; }
    try {
        const params = new URLSearchParams({ segment });
        if (value) params.set('segment_value', value);
        const res = await apiCall('/api/admin/newsletter/campaigns/audience-count?' + params.toString());
        if (res && res.success) $('#newsletterAudienceCount').text(res.count + (res.count === 1 ? ' recipient' : ' recipients'));
    } catch (e) { $('#newsletterAudienceCount').text(''); }
}
$('#newsletterAudienceSelect').on('change', function() { updateAudienceValueVisibility(); refreshAudienceCount(); });
$('#newsletterAudienceMonth, #newsletterAudienceSource').on('change', refreshAudienceCount);
let audienceTagDebounce = null;
$('#newsletterAudienceTag').on('input', function() {
    clearTimeout(audienceTagDebounce);
    audienceTagDebounce = setTimeout(refreshAudienceCount, 400);
});
let audienceDaysDebounce = null;
$('#newsletterAudienceDays').on('input', function() {
    clearTimeout(audienceDaysDebounce);
    audienceDaysDebounce = setTimeout(refreshAudienceCount, 400);
});

$('#newsletterForm').on('submit', async function(e) {
    e.preventDefault();
    let valid = true;
    $('#err-newsletterSubject, #err-newsletterContent').hide();
    $('#newsletterSubject').css('border-color', '');
    $('#newsletterEditorContainer .ql-container').css('border-color', '');

    const subject = $('#newsletterSubject').val().trim();
    const contentText = window.newsletterQuill ? window.newsletterQuill.getText().trim() : '';

    if (!subject) {
        $('#err-newsletterSubject').text('Subject is required.').show();
        $('#newsletterSubject').css('border-color', 'var(--atl-clay)');
        valid = false;
    }
    if (!contentText || contentText === '\n') {
        $('#err-newsletterContent').text('Message content cannot be empty.').show();
        $('#newsletterEditorContainer .ql-container').css('border-color', 'var(--atl-clay)');
        valid = false;
    }
    if (!valid) return;

    var message = (window.newsletterQuill ? window.newsletterQuill.root.innerHTML : $('#newsletterMessage').val()).trim();
    var $btn = $('#newsletterSubmitBtn');
    const originalBtnHtml = $btn.html();
    const { segment, value: segmentValue } = getSelectedAudience();

    if(!(await window.notificationService.showConfirm({ message: `You are about to dispatch this HTML newsletter to ${audienceLabel()}. Proceed?`, isDestructive: false }))) {
        return;
    }

    $btn.prop('disabled', true).html('<i class="fa fa-spinner fa-spin"></i> Dispatching...');

    try {
        const fd = new FormData();
        fd.append('subject', subject);
        fd.append('message', message);
        fd.append('segment', segment);
        if (segmentValue) fd.append('segment_value', segmentValue);
        newsletterFiles.forEach(f => fd.append('attachments', f));
        const _res = await fetch('/api/admin/campaigns', { method: 'POST', body: fd, credentials: 'same-origin' });
        const response = await _res.json();
        if (!_res.ok || !response.success) throw new Error(response.message || 'Dispatch failed');
        window.notificationService.showSuccess('Newsletter dispatched!', response.message || 'All active subscribers have been queued.');
        if (window.newsletterQuill) { window.newsletterQuill.setContents([]); } else { $('#newsletterMessage').val(''); }
        $('#newsletterSubject').val('');
        $('#draftStatus').text('').css('color', '');
        currentDraftId = null;
        newsletterFiles = []; renderAttachmentChips();
        loadCampaigns();
    } catch(e) {
        window.notificationService.showError('Dispatch failed', e.message || 'Could not send the newsletter. Please try again.');
    } finally {
        $btn.prop('disabled', false).html(originalBtnHtml);
    }
});

// ─── Draft Save ───
$('#draftSaveBtn').on('click', async () => {
    const subject = $('#newsletterSubject').val().trim();
    const content = window.newsletterQuill ? window.newsletterQuill.root.innerHTML : '';
    if (!content.trim()) {
        window.notificationService.showWarning('Cannot save an empty draft.');
        return;
    }
    try {
        const fd = new FormData(); fd.append('subject', subject); fd.append('content', content);
        const _r = await fetch('/api/admin/newsletter/drafts', { method: 'POST', body: fd, credentials: 'same-origin' });
        const res = await _r.json();
        if (!_r.ok || !res.success) throw new Error(res.message || 'Save failed');
        window.notificationService.showSuccess('Draft saved successfully!');
        $('#draftStatus').text('Draft saved at ' + new Date().toLocaleTimeString()).css('color', 'var(--atl-sage)');
        loadDraftsList();
    } catch(e) {
        window.notificationService.showError('Draft not saved', 'Could not save the draft — check your connection.');
        $('#draftStatus').text('Save failed.').css('color', 'var(--atl-clay)');
    }
});

// ─── Draft Update ───
let currentDraftId = null;

$('#draftUpdateBtn').on('click', async () => {
    if (!currentDraftId) return;
    const subject = $('#newsletterSubject').val().trim();
    const content = window.newsletterQuill ? window.newsletterQuill.root.innerHTML : '';
    if (!content.trim()) return;
    try {
        const fd = new FormData(); fd.append('subject', subject); fd.append('content', content);
        const _r = await fetch('/api/admin/newsletter/drafts/' + currentDraftId, { method: 'PUT', body: fd, credentials: 'same-origin' });
        const res = await _r.json();
        if (!_r.ok || !res.success) throw new Error(res.message || 'Update failed');
        window.notificationService.showSuccess('Draft updated successfully!');
        $('#draftStatus').text('Draft updated at ' + new Date().toLocaleTimeString()).css('color', 'var(--atl-sage)');
        loadDraftsList();
    } catch(e) {
        window.notificationService.showError('Draft not saved', 'Could not save the draft — check your connection.');
        $('#draftStatus').text('Save failed.').css('color', 'var(--atl-clay)');
    }
});

// ─── Load Drafts Dropdown ───
async function loadDraftsList() {
    try {
        const drafts = await apiCall('/api/admin/newsletter/drafts', 'GET');
        const $sel = $('#draftLoadSelect');
        $sel.find('option:not(:first)').remove();
        if (drafts && drafts.length) {
            drafts.forEach(d => {
                const label = (d.subject || 'No subject') + ' — ' + new Date(d.updated_at).toLocaleString();
                $sel.append(`<option value="${d.id}">${label}</option>`);
            });
        }
    } catch(e) { window.notificationService.showError('Could not load drafts.'); }
}

$('#draftLoadSelect').on('change', async function() {
    const id = $(this).val();
    if (!id) {
        $('#draftDeleteBtn').hide();
        $('#draftUpdateBtn').hide();
        currentDraftId = null;
        return;
    }
    try {
        const draft = await apiCall('/api/admin/newsletter/drafts/' + id, 'GET');
        if (draft) {
            $('#newsletterSubject').val(draft.subject || '');
            if (window.newsletterQuill) window.newsletterQuill.root.innerHTML = draft.content || '';
            currentDraftId = draft.id;
            $('#draftUpdateBtn').show();
            $('#draftDeleteBtn').show();
            $('#draftStatus').text('Draft loaded from ' + new Date(draft.updated_at).toLocaleString()).css('color', '#aaa');
        }
    } catch(e) { window.notificationService.showError('Could not load that draft.'); }
});

$('#draftDeleteBtn').on('click', async () => {
    if (!currentDraftId) return;
    if (!await window.notificationService.showConfirm({ message: 'Delete this draft?', isDestructive: true })) return;
    try {
        await apiCall('/api/admin/newsletter/drafts/' + currentDraftId, 'DELETE');
        currentDraftId = null;
        $('#draftUpdateBtn').hide();
        $('#draftDeleteBtn').hide();
        $('#newsletterSubject').val('');
        if (window.newsletterQuill) window.newsletterQuill.root.innerHTML = '';
        $('#draftStatus').text('Draft deleted.').css('color', 'var(--atl-clay)');
        loadDraftsList();
    } catch(e) { window.notificationService.showError('Could not delete the draft.'); }
});

// Toggle schedule fields
$('#scheduleToggle').on('change', function() {
    if (this.checked) {
        $('#scheduleFields').slideDown(200);
        $('#newsletterSubmitBtn').hide();
        $('#newsletterScheduleBtn').show();
    } else {
        $('#scheduleFields').slideUp(200);
        $('#newsletterSubmitBtn').show();
        $('#newsletterScheduleBtn').hide();
    }
});

let currentScheduleId = null;
let newsletterFiles = [];

function renderAttachmentChips() {
    const $list = $('#attachmentList');
    $list.empty();
    newsletterFiles.forEach((f, i) => {
        $list.append(`<span style="display:inline-flex;align-items:center;gap:6px;background: var(--atl-card);border: 1px solid var(--atl-line);border-radius:4px;padding:4px 10px;font-size:12px;color: var(--atl-ink-dim);">
            <i class="fa-solid fa-paperclip" style="color: var(--atl-amber);font-size:10px;"></i>${$('<span>').text(f.name).html()}
            <button type="button" data-idx="${i}" class="rm-attach" style="background:none;border:none;color:#666;cursor:pointer;padding:0 0 0 4px;font-size:15px;line-height:1;">&times;</button>
        </span>`);
    });
    const $zoneText = $('#newsletterUploadText');
    if (newsletterFiles.length > 0) {
        $zoneText.text(newsletterFiles.length + ' file' + (newsletterFiles.length === 1 ? '' : 's') + ' attached').css('color', 'var(--atl-amber)');
    } else {
        $zoneText.text('Drag & drop or click to attach files').css('color', '');
    }
}

$('#newsletterAttachments').on('change', function() {
    Array.from(this.files).forEach(f => {
        if (!newsletterFiles.find(x => x.name === f.name && x.size === f.size)) newsletterFiles.push(f);
    });
    this.value = '';
    renderAttachmentChips();
});

$(document).on('click', '.rm-attach', function() {
    newsletterFiles.splice($(this).data('idx'), 1);
    renderAttachmentChips();
});

$('#newsletterPreviewBtn').on('click', async function() {
    const subject = $('#newsletterSubject').val().trim();
    const content = window.newsletterQuill ? window.newsletterQuill.root.innerHTML : '';
    const $btn = $(this);
    $btn.prop('disabled', true).html('<i class="fa fa-spinner fa-spin"></i> Loading...');
    try {
        // Use FormData (not JSON) so the server's XSS middleware doesn't escape the HTML content
        const fd = new FormData();
        fd.append('subject', subject);
        fd.append('content', content);
        const _r = await fetch('/api/admin/newsletter/preview', { method: 'POST', body: fd, credentials: 'same-origin' });
        const res = await _r.json();
        if (!_r.ok || !res.success) throw new Error(res.message || 'Preview failed');
        document.getElementById('newsletterPreviewFrame').srcdoc = res.html;
        $('#newsletterPreviewModal').modal('show');
    } catch(e) {
        window.notificationService.showError('Could not load preview: ' + (e.message || 'Unknown error'));
    } finally {
        $btn.prop('disabled', false).html('<i class="fa-solid fa-eye"></i> Preview Email');
    }
});

$('#newsletterSendTestBtn').on('click', async function() {
    const subject = $('#newsletterSubject').val().trim();
    const content = window.newsletterQuill ? window.newsletterQuill.root.innerHTML : '';
    if (!subject || !content.trim()) {
        window.notificationService.showWarning('Add a subject and message before sending a test.');
        return;
    }
    const $btn = $(this);
    const original = $btn.html();
    $btn.prop('disabled', true).html('<i class="fa fa-spinner fa-spin"></i> Sending...');
    try {
        const fd = new FormData();
        fd.append('subject', subject);
        fd.append('message', content);
        const _r = await fetch('/api/admin/campaigns/send-test', { method: 'POST', body: fd, credentials: 'same-origin' });
        const res = await _r.json();
        if (!_r.ok || !res.success) throw new Error(res.message || 'Send failed');
        window.notificationService.showSuccess(res.message || 'Test email sent.');
    } catch (e) {
        window.notificationService.showError('Could not send test email: ' + (e.message || 'Unknown error'));
    } finally {
        $btn.prop('disabled', false).html(original);
    }
});

// Schedule Send button
$('#newsletterScheduleBtn').on('click', async function() {
    let valid = true;
    $('#err-newsletterSubject, #err-newsletterContent').hide();
    $('#newsletterSubject').css('border-color', '');
    $('#newsletterEditorContainer .ql-container').css('border-color', '');

    const subject = $('#newsletterSubject').val().trim();
    const contentText = window.newsletterQuill ? window.newsletterQuill.getText().trim() : '';
    const content = window.newsletterQuill ? window.newsletterQuill.root.innerHTML : '';
    const scheduledAt = $('#scheduledDateTime').val();

    if (!subject) {
        $('#err-newsletterSubject').text('Subject is required.').show();
        $('#newsletterSubject').css('border-color', 'var(--atl-clay)');
        valid = false;
    }
    if (!contentText || contentText === '\n') {
        $('#err-newsletterContent').text('Message content cannot be empty.').show();
        $('#newsletterEditorContainer .ql-container').css('border-color', 'var(--atl-clay)');
        valid = false;
    }
    if (!valid) return;

    if (!scheduledAt) {
        window.notificationService.showError('Please select a date and time.');
        return;
    }

    const $btn = $(this);
    const origHtml = $btn.html();
    $btn.prop('disabled', true).html('<i class="fa fa-spinner fa-spin"></i> Processing...');

    try {
        const method = currentScheduleId ? 'PUT' : 'POST';
        const url = currentScheduleId ? `/api/admin/newsletter/schedule/${currentScheduleId}` : '/api/admin/newsletter/schedule';
        const fd = new FormData();
        fd.append('subject', subject);
        fd.append('content', content);
        fd.append('scheduled_at', new Date(scheduledAt).toISOString());
        const { segment, value: segmentValue } = getSelectedAudience();
        fd.append('segment', segment);
        if (segmentValue) fd.append('segment_value', segmentValue);
        newsletterFiles.forEach(f => fd.append('attachments', f));
        const _r = await fetch(url, { method, body: fd, credentials: 'same-origin' });
        const res = await _r.json();
        if (!_r.ok || !res.success) throw new Error(res.message || 'Request failed');
        window.notificationService.showSuccess(currentScheduleId ? 'Schedule updated.' : 'Newsletter scheduled for ' + new Date(scheduledAt).toLocaleString());
        $('#newsletterSubject').val('');
        if (window.newsletterQuill) window.newsletterQuill.root.innerHTML = '';
        $('#scheduleToggle').prop('checked', false).trigger('change');
        currentScheduleId = null;
        $('#newsletterScheduleBtn').html('<i class="fa-solid fa-calendar-check"></i> Schedule Send');
        newsletterFiles = []; renderAttachmentChips();
        loadCampaigns();
        // Surface the freshly scheduled item by switching to the Campaigns tab.
        $('[data-um-tab="newsletterCampaignsPanel"]').trigger('click');
    } catch(e) {
        window.notificationService.showError('Could not process — check your connection and try again.');
    } finally {
        $btn.prop('disabled', false).html(origHtml);
    }
});

// Stubs kept for any remaining internal callsites
function loadScheduledList() { loadCampaigns(); }
// (D10) Removed empty loadSentCampaigns() stub — superseded by loadCampaigns()/the unified endpoint, no callers.

// ── Unified Campaigns ──
let campaignsPage = 1, campaignsStatus = 'all', campaignsSort = 'date_desc', campaignsSearch = '', campaignsData = [];

function updateCampaignsBulkBar() {
    const checked = $('.campaign-checkbox:checked').length;
    const total = $('.campaign-checkbox').length;
    if (checked > 0) {
        $('#campaignsBulkCount').text(checked + ' selected');
        $('#campaignsBulkBar').css('display', 'flex');
    } else {
        $('#campaignsBulkBar').hide();
    }
    const $all = $('#selectAllCampaigns');
    $all.prop('indeterminate', checked > 0 && checked < total);
    $all.prop('checked', total > 0 && checked === total);
}

/* Phase 7 Component 1 (HOUSEKEEPING-NOTES.md "#11"): loadCampaigns is now a DataTable instance.
   campaignsPage/Status/Sort/Search/Data, renderCampaignsPaginationNumbered, updateCampaignsBulkBar,
   the delegated .campaign-checkbox / #selectAllCampaigns handlers and everything else are UNCHANGED.
   window.DataTable comes from js/admin/components/data-table.js (loaded before this file). */
const campaignsTable = new DataTable({
    body:  '#campaignsTableBody',
    table: null,
    colspan: 5,
    states: {
        loading: { idiom: 'row-html', html: '<tr><td colspan="5"><div class="um-empty-state" style="padding:30px 20px;"><i class="fa-solid fa-circle-notch fa-spin" style="font-size:22px;color:var(--atl-amber);display:block;margin-bottom:8px;"></i>Loading campaigns…</div></td></tr>' },
        empty:   { idiom: 'row-html', html: function () {
            var msg = campaignsSearch ? 'No campaigns match your search.' : 'No campaigns found.';
            return '<tr><td colspan="5"><div class="um-empty-state" style="padding:30px 20px;"><i class="fa-solid fa-inbox" style="font-size:22px;color:var(--atl-muted-dim);display:block;margin-bottom:8px;"></i>' + msg + '</div></td></tr>';
        } },
        error:   { idiom: 'row-html', html: '<tr><td colspan="5"><div class="um-empty-state" style="padding:30px 20px;"><i class="fa-solid fa-triangle-exclamation" style="font-size:22px;color:var(--atl-clay);display:block;margin-bottom:8px;"></i>Could not load campaigns.</div></td></tr>' }
    },
    server: {
        pageSize: 0,   // server owns page size; unused here (#11 has no stats; wrapper returns data.pages)
        fetch: async function () {
            try {
                const data = await apiCall(`/api/admin/campaigns/unified?page=${campaignsPage}&status=${campaignsStatus}&sort=${campaignsSort}&search=${encodeURIComponent(campaignsSearch)}`, 'GET');
                campaignsData = data.campaigns || [];
                return { rows: campaignsData, total: data.total || 0, totalPages: data.pages || 1 };
            } catch (e) {
                $('#campaignsPagination').hide();                     // original catch also hides it (Gap F)
                throw e;                                              // -> component .catch -> states.error
            }
        }
    },
    renderRow: function (c) {
        const statusColors = { sent:'var(--atl-green)', scheduled:'var(--atl-orange)', failed:'var(--atl-clay)', cancelled:'var(--atl-muted)' };
        const raw = c.date || '';
        const d = raw ? new Date(raw.includes('T') ? raw : raw.replace(' ','T')+'Z') : null;
        const dateStr = d && !isNaN(d) ? d.toLocaleString() : '—';
        const sc = statusColors[c.display_status] || 'var(--atl-muted)';
        const label = c.display_status.charAt(0).toUpperCase() + c.display_status.slice(1);
        const isPending = c.display_status === 'scheduled';
        const subj = $('<span>').text(c.subject || '(No subject)').html();
        return `<tr class="campaign-row" data-subject="${subj.toLowerCase()}" style="border-bottom:1px solid var(--atl-line);">
                <td style="padding:10px 8px;width:36px;vertical-align:middle;border:none;">
                    <input type="checkbox" class="campaign-checkbox" data-id="${c.id}" data-source="${c.source}" style="accent-color: var(--atl-amber);cursor:pointer;">
                </td>
                <td style="padding:10px 8px;vertical-align:middle;border:none;max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px;color:var(--atl-ink-dim);" title="${subj}">${subj}</td>
                <td style="padding:10px 8px;vertical-align:middle;border:none;white-space:nowrap;">
                    <span style="display:inline-block;padding:2px 8px;border-radius:3px;font-size:11px;font-weight:600;background:${sc}22;color:${sc};border:1px solid ${sc}44;">${label}</span>
                </td>
                <td style="padding:10px 8px;vertical-align:middle;border:none;font-size:11px;color: var(--atl-muted);white-space:nowrap;">${dateStr}</td>
                <td style="padding:10px 8px;vertical-align:middle;border:none;text-align:right;white-space:nowrap;">
                    ${isPending ? `<button class="um-btn um-btn--ghost um-btn--sm campaign-edit-btn" data-id="${c.id}" style="margin-right:4px;" title="Edit"><i class="fa-solid fa-pen-to-square"></i></button>` : ''}
                    ${isPending ? `<button class="um-btn um-btn--ghost um-btn--sm campaign-cancel-btn" data-id="${c.id}" style="margin-right:4px;color:var(--atl-orange);border-color:rgba(255,152,0,0.4);" title="Cancel scheduled send"><i class="fa-solid fa-ban"></i> Cancel</button>` : ''}
                    ${c.display_status === 'sent' ? `<button class="um-btn um-btn--ghost um-btn--sm campaign-delivery-log-btn" data-subject="${subj}" data-source="${c.source}" style="margin-right:4px;" title="View delivery log"><i class="fa-solid fa-list-check"></i></button>` : ''}
                    <button class="um-btn um-btn--primary um-btn--sm campaign-reuse-btn" data-id="${c.id}" data-source="${c.source}" style="margin-right:4px;" title="Load into composer"><i class="fa-solid fa-rotate-left"></i> Reuse</button>
                    <button class="um-btn um-btn--ghost um-btn--sm campaign-delete-btn" data-id="${c.id}" data-source="${c.source}" style="color:var(--atl-clay);" title="Delete"><i class="fa-solid fa-trash"></i></button>
                </td>
            </tr>`;
    },
    onRender:   function ()     { updateCampaignsBulkBar(); },   // original called it on both empty (1171) and rows (1202)
    pagination: function (info) { renderCampaignsPaginationNumbered(info.totalPages); }
});

function loadCampaigns(resetPage) {
    if (resetPage) campaignsPage = 1;
    return campaignsTable.setPage(campaignsPage);
}

function renderCampaignsPaginationNumbered(totalPages) {
    var container = document.getElementById('campaignsPagination');
    if (!container) return;
    container.innerHTML = '';
    container.style.display = totalPages > 1 ? 'flex' : 'none';
    if (totalPages <= 1) return;

    var prev = document.createElement('button');
    prev.className = 'um-btn um-btn--ghost um-btn--sm' + (campaignsPage === 1 ? ' disabled' : '');
    prev.innerHTML = '<i class="fa fa-chevron-left"></i>';
    prev.onclick = function() { if (campaignsPage > 1) { campaignsPage--; loadCampaigns(); } };
    container.appendChild(prev);

    for (var i = 1; i <= totalPages; i++) {
        if (totalPages > 7 && i > 5 && i < totalPages) {
            if (i === 6) { var sp = document.createElement('span'); sp.textContent = '…'; sp.style.color = 'var(--atl-muted)'; sp.style.padding = '0 4px'; container.appendChild(sp); }
            continue;
        }
        var b = document.createElement('button');
        b.className = 'um-btn um-btn--sm ' + (campaignsPage === i ? 'um-btn--primary' : 'um-btn--ghost');
        b.textContent = i;
        (function(p) { b.onclick = function() { campaignsPage = p; loadCampaigns(); }; })(i);
        container.appendChild(b);
    }

    var next = document.createElement('button');
    next.className = 'um-btn um-btn--ghost um-btn--sm' + (campaignsPage === totalPages ? ' disabled' : '');
    next.innerHTML = '<i class="fa fa-chevron-right"></i>';
    next.onclick = function() { if (campaignsPage < totalPages) { campaignsPage++; loadCampaigns(); } };
    container.appendChild(next);
}

// Search is server-side (matches the backend's `search` param on the unified endpoint),
// debounced — previously this only filtered rows already on the current page.
let campaignsSearchDebounce = null;
$('#campaignsSearchInput').on('input', function() {
    var val = $(this).val().trim();
    clearTimeout(campaignsSearchDebounce);
    campaignsSearchDebounce = setTimeout(function() {
        campaignsSearch = val;
        loadCampaigns(true);
    }, 300);
});
$('#campaignsSortSelect').on('change', function() {
    campaignsSort = $(this).val();
    loadCampaigns(true);
});

$(document).on('click', '.campaign-cancel-btn', async function() {
    const id = $(this).data('id');
    if (!await window.notificationService.showConfirm({
        message: 'Cancel this scheduled newsletter? It will not be sent.',
        isDestructive: true
    })) return;
    try {
        const res = await apiCall('/api/admin/newsletter/schedule/' + id, 'DELETE');
        if (!res || !res.success) throw new Error(res.message || 'Cancel failed');
        window.notificationService.showSuccess('Scheduled newsletter cancelled.');
        loadCampaigns();
    } catch(e) { window.notificationService.showError('Could not cancel the scheduled newsletter.'); }
});
$('#campaignsPrevBtn').on('click', function() { if (campaignsPage > 1) { campaignsPage--; loadCampaigns(); } });
$('#campaignsNextBtn').on('click', function() { campaignsPage++; loadCampaigns(); });

// ─── Delivery log: real per-recipient send outcomes live in email_logs (written by the
// notification queue, not at enqueue time), scoped by trigger_event + a subject substring —
// email_logs has no campaign/schedule foreign key, so this is the best available scoping
// without a schema change. Mirrors loadBirthdayRecentSends()'s inline list pattern. ───
async function viewCampaignDeliveryLog(subject, source) {
    const trigger = source === 'schedule' ? 'Newsletter: Scheduled Campaign' : 'Newsletter: Campaign Dispatch';
    const $list = $('#campaignDeliveryLogList');
    const $empty = $('#campaignDeliveryLogEmpty');
    $list.empty();
    $empty.hide();
    $('#campaignDeliveryLogModal').modal('show');
    try {
        const res = await apiCall('/api/admin/email-logs?trigger=' + encodeURIComponent(trigger) + '&search=' + encodeURIComponent(subject) + '&limit=50&sort=sent_at&order=DESC');
        const logs = (res && res.success && Array.isArray(res.logs)) ? res.logs : [];
        if (!logs.length) { $empty.show(); return; }
        logs.forEach(function(log) {
            var statusBadge = log.status === 'success'
                ? '<span class="atl-badge atl-badge--confirmed">Sent</span>'
                : (log.status === 'failed' ? '<span class="atl-badge atl-badge--cancelled">Failed</span>' : '<span class="atl-badge atl-badge--unpaid">' + escHtml(log.status || '') + '</span>');
            var d = new Date(log.sent_at);
            $list.append(
                '<div style="display:flex; align-items:center; justify-content:space-between; gap:10px; padding:8px 10px; background:var(--atl-card); border:1px solid var(--atl-line); border-radius:6px; font-size:12px;">' +
                    '<span style="color:var(--atl-ink-dim); word-break:break-all;">' + escHtml(log.recipient_email) + '</span>' +
                    '<span style="display:flex; align-items:center; gap:8px; white-space:nowrap;"><span style="color:var(--atl-muted);">' + d.toLocaleString() + '</span>' + statusBadge + '</span>' +
                '</div>'
            );
        });
    } catch (e) {
        console.error('Error loading campaign delivery log:', e);
        $empty.text('Could not load the delivery log.').show();
    }
    $('#campaignDeliveryLogViewAll').off('click').on('click', function(ev) {
        ev.preventDefault();
        logState.trigger = trigger;
        logState.search = subject;
        $('#logTriggerFilter').val(trigger);
        $('#logSearch').val(subject);
        $('#campaignDeliveryLogModal').modal('hide');
        window.switchTab('emailLogsAdmin');
        window.loadEmailLogs();
    });
}
$(document).on('click', '.campaign-delivery-log-btn', function() {
    viewCampaignDeliveryLog($(this).data('subject'), $(this).data('source'));
});

$(document).on('change', '#selectAllCampaigns', function() {
    $('.campaign-checkbox').prop('checked', this.checked);
    updateCampaignsBulkBar();
});
$(document).on('change', '.campaign-checkbox', function() { updateCampaignsBulkBar(); });

$('#campaignsBulkDeleteBtn').on('click', async function() {
    const items = [];
    $('.campaign-checkbox:checked').each(function() {
        items.push({ id: parseInt($(this).data('id')), source: $(this).data('source') });
    });
    if (!items.length) return;
    if (!await window.notificationService.showConfirm({
        message: `Delete ${items.length} campaign record${items.length !== 1 ? 's' : ''}? This cannot be undone.`,
        isDestructive: true
    })) return;
    try {
        await apiCall('/api/admin/campaigns/bulk-delete', 'POST', { items });
        window.notificationService.showSuccess(`${items.length} campaign${items.length !== 1 ? 's' : ''} deleted.`);
        loadCampaigns();
    } catch(e) { window.notificationService.showError('Could not delete campaigns.'); }
});

$(document).on('click', '.campaign-reuse-btn', function() {
    const id = parseInt($(this).data('id'));
    const source = $(this).data('source');
    const item = campaignsData.find(c => c.id === id && c.source === source);
    if (!item) return;
    $('#newsletterSubject').val(item.subject || '');
    if (window.newsletterQuill) window.newsletterQuill.root.innerHTML = item.content || '';
    window.notificationService.showSuccess('Campaign loaded into composer.');
    $('html, body').animate({ scrollTop: $('#newsletterSubject').offset().top - 80 }, 300);
});

$(document).on('click', '.campaign-delete-btn', async function() {
    if (!await window.notificationService.showConfirm({ message: 'Delete this campaign record?', isDestructive: true })) return;
    const id = parseInt($(this).data('id'));
    const source = $(this).data('source');
    try {
        await apiCall('/api/admin/campaigns/bulk-delete', 'POST', { items: [{ id, source }] });
        window.notificationService.showSuccess('Campaign deleted.');
        loadCampaigns();
    } catch(e) { window.notificationService.showError('Could not delete campaign.'); }
});

$(document).on('click', '.campaign-edit-btn', function() {
    const id = parseInt($(this).data('id'));
    const item = campaignsData.find(c => c.id === id && c.source === 'schedule');
    if (!item) return;
    $('#newsletterSubject').val(item.subject || '');
    if (window.newsletterQuill) window.newsletterQuill.root.innerHTML = item.content || '';
    const raw = item.date || '';
    const dt = new Date(raw.includes('T') ? raw : raw.replace(' ','T')+'Z');
    const pad = n => String(n).padStart(2,'0');
    $('#scheduledDateTime').val(`${dt.getFullYear()}-${pad(dt.getMonth()+1)}-${pad(dt.getDate())}T${pad(dt.getHours())}:${pad(dt.getMinutes())}`);
    if (!$('#scheduleToggle').prop('checked')) $('#scheduleToggle').prop('checked', true).trigger('change');
    currentScheduleId = item.id;
    $('#newsletterScheduleBtn').html('<i class="fa-solid fa-calendar-check"></i> Update Schedule');
    document.getElementById('newsletterAdmin').scrollIntoView({ behavior: 'smooth' });
});
