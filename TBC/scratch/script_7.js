
(function initFinanceManagement() {
    'use strict';
    
    // Financial State
    let finStatsLoaded = false;

    // Helper for formatting currency
    function fmtCurr(val) {
        return 'R ' + parseFloat(val || 0).toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    }

    // 1. Load Financial Overview Stats
    window.loadFinancialStats = async function() {
        try {
            const res = await apiCall('/api/admin/financials/stats', 'GET');
            if (res && res.success) {
                $('#finStat-TotalRevenue').text(fmtCurr(res.stats.revenue));
                $('#finStat-Outstanding').text(fmtCurr(res.stats.outstanding));
                if (res.stats.monthly_expenses !== undefined) {
                    $('#finStat-Expenses').text(fmtCurr(res.stats.monthly_expenses));
                    const netColor = res.stats.net_profit_month >= 0 ? '#4CAF50' : '#ef5350';
                    $('#finStat-NetProfit').text(fmtCurr(res.stats.net_profit_month)).css('color', netColor);
                }
                
                // Fetch recent transactions
                if (res.recentTransactions) {
                    renderTransactions(res.recentTransactions);
                }
                
                // Fetch invoices
                const invRes = await apiCall('/api/admin/invoices', 'GET');
                if (invRes && !invRes.error) {
                    renderInvoices(invRes);
                }

                // Temporary: Estimate pending quotes from booking stats
                const quoteTotal = res.recentTransactions.reduce((acc, t) => acc + (t.status === 'pending' ? t.amount : 0), 0);
                $('#finStat-Pending').text(fmtCurr(quoteTotal));

            }
        } catch (e) {
            console.error("Finance Stats Error:", e);
        }
    };

    function renderTransactions(list) {
        const $body = $('#finTransactionsList');
        if (!$body.length) return;
        
        if (!list || list.length === 0) {
            $body.html('<tr><td colspan="6" class="text-center">No transactions recorded yet.</td></tr>');
            return;
        }

        $body.html(list.map(t => {
            const date = new Date(t.transaction_date).toLocaleDateString('en-ZA');
            const statusColor = t.status === 'completed' ? '#4CAF50' : (t.status === 'failed' ? '#F44336' : '#FF9800');
            return `<tr>
                <td>${date}</td>
                <td style="font-family:monospace; font-size:12px;">${t.reference || '—'}</td>
                <td>${t.client_name || 'Booking #' + t.booking_id}</td>
                <td><i class="fa-solid fa-credit-card" style="margin-right:6px; opacity:0.6;"></i>${t.payment_method || 'PayFast'}</td>
                <td style="font-weight:bold; color:#fff;">${fmtCurr(t.amount)}</td>
                <td><span style="color:${statusColor}; font-weight:bold; text-transform:uppercase; font-size:11px;">${t.status}</span></td>
            </tr>`;
        }).join(''));
    }

    var allInvoicesCache = [];

    function renderInvoices(list) {
        allInvoicesCache = list || [];
        applyInvoiceFilter();
    }

    window.loadRemindersLog = async function() {
        const $body = $('#finRemindersList');
        if (!$body.length) return;
        $body.html('<tr><td colspan="7" class="text-center"><i class="fa-solid fa-spinner fa-spin"></i> Loading...</td></tr>');
        try {
            const r = await apiCall('/api/admin/reminders?limit=200');
            if (!r || !r.success || !r.reminders || r.reminders.length === 0) {
                $body.html('<tr><td colspan="7" class="text-center text-muted">No reminders sent yet.</td></tr>');
                return;
            }
            $body.html(r.reminders.map(rem => {
                const sentAt = rem.sent_at ? new Date(rem.sent_at).toLocaleString('en-ZA') : '—';
                const sc = rem.status === 'sent' ? '#4CAF50' : '#F44336';
                return `<tr>
                    <td style="font-size:12px;color:#aaa;">${sentAt}</td>
                    <td>${rem.client_name || rem.recipient_email}</td>
                    <td><a href="#" class="bk-nav-link" style="color:#D4AF37;" data-id="${rem.booking_id}">#${rem.booking_id}</a></td>
                    <td>${rem.due_date || '—'}</td>
                    <td style="text-align:center;">${rem.days_before}d</td>
                    <td style="font-weight:700;color:#fff;">${rem.amount_due != null ? fmtCurr(rem.amount_due) : '—'}</td>
                    <td><span style="color:${sc};font-size:11px;font-weight:700;text-transform:uppercase;">${rem.status}</span>${rem.error_message ? `<br><span style="font-size:10px;color:#888;" title="${rem.error_message}">⚠ ${rem.error_message.substring(0,40)}</span>` : ''}</td>
                </tr>`;
            }).join(''));
        } catch(e) {
            $body.html('<tr><td colspan="7" class="text-center text-muted">Failed to load reminders.</td></tr>');
        }
    };

    window.applyInvoiceFilter = function() {
        const $body = $('#finInvoicesList');
        if (!$body.length) return;
        const filterVal = ($('#invoiceStatusFilter').val() || '').toUpperCase();
        const list = filterVal ? allInvoicesCache.filter(i => (i.status||'').toUpperCase() === filterVal) : allInvoicesCache;

        if (!list || list.length === 0) {
            $body.html('<tr><td colspan="6" class="text-center">No invoices match the selected filter.</td></tr>');
            return;
        }

        const statusColors = { PAID:'#4CAF50', OVERDUE:'#F44336', VOID:'#888', SENT:'#FF9800', DRAFT:'#aaa' };
        $body.html(list.map(inv => {
            const date = inv.invoice_date ? new Date(inv.invoice_date).toLocaleDateString('en-ZA') : '—';
            const sc = statusColors[inv.status] || '#aaa';
            const isVoided = inv.status === 'VOID';
            return `<tr>
                <td style="font-weight:bold; color:#D4AF37;">${inv.invoice_number}</td>
                <td>${date}</td>
                <td>${inv.client_name || 'Client'}</td>
                <td style="font-weight:bold;">${fmtCurr(inv.total_amount)}</td>
                <td><span style="color:${sc}; font-weight:bold; font-size:11px;">${inv.status}</span></td>
                <td style="white-space:nowrap;">
                    <a href="/api/admin/bookings/${inv.booking_id}/invoice/download" target="_blank" class="btn btn-xs btn-admin-secondary" title="Download"><i class="fa-solid fa-download"></i></a>
                    ${!isVoided ? `<button class="btn btn-xs btn-admin-secondary" style="margin-left:4px;" title="Resend email" onclick="sendInvoice(${inv.id})"><i class="fa-solid fa-paper-plane"></i></button>` : ''}
                    ${!isVoided ? `<button class="btn btn-xs" style="margin-left:4px;background:rgba(244,67,54,0.15);color:#F44336;border:1px solid rgba(244,67,54,0.3);" title="Void invoice" onclick="voidInvoice(${inv.id},'${inv.invoice_number}')"><i class="fa-solid fa-ban"></i></button>` : ''}
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

    window.voidInvoice = async function(id, num) {
        const reason = await window.notificationService.showPrompt({ 
            title: "Void Invoice",
            message: 'Reason for voiding invoice ' + num + ':',
            defaultValue: ""
        });
        if (reason === null) return;
        try {
            await apiCall('/api/admin/invoices/' + id + '/void', 'POST', { reason: reason || 'Voided by admin' });
            const invRes = await apiCall('/api/admin/invoices', 'GET');
            if (invRes && !invRes.error) renderInvoices(invRes);
        } catch(e) {}
    };

    window.generateInvoice = async function(bookingId) {
        const $btn = $(`#btnGenInvoice-${bookingId}`);
        const orig = $btn.html();
        $btn.prop('disabled', true).html('<i class="fa fa-spinner fa-spin"></i> Generating...');
        
        try {
            const res = await apiCall(`/api/admin/bookings/${bookingId}/invoice/generate`, 'POST');
            if (res.success) {
                window.notificationService.showSuccess('Success: Invoice PDF generated and dispatched. Booking updated.');
                $btn.html('<i class="fa-solid fa-check"></i> Regenerate Invoice').css('background','#4CAF50').css('color', '#fff').prop('disabled', false);
            } else {
                window.notificationService.showError('Error: ' + res.message);
                $btn.prop('disabled', false).html(orig);
            }
        } catch (e) {
            window.notificationService.showError('Failed to connect to server.');
            $btn.prop('disabled', false).html(orig);
        }
    };

    // --- Audit Log Logic ---
    window.loadAuditLogs = async function() {
        const body = qs('#auditLogsBody');
        if (!body) return;
        body.innerHTML = '<tr><td colspan="4" class="text-center" style="padding: 30px; opacity: 0.5;"><i class="fa fa-spinner fa-spin"></i> Refreshing trail...</td></tr>';

        try {
            const tableF = (qs('#auditTableFilter') && qs('#auditTableFilter').value) || '';
            const dateFrom = (qs('#auditDateFrom') && qs('#auditDateFrom').value) || '';
            const dateTo = (qs('#auditDateTo') && qs('#auditDateTo').value) || '';
            let auditUrl = '/api/admin/audit_log?limit=100';
            if (tableF) auditUrl += '&table=' + encodeURIComponent(tableF);
            if (dateFrom) auditUrl += '&date_from=' + encodeURIComponent(dateFrom);
            if (dateTo) auditUrl += '&date_to=' + encodeURIComponent(dateTo);
            const response = await fetch(auditUrl, { credentials: 'include' });
            if (response.status === 401) return;
            const res = await response.json();
            if (res && res.success && res.logs) {
                body.innerHTML = '';
                if (res.logs.length === 0) {
                    body.innerHTML = '<tr><td colspan="4" class="text-center" style="padding:40px; color:#666;">No audit events recorded yet.</td></tr>';
                    return;
                }
                res.logs.forEach(log => {
                    const tr = document.createElement('tr');
                    tr.style.borderBottom = '1px solid rgba(255,255,255,0.02)';
                    const date = new Date(log.change_timestamp || log.timestamp).toLocaleString();
                    const actionColor = log.action === 'UPDATE' ? '#FF9800' : (log.action === 'INSERT' ? '#4CAF50' : '#F44336');
                    
                    tr.innerHTML = `
                        <td style="padding:12px; font-weight:bold; color:#D4AF37;">${escHtml(log.table_name)} <span style="font-size:10px; opacity:0.5; font-weight:normal;">#${log.record_id}</span></td>
                        <td style="padding:12px; font-size:12px;">${escHtml(log.table_name === 'bookings' ? 'Bookings' : (log.table_name === 'users' ? 'Security' : 'Events'))}</td>
                        <td style="padding:12px;"><span style="color:${actionColor}; font-weight:bold; font-size:11px;">${escHtml(log.action)}</span></td>
                        <td style="padding:12px; font-size:11px; opacity:0.6;">${date}</td>
                    `;
                    body.appendChild(tr);
                });
            }
        } catch (e) {
            console.error("Audit Log Error:", e);
        }
    };

    // --- POPIA/GDPR Data Erasure ---
    (function() {
        const btn = document.getElementById('btnGdprDelete');
        if (!btn) return;
        btn.addEventListener('click', async function() {
            const emailEl = document.getElementById('gdprDeleteEmail');
            const resultEl = document.getElementById('gdprDeleteResult');
            const email = (emailEl && emailEl.value || '').trim();
            if (!email) { 
                window.notificationService.showError('Please enter a client email address.'); 
                return; 
            }
            if (!await window.notificationService.showConfirm({ 
                title: "Confirm Data Erasure",
                message: 'WARNING: This will permanently anonymize all personal data for ' + email + '. Financial records are retained as required by law. This cannot be undone. Proceed?',
                isDestructive: true 
            })) return;
            btn.disabled = true;
            btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Processing...';
            try {
                const r = await fetch('/api/admin/gdpr/delete', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ email })
                });
                const d = await r.json();
                if (d.success) {
                    window.notificationService.showSuccess(d.message || 'Data anonymized successfully.');
                    emailEl.value = '';
                } else {
                    window.notificationService.showError(d.message || 'Anonymization failed.');
                }
            } catch (e) {
                window.notificationService.showError('Network error: ' + e.message);
            } finally {
                btn.disabled = false;
                btn.innerHTML = '<i class="fa-solid fa-user-slash"></i> Anonymize';
            }
        });
    })();

    // --- Global Upload Zone Logic ---
    $(document).on('dragover dragenter', '.um-upload-zone', function(e) {
        e.preventDefault(); e.stopPropagation();
        $(this).addClass('um-upload-zone--active');
    });

    $(document).on('dragleave dragend drop', '.um-upload-zone', function(e) {
        e.preventDefault(); e.stopPropagation();
        $(this).removeClass('um-upload-zone--active');
    });

    $(document).on('change', '.um-file-input', function(e) {
        const files = e.target.files;
        const $zone = $(this).closest('.um-upload-zone');
        const $text = $zone.find('.um-upload-text');
        
        if (files && files.length > 0) {
            if (files.length === 1) {
                $text.text(files[0].name).css('color', '#D4AF37');
            } else {
                $text.text(files.length + ' files selected').css('color', '#D4AF37');
            }
        }
    });

    // Handle Drop manually for zones that don't have specific logic
    $(document).on('drop', '.um-upload-zone', function(e) {
        const files = e.originalEvent.dataTransfer.files;
        const inputId = $(this).attr('for');
        const $input = $('#' + inputId);
        
        if (files.length > 0 && $input.length > 0) {
            // For sections that don't auto-upload (like Events/About), we just set the input files
            // Home Slider has its own 'drop' listener which will handle the actual upload
            if (inputId !== 'homeFile') {
                $input[0].files = files;
                $input.trigger('change');
            }
        }
    });

    // --- Session Expiry Monitoring ---
    let sessionTimeoutSec = 7200; // 2 hours
    let lastActivity = Date.now();

    function updateSessionTimer() {
        const elapsed = Math.floor((Date.now() - lastActivity) / 1000);
        const remaining = sessionTimeoutSec - elapsed;
        const badge = qs('#sessionTimerBadge');
        
        if (remaining <= 300) { // 5 minutes left
            if (badge) {
                badge.textContent = Math.floor(remaining / 60) + "m REMAINING";
                badge.style.background = "rgba(244,67,54,0.2)";
                badge.style.color = "#F44336";
            }
        } else {
            if (badge) badge.textContent = "ACTIVE SESSION";
        }

        if (remaining <= 0) {
            window.notificationService.showInfo("Your session has expired for security. Please log in again.");
            window.location.href = 'admin.html';
        }
    }

    document.addEventListener('mousedown', () => lastActivity = Date.now());
    document.addEventListener('keydown', () => lastActivity = Date.now());
    setInterval(updateSessionTimer, 15000);

    // 3. Tab Bootstrap
    if (typeof $ !== 'undefined') {
        $('a[href="#homeAdmin"]').on('shown.bs.tab shown', function() {
            if (typeof fetchHomeSlider === 'function') fetchHomeSlider();
        });
        $('a[href="#financeAdmin"]').on('shown.bs.tab shown', function() {
            loadFinancialStats();
        });
        $('a[href="#securityAdmin"]').on('shown.bs.tab shown', function() {
            loadAuditLogs();
        });
        $('a[href="#servicesAdmin"]').on('shown.bs.tab shown', function() {
            loadAdminServices();
        });
        $('a[href="#policiesAdmin"]').on('shown.bs.tab shown', function() {
            loadPolicies();
        });
        $('a[href="#preferencesAdmin"]').on('shown.bs.tab shown', function() {
            loadSystemSettings();
        });
    }

    // ─── Services CRUD ───
    var allServicesCache = [];
    window.loadAdminServices = async function() {
        const $body = $('#servicesTableBody');
        $body.html('<tr><td colspan="5" class="text-center" style="padding:20px;color:#555;">Loading...</td></tr>');
        try {
            const data = await apiCall('/api/admin/services');
            allServicesCache = Array.isArray(data) ? data : [];
            if (!allServicesCache.length) { $body.html('<tr><td colspan="5" class="text-center" style="padding:20px;color:#555;">No services yet. Add one above.</td></tr>'); return; }
            $body.html(allServicesCache.map(s => {
                const modelDisp = s.pricing_model === 'per_minute' ? 'Per Minute' : s.pricing_model === 'per_hour' ? 'Per Hour' : 'Flat Fee';
                const limits = s.pricing_model === 'flat_fee' ? '—' : `${s.min_quantity || 15}-${s.max_quantity || '∞'}m`;
                return `<tr>
                <td style="color:#fff; font-weight:600;">
                    ${s.name}
                    <div style="font-size:10px; color:#555;">${s.category||'—'} ${s.display_unit ? ' | ' + s.display_unit : ''}</div>
                </td>
                <td><span style="color:#aaa; font-size:11px;">${modelDisp}</span></td>
                <td style="color:#D4AF37; font-weight:600;">R ${parseFloat(s.default_price||0).toLocaleString('en-ZA', {minimumFractionDigits:2})}</td>
                <td style="color:#666; font-size:11px;">${limits}</td>
                <td>${s.is_active !== 0 ? '<span style="background:rgba(76,175,80,0.15);color:#4CAF50;padding:2px 8px;border-radius:10px;font-size:10px;font-weight:700;">ACTIVE</span>' : '<span style="background:rgba(244,67,54,0.15);color:#F44336;padding:2px 8px;border-radius:10px;font-size:10px;font-weight:700;">INACTIVE</span>'}</td>
                <td style="text-align:right;">
                    <button class="btn btn-xs btn-admin-secondary btn-svc-edit" data-id="${s.id}" style="margin-right:4px;"><i class="fa-solid fa-pen"></i></button>
                    <button class="btn btn-xs btn-svc-delete" data-id="${s.id}" style="background:rgba(244,67,54,0.1);color:#555;border:1px solid rgba(255,255,255,0.05);"><i class="fa-solid fa-trash"></i></button>
                </td></tr>`;
            }).join(''));
        } catch(e) {}
    };

    window.toggleServiceForm = function() {
        const $f = $('#serviceFormCard');
        if ($f.is(':visible')) { cancelServiceForm(); } else {
            $('#svcEditId').val(''); $('#svcName,#svcDesc,#svcPrice,#svcUnit').val('');
            $('#svcCategory').val('Performance'); $('#svcPricingModel').val('flat_fee');
            $('#svcMinQty').val('15'); $('#svcMaxQty').val('1440');
            $('#svcTaxable').prop('checked', true); $('#svcActive').prop('checked', true);
            $('#serviceFormTitle').text('New Service');
            window.togglePricingFields();
            $f.slideDown(200);
        }
    };

    window.togglePricingFields = function() {
        const model = $('#svcPricingModel').val();
        if (model === 'flat_fee') {
            $('#svcTimeFields').hide();
            $('#svcPriceLabel').text('Flat Price (R)');
        } else {
            $('#svcTimeFields').show();
            $('#svcPriceLabel').text('Base Price / Min (R)');
        }
    };
    window.cancelServiceForm = function() { $('#serviceFormCard').slideUp(200); $('#svcEditId').val(''); };

    window.editService = function(id) {
        const s = allServicesCache.find(x => x.id == id);
        if (!s) return;
        $('#svcEditId').val(s.id); $('#svcName').val(s.name); $('#svcDesc').val(s.description||'');
        $('#svcPrice').val(s.default_price); $('#svcCategory').val(s.category||'Other');
        $('#svcPricingModel').val(s.pricing_model || 'flat_fee');
        $('#svcUnit').val(s.display_unit || '');
        $('#svcMinQty').val(s.min_quantity || 15);
        $('#svcMaxQty').val(s.max_quantity || 1440);
        $('#svcTaxable').prop('checked', !!s.is_taxable);
        $('#svcActive').prop('checked', s.is_active !== 0);
        $('#serviceFormTitle').text('Edit Service: ' + s.name);
        window.togglePricingFields();
        $('#serviceFormCard').slideDown(200);
        $('#serviceFormCard')[0].scrollIntoView({ behavior:'smooth' });
    };

    window.saveService = async function() {
        const id = $('#svcEditId').val();
        const model = $('#svcPricingModel').val();
        const minQ = parseInt($('#svcMinQty').val()) || 1;
        const maxQ = parseInt($('#svcMaxQty').val()) || 1;

        // Validation
        if (model !== 'flat_fee') {
            if (minQ < 15) { window.notificationService.showError('Minimum quantity for time-based services must be at least 15 minutes.'); return; }
            if (minQ > maxQ) { window.notificationService.showError('Minimum quantity cannot exceed Maximum quantity.'); return; }
        }

        const body = { 
            name: $('#svcName').val().trim(), 
            description: $('#svcDesc').val().trim(),
            default_price: parseFloat($('#svcPrice').val()), 
            category: $('#svcCategory').val(),
            pricing_model: model,
            display_unit: $('#svcUnit').val().trim(),
            min_quantity: minQ,
            max_quantity: maxQ,
            is_taxable: $('#svcTaxable').is(':checked'), 
            is_active: $('#svcActive').is(':checked') 
        };
        
        if (!body.name || isNaN(body.default_price)) { 
            window.notificationService.showError('Name and price are required.'); 
            return; 
        }
        try {
            if (id) { await apiCall('/api/admin/services/' + id, 'PUT', body); }
            else { await apiCall('/api/admin/services', 'POST', body); }
            cancelServiceForm();
            await loadAdminServices();
            window.notificationService.showSuccess('Service saved successfully.');
        } catch(e) {}
    };

    window.deleteService = async function(id) {
        if (!await window.notificationService.showConfirm({ 
            title: "Delete Service",
            message: 'Delete this service?',
            isDestructive: true 
        })) return;
        try {
            await apiCall('/api/admin/services/' + id, 'DELETE');
            await loadAdminServices();
        } catch(e) {}
    };

    // ─── Policies ───
    window.loadPolicies = async function() {
        try {
            const r = await apiCall('/api/admin/policies');
            if (r && r.policies) {
                const p = r.policies;
                if (p.deposit_percentage !== undefined) $('#polDeposit').val(p.deposit_percentage);
                if (p.quote_validity_days !== undefined) $('#polQuoteValidity').val(p.quote_validity_days);
                if (p.payment_terms) $('#polPaymentTerms').val(p.payment_terms);
                if (p.cancellation_policy) $('#polCancellation').val(p.cancellation_policy);
                if (p.reminder_days_1 !== undefined) $('#polReminderDays1').val(p.reminder_days_1);
                if (p.reminder_days_2 !== undefined) $('#polReminderDays2').val(p.reminder_days_2);
            }
        } catch(e) {}
    };

    window.savePolicies = async function() {
        const policies = {
            deposit_percentage: $('#polDeposit').val(),
            quote_validity_days: $('#polQuoteValidity').val(),
            payment_terms: $('#polPaymentTerms').val(),
            cancellation_policy: $('#polCancellation').val(),
            reminder_days_1: $('#polReminderDays1').val() || '7',
            reminder_days_2: $('#polReminderDays2').val() || '2'
        };
        try {
            await apiCall('/api/admin/policies', 'PUT', { policies });
            window.notificationService.showSuccess('Booking policies saved successfully.');
        } catch(e) {}
    };

    window.triggerReminderJob = async function(btn) {
        const $btn = $(btn);
        const orig = $btn.html();
        $btn.prop('disabled', true).html('<i class="fa-solid fa-spinner fa-spin" style="margin-right:5px;"></i>Running...');
        try {
            const r = await apiCall('/api/admin/reminders/run', 'POST', {});
            if (r && r.success) {
                window.notificationService.showSuccess('Reminders Job Complete', `Sent: ${r.sent} | Skipped: ${r.skipped} | Errors: ${r.errors}`);
            } else {
                window.notificationService.showError('Reminder Job Failed', r && r.message ? r.message : 'Unknown error');
            }
        } catch(e) {
            window.notificationService.showError('Network Error', 'Could not run reminder job.');
        }
        $btn.prop('disabled', false).html(orig);
    };

    // ─── System Settings ───
    window.loadSystemSettings = async function() {
        try {
            const r = await apiCall('/api/admin/settings');
            if (r && r.settings) {
                const s = r.settings;
                if (s.payfast_merchant_id) $('#stPayfastId').val(s.payfast_merchant_id);
                if (s.payfast_merchant_key) $('#stPayfastKey').val(s.payfast_merchant_key);
                if (s.payfast_passphrase) $('#stPayfastPass').val(s.payfast_passphrase);
                if (s.payfast_url) $('#stPayfastUrl').val(s.payfast_url);
                if (s.smtp_host) $('#stSmtpHost').val(s.smtp_host);
                if (s.smtp_port) $('#stSmtpPort').val(s.smtp_port);
                if (s.smtp_user) $('#stSmtpUser').val(s.smtp_user);
                if (s.smtp_pass) $('#stSmtpPass').val(s.smtp_pass);
                if (s.smtp_from) $('#stSmtpFrom').val(s.smtp_from);
                if (s.notification_email) $('#stNotificationEmail').val(s.notification_email);
            }
        } catch(e) {}
    };

    window.saveSystemSettings = async function() {
        const settings = {
            payfast_merchant_id: $('#stPayfastId').val(),
            payfast_merchant_key: $('#stPayfastKey').val(),
            payfast_passphrase: $('#stPayfastPass').val(),
            payfast_url: $('#stPayfastUrl').val(),
            smtp_host: $('#stSmtpHost').val(),
            smtp_port: $('#stSmtpPort').val(),
            smtp_user: $('#stSmtpUser').val(),
            smtp_pass: $('#stSmtpPass').val(),
            smtp_from: $('#stSmtpFrom').val(),
            notification_email: $('#stNotificationEmail').val()
        };
        // Remove blank keys to avoid overwriting with empty strings
        Object.keys(settings).forEach(k => { if (!settings[k]) delete settings[k]; });
        try {
            await apiCall('/api/admin/settings', 'PUT', { settings });
            window.notificationService.showSuccess('System settings saved successfully.');
        } catch(e) {}
    };

    window.sendTestNotification = async function() {
        const $btn = $('#testNotifBtn');
        const orig = $btn.html();
        $btn.prop('disabled', true).html('<i class="fa-solid fa-spinner fa-spin"></i> Sending...');
        try {
            const r = await apiCall('/api/admin/settings/test-notification', 'POST');
            if (r && r.success) {
                window.notificationService.showSuccess(r.message || 'Test email sent.');
            } else {
                window.notificationService.showError(r.error || 'Failed to send test email.');
            }
        } catch(e) {
            window.notificationService.showError('Failed to send test email.');
        } finally {
            $btn.prop('disabled', false).html(orig);
        }
    };

})();
