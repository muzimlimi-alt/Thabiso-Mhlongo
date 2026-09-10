/* Phase 6 (HOUSEKEEPING-NOTES.md): relocated from admin.html verbatim — Audit Log Logic
   (auditState, loadAuditLogs, pagination/sort, diff-rendering) + POPIA Requests Logic
   (popiaState, loadPopiaRequests, approve/reject/process/complete-anonymization, the request
   detail drawer, the "Anonymize Now" drawer, CSV export). This code sat in the middle of the
   large initFinanceManagement(...) closure (the same one Services/Policies/Branding came
   from), with zero cross-reference either direction (verified via grep) except two things
   explicitly NOT moved: a "Global Upload Zone Logic" drag-drop handler immediately after this
   block (shared across multiple sections — a Phase 7 "Shared candidate") and "Session Expiry
   Monitoring" right after that (global admin-app session timeout, not specific to this tab).
   Per the Email Logs / Services+Policies fix, the enclosing <script> tag is NOT split here —
   the code before this block and the Global Upload Zone Logic after it are reunited directly,
   and this file's <script src> tag sits before the whole initFinanceManagement block instead,
   alongside services.js/policies.js/branding.js.

   window.loadAuditLogs/loadPopiaRequests/debouncePopiaSearch/popiaExportCsv were already
   window-attached in the original source. auditState and popiaState were NOT — both are
   referenced bare from inline onclick/onchange attributes in the markup
   (auditState.page=1;loadAuditLogs() on the Audit Log Search button;
   popiaState.page=1;loadPopiaRequests() on every POPIA filter/search control), and — being
   closure-scoped, unreachable from inline-attribute global scope — those controls have almost
   certainly thrown ReferenceError silently for as long as this code has existed, discovered and
   confirmed with the user before this extraction. window.auditState = auditState and
   window.popiaState = popiaState are added below (same object reference, so this file's own
   internal mutations and the exposed global stay in sync) — the user explicitly chose to let
   this incidentally fix the Search/filter controls as part of this move, not silently. */

// --- Audit Log Logic ---
let auditState = { page: 1, limit: 50, search: '', sort: 'change_timestamp', order: 'DESC' };
window.auditState = auditState;

// Friendly Section labels for audit_log.table_name. Previously this was a broken 3-bucket guess
// (bookings -> "Bookings", users -> "Security" — but the actual table is "admins", so that branch
// never matched — everything else silently fell through to "Events", mislabeling invoices,
// transactions, quotations, gallery_images, etc.). Anything not explicitly listed here is
// humanized from its raw table_name instead of guessed into an unrelated bucket.
const AUDIT_TABLE_LABELS = {
    bookings: 'Bookings', admins: 'Users', events: 'Events', date_holds: 'Calendar',
    gallery_images: 'Gallery', inquiries: 'Inquiries', invoices: 'Invoices',
    transactions: 'Financials', cancellations: 'Cancellations', quotations: 'Quotations',
    contracts: 'Contracts', payment_schedules: 'Payment Schedules', expenses: 'Expenses',
    services: 'Services', clients: 'Clients',
    popia_erasure_requests: 'POPIA Erasure', popia_verification_codes: 'POPIA Verification',
    career_highlights: 'Career', home_slider: 'Home Slider', testimonials: 'Testimonials',
    footprint_countries: 'Footprint', about_me: 'About Me'
};
function auditSectionLabel(tableName) {
    if (AUDIT_TABLE_LABELS[tableName]) return AUDIT_TABLE_LABELS[tableName];
    return String(tableName || '—').replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

// snake_case/camelCase column name -> readable label ("total_amount" -> "Total Amount").
function prettyFieldKey(k) {
    return String(k || '').replace(/_/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/\b\w/g, c => c.toUpperCase());
}
function formatAuditFieldValue(v) {
    if (v === null || v === undefined || v === '') return '—';
    if (typeof v === 'object') { try { return JSON.stringify(v); } catch (e) { return String(v); } }
    var s = String(v);
    // Rich-text fields (e.g. About Me's Quill paragraphs) store raw HTML - show the plain text
    // in the diff instead of a wall of visible tags and inline styles.
    if (/<[a-z][\s\S]*>/i.test(s)) {
        s = s.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
    }
    return s;
}

// Renders the actual field-level diff for one audit_log row — what changed, not just that a
// change happened. UPDATE rows compare old_values -> new_values field-by-field (both are JSON
// snapshots the DB trigger or logAudit() wrote at save time — only the columns each writer
// captures are diffable, so coverage varies by table); CREATE/DELETE rows have only one side, so
// they show the record's field values at that moment instead of a before/after pair.
function buildAuditDiffHtml(log) {
    let ov = null, nv = null;
    try { if (log.old_values) ov = JSON.parse(log.old_values); } catch (e) {}
    try { if (log.new_values) nv = JSON.parse(log.new_values); } catch (e) {}
    const action = String(log.action || '').toUpperCase();

    let rows = [];
    if (ov && nv) {
        rows = Object.keys(nv)
            .filter(k => JSON.stringify(nv[k]) !== JSON.stringify(ov[k]))
            .map(k => ({ key: k, from: ov[k], to: nv[k], isDiff: true }));
    } else if (nv && (action === 'CREATE' || action === 'INSERT')) {
        rows = Object.keys(nv).map(k => ({ key: k, to: nv[k], isDiff: false }));
    } else if (ov && !nv) {
        rows = Object.keys(ov).map(k => ({ key: k, to: ov[k], isDiff: false }));
    }
    if (!rows.length) return '';

    const rowsHtml = rows.map(r => {
        const label = window.escHtml(prettyFieldKey(r.key));
        const toVal = window.escHtml(formatAuditFieldValue(r.to));
        const valueHtml = r.isDiff
            ? '<s style="opacity:0.55;">' + window.escHtml(formatAuditFieldValue(r.from)) + '</s> <i class="fa-solid fa-arrow-right" style="font-size:8px; opacity:0.5;"></i> <strong style="color:var(--atl-ink);">' + toVal + '</strong>'
            : '<strong style="color:var(--atl-ink);">' + toVal + '</strong>';
        return '<div style="display:flex; justify-content:space-between; gap:10px; padding:3px 0; font-size:11px;">' +
            '<span style="color:var(--atl-muted-dim); flex-shrink:0;">' + label + '</span>' +
            '<span style="color:var(--atl-muted); text-align:right; word-break:break-word;">' + valueHtml + '</span>' +
            '</div>';
    }).join('');

    return '<div style="margin-top:6px; padding:8px 10px; background:var(--atl-input-bg); border-radius:6px;">' + rowsHtml + '</div>';
}

// Shared per-record "Change History" card — reuses the same GET /api/admin/audit_log endpoint
// the global Audit Trail list uses (table + record_id filter), so there's exactly one place that
// reads audit_log. Used by Bookings (Deal View's Timeline & Notes tab, alongside — not replacing —
// its existing business-lifecycle Activity timeline), Events, and Users.
window.loadChangeHistoryCard = async function(containerId, tableName, recordId) {
    const el = qs('#' + containerId);
    if (!el) return;
    if (!recordId) { el.innerHTML = '<div style="padding:6px 0; font-size:12px; color:var(--atl-muted);">No change history yet.</div>'; return; }
    el.innerHTML = '<div style="padding:6px 0; font-size:12px; color:var(--atl-muted);"><i class="fa fa-spinner fa-spin"></i> Loading history…</div>';
    try {
        const res = await fetch('/api/admin/audit_log?table=' + encodeURIComponent(tableName) + '&record_id=' + encodeURIComponent(recordId) + '&limit=20', { credentials: 'include' });
        const data = await res.json();
        if (!data || !data.success || !data.logs || !data.logs.length) {
            el.innerHTML = '<div style="padding:6px 0; font-size:12px; color:var(--atl-muted);">No change history recorded yet.</div>';
            return;
        }
        el.innerHTML = data.logs.map(function(log) {
            const actorName = log.actor_full_name || log.actor_username || log.changed_by || 'System';
            const actorRole = log.actor_role ? (log.actor_role.charAt(0).toUpperCase() + log.actor_role.slice(1)) : '';
            const when = log.change_timestamp ? new Date(log.change_timestamp).toLocaleString('en-ZA') : '—';
            return '<div style="padding:8px 0; border-bottom:1px solid var(--atl-line);">' +
                '<div style="display:flex; justify-content:space-between; gap:8px; font-size:12px;">' +
                '<strong style="color:var(--atl-ink);">' + window.escHtml(String(log.action || '').toUpperCase()) + '</strong>' +
                '<span style="color:var(--atl-muted-dim); font-size:10.5px; white-space:nowrap;">' + when + '</span>' +
                '</div>' +
                '<div style="font-size:11.5px; color:var(--atl-muted); margin-top:2px;">' +
                window.escHtml(actorName) + (actorRole ? ' (' + window.escHtml(actorRole) + ')' : '') +
                '</div>' +
                buildAuditDiffHtml(log) +
            '</div>';
        }).join('');
    } catch (e) {
        el.innerHTML = '<div style="padding:6px 0; font-size:12px; color:var(--atl-clay);">Could not load change history.</div>';
    }
};

/* Phase 7 Component 1 (HOUSEKEEPING-NOTES.md "#3"): loadAuditLogs is now a DataTable instance.
   auditState (+ window.auditState) / toggleAuditSort / updateAuditSortIcons and every audit helper
   above are UNCHANGED; renderAuditPagination is now a Pagination instance ("A2"), debounceAuditSearch
   uses the shared debounce() ("FilterBar").
   window.DataTable comes from js/admin/components/data-table.js (loaded before this file). */
const auditLogsTable = new DataTable({
    body:  '#auditLogsBody',
    table: null,
    colspan: 7,
    stats: { el: '#auditStats', format: 'X-Y', noun: 'entries', emptyText: 'Showing 0 of 0 entries' },
    states: {
        loading: { idiom: 'row-html', html: '<tr><td colspan="7" class="text-center" style="padding: 30px; opacity: 0.5;"><i class="fa fa-spinner fa-spin"></i> Refreshing trail...</td></tr>' },
        empty:   { idiom: 'row-component', icon: 'fa-solid fa-clipboard-list',       iconOpacity: 0.4, message: 'No audit events found',        subMessage: 'Try adjusting your search or filters.' },
        error:   { idiom: 'row-component', icon: 'fa-solid fa-triangle-exclamation', iconOpacity: 0.6, message: 'Could not load the audit trail', subMessage: 'Please try again.' }
    },
    server: {
        pageSize: 50,
        fetch: async function () {
            const tableF   = (qs('#auditTableFilter') && qs('#auditTableFilter').value) || '';
            const dateFrom = (qs('#auditDateFrom')   && qs('#auditDateFrom').value)   || '';
            const dateTo   = (qs('#auditDateTo')     && qs('#auditDateTo').value)     || '';
            const params = new URLSearchParams({ page: auditState.page, limit: auditState.limit, sort: auditState.sort, order: auditState.order });
            if (auditState.search) params.set('search', auditState.search);
            if (tableF)   params.set('table', tableF);
            if (dateFrom) params.set('date_from', dateFrom);
            if (dateTo)   params.set('date_to', dateTo);
            let res;
            try {
                const response = await fetch('/api/admin/audit_log?' + params.toString(), { credentials: 'include' });
                if (response.status === 401) return DataTable.ABORT;   // original: bare `return` (loading row stays)
                res = await response.json();
            } catch (e) {
                console.error("Audit Log Error:", e);
                if (window.notificationService) window.notificationService.showError('Could not load the audit trail. Please try again.');
                throw e;                                               // -> component .catch -> states.error
            }
            updateAuditSortIcons();                                    // mirrors original: ran right after response.json(), before the success gate
            if (res && res.success && res.logs) {
                return { rows: res.logs, total: parseInt(res.total) || 0, totalPages: parseInt(res.totalPages) || 0 };
            }
            return DataTable.ABORT;                                    // res exists but not success -> original left the loading row up
        }
    },
    renderRow: function (log) {
        const date = new Date(log.change_timestamp || log.timestamp).toLocaleString();
        const actionColor = log.action === 'UPDATE' ? 'var(--atl-orange)' : (log.action === 'INSERT' ? 'var(--atl-sage)' : 'var(--atl-clay)');
        const actorName = log.actor_full_name || log.actor_username || log.changed_by || '—';
        const actorRole = log.actor_role ? (log.actor_role.charAt(0).toUpperCase() + log.actor_role.slice(1)) : '—';
        const cells = `
                    <td style="padding:12px; font-weight:bold; color: var(--atl-amber);">${escHtml(log.table_name)} <span style="font-size:10px; opacity:0.5; font-weight:normal;">#${log.record_id}</span></td>
                    <td style="padding:12px; font-size:12px;">${escHtml(auditSectionLabel(log.table_name))}</td>
                    <td style="padding:12px;"><span style="color:${actionColor}; font-weight:bold; font-size:11px;">${escHtml(log.action)}</span></td>
                    <td style="padding:12px; font-size:12px;">${escHtml(actorName)}</td>
                    <td style="padding:12px; font-size:11px; opacity:0.75;">${escHtml(actorRole)}</td>
                    <td style="padding:12px; font-size:11px; opacity:0.6; font-family:'JetBrains Mono',monospace;">${escHtml(log.ip_address || '—')}</td>
                    <td style="padding:12px; font-size:11px; opacity:0.6;">${date}</td>
                `;
        return '<tr>' + cells + '</tr>';
    },
    rowDecorate: function (tr) { tr.style.borderBottom = '1px solid rgba(255,255,255,0.02)'; },
    onRender:   function () { updateAuditSortIcons(); },
    pagination: function (info) { renderAuditPagination(info.totalPages); }
});

window.loadAuditLogs = function () { return auditLogsTable.setPage(auditState.page); };

/* Phase 7 Component 2 ("A2"): renderAuditPagination -> Pagination instance (standard variant). */
var auditPager = new Pagination({
    mode: 'numbered',
    container: '#auditPagination',
    getPage: function () { return auditState.page; },
    onGoto: function (n) { auditState.page = n; loadAuditLogs(); }
});
function renderAuditPagination(totalPages) { return auditPager.render(totalPages); }

window.toggleAuditSort = function(col) {
    if (auditState.sort === col) { auditState.order = auditState.order === 'ASC' ? 'DESC' : 'ASC'; }
    else { auditState.sort = col; auditState.order = 'DESC'; }
    auditState.page = 1;
    loadAuditLogs();
};

function updateAuditSortIcons() {
    qsa('#auditSortHeaders i').forEach(icon => { icon.className = 'fa-solid fa-sort'; icon.style.opacity = '0.4'; });
    qsa('#auditSortHeaders th[aria-sort]').forEach(th => th.setAttribute('aria-sort', 'none'));
    const active = qs('#auditsort-' + auditState.sort);
    if (active) {
        active.className = auditState.order === 'ASC' ? 'fa-solid fa-sort-up' : 'fa-solid fa-sort-down';
        active.style.opacity = '1';
        const th = active.closest('th');
        if (th) th.setAttribute('aria-sort', auditState.order === 'ASC' ? 'ascending' : 'descending');
    }
}

window.debounceAuditSearch = debounce(function () { auditState.search = (qs('#auditSearch') || {}).value || ''; auditState.page = 1; loadAuditLogs(); }, 400);

// --- POPIA Data Erasure Request Management ---
let popiaState = { page: 1, limit: 20, search: '', status: '', source: '', dateFrom: '', dateTo: '' };
window.popiaState = popiaState;

const POPIA_REASON_LABELS = {
    no_longer_a_client: 'No longer a client',
    privacy_concerns: 'Privacy concerns',
    no_longer_wish_to_be_contacted: 'No longer wishes to be contacted',
    duplicate_or_test_submission: 'Duplicate/test submission',
    incorrect_information_on_file: 'Incorrect information on file',
    other: 'Other'
};
const POPIA_STATUS_BADGE = {
    pending: 'atl-badge--pending', approved: 'atl-badge--accepted', processing: 'atl-badge--warning',
    awaiting_refund: 'atl-badge--info', processed: 'atl-badge--confirmed', rejected: 'atl-badge--cancelled', failed: 'atl-badge--cancelled'
};

async function popiaFetch(url, method, body) {
    const opts = { method: method || 'GET', credentials: 'include' };
    if (body) { opts.headers = { 'Content-Type': 'application/json' }; opts.body = JSON.stringify(body); }
    const r = await fetch(url, opts);
    const d = await r.json().catch(() => ({}));
    if (!r.ok || d.success === false) throw new Error(d.message || 'Request failed.');
    return d;
}

function popiaQueryParams() {
    const p = new URLSearchParams({ page: popiaState.page, limit: popiaState.limit });
    if (popiaState.search) p.set('search', popiaState.search);
    if (popiaState.status) p.set('status', popiaState.status);
    if (popiaState.source) p.set('source', popiaState.source);
    if (popiaState.dateFrom) p.set('date_from', popiaState.dateFrom);
    if (popiaState.dateTo) p.set('date_to', popiaState.dateTo);
    return p;
}

/* Phase 7 Component 1 (HOUSEKEEPING-NOTES.md "#4"): loadPopiaRequests is now a DataTable instance.
   popiaState (+ window.popiaState) / popiaQueryParams / renderPopiaRow / updatePopiaPendingBadge and
   the drawer fns are UNCHANGED; renderPopiaPagination is now a Pagination instance ("A3"),
   debouncePopiaSearch uses the shared debounce() ("FilterBar").
   window.DataTable comes from js/admin/components/data-table.js (loaded before this file). */
const popiaRequestsTable = new DataTable({
    body:  '#popiaRequestsBody',
    table: null,
    colspan: 7,
    stats: { el: '#popiaStats', format: 'X-Y', noun: 'entries' },   // no emptyText: 0-rows falls through to "Showing 0-0 of 0 entries"
    states: {
        loading: { idiom: 'row-html', html: '<tr><td colspan="7" class="text-center" style="padding: 30px; opacity: 0.5;"><i class="fa fa-spinner fa-spin"></i> Loading requests...</td></tr>' },
        empty:   { idiom: 'row-component', icon: 'fa-solid fa-user-slash',           iconOpacity: 0.4, message: 'No erasure requests found',   subMessage: 'Try adjusting your search or filters.' },
        error:   { idiom: 'row-component', icon: 'fa-solid fa-triangle-exclamation', iconOpacity: 0.6, message: 'Could not load erasure requests', subMessage: 'Please try again.' }
    },
    server: {
        pageSize: 20,
        fetch: async function () {
            popiaState.status = (qs('#popiaStatusFilter') || {}).value || '';
            popiaState.source = (qs('#popiaSourceFilter') || {}).value || '';
            popiaState.dateFrom = (qs('#popiaDateFrom') || {}).value || '';
            popiaState.dateTo = (qs('#popiaDateTo') || {}).value || '';
            let res;
            try {
                const response = await fetch('/api/admin/popia/requests?' + popiaQueryParams().toString(), { credentials: 'include' });
                if (response.status === 401) return DataTable.ABORT;   // original: bare `return` (loading row stays)
                res = await response.json();
            } catch (e) {
                console.error('POPIA Requests Error:', e);
                throw e;                                               // -> component .catch -> states.error (no showError, matching the original catch)
            }
            if (res && res.success) {
                return { rows: res.requests || [], total: parseInt(res.total) || 0, totalPages: parseInt(res.totalPages) || 0 };
            }
            return DataTable.ABORT;                                    // res exists but not success -> original left the loading row up
        }
    },
    renderRow:  function (r)    { return renderPopiaRow(r).outerHTML; },
    onRender:   function ()     { updatePopiaPendingBadge(); },
    pagination: function (info) { renderPopiaPagination(info.totalPages); }
});

window.loadPopiaRequests = function () { return popiaRequestsTable.setPage(popiaState.page); };

function renderPopiaRow(r) {
    const tr = document.createElement('tr');
    tr.style.borderBottom = '1px solid rgba(255,255,255,0.02)';
    const badgeClass = POPIA_STATUS_BADGE[r.status] || 'atl-badge--info';
    const reasonLabel = POPIA_REASON_LABELS[r.reason] || r.reason;
    const date = r.requested_at ? new Date(r.requested_at).toLocaleString() : '';
    let actions = '<button type="button" class="atl-btn atl-btn--ghost popia-view-btn" data-id="' + r.id + '" title="View"><i class="fa-solid fa-eye"></i></button>';
    if (r.status === 'pending') {
        actions += '<button type="button" class="atl-btn atl-btn--ghost popia-approve-btn" data-id="' + r.id + '" title="Approve" style="color:#34d399;"><i class="fa-solid fa-check"></i></button>'
                 + '<button type="button" class="atl-btn atl-btn--ghost popia-view-btn" data-id="' + r.id + '" title="Reject (opens review)" style="color:#f87171;"><i class="fa-solid fa-xmark"></i></button>';
    } else if (r.status === 'approved') {
        actions += '<button type="button" class="atl-btn atl-btn--ghost popia-process-btn" data-id="' + r.id + '" title="Process — Anonymize Now" style="color:var(--atl-clay);"><i class="fa-solid fa-user-slash"></i></button>';
    }
    tr.innerHTML = ''
        + '<td style="padding:12px; font-weight:bold; color: var(--atl-amber); font-family:\'JetBrains Mono\',monospace; font-size:11px;">' + escHtml(r.reference_number || '—') + '</td>'
        + '<td style="padding:12px; font-size:12px;">' + escHtml(r.email) + '</td>'
        + '<td style="padding:12px; font-size:12px;">' + escHtml(reasonLabel) + '</td>'
        + '<td style="padding:12px; font-size:12px; text-transform:capitalize;">' + escHtml(r.source) + '</td>'
        + '<td style="padding:12px;"><span class="atl-badge ' + badgeClass + '">' + escHtml(r.status) + '</span></td>'
        + '<td style="padding:12px; font-size:11px; opacity:0.7;">' + date + '</td>'
        + '<td style="padding:12px; text-align:right; white-space:nowrap;">' + actions + '</td>';
    return tr;
}

/* Phase 7 Component 2 ("A3"): renderPopiaPagination -> Pagination instance (standard variant). */
var popiaPager = new Pagination({
    mode: 'numbered',
    container: '#popiaPagination',
    getPage: function () { return popiaState.page; },
    onGoto: function (n) { popiaState.page = n; loadPopiaRequests(); }
});
function renderPopiaPagination(totalPages) { return popiaPager.render(totalPages); }

window.debouncePopiaSearch = debounce(function () { popiaState.search = (qs('#popiaSearch') || {}).value || ''; popiaState.page = 1; loadPopiaRequests(); }, 400);

async function updatePopiaPendingBadge() {
    try {
        const r = await fetch('/api/admin/popia/requests?status=pending&limit=1', { credentials: 'include' });
        const d = await r.json();
        const badge = qs('#popiaPendingBadge');
        if (!badge) return;
        const total = parseInt(d && d.total) || 0;
        if (total > 0) { badge.style.display = 'inline-flex'; badge.textContent = total + ' pending'; }
        else { badge.style.display = 'none'; }
    } catch (e) {}
}

async function openPopiaRequestDrawer(id) {
    const bodyEl = qs('#popiaRequestDrawerBody');
    bodyEl.innerHTML = '<div style="text-align:center; padding:40px 0; opacity:0.6;"><i class="fa fa-spinner fa-spin"></i> Loading…</div>';
    openAtlDrawer('popiaRequestDrawer');
    try {
        const res = await popiaFetch('/api/admin/popia/requests/' + id);
        const r = res.request, preview = res.preview;
        const bookingImpact = res.booking_impact || [];
        const pendingRefundBookingIds = res.pending_refund_booking_ids || [];
        const badgeClass = POPIA_STATUS_BADGE[r.status] || 'atl-badge--info';
        const reasonLabel = POPIA_REASON_LABELS[r.reason] || r.reason;
        let affected = null;
        try { affected = r.affected_tables_json ? JSON.parse(r.affected_tables_json) : null; } catch (e2) {}

        let html = ''
            + '<div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:16px;">'
            + '<span style="font-family:\'JetBrains Mono\',monospace; font-size:13px; color:var(--atl-amber);">' + escHtml(r.reference_number || '—') + '</span>'
            + '<span class="atl-badge ' + badgeClass + '">' + escHtml(r.status) + '</span></div>'
            + '<div class="um-field-group"><label class="um-label">Email</label><div style="font-size:14px;">' + escHtml(r.email) + '</div></div>'
            + '<div class="um-field-group"><label class="um-label">Reason</label><div style="font-size:13px;">' + escHtml(reasonLabel) + (r.reason === 'other' && r.reason_other_text ? ' — ' + escHtml(r.reason_other_text) : '') + '</div></div>'
            + (r.additional_comments ? '<div class="um-field-group"><label class="um-label">Additional Comments</label><div style="font-size:13px; white-space:pre-wrap;">' + escHtml(r.additional_comments) + '</div></div>' : '')
            + '<div class="um-field-group"><label class="um-label">Source</label><div style="font-size:13px; text-transform:capitalize;">' + escHtml(r.source) + ' &middot; ' + (r.requested_ip ? escHtml(r.requested_ip) : 'IP not recorded') + '</div></div>'
            + '<div class="um-field-group"><label class="um-label">Requested</label><div style="font-size:13px;">' + (r.requested_at ? new Date(r.requested_at).toLocaleString() : '—') + '</div></div>'
            + (r.reviewed_at ? '<div class="um-field-group"><label class="um-label">Reviewed</label><div style="font-size:13px;">' + new Date(r.reviewed_at).toLocaleString() + ' by ' + escHtml(r.reviewed_by_name || '—') + (r.review_notes ? '<br><span style="opacity:0.8;">' + escHtml(r.review_notes) + '</span>' : '') + '</div></div>' : '')
            + (r.processed_at ? '<div class="um-field-group"><label class="um-label">Processed</label><div style="font-size:13px;">' + new Date(r.processed_at).toLocaleString() + ' by ' + escHtml(r.processed_by_name || '—') + '</div></div>' : '')
            + (r.error_message ? '<div class="um-field-group"><label class="um-label" style="color:var(--atl-clay);">Error</label><div style="font-size:12px; color:var(--atl-clay);">' + escHtml(r.error_message) + '</div></div>' : '')
            + '<hr class="um-divider">'
            + '<div class="um-field-group"><label class="um-label">' + (affected ? 'Records Anonymized' : 'Records That Will Be Affected') + '</label>'
            + '<div style="display:grid; grid-template-columns:1fr 1fr; gap:6px 16px; font-size:12px;">'
            + Object.entries(affected || preview || {}).map(function(entry) {
                return '<div style="display:flex; justify-content:space-between; border-bottom:1px dashed var(--atl-line); padding-bottom:2px;"><span style="color:var(--atl-muted);">' + escHtml(entry[0].replace(/_/g, ' ')) + '</span><span style="font-weight:600;">' + entry[1] + '</span></div>';
            }).join('')
            + '</div></div>';

        if (bookingImpact.length) {
            html += ''
                + '<hr class="um-divider">'
                + '<div class="um-field-group"><label class="um-label" style="color:var(--atl-clay);">Booking Impact' + (r.status === 'awaiting_refund' ? ' — cancelled, refund status' : ' — will be cancelled on Process') + '</label>'
                + bookingImpact.map(function(b) {
                    const blocked = pendingRefundBookingIds.indexOf(b.booking_id) !== -1;
                    const hasRefundedFigure = b.refunded_so_far !== undefined;
                    const refundLine = hasRefundedFigure
                        ? 'Refunded so far: R ' + parseFloat(b.refunded_so_far || 0).toFixed(2) + ' / R ' + parseFloat(b.estimated_refund_due || 0).toFixed(2) + ' due'
                        : 'Est. refund due: R ' + parseFloat(b.estimated_refund_due || 0).toFixed(2);
                    return '<div style="border:1px solid ' + (blocked ? 'var(--atl-clay)' : 'var(--atl-line)') + '; border-radius:8px; padding:10px 12px; margin-top:8px; font-size:12px;">'
                        + '<div style="display:flex; justify-content:space-between; font-weight:600;"><span>#' + b.booking_id + ' — ' + escHtml(b.event_name || b.event_type || 'Event') + '</span><span>' + escHtml(b.date || '') + '</span></div>'
                        + (b.policy_rule ? '<div style="color:var(--atl-muted); margin-top:4px;">' + escHtml(b.policy_rule) + '</div>' : '')
                        + '<div style="display:flex; justify-content:space-between; margin-top:6px;"><span>Amount paid: R ' + parseFloat(b.amount_paid || 0).toFixed(2) + '</span><span style="color:var(--atl-clay); font-weight:600;">' + refundLine + '</span></div>'
                        + (blocked ? '<div style="color:var(--atl-clay); margin-top:6px;"><i class="fa-solid fa-triangle-exclamation"></i> Blocking anonymization until this refund is recorded</div>' : '')
                        + '</div>';
                }).join('')
                + '</div>';
        }

        if (r.status === 'awaiting_refund') {
            html += '<div class="um-form-actions" style="justify-content:flex-end; gap:10px; margin-top:12px;">'
                + '<button type="button" class="atl-btn" style="background:var(--atl-clay); color:#fff; border:none;" id="popiaCompleteBtn"' + (pendingRefundBookingIds.length ? ' disabled title="Record the refund(s) above via that booking\'s Deal View first"' : '') + '><i class="fa-solid fa-user-slash"></i> Complete Anonymization</button></div>';
        } else if (r.status === 'pending') {
            html += ''
                + '<hr class="um-divider">'
                + '<div class="um-field-group"><label class="um-label" for="popiaReviewNotes">Review Notes (required to reject)</label>'
                + '<textarea id="popiaReviewNotes" class="um-input" rows="2" placeholder="Reason for approval/rejection"></textarea></div>'
                + '<div class="um-form-actions" style="justify-content:flex-end; gap:10px;">'
                + '<button type="button" class="atl-btn" style="background:#f87171; color:#111; border:none;" id="popiaRejectBtn"><i class="fa-solid fa-xmark"></i> Reject</button>'
                + '<button type="button" class="atl-btn" style="background:#34d399; color:#111; border:none;" id="popiaApproveBtn"><i class="fa-solid fa-check"></i> Approve</button>'
                + '</div>';
        } else if (r.status === 'approved') {
            html += '<div class="um-form-actions" style="justify-content:flex-end; gap:10px;">'
                + '<button type="button" class="atl-btn" style="background:var(--atl-clay); color:#fff; border:none;" id="popiaProcessBtn"><i class="fa-solid fa-user-slash"></i> Process — Anonymize Now</button></div>';
        }

        bodyEl.innerHTML = html;

        const approveBtn = qs('#popiaApproveBtn');
        if (approveBtn) approveBtn.addEventListener('click', async function() {
            if (!await window.notificationService.showConfirm({ title: 'Approve Erasure Request', message: 'Approve this request for ' + r.email + '? You will still need to Process it separately to anonymize the data.' })) return;
            await popiaApprove(r.id);
        });
        const rejectBtn = qs('#popiaRejectBtn');
        if (rejectBtn) rejectBtn.addEventListener('click', async function() {
            const notes = (qs('#popiaReviewNotes') || {}).value || '';
            if (!notes.trim()) { window.notificationService.showError('Please add review notes before rejecting.'); return; }
            if (!await window.notificationService.showConfirm({ title: 'Reject Erasure Request', message: 'Reject this request for ' + r.email + '?', isDestructive: true })) return;
            await popiaReject(r.id, notes);
        });
        const processBtn = qs('#popiaProcessBtn');
        if (processBtn) processBtn.addEventListener('click', async function() {
            if (!await window.notificationService.showConfirm({ title: 'Process Erasure Request', message: 'WARNING: This will permanently anonymize all personal data for ' + r.email + '. Financial records are retained. This cannot be undone. Proceed?', isDestructive: true })) return;
            await popiaProcess(r.id);
        });
        const completeBtn = qs('#popiaCompleteBtn');
        if (completeBtn) completeBtn.addEventListener('click', async function() {
            if (!await window.notificationService.showConfirm({ title: 'Complete Anonymization', message: 'WARNING: This will permanently anonymize all personal data for ' + r.email + '. This cannot be undone. Proceed?', isDestructive: true })) return;
            await popiaCompleteAnonymization(r.id);
        });
    } catch (e) {
        bodyEl.innerHTML = '<div class="atl-empty-state"><i class="fa-solid fa-triangle-exclamation" style="font-size:28px; color:var(--atl-clay);"></i><p class="atl-empty-display">Could not load request</p></div>';
    }
}

async function popiaApprove(id) {
    try {
        await popiaFetch('/api/admin/popia/requests/' + id + '/approve', 'PUT');
        window.notificationService.showSuccess('Request approved.');
        closeAtlDrawer('popiaRequestDrawer');
        loadPopiaRequests();
    } catch (e) { window.notificationService.showError(e.message); }
}
async function popiaReject(id, notes) {
    try {
        await popiaFetch('/api/admin/popia/requests/' + id + '/reject', 'PUT', { review_notes: notes });
        window.notificationService.showSuccess('Request rejected.');
        closeAtlDrawer('popiaRequestDrawer');
        loadPopiaRequests();
    } catch (e) { window.notificationService.showError(e.message); }
}
async function popiaProcess(id) {
    try {
        const res = await popiaFetch('/api/admin/popia/requests/' + id + '/process', 'POST');
        window.notificationService.showSuccess(res.awaiting_refund
            ? 'Booking cancelled — a refund is now owing. Record it, then complete anonymization.'
            : 'Data anonymized successfully.');
        closeAtlDrawer('popiaRequestDrawer');
        loadPopiaRequests();
    } catch (e) { window.notificationService.showError(e.message); }
}
async function popiaCompleteAnonymization(id) {
    try {
        await popiaFetch('/api/admin/popia/requests/' + id + '/complete-anonymization', 'POST');
        window.notificationService.showSuccess('Refund resolved — data anonymized successfully.');
        closeAtlDrawer('popiaRequestDrawer');
        loadPopiaRequests();
    } catch (e) { window.notificationService.showError(e.message); }
}

window.popiaExportCsv = function() {
    const p = popiaQueryParams();
    p.delete('page'); p.delete('limit');
    window.open('/api/admin/popia/requests/export?' + p.toString(), '_blank');
};

$(document).on('click', '.popia-view-btn', function() { openPopiaRequestDrawer($(this).data('id')); });
$(document).on('click', '.popia-approve-btn', async function() {
    const id = $(this).data('id');
    if (!await window.notificationService.showConfirm({ title: 'Approve Erasure Request', message: 'Approve this request? You will still need to Process it separately to anonymize the data.' })) return;
    await popiaApprove(id);
});
$(document).on('click', '.popia-process-btn', async function() {
    const id = $(this).data('id');
    if (!await window.notificationService.showConfirm({ title: 'Process Erasure Request', message: 'WARNING: This will permanently anonymize all personal data for this client. Financial records are retained. This cannot be undone. Proceed?', isDestructive: true })) return;
    await popiaProcess(id);
});
$(document).on('click', '#popiaRequestDrawerClose, #popiaRequestDrawerBackdrop', function() {
    closeAtlDrawer('popiaRequestDrawer');
});

// --- POPIA "Anonymize Now" (admin-initiated create + immediate process) ---
$(document).on('click', '#popiaAnonymizeNowCancelBtn, #popiaAnonymizeNowDrawerClose, #popiaAnonymizeNowDrawerBackdrop', function() {
    closeAtlDrawer('popiaAnonymizeNowDrawer');
});
$(document).on('submit', '#popiaAnonymizeNowForm', async function(e) {
    e.preventDefault();
    const emailEl = qs('#popiaAnonEmail');
    const email = (emailEl && emailEl.value || '').trim();
    const reason = (qs('#popiaAnonReason') || {}).value;
    const comments = ((qs('#popiaAnonComments') || {}).value || '').trim();
    const errEl = qs('#err-popiaAnonymizeNowForm');
    if (errEl) errEl.style.display = 'none';
    if (!email) { if (errEl) { errEl.textContent = 'Please enter a client email address.'; errEl.style.display = 'block'; } return; }
    if (!await window.notificationService.showConfirm({
        title: 'Confirm Data Erasure',
        message: 'WARNING: This will permanently anonymize all personal data for ' + email + '. Financial records are retained as required by law. This cannot be undone. Proceed?',
        isDestructive: true
    })) return;

    const btn = qs('#popiaAnonymizeNowSubmitBtn');
    const originalHtml = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Processing...';
    try {
        const res = await popiaFetch('/api/admin/popia/requests', 'POST', { email: email, reason: reason, additional_comments: comments, auto_process: true });
        window.notificationService.showSuccess(res.message || 'Data anonymized successfully.');
        qs('#popiaAnonymizeNowForm').reset();
        closeAtlDrawer('popiaAnonymizeNowDrawer');
        loadPopiaRequests();
    } catch (e) {
        window.notificationService.showError(e.message);
    } finally {
        btn.disabled = false;
        btn.innerHTML = originalHtml;
    }
});
