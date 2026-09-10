/* Phase 6 (HOUSEKEEPING-NOTES.md): relocated from admin.html verbatim — the "INQUIRIES — EMAIL
   CLIENT" block: inbox list/search/filter/sort/pagination, the detail drawer, a Quill-based
   compose view with recipient chips, attachments, scheduling, autosave drafts, templates, bulk
   status actions, and notes.

   Verified before this move (given two near-misses on the two sections immediately before this
   one): an exhaustive scan of the entire original range for (function/})(); patterns found
   none, the range parses standalone, and the file itself confirms it via existing developer
   comment ("this section's <script> block is a separate scope from the manual-booking
   drawer's") — no enclosing IIFE, safe as a same-position split.

   Zero new window attachments needed. window.loadInquiries was already explicitly attached
   (per that same comment, so Convert-to-Booking's manual-booking drawer — a different closure
   — can refresh the inbox). Every other name here (openInquiry and ~48 more) is a plain
   top-level function/let declaration with no wrapping IIFE, so it was already globally
   reachable exactly as before — including allInquiriesCache, read via a
   `typeof allInquiriesCache !== 'undefined'` guard from inside the anonymous mega-closure's own
   "Notifications" dropdown feature, which already works correctly today (unlike the
   adminCalendar/auditState cases, this one was never broken — let declarations at a script's
   true top level are already part of the page's one shared global lexical environment). */

// ===========================
// INQUIRIES — EMAIL CLIENT
// ===========================

let allInquiriesCache = [];   // holds the CURRENT PAGE of inquiries (server-paginated)
let currentInqFilter = 'all';
let currentInqId = null;
let inqPage = 1;
let inqCounts = { all: 0, unread: 0, read: 0, replied: 0, archived: 0, mine: 0 };
let inqAssignableAdmins = null; // cached list of {id, full_name, username, role}

// Fetches (once per page load) the active-admin roster for the "Assigned to" select.
async function loadInqAssignableAdmins() {
    if (inqAssignableAdmins) return inqAssignableAdmins;
    try {
        const res = await apiCall('/api/admin/inquiries/assignable-admins');
        inqAssignableAdmins = (res && res.success && res.admins) ? res.admins : [];
    } catch (e) {
        inqAssignableAdmins = [];
    }
    const $sel = $('#inqAssignSelect');
    $sel.find('option[value!=""]').remove();
    inqAssignableAdmins.forEach(a => {
        $sel.append(`<option value="${a.id}">${$('<s>').text(a.full_name || a.username).html()}</option>`);
    });
    return inqAssignableAdmins;
}

let inqCategoriesCache = null;
async function loadInqCategories() {
    if (inqCategoriesCache) return inqCategoriesCache;
    try {
        const res = await apiCall('/api/admin/inquiries/categories');
        inqCategoriesCache = (res && res.success && res.categories) ? res.categories : [];
    } catch (e) {
        inqCategoriesCache = [];
    }
    const $list = $('#inqCategoryList');
    $list.empty();
    inqCategoriesCache.forEach(c => $list.append(`<option value="${$('<s>').text(c).html()}"></option>`));
    return inqCategoriesCache;
}

// ---- Helpers ----
function inqIsToday(d) {
    const t = new Date();
    return d.getDate() === t.getDate() && d.getMonth() === t.getMonth() && d.getFullYear() === t.getFullYear();
}

function inqFormatDate(dateStr) {
    if (!dateStr) return '';
    const d = new Date(dateStr);
    return inqIsToday(d)
        ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        : d.toLocaleDateString([], { day: 'numeric', month: 'short', year: '2-digit' });
}

function inqStatusBadgeClass(status) {
    return { unread: 'inq-badge--unread', read: 'inq-badge--read', replied: 'inq-badge--replied', archived: 'inq-badge--archived' }[status] || 'inq-badge--read';
}

function inqStatusLabel(status) {
    return { unread: 'Unread', read: 'Read', replied: 'Replied', archived: 'Archived' }[status] || status;
}

// ---- Data Loading (server-side paginated/filtered/sorted) ----
// Exposed on window: this section's <script> block is a separate scope from the manual-booking
// drawer's (Convert to Booking needs to refresh the inbox after creating a booking).
window.loadInquiries = loadInquiries;
async function loadInquiries(resetPage) {
    if (resetPage) inqPage = 1;
    $('#inqListBody').html('<div class="inq-empty-state"><i class="fa-solid fa-rotate fa-spin" aria-hidden="true"></i><p>Loading...</p></div>');
    const sort = $('#inqSortSelect').val() || 'newest';
    const search = $('#inqSearchInput').val() || '';

    if (currentInqFilter === 'drafts' || currentInqFilter === 'scheduled') {
        const statusQuery = currentInqFilter === 'drafts' ? 'draft' : 'scheduled';
        try {
            const res = await apiCall('/api/admin/direct-emails?page=' + inqPage + '&status=' + statusQuery + '&search=' + encodeURIComponent(search));
            if (res && res.success) {
                allInquiriesCache = res.emails;
                if (allInquiriesCache.length === 0 && inqPage > 1 && (res.total || 0) > 0) {
                    inqPage--;
                    return loadInquiries();
                }
                
                // We also trigger a badge count sweep to refresh sidebar counters
                const cntRes = await apiCall('/api/admin/inquiries?page=1&limit=1');
                if (cntRes && cntRes.success) {
                    renderInqCounts(cntRes.counts);
                }

                renderDirectEmailsList();
                inqUpdatePagination(res.total || 0, res.pages || 1);
                updateInqBulkBar();
            } else {
                throw new Error('Invalid response');
            }
        } catch (e) {
            $('#inqListBody').html('<div class="inq-empty-state"><i class="fa-solid fa-circle-exclamation" aria-hidden="true"></i><p>Failed to load direct emails.</p></div>');
            window.notificationService.showError('Could not load direct emails.');
            $('#inqPagination').hide();
        }
        return;
    }

    const isMine = currentInqFilter === 'mine';
    const statusParam = isMine ? 'all' : currentInqFilter;
    let data;
    try {
        data = await apiCall('/api/admin/inquiries?page=' + inqPage + '&limit=50&status=' + encodeURIComponent(statusParam) + (isMine ? '&mine=1' : '') + '&sort=' + encodeURIComponent(sort) + '&search=' + encodeURIComponent(search));
    } catch (e) {
        $('#inqListBody').html('<div class="inq-empty-state"><i class="fa-solid fa-circle-exclamation" aria-hidden="true"></i><p>Failed to load messages.</p></div>');
        window.notificationService.showError('Could not load messages — please check your connection and try again.');
        $('#inqPagination').hide();
        return;
    }
    if (!data || !data.success || !Array.isArray(data.inquiries)) {
        $('#inqListBody').html('<div class="inq-empty-state"><i class="fa-solid fa-circle-exclamation" aria-hidden="true"></i><p>Failed to load messages.</p></div>');
        window.notificationService.showError('Could not load messages — please try again.');
        $('#inqPagination').hide();
        return;
    }
    allInquiriesCache = data.inquiries;
    // If a deletion emptied the current page (but earlier pages still have rows), step back.
    if (allInquiriesCache.length === 0 && inqPage > 1 && (data.total || 0) > 0) {
        inqPage--;
        return loadInquiries();
    }
    renderInqCounts(data.counts);
    // Pagination state must be current before renderInqList() runs — it reads #inqNextBtn's
    // disabled state to decide whether this is the last page (and so whether to show the
    // "You're all caught up" end-of-list marker).
    inqUpdatePagination(data.total || 0, data.pages || 1);
    renderInqList();
    updateInqBulkBar();
}

// Optimistic global-count adjustment for a single-item status change (avoids a full re-fetch).
function inqAdjustCounts(oldStatus, newStatus) {
    if (oldStatus && inqCounts[oldStatus] != null) inqCounts[oldStatus] = Math.max(0, inqCounts[oldStatus] - 1);
    if (newStatus && inqCounts[newStatus] != null) inqCounts[newStatus] = (inqCounts[newStatus] || 0) + 1;
    renderInqCounts();
}

function renderInqCounts(counts) {
    if (counts && typeof counts === 'object') inqCounts = counts;
    $('#inqCount-all').text(inqCounts.all > 0 ? inqCounts.all : '');
    $('#inqCount-unread').text(inqCounts.unread > 0 ? inqCounts.unread : '');
    $('#inqCount-read').text(inqCounts.read > 0 ? inqCounts.read : '');
    $('#inqCount-replied').text(inqCounts.replied > 0 ? inqCounts.replied : '');
    $('#inqCount-archived').text(inqCounts.archived > 0 ? inqCounts.archived : '');
    $('#inqCount-drafts').text(inqCounts.drafts > 0 ? inqCounts.drafts : '');
    $('#inqCount-scheduled').text(inqCounts.scheduled > 0 ? inqCounts.scheduled : '');
    $('#inqCount-mine').text(inqCounts.mine > 0 ? inqCounts.mine : '');
}

function renderDirectEmailsList() {
    const data = allInquiriesCache;
    const $body = $('#inqListBody');
    $body.empty();

    if (!data || data.length === 0) {
        $body.html('<div class="inq-empty-state"><i class="fa-regular fa-envelope-open" aria-hidden="true"></i><p>No draft or scheduled emails found.</p></div>');
        return;
    }

    data.forEach(row => {
        let toList = [];
        try { toList = JSON.parse(row.to_emails || '[]'); } catch(e) { toList = [row.to_emails]; }
        const toStr = toList.join(', ') || 'Draft';
        const initial = toStr.charAt(0).toUpperCase();
        const dateStr = inqFormatDate(row.updated_at);
        const preview = (row.body || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim().substring(0, 100);
        const isActive = (inqActiveDraftId == row.id) ? 'inq-row--active' : '';
        const escapedTo = $('<span>').text(toStr).html();
        const escapedSubject = $('<span>').text(row.subject || '(No Subject)').html();
        const escapedPreview = $('<span>').text(preview).html();

        let statusDot = 'draft';
        let statusLabel = 'Draft';
        if (row.status === 'scheduled') {
            statusDot = 'scheduled';
            statusLabel = 'Scheduled at ' + row.scheduled_at;
        }

        $body.append(`
<div class="inq-row ${isActive}" data-id="${row.id}" role="button" tabindex="0" aria-label="Direct email to ${escapedTo}: ${escapedSubject}">
    <input type="checkbox" class="inq-row-check" data-id="${row.id}" aria-label="Select draft">
    <div class="inq-row-avatar" aria-hidden="true" style="background:rgba(212,175,55,0.1); color:var(--atl-amber);">${initial}</div>
    <div class="inq-row-main">
<div class="inq-row-top">
    <span class="inq-row-name">${escapedTo}</span>
    <span class="inq-row-date">${dateStr}</span>
</div>
<div class="inq-row-subject">${escapedSubject}</div>
<div class="inq-row-preview">${escapedPreview}</div>
    </div>
    <span class="inq-status-dot inq-status-dot--${statusDot}" aria-label="${statusLabel}"></span>
</div>`);
    });
}

// ---- Pagination control ----
/* Phase 7 Component 2 ("B1"): inqUpdatePagination -> Pagination prevnext instance. It only sets
   #inqPrevBtn/#inqNextBtn .disabled + the #inqPageInfo label + #inqPagination visibility; the
   prev/next CLICKS stay bound by the delegated $(document).on('click', '#inqPrevBtn'|…) handlers. */
var inqPager = new Pagination({
    mode: 'prevnext',
    container: '#inqPagination',
    prevEl: '#inqPrevBtn',
    nextEl: '#inqNextBtn',
    infoEl: '#inqPageInfo',
    pageSize: 50,
    getPage: function () { return inqPage; }
});
function inqUpdatePagination(total, pages) { return inqPager.render(total, pages); }

// ---- Render Message List ----
// Server already applied folder/search/sort + pagination, so this is a pure renderer
// of the current page (allInquiriesCache).
function renderInqList() {
    const data = allInquiriesCache;

    const $body = $('#inqListBody');
    $body.empty();

    if (!data || data.length === 0) {
        $body.html('<div class="inq-empty-state"><i class="fa-regular fa-envelope-open" aria-hidden="true"></i><p>No messages found.</p></div>');
        return;
    }

    data.forEach(row => {
        const isUnread = row.status === 'unread';
        const rowInitial = (row.sender_name || '?').charAt(0).toUpperCase();
        const dateStr = inqFormatDate(row.submitted_at);
        const preview = (row.message_body || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim().substring(0, 100);
        const isActive = (currentInqId == row.inquiry_id) ? 'inq-row--active' : '';
        const unreadClass = isUnread ? 'inq-row--unread' : '';
        const escapedName = $('<span>').text(row.sender_name || 'Unknown').html();
        const escapedSubject = $('<span>').text(row.subject || '(No Subject)').html();
        const escapedPreview = $('<span>').text(preview).html();
        const assigneeChip = row.assigned_to_name
            ? `<span class="inq-chip" style="margin-left:6px;" title="Assigned to ${$('<s>').text(row.assigned_to_name).html()}"><i class="fa-solid fa-user" aria-hidden="true"></i> ${(row.assigned_to_name || '?').charAt(0).toUpperCase()}</span>`
            : '';
        const priorityFlag = (row.priority === 'high' || row.priority === 'urgent')
            ? `<i class="fa-solid fa-flag inq-priority-flag inq-priority-flag--${row.priority}" title="${row.priority === 'urgent' ? 'Urgent' : 'High'} priority" aria-label="${row.priority === 'urgent' ? 'Urgent' : 'High'} priority"></i>`
            : '';
        const categoryPill = row.category
            ? `<span class="inq-chip" style="margin-left:6px; flex-shrink:0;"><i class="fa-solid fa-tag" aria-hidden="true"></i> ${$('<s>').text(row.category).html()}</span>`
            : '';
        const overdueFlag = row.overdue
            ? `<i class="fa-solid fa-clock inq-overdue-flag" title="Overdue: past the response SLA" aria-label="Overdue: past the response SLA"></i>`
            : '';

        $body.append(`
<div class="inq-row ${unreadClass} ${isActive}" data-id="${row.inquiry_id}" role="button" tabindex="0" aria-label="Message from ${escapedName}: ${escapedSubject}">
    <input type="checkbox" class="inq-row-check" data-id="${row.inquiry_id}" aria-label="Select message from ${escapedName}">
    <div class="inq-row-avatar" aria-hidden="true">${rowInitial}</div>
    <div class="inq-row-main">
<div class="inq-row-top">
    <span class="inq-row-name">${overdueFlag}${priorityFlag}${escapedName}</span>${assigneeChip}${categoryPill}
    <span class="inq-row-date" style="margin-left:auto;">${dateStr}</span>
</div>
<div class="inq-row-subject">${escapedSubject}</div>
<div class="inq-row-preview">${escapedPreview}</div>
    </div>
    <span class="inq-status-dot inq-status-dot--${row.status}" aria-label="${inqStatusLabel(row.status)}"></span>
</div>`);
    });

    // Only on the last page — avoids implying "that's everything" while more pages remain.
    if ($('#inqNextBtn').is(':disabled')) {
        $body.append(`
<div class="inq-list-end">
    <i class="fa-solid fa-circle-check" aria-hidden="true"></i>
    <span>You're all caught up</span>
</div>`);
    }
}

// ---- Open / Read a Message ----
function openInquiry(id) {
    const inquiry = allInquiriesCache.find(i => i.inquiry_id == id);
    if (!inquiry) return;
    currentInqId = id;

    // Populate header
    const initial = (inquiry.sender_name || '?').charAt(0).toUpperCase();
    $('#inqReadAvatar').text(initial);
    $('#inqReadSubject').text(inquiry.subject || '(No Subject)');
    $('#inqReadFrom').text(inquiry.sender_name || 'Unknown');
    $('#inqReadFromEmail').text('<' + inquiry.sender_email + '>');
    $('#inqReadDate').text(new Date(inquiry.submitted_at).toLocaleString());
    $('#inqReadStatusBadge')
        .text(inqStatusLabel(inquiry.status))
        .attr('class', 'inq-read-status-badge inq-badge ' + inqStatusBadgeClass(inquiry.status));
    $('#inqOverdueBadge').toggle(!!inquiry.overdue);

    // Metadata chips
    let chips = '';
    if (inquiry.category) chips += `<span class="inq-chip"><i class="fa-solid fa-tag" aria-hidden="true"></i> ${$('<s>').text(inquiry.category).html()}</span>`;
    if (inquiry.sender_phone) chips += `<span class="inq-chip"><i class="fa-solid fa-phone" aria-hidden="true"></i> ${$('<s>').text(inquiry.sender_phone).html()}</span>`;
    if (inquiry.sender_email) chips += `<span class="inq-chip"><i class="fa-solid fa-at" aria-hidden="true"></i> <a href="mailto:${inquiry.sender_email}" style="color:inherit;">${$('<s>').text(inquiry.sender_email).html()}</a></span>`;
    if (inquiry.routing_path) chips += `<span class="inq-chip"><i class="fa-solid fa-route" aria-hidden="true"></i> ${$('<s>').text(inquiry.routing_path).html()}</span>`;
    $('#inqReadChips').html(chips);

    // CRM panel: assignment + priority (manager+ only — assistants see them read-only)
    loadInqAssignableAdmins().then(() => {
        $('#inqAssignSelect').val(inquiry.assigned_to || '');
    });
    $('#inqAssignSelect').prop('disabled', window.currentUserRole === 'assistant');
    $('#inqPrioritySelect').val(inquiry.priority || 'normal').prop('disabled', window.currentUserRole === 'assistant');
    loadInqCategories();
    $('#inqCategoryInput').val(inquiry.category || '');

    // Convert to Booking: show the converted-booking link instead of the action once linked
    if (inquiry.converted_booking_id) {
        $('#inqConvertToBookingBtn').hide();
        $('#inqConvertedLinkText').text('Converted → Booking #' + inquiry.converted_booking_id);
        $('#inqConvertedLink').show();
    } else {
        $('#inqConvertToBookingBtn').show();
        $('#inqConvertedLink').hide();
    }

    // Internal notes: collapsed by default, loaded lazily when expanded (see toggle handler)
    $('#inqNotesBody').hide();
    $('#inqNotesToggle').attr('aria-expanded', 'false');
    $('#inqNotesList').empty();
    $('#inqNotesCount').text('');
    $('#inqNoteInput').val('');

    // Message body (newlines → <br>)
    const safeBody = $('<span>').text(inquiry.message_body || '').html().replace(/\n/g, '<br>');
    $('#inqReadBody').html('<p style="margin:0;">' + safeBody + '</p>');

    // Show views
    $('#inqComposeView').hide();
    $('#inqReadView').show();
    openAtlDrawer('inqDetailDrawer');

    // Highlight active row
    $('.inq-row').removeClass('inq-row--active');
    $(`.inq-row[data-id="${id}"]`).addClass('inq-row--active');

    // Auto-mark as read (skipped for assistants — status-change is manager+ only)
    if (inquiry.status === 'unread' && window.currentUserRole !== 'assistant') {
        apiCall('/api/admin/inquiries/' + id + '/status', 'PUT', { status: 'read' }).then(res => {
            if (res && res.success) {
                inquiry.status = 'read';
                inqAdjustCounts('unread', 'read');
                $(`.inq-row[data-id="${id}"]`).removeClass('inq-row--unread');
                $('#inqReadStatusBadge')
                    .text('Read')
                    .attr('class', 'inq-read-status-badge inq-badge inq-badge--read');
            }
        }).catch(() => {});
    }
}

// ---- Direct Email Recipient Arrays & Config ----
let inqToEmails = [];
let inqCcEmails = [];
let inqBccEmails = [];
let inqComposeQuill = null;
let inqActiveDraftId = null;
let inqAttachments = [];
let inqActiveInquiryContext = null;
let inqAutosaveTimer = null;

// ---- Compose Mode (Enhanced) ----
function showInqComposeView(defaults) {
    currentInqId = null;
    inqActiveDraftId = null;
    inqAttachments = [];
    inqToEmails = [];
    inqCcEmails = [];
    inqBccEmails = [];
    inqActiveInquiryContext = null;

    defaults = defaults || {};
    
    // Clean/Reset all form fields
    $('#inqComposerTitle').html(defaults.isReply ? '<i class="fa-solid fa-reply"></i> Reply to Inquiry' : '<i class="fa-solid fa-pen-to-square"></i> New Message');
    $('#inqComposeSubject').val(defaults.subject || '');
    $('#inqComposeReplyTo').val(defaults.replyTo || '');
    
    // Initialize/reset Quill editor
    initInqComposeQuill();
    if (inqComposeQuill) {
        inqComposeQuill.root.innerHTML = defaults.body || '<p><br></p>';
    }

    // CC/BCC collapses
    $('#inqCcRow, #inqBccRow, #inqReplyToRow').hide();
    $('#toggleCcBccBtn').text('Cc/Bcc/Reply-To');

    // Reset template selection
    $('#inqTemplateSelect').val('');

    // Clear attachments
    renderInqAttachments();

    // Clear scheduled sendpicker
    $('#inqScheduleSendRow').hide();
    $('#inqSchedulePicker').val('');

    // Pre-populate recipients
    if (defaults.to) {
        if (Array.isArray(defaults.to)) {
            defaults.to.forEach(e => addRecipientChip('inqToChipsContainer', 'inqComposeToInput', e, inqToEmails));
        } else {
            addRecipientChip('inqToChipsContainer', 'inqComposeToInput', defaults.to, inqToEmails);
        }
    } else {
        renderRecipientChips('inqToChipsContainer', 'inqComposeToInput', inqToEmails);
    }
    renderRecipientChips('inqCcChipsContainer', 'inqComposeCcInput', inqCcEmails);
    renderRecipientChips('inqBccChipsContainer', 'inqComposeBccInput', inqBccEmails);

    // Bind inputs
    setupInqChipInput('inqToChipsContainer', 'inqComposeToInput', inqToEmails);
    setupInqChipInput('inqCcChipsContainer', 'inqComposeCcInput', inqCcEmails);
    setupInqChipInput('inqBccChipsContainer', 'inqComposeBccInput', inqBccEmails);

    // Set attachments drag/drop
    initInqAttachmentUpload();

    // Set scheduled datetimepicker
    initInqSchedulePicker();

    // Hide/Show correct drawer panels. inqComposeView uses the atl-drawer__header/body/footer
    // flex layout, so it needs display:flex specifically — jQuery's .show() would default to
    // display:block (the tag's UA default), breaking the pinned header/footer + scrolling body.
    $('#inqReadView').hide();
    $('#inqComposeView').css('display', 'flex');

    openAtlDrawer('inqDetailDrawer');
    $('.inq-row').removeClass('inq-row--active');
    
    setTimeout(() => {
        $('#inqComposeToInput').trigger('focus');
    }, 100);

    // Clear existing autosave timer
    if (inqAutosaveTimer) clearInterval(inqAutosaveTimer);
    // Trigger automatic draft autosaving every 15 seconds if body/to has content
    inqAutosaveTimer = setInterval(autosaveInqDraft, 15000);
}

// Quill WYSIWYG editor init
function initInqComposeQuill() {
    if (inqComposeQuill) return;
    try {
        if (typeof Quill === 'undefined') return;
        
        var Font = Quill.import('formats/font');
        Font.whitelist = ['outfit','cormorant','jetbrains','farsan','opensans','roboto','lato','montserrat','arial','georgia','timesnewroman','garamond','playfair'];
        Quill.register(Font, true);

        var Size = Quill.import('formats/size');
        Size.whitelist = ['small', false, 'large', 'huge'];
        Quill.register(Size, true);

        const toolbarOptions = [
            [{ 'font': Font.whitelist }],
            [{ 'size': Size.whitelist }],
            ['bold', 'italic', 'underline', 'strike'],
            [{ 'color': [] }, { 'background': [] }],
            [{ 'header': [1, 2, 3, false] }],
            [{ 'align': [] }],
            [{ 'list': 'ordered'}, { 'list': 'bullet' }],
            [{ 'indent': '-1'}, { 'indent': '+1' }],
            ['blockquote', 'link'],
            ['table-insert', 'hr-insert', 'emoji-picker'],
            ['undo', 'redo', 'clean']
        ];

        inqComposeQuill = new Quill('#inqComposeBodyEditor', {
            theme: 'snow',
            placeholder: 'Write your email here...',
            modules: {
                toolbar: {
                    container: toolbarOptions,
                    handlers: {
                        'table-insert': function() {
                            const rows = prompt('Number of rows:', '2') || 2;
                            const cols = prompt('Number of columns:', '3') || 3;
                            let table = '<table style="width:100%; border-collapse:collapse; margin:10px 0; border:1px solid var(--atl-line);">';
                            table += '<thead><tr style="background:rgba(255,255,255,0.03);">';
                            for (let c = 0; c < cols; c++) table += '<th style="border:1px solid var(--atl-line); padding:6px 10px; text-align:left; color:var(--atl-amber);">Header</th>';
                            table += '</tr></thead><tbody>';
                            for (let r = 0; r < rows; r++) {
                                table += '<tr>';
                                for (let c = 0; c < cols; c++) table += '<td style="border:1px solid var(--atl-line); padding:6px 10px; color:var(--atl-ink);">Cell</td>';
                                table += '</tr>';
                            }
                            table += '</tbody></table>';
                            const range = this.quill.getSelection(true);
                            this.quill.clipboard.dangerouslyPasteHTML(range.index, table);
                        },
                        'hr-insert': function() {
                            const range = this.quill.getSelection(true);
                            this.quill.clipboard.dangerouslyPasteHTML(range.index, '<hr style="border:0; border-top:1px solid rgba(255,255,255,0.15); margin:15px 0;">');
                        },
                        'emoji-picker': function() {
                            const emojis = ['😊', '👍', '🙏', '🎉', '🔥', '💡', '🌟', '👏', '❤️', '📧', '📞', '🤝'];
                            const selected = prompt('Choose an emoji:\n' + emojis.join(' '), '😊');
                            if (selected && emojis.includes(selected.trim())) {
                                const range = this.quill.getSelection(true);
                                this.quill.insertText(range.index, selected.trim());
                            }
                        },
                        'undo': function() { this.quill.history.undo(); },
                        'redo': function() { this.quill.history.redo(); }
                    }
                }
            }
        });

        $('.ql-table-insert').html('<i class="fa-solid fa-table" title="Insert Table"></i>');
        $('.ql-hr-insert').html('<i class="fa-solid fa-minus" title="Insert Horizontal Rule"></i>');
        $('.ql-emoji-picker').html('<i class="fa-regular fa-face-smile" title="Insert Emoji"></i>');
        $('.ql-undo').html('<i class="fa-solid fa-rotate-left" title="Undo"></i>');
        $('.ql-redo').html('<i class="fa-solid fa-rotate-right" title="Redo"></i>');
    } catch(e) {
        console.warn('Composer Quill init failed:', e);
    }
}

// Recipient chips controller logic
function setupInqChipInput(containerId, inputId, storageArray) {
    const $container = $('#' + containerId);
    const $input = $('#' + inputId);
    
    $container.off('click').on('click', function(e) {
        if (e.target === this || $(e.target).hasClass('inq-recipient-chip') || $(e.target).parent().hasClass('inq-recipient-chip')) {
            $input.trigger('focus');
        }
    });

    $input.off('keydown').on('keydown', function(e) {
        const value = $(this).val().trim();
        if (e.key === 'Enter' || e.key === ',' || e.key === ' ' || e.key === 'Tab') {
            e.preventDefault();
            if (value) {
                addRecipientChip(containerId, inputId, value, storageArray);
                $(this).val('');
            }
        } else if (e.key === 'Backspace' && !value && storageArray.length > 0) {
            storageArray.pop();
            renderRecipientChips(containerId, inputId, storageArray);
        }
    });

    $input.off('blur').on('blur', function() {
        const value = $(this).val().trim();
        if (value) {
            addRecipientChip(containerId, inputId, value, storageArray);
            $(this).val('');
        }
    });
}

function addRecipientChip(containerId, inputId, email, storageArray) {
    const cleanEmail = email.replace(/,/g, '').trim();
    if (!cleanEmail) return;
    if (storageArray.includes(cleanEmail)) return;
    storageArray.push(cleanEmail);
    renderRecipientChips(containerId, inputId, storageArray);
}

function removeRecipientChip(containerId, inputId, email, storageArray) {
    const idx = storageArray.indexOf(email);
    if (idx !== -1) {
        storageArray.splice(idx, 1);
    }
    renderRecipientChips(containerId, inputId, storageArray);
}

function renderRecipientChips(containerId, inputId, storageArray) {
    const $container = $('#' + containerId);
    const $input = $('#' + inputId);
    $container.find('.inq-recipient-chip').remove();
    
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    storageArray.forEach(email => {
        const isValid = emailRegex.test(email);
        const invalidClass = isValid ? '' : 'inq-recipient-invalid';
        const chipHtml = `
            <span class="inq-recipient-chip ${invalidClass}">
                <span>${email}</span>
                <i class="fa-solid fa-xmark inq-chip-remove" data-email="${email}"></i>
            </span>
        `;
        $(chipHtml).insertBefore($input);
    });
}

// Attachments upload logic
function initInqAttachmentUpload() {
    const $zone = $('#inqDragDropZone');
    const $fileInput = $('#inqAttachmentFileInput');

    $('#inqBrowseLink').off('click').on('click', function(e) {
        e.stopPropagation();
        $fileInput.trigger('click');
    });

    $zone.off('dragover').on('dragover', function(e) {
        e.preventDefault();
        e.stopPropagation();
        $(this).addClass('dragover');
    });

    $zone.off('dragleave').on('dragleave', function(e) {
        e.preventDefault();
        e.stopPropagation();
        $(this).removeClass('dragover');
    });

    $zone.off('drop').on('drop', function(e) {
        e.preventDefault();
        e.stopPropagation();
        $(this).removeClass('dragover');
        const files = e.originalEvent.dataTransfer.files;
        handleInqFiles(files);
    });

    $fileInput.off('change').on('change', function() {
        const files = this.files;
        handleInqFiles(files);
    });
}

function handleInqFiles(files) {
    if (!files.length) return;
    for (let i = 0; i < files.length; i++) {
        uploadInqAttachment(files[i]);
    }
}

async function uploadInqAttachment(file) {
    const maxSize = 10 * 1024 * 1024;
    if (file.size > maxSize) {
        window.notificationService.showError(`File ${file.name} exceeds 10MB limit.`);
        return;
    }

    const formData = new FormData();
    formData.append('file', file);

    const $progressBox = $('#inqUploadProgressBox');
    const $percent = $('#inqUploadProgressPercent');
    const $fileName = $('#inqUploadFileName');
    const $barFill = $('#inqProgressBarFill');

    $fileName.text('Uploading ' + file.name + '...');
    $percent.text('0%');
    $barFill.css('width', '0%');
    $progressBox.show();

    try {
        const xhr = new XMLHttpRequest();
        xhr.open('POST', '/api/admin/direct-emails/upload', true);
        
        xhr.upload.onprogress = function(e) {
            if (e.lengthComputable) {
                const percentVal = Math.round((e.loaded / e.total) * 100);
                $percent.text(percentVal + '%');
                $barFill.css('width', percentVal + '%');
            }
        };

        xhr.onload = function() {
            $progressBox.hide();
            if (xhr.status === 200) {
                try {
                    const res = JSON.parse(xhr.responseText);
                    if (res.success) {
                        inqAttachments.push({
                            filename: res.originalName,
                            path: res.path,
                            size: res.size
                        });
                        renderInqAttachments();
                        window.notificationService.showSuccess(`Uploaded ${res.originalName}`);
                    } else {
                        window.notificationService.showError(res.message || 'Upload failed');
                    }
                } catch(e) {
                    window.notificationService.showError('Invalid server response');
                }
            } else {
                window.notificationService.showError('Upload failed with status ' + xhr.status);
            }
        };

        xhr.onerror = function() {
            $progressBox.hide();
            window.notificationService.showError('Network error during upload');
        };

        xhr.send(formData);
    } catch(e) {
        $progressBox.hide();
        window.notificationService.showError('Upload initialization failed');
    }
}

function renderInqAttachments() {
    const $list = $('#inqAttachmentsList');
    $list.empty();
    inqAttachments.forEach((att, idx) => {
        const sizeMb = (att.size / (1024 * 1024)).toFixed(2);
        const ext = att.filename.split('.').pop().toLowerCase();
        let iconClass = 'fa-file';
        if (['jpg', 'jpeg', 'png', 'gif', 'webp'].includes(ext)) iconClass = 'fa-file-image';
        else if (ext === 'pdf') iconClass = 'fa-file-pdf';
        else if (['doc', 'docx'].includes(ext)) iconClass = 'fa-file-word';
        else if (['zip', 'rar', '7z', 'gz'].includes(ext)) iconClass = 'fa-file-zipper';

        $list.append(`
            <div class="inq-attachment-tile">
                <div class="inq-attach-info">
                    <i class="fa-solid ${iconClass} inq-attach-icon" aria-hidden="true"></i>
                    <div>
                        <span class="inq-attach-name">${att.filename}</span>
                        <span class="inq-attach-size">(${sizeMb} MB)</span>
                    </div>
                </div>
                <button type="button" class="inq-attach-remove" data-idx="${idx}" aria-label="Remove attachment">
                    <i class="fa-solid fa-trash-can" aria-hidden="true"></i>
                </button>
            </div>
        `);
    });
}

// Datepicker scheduling send
function initInqSchedulePicker() {
    const el = document.getElementById('inqSchedulePicker');
    if (el && !el._flatpickr) {
        if (typeof flatpickr !== 'undefined') {
            flatpickr(el, {
                enableTime: true,
                dateFormat: "Y-m-d H:i",
                minDate: "today",
                time_24hr: true
            });
        }
    }
}

// Auto save drafts block
async function autosaveInqDraft() {
    if (!inqComposeQuill || !$('#inqComposeView').is(':visible')) return;
    const body = inqComposeQuill.root.innerHTML.trim();
    if (body === '<p><br></p>' && inqToEmails.length === 0) return;
    
    const subject = $('#inqComposeSubject').val().trim() || '(No Subject)';
    const replyTo = $('#inqComposeReplyTo').val().trim();

    const payload = {
        inquiry_id: inqActiveInquiryContext ? inqActiveInquiryContext.inquiry_id : null,
        to_emails: inqToEmails,
        cc_emails: inqCcEmails,
        bcc_emails: inqBccEmails,
        reply_to: replyTo,
        subject: subject,
        body: body,
        attachment_paths: inqAttachments,
        status: 'draft'
    };

    try {
        if (inqActiveDraftId) {
            await apiCall('/api/admin/direct-emails/' + inqActiveDraftId, 'PUT', payload);
        } else {
            const res = await apiCall('/api/admin/direct-emails', 'POST', payload);
            if (res && res.success && res.email) {
                inqActiveDraftId = res.email.id;
            }
        }
        if (currentInqFilter === 'drafts') {
            loadInquiries(false);
        }
    } catch(e) {
        console.warn('Auto-draft save failed:', e);
    }
}

// Open direct email draft / schedule send for editing
async function openDirectEmailDraft(id) {
    inqActiveDraftId = id;
    inqAttachments = [];
    inqToEmails = [];
    inqCcEmails = [];
    inqBccEmails = [];
    inqActiveInquiryContext = null;

    try {
        const res = await apiCall('/api/admin/direct-emails/' + id);
        if (res && res.success && res.email) {
            const email = res.email;
            
            $('#inqComposerTitle').html(email.status === 'scheduled' ? '<i class="fa-solid fa-clock"></i> Scheduled Email' : '<i class="fa-solid fa-pen-to-square"></i> Edit Draft');
            $('#inqComposeSubject').val(email.subject || '');
            $('#inqComposeReplyTo').val(email.reply_to || '');

            initInqComposeQuill();
            if (inqComposeQuill) {
                inqComposeQuill.root.innerHTML = email.body || '<p><br></p>';
            }

            try { inqToEmails = JSON.parse(email.to_emails || '[]'); } catch(e) { inqToEmails = [email.to_emails]; }
            try { inqCcEmails = JSON.parse(email.cc_emails || '[]'); } catch(e) { inqCcEmails = []; }
            try { inqBccEmails = JSON.parse(email.bcc_emails || '[]'); } catch(e) { inqBccEmails = []; }
            try { inqAttachments = JSON.parse(email.attachment_paths || '[]'); } catch(e) { inqAttachments = []; }

            renderRecipientChips('inqToChipsContainer', 'inqComposeToInput', inqToEmails);
            renderRecipientChips('inqCcChipsContainer', 'inqComposeCcInput', inqCcEmails);
            renderRecipientChips('inqBccChipsContainer', 'inqComposeBccInput', inqBccEmails);

            setupInqChipInput('inqToChipsContainer', 'inqComposeToInput', inqToEmails);
            setupInqChipInput('inqCcChipsContainer', 'inqComposeCcInput', inqCcEmails);
            setupInqChipInput('inqBccChipsContainer', 'inqComposeBccInput', inqBccEmails);

            if (inqCcEmails.length > 0 || inqBccEmails.length > 0 || email.reply_to) {
                $('#inqCcRow, #inqBccRow, #inqReplyToRow').show();
                $('#toggleCcBccBtn').text('Hide Cc/Bcc/Reply-To');
            } else {
                $('#inqCcRow, #inqBccRow, #inqReplyToRow').hide();
                $('#toggleCcBccBtn').text('Cc/Bcc/Reply-To');
            }

            $('#inqTemplateSelect').val('');

            renderInqAttachments();

            if (email.status === 'scheduled' && email.scheduled_at) {
                const dt = email.scheduled_at.replace('Z', '').replace('T', ' ').substring(0, 16);
                $('#inqSchedulePicker').val(dt);
                $('#inqScheduleSendRow').show();
            } else {
                $('#inqSchedulePicker').val('');
                $('#inqScheduleSendRow').hide();
            }

            if (email.inquiry_id) {
                const inqs = await apiCall('/api/admin/inquiries?limit=100'); // Check cache
                if (inqs && inqs.success && inqs.inquiries) {
                    inqActiveInquiryContext = inqs.inquiries.find(i => i.inquiry_id == email.inquiry_id);
                }
            }

            $('#inqReadView').hide();
            $('#inqComposeView').css('display', 'flex');
            openAtlDrawer('inqDetailDrawer');
            $('.inq-row').removeClass('inq-row--active');
            $(`.inq-row[data-id="${id}"]`).addClass('inq-row--active');

            initInqAttachmentUpload();
            initInqSchedulePicker();

            if (inqAutosaveTimer) clearInterval(inqAutosaveTimer);
            inqAutosaveTimer = setInterval(autosaveInqDraft, 15000);
        } else {
            window.notificationService.showError('Could not load draft details.');
        }
    } catch(e) {
        window.notificationService.showError('Draft loading failed: ' + e.message);
    }
}

// Apply templates
function applyInqTemplate(templateKey) {
    if (!inqComposeQuill) return;
    let clientName = 'there';
    if (inqActiveInquiryContext && inqActiveInquiryContext.sender_name) {
        clientName = inqActiveInquiryContext.sender_name.split(' ')[0];
    }
    
    let html = '';
    if (templateKey === 'inquiry_follow_up') {
        html = `<p>Hi ${clientName},</p><p>Thank you for reaching out to us. We have received your inquiry and would love to assist you with organizing Thabiso's performance for your upcoming event.</p><p>Could you please provide some additional details regarding the event format, location, and the expected audience size? This will help us quote accurately.</p><p>Looking forward to your reply!</p>`;
    } else if (templateKey === 'date_unavailable') {
        html = `<p>Hi ${clientName},</p><p>Thank you for considering Thabiso for your event${inqActiveInquiryContext ? ' on ' + (inqActiveInquiryContext.submitted_at ? new Date(inqActiveInquiryContext.submitted_at).toLocaleDateString() : '') : ''}.</p><p>Unfortunately, Thabiso is already booked or unavailable at that time. We appreciate your inquiry and hope we can work together on a future event!</p><p>Best regards,</p>`;
    } else if (templateKey === 'phone_call') {
        html = `<p>Hi ${clientName},</p><p>Thank you for your message. To understand your requirements and ensure Thabiso is the perfect fit, we would love to jump on a quick 10-minute phone call.</p><p>Please let us know what time works best for you this week, or call Lindelwe Xulu at +27 74 341 9681.</p><p>Best regards,</p>`;
    } else {
        html = `<p>Hi ${clientName},</p><p><br></p>`;
    }

    inqComposeQuill.root.innerHTML = html;
}

// Preview email modal
window.closeEmailPreviewModal = function() {
    $('#inqPreviewBackdrop').removeClass('active');
};

function inqCloseDetail() {
    if (inqAutosaveTimer) clearInterval(inqAutosaveTimer);
    closeAtlDrawer('inqDetailDrawer');
}

// Clear selection state whenever the reading-pane drawer closes
document.addEventListener('atl:drawerClosed', function(e) {
    if (!e.detail || e.detail.id !== 'inqDetailDrawer') return;
    currentInqId = null;
    inqActiveDraftId = null;
    if (inqAutosaveTimer) clearInterval(inqAutosaveTimer);
    $('#inqReadView').hide();
    $('#inqComposeView').hide();
    $('.inq-row').removeClass('inq-row--active');
});

// ---- Event Bindings ----

// Open message on row click (ignore clicks on the row's select checkbox)
$(document).on('click', '.inq-row', function(e) {
    if ($(e.target).is('.inq-row-check')) return;
    const id = $(this).data('id');
    if (currentInqFilter === 'drafts' || currentInqFilter === 'scheduled') {
        openDirectEmailDraft(id);
    } else {
        openInquiry(id);
    }
});
$(document).on('keydown', '.inq-row', function(e) {
    if ($(e.target).is('.inq-row-check')) return;
    if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        const id = $(this).data('id');
        if (currentInqFilter === 'drafts' || currentInqFilter === 'scheduled') {
            openDirectEmailDraft(id);
        } else {
            openInquiry(id);
        }
    }
});

// Row checkbox: select without opening the message
$(document).on('click', '.inq-row-check', function(e) { e.stopPropagation(); });
$(document).on('change', '.inq-row-check', updateInqBulkBar);

// Refresh
$('#inqRefreshBtn').on('click', function() {
    const $icon = $(this).find('i');
    $icon.addClass('fa-spin');
    loadInquiries().finally(() => setTimeout(() => $icon.removeClass('fa-spin'), 600));
});

// Compose
$('#inqComposeBtn').on('click', function() { showInqComposeView(); });
// The detail-pane buttons live in the slide-in drawer (#inqDetailDrawer), which is added to the
// DOM after this script runs, so these are delegated from document rather than bound directly.
$(document).on('click', '#inqComposeBackBtn', inqCloseDetail);
$(document).on('click', '#inqBackBtn', inqCloseDetail);
// #inqComposeDiscardBtn's own handler (below, near sendOrScheduleComposedEmail) closes the
// drawer itself once it's done — it used to ALSO have this unconditional handler bound to the
// same click, which closed the drawer immediately regardless of whether the user confirmed or
// cancelled the "discard this draft?" prompt.

// Folder filter
$(document).on('click', '.inq-folder', function(e) {
    e.preventDefault();
    currentInqFilter = $(this).data('filter');
    currentInqId = null;
    $('.inq-folder').removeClass('active').removeAttr('aria-current');
    $(this).addClass('active').attr('aria-current', 'page');
    $('#inqFolderTitle').text($(this).find('span').first().text().trim());
    $('#inqSelectAll').prop('checked', false).prop('indeterminate', false);
    inqCloseDetail();
    loadInquiries(true);
});

// Search (debounced) + Sort — both re-fetch server-side from page 1
$('#inqSearchInput').on('input', debounce(function () { loadInquiries(true); }, 300));
$('#inqSortSelect').on('change', function() { loadInquiries(true); });

// Pagination
$('#inqPrevBtn').on('click', function() { if (inqPage > 1) { inqPage--; loadInquiries(); } });
$('#inqNextBtn').on('click', function() { inqPage++; loadInquiries(); });

// About is now a tab (#inqAboutPanel); initTabs() handles switching — no JS needed here.

// ---- Bulk select + actions ----
function getSelectedInqIds() {
    return $('.inq-row-check:checked').map(function() { return $(this).data('id'); }).get();
}

function updateInqBulkBar() {
    const $checks = $('.inq-row-check');
    const checked = $checks.filter(':checked').length;
    const total = $checks.length;
    if (checked > 0) {
        $('#inqBulkCount').text(checked + ' selected');
        $('#inqBulkBar').css('display', 'flex');
    } else {
        $('#inqBulkBar').hide();
    }
    const $all = $('#inqSelectAll');
    $all.prop('indeterminate', checked > 0 && checked < total);
    $all.prop('checked', total > 0 && checked === total);
}

$('#inqSelectAll').on('change', function() {
    $('.inq-row-check').prop('checked', this.checked);
    updateInqBulkBar();
});

async function inqBulkStatus(status) {
    const ids = getSelectedInqIds();
    if (!ids.length) return;
    try {
        const res = await apiCall('/api/admin/inquiries/bulk-status', 'PUT', { ids: ids, status: status });
        if (res && res.success) {
            window.notificationService.showSuccess(res.message || (ids.length + ' message(s) updated.'));
            $('#inqSelectAll').prop('checked', false).prop('indeterminate', false);
            loadInquiries();
        }
    } catch (e) {}
}

$('#inqBulkReadBtn').on('click', function() { inqBulkStatus('read'); });
$('#inqBulkArchiveBtn').on('click', function() { inqBulkStatus('archived'); });
$('#inqBulkDeleteBtn').on('click', async function() {
    const ids = getSelectedInqIds();
    if (!ids.length) return;
    if (!(await window.notificationService.showConfirm({ message: 'Delete ' + ids.length + ' message(s) permanently? This cannot be undone.', isDestructive: true }))) return;
    try {
        const res = await apiCall('/api/admin/inquiries/bulk-delete', 'POST', { ids: ids });
        if (res && res.success) {
            window.notificationService.showSuccess(res.message || (ids.length + ' message(s) deleted.'));
            $('#inqSelectAll').prop('checked', false).prop('indeterminate', false);
            if (currentInqId && ids.map(String).includes(String(currentInqId))) inqCloseDetail();
            loadInquiries();
        }
    } catch (e) {}
});

// Reply drawer trigger
$(document).on('click', '#inqReadReplyBtn', function() {
    const inquiry = allInquiriesCache.find(i => i.inquiry_id == currentInqId);
    if (!inquiry) return;
    
    inqActiveInquiryContext = inquiry;
    const firstName = (inquiry.sender_name || '').split(' ')[0] || 'there';
    showInqComposeView({
        isReply: true,
        to: inquiry.sender_email,
        subject: 'Re: ' + (inquiry.subject || 'Your Inquiry'),
        body: `<p>Hi ${firstName},</p><p>Thank you for reaching out to us. We appreciate you taking the time to contact us.</p><p><br></p><p>Best Regards,</p><p>Thabiso Mhlongo Management</p>`
    });
});
// Archive toggle
$(document).on('click', '#inqReadArchiveBtn', async function() {
    if (!currentInqId) return;
    const inquiry = allInquiriesCache.find(i => i.inquiry_id == currentInqId);
    if (!inquiry) return;
    const newStatus = inquiry.status === 'archived' ? 'read' : 'archived';
    try {
        const res = await apiCall('/api/admin/inquiries/' + currentInqId + '/status', 'PUT', { status: newStatus });
        if (res && res.success) {
            inquiry.status = newStatus;
            $('#inqReadStatusBadge').text(inqStatusLabel(newStatus)).attr('class', 'inq-read-status-badge inq-badge ' + inqStatusBadgeClass(newStatus));
            if (newStatus === 'archived') { inqCloseDetail(); }
            loadInquiries();
        }
    } catch (e) {}
});

// Toggle read / unread from read view
$(document).on('click', '#inqReadToggleReadBtn', async function() {
    if (!currentInqId) return;
    const inquiry = allInquiriesCache.find(i => i.inquiry_id == currentInqId);
    if (!inquiry) return;
    const newStatus = inquiry.status === 'unread' ? 'read' : 'unread';
    try {
        const res = await apiCall('/api/admin/inquiries/' + currentInqId + '/status', 'PUT', { status: newStatus });
        if (res && res.success) {
            inquiry.status = newStatus;
            $('#inqReadStatusBadge').text(inqStatusLabel(newStatus)).attr('class', 'inq-read-status-badge inq-badge ' + inqStatusBadgeClass(newStatus));
            loadInquiries();
        }
    } catch (e) {}
});

// Delete from read view
$(document).on('click', '#inqReadDeleteBtn', async function() {
    if (!currentInqId) return;
    if (!(await window.notificationService.showConfirm({ message: 'Delete this message permanently? This cannot be undone.', isDestructive: true }))) return;
    try {
        await apiCall('/api/admin/inquiries/' + currentInqId, 'DELETE');
        inqCloseDetail();
        loadInquiries();
    } catch (e) {}
});

// Assign / reassign inquiry to an admin
$(document).on('change', '#inqAssignSelect', async function() {
    if (!currentInqId) return;
    const val = $(this).val();
    try {
        const res = await apiCall('/api/admin/inquiries/' + currentInqId + '/assign', 'PUT', { assigned_to: val || null });
        if (res && res.success) {
            window.notificationService.showSuccess(val ? 'Inquiry assigned.' : 'Inquiry unassigned.');
            loadInquiries();
        }
    } catch (e) {}
});

// Change priority
$(document).on('change', '#inqPrioritySelect', async function() {
    if (!currentInqId) return;
    const priority = $(this).val();
    try {
        const res = await apiCall('/api/admin/inquiries/' + currentInqId + '/priority', 'PUT', { priority });
        if (res && res.success) {
            const inquiry = allInquiriesCache.find(i => i.inquiry_id == currentInqId);
            if (inquiry) inquiry.priority = priority;
            window.notificationService.showSuccess('Priority updated.');
        }
    } catch (e) {}
});

// ---- Internal Notes ----
function renderInqNotes(notes) {
    const $list = $('#inqNotesList');
    $list.empty();
    $('#inqNotesCount').text(notes.length > 0 ? notes.length : '');
    if (!notes.length) {
        $list.html('<div class="inq-notes-empty">No internal notes yet.</div>');
        return;
    }
    notes.forEach(n => {
        const when = new Date(n.created_at).toLocaleString();
        const escapedAuthor = $('<s>').text(n.author || 'Admin').html();
        const escapedNote = $('<s>').text(n.note || '').html();
        $list.append(`
<div class="inq-note-item" data-note-id="${n.id}">
    <div class="inq-note-meta">
<span><span class="inq-note-author">${escapedAuthor}</span> · ${when}</span>
<button type="button" class="inq-note-delete" data-note-id="${n.id}" title="Delete note" aria-label="Delete note"><i class="fa-solid fa-trash" aria-hidden="true"></i></button>
    </div>
    <div class="inq-note-text">${escapedNote}</div>
</div>`);
    });
}

async function loadInqNotes(id) {
    try {
        const res = await apiCall('/api/admin/inquiries/' + id + '/notes');
        if (res && res.success) renderInqNotes(res.notes || []);
    } catch (e) {}
}

$(document).on('click', '#inqNotesToggle', function() {
    const $body = $('#inqNotesBody');
    const expanding = !$body.is(':visible');
    $body.toggle(expanding);
    $(this).attr('aria-expanded', expanding ? 'true' : 'false');
    if (expanding && currentInqId) loadInqNotes(currentInqId);
});

$(document).on('click', '#inqAddNoteBtn', async function() {
    if (!currentInqId) return;
    const note = $('#inqNoteInput').val().trim();
    if (!note) return;
    try {
        const res = await apiCall('/api/admin/inquiries/' + currentInqId + '/notes', 'POST', { note });
        if (res && res.success) {
            $('#inqNoteInput').val('');
            loadInqNotes(currentInqId);
        }
    } catch (e) {}
});

$(document).on('click', '.inq-note-delete', async function() {
    if (!currentInqId) return;
    const noteId = $(this).data('note-id');
    if (!(await window.notificationService.showConfirm({ message: 'Delete this note?', isDestructive: true }))) return;
    try {
        await apiCall('/api/admin/inquiries/' + currentInqId + '/notes/' + noteId, 'DELETE');
        loadInqNotes(currentInqId);
    } catch (e) {}
});

// Edit category / tag (saved on blur, not per-keystroke)
$(document).on('blur', '#inqCategoryInput', async function() {
    if (!currentInqId) return;
    const inquiry = allInquiriesCache.find(i => i.inquiry_id == currentInqId);
    const category = $(this).val().trim();
    if (inquiry && category === (inquiry.category || '')) return; // unchanged, skip the call
    try {
        const res = await apiCall('/api/admin/inquiries/' + currentInqId + '/category', 'PUT', { category });
        if (res && res.success) {
            if (inquiry) inquiry.category = category;
            inqCategoriesCache = null; // refreshed next time the datalist is needed
            window.notificationService.showSuccess('Category updated.');
        }
    } catch (e) {}
});

// Convert to Booking: hand off to the manual booking drawer, pre-filled from this inquiry
$(document).on('click', '#inqConvertToBookingBtn', function() {
    if (!currentInqId) return;
    const inquiry = allInquiriesCache.find(i => i.inquiry_id == currentInqId);
    if (!inquiry || typeof window.inqConvertToBooking !== 'function') return;
    window.inqConvertToBooking(inquiry);
});

$(document).on('click', '#inqConvertedLink', function(e) {
    e.preventDefault();
    switchTab('bookingsAdmin');
});

// Toggle CC/BCC/Reply-To collapse row
$(document).on('click', '#toggleCcBccBtn', function() {
    const isVisible = $('#inqCcRow').is(':visible');
    if (isVisible) {
        $('#inqCcRow, #inqBccRow, #inqReplyToRow').hide();
        $(this).text('Cc/Bcc/Reply-To');
    } else {
        $('#inqCcRow, #inqBccRow, #inqReplyToRow').show();
        $(this).text('Hide Cc/Bcc/Reply-To');
    }
});

// Templates selection trigger
$(document).on('change', '#inqTemplateSelect', function() {
    const val = $(this).val();
    if (val) {
        applyInqTemplate(val);
    }
});

// Personalization tokens bar chip click
$(document).on('click', '.inq-token-chip', function() {
    if (!inqComposeQuill) return;
    const token = $(this).data('token');
    const range = inqComposeQuill.getSelection(true);
    inqComposeQuill.insertText(range.index, token);
    inqComposeQuill.setSelection(range.index + token.length);
});

// Attachment removal delegate
$(document).on('click', '.inq-attach-remove', function() {
    const idx = $(this).data('idx');
    inqAttachments.splice(idx, 1);
    renderInqAttachments();
});

// Split send options
$(document).on('click', '#inqSendMenuToggleBtn', function(e) {
    e.stopPropagation();
    $('#inqSendDropdownMenu').toggle();
});

$(document).on('click', function() {
    $('#inqSendDropdownMenu').hide();
});

$(document).on('click', '#inqScheduleSendBtnOption', function() {
    $('#inqScheduleSendRow').show();
    $('#inqSchedulePicker').trigger('focus');
});

$(document).on('click', '#inqClearScheduleBtn', function() {
    $('#inqSchedulePicker').val('');
    $('#inqScheduleSendRow').hide();
});

// Manual Save Draft button
$(document).on('click', '#inqComposeSaveDraftBtn', async function() {
    if (inqToEmails.length === 0 && (!inqComposeQuill || inqComposeQuill.root.innerHTML.trim() === '<p><br></p>')) {
        window.notificationService.showError('Cannot save an empty draft.');
        return;
    }
    const $btn = $(this);
    $btn.prop('disabled', true).text('Saving...');
    await autosaveInqDraft();
    window.notificationService.showSuccess('Draft saved successfully.');
    $btn.prop('disabled', false).text('Save Draft');
});

// Preview rendering trigger
async function previewComposedEmail() {
    if (!inqComposeQuill) return;
    const body = inqComposeQuill.root.innerHTML;
    const subject = $('#inqComposeSubject').val().trim() || '(No Subject)';

    try {
        const res = await apiCall('/api/admin/direct-emails/preview', 'POST', {
            body,
            subject,
            inquiry_id: inqActiveInquiryContext ? inqActiveInquiryContext.inquiry_id : null
        });

        if (res && res.success && res.html) {
            const iframe = document.getElementById('inqPreviewIframe');
            const iframeDoc = iframe.contentWindow || iframe.contentDocument;
            const doc = iframeDoc.document ? iframeDoc.document : iframeDoc;
            doc.open();
            doc.write(res.html);
            doc.close();
            $('#inqPreviewBackdrop').addClass('active');
        } else {
            window.notificationService.showError('Preview generation failed.');
        }
    } catch(e) {
        window.notificationService.showError('Could not load email preview: ' + e.message);
    }
}
$(document).on('click', '#inqComposePreviewBtn', previewComposedEmail);

// Send or Schedule composed email
async function sendOrScheduleComposedEmail() {
    if (inqToEmails.length === 0) {
        window.notificationService.showError('Please add at least one recipient email address.');
        return;
    }
    const body = inqComposeQuill ? inqComposeQuill.root.innerHTML.trim() : '';
    if (!body || body === '<p><br></p>') {
        window.notificationService.showError('Please write a message before sending.');
        return;
    }

    const subject = $('#inqComposeSubject').val().trim() || '(No Subject)';
    const replyTo = $('#inqComposeReplyTo').val().trim();

    const schedPicker = $('#inqSchedulePicker').val();
    const isScheduled = $('#inqScheduleSendRow').is(':visible') && schedPicker;
    const status = isScheduled ? 'scheduled' : 'draft';
    const scheduledAt = isScheduled ? schedPicker : null;

    const payload = {
        inquiry_id: inqActiveInquiryContext ? inqActiveInquiryContext.inquiry_id : null,
        to_emails: inqToEmails,
        cc_emails: inqCcEmails,
        bcc_emails: inqBccEmails,
        reply_to: replyTo,
        subject: subject,
        body: body,
        attachment_paths: inqAttachments,
        scheduled_at: scheduledAt,
        status: status
    };

    const $btn = $('#inqComposeSendBtn');
    const origHtml = $btn.html();
    $btn.prop('disabled', true).html('<i class="fa-solid fa-spinner fa-spin"></i> Processing...');

    try {
        let draftId = inqActiveDraftId;
        if (draftId) {
            await apiCall('/api/admin/direct-emails/' + draftId, 'PUT', payload);
        } else {
            const res = await apiCall('/api/admin/direct-emails', 'POST', payload);
            if (res && res.success && res.email) {
                draftId = res.email.id;
            }
        }

        if (isScheduled) {
            window.notificationService.showSuccess('Email scheduled successfully.');
            if (inqAutosaveTimer) clearInterval(inqAutosaveTimer);
            inqCloseDetail();
            loadInquiries(true);
        } else {
            const sendRes = await apiCall('/api/admin/direct-emails/' + draftId + '/send', 'POST');
            if (sendRes && sendRes.success) {
                window.notificationService.showSuccess('Message sent successfully.');
                if (inqAutosaveTimer) clearInterval(inqAutosaveTimer);
                inqCloseDetail();
                loadInquiries(true);
            } else {
                window.notificationService.showError('Sending failed. Saved as draft.');
            }
        }
    } catch(e) {
        window.notificationService.showError('Failed: ' + e.message);
    }
    $btn.prop('disabled', false).html(origHtml);
}
$(document).off('click', '#inqComposeSendBtn').on('click', '#inqComposeSendBtn', sendOrScheduleComposedEmail);

// Discard / Delete draft button click
$(document).on('click', '#inqComposeDiscardBtn', async function() {
    if (inqActiveDraftId) {
        if (confirm('Are you sure you want to discard this draft?')) {
            try {
                await apiCall('/api/admin/direct-emails/' + inqActiveDraftId, 'DELETE');
                window.notificationService.showSuccess('Draft discarded.');
                inqCloseDetail();
                loadInquiries(true);
            } catch(e) {
                window.notificationService.showError('Could not discard draft.');
            }
        }
    } else {
        inqCloseDetail();
    }
});
