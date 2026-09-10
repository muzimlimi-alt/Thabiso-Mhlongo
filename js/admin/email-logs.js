/* Phase 6 (HOUSEKEEPING-NOTES.md): relocated from admin.html verbatim — the "EMAIL LOGS MODULE"
   block. Every function called from an inline onclick/oninput/onchange attribute in the section
   markup (loadEmailLogs(), debounceLogSearch(), applyLogFilters(), toggleLogSort('...')) was
   already window-attached in the original source — no new window.X = X lines needed here, unlike
   every prior section this pass. Uses only qs/qsa (the file's foundational DOM-query helpers,
   defined near the very top of the main script and used everywhere in this file) — no
   atlActivateDrawerTab/uploadFileToServer dependency, no drawer here. */
let logState = {
    page: 1,
    limit: 15,
    search: '',
    status: '',
    trigger: '',
    sort: 'sent_at',
    order: 'DESC'
};
let logSearchTimer;

/* Phase 7 Component 1 (HOUSEKEEPING-NOTES.md "#9"): loadEmailLogs is now a DataTable instance.
   logState / logSearchTimer / renderLogPagination / toggleLogSort / updateSortIcons /
   applyLogFilters / debounceLogSearch below are UNCHANGED (Pagination + sort-icons are later
   Phase 7 components). window.DataTable comes from js/admin/components/data-table.js, loaded
   before this file in admin.html. Accepted micro-deltas + the still-owed live-load checklist
   are in HOUSEKEEPING-NOTES.md's "#9" section. */
const emailLogsTable = new DataTable({
    body:  '#emailLogsBody',
    table: null,
    stats: { el: '#logStats', format: 'X-Y', noun: 'logs', emptyText: 'Showing 0 logs' },
    colspan: { loading: 5, empty: 5, error: 6 },
    states: {
        siblingEl: '#emailLogsEmpty',
        empty:   { idiom: 'sibling-el', siblingMode: 'toggle-only' },
        loading: { idiom: 'row-html', html: '<tr><td colspan="5" class="text-center" style="padding: 40px; border:none; opacity: 0.5;"><i class="fa fa-spinner fa-spin" style="margin-right: 10px;"></i> Fetching logs...</td></tr>' },
        error:   { idiom: 'row-html', html: '<tr><td colspan="6" class="text-center text-danger" style="padding:20px;">Failed to load logs. Session may have expired.</td></tr>' }
    },
    server: {
        pageSize: 15,
        fetch: async function () {
            const query = new URLSearchParams(logState).toString();
            let response;
            try {
                response = await fetch(`/api/admin/email-logs?${query}`, { credentials: 'include' });
            } catch (e) {
                console.error("❌ Failed to load email logs:", e);
                if (window.notificationService) window.notificationService.showError('Could not load email logs. Please try again.');
                throw e;
            }
            if (response.status === 401) {
                const body = qs('#emailLogsBody');
                if (body) body.innerHTML = '<tr><td colspan="5" class="text-center text-danger">Unauthorized. Redirecting to login...</td></tr>';
                setTimeout(() => window.location.reload(), 2000);
                return DataTable.ABORT;
            }
            let res;
            try { res = await response.json(); }
            catch (e) {
                console.error("❌ Failed to load email logs:", e);
                if (window.notificationService) window.notificationService.showError('Could not load email logs. Please try again.');
                throw e;
            }
            if (res && res.success) {
                return { rows: res.logs || [], total: parseInt(res.total) || 0, totalPages: parseInt(res.totalPages) || 0 };
            }
            return DataTable.ABORT;
        }
    },
    renderRow: function (log) {
        const escape = (str) => { const div = document.createElement('div'); div.textContent = str || ''; return div.innerHTML; };
        const date = new Date(log.sent_at).toLocaleString();
        const statusClass = log.status === 'success' ? 'text-success' : (log.status === 'pending' ? 'text-warning' : 'text-danger');
        const triggerIcon = (log.trigger_event||'').includes('Newsletter') ? 'fa-envelopes-bulk' :
                           (log.trigger_event||'').includes('Booking') ? 'fa-calendar-check' :
                           (log.trigger_event||'').includes('Admin') ? 'fa-user-shield' : 'fa-paper-plane';
        const cells = `
                    <td style="padding: 15px; border:none; font-size: 13px; color: #aaa;">${escape(date)}</td>
                    <td style="padding: 15px; border:none; font-weight: 500;">${escape(log.recipient_email)}</td>
                    <td style="padding: 15px; border:none; color: #ddd;">${escape(log.subject)}</td>
                    <td style="padding: 15px; border:none; font-size: 12px;"><i class="fa-solid ${triggerIcon}" style="margin-right:6px; opacity:0.6;"></i>${escape(log.trigger_event)}</td>
                    <td style="padding: 15px; border:none;"><span class="${statusClass}" style="font-weight:bold; text-transform:uppercase; font-size:11px;"><i class="fa-solid ${log.status === 'success' ? 'fa-check-circle' : (log.status === 'pending' ? 'fa-clock' : 'fa-circle-xmark')}" style="margin-right:4px;"></i>${escape(log.status)}</span></td>
                `;
        return '<tr>' + cells + '</tr>';
    },
    rowDecorate: function (tr) {
        tr.style.background = 'rgba(255,255,255,0.03)';
        tr.style.transition = '0.2s';
        tr.onmouseover = () => tr.style.background = 'rgba(255,255,255,0.06)';
        tr.onmouseout  = () => tr.style.background = 'rgba(255,255,255,0.03)';
    },
    onRender:   function () { updateSortIcons(); },
    pagination: function (info) { renderLogPagination(info.totalPages); }
});

window.loadEmailLogs = function () { return emailLogsTable.setPage(logState.page); };

/* Phase 7 Component 2 (HOUSEKEEPING-NOTES.md "A1"): renderLogPagination is now a Pagination
   instance. A1 is the copy-paste outlier — '...' glyph, #555 colour, no `>7` ellipsis guard,
   no `um-btn--sm` — all reproduced via config. window.Pagination comes from
   js/admin/components/pagination.js (loaded before this file). */
var logPager = new Pagination({
    mode: 'numbered',
    container: '#logPagination',
    getPage: function () { return logState.page; },
    onGoto: function (n) { logState.page = n; window.loadEmailLogs(); },
    ellipsis: 'gt6',            // A1: `i > 5 && i < totalPages` with no `totalPages > 7` guard
    ellipsisGlyph: '...',
    ellipsisColor: '#555',
    ellipsisPadding: ''
});
function renderLogPagination(totalPages) { return logPager.render(totalPages); }

window.toggleLogSort = function(col) {
    if (logState.sort === col) {
        logState.order = logState.order === 'ASC' ? 'DESC' : 'ASC';
    } else {
        logState.sort = col;
        logState.order = 'DESC';
    }
    logState.page = 1;
    loadEmailLogs();
}

function updateSortIcons() {
    qsa('#logSortHeaders i').forEach(icon => {
        icon.className = 'fa-solid fa-sort';
        icon.style.opacity = '0.3';
    });
    const activeIcon = qs(`#sort-${logState.sort}`);
    if (activeIcon) {
        activeIcon.className = logState.order === 'ASC' ? 'fa-solid fa-sort-up' : 'fa-solid fa-sort-down';
        activeIcon.style.opacity = '1';
    }
}

window.applyLogFilters = function() {
    logState.status = qs('#logStatusFilter').value;
    logState.trigger = qs('#logTriggerFilter').value;
    logState.page = 1;
    loadEmailLogs();
}

window.debounceLogSearch = function() {
    clearTimeout(logSearchTimer);
    logSearchTimer = setTimeout(() => {
        logState.search = qs('#logSearch').value;
        logState.page = 1;
        loadEmailLogs();
    }, 400);
}
