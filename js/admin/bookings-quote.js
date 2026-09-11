/* Phase 6 (HOUSEKEEPING-NOTES.md "Section 21 / Bookings sub-batch 3: Quote Builder"):
 * relocated VERBATIM from admin.html’s big Bookings inline <script> (was lines ~14666-15335) —
 * auto-save & recovery (localStorage draft, periodic + on-blur autosave, beforeunload warning),
 * the open-drawer handler (fetches the booking fresh via apiCall, populates client/event info,
 * payment-milestone terms text, draft recovery), the Terms Source Switcher, the service-catalogue
 * selector, addQuoteItem/calcQuoteTotal, and the Send Quote handler.
 *
 * Confirmed self-contained (grepped, not assumed): none of qbAutoSaveTimeout / qbHasUnsavedChanges /
 * qbAutoSaveFailed / saveQuoteDraft / triggerAutoSave / formatDuration / _applyQbTermsSource /
 * fetchServicesForQuote / addQuoteItem / calcQuoteTotal are referenced anywhere outside this range;
 * the block itself never reads allBookingsCache / dealView* / currentDealId. A first pass across a
 * WIDER span (through the next section header) found what looked like Quote Builder interleaved
 * with core-Bookings pipeline actions (status/disposition/complete/refund/record-payment/cancel) —
 * a closer line-by-line read showed that was wrong: this block ends cleanly at the `});` below, and
 * everything after it (bkContractFinalised / .bk-action-status / etc.) is a separate, unrelated
 * cluster that merely starts right after Quote Builder in the file. That cluster is NOT moved here.
 *
 * window.saveQuoteDraft / window.triggerAutoSave / window.addQuoteItem were already window-attached
 * in the original source — no new attachments needed. window.openQuoteDrawer/closeQuoteDrawer
 * (services.js) and openAtlDrawer/closeAtlDrawer (components/drawer.js) are called, not moved. */
    // ─── Quote Builder Auto-Save & Recovery ───
    let qbAutoSaveTimeout = null;
    let qbHasUnsavedChanges = false;
    let qbAutoSaveFailed = false;

    window.saveQuoteDraft = function() {
        const id = $('#quoteModalBookingId').val();
        if (!id) return;

        $('#qbSaveStatus').html('<i class="fa-solid fa-spinner fa-spin" style="margin-right:4px;"></i> Saving...');
        
        let items = [];
        $('.qb-item-row').each(function() {
            items.push({
                service_id: $(this).data('service-id') || null,
                description: $(this).find('.qb-desc').val().trim(),
                quantity_minutes: parseFloat($(this).find('.qb-qty').val()) || 0,
                unit_price: parseFloat($(this).find('.qb-price').val()) || 0,
                pricing_model: $(this).data('model') || 'flat'
            });
        });

        const draft = {
            bookingId: id,
            expiry: $('#quoteModalExpiry').val(),
            discount: parseFloat($('#qbDiscount').val()) || 0,
            depositPercentage: parseFloat($('#qbDepositPercentage').val()) || 0,
            applyVat: $('#qbApplyVat').is(':checked'),
            termsSource: $('input[name="qbTermsSource"]:checked').val() || 'global',
            terms: $('#quoteModalDetails').val(),
            items: items,
            timestamp: Date.now()
        };

        try {
            localStorage.setItem(`quote_draft_booking_${id}`, JSON.stringify(draft));
            qbAutoSaveFailed = false;
            qbHasUnsavedChanges = false;
            const timeStr = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
            $('#qbSaveStatus').text(`Saved at ${timeStr}`);
        } catch(e) {
            console.error('Draft auto-save failed:', e);
            qbAutoSaveFailed = true;
            $('#qbSaveStatus').html('<span style="color:var(--atl-clay); font-weight:700;"><i class="fa-solid fa-circle-xmark"></i> Save failed</span>');
            if (window.notificationService) {
                window.notificationService.showError('Quote auto-save failed. Local storage might be full or disabled.');
            }
        }
    };

    window.triggerAutoSave = function() {
        qbHasUnsavedChanges = true;
        if (qbAutoSaveTimeout) clearTimeout(qbAutoSaveTimeout);
        qbAutoSaveTimeout = setTimeout(window.saveQuoteDraft, 1000); // 1s debounce
    };

    // Auto-save listeners
    $(document).off('input.qbas change.qbas').on('input.qbas change.qbas', 
        '#quoteModalExpiry, #qbDiscount, #qbDepositPercentage, #quoteModalDetails, #qbApplyVat, input[name="qbTermsSource"], .qb-desc, .qb-qty, .qb-price', 
        function() {
            if ($('#quoteDrawer').hasClass('qb-drawer--open')) {
                window.triggerAutoSave();
            }
        }
    );

    $(document).off('click.qbas_click').on('click.qbas_click', '#qbAddItemBtn, .qb-remove-btn', function() {
        if ($('#quoteDrawer').hasClass('qb-drawer--open')) {
            window.triggerAutoSave();
        }
    });

    $(document).off('change.qbas_sel').on('change.qbas_sel', '#qbServiceSelector', function() {
        if ($('#quoteDrawer').hasClass('qb-drawer--open') && $(this).val()) {
            window.triggerAutoSave();
        }
    });

    // Periodic auto-save every 10 seconds
    setInterval(function() {
        if ($('#quoteDrawer').hasClass('qb-drawer--open') && qbHasUnsavedChanges) {
            window.saveQuoteDraft();
        }
    }, 10000);

    // Unload warning for unsaved changes
    window.addEventListener('beforeunload', function(e) {
        if (qbHasUnsavedChanges && qbAutoSaveFailed && $('#quoteDrawer').hasClass('qb-drawer--open')) {
            e.preventDefault();
            e.returnValue = 'You have unsaved changes in the Quote Builder that could not be auto-saved. Are you sure you want to leave?';
            return e.returnValue;
        }
    });

    // Show Quote Modal — fetch full booking detail first so booking.services is populated
    $(document).off('click.bkq_toggle').on('click.bkq_toggle', '.bk-action-quote', async function() {
        const id = $(this).data('id');
        const $btn = $(this);
        const origHtml = $btn.html();

        // Show spinner on button while fetching
        $btn.prop('disabled', true).html('<i class="fa fa-spinner fa-spin"></i> Loading…');

        let booking;
        try {
            booking = await apiCall(`/api/admin/bookings/${id}`, 'GET');
        } catch(e) {
            window.notificationService && window.notificationService.showError('Failed to load booking details.');
            $btn.prop('disabled', false).html(origHtml);
            return;
        }
        $btn.prop('disabled', false).html(origHtml);

        if (!booking || booking.error) {
            window.notificationService && window.notificationService.showError('Booking not found.');
            return;
        }

        // Hide any open booking modals first to avoid Bootstrap stacking conflict
        $('#adminBookingModal').modal('hide');
        closeAtlDrawer('bookingFinancialsDrawer');

        // Wait for Bootstrap hide animation, then open Quote Builder
        const sleep = ms => new Promise(r => setTimeout(r, ms));
        await sleep(200);

        $('#quoteModalBookingId').val(id);
        $('#quoteDrawer').data('has-existing-quote', !!(booking.quoted_at || booking.quote_amount));
        $('#quoteDrawer').data('perf-duration', booking.performance_duration || 60);
        // Re-quoting a booking that's already ACCEPTED/CONFIRMED auto-supersedes its contract back
        // to draft (see reQuotingCommitted in the /quote route) — including a signed one. Stash what
        // we know about the current contract so the submit handler can warn before that happens,
        // instead of it landing silently in the audit log only.
        $('#quoteDrawer').data('booking-status', booking.status);
        $('#quoteDrawer').data('contract-status', booking.contract_status || null);
        $('#quoteDrawer').data('contract-signed', !!booking.contract_signed_by_client_at || booking.contract_status === 'signed');

        // Populate Client/Event info
        $('#qbClientName').text(booking.name);
        $('#qbClientEmail').text(booking.email);
        $('#qbEventName').text(booking.event_name || booking.event_type);
        $('#qbEventDate').text(booking.date);

        // CHECK DRAFT RECOVERY
        const draftKey = `quote_draft_booking_${id}`;
        const savedDraft = localStorage.getItem(draftKey);
        let restoreDraft = false;

        if (savedDraft) {
            try {
                const draftObj = JSON.parse(savedDraft);
                const dateStr = new Date(draftObj.timestamp).toLocaleString();
                restoreDraft = await window.notificationService.showConfirm({
                    title: 'Recover Unsaved Draft?',
                    message: `We found a partially completed quote draft for this booking saved on ${dateStr}. Would you like to restore it and continue editing?`,
                    confirmText: 'Continue Editing Draft',
                    cancelText: 'Discard & Start Fresh',
                    isDestructive: false
                });

                if (!restoreDraft) {
                    localStorage.removeItem(draftKey);
                }
            } catch(e) {
                console.error("Failed to parse draft:", e);
                localStorage.removeItem(draftKey);
            }
        }

        // Expiry defaults to 7 days from now
        let d = new Date();
        d.setDate(d.getDate() + 7);
        $('#quoteModalExpiry').val(d.toISOString().split('T')[0]);

        // Pull deposit percentage from global policies or default to 50
        const policyDeposit = parseFloat($('#polDeposit').val()) || 50;
        $('#qbDepositPercentage').val(policyDeposit);

        // Build Global Booking Policies text
        const paymentTerms = $('#polPaymentTerms').val() || `${policyDeposit}% Deposit required to secure the booking. Balance due 48 hours prior to the event.`;
        const cancellationPolicy = $('#polCancellation').val() || 'Standard cancellation policy applies.';
        const globalTermsText = `PAYMENT TERMS:\n${paymentTerms}\n\nCANCELLATION POLICY:\n${cancellationPolicy}`;

        // Fetch payment milestones for this booking
        let milestonesText = '';
        try {
            const msResp = await fetch(`/api/admin/bookings/${id}/payment-schedules`);
            const msData = await msResp.json();
            if (msData.success && msData.schedules && msData.schedules.length > 0) {
                const fmtAmt = n => 'R ' + parseFloat(n).toLocaleString('en-ZA', { minimumFractionDigits: 2 });
                const fmtDate = ds => { try { return new Date(ds).toLocaleDateString('en-ZA', { day: 'numeric', month: 'short', year: 'numeric' }); } catch(ex) { return ds; } };
                milestonesText = 'PAYMENT SCHEDULE:\n' + msData.schedules.map((s, i) =>
                    `  ${i + 1}. ${s.description} — ${fmtAmt(s.expected_amount)} due ${fmtDate(s.due_date)}`
                ).join('\n');
                milestonesText += '\n\nCANCELLATION POLICY:\n' + cancellationPolicy;
                // Store raw data so calcQuoteTotal() can proportionally scale amounts when totals change
                const msTotal = msData.schedules.reduce((sum, s) => sum + parseFloat(s.expected_amount || 0), 0);
                $('#quoteDrawer').data('qb-milestones-raw', msData.schedules);
                $('#quoteDrawer').data('qb-milestones-proportions',
                    msData.schedules.map(s => msTotal > 0 ? parseFloat(s.expected_amount) / msTotal : 0)
                );
            } else {
                milestonesText = '(No payment milestones configured for this booking.)\n\nTo set up milestones, close this modal and use the Payment Milestones widget in booking details.\n\nCANCELLATION POLICY:\n' + cancellationPolicy;
                $('#quoteDrawer').data('qb-milestones-raw', []);
                $('#quoteDrawer').data('qb-milestones-proportions', []);
            }
        } catch(eMs) {
            milestonesText = globalTermsText;
            $('#quoteDrawer').data('qb-milestones-raw', []);
            $('#quoteDrawer').data('qb-milestones-proportions', []);
        }

        // Store both texts for radio switching
        $('#quoteDrawer').data('qb-global-terms', globalTermsText);
        $('#quoteDrawer').data('qb-milestones-terms', milestonesText);

        // Reset Item table BEFORE loading services
        $('#qbItemsBody').empty();
        $('#qbDiscount').val('0');
        $('#qbApplyVat').prop('checked', false);

        // Load services catalogue (properly awaited so servicesCache is populated)
        await fetchServicesForQuote();

        if (restoreDraft) {
            // Restore from Draft
            try {
                const draftObj = JSON.parse(savedDraft);
                $('#quoteModalExpiry').val(draftObj.expiry);
                $('#qbDiscount').val(draftObj.discount);
                $('#qbDepositPercentage').val(draftObj.depositPercentage);
                $('#qbApplyVat').prop('checked', draftObj.applyVat);

                // Restore terms source radio
                const termsSource = draftObj.termsSource || 'global';
                $(`input[name="qbTermsSource"][value="${termsSource}"]`).prop('checked', true);
                _applyQbTermsSource(termsSource);

                // Restore terms text (override default terms generation)
                $('#quoteModalDetails').val(draftObj.terms);

                // Restore items
                if (draftObj.items && draftObj.items.length > 0) {
                    draftObj.items.forEach(item => {
                        addQuoteItem(item.description, item.quantity_minutes, item.unit_price, item.service_id);
                    });
                }
                
                calcQuoteTotal();
                
                // Set status indicator
                const timeStr = new Date(draftObj.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
                $('#qbSaveStatus').text(`Draft recovered (saved at ${timeStr})`);
            } catch(e) {
                console.error("Failed to apply draft state:", e);
            }
        } else {
            // Reset radio to Global (Booking Policies) on each open and apply
            $('#qbRadioGlobal').prop('checked', true);
            _applyQbTermsSource('global');

            // Auto-prefill line items from the client's booking services
            if (booking.services && booking.services.length > 0) {
                booking.services.forEach(svc => {
                    const price = parseFloat(svc.unit_price) > 0 ? parseFloat(svc.unit_price) : parseFloat(svc.default_price || 0);
                    addQuoteItem(svc.service_name, svc.quantity_minutes, price, svc.service_id);
                });
            } else {
                // Fallback for legacy bookings with no booking_services rows
                const cache = window.servicesCache || [];
                const matchedService = cache.find(s => s.name.toLowerCase().includes((booking.event_type || '').toLowerCase()));
                if (matchedService) {
                    addQuoteItem(matchedService.name, 1, matchedService.default_price, matchedService.id);
                } else {
                    // Ultimate fallback: add a generic line item so the table is never empty
                    addQuoteItem('Main Performance (' + (booking.performance_duration || '60 min') + ')', 1, 20000, null);
                }
            }
            // Clear status indicator on new quote build
            $('#qbSaveStatus').text('');
        }

        $('#quoteModalMsg').css('color','#aaa').text('');
        window.openQuoteDrawer();
    });

    function formatDuration(mins) {
        if (!mins || mins <= 0) return '0m';
        var h = Math.floor(mins / 60);
        var m = mins % 60;
        if (h > 0 && m > 0) return h + 'h ' + m + 'm';
        if (h > 0) return h + 'h';
        return m + 'm';
    }

    // ─── Quote Builder: Terms Source Switcher ───────────────────────────────────
    function _applyQbTermsSource(source) {
        const globalText = $('#quoteDrawer').data('qb-global-terms') || '';
        const localText  = $('#quoteDrawer').data('qb-milestones-terms') || '';
        if (source === 'local') {
            $('#quoteModalDetails').val(localText);
            $('#qbTermsBadgeText').text('Using Booking Payment Milestones (Local)');
            $('#qbTermsBadge').css('color', 'var(--atl-amber)');
            // Style the radio labels
            $('#qbTermsOptPolicies').css({ border: '1.5px solid var(--atl-line)', background: 'transparent' });
            $('#qbTermsOptMilestones').css({ border: '1.5px solid var(--atl-amber)', background: 'rgba(251,191,36,0.10)' });
        } else {
            $('#quoteModalDetails').val(globalText);
            $('#qbTermsBadgeText').text('Using Global Booking Policies');
            $('#qbTermsBadge').css('color', 'var(--atl-blue)');
            // Style the radio labels
            $('#qbTermsOptPolicies').css({ border: '1.5px solid var(--atl-blue)', background: 'rgba(96,165,250,0.12)' });
            $('#qbTermsOptMilestones').css({ border: '1.5px solid var(--atl-line)', background: 'transparent' });
        }
    }

    // Wire up radio buttons (delegated so they work even if modal hasn't rendered yet)
    $(document).off('change.qbTermsRadio').on('change.qbTermsRadio', 'input[name="qbTermsSource"]', function() {
        _applyQbTermsSource($(this).val()); // restore base text + visual styling
        calcQuoteTotal();                    // immediately inject current dynamic values
    });

    async function fetchServicesForQuote() {

        const $sel = $('#qbServiceSelector');
        if (!$sel.length) return;
        try {
            // Load ONLY active services
            const r = await fetch('/api/admin/services?active_only=1');
            const services = await r.json();
            window.servicesCache = services;
            
            $sel.html('<option value="">-- Quick Add from Catalogue --</option>');
            
            // Group by category
            const grouped = services.reduce((acc, s) => {
                const cat = s.category || 'Other';
                if (!acc[cat]) acc[cat] = [];
                acc[cat].push(s);
                return acc;
            }, {});

            Object.keys(grouped).sort().forEach(cat => {
                const $group = $(`<optgroup label="${cat}"></optgroup>`);
                grouped[cat].forEach(s => {
                    const price = parseFloat(s.default_price || 0);
                    const model = s.pricing_model === 'per_minute' ? '/ min' : s.pricing_model === 'per_hour' ? '/ hr' : '/ unit';
                    $group.append(`<option value="${s.id}">${s.name} (R ${price.toLocaleString('en-ZA', {minimumFractionDigits:0})} ${model})</option>`);
                });
                $sel.append($group);
            });
        } catch(e) {
            console.error('Failed to fetch services for quote', e);
        }
    }

    $(document).off('change.qb_svc').on('change.qb_svc', '#qbServiceSelector', function() {
        const serviceId = $(this).val();
        let $preview = $('#qbSvcPreviewAdmin');
        if (!$preview.length) {
            $(this).after('<div id="qbSvcPreviewAdmin" style="font-size:11px; color: var(--atl-amber); margin-top:5px; font-weight:600;"></div>');
            $preview = $('#qbSvcPreviewAdmin');
        }

        if (!serviceId) { $preview.fadeOut(200); return; }
        
        const service = window.servicesCache.find(s => s.id == serviceId);
        if (service) {
            const price = parseFloat(service.default_price) || 0;
            const isPerMinute = service.pricing_model === 'per_minute';
            const isPerHour = service.pricing_model === 'per_hour';
            const isFlat = service.pricing_model === 'flat' || service.pricing_model === 'flat_fee';
            const modelDisp = isPerMinute ? 'per min' : (isPerHour ? 'per hr' : 'flat fee');
            $preview.text(`Selected: R ${price.toLocaleString()} (${modelDisp})`).fadeIn(200);
            
            let defaultQty = 1;
            if (!isFlat) {
                // Use the service's own performance_length_minutes as the default quantity.
                // Fall back to min_quantity, then 60 min. Do NOT use the booking slot duration.
                const perfMins = parseInt(service.performance_length_minutes) || 0;
                if (isPerMinute) defaultQty = perfMins || service.min_quantity || 60;
                else if (isPerHour) defaultQty = Math.ceil((perfMins || 60) / 60);
            }
            
            addQuoteItem(service.name, defaultQty, service.default_price, service.id);
            $(this).val('');
            
            // Clear preview after add
            setTimeout(() => { $preview.fadeOut(300); }, 1000);

            // Scroll table to bottom to see new item
            const $body = $('#qbItemsBody').parent().parent();
            $body.scrollTop($body[0].scrollHeight);
        }
    });

    // Helper to add row
    window.addQuoteItem = function(desc = '', qty = 1, price = 0, serviceId = null) {
        let minQty = 1;
        let model = 'flat_fee';
        let unit = '';
        
        let maxQty = null;
        let externalNote = '';
        if (serviceId && window.servicesCache) {
            const svc = window.servicesCache.find(s => s.id == serviceId);
            if (svc) {
                minQty = svc.min_quantity || 1;
                maxQty = svc.max_quantity || null;
                model = svc.pricing_model || 'flat_fee';
                unit = svc.display_unit || '';
                externalNote = svc.external_note || '';
            }
        }
        
        qty = Math.max(qty, minQty);
        
        const isPerMinute = model === 'per_minute';
        const isPerHour = model === 'per_hour';
        const isFlat = model === 'flat' || model === 'flat_fee';
        
        // Disable qty input if it's duration-driven? 
        // Actually, Quote Builder allows manual override, so let's leave it enabled.
        const durHint = isPerMinute ? `<div class="qb-dur-hint" style="color: var(--atl-amber); font-size:10px; font-weight:700; margin-top:2px;">${formatDuration(qty)}</div>` : '';

        const tr = `
            <tr class="qb-item-row" data-service-id="${serviceId || ''}" data-model="${model}" data-min-qty="${minQty}" data-max-qty="${maxQty || ''}" style="border-bottom:1px solid var(--atl-line);">
                <td style="border:none; padding:8px 0;">
                    <div style="display:flex; flex-direction:column;">
                        <input type="text" class="atl-input qb-desc" style="background: var(--atl-paper); border:1px solid var(--atl-line-strong); color: var(--atl-ink);" value="${desc}" placeholder="Description">
                        ${unit ? `<small style="color:#666; font-size:9px; margin-top:2px; text-transform:uppercase; letter-spacing:0.5px;">${unit} | Model: ${model.replace('_', ' ')}</small>` : ''}
                        ${externalNote ? `<small style="color:var(--atl-amber); font-size:10px; margin-top:3px; font-style:italic;">${externalNote}</small>` : ''}
                    </div>
                </td>
                <td style="border:none; padding:8px 5px; width:100px;">
                    <div style="display:flex; flex-direction:column; align-items:center;">
                        <input type="number" class="atl-input qb-qty text-center" style="background: var(--atl-paper); border:1px solid var(--atl-line-strong); color: var(--atl-ink);" value="${qty}" min="${minQty}" step="${isPerMinute ? '15' : '1'}">
                        ${durHint}
                    </div>
                </td>
                <td style="border:none; padding:8px 5px; width:130px;">
                    <input type="number" class="atl-input qb-price text-right" style="background: var(--atl-paper); border:1px solid var(--atl-line-strong); color: var(--atl-ink);" value="${price}" min="0">
                </td>
                <td style="border:none; padding:8px 5px; vertical-align:middle; text-align:right; font-weight:600; color:#eee;">
                    R <span class="qb-row-total">0.00</span>
                </td>
                <td style="border:none; padding:8px 0; text-align:right; width:40px;">
                    <button class="atl-btn atl-btn--danger qb-remove-btn" style="background:none; border:none; color:#555;"><i class="fa fa-trash"></i></button>
                </td>
            </tr>
        `;
        const $tr = $(tr);
        $('#qbItemsBody').append($tr);
        
        // Visual highlight if added from catalogue
        if (serviceId) {
            $tr.addClass('qb-row-flash');
        }
        
        calcQuoteTotal();
    };

    $(document).off('click.qb_add').on('click.qb_add', '#qbAddItemBtn', () => addQuoteItem('', 1, 0));
    $(document).on('click', '.qb-remove-btn', function() { $(this).closest('tr').remove(); calcQuoteTotal(); });
    $(document).on('input', '.qb-qty, .qb-price, #qbDiscount, #qbDepositPercentage', calcQuoteTotal);
    $(document).on('change', '#qbApplyVat', calcQuoteTotal);

    function calcQuoteTotal() {
        let subtotal = 0;
        $('.qb-item-row').each(function() {
            const minQ = parseFloat($(this).data('min-qty')) || 1;
            const model = $(this).data('model');
            let q = parseFloat($(this).find('.qb-qty').val()) || 0;
            
            if (q < minQ) {
                q = minQ;
                $(this).find('.qb-qty').val(minQ).css('border-color', 'var(--atl-clay)');
                setTimeout(() => $(this).find('.qb-qty').css('border-color', '#444'), 600);
            }
            const maxQ = parseFloat($(this).data('max-qty'));
            if (maxQ && q > maxQ) {
                q = maxQ;
                $(this).find('.qb-qty').val(maxQ).css('border-color', 'var(--atl-amber)');
                setTimeout(() => $(this).find('.qb-qty').css('border-color', '#444'), 600);
            }
            
            if (model === 'per_minute') {
                $(this).find('.qb-dur-hint').text(formatDuration(q));
            }
            
            const p = parseFloat($(this).find('.qb-price').val()) || 0;
            const rt = q * p;
            $(this).find('.qb-row-total').text(rt.toLocaleString('en-ZA', {minimumFractionDigits:2}));
            subtotal += rt;
        });
        const discount = parseFloat($('#qbDiscount').val()) || 0;
        let vatable = Math.max(0, subtotal - discount);
        let vat = 0;
        if($('#qbApplyVat').is(':checked')) vat = vatable * 0.15;
        
        let finalTotal = vatable + vat;
        
        $('#qbSubtotal').text(subtotal.toFixed(2));
        $('#qbVatAmount').text(vat.toFixed(2));
        $('#qbFinalTotal').text(finalTotal.toFixed(2));

        const depPct = parseFloat($('#qbDepositPercentage').val()) || 0;
        const depositAmount = (finalTotal * (depPct / 100)).toFixed(2);
        $('#qbDepositAmount').text(depositAmount);


        // Auto-update terms textarea to reflect current quote values in both modes
        const _fmtR = n => parseFloat(n).toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
        const _fmtDate = ds => { try { return new Date(ds).toLocaleDateString('en-ZA', { day: 'numeric', month: 'short', year: 'numeric' }); } catch(e) { return ds; } };

        if ($('#qbRadioGlobal').is(':checked')) {
            // Strip any previously injected deposit/balance lines, then prepend fresh values
            let t = $('#quoteModalDetails').val() || '';
            t = t.replace(/^\d+% Deposit.*?\n?/im, '').replace(/^Balance Due:.*?\n?/im, '').trim();
            let prefix = '';
            if (depPct > 0) {
                const balanceDue = finalTotal - parseFloat(depositAmount);
                prefix  = `${depPct}% Deposit (R ${_fmtR(depositAmount)}) required to secure the booking.\n`;
                prefix += `Balance Due: R ${_fmtR(balanceDue)}\n\n`;
            }
            $('#quoteModalDetails').val(prefix + t);
        }

        if ($('#qbRadioLocal').is(':checked')) {
            // Rebuild milestones text with proportionally scaled amounts
            const rawMs = $('#quoteDrawer').data('qb-milestones-raw') || [];
            const props = $('#quoteDrawer').data('qb-milestones-proportions') || [];
            if (rawMs.length > 0 && finalTotal > 0) {
                const lines = rawMs.map((s, i) => {
                    const amt = props[i] != null ? Math.round(finalTotal * props[i] * 100) / 100 : parseFloat(s.expected_amount);
                    return `  ${i + 1}. ${s.description} — R ${_fmtR(amt)} due ${_fmtDate(s.due_date)}`;
                });
                const cancelText = $('#polCancellation').val() || 'Standard cancellation policy applies.';
                $('#quoteModalDetails').val(`PAYMENT SCHEDULE:\n${lines.join('\n')}\n\nCANCELLATION POLICY:\n${cancelText}`);
            }
        }
    }

    // Send quote via Modal
    $(document).off('click.bkq_send').on('click.bkq_send', '#quoteModalSendBtn', async function() {
        calcQuoteTotal(); // defensive refresh — ensures PDF receives latest calculations
        const id = $('#quoteModalBookingId').val();
        const details = $('#quoteModalDetails').val().trim();
        const expiry = $('#quoteModalExpiry').val();
        
        let items = [];
        $('.qb-item-row').each(function() {
            items.push({
                service_id: $(this).data('service-id') || null,
                description: $(this).find('.qb-desc').val().trim(),
                quantity_minutes: parseFloat($(this).find('.qb-qty').val()) || 0,
                unit_price: parseFloat($(this).find('.qb-price').val()) || 0,
                pricing_model: $(this).data('model') || 'flat'
            });
        });
        
        const payload = {
            quote_expiry_date: expiry,
            terms: details,
            items: items,
            discount: parseFloat($('#qbDiscount').val()) || 0,
            apply_vat: $('#qbApplyVat').is(':checked')
        };
        
        const $msg = $('#quoteModalMsg');
        if (items.length === 0 || !expiry) {
            $msg.css('color','var(--atl-clay)').text('Please add at least one item and set expiry.');
            return;
        }
        // Per-row validation: description required, quantity > 0
        const invalidItems = items.filter(it => !it.description || it.quantity_minutes <= 0);
        if (invalidItems.length > 0) {
            $msg.css('color','var(--atl-clay)').text('Each line item must have a description and a quantity greater than zero.');
            $('.qb-item-row').each(function() {
                const desc = $(this).find('.qb-desc').val().trim();
                const qty  = parseFloat($(this).find('.qb-qty').val()) || 0;
                if (!desc || qty <= 0) $(this).css('outline', '1px solid var(--atl-clay)');
                else $(this).css('outline', '');
            });
            return;
        }
        $('.qb-item-row').css('outline', '');

        const $btn = $(this);
        const originalText = $btn.html();

        const qbBookingStatus = String($('#quoteDrawer').data('booking-status') || '').toUpperCase();
        const qbContractStatus = $('#quoteDrawer').data('contract-status');
        const qbContractSigned = !!$('#quoteDrawer').data('contract-signed');
        // Only ACCEPTED/CONFIRMED bookings trip the server's contract-supersede logic — matches
        // reQuotingCommitted in the /quote route exactly, so this warning only fires when it's true.
        if (['ACCEPTED', 'CONFIRMED'].includes(qbBookingStatus) && qbContractStatus && qbContractStatus !== 'draft') {
            const confirmed = await window.notificationService.showConfirm({
                title: qbContractSigned ? 'This Will Invalidate a Signed Contract' : 'This Will Reset an In-Progress Contract',
                message: qbContractSigned
                    ? 'This booking has a SIGNED contract at the current amount. Saving a new quote will reset that contract to draft and clear the signature — the client will need to sign again at the new figure.'
                    : 'This booking has a contract that has already been sent to the client for signing. Saving a new quote will reset it to draft, and it will need to be re-sent.',
                confirmText: 'Re-Quote Anyway',
                cancelText: 'Cancel',
                isDestructive: true
            });
            if (!confirmed) return;
        } else if ($('#quoteDrawer').data('has-existing-quote')) {
            const confirmed = await window.notificationService.showConfirm({
                title: 'Create New Quote Version?',
                message: 'This booking already has a quote. Saving will create a new version and archive the previous one.',
                confirmText: 'Create New Version',
                cancelText: 'Cancel'
            });
            if (!confirmed) return;
        }

        $msg.css('color','#aaa').text('Generating PDF & Sending Email...');
        $btn.prop('disabled', true).text('Working...');

        async function performQuoteSubmit(body) {
            const r = await fetch(`/api/admin/bookings/${id}/quote`, { 
                method:'POST', 
                headers:{'Content-Type':'application/json'}, 
                body: JSON.stringify(body) 
            });
            
            if (r.status === 409) {
                const data = await r.json();
                if (data.conflict) {
                    const confirmOverride = await window.notificationService.showConfirm({
                        title: 'Scheduling Conflict Detected',
                        message: data.message,
                        confirmText: 'Override & Send',
                        cancelText: 'Cancel'
                    });
                    if (confirmOverride) {
                        body.override_conflict = true;
                        $msg.text('Overriding Conflict & Sending...');
                        return await performQuoteSubmit(body);
                    } else {
                        throw new Error('Quote generation cancelled due to scheduling conflict.');
                    }
                }
            }
            
            const data = await r.json();
            if (!r.ok || !data.success) {
                throw new Error(data.message || 'Failed to send quote.');
            }
            return data;
        }

        try {
            const d = await performQuoteSubmit(payload);
            $msg.css('color','var(--atl-sage)').text('Quote sent successfully!');
            localStorage.removeItem(`quote_draft_booking_${id}`);
            qbHasUnsavedChanges = false;
            if (d.warnings && d.warnings.length) {
                d.warnings.forEach(w => window.notificationService.showError('⚠ ' + w));
            }
            setTimeout(() => {
                window.closeQuoteDrawer();
                loadBookings();
            }, 1500);
        } catch(e) { 
            $msg.css('color','var(--atl-clay)').text(e.message || 'Network error.'); 
        }
        $btn.prop('disabled', false).html(originalText);
    });
