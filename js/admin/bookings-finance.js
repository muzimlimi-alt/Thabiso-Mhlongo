/* Phase 6 (HOUSEKEEPING-NOTES.md "Section 21 / Bookings sub-batch 2: Expense/Bank/Reconciliation"):
 * relocated VERBATIM from admin.html’s big Bookings inline <script> (was lines ~15865-16634) —
 * a second, previously-undiscovered Finance module physically coded inside Bookings’ own script
 * range: Expense Tracking, Manual Transaction / Log Adjustment, Bank Statement Import & Matching,
 * and Reconciliation. NOT part of the initFinanceManagement closure extracted for js/admin/
 * financials.js (Section 16) — separate finance territory, confirmed by grep: no shared state,
 * no cross-calls either direction with core Bookings (pipeline/deal-view/payment/calendar-sync).
 *
 * CROSS-FILE DEPENDENCY: `const R_FMT` (currency formatter, defined in the Reconciliation section)
 * is consumed by js/admin/financials.js (9 call sites: chart tooltips, aging values, invoice list,
 * donut/cash-flow charts) as a bare global — a top-level `const` in a classic script joins the
 * shared global lexical environment, so this file must keep loading BEFORE financials.js (it does:
 * right after bookings-contracts.js, financials.js is far later in the load order). Conversely,
 * this file calls `loadFinancialStats()` (window-attached in financials.js) from inside a
 * setTimeout in a click handler — fires long after every script has loaded, so load order there
 * doesn’t matter.
 *
 * Every function reachable from an inline onclick/onchange attribute in the section markup was
 * already window-attached in the original source (13 window.X = … lines) — no new attachments
 * needed. hexToRgb / EXPENSE_CATEGORY_LABELS / EXPENSE_CATEGORY_COLORS / calcMileageAmount /
 * calcPerDiemAmount and the module-local caches are used only within this block. */
    // ─── EXPENSE TRACKING ───────────────────────────────────────

    const EXPENSE_CATEGORY_LABELS = {
        mileage: 'Mileage', airfare: 'Airfare', accommodation: 'Accommodation',
        meals: 'Meals', per_diem: 'Per Diem', parking_tolls: 'Parking & Tolls',
        marketing: 'Marketing', props: 'Props', misc: 'Misc'
    };
    const EXPENSE_CATEGORY_COLORS = {
        mileage: 'var(--atl-blue)', airfare: 'var(--atl-purple)', accommodation: 'var(--atl-orange)',
        meals: 'var(--atl-sage)', per_diem: 'var(--atl-blue)', parking_tolls: 'var(--atl-muted-dim)',
        marketing: '#E91E63', props: '#FF5722', misc: '#888'
    };

    // Load all expenses (Finance > Expenses tab)
    var _expensesCache = [];
    window.loadExpensesTab = async function() {
        const category = $('#expenseCategoryFilter').val();
        const dateFrom = $('#expenseDateFrom').val();
        const dateTo = $('#expenseDateTo').val();
        let qs = '';
        if (category) qs += '&category=' + encodeURIComponent(category);
        if (dateFrom) qs += '&date_from=' + encodeURIComponent(dateFrom);
        if (dateTo)   qs += '&date_to=' + encodeURIComponent(dateTo);

        $('#finExpensesList').html('<tr><td colspan="7" class="text-center"><i class="fa fa-spinner fa-spin"></i> Loading…</td></tr>');
        try {
            const d = await apiCall('/api/admin/expenses?' + qs.replace(/^&/,''), 'GET');
            const expenses = d.expenses || [];
            _expensesCache = expenses;

            if (!expenses.length) {
                $('#finExpensesList').html('<tr><td colspan="7" class="text-center" style="color:var(--atl-muted-dim);">No expenses found.</td></tr>');
                $('#expensesGrandTotal').text('');
                $('#expenseCategoryTotals').html('');
                return;
            }

            // Render rows
            $('#finExpensesList').html(expenses.map(e => {
                const cat = EXPENSE_CATEGORY_LABELS[e.category] || e.category;
                const color = EXPENSE_CATEGORY_COLORS[e.category] || '#888';
                const bookingRef = e.event_name ? `<span style="font-size:11px;color: var(--atl-muted);">#${e.booking_id} – ${e.event_name}</span>` : '<span style="color:#555;font-size:11px;">—</span>';
                return `<tr>
                    <td style="font-size:12px;">${new Date(e.expense_date).toLocaleDateString('en-ZA')}</td>
                    <td><span style="background:rgba(${hexToRgb(color)},0.15);color:${color};border:1px solid ${color};padding:2px 8px;border-radius:20px;font-size:10px;font-weight:700;">${cat}</span></td>
                    <td style="font-size:13px;">${e.description}${e.vendor ? `<div style="font-size:11px;color:var(--atl-muted);margin-top:2px;">${e.vendor}</div>` : ''}</td>
                    <td>${bookingRef}</td>
                    <td style="font-weight:600;color: var(--atl-ink);">R ${parseFloat(e.amount).toLocaleString('en-ZA',{minimumFractionDigits:2})}</td>
                    <td style="white-space:nowrap;">
                        <button class="atl-btn atl-btn--ghost" onclick="editExpense(${e.id})" style="padding:4px 8px;border-radius:4px;margin-right:4px;" title="Edit"><i class="fa-solid fa-pen-to-square" style="font-size:12px;color:var(--atl-blue);"></i></button>
                        <button class="atl-btn atl-btn--danger" onclick="deleteExpense(${e.id})" style="background:rgba(248,113,113,0.15);color:var(--atl-clay);border:1px solid rgba(248,113,113,0.3);border-radius:4px;padding:4px 8px;" title="Delete"><i class="fa-solid fa-trash-can" style="font-size:12px;"></i></button>
                    </td>
                </tr>`;
            }).join(''));

            // Grand total
            const total = expenses.reduce((s, e) => s + parseFloat(e.amount || 0), 0);
            $('#expensesGrandTotal').text('Grand Total: R ' + total.toLocaleString('en-ZA', {minimumFractionDigits: 2}));

            // Category totals strip
            const catTotals = {};
            expenses.forEach(e => { catTotals[e.category] = (catTotals[e.category] || 0) + parseFloat(e.amount || 0); });
            $('#expenseCategoryTotals').html(Object.entries(catTotals).map(([k, v]) => {
                const color = EXPENSE_CATEGORY_COLORS[k] || '#888';
                return `<span style="background:rgba(${hexToRgb(color)},0.12);color:${color};border:1px solid ${color};padding:4px 10px;border-radius:20px;font-size:11px;font-weight:700;">${EXPENSE_CATEGORY_LABELS[k] || k}: R ${v.toLocaleString('en-ZA', {minimumFractionDigits:2})}</span>`;
            }).join(''));
        } catch(e) {
            $('#finExpensesList').html('<tr><td colspan="7" class="text-center" style="color:var(--atl-clay);">Failed to load expenses.</td></tr>');
        }
    };

    function hexToRgb(hex) {
        const r = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
        return r ? parseInt(r[1],16)+','+parseInt(r[2],16)+','+parseInt(r[3],16) : '128,128,128';
    }

    // Delete an expense
    window.deleteExpense = async function(id) {
        const confirmed = window.notificationService ? await window.notificationService.showConfirm({
            title: 'Delete Expense',
            message: 'Are you sure you want to delete this expense?',
            isDestructive: true
        }) : confirm('Delete this expense?');
        if (!confirmed) return;
        try {
            const d = await apiCall('/api/admin/expenses/' + id, 'DELETE');
            if (d.success) {
                loadExpensesTab();
                loadFinancialStats();
            } else {
                window.notificationService && window.notificationService.showError(d.message || 'Delete failed.');
            }
        } catch(e) {
            window.notificationService && window.notificationService.showError('Network error.');
        }
    };

    // Load P&L for a specific booking (used in booking detail)
    async function loadBookingPL(bookingId) {
        try {
            const d = await apiCall(`/api/admin/bookings/${bookingId}/expenses`, 'GET');
            const gross = parseFloat(d.gross_revenue || 0);
            const exp = parseFloat(d.total_expenses || 0);
            const net = gross - exp;
            const netColor = net >= 0 ? 'var(--atl-green)' : 'var(--atl-clay)';
            $(`#bkPLCard-${bookingId}`).html(`
                <div style="font-size:11px;color: var(--atl-muted);font-weight:700;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:8px;"><i class="fa-solid fa-chart-pie" style="margin-right:5px;color: var(--atl-amber);"></i>Profit & Loss</div>
                <div style="display:flex;justify-content:space-between;margin-bottom:3px;">
                    <span style="color:#aaa;">Gross Revenue:</span>
                    <span style="color:var(--atl-green);font-weight:600;">R ${gross.toLocaleString('en-ZA',{minimumFractionDigits:2})}</span>
                </div>
                <div style="display:flex;justify-content:space-between;margin-bottom:3px;">
                    <span style="color:#aaa;">Expenses:</span>
                    <span style="color:var(--atl-clay);font-weight:600;">R ${exp.toLocaleString('en-ZA',{minimumFractionDigits:2})}</span>
                </div>
                <div style="display:flex;justify-content:space-between;padding-top:6px;border-top: 1px solid var(--atl-line);">
                    <span style="color: var(--atl-amber);font-weight:700;font-size:13px;">Net Profit:</span>
                    <span style="color:${netColor};font-weight:800;font-size:14px;">R ${net.toLocaleString('en-ZA',{minimumFractionDigits:2})}</span>
                </div>
            `);
        } catch(e) {
            $(`#bkPLCard-${bookingId}`).html('<span style="color:#555;font-size:11px;">P&L unavailable</span>');
        }
    }

    // Open expense modal pre-filled with a booking
    window.openExpenseModal = function(bookingId) {
        $('#expenseCategory').val('');
        $('#expenseAmount').val('');
        $('#expenseDescription').val('');
        $('#expenseDate').val(new Date().toISOString().split('T')[0]);
        $('#expenseReceiptUrl').val('');
        $('#expenseModalMsg').text('');
        $('#expenseModalBookingId').val(bookingId || '');
        // Pre-select booking in dropdown
        if (bookingId) {
            const $opt = $('#expenseBookingSelect option[value="' + bookingId + '"]');
            if ($opt.length) $opt.prop('selected', true);
            else $('#expenseBookingSelect').val('');
        } else {
            $('#expenseBookingSelect').val('');
        }
        openAtlDrawer('expenseDrawer');
    };

    // Populate booking dropdown in expense modal
    async function populateExpenseBookingList() {
        try {
            const d = await apiCall('/api/admin/bookings', 'GET');
            const list = Array.isArray(d) ? d : (d.bookings || []);
            const $sel = $('#expenseBookingSelect');
            $sel.find('option:not(:first)').remove();
            list.forEach(b => {
                $sel.append(`<option value="${b.id}">#${b.id} – ${b.event_name || b.name || 'Booking'} (${b.date || ''})</option>`);
            });
        } catch(e) {
            console.error('Failed to load bookings for expense association:', e);
            window.notificationService.showError('Could not load bookings for expense association — the dropdown will be empty.');
        }
    }
    populateExpenseBookingList();

    // Receipt file upload handler
    $(document).on('change', '#expenseReceiptFile', async function() {
        const file = this.files[0];
        if (!file) return;
        $('#expReceiptUploadStatus').css('color','var(--atl-muted)').text('Uploading…');
        const fd = new FormData();
        fd.append('receipt', file);
        try {
            const resp = await fetch('/api/admin/expenses/upload-receipt', { method: 'POST', body: fd, credentials: 'same-origin' });
            const d = await resp.json();
            if (d.success) {
                $('#expenseReceiptUrl').val(d.url);
                $('#expReceiptUploadStatus').css('color','var(--atl-sage)').html('<i class="fa-solid fa-circle-check" style="margin-right:4px;"></i>' + (d.filename || file.name) + ' uploaded');
            } else {
                $('#expReceiptUploadStatus').css('color','var(--atl-clay)').text(d.message || 'Upload failed.');
            }
        } catch(e) {
            $('#expReceiptUploadStatus').css('color','var(--atl-clay)').text('Network error.');
        }
        $(this).val('');
    });

    // Mileage/per diem auto-show and amount calculator
    var _expenseEditMode = false;
    $(document).on('change.expcat', '#expenseCategory', function() {
        var cat = $(this).val();
        $('#expMileageBlock').toggle(cat === 'mileage');
        $('#expPerDiemBlock').toggle(cat === 'per_diem');
    });
    function calcMileageAmount() {
        var start = parseFloat($('#expStartOdo').val()) || 0;
        var end   = parseFloat($('#expEndOdo').val())   || 0;
        var rate  = parseFloat($('#expRatePerKm').val()) || 0;
        if (end > start && rate > 0) {
            var km = end - start;
            $('#expTotalKm').val(km);
            $('#expenseAmount').val((km * rate).toFixed(2));
        } else {
            $('#expTotalKm').val('');
        }
    }
    function calcPerDiemAmount() {
        var days = parseFloat($('#expPerDiemDays').val()) || 0;
        var rate = parseFloat($('#expPerDiemRate').val()) || 0;
        if (days > 0 && rate > 0) $('#expenseAmount').val((days * rate).toFixed(2));
    }
    $(document).on('input.expodo', '#expStartOdo, #expEndOdo, #expRatePerKm', calcMileageAmount);
    $(document).on('input.exppd', '#expPerDiemDays, #expPerDiemRate', calcPerDiemAmount);

    // Save expense (create or edit)
    $(document).off('click.expsave').on('click.expsave', '#expenseSaveBtn', async function() {
        const category = $('#expenseCategory').val();
        const amount = $('#expenseAmount').val();
        const description = $('#expenseDescription').val().trim();
        const expense_date = $('#expenseDate').val();
        const booking_id = $('#expenseBookingSelect').val() || null;
        const receipt_url = $('#expenseReceiptUrl').val().trim();

        if (!category) { $('#expenseModalMsg').css('color','var(--atl-clay)').text('Please select a category.'); return; }
        if (!amount || parseFloat(amount) <= 0) { $('#expenseModalMsg').css('color','var(--atl-clay)').text('Enter a valid amount greater than zero.'); return; }
        if (!description) { $('#expenseModalMsg').css('color','var(--atl-clay)').text('Description is required.'); return; }
        if (!expense_date) { $('#expenseModalMsg').css('color','var(--atl-clay)').text('Date is required.'); return; }

        const payload = {
            booking_id, category, amount: parseFloat(amount), description, expense_date, receipt_url,
            vendor: $('#expenseVendor').val().trim() || null,
            start_odometer: parseInt($('#expStartOdo').val()) || null,
            end_odometer:   parseInt($('#expEndOdo').val())   || null,
            rate_per_km:    parseFloat($('#expRatePerKm').val()) || null,
            per_diem_days:  parseFloat($('#expPerDiemDays').val()) || null,
            per_diem_rate:  parseFloat($('#expPerDiemRate').val()) || null,
            vat_paid:       parseFloat($('#expVatPaid').val()) || null,
            vat_rate:       parseFloat($('#expVatRate').val()) || null
        };

        const $btn = $(this);
        $btn.prop('disabled', true).html('<i class="fa-solid fa-spinner fa-spin" style="margin-right:6px;"></i>Saving…');
        try {
            const editId = $('#expenseEditId').val();
            const url    = _expenseEditMode && editId ? '/api/admin/expenses/' + editId : '/api/admin/expenses';
            const method = _expenseEditMode && editId ? 'PUT' : 'POST';
            const d = await apiCall(url, method, payload);
            if (d.success) {
                $('#expenseModalMsg').css('color','var(--atl-sage)').html('<i class="fa-solid fa-circle-check" style="margin-right:5px;"></i>' + (_expenseEditMode ? 'Expense updated!' : 'Expense saved!'));
                setTimeout(() => { closeAtlDrawer('expenseDrawer'); }, 800);
                loadExpensesTab();
                loadFinancialStats();
                if (booking_id) loadBookingPL(booking_id);
            } else {
                $('#expenseModalMsg').css('color','var(--atl-clay)').text(d.message || 'Save failed.');
            }
        } catch(e) {
            $('#expenseModalMsg').css('color','var(--atl-clay)').text('Network error. Please try again.');
        } finally {
            $btn.prop('disabled', false).html('<i class="fa-solid fa-floppy-disk" style="margin-right:6px;"></i>Save Expense');
        }
    });

    // Reset expense drawer on close
    (function() {
        var _expDrawerEl = document.getElementById('expenseDrawer');
        if (!_expDrawerEl) return;
        new MutationObserver(function(mutations) {
            mutations.forEach(function(m) {
                if (m.attributeName === 'class' && !_expDrawerEl.classList.contains('atl-drawer--open')) {
                    _expenseEditMode = false;
                    $('#expenseEditId').val('');
                    $('#expenseDrawerLabel').html('Log Expense');
                    $('#expenseCategory').val('').trigger('change.expcat');
                    $('#expenseAmount, #expenseDescription, #expenseVendor, #expenseReceiptUrl').val('');
                    $('#expStartOdo, #expEndOdo, #expTotalKm, #expRatePerKm').val('');
                    $('#expRatePerKm').val('4.84');
                    $('#expPerDiemDays, #expPerDiemRate').val('');
                    $('#expVatPaid').val('');
                    $('#expVatRate').val('15');
                    $('#expenseReceiptFile').val('');
                    $('#expReceiptUploadStatus').text('');
                    $('#expenseModalMsg').text('');
                }
            });
        }).observe(_expDrawerEl, { attributes: true });
    })();

    // Edit expense — populate modal with existing data
    window.editExpense = async function(id) {
        try {
            // Use cached rows from the current tab load; fall back to a fresh fetch if empty
            let cached = _expensesCache.find(e => e.id == id);
            if (!cached) {
                const d2 = await apiCall('/api/admin/expenses', 'GET');
                _expensesCache = d2.expenses || [];
                cached = _expensesCache.find(e => e.id == id);
            }
            if (!cached) { window.notificationService.showError('Could not load expense.'); return; }
            _expenseEditMode = true;
            $('#expenseEditId').val(id);
            $('#expenseDrawerLabel').html('<i class="fa-solid fa-pen-to-square" style="margin-right:8px;color:var(--atl-blue);"></i>Edit Expense');
            $('#expenseCategory').val(cached.category).trigger('change.expcat');
            $('#expenseAmount').val(cached.amount);
            $('#expenseDescription').val(cached.description);
            $('#expenseDate').val(cached.expense_date);
            $('#expenseBookingSelect').val(cached.booking_id || '');
            $('#expenseReceiptUrl').val(cached.receipt_url || '');
            $('#expenseVendor').val(cached.vendor || '');
            $('#expStartOdo').val(cached.start_odometer || '');
            $('#expEndOdo').val(cached.end_odometer || '');
            $('#expTotalKm').val(cached.total_km || '');
            $('#expRatePerKm').val(cached.rate_per_km || '4.84');
            $('#expPerDiemDays').val(cached.per_diem_days || '');
            $('#expPerDiemRate').val(cached.per_diem_rate || '');
            $('#expVatPaid').val(cached.vat_paid || '');
            $('#expVatRate').val(cached.vat_rate || '15');
            $('#expenseModalMsg').text('');
            openAtlDrawer('expenseDrawer');
        } catch(e) {
            window.notificationService.showError('Failed to load expense details.');
        }
    };

    // Finance sub-tab lazy-loads (migrated from Bootstrap shown.bs.tab to the atl-tab-bar #finTabBar)
    $(document).on('click', '#finTabBar .atl-tab-btn', function() {
        switch (this.getAttribute('data-um-tab')) {
            case 'finExpenses':       loadExpensesTab(); break;
            case 'finReconciliation': loadReconciliation(); loadBankLines(); break;
            case 'finReminders':      loadRemindersLog(); break;
            case 'finAnalytics':      loadFinAnalytics(); if (window.loadScheduleMismatches) window.loadScheduleMismatches(); break;
        }
    });

    // Expense CSV export — respects active filters
    $(document).on('click', '#expenseExportBtn', function() {
        var params = new URLSearchParams();
        var cat = $('#expenseCategoryFilter').val();
        var df  = $('#expenseDateFrom').val();
        var dt  = $('#expenseDateTo').val();
        if (cat) params.set('category', cat);
        if (df)  params.set('date_from', df);
        if (dt)  params.set('date_to', dt);
        window.location.href = '/api/admin/expenses/export?' + params.toString();
    });

    // ─── MANUAL TRANSACTION / LOG ADJUSTMENT ─────────────────────

    // Open modal — pre-set today's date and populate booking list
    $(document).on('click', '#logAdjustmentBtn', async function() {
        $('#manualTxDate').val(new Date().toISOString().split('T')[0]);
        $('#manualTxAmount, #manualTxReference, #manualTxNotes').val('');
        $('#manualTxType').val('payment').trigger('change');
        $('#manualTxDirection').val('credit');
        $('#manualTxMethod').val('');
        $('#manualTxMsg').text('');
        var $sel = $('#manualTxBooking').empty().append('<option value="">— No booking —</option>');
        try {
            var bd = await apiCall('/api/admin/bookings', 'GET');
            var list = Array.isArray(bd) ? bd : (bd.bookings || []);
            list.forEach(function(b) {
                $sel.append('<option value="' + b.id + '">#' + b.id + ' – ' + (b.name || '') + (b.event_name ? ' · ' + b.event_name : '') + '</option>');
            });
        } catch(e) {}
        openAtlDrawer('manualTxDrawer');
    });

    // Handle transaction type visibility toggles
    $(document).on('change', '#manualTxType', function() {
        const type = $(this).val();
        $('#manualTxDirBlock').toggle(type === 'adjustment');
        $('#manualTxMethodBlock').toggle(type !== 'adjustment');
    });

    // Save manual transaction
    $(document).on('click', '#manualTxSaveBtn', async function() {
        var type   = $('#manualTxType').val();
        var amount = $('#manualTxAmount').val();
        var date   = $('#manualTxDate').val();
        if (!amount || parseFloat(amount) <= 0) { $('#manualTxMsg').css('color','var(--atl-clay)').text('Enter a valid amount greater than zero.'); return; }
        if (!date) { $('#manualTxMsg').css('color','var(--atl-clay)').text('Date is required.'); return; }

        var payload = {
            transaction_type:  type,
            amount:            parseFloat(amount),
            transaction_date:  date,
            payment_method:    type === 'adjustment' ? null : ($('#manualTxMethod').val() || null),
            reference:         $('#manualTxReference').val().trim() || null,
            notes:             $('#manualTxNotes').val().trim() || null,
            booking_id:        $('#manualTxBooking').val() || null
        };
        if (type === 'adjustment') {
            payload.direction = $('#manualTxDirection').val();
        }

        var $btn = $(this);
        $btn.prop('disabled', true).html('<i class="fa-solid fa-spinner fa-spin" style="margin-right:6px;"></i>Saving…');
        try {
            var d = await apiCall('/api/admin/transactions/manual', 'POST', payload);
            if (d.success) {
                $('#manualTxMsg').css('color','var(--atl-sage)').html('<i class="fa-solid fa-circle-check" style="margin-right:5px;"></i>Transaction logged!');
                setTimeout(function() { closeAtlDrawer('manualTxDrawer'); loadFinancialStats(); }, 900);
            } else {
                $('#manualTxMsg').css('color','var(--atl-clay)').text(d.message || 'Save failed.');
            }
        } catch(e) {
            $('#manualTxMsg').css('color','var(--atl-clay)').text('Network error. Please try again.');
        } finally {
            $btn.prop('disabled', false).html('<i class="fa-solid fa-floppy-disk" style="margin-right:6px;"></i>Log Transaction');
        }
    });

    // ─── BANK STATEMENT IMPORT & MATCHING ────────────────────────

    var _bankUnmatchedOnly = false;

    window.loadBankLines = async function() {
        var batchId = $('#bankBatchSelect').val();
        var qs = '';
        if (batchId) qs += '&batch_id=' + encodeURIComponent(batchId);
        if (_bankUnmatchedOnly) qs += '&unmatched_only=1';
        try {
            var d = await apiCall('/api/admin/bank-statement/lines?' + qs.replace(/^&/,''), 'GET');
            // Populate batch dropdown
            var $bs = $('#bankBatchSelect');
            var cur = $bs.val();
            $bs.find('option:not(:first)').remove();
            (d.batches || []).forEach(function(b) {
                $bs.append('<option value="' + b.import_batch + '">' + b.import_batch + ' (' + b.import_date + ', ' + b.line_count + ' lines, ' + b.unmatched_count + ' unmatched)</option>');
            });
            if (cur) $bs.val(cur);
            $('#bankDeleteBatchBtn').toggle(!!$bs.val());

            var lines = d.lines || [];
            if (!lines.length) {
                $('#bankLinesSection').toggle(d.batches && d.batches.length > 0);
                $('#bankLinesList').html('<tr><td colspan="6" class="text-center" style="color:var(--atl-muted-dim);">' + (_bankUnmatchedOnly ? 'All lines matched.' : 'No lines found. Import a CSV.') + '</td></tr>');
                return;
            }
            $('#bankLinesSection').show();
            $('#bankLinesList').html(lines.map(function(l) {
                var isMatched = l.matched_booking_id || l.matched_transaction_id;
                var matchBadge = isMatched
                    ? '<span style="font-size:10px;background:rgba(74,222,128,0.15);color:var(--atl-sage);border:1px solid var(--atl-sage);padding:1px 7px;border-radius:10px;font-weight:700;">✓ Matched' + (l.matched_client ? ' · ' + l.matched_client : '') + '</span>'
                    : '<span style="font-size:10px;background:rgba(251,191,36,0.12);color:var(--atl-amber);border:1px solid var(--atl-amber);padding:1px 7px;border-radius:10px;font-weight:700;">Unmatched</span>';
                var amtStyle = l.amount < 0 ? 'color:var(--atl-clay);' : 'color:var(--atl-sage);';
                var matchBtn = isMatched
                    ? '<button class="atl-btn atl-btn--ghost" style="font-size:11px;padding:3px 8px;" onclick="unmatchBankLine(' + l.id + ')">Unmatch</button>'
                    : '<button class="atl-btn atl-btn--ghost" style="font-size:11px;padding:3px 8px;" onclick="openBankMatchRow(' + l.id + ', this)">Match</button>';
                return '<tr id="bsl-row-' + l.id + '">'
                    + '<td style="white-space:nowrap;">' + (l.statement_date || '') + '</td>'
                    + '<td style="max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="' + (l.description||'').replace(/"/g,'&quot;') + '">' + (l.description || '') + '</td>'
                    + '<td style="text-align:right;font-weight:600;' + amtStyle + '">R ' + parseFloat(l.amount).toLocaleString('en-ZA',{minimumFractionDigits:2}) + '</td>'
                    + '<td style="color:var(--atl-muted);">' + (l.reference || '—') + '</td>'
                    + '<td>' + matchBadge + '</td>'
                    + '<td style="white-space:nowrap;">' + matchBtn + ' <button class="atl-btn atl-btn--ghost" style="font-size:11px;padding:3px 6px;color:var(--atl-clay);" onclick="deleteBankLine(' + l.id + ')" title="Remove line"><i class="fa-solid fa-trash-can"></i></button></td>'
                    + '</tr>';
            }).join(''));
        } catch(e) {
            $('#bankImportStatus').css('color','var(--atl-clay)').text('Failed to load bank lines.');
        }
    };

    // Import CSV
    $(document).on('change', '#bankStatementFile', async function() {
        var file = this.files[0];
        if (!file) return;
        $('#bankImportStatus').css('color','var(--atl-muted)').text('Importing…');
        var fd = new FormData();
        fd.append('statement', file);
        try {
            var resp = await fetch('/api/admin/bank-statement/import', { method: 'POST', body: fd, credentials: 'same-origin' });
            var d = await resp.json();
            if (d.success) {
                $('#bankImportStatus').css('color','var(--atl-sage)').html('<i class="fa-solid fa-circle-check" style="margin-right:4px;"></i>' + d.imported + ' lines imported (batch ' + d.batch_id + ')');
                $('#bankBatchSelect').val(d.batch_id);
                $('#bankDeleteBatchBtn').show();
                await loadBankLines();
            } else {
                $('#bankImportStatus').css('color','var(--atl-clay)').text(d.message || 'Import failed.');
            }
        } catch(e) {
            $('#bankImportStatus').css('color','var(--atl-clay)').text('Network error.');
        }
        $(this).val('');
    });

    // Batch filter change
    $(document).on('change', '#bankBatchSelect', function() {
        $('#bankDeleteBatchBtn').toggle(!!$(this).val());
        loadBankLines();
    });

    // Toggle unmatched filter
    $(document).on('click', '#bankToggleUnmatched', function() {
        _bankUnmatchedOnly = !_bankUnmatchedOnly;
        $(this).toggleClass('atl-btn--primary', _bankUnmatchedOnly).toggleClass('atl-btn--ghost', !_bankUnmatchedOnly);
        loadBankLines();
    });

    // Delete a batch
    $(document).on('click', '#bankDeleteBatchBtn', async function() {
        var batchId = $('#bankBatchSelect').val();
        if (!batchId) return;
        if (!await window.notificationService.showConfirm({ message: 'Delete all lines in batch ' + batchId + '?', isDestructive: true })) return;
        await apiCall('/api/admin/bank-statement/batch/' + encodeURIComponent(batchId), 'DELETE');
        $('#bankBatchSelect').val('');
        loadBankLines();
    });

    // Remove a single line
    window.deleteBankLine = async function(id) {
        await apiCall('/api/admin/bank-statement/lines/' + id, 'DELETE');
        loadBankLines();
    };

    // Unmatch a line
    window.unmatchBankLine = async function(id) {
        await apiCall('/api/admin/bank-statement/lines/' + id + '/match', 'PATCH', { booking_id: null, transaction_id: null });
        loadBankLines();
    };

    // Inline match — replace the row's action cell with a booking select + confirm
    window.openBankMatchRow = async function(id, btn) {
        var $row = $('#bsl-row-' + id);
        var $actionCell = $row.find('td:last');
        $actionCell.html('<i class="fa fa-spinner fa-spin" style="margin-right:4px;"></i>Loading…');
        try {
            var bd = await apiCall('/api/admin/bookings', 'GET');
            var list = Array.isArray(bd) ? bd : (bd.bookings || []);
            var opts = '<option value="">— Select booking —</option>' + list.map(function(b) {
                return '<option value="' + b.id + '">#' + b.id + ' – ' + (b.name || '') + (b.event_name ? ' · ' + b.event_name : '') + '</option>';
            }).join('');
            $actionCell.html(
                '<select id="bsl-match-sel-' + id + '" class="atl-input" style="font-size:11px;width:auto;max-width:160px;background:var(--atl-card);color:var(--atl-ink);">' + opts + '</select>'
                + ' <button class="atl-btn atl-btn--primary" style="font-size:11px;padding:3px 8px;" onclick="confirmBankMatch(' + id + ')">Confirm</button>'
                + ' <button class="atl-btn atl-btn--ghost" style="font-size:11px;padding:3px 6px;" onclick="loadBankLines()">✕</button>'
            );
        } catch(e) {
            $actionCell.html('<span style="color:var(--atl-clay);font-size:11px;">Error</span>');
        }
    };

    window.confirmBankMatch = async function(id) {
        var bookingId = $('#bsl-match-sel-' + id).val();
        if (!bookingId) { window.notificationService.showError('Select a booking to match.'); return; }
        await apiCall('/api/admin/bank-statement/lines/' + id + '/match', 'PATCH', { booking_id: parseInt(bookingId) });
        loadBankLines();
    };

    // (Reconciliation lazy-load handled by the #finTabBar switch above — loadBankLines + loadReconciliation)

    // ─── RECONCILIATION ─────────────────────────────────────────

    const R_FMT = (n) => 'R ' + parseFloat(n || 0).toLocaleString('en-ZA', { minimumFractionDigits: 2 });

    window.loadReconciliation = async function() {
        $('#reconTableBody').html('<tr><td colspan="11" class="text-center"><i class="fa fa-spinner fa-spin"></i> Loading…</td></tr>');
        $('#reconSummary').html('');
        try {
            const d = await apiCall('/api/admin/reconciliation', 'GET');
            const filter = $('#reconWarnFilter').val();
            let rows = d.rows || [];
            window._reconRowsCache = rows;

            if (filter === 'warn') rows = rows.filter(r => r.has_both_sources || r.is_overpaid);
            if (filter === 'ok')   rows = rows.filter(r => !r.has_both_sources && !r.is_overpaid);

            // Summary bar
            if (d.summary) {
                const s = d.summary;
                const net = parseFloat(s.total_received || 0) - parseFloat(s.total_duplicates_flagged || 0);
                $('#reconSummary').html(`
                    <div style="flex:1;min-width:160px;">
                        <div style="font-size:11px;color: var(--atl-muted);text-transform:uppercase;letter-spacing:0.6px;">Total Quoted</div>
                        <div style="font-size:20px;font-weight:800;color: var(--atl-ink);">${R_FMT(s.total_quoted)}</div>
                    </div>
                    <div style="flex:1;min-width:160px;">
                        <div style="font-size:11px;color: var(--atl-muted);text-transform:uppercase;letter-spacing:0.6px;">Total Received (Effective)</div>
                        <div style="font-size:20px;font-weight:800;color:var(--atl-green);">${R_FMT(s.total_received)}</div>
                    </div>
                    <div style="flex:1;min-width:160px;">
                        <div style="font-size:11px;color: var(--atl-muted);text-transform:uppercase;letter-spacing:0.6px;">Duplicates Flagged</div>
                        <div style="font-size:20px;font-weight:800;color:var(--atl-clay);">${R_FMT(s.total_duplicates_flagged)}</div>
                    </div>
                    <div style="flex:1;min-width:160px;">
                        <div style="font-size:11px;color: var(--atl-muted);text-transform:uppercase;letter-spacing:0.6px;">Balance Outstanding</div>
                        <div style="font-size:20px;font-weight:800;color:var(--atl-orange);">${R_FMT(parseFloat(s.total_quoted) - parseFloat(s.total_received))}</div>
                    </div>
                `);
            }

            if (!rows.length) {
                $('#reconTableBody').html('<tr><td colspan="11" class="text-center" style="color:var(--atl-muted-dim);">No bookings found.</td></tr>');
                return;
            }

            $('#reconTableBody').html(rows.map(r => {
                const warnDual  = r.has_both_sources;
                const warnOver  = r.is_overpaid;
                const rowBg     = warnOver ? 'rgba(239,83,80,0.07)' : warnDual ? 'rgba(255,152,0,0.07)' : 'transparent';
                const warnBadge = warnOver
                    ? '<span style="background:rgba(248,113,113,0.15);color:var(--atl-clay);border:1px solid var(--atl-clay);padding:2px 8px;border-radius:20px;font-size:10px;font-weight:700;">OVERPAID</span>'
                    : warnDual
                    ? '<span style="background:rgba(251,146,60,0.15);color:var(--atl-orange);border:1px solid var(--atl-orange);padding:2px 8px;border-radius:20px;font-size:10px;font-weight:700;">⚠ DUAL SOURCE</span>'
                    : '<span style="color:var(--atl-green);font-size:12px;"><i class="fa-solid fa-circle-check"></i></span>';

                const psColor = r.payment_status === 'PAID' ? 'var(--atl-green)' : r.payment_status === 'UNPAID' ? 'var(--atl-clay)' : 'var(--atl-orange)';
                const effectiveColor = warnOver ? 'var(--atl-clay)' : 'var(--atl-ink)';

                return `
                    <tr data-booking-id="${r.booking_id}" style="background:${rowBg}; cursor:pointer;" class="recon-row">
                        <td style="text-align:center;" data-label="Details"><i class="fa-solid fa-chevron-right recon-chevron-${r.booking_id}" style="font-size:10px;color:var(--atl-muted-dim);transition:transform 0.2s;"></i></td>
                        <td style="font-size:12px;color: var(--atl-muted);" data-label="ID">#${r.booking_id}</td>
                        <td data-label="Client / Event">
                            <div style="font-weight:600;font-size:13px;">${r.client_name || '—'}</div>
                            <div style="font-size:11px;color: var(--atl-muted);">${r.event_name || ''}</div>
                        </td>
                        <td style="font-size:12px;" data-label="Date">${r.event_date ? new Date(r.event_date).toLocaleDateString('en-ZA') : '—'}</td>
                        <td style="font-weight:600;" data-label="Quoted">${R_FMT(r.quoted_amount)}</td>
                        <td style="color:#2196F3;" data-label="PayFast">${R_FMT(r.payfast_total)}</td>
                        <td style="color:#9C27B0;" data-label="Manual">${R_FMT(r.manual_total)}</td>
                        <td style="color:${effectiveColor};font-weight:700;" data-label="Effective">${R_FMT(r.effective_received)}</td>
                        <td style="color:var(--atl-orange);" data-label="Outstanding">${R_FMT(r.outstanding)}</td>
                        <td data-label="Status"><span style="color:${psColor};font-size:11px;font-weight:700;">${r.payment_status || '—'}</span></td>
                        <td data-label="Warning">${warnBadge}</td>
                    </tr>
                    <tr id="recon-detail-${r.booking_id}" style="display:none;background:#0d0d0d;">
                        <td colspan="11" style="padding:0;">
                            <div id="recon-detail-inner-${r.booking_id}" style="padding:16px 24px;border-top:1px dashed #2a2a2a;"></div>
                        </td>
                    </tr>
                `;
            }).join(''));

        } catch(e) {
            $('#reconTableBody').html('<tr><td colspan="11" class="text-center" style="color:var(--atl-clay);">Failed to load reconciliation data.</td></tr>');
        }
    };

    // Expand/collapse a booking's individual transactions
    window.toggleReconDetail = async function(bookingId, rowEl) {
        const $detail = $(`#recon-detail-${bookingId}`);
        const $chevron = $(`.recon-chevron-${bookingId}`);
        const $inner   = $(`#recon-detail-inner-${bookingId}`);

        if ($detail.is(':visible')) {
            $detail.hide();
            $chevron.css('transform', '');
            return;
        }
        $detail.show();
        $chevron.css('transform', 'rotate(90deg)');
        $inner.html('<i class="fa fa-spinner fa-spin" style="color: var(--atl-muted);"></i> Loading transactions…');

        try {
            const d = await apiCall(`/api/admin/reconciliation/${bookingId}/transactions`, 'GET');
            const txs = d.transactions || [];
            
            // Check for drift in window._reconRowsCache and render warning if found
            let driftWarning = '';
            if (window._reconRowsCache) {
                const rowData = window._reconRowsCache.find(r => r.booking_id == bookingId);
                if (rowData && Math.abs(parseFloat(rowData.amount_paid) - parseFloat(rowData.effective_received)) > 0.01) {
                    driftWarning = `
                        <div style="background:rgba(239,83,80,0.08); border:1px solid rgba(239,83,80,0.25); padding:12px 18px; border-radius:6px; margin-bottom:12px; display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:10px;">
                            <span style="color:var(--atl-clay); font-size:12px; font-weight:600;">
                                <i class="fa-solid fa-triangle-exclamation" style="margin-right:6px; color:var(--atl-orange);"></i>
                                Ledger Drift Detected: Booking paid is R ${parseFloat(rowData.amount_paid).toLocaleString('en-ZA',{minimumFractionDigits:2})}, but transaction ledger sums to R ${parseFloat(rowData.effective_received).toLocaleString('en-ZA',{minimumFractionDigits:2})}.
                            </span>
                            <button class="atl-btn atl-btn--primary" style="font-size:11px; padding:4px 12px; border-radius:4px;" onclick="window.syncBookingLedger(${bookingId}, this)">
                                <i class="fa-solid fa-rotate" style="margin-right:4px;"></i>Sync Ledger
                            </button>
                        </div>
                    `;
                }
            }

            if (!txs.length) {
                $inner.html((driftWarning || '') + '<p style="color:var(--atl-muted-dim);font-size:12px;margin:0;">No completed transactions recorded for this booking.</p>');
                return;
            }
            $inner.html((driftWarning || '') + `
                <table style="width:100%;font-size:12px;color: var(--atl-ink-dim);border-collapse:collapse;">
                    <thead>
                        <tr style="color: var(--atl-muted);text-transform:uppercase;letter-spacing:0.5px;font-size:10px;">
                            <th style="padding:6px 10px;">Date</th>
                            <th>Source</th>
                            <th>Method</th>
                            <th>Reference</th>
                            <th>Amount</th>
                            <th style="text-align:center;">Duplicate?</th>
                            <th>Note</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${txs.map(t => {
                            const srcColor = t.source === 'payfast' ? '#2196F3' : '#9C27B0';
                            const isDupe = t.is_duplicate ? 1 : 0;
                            return `
                                <tr style="border-top:1px solid var(--atl-line);${isDupe ? 'opacity:0.5;' : ''}">
                                    <td style="padding:6px 10px;">${new Date(t.transaction_date).toLocaleDateString('en-ZA')}</td>
                                    <td><span style="color:${srcColor};font-weight:700;font-size:10px;text-transform:uppercase;">${t.source || 'manual'}</span></td>
                                    <td style="color:var(--atl-muted);">${t.payment_method || '—'}</td>
                                    <td style="color:var(--atl-muted-dim);font-size:11px;">${t.reference || '—'}</td>
                                    <td style="font-weight:600;color: var(--atl-ink);">${R_FMT(t.amount)}</td>
                                    <td style="text-align:center;">
                                        <input type="checkbox" title="Flag as duplicate (audit-safe)"
                                            data-tx-id="${t.id}" data-booking-id="${bookingId}"
                                            class="recon-dupe-chk" ${isDupe ? 'checked' : ''}
                                            style="accent-color:var(--atl-clay);width:16px;height:16px;cursor:pointer;">
                                    </td>
                                    <td>
                                        <input type="text" value="${t.reconcile_note || ''}" placeholder="Add note…"
                                            data-tx-id="${t.id}" class="recon-note-input"
                                            style="background: var(--atl-paper);border: 1px solid var(--atl-line);color: var(--atl-ink-dim);border-radius:4px;padding:2px 6px;font-size:11px;width:160px;">
                                    </td>
                                </tr>
                            `;
                        }).join('')}
                    </tbody>
                </table>
            `);
        } catch(e) {
            $inner.html('<p style="color:var(--atl-clay);font-size:12px;">Failed to load transactions.</p>');
        }
    };

    // Force sync booking ledger with transactions
    window.syncBookingLedger = async function(bookingId, btnEl) {
        var $btn = $(btnEl);
        var originalHtml = $btn.html();
        $btn.prop('disabled', true).html('<i class="fa-solid fa-spinner fa-spin" style="margin-right:4px;"></i>Syncing…');
        try {
            var d = await apiCall(`/api/admin/bookings/${bookingId}/reconcile/sync`, 'POST');
            if (d.success) {
                window.notificationService && window.notificationService.showSuccess('Ledger aligned successfully.');
                loadReconciliation();
            } else {
                window.notificationService && window.notificationService.showError(d.message || 'Sync failed.');
                $btn.prop('disabled', false).html(originalHtml);
            }
        } catch(e) {
            window.notificationService && window.notificationService.showError('Network error.');
            $btn.prop('disabled', false).html(originalHtml);
        }
    };

    // Flag/unflag a transaction as duplicate
    $(document).off('change.recon').on('change.recon', '.recon-dupe-chk', async function() {
        const txId = $(this).data('tx-id');
        const bookingId = $(this).data('booking-id');
        const isDupe = this.checked;
        const note = $(`.recon-note-input[data-tx-id="${txId}"]`).val() || '';
        try {
            const d = await apiCall(`/api/admin/transactions/${txId}/reconcile`, 'PATCH', { is_duplicate: isDupe ? 1 : 0, reconcile_note: note });
            if (!d.success) { this.checked = !isDupe; return; }
            // Dim/undim the row
            $(this).closest('tr').css('opacity', isDupe ? '0.4' : '1');
            // Reload the summary row silently
            loadReconciliation();
        } catch(e) { this.checked = !isDupe; }
    });

    // Save reconcile note on blur
    window.saveReconNote = async function(txId, note) {
        const isDupe = $(`.recon-dupe-chk[data-tx-id="${txId}"]`).is(':checked') ? 1 : 0;
        try { await apiCall(`/api/admin/transactions/${txId}/reconcile`, 'PATCH', { is_duplicate: isDupe, reconcile_note: note }); }
        catch(e) { console.error('Failed to save reconciliation note:', e); window.notificationService.showError('Failed to save reconciliation note.'); }
    };

    // (Reconciliation lazy-load handled by the #finTabBar switch above)
