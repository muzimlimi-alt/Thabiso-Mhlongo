/* Phase 6 (HOUSEKEEPING-NOTES.md): relocated from admin.html verbatim — core Finance content
   (Financial State/helpers, Transactions, Invoices, Generate Invoice Modal, Financial
   Analytics & Reports/charts). This code sat in the middle of the large
   initFinanceManagement(...) closure (the same one Services/Policies/Branding/Security & Audit/
   System Settings came from), with zero cross-reference in either direction to the "Payment
   Milestone Schedules" widget immediately after it (verified via grep — that widget is Bookings'
   own Deal View feature, keyed by bookingId, and was deliberately NOT moved here; it stays in
   admin.html, deferred to a future Bookings scoping pass). Per the Email Logs / Services+Policies
   fix, the enclosing closure is kept whole — this file's <script src> tag sits before the whole
   initFinanceManagement block instead, alongside services.js/policies.js/branding.js/
   security-audit.js/system-settings.js.

   Every publicly-needed function (window.loadFinancialStats, window.loadFinAnalytics,
   window.generateInvoice, window.sendInvoice, window.markInvoicePaid, window.voidInvoice,
   window.filterTransactions, window.applyInvoiceFilter, window.openGenerateInvoiceModal,
   window.onFinPeriodPresetChange, window.sendQuoteFromCard/resendQuoteFromCard/
   sendOrResendInvoiceFromCard, window.loadRemindersLog) was already window-attached in the
   original source — no new attachments were needed. */

// Financial State
let finStatsLoaded = false;
let _allTransactionsCache = [];
let _totalTransactionCount = 0;
let allInvoicesCache = [];

// Helper: format currency
function fmtCurr(val) {
    return 'R ' + parseFloat(val || 0).toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// Helper: compute date range from period preset
function getPeriodDates(preset) {
    const now = new Date();
    const y = now.getFullYear(), m = now.getMonth();
    let from, to;
    if (preset === 'last_month') {
        const lm = new Date(y, m - 1, 1);
        from = lm.toISOString().split('T')[0];
        to   = new Date(y, m, 0).toISOString().split('T')[0];
    } else if (preset === 'this_quarter') {
        const q = Math.floor(m / 3);
        from = new Date(y, q * 3, 1).toISOString().split('T')[0];
        to   = now.toISOString().split('T')[0];
    } else if (preset === 'last_quarter') {
        const q = Math.floor(m / 3);
        const lqs = q === 0 ? new Date(y - 1, 9, 1) : new Date(y, (q - 1) * 3, 1);
        const lqe = q === 0 ? new Date(y - 1, 12, 0) : new Date(y, q * 3, 0);
        from = lqs.toISOString().split('T')[0];
        to   = lqe.toISOString().split('T')[0];
    } else if (preset === 'ytd') {
        from = new Date(y, 0, 1).toISOString().split('T')[0];
        to   = now.toISOString().split('T')[0];
    } else if (preset === 'custom') {
        from = $('#finDateFrom').val() || new Date(y, m, 1).toISOString().split('T')[0];
        to   = $('#finDateTo').val() || now.toISOString().split('T')[0];
    } else {
        // default: this_month
        from = new Date(y, m, 1).toISOString().split('T')[0];
        to   = now.toISOString().split('T')[0];
    }
    return { from, to };
}

// Period preset change handler
window.onFinPeriodPresetChange = function() {
    const preset = $('#finPeriodPreset').val();
    if (preset === 'custom') {
        $('#finCustomDateRow').css('display', 'flex');
    } else {
        $('#finCustomDateRow').hide();
        loadFinancialStats();
    }
};

// 1. Load Financial Overview Stats
window.loadFinancialStats = async function() {
    const preset = $('#finPeriodPreset').val() || 'this_month';
    const { from, to } = getPeriodDates(preset);

    // Update period label
    const presetLabels = {
        this_month: 'This Month', last_month: 'Last Month',
        this_quarter: 'This Quarter', last_quarter: 'Last Quarter',
        ytd: 'Year to Date', custom: `${from} → ${to}`
    };
    $('#finPeriodLabel').text(presetLabels[preset] || 'This Month');
    $('#finStat-PeriodLabel').text(`${from} to ${to}`);

    try {
        const res = await apiCall(`/api/admin/financials/stats?date_from=${from}&date_to=${to}`, 'GET');
        if (res && res.success) {
            const s = res.stats;

            // Revenue tile
            $('#finStat-TotalRevenue').text(fmtCurr(s.revenue));
            $('#finStat-RevenueInline').text(fmtCurr(s.revenue));

            // Outstanding
            $('#finStat-Outstanding').text(fmtCurr(s.outstanding));

            // Pending Quotes — now uses REAL data from quotations table
            $('#finStat-Pending').text(fmtCurr(s.pending_quotes_value));
            $('#finStat-PendingCount').text(s.pending_quotes_count || 0);

            // Overdue Invoices
            const overdueCount = s.overdue_invoices_count || 0;
            const overdueVal   = s.overdue_invoices_value || 0;
            $('#finStat-Overdue').text(overdueCount + (overdueVal > 0 ? ' (' + fmtCurr(overdueVal) + ')' : ''));
            $('#finTile-Overdue').css('border-color', overdueCount > 0 ? 'var(--atl-clay)' : '');

            // Due Soon Invoices
            const dueSoonCount = s.due_soon_invoices_count || 0;
            const dueSoonVal   = s.due_soon_invoices_value || 0;
            $('#finStat-DueSoon').text(dueSoonCount + (dueSoonVal > 0 ? ' (' + fmtCurr(dueSoonVal) + ')' : ''));
            $('#finTile-DueSoon').css('border-color', dueSoonCount > 0 ? 'var(--atl-amber)' : '');

            // Unsent Invoices
            const unsentCount = s.unsent_invoices_count || 0;
            $('#finStat-Unsent').text(unsentCount);
            $('#finTile-Unsent').css('border-color', unsentCount > 0 ? 'var(--atl-line-strong)' : '');

            // Expenses + Net Profit
            if (s.monthly_expenses !== undefined) {
                $('#finStat-Expenses').text(fmtCurr(s.monthly_expenses));
                $('#finStat-ExpensesPeriod').text(fmtCurr(s.monthly_expenses));
                const netVal = s.net_profit_month;
                const netColor = netVal >= 0 ? 'var(--atl-sage)' : 'var(--atl-clay)';
                $('#finStat-NetProfit').text(fmtCurr(netVal)).css('color', netColor);

                // Profit margin % (net profit ÷ revenue) — derived from existing stats, no backend
                const marginVal = (s.revenue && s.revenue > 0) ? (netVal / s.revenue * 100) : null;
                $('#finStat-Margin')
                    .text(marginVal === null ? '—' : marginVal.toFixed(1) + '%')
                    .css('color', marginVal === null ? '' : (marginVal >= 0 ? 'var(--atl-sage)' : 'var(--atl-clay)'));

                // Previous-period delta
                try {
                    const fromD  = new Date(from);
                    const toD    = new Date(to);
                    const spanMs = toD - fromD;
                    const prevTo   = new Date(fromD - 86400000).toISOString().split('T')[0];
                    const prevFrom = new Date(fromD - spanMs - 86400000).toISOString().split('T')[0];
                    const prevRes  = await apiCall(`/api/admin/financials/stats?date_from=${prevFrom}&date_to=${prevTo}`, 'GET');
                    if (prevRes && prevRes.success) {
                        const prevNet  = prevRes.stats.net_profit_month || 0;
                        const delta    = netVal - prevNet;
                        const absDelta = Math.abs(delta);
                        if (absDelta > 0.005) {
                            const arrow = delta >= 0 ? '▲' : '▼';
                            const dColor = delta >= 0 ? 'var(--atl-sage)' : 'var(--atl-clay)';
                            $('#finNetProfitDelta').html(`<span style="color:${dColor};">${arrow} ${fmtCurr(absDelta)}</span> <span style="color:var(--atl-muted);">vs prev. period</span>`);
                        } else {
                            $('#finNetProfitDelta').text('No change vs prev. period');
                        }
                    } else {
                        $('#finNetProfitDelta').text('');
                    }
                } catch(_) { $('#finNetProfitDelta').text(''); }
            }

            // Transactions
            if (res.recentTransactions) {
                _allTransactionsCache = res.recentTransactions;
                _totalTransactionCount = res.stats && res.stats.total_transaction_count ? res.stats.total_transaction_count : res.recentTransactions.length;
                renderTransactions(res.recentTransactions);
            }

            // Invoices
            const invRes = await apiCall('/api/admin/invoices', 'GET');
            if (invRes && !invRes.error) {
                renderInvoices(invRes);
            }

            finStatsLoaded = true;
        }
    } catch (e) {
        console.error('Finance Stats Error:', e);
        window.notificationService.showError('Failed to load financial stats — please refresh.');
    }
};

function renderTransactions(list) {
    const $body = $('#finTransactionsList');
    if (!$body.length) return;

    if (!list || list.length === 0) {
        $body.html('<tr><td colspan="7" class="text-center" style="color:var(--atl-muted-dim);">No transactions found.</td></tr>');
        $('#txGrandTotal').text('');
        $('#txCountBadge').text('');
        return;
    }

    $body.html(list.map(t => {
        const date = t.transaction_date ? new Date(t.transaction_date).toLocaleDateString('en-ZA') : '—';
        const txTypeRaw    = (t.transaction_type || '').toLowerCase();
        const isRefund     = txTypeRaw === 'refund';
        const isAdjustment = txTypeRaw === 'adjustment';
        const statusColor = isRefund     ? 'var(--atl-clay)'
            : isAdjustment               ? 'var(--atl-amber)'
            : t.status === 'completed'   ? 'var(--atl-sage)'
            : t.status === 'failed'      ? 'var(--atl-clay)'
            : 'var(--atl-orange)';
        const typeBadge = isRefund
            ? '<span style="font-size:9px;background:rgba(248,113,113,0.12);color:var(--atl-clay);padding:2px 7px;border-radius:20px;font-weight:700;">REFUND</span>'
            : isAdjustment
            ? '<span style="font-size:9px;background:rgba(251,191,36,0.12);color:var(--atl-amber);padding:2px 7px;border-radius:20px;font-weight:700;">ADJUSTMENT</span>'
            : '<span style="font-size:9px;background:rgba(74,222,128,0.1);color:var(--atl-sage);padding:2px 7px;border-radius:20px;font-weight:700;">PAYMENT</span>';
        const amtStyle = isRefund ? 'color:var(--atl-clay);font-weight:700;' : isAdjustment ? 'color:var(--atl-amber);font-weight:700;' : 'font-weight:700;color:var(--atl-ink);';
        const txTypeKey = isRefund ? 'refund' : isAdjustment ? 'adjustment' : 'payment';
        return `<tr data-date="${t.transaction_date || ''}" data-type="${txTypeKey}" data-search="${(t.client_name||'').toLowerCase()} ${(t.reference||'').toLowerCase()}">
            <td style="font-size:12px;">${date}</td>
            <td style="font-family:monospace;font-size:12px;color:var(--atl-muted);">${t.reference || '—'}</td>
            <td>${t.client_name || ('<a href="#" class="bk-nav-link" data-id="' + t.booking_id + '" style="color:var(--atl-amber);">Booking #' + t.booking_id + '</a>')}</td>
            <td style="font-size:12px;"><i class="fa-solid fa-credit-card" style="margin-right:5px;opacity:0.5;"></i>${t.payment_method || 'PayFast'}</td>
            <td>${typeBadge}</td>
            <td style="text-align:right;${amtStyle}">${isRefund ? '–' : ''}${fmtCurr(t.amount)}</td>
            <td><span style="color:${statusColor};font-weight:700;text-transform:uppercase;font-size:11px;">${t.status}</span></td>
        </tr>`;
    }).join(''));

    // Grand total of visible rows
    const total = list.reduce((s, t) => {
        const isRefund = (t.transaction_type || '').toLowerCase() === 'refund';
        return s + (isRefund ? -parseFloat(t.amount || 0) : parseFloat(t.amount || 0));
    }, 0);
    $('#txGrandTotal').text(`Showing ${list.length} transaction(s) · Net: ${fmtCurr(total)}`);
    const isFiltered = list.length < _allTransactionsCache.length;
    const overLimitNote = !isFiltered && _totalTransactionCount > _allTransactionsCache.length
        ? ` · <span style="color:var(--atl-amber);" title="Latest ${_allTransactionsCache.length} of ${_totalTransactionCount} loaded. Use date filters to narrow.">⚠ ${_totalTransactionCount} total in DB</span>`
        : '';
    $('#txCountBadge').html(`${list.length} result(s)${overLimitNote}`);
}

// Client-side filter for transactions tab
window.filterTransactions = function() {
    const search = ($('#txSearchInput').val() || '').toLowerCase();
    const typeFilter = ($('#txTypeFilter').val() || '').toLowerCase();
    const dateFrom = $('#txDateFrom').val();
    const dateTo   = $('#txDateTo').val();

    let filtered = _allTransactionsCache.filter(t => {
        const txTypeRaw = (t.transaction_type || '').toLowerCase();
        const txType = txTypeRaw === 'refund' ? 'refund' : txTypeRaw === 'adjustment' ? 'adjustment' : 'payment';
        const searchStr = `${(t.client_name||'').toLowerCase()} ${(t.reference||'').toLowerCase()}`;
        const txDate = (t.transaction_date || '').split('T')[0];

        if (typeFilter && txType !== typeFilter) return false;
        if (search && !searchStr.includes(search)) return false;
        if (dateFrom && txDate < dateFrom) return false;
        if (dateTo   && txDate > dateTo)   return false;
        return true;
    });
    renderTransactions(filtered);
};


function renderInvoices(list) {
    allInvoicesCache = list || [];
    applyInvoiceFilter();
}

window.loadRemindersLog = async function() {
    const $body = $('#finRemindersList');
    if (!$body.length) return;
    $body.html('<tr><td colspan="8" class="text-center"><i class="fa-solid fa-spinner fa-spin"></i> Loading...</td></tr>');
    try {
        const r = await apiCall('/api/admin/reminders?limit=200');
        if (!r || !r.success || !r.reminders || r.reminders.length === 0) {
            $body.html('<tr><td colspan="8" class="text-center text-muted">No reminders sent yet.</td></tr>');
            return;
        }
        $body.html(r.reminders.map(rem => {
            const sentAt = rem.sent_at ? new Date(rem.sent_at).toLocaleString('en-ZA') : '—';
            const sc = rem.status === 'sent' ? 'var(--atl-sage)' : 'var(--atl-clay)';
            let deliveryBadge;
            if (rem.bounce_reason) {
                deliveryBadge = `<span style="font-size:10px;background:rgba(248,113,113,0.12);color:var(--atl-clay);border:1px solid rgba(248,113,113,0.3);padding:2px 7px;border-radius:20px;font-weight:700;" title="${rem.bounce_reason}">Bounced</span>`;
            } else if (rem.delivered_at) {
                deliveryBadge = `<span style="font-size:10px;background:rgba(74,222,128,0.1);color:var(--atl-sage);border:1px solid rgba(74,222,128,0.2);padding:2px 7px;border-radius:20px;font-weight:700;" title="Delivered ${new Date(rem.delivered_at).toLocaleString('en-ZA')}">Delivered</span>`;
            } else if (rem.status === 'sent') {
                deliveryBadge = `<span style="font-size:10px;background:rgba(212,175,55,0.1);color:var(--atl-amber);border:1px solid rgba(212,175,55,0.2);padding:2px 7px;border-radius:20px;font-weight:700;">Pending</span>`;
            } else {
                deliveryBadge = `<span style="font-size:10px;color:var(--atl-muted);">—</span>`;
            }
            return `<tr>
                <td style="font-size:12px;color:#aaa;">${sentAt}</td>
                <td>${rem.client_name || rem.recipient_email}</td>
                <td><a href="#" class="bk-nav-link" style="color: var(--atl-amber);" data-id="${rem.booking_id}">#${rem.booking_id}</a></td>
                <td>${rem.due_date || '—'}</td>
                <td style="text-align:center;">${rem.days_before}d</td>
                <td style="font-weight:700;color: var(--atl-ink);">${rem.amount_due != null ? fmtCurr(rem.amount_due) : '—'}</td>
                <td><span style="color:${sc};font-size:11px;font-weight:700;text-transform:uppercase;">${rem.status}</span>${rem.error_message ? `<br><span style="font-size:10px;color: var(--atl-muted);" title="${rem.error_message}">⚠ ${rem.error_message.substring(0,40)}</span>` : ''}</td>
                <td>${deliveryBadge}</td>
            </tr>`;
        }).join(''));
    } catch(e) {
        $body.html('<tr><td colspan="8" class="text-center text-muted">Failed to load reminders.</td></tr>');
    }
};

window.applyInvoiceFilter = function() {
    const $body = $('#finInvoicesList');
    if (!$body.length) return;
    const filterVal = ($('#invoiceStatusFilter').val() || '').toUpperCase();
    let list;
    if (filterVal === 'DUE_SOON') {
        const _today = new Date(); _today.setHours(0,0,0,0);
        const _in7 = new Date(_today); _in7.setDate(_today.getDate() + 7);
        list = allInvoicesCache.filter(i => {
            if (!i.due_date || (i.status||'').toUpperCase() === 'PAID') return false;
            const d = new Date(i.due_date);
            return d >= _today && d <= _in7;
        });
    } else if (filterVal === 'UNSENT') {
        list = allInvoicesCache.filter(i => !i.sent_at && !['void','VOID'].includes(i.status||''));
    } else {
        list = filterVal ? allInvoicesCache.filter(i => (i.status||'').toUpperCase() === filterVal) : allInvoicesCache;
    }

    if (!list || list.length === 0) {
        $body.html('<tr><td colspan="7" class="text-center" style="color:var(--atl-muted-dim);">No invoices match the selected filter.</td></tr>');
        return;
    }

    const today = new Date().toISOString().split('T')[0];
    const statusColors = { PAID:'var(--atl-sage)', OVERDUE:'var(--atl-clay)', VOID:'var(--atl-muted-dim)', SENT:'var(--atl-orange)', DRAFT:'var(--atl-muted)' };

    $body.html(list.map(inv => {
        const issueDate = inv.invoice_date ? new Date(inv.invoice_date).toLocaleDateString('en-ZA') : '—';
        const dueDate   = inv.due_date    ? new Date(inv.due_date).toLocaleDateString('en-ZA') : '—';
        const isOverdue = inv.status === 'SENT' && inv.due_date && inv.due_date < today;
        const dueDateHtml = isOverdue
            ? `<span style="color:var(--atl-clay);font-weight:700;">${dueDate} ⚠</span>`
            : `<span style="color:var(--atl-muted);">${dueDate}</span>`;
        const sc = statusColors[inv.status] || 'var(--atl-muted)';
        const isVoided = inv.status === 'VOID';
        const rowStyle = isOverdue ? 'background:rgba(239,68,68,0.05);' : '';
        return `<tr style="${rowStyle}">
            <td style="font-weight:700;color:var(--atl-amber);">${inv.invoice_number}</td>
            <td style="font-size:12px;">${issueDate}</td>
            <td>${dueDateHtml}</td>
            <td>${inv.client_name || 'Client'}</td>
            <td style="text-align:right;font-weight:700;">${fmtCurr(inv.total_amount)}</td>
            <td><span style="color:${sc};font-weight:700;font-size:11px;">${inv.status}</span></td>
            <td style="white-space:nowrap;">
                <a href="/api/admin/bookings/${inv.booking_id}/invoice/download" target="_blank" class="atl-btn atl-btn--ghost" title="Download PDF" style="padding:4px 8px;min-height:32px;"><i class="fa-solid fa-download"></i></a>
                ${!isVoided && inv.status !== 'PAID' ? `<button class="atl-btn" style="margin-left:4px;padding:4px 8px;min-height:32px;background:rgba(74,222,128,0.12);color:var(--atl-sage);border:1px solid rgba(74,222,128,0.3);border-radius:6px;" title="Mark as Paid" onclick="markInvoicePaid(${inv.id},'${inv.invoice_number}')"><i class="fa-solid fa-circle-check"></i></button>` : ''}
                ${!isVoided ? `<button class="atl-btn atl-btn--ghost" style="margin-left:4px;padding:4px 8px;min-height:32px;" title="Resend email" onclick="sendInvoice(${inv.id})"><i class="fa-solid fa-paper-plane"></i></button>` : ''}
                ${!isVoided ? `<button class="atl-btn btn-void-invoice" style="margin-left:4px;padding:4px 8px;min-height:32px;background:rgba(248,113,113,0.1);color:var(--atl-clay);border:1px solid rgba(248,113,113,0.25);border-radius:6px;" title="Void invoice" onclick="voidInvoice(${inv.id},'${inv.invoice_number}')"><i class="fa-solid fa-ban"></i></button>` : ''}
            </td>
        </tr>`;
    }).join(''));
};

window.sendInvoice = async function(id) {
    if (!await window.notificationService.showConfirm({ message: "Resend this invoice email to the client?", isDestructive: false })) return;
    try {
        const r = await apiCall('/api/admin/invoices/' + id + '/send', 'POST');
        window.notificationService.showSuccess(r.message || 'Invoice sent.');
    } catch(e) {
        window.notificationService.showError("Failed to send invoice.");
    }
};

// Bulk send all unsent invoices
$(document).on('click', '#invoiceSendAllUnsentBtn', async function() {
    const unsent = (allInvoicesCache || []).filter(i => !i.sent_at && !['void','VOID'].includes((i.status||'').toLowerCase()));
    if (!unsent.length) { window.notificationService.showError('No unsent invoices found.'); return; }
    if (!await window.notificationService.showConfirm({ message: 'Send ' + unsent.length + ' unsent invoice(s) by email?', isDestructive: false })) return;
    const $btn = $(this).prop('disabled', true).html('<i class="fa-solid fa-spinner fa-spin" style="margin-right:5px;"></i>Sending…');
    const d = await apiCall('/api/admin/invoices/bulk-send-unsent', 'POST', {});
    $btn.prop('disabled', false).html('<i class="fa-solid fa-paper-plane" style="margin-right:5px;"></i>Send All Unsent');
    if (d.success) {
        window.notificationService.showSuccess(d.sent + ' invoice(s) sent' + (d.failed ? ', ' + d.failed + ' failed' : '') + '.');
        if (typeof loadInvoices === 'function') loadInvoices();
    } else {
        window.notificationService.showError(d.message || 'Bulk send failed.');
    }
});

// Called from the Quote card "Send Quote" button (no prior send) — opens Quote Builder modal
window.sendQuoteFromCard = async function(bookingId) {
    var $fakeBtn = $('<button type="button" class="bk-action-quote">').attr('data-id', bookingId);
    $('body').append($fakeBtn);
    $fakeBtn.trigger('click');
    setTimeout(function() { $fakeBtn.remove(); }, 300);
};

// Called from the Quote card "Resend Quote" button — delegates to the existing .bk-action-resend-quote handler
window.resendQuoteFromCard = function(bookingId) {
    var $fakeBtn = $('<button type="button" class="bk-action-resend-quote">').attr('data-id', bookingId);
    $('body').append($fakeBtn);
    $fakeBtn.trigger('click');
    setTimeout(function() { $fakeBtn.remove(); }, 300);
};

// Called from the Invoice card "Send Invoice" / "Resend Invoice" button — delegates to window.sendInvoice
window.sendOrResendInvoiceFromCard = function(invoiceId) {
    window.sendInvoice(invoiceId);
};

window.voidInvoice = async function(id, num) {
    const reason = await window.notificationService.showPrompt({ 
        title: 'Void Invoice',
        message: 'Reason for voiding invoice ' + num + ' (required):',
        defaultValue: ''
    });
    if (reason === null) return;
    if (!reason.trim()) {
        window.notificationService.showError('A void reason is required.');
        return;
    }
    try {
        await apiCall('/api/admin/invoices/' + id + '/void', 'POST', { reason: reason.trim() });
        window.notificationService.showSuccess('Invoice ' + num + ' has been voided.');
        const invRes = await apiCall('/api/admin/invoices', 'GET');
        if (invRes && !invRes.error) renderInvoices(invRes);
    } catch(e) {
        window.notificationService.showError('Failed to void invoice.');
    }
};

window.markInvoicePaid = async function(id, num) {
    const confirmed = await window.notificationService.showConfirm({
        title: 'Mark Invoice as Paid',
        message: `Mark invoice ${num} as PAID? This records the invoice as manually settled. No payment transaction will be created \u2014 use "Record Payment" on the booking if you need a transaction record.`,
        confirmText: 'Yes, Mark as Paid',
        isDestructive: false
    });
    if (!confirmed) return;
    try {
        // Use the existing void endpoint pattern — mark status directly
        await apiCall('/api/admin/invoices/' + id + '/mark-paid', 'POST', {});
        window.notificationService.showSuccess('Invoice ' + num + ' marked as PAID.');
        const invRes = await apiCall('/api/admin/invoices', 'GET');
        if (invRes && !invRes.error) renderInvoices(invRes);
        // Also refresh stats to reflect the change
        loadFinancialStats();
    } catch(e) {
        window.notificationService.showError('Failed to mark invoice as paid. Ensure the endpoint exists on the server.');
    }
};

window.generateInvoice = async function(bookingId, btnEl) {
    const $btn = btnEl ? $(btnEl) : $();
    const orig = $btn.html();
    $btn.prop('disabled', true).html('<i class="fa fa-spinner fa-spin"></i> Generating...');
    
    try {
        const res = await apiCall(`/api/admin/bookings/${bookingId}/invoice/generate`, 'POST');
        if (res.success) {
            window.notificationService.showSuccess('Success: Invoice PDF generated and dispatched. Booking updated.');
            $btn.html('<i class="fa-solid fa-check"></i> Regenerate Invoice').css('background','var(--atl-sage)').css('color', '#fff').prop('disabled', false);
            await loadBookings();
            if (typeof window.toggleBookingDetail === 'function') window.toggleBookingDetail(bookingId, true);
        } else {
            window.notificationService.showError('Error: ' + res.message);
            $btn.prop('disabled', false).html(orig);
        }
    } catch (e) {
        window.notificationService.showError('Failed to connect to server.');
        $btn.prop('disabled', false).html(orig);
    }
};

// --- Generate Invoice Modal from Invoices Tab ---
window.openGenerateInvoiceModal = function() {
    const select = $('#giBookingSelect');
    select.empty();
    
    const eligible = (typeof allBookingsCache !== 'undefined' ? allBookingsCache : []).filter(b => {
        const hasInv = !!b.invoice_id && String(b.invoice_status || '').toUpperCase() !== 'VOID';
        return !hasInv && ['ACCEPTED', 'CONFIRMED', 'COMPLETED', 'QUOTED'].includes(b.status);
    });
    
    if (eligible.length === 0) {
        select.append('<option value="">No bookings eligible for invoice generation</option>');
        $('#giBookingDetails').hide();
        $('#giSubmitBtn').prop('disabled', true);
    } else {
        select.append('<option value="">-- Select a booking --</option>');
        eligible.forEach(b => {
            const dateStr = b.date ? new Date(b.date).toLocaleDateString('en-ZA') : 'N/A';
            const amtStr = b.total_amount ? `(R ${parseFloat(b.total_amount).toFixed(2)})` : '';
            select.append(`<option value="${b.id}">${b.name || 'Booking #' + b.id} - ${b.event_name || b.event_type || ''} on ${dateStr} ${amtStr}</option>`);
        });
        $('#giSubmitBtn').prop('disabled', false);
    }
    
    select.off('change').on('change', function() {
        const val = $(this).val();
        if (!val) {
            $('#giBookingDetails').hide();
            return;
        }
        const bk = eligible.find(b => b.id == val);
        if (bk) {
            $('#giClientName').text(bk.name || '—');
            $('#giEventDate').text(bk.date ? new Date(bk.date).toLocaleDateString('en-ZA') : '—');
            $('#giTotalAmount').text(bk.total_amount ? `R ${parseFloat(bk.total_amount).toFixed(2)}` : 'R 0.00');
            $('#giBookingDetails').show();
        } else {
            $('#giBookingDetails').hide();
        }
    });
    
    $('#giSubmitBtn').off('click').on('click', async function() {
        const bookingId = select.val();
        if (!bookingId) {
            window.notificationService.showError('Please select a booking.');
            return;
        }
        
        $('#generateInvoiceModal').modal('hide');
        await window.generateInvoice(bookingId);
        if (typeof loadInvoices === 'function') {
            loadInvoices();
        }
    });
    
    $('#generateInvoiceModal').modal('show');
};

// --- Financial Analytics & Reports ---
let finRevenueChartInstance = null;
let finCategoryChartInstance = null;
let finCashflowChartInstance = null;

window.loadFinAnalytics = async function() {
    $('#finAnalyticsTopClientsList').html('<div class="db-rank-empty"><i class="fa fa-spinner fa-spin"></i> Loading&hellip;</div>');
    $('#finAnalyticsOverdueListBody').html('<tr><td colspan="5" class="text-center"><i class="fa fa-spinner fa-spin"></i> Loading...</td></tr>');
    
    try {
        const res = await apiCall('/api/admin/financials/analytics', 'GET');
        if (!res.success) {
            window.notificationService.showError('Failed to load financial analytics.');
            return;
        }
        
        const trend = res.revenueTrend || [];
        const months = trend.map(t => {
            const parts = t.month.split('-');
            if (parts.length === 2) {
                const date = new Date(parseInt(parts[0]), parseInt(parts[1]) - 1, 1);
                return date.toLocaleString('default', { month: 'short', year: 'numeric' });
            }
            return t.month;
        });
        const revenues = trend.map(t => parseFloat(t.total_revenue || 0));
        
        const fb = finApexBase();
        const chartOptions = {
            series: [{ name: 'Revenue Received', data: revenues }],
            chart: { type: 'area', height: 300, toolbar: { show: false }, background: 'transparent', animations: { enabled: true, speed: 600 } },
            colors: ['#D4AF37'],
            stroke: { curve: 'smooth', width: 2 },
            fill: { type: 'gradient', gradient: { opacityFrom: 0.4, opacityTo: 0.05 } },
            dataLabels: { enabled: false },
            grid: { borderColor: fb.gridColor },
            xaxis: { categories: months, labels: { style: { colors: fb.axisColor } } },
            yaxis: { labels: { style: { colors: fb.axisColor }, formatter: function(val) { return val >= 1000 ? 'R' + (val / 1000).toFixed(0) + 'k' : 'R' + Math.round(val); } } },
            tooltip: { theme: fb.tooltip, x: { show: true }, y: { formatter: function(val) { return R_FMT(val); } } }
        };
        
        if (finRevenueChartInstance) {
            finRevenueChartInstance.destroy();
        }
        const chartEl = document.querySelector("#finAnalyticsRevenueChart");
        if (chartEl) {
            finRevenueChartInstance = new ApexCharts(chartEl, chartOptions);
            finRevenueChartInstance.render();
        }
        
        const clients = res.topClients || [];
        const tcEl = document.getElementById('finAnalyticsTopClientsList');
        if (tcEl) {
            if (!clients.length) {
                tcEl.innerHTML = '<div class="db-rank-empty">No customer data found.</div>';
            } else {
                const tcMax = clients.reduce(function(m, c) { return Math.max(m, parseFloat(c.total_spent || 0)); }, 0) || 1;
                tcEl.innerHTML = clients.map(function(c, i) {
                    const val  = parseFloat(c.total_spent || 0);
                    const pct  = Math.max(4, Math.round(val / tcMax * 100));
                    const name = (c.client_name || '—') + (c.company_name ? ' · ' + c.company_name : '');
                    const n    = c.booking_count || 0;
                    return '<div class="db-rank-item">' +
                            '<span class="db-rank-idx">' + (i + 1) + '</span>' +
                            '<span class="db-rank-main">' +
                                '<span class="db-rank-label">' + finEsc(name) + '</span>' +
                                '<span class="db-rank-bar" style="--db-rank-pct:' + pct + '%"></span>' +
                            '</span>' +
                            '<span class="db-rank-value">' + R_FMT(val) + '<small>' + n + ' booking' + (n === 1 ? '' : 's') + '</small></span>' +
                        '</div>';
                }).join('');
            }
        }
        
        const aging = res.debtAging || {};
        $('#finAgingCurrentCount').text(`${aging.current_count || 0} invoice(s)`);
        $('#finAgingCurrentVal').text(R_FMT(aging.current_value));
        
        $('#finAging30Count').text(`${aging.age_30_count || 0} invoice(s)`);
        $('#finAging30Val').text(R_FMT(aging.age_30_value));
        
        $('#finAging60Count').text(`${aging.age_60_count || 0} invoice(s)`);
        $('#finAging60Val').text(R_FMT(aging.age_60_value));
        
        $('#finAging90Count').text(`${aging.age_over_90_count || 0} invoice(s)`);
        $('#finAging90Val').text(R_FMT(aging.age_over_90_value));
        
        const overdue = res.overdueInvoices || [];
        if (overdue.length === 0) {
            $('#finAnalyticsOverdueListBody').html('<tr><td colspan="5" class="text-center" style="color:var(--atl-muted-dim);">No overdue invoices.</td></tr>');
        } else {
            $('#finAnalyticsOverdueListBody').html(overdue.map(i => `
                <tr>
                    <td style="font-weight:700;color:var(--atl-amber);">${i.invoice_number}</td>
                    <td>
                        <div style="font-weight:600;color:var(--atl-ink);">${i.client_name || '—'}</div>
                        <div style="font-size:11px;color:var(--atl-muted);">${i.event_name || ''}</div>
                    </td>
                    <td>${i.due_date ? new Date(i.due_date).toLocaleDateString('en-ZA') : '—'}</td>
                    <td style="text-align:right;color:var(--atl-clay);font-weight:700;">${i.days_overdue || 0}d</td>
                    <td style="text-align:right;font-weight:700;color:var(--atl-ink);">${R_FMT(i.total_amount)}</td>
                </tr>
            `).join(''));
        }
        
        // Supplementary charts: Revenue by Service Type + Cash Flow
        renderFinExtraCharts(res);

    } catch(e) {
        console.error('Error loading financial analytics:', e);
        window.notificationService.showError('Failed to load financial analytics.');
    }
};

// Theme-aware chart palette shared by the finance-analytics charts — mirrors
// the main dashboard's dbApexBase() light/dark behaviour.
function finApexBase() {
    var light = document.documentElement.getAttribute('data-theme') === 'light';
    return {
        axisColor: light ? '#555'    : '#b0b0b0',
        gridColor: light ? '#e6e6e6' : 'rgba(255,255,255,0.08)',
        tooltip:   light ? 'light'   : 'dark',
        legend:    light ? '#555'    : '#b0b0b0'
    };
}
function finEsc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
        return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
}

// Renders the two supplementary finance-analytics charts:
//   • Revenue by Service Type (donut)  • Cash Flow: Revenue vs Expenses (combo)
function renderFinExtraCharts(res) {
    var fb = finApexBase();
    // ---- Revenue by Service Type (donut) ----
    const cats  = (res && res.revenueByCategory) || [];
    const catEl = document.querySelector('#finAnalyticsCategoryChart');
    if (finCategoryChartInstance) { finCategoryChartInstance.destroy(); finCategoryChartInstance = null; }
    if (catEl) {
        if (!cats.length) {
            catEl.innerHTML = '<div style="text-align:center;color:var(--atl-muted-dim);padding:70px 0;font-size:13px;">No revenue recorded yet.</div>';
        } else {
            finCategoryChartInstance = new ApexCharts(catEl, {
                series: cats.map(function(c){ return parseFloat(c.revenue || 0); }),
                labels: cats.map(function(c){ return c.category; }),
                chart: { type: 'donut', height: 300, background: 'transparent', animations: { enabled: true, speed: 600 } },
                colors: ['#D4AF37','#e0c04a','#b08800','#8a6d00','#c98a3c','#7c9a6d','#6d8a9a','#9a6d7c'],
                stroke: { width: 0 },
                legend: { position: 'bottom', fontSize: '12px', labels: { colors: fb.legend } },
                dataLabels: { enabled: true, formatter: function(val){ return Math.round(val) + '%'; }, style: { fontSize: '11px', fontWeight: 600 } },
                plotOptions: { pie: { donut: { size: '62%', labels: { show: true, total: { show: true, label: 'Total', color: fb.axisColor, fontSize: '13px', formatter: function(w){ return R_FMT(w.globals.seriesTotals.reduce(function(a,b){ return a + b; }, 0)); } } } } } },
                tooltip: { theme: fb.tooltip, y: { formatter: function(val){ return R_FMT(val); } } }
            });
            finCategoryChartInstance.render();
        }
    }

    // ---- Cash Flow — Revenue vs Expenses (combo) ----
    const cf   = (res && res.cashFlow) || [];
    const cfEl = document.querySelector('#finAnalyticsCashflowChart');
    if (finCashflowChartInstance) { finCashflowChartInstance.destroy(); finCashflowChartInstance = null; }
    if (cfEl) {
        if (!cf.length) {
            cfEl.innerHTML = '<div style="text-align:center;color:var(--atl-muted-dim);padding:70px 0;font-size:13px;">No cash-flow data yet.</div>';
        } else {
            const cfMonths = cf.map(function(r){
                const p = String(r.month).split('-');
                return (p.length === 2)
                    ? new Date(parseInt(p[0]), parseInt(p[1]) - 1, 1).toLocaleString('default', { month: 'short', year: '2-digit' })
                    : r.month;
            });
            finCashflowChartInstance = new ApexCharts(cfEl, {
                series: [
                    { name: 'Revenue',  type: 'column', data: cf.map(function(r){ return parseFloat(r.revenue  || 0); }) },
                    { name: 'Expenses', type: 'column', data: cf.map(function(r){ return parseFloat(r.expenses || 0); }) },
                    { name: 'Net',      type: 'line',   data: cf.map(function(r){ return parseFloat(r.net      || 0); }) }
                ],
                chart: { type: 'line', height: 300, toolbar: { show: false }, background: 'transparent', animations: { enabled: true, speed: 600 } },
                colors: ['#7c9a6d','#c17767','#D4AF37'],
                stroke: { width: [0,0,3], curve: 'smooth' },
                plotOptions: { bar: { columnWidth: '55%', borderRadius: 3 } },
                grid: { borderColor: fb.gridColor },
                xaxis: { categories: cfMonths, labels: { style: { colors: fb.axisColor } } },
                yaxis: { labels: { style: { colors: fb.axisColor }, formatter: function(v){ return v >= 1000 ? 'R' + (v / 1000).toFixed(0) + 'k' : 'R' + Math.round(v); } } },
                legend: { position: 'top', labels: { colors: fb.legend } },
                dataLabels: { enabled: false },
                tooltip: { theme: fb.tooltip, shared: true, intersect: false, y: { formatter: function(val){ return R_FMT(val); } } }
            });
            finCashflowChartInstance.render();
        }
    }
}
