// Patch: Replace old view-booking-btn + email template + email submit handlers
// with new ⋮ More dropdown toggle + 3 dedicated modal handlers
const fs = require('fs');
const file = 'admin.html';
let lines = fs.readFileSync(file, 'utf8').split('\n');

const NEW_BLOCK = `        // ⋮ More dropdown toggle
        $(document).on('click', '.bk-action-more', function(e) {
            e.stopPropagation();
            const id = $(this).data('id');
            $('.bkr-more-dropdown').not('[data-id="'+id+'"]').hide();
            $(this).siblings('.bkr-more-dropdown').toggle();
        });
        $(document).on('click', function() { $('.bkr-more-dropdown').hide(); });
        $(document).on('click', '.bkr-more-item', function() { $('.bkr-more-dropdown').hide(); });
        // Hover highlight for dropdown items
        $(document).on('mouseenter', '.bkr-more-item', function() { $(this).css('background','rgba(255,255,255,.06)'); });
        $(document).on('mouseleave', '.bkr-more-item', function() { $(this).css('background','none'); });

        // ═══════════════════════════════════════════════
        // MODAL 1 — BOOKING INFO  (.bk-action-info)
        // ═══════════════════════════════════════════════
        $(document).on('click', '.bk-action-info', function() {
            const bookingId = $(this).data('id');
            const booking = allBookingsCache.find(b => b.id == bookingId);
            if (!booking) return;

            // Title
            $('#bi-modal-title').text('Booking #' + booking.id + ' — ' + (booking.name || 'Unknown'));

            // Client Info
            $('#bi-name').text(booking.name || 'N/A');
            $('#bi-company').text(booking.company || 'N/A');
            $('#bi-email').text(booking.email || '').attr('href', 'mailto:' + (booking.email || ''));
            $('#bi-cell').text(booking.cell || 'N/A');

            // Event Details
            $('#bi-event-name').text(booking.event_name || 'N/A');
            $('#bi-date').text(booking.date || 'N/A');
            $('#bi-start-time').text(booking.event_start_time ? 'at ' + booking.event_start_time : '');
            $('#bi-slot').text(booking.performance_slot || 'N/A');
            $('#bi-duration').text(booking.performance_duration || 'N/A');
            $('#bi-location').text(booking.event_location || 'TBD');
            let fullAddress = [booking.venue_address, booking.city, booking.country].filter(Boolean).join(', ');
            $('#bi-address').text(fullAddress || 'N/A');
            $('#bi-type').text(booking.event_type || 'N/A');
            $('#bi-venue-type').text(booking.venue_type || 'N/A');

            // Audience & Logistics
            $('#bi-audience').text(booking.audience_size || 'N/A');
            $('#bi-demographic').text(booking.audience_demographic || 'N/A');
            $('#bi-budget').text(booking.budget_range || 'N/A');
            const travelYes = booking.travel_accommodation;
            $('#bi-travel').text(travelYes ? 'Yes' : 'No')
                .css('color', travelYes ? '#4CAF50' : '#aaa')
                .css('font-weight', travelYes ? 'bold' : 'normal');

            // Venue notes
            let vnHtml = '';
            if (booking.venue_notes) vnHtml += '<div style="color:#aaa;margin-bottom:6px;"><strong style="color:#ccc;">Venue Notes:</strong><br>' + booking.venue_notes + '</div>';
            if (booking.green_room_notes) vnHtml += '<div style="color:#aaa;margin-bottom:6px;"><strong style="color:#ccc;">Green Room:</strong><br>' + booking.green_room_notes + '</div>';
            if (booking.venue_negotiated_rates) vnHtml += '<div style="color:#D4AF37;"><strong>Negotiated Rates:</strong><br>' + booking.venue_negotiated_rates + '</div>';
            if (vnHtml) { $('#bi-venue-notes').html(vnHtml).show(); } else { $('#bi-venue-notes').hide(); }

            // Notes
            $('#bi-message').text(booking.message || 'No notes provided.');

            // Also populate legacy hidden IDs for backward-compat
            $('#abName').text(booking.name); $('#abCompany').text(booking.company || '');
            $('#abEmail').text(booking.email); $('#abCell').text(booking.cell);

            // Auto-update status NEW → Reviewed
            if (booking.status && booking.status.toLowerCase() === 'new') {
                apiCall('/api/admin/bookings/' + booking.id, 'PUT', { status: 'Reviewed' }).then(() => {
                    booking.status = 'Reviewed';
                    $('#bookingStatusFilter').trigger('change');
                });
            }

            $('#bookingInfoModal').modal('show');
        });

        // ═══════════════════════════════════════════════
        // MODAL 2 — FINANCIAL CONTROLS  (.bk-action-financials)
        // ═══════════════════════════════════════════════
        $(document).on('click', '.bk-action-financials', function() {
            const bookingId = $(this).data('id');
            const booking = allBookingsCache.find(b => b.id == bookingId);
            if (!booking) return;

            // Store booking ID on modal for sub-actions
            $('#bookingFinancialsModal').data('booking-id', bookingId);

            // Title
            $('#bf-modal-title').text('Booking #' + booking.id + ' — ' + (booking.name || ''));

            // Payment ledger
            const ps = (booking.payment_status || 'UNPAID').toUpperCase();
            const payColor = { PAID:'#4CAF50', PARTIALLY_PAID:'#ff9800', DEPOSIT_PAID:'#64B5F6', UNPAID:'#F44336', FAILED:'#ef5350' };
            const c = payColor[ps] || '#aaa';
            $('#bf-pay-status').text(ps).css({ color: c, background: 'rgba(255,255,255,.05)', border: '1px solid ' + c + '44' });
            $('#bf-total').text('R ' + parseFloat(booking.total_amount || 0).toFixed(2));
            $('#bf-paid').text('R ' + parseFloat(booking.amount_paid || 0).toFixed(2));
            $('#bf-outstanding').text('R ' + parseFloat(booking.amount_outstanding || 0).toFixed(2));

            // Last payment info
            if (booking.last_payment_date) {
                $('#bf-last-payment').html('<i class="fa-solid fa-clock" style="margin-right:4px;"></i>Last payment: ' + booking.last_payment_date + (booking.last_payment_ref ? ' (Ref: ' + booking.last_payment_ref + ')' : ''));
            } else {
                $('#bf-last-payment').text('');
            }

            // P&L card — async load
            $('#bf-pl-card').html('<i class="fa-solid fa-spinner fa-spin" style="color:#888;"></i> Loading P&L…');
            apiCall('/api/admin/bookings/' + bookingId + '/expenses', 'GET').then(d => {
                const gross = parseFloat(d.gross_revenue || 0);
                const exp = parseFloat(d.total_expenses || 0);
                const net = gross - exp;
                const netClr = net >= 0 ? '#4CAF50' : '#ef5350';
                let expRows = '';
                if (d.expenses && d.expenses.length) {
                    d.expenses.forEach(e => {
                        expRows += '<div style="display:flex;justify-content:space-between;font-size:11px;color:#bbb;margin-top:4px;">'
                            + '<span>' + (e.category || 'Misc') + ': ' + (e.description || '') + '</span>'
                            + '<span style="color:#ef5350;">- R ' + parseFloat(e.amount || 0).toFixed(2) + '</span></div>';
                    });
                }
                $('#bf-pl-card').html(
                    '<div style="font-size:11px;color:#888;font-weight:700;text-transform:uppercase;letter-spacing:.5px;margin-bottom:8px;"><i class="fa-solid fa-chart-pie" style="margin-right:5px;color:#D4AF37;"></i>Profit & Loss</div>'
                    + '<div style="display:flex;justify-content:space-between;font-size:13px;margin-bottom:4px;"><span style="color:#888;">Revenue</span><span style="color:#4CAF50;font-weight:700;">R ' + gross.toFixed(2) + '</span></div>'
                    + '<div style="display:flex;justify-content:space-between;font-size:13px;margin-bottom:4px;"><span style="color:#888;">Expenses</span><span style="color:#ef5350;font-weight:700;">R ' + exp.toFixed(2) + '</span></div>'
                    + expRows
                    + '<div style="display:flex;justify-content:space-between;font-size:14px;padding-top:8px;border-top:1px solid rgba(212,175,55,.2);margin-top:8px;"><span style="color:#D4AF37;font-weight:700;">Net Profit</span><span style="color:' + netClr + ';font-weight:700;">R ' + net.toFixed(2) + '</span></div>'
                );
            }).catch(() => {
                $('#bf-pl-card').html('<div style="color:#ef5350;font-size:12px;">Failed to load P&L data.</div>');
            });

            // Document links
            $('#bf-doc-links').html('<i class="fa-solid fa-spinner fa-spin" style="color:#555;"></i>');
            fetch('/api/admin/bookings/' + bookingId + '/financials').then(r => r.json()).then(fin => {
                let html = '';
                if (fin && fin.quote) {
                    html += '<div style="margin-bottom:5px;"><i class="fa-solid fa-paperclip" style="margin-right:5px;"></i>Quote: <a href="/api/admin/bookings/' + bookingId + '/quote/download" target="_blank" style="color:#D4AF37;">View Generated Quote</a></div>';
                }
                if (fin && fin.invoice) {
                    html += '<div style="margin-bottom:5px;"><i class="fa-solid fa-paperclip" style="margin-right:5px;"></i>Invoice: <a href="/api/admin/bookings/' + bookingId + '/invoice/download" target="_blank" style="color:#D4AF37;">View Generated Invoice</a></div>';
                }
                $('#bf-doc-links').html(html || '<div style="font-style:italic;color:#555;">No documents generated yet.</div>');
            }).catch(() => {
                $('#bf-doc-links').html('<div style="color:#ef5350;">Failed to load documents.</div>');
            });

            // Wire up action buttons
            $('#bf-btn-quote').data('id', bookingId);
            $('#bf-btn-invoice').off('click.bfinv').on('click.bfinv', function() {
                $('#bookingFinancialsModal').modal('hide');
                setTimeout(() => { generateInvoice(bookingId); }, 400);
            });
            $('#bf-btn-expense').off('click.bfexp').on('click.bfexp', function() {
                openExpenseModal(bookingId);
            });

            $('#bookingFinancialsModal').modal('show');
        });

        // When Generate Quote is clicked inside Financials modal, hide it first
        $(document).on('click', '#bf-btn-quote', function() {
            $('#bookingFinancialsModal').modal('hide');
        });

        // ═══════════════════════════════════════════════
        // MODAL 3 — EMAIL DISPATCHER  (.bk-action-email)
        // ═══════════════════════════════════════════════
        var beQuillInstance = null;

        $(document).on('click', '.bk-action-email', function() {
            const bookingId = $(this).data('id');
            const booking = allBookingsCache.find(b => b.id == bookingId);
            if (!booking) return;

            // Populate
            $('#be-booking-id').val(bookingId);
            $('#be-modal-title').text(booking.name || 'Booking #' + bookingId);
            $('#be-to').text(booking.email || '');
            $('#be-subject').val('Re: Thabiso Mhlongo Booking - ' + (booking.event_type || ''));
            $('#be-template').val('');
            $('#be-alert').hide().text('');

            // Init Quill (only once)
            if (!beQuillInstance) {
                beQuillInstance = new Quill('#be-quill-container', {
                    theme: 'snow',
                    placeholder: 'Type your message here…',
                    modules: {
                        toolbar: [['bold', 'italic', 'underline'], ['link'], [{ list: 'ordered' }, { list: 'bullet' }], ['clean']]
                    }
                });
                // Style the editor for dark mode
                var qlEditor = document.querySelector('#be-quill-container .ql-editor');
                if (qlEditor) { qlEditor.style.color = '#ddd'; qlEditor.style.minHeight = '180px'; }
                var qlToolbar = document.querySelector('#be-quill-container .ql-toolbar');
                if (qlToolbar) { qlToolbar.style.background = '#222'; qlToolbar.style.borderColor = '#333'; }
            }
            beQuillInstance.setText('');

            $('#bookingEmailModal').modal('show');
        });

        // Email template switcher for new modal
        $('#be-template').on('change', function() {
            const tmpl = $(this).val();
            const booking = allBookingsCache.find(b => b.id == $('#be-booking-id').val());
            const clientName = booking ? (booking.name || '').split(' ')[0] || 'there' : 'there';
            let text = '';

            if (tmpl === 'pricing') {
                text = 'Hi ' + clientName + ',\\n\\nThank you for reaching out regarding Thabiso\\'s availability for your event. Please find our standard rate card below:\\n\\n- Corporate Event (45 mins): R 35,000.00\\n- Private Function (30 mins): R 20,000.00\\n- Festival Appearance (15 mins): R 15,000.00\\n*(Prices exclude VAT and travel/accommodation outside Gauteng)*\\n\\nPlease let us know if this aligns with your budget and we can proceed with a formal contract.\\n\\nBest Regards,\\nThabiso Mhlongo Management';
            } else if (tmpl === 'available') {
                text = 'Hi ' + clientName + ',\\n\\nGreat news! Thabiso is available on your requested date. We would love to be part of your event.\\n\\nPlease reply to this email to confirm you would like to proceed with the booking, and we will draw up the invoice and contract.\\n\\nBest Regards,\\nThabiso Mhlongo Management';
            } else if (tmpl === 'decline') {
                text = 'Hi ' + clientName + ',\\n\\nThank you for considering Thabiso for your upcoming event. Unfortunately, he is already booked or unavailable on that specific date.\\n\\nWe appreciate the inquiry and hope to work together in the future!\\n\\nBest Regards,\\nThabiso Mhlongo Management';
            } else if (tmpl === 'call') {
                text = 'Hi ' + clientName + ',\\n\\nThank you for your inquiry. To best understand your event requirements and ensure Thabiso is the perfect fit, we would love to jump on a quick phone call.\\n\\nPlease let us know what time works best for you this week, or feel free to call our management number at +27 74 341 9681.\\n\\nBest Regards,\\nThabiso Mhlongo Management';
            }
            if (beQuillInstance && text) {
                beQuillInstance.setText(text.replace(/\\\\n/g, '\\n'));
            }
        });

        // Send email handler
        $('#be-send-btn').on('click', async function() {
            const bookingId = $('#be-booking-id').val();
            const subject = $('#be-subject').val();
            const message = beQuillInstance ? beQuillInstance.getText().trim() : '';
            const booking = allBookingsCache.find(b => b.id == bookingId);
            if (!booking) return;

            if (!subject || !message) {
                $('#be-alert').css('color', '#ef5350').text('Subject and message are required.').show();
                return;
            }

            const $btn = $('#be-send-btn');
            const origHtml = $btn.html();
            $btn.prop('disabled', true).html('<i class="fa fa-spinner fa-spin"></i> Sending…');

            try {
                const res = await apiCall('/api/admin/bookings/' + bookingId + '/respond', 'POST', {
                    email: booking.email,
                    subject: subject,
                    message: message
                });
                if (res.error || !res.success) {
                    window.notificationService.showError(res.error || res.message || 'Failed to send email.');
                    $btn.prop('disabled', false).html(origHtml);
                } else {
                    window.notificationService.showSuccess('Email dispatched successfully.');
                    booking.status = 'Responded';
                    setTimeout(() => {
                        $('#bookingEmailModal').modal('hide');
                        $('#bookingStatusFilter').trigger('change');
                        $btn.prop('disabled', false).html(origHtml);
                    }, 1500);
                }
            } catch (err) {
                window.notificationService.showError('Network error sending email.');
                $btn.prop('disabled', false).html(origHtml);
            }
        });
`;

// Replace lines 6996-7191 (0-indexed: 6995-7190)
const startIdx = 6995; // line 6996
const endIdx = 7191;   // line 7192 (exclusive)
const count = endIdx - startIdx;

lines.splice(startIdx, count, ...NEW_BLOCK.split('\n').map(l => l + '\r'));
fs.writeFileSync(file, lines.join('\n'), 'utf8');
console.log('Done. Old handler block (' + count + ' lines) replaced with new handlers (' + NEW_BLOCK.split('\n').length + ' lines). Total lines:', lines.length);
