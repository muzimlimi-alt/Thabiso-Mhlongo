/* Phase 6 (HOUSEKEEPING-NOTES.md "Section 21 / Bookings sub-batch 4: Booking Detail Actions"):
 * relocated VERBATIM from admin.html’s big Bookings inline <script> (was lines ~14666-15365) —
 * per-booking action handlers: status change / disposition (soft-decline) / mark-complete / record
 * refund / stat-pill filter click / clear-filters / open Record-Payment drawer / cancel-confirm /
 * resend quote / resend confirmation / Gap 11 Sync-to-Google-Calendar / Gap 9 view-by-client /
 * refresh email-comms history / the Timeline’s notes thread (load/add/delete) / review request /
 * reopen expired / book-again-from-cancelled / per-booking buffer save / venue edit (S5-2) /
 * promote-to-public-event toggle / ticket-link save / venue link+unlink.
 *
 * Confirmed self-contained except two DEFERRED cross-script-block calls (grepped, not assumed):
 * renderCommsThread / renderNotesThread are each called once from `loadDealViewTimelineData`
 * (admin.html ~11598/11610, a DIFFERENT, EARLIER inline <script> block that renders the Deal View
 * Timeline tab) — both call sites are inside a `fetch(...).then(...)` callback, i.e. fire only
 * after the whole page (all scripts, this one included) has already loaded, so the cross-script-
 * block reference is safe regardless of this file’s position in the load order (same pattern as
 * R_FMT / js/admin/financials.js in the Expense/Bank/Reconciliation sub-batch). `window.toggleBookingDetail`
 * (admin.html ~11865, same earlier block) is read here the same way — deferred, typeof-guarded.
 * `allBookingsCache` / `loadBookings` (still in admin.html’s big Bookings <script>, defined before
 * this file’s old position) and `openAtlDrawer` (components/drawer.js) are used, not moved.
 *
 * Nothing defined in this block (bkContractFinalised / bkUnsignedContractNote / renderCommsThread /
 * renderNotesThread / updatePromotePanel) is referenced from admin.html’s remaining Bookings script
 * content (the Pipeline/Archive sort+filter+table-render code that follows, starting at
 * `bookingNeedsAction` — confirmed by grep, not moved here). */
    // Status action buttons
    // A contract is "finalised" once signed & frozen — mirrors computeNextStepHint's contractFinalised
    // and server.js's own signed/is_frozen check. Used to warn (not block) Confirm/Complete when the
    // booking is about to move forward — or collect final payment — with no signed agreement on file.
    function bkContractFinalised(bk) {
        return !!bk && (String(bk.contract_status || '').toLowerCase() === 'signed' || bk.contract_is_frozen === 1);
    }
    function bkUnsignedContractNote(bk) {
        if (!bk) return '';
        if (bkContractFinalised(bk)) return '';
        if (!bk.contract_pdf_url) return ' Note: no contract has been generated for this booking yet.';
        if (!bk.contract_sent_at) return ' Note: a contract exists but has not been sent to the client for signature yet.';
        if (!bk.contract_signed_by_client_at) return ' Note: the contract has been sent but the client has not signed it yet.';
        return ' Note: the client has signed the contract but it has not been countersigned yet.';
    }

    $(document).off('click.bkact').on('click.bkact', '.bk-action-status', async function() {
        const id = $(this).data('id');
        const newStatus = $(this).data('status');
        let confirmMsg = `Change booking #${id} status to ${newStatus}?`;
        if (newStatus === 'CONFIRMED') {
            const bk = allBookingsCache.find(b => b.id == id);
            confirmMsg += bkUnsignedContractNote(bk);
        }
        if (!(await window.notificationService.showConfirm({ message: confirmMsg, isDestructive: false }))) return;
        try {
            const r = await fetch(`/api/admin/bookings/${id}/status`, { method:'PUT', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ status: newStatus }) });
            const d = await r.json();
            if (d.success) {
                window.notificationService.showSuccess(`Booking #${id} → ${newStatus}`);
                await loadBookings();
                // Re-open the Deal View if it's still visible after the filter is re-applied
                if (typeof window.toggleBookingDetail === 'function') window.toggleBookingDetail(id, true);

                if (newStatus === 'ACCEPTED') {
                    // Accepting fires a server-side chain (payment schedule + draft invoice + draft
                    // contract, see applyStatusChange's ACCEPTED branch) that runs fire-and-forget
                    // AFTER this response — so it isn't done yet. Poll once, after giving it a beat,
                    // and tell the admin what actually landed rather than leaving them to discover it
                    // (or its silent absence) by clicking into the Invoices/Offer & Contract tabs.
                    setTimeout(async () => {
                        try {
                            const fresh = await apiCall(`/api/admin/bookings/${id}`, 'GET');
                            const created = [];
                            const missing = [];
                            if (fresh && fresh.invoice_id) created.push('a draft invoice'); else missing.push('invoice');
                            if (fresh && fresh.contract_status) created.push('a draft contract'); else missing.push('contract');
                            if (created.length) window.notificationService.showSuccess(`Booking #${id}: ${created.join(' + ')} ready for review.`);
                            if (missing.length) window.notificationService.showError(`Booking #${id}: ${missing.join(' & ')} didn't auto-create — check the relevant tab or generate manually.`);
                            await loadBookings();
                            const $dv = $('#dealViewDrawer');
                            if ($dv.hasClass('atl-drawer--open') && $dv.data('bookingId') == id && typeof window.toggleBookingDetail === 'function') {
                                window.toggleBookingDetail(id, true);
                            }
                        } catch (e) { /* best-effort follow-up only, initial status change already succeeded */ }
                    }, 2500);
                }

                if (newStatus === 'CONFIRMED') {
                    const bk = allBookingsCache.find(b => b.id == id);
                    if (bk && !bk.event_id) {
                        $('#promoteBookingModalId').val(bk.id);
                        $('#promoteBookingModalName').text(bk.event_name || bk.name || 'Booking');
                        $('#promoteBookingModalDate').text(bk.date);
                        $('#promoteBookingModalVenue').text(bk.event_location || 'TBD');
                        $('#promoteBookingModal').modal('show');
                    }
                }
            } else { window.notificationService.showError(d.message || 'Status update failed.'); }
        } catch(e) { window.notificationService.showError('Network error.'); }
    });

    // Booking triage (soft-decline) — orthogonal to status/ALLOWED_TRANSITIONS, see
    // PUT /api/admin/bookings/:id/disposition. Confirm→PUT→toast→refresh mirrors .bk-action-status.
    $(document).off('click.bkdisposition').on('click.bkdisposition', '.bk-action-disposition', async function() {
        const id = $(this).data('id');
        const disposition = $(this).data('disposition');
        const actions = { active: `Restore booking #${id} to Active?`, not_a_fit: `Mark booking #${id} as Not a Fit?`, archived: `Archive booking #${id}?` };
        const msg = (actions[disposition] || `Change the disposition of booking #${id}?`)
            + (disposition !== 'active' ? ' This removes it from the active pipeline view and conversion counts — it can be restored at any time.' : '');
        if (!(await window.notificationService.showConfirm({ message: msg, isDestructive: false }))) return;
        try {
            const r = await fetch(`/api/admin/bookings/${id}/disposition`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ disposition }) });
            const d = await r.json();
            if (d.success) {
                window.notificationService.showSuccess(`Booking #${id}: disposition set to ${disposition === 'active' ? 'Active' : (disposition === 'not_a_fit' ? 'Not a Fit' : 'Archived')}.`);
                await loadBookings();
            } else { window.notificationService.showError(d.message || 'Could not update disposition.'); }
        } catch(e) { window.notificationService.showError('Network error.'); }
    });

    // Mark as Completed
    $(document).off('click.bkcomplete').on('click.bkcomplete', '.bk-action-complete', async function() {
        const id = $(this).data('id');
        const bk = allBookingsCache.find(b => b.id == id);
        const completeMsg = `Mark booking #${id} as COMPLETED? A thank-you email will be sent to the client.` + bkUnsignedContractNote(bk);
        if (!(await window.notificationService.showConfirm({ message: completeMsg, isDestructive: false }))) return;
        try {
            const r = await fetch(`/api/admin/bookings/${id}/complete`, { method: 'POST', headers: { 'Content-Type': 'application/json' } });
            const d = await r.json();
            if (d.success) { window.notificationService.showSuccess(`Booking #${id} marked as completed.`); await loadBookings(); }
            else { window.notificationService.showError(d.message || 'Failed to mark completed.'); }
        } catch(e) { window.notificationService.showError('Network error.'); }
    });

    // Record Refund
    $(document).off('click.bkrefund').on('click.bkrefund', '.bk-action-refund', async function() {
        const id = $(this).data('id');
        
        // Fetch full detail to get cancellation info
        let booking = null;
        try {
            booking = await apiCall(`/api/admin/bookings/${id}`);
        } catch(e) {
            window.notificationService.showError('Failed to fetch booking details for refund.');
            return;
        }

        const refundDue = booking.refund_due || 0;
        const paid      = booking.cancellation_paid_snapshot || booking.amount_paid || 0;
        const retention = booking.retention_amount || 0;

        const html = `
            <div style="padding:4px 0;">
                <div style="background:rgba(212,175,55,.05); border:1px solid rgba(212,175,55,.2); border-radius:6px; padding:10px; margin-bottom:15px; font-size:12px;">
                    <div style="display:flex; justify-content:space-between; margin-bottom:4px;">
                        <span style="color: var(--atl-muted);">Total Paid:</span>
                        <span style="color: var(--atl-ink); font-weight:700;">R ${parseFloat(paid).toFixed(2)}</span>
                    </div>
                    <div style="display:flex; justify-content:space-between; margin-bottom:4px;">
                        <span style="color: var(--atl-muted);">Retention (Policy):</span>
                        <span style="color:var(--atl-clay);">R ${parseFloat(retention).toFixed(2)}</span>
                    </div>
                    <div style="display:flex; justify-content:space-between; margin-top:8px; padding-top:8px; border-top:1px solid var(--atl-line);">
                        <span style="color: var(--atl-amber); font-weight:700;">Recommended Refund:</span>
                        <span style="color: var(--atl-amber); font-weight:700;">R ${parseFloat(refundDue).toFixed(2)}</span>
                    </div>
                </div>
                <div class="form-group" style="margin-bottom:12px;">
                    <label style="font-size:11px;font-weight:700;text-transform:uppercase;color: var(--atl-muted);display:block;margin-bottom:4px;">Refund Amount (R)</label>
                    <input type="number" id="rfAmount" min="0" step="0.01" class="atl-input" style="background: var(--atl-paper);border:1px solid var(--atl-line);color: var(--atl-ink);border-radius:6px;" value="${parseFloat(refundDue).toFixed(2)}">
                </div>
                <div class="form-group" style="margin-bottom:12px;">
                    <label style="font-size:11px;font-weight:700;text-transform:uppercase;color: var(--atl-muted);display:block;margin-bottom:4px;">Reference / EFT Ref</label>
                    <input type="text" id="rfReference" class="atl-input" style="background: var(--atl-paper);border:1px solid var(--atl-line);color: var(--atl-ink);border-radius:6px;" placeholder="e.g. EFT_REF_123">
                </div>
                <div class="form-group">
                    <label style="font-size:11px;font-weight:700;text-transform:uppercase;color: var(--atl-muted);display:block;margin-bottom:4px;">Notes</label>
                    <input type="text" id="rfNotes" class="atl-input" style="background: var(--atl-paper);border:1px solid var(--atl-line);color: var(--atl-ink);border-radius:6px;" placeholder="e.g. Processed via Bank Transfer">
                </div>
            </div>`;

        window.notificationService.showConfirm({ 
            message: html, 
            isDestructive: false, 
            confirmText: 'Record Refund', 
            title: `Record Refund – Booking #${id}` 
        }).then(async confirmed => {
            if (!confirmed) return;
            const amount    = parseFloat($('#rfAmount').val()) || 0;
            const reference = $('#rfReference').val() || '';
            const notes     = $('#rfNotes').val() || '';
            
            if (amount > paid) {
                window.notificationService.showError(`Refund cannot exceed amount paid (R${paid.toFixed(2)}).`);
                return;
            }

            try {
                const r = await fetch(`/api/admin/bookings/${id}/refund`, { 
                    method: 'PUT', 
                    headers: { 'Content-Type': 'application/json' }, 
                    body: JSON.stringify({ refund_amount: amount, refund_reference: reference, notes }) 
                });
                const d = await r.json();
                if (d.success) { 
                    window.notificationService.showSuccess(d.message || `Refund recorded for booking #${id}.`); 
                    loadBookings(); 
                } else { 
                    window.notificationService.showError(d.message || 'Failed to record refund.'); 
                }
            } catch(e) { window.notificationService.showError('Network error.'); }
        });
    });

    // Click stat pills to filter — also highlights active pill and clears search
    $(document).off('click.statpill').on('click.statpill', '.bk-stat-pill', function() {
        const status = $(this).data('status');
        $('#bkSearchInput').val('');
        $('#bookingStatusFilter').val(status).trigger('change');
        if (typeof window.updatePills === 'function') window.updatePills();
    });

    // Clear Filters Click Handler
    $(document).off('click.clearfilters').on('click.clearfilters', '#clearFilters', function() {
        $('#bkSearchInput').val('');
        $('#bookingStatusFilter').val('All');
        $('#bookingDispositionFilter').val('active').trigger('change');
        if (typeof window.updatePills === 'function') window.updatePills();
    });

    // Record Payment — open modal
    $(document).off('click.bkpay').on('click.bkpay', '.bk-action-record-payment', function() {
        const id    = $(this).data('id');
        const quote = $(this).data('quote') || '';
        const raw   = parseFloat(quote.toString().replace(/[^0-9.]/g, '')) || 0;
        $('#rpBookingId').val(id);
        $('#rpBookingLabel').text('Booking #' + id);
        $('#rpAmountPaid').val(raw > 0 ? raw.toFixed(2) : '');
        $('#rpPaymentStatus').val('PAID');
        openAtlDrawer('recordPaymentDrawer');
    });

    $(document).off('click.bk_cancel_cf').on('click.bk_cancel_cf', '#cancelConfirmBtn', async function() {
        const id     = $('#cancelBookingId').val();
        const $btn   = $(this);
        $btn.prop('disabled', true).html('<i class="fa-solid fa-spinner fa-spin" style="margin-right:6px;"></i>Cancelling…');
        try {
            const r = await fetch('/api/admin/bookings/' + id + '/cancel', {
                method: 'POST',
                credentials: 'include',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    reason:         $('#cancelReason').val().trim(),
                    cancelled_by:   $('#cancelCancelledBy').val(),
                    refund_amount:  parseFloat($('#cancelRefundAmount').val()) || 0,
                    notes:          $('#cancelNotes').val().trim()
                })
            });
            const d = await r.json();
            if (d.success) {
                $('#cancelBookingModal').modal('hide');
                window.notificationService.showSuccess('Booking Cancelled', 'The booking has been cancelled and the client notified.');
                loadBookings();
            } else {
                $('#cancelModalMsg').css('color','var(--atl-clay)').text(d.message || 'Cancellation failed.');
            }
        } catch(e) {
            $('#cancelModalMsg').css('color','var(--atl-clay)').text('Network error. Please try again.');
        } finally {
            $btn.prop('disabled', false).html('<i class="fa-solid fa-ban" style="margin-right:6px;"></i>Confirm Cancellation');
        }
    });

    // ─── Resend Quote ───
    $(document).off('click.bkresendq').on('click.bkresendq', '.bk-action-resend-quote', async function() {
        const id = $(this).data('id');
        if (!(await window.notificationService.showConfirm({ message: `Resend quote email to client for booking #${id}?` }))) return;
        try {
            const r = await fetch(`/api/admin/bookings/${id}/resend-quote`, { method: 'POST' });
            const d = await r.json();
            d.success ? window.notificationService.showSuccess('Quote email resent.') : window.notificationService.showError(d.message || 'Failed.');
        } catch(e) { window.notificationService.showError('Network error.'); }
    });

    // ─── Resend Confirmation ───
    $(document).off('click.bkresendc').on('click.bkresendc', '.bk-action-resend-confirm', async function() {
        const id = $(this).data('id');
        if (!(await window.notificationService.showConfirm({ message: `Resend confirmation email for booking #${id}?` }))) return;
        try {
            const r = await fetch(`/api/admin/bookings/${id}/resend-confirmation`, { method: 'POST' });
            const d = await r.json();
            d.success ? window.notificationService.showSuccess('Confirmation email resent.') : window.notificationService.showError(d.message || 'Failed.');
        } catch(e) { window.notificationService.showError('Network error.'); }
    });

    // ─── Gap 11: Sync Booking to Google Calendar ───
    $(document).off('click.bksyncal').on('click.bksyncal', '.bk-action-sync-cal', async function() {
        const id = $(this).data('id');
        $(this).prop('disabled', true);
        try {
            const r = await fetch(`/api/admin/bookings/${id}/sync-calendar`, { method: 'POST' });
            const d = await r.json();
            d.success
                ? window.notificationService.showSuccess('Calendar Synced', 'Booking synced to Google Calendar.')
                : window.notificationService.showError('Sync failed: ' + (d.message || ''));
        } catch(e) { window.notificationService.showError('Network error during calendar sync.'); }
        $(this).prop('disabled', false);
    });

    // ─── Gap 9: View all bookings by this client (filter by email) ───
    $(document).off('click.bkclienthist').on('click.bkclienthist', '.bk-view-client-history', function(e) {
        e.preventDefault();
        const email = $(this).data('email');
        if (!email) return;
        // Switch to bookings section if needed
        if (typeof switchTab === 'function') switchTab('bookingsAdmin');
        // Set search field and trigger filter
        $('#admGlobalSearch').val(email).trigger('input');
        // Scroll to bookings section
        setTimeout(function() {
            var $sect = $('#bookingsAdmin');
            if ($sect.length) $sect[0].scrollIntoView({ behavior: 'smooth', block: 'start' });
        }, 300);
    });

    // ─── Refresh email communication history for a booking ───
    $(document).off('click.bkcommsload').on('click.bkcommsload', '.bk-comms-load-btn', async function() {
        const id = $(this).data('id');
        $(this).prop('disabled', true).html('<i class="fa-solid fa-spinner fa-spin"></i>');
        try {
            const r = await fetch(`/api/admin/bookings/${id}/communications`);
            const d = await r.json();
            renderCommsThread(id, d.logs);
        } catch(e) {
            $('#comms-thread-' + id).html('<p style="color:var(--atl-clay);font-size:12px;">Failed to load email history.</p>');
        }
        $(this).prop('disabled', false).html('<i class="fa-solid fa-arrows-rotate" style="margin-right:4px;"></i>Refresh');
    });

    // ─── Review Request ───
    $(document).off('click.bkreview').on('click.bkreview', '.bk-action-review-request', async function() {
        const id = $(this).data('id');
        if (!(await window.notificationService.showConfirm({ message: `Send a review request email to the client for booking #${id}?` }))) return;
        try {
            const r = await fetch(`/api/admin/bookings/${id}/review-request`, { method: 'POST' });
            const d = await r.json();
            d.success ? window.notificationService.showSuccess('Review request sent.') : window.notificationService.showError(d.message || 'Failed.');
        } catch(e) { window.notificationService.showError('Network error.'); }
    });

    // ─── Reopen Expired Booking ───
    $(document).off('click.bkreopen').on('click.bkreopen', '.bk-action-reopen', async function() {
        const id = $(this).data('id');
        const confirmed = await window.notificationService.showConfirm({
            message: `Reopen booking #${id}? It will return to PENDING status so you can issue a new quote. The expired quote will be cleared.`
        });
        if (!confirmed) return;
        try {
            const d = await apiCall(`/api/admin/bookings/${id}/reopen`, 'POST');
            if (d && d.success) {
                window.notificationService.showSuccess('Booking reopened — ready for a new quote.');
                await loadBookings();
            } else {
                window.notificationService.showError(d.message || 'Failed to reopen booking.');
            }
        } catch(e) { window.notificationService.showError('Network error reopening booking.'); }
    });

    // ─── Book Again (from Cancelled) ───
    $(document).off('click.bkbookagain').on('click.bkbookagain', '.bk-action-book-again', async function() {
        const id = $(this).data('id');
        const confirmed = await window.notificationService.showConfirm({
            message: `Create a new booking pre-filled with this client's details? The cancelled booking #${id} will remain as a closed record.`
        });
        if (!confirmed) return;
        try {
            const d = await apiCall(`/api/admin/bookings/${id}/book-again`, 'POST');
            if (d && d.success) {
                window.notificationService.showSuccess(`New booking #${d.new_booking_id} created. The cancelled booking remains on record.`);
                await loadBookings();
            } else {
                window.notificationService.showError(d.message || 'Failed to create new booking.');
            }
        } catch(e) { window.notificationService.showError('Network error creating new booking.'); }
    });

    function renderCommsThread(bookingId, logs) {
        var $thread = $('#comms-thread-' + bookingId);
        if (!logs || !logs.length) {
            $thread.html('<p style="color:var(--atl-muted);font-size:12px;margin:0;">No emails on record for this booking yet.</p>');
            return;
        }
        var html = logs.map(function(log) {
            var ts = log.sent_at ? new Date(log.sent_at).toLocaleString('en-ZA', {day:'2-digit',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit'}) : '';
            var snippet = '';
            if (log.content_snippet) {
                var _tmp = document.createElement('div');
                _tmp.innerHTML = log.content_snippet;
                snippet = (_tmp.textContent || _tmp.innerText || '').replace(/\s+/g, ' ').trim();
            }
            return '<div style="background:var(--atl-paper);border:1px solid var(--atl-line);border-radius:6px;padding:10px 12px;margin-bottom:8px;">' +
                '<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px;flex-wrap:wrap;margin-bottom:' + (snippet ? '6px' : '0') + ';">' +
                    '<div style="display:flex;align-items:center;gap:6px;min-width:0;">' +
                        '<i class="fa-regular fa-envelope" style="color:var(--atl-amber);font-size:11px;flex-shrink:0;"></i>' +
                        '<span style="color:var(--atl-ink);font-weight:600;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + (log.subject || '(No subject)') + '</span>' +
                    '</div>' +
                    '<span style="color:var(--atl-muted);font-size:10px;white-space:nowrap;flex-shrink:0;">' + ts + '</span>' +
                '</div>' +
                (snippet ? '<div style="color:var(--atl-muted-dim);font-size:11px;line-height:1.55;word-break:break-word;overflow-wrap:anywhere;border-top:1px solid var(--atl-line);padding-top:6px;">' + snippet + '</div>' : '') +
            '</div>';
        }).join('');
        $thread.html(html);
    }

    function renderNotesThread(id, notes) {
        try {
            var $thread = $(`#notes-thread-${id}`);
            if (!notes || notes.length === 0) {
                $thread.html('<div style="font-size:11px;color:#555;padding:6px 0;">No notes yet.</div>');
                return;
            }
            $thread.html(notes.map(function(n) {
                let ts = 'N/A';
                if (n.created_at) {
                    try {
                        const isoStr = n.created_at.replace(' ', 'T');
                        ts = new Date(isoStr).toLocaleString('en-ZA', { dateStyle: 'short', timeStyle: 'short' });
                    } catch(e) {
                        try {
                            ts = new Date(n.created_at).toLocaleString('en-ZA', { dateStyle: 'short', timeStyle: 'short' });
                        } catch(e2) {
                            ts = n.created_at;
                        }
                    }
                }
                var isClient = n.author === 'Client';
                var borderStyle = isClient ? 'border:1px solid rgba(212,175,55,0.4);background:rgba(212,175,55,0.03);' : 'border:1px solid #222;background:#0d0d0d;';
                var authorStyle = isClient ? 'color: var(--atl-amber);font-weight:600;' : 'color:#555;';
                var noteText = window.escHtml(n.note || '').replace(/\n/g, '<br>');
                return `<div class="bk-note-item" style="padding:6px 8px;margin-bottom:4px;border-radius:4px;${borderStyle}">` +
                    `<div style="font-size:11px;color:#aaa;line-height:1.5;">${noteText}</div>` +
                    `<div style="margin-top:4px;display:flex;justify-content:space-between;align-items:center;">` +
                    `<span style="font-size:10px;${authorStyle}">${n.author || 'System'} &middot; ${ts}</span>` +
                    `<button type="button" class="bk-delete-note-btn" data-booking-id="${id}" data-note-id="${n.id}" style="background:none;border:none;color:var(--atl-clay);font-size:10px;cursor:pointer;padding:0;"><i class="fa-solid fa-trash-can"></i></button>` +
                    `</div></div>`;
            }).join(''));
        } catch(err) {
            console.error('[renderNotesThread] Error:', err);
        }
    }

    $(document).off('click.bknotesload').on('click.bknotesload', '.bk-notes-load-btn', async function() {
        var id = $(this).data('id');
        try {
            var r = await fetch(`/api/admin/bookings/${id}/notes`);
            var d = await r.json();
            if (d.success) renderNotesThread(id, d.notes);
        } catch(e) { window.notificationService.showError('Failed to load notes.'); }
    });

    $(document).off('click.bkaddnote').on('click.bkaddnote', '.bk-add-note-btn', async function() {
        var id = $(this).data('id');
        var $input = $(`#note-input-${id}`);
        var noteText = $input.val().trim();
        if (!noteText) { window.notificationService.showWarning('Empty Note', 'Please enter some text before adding.'); return; }
        try {
            var r = await fetch(`/api/admin/bookings/${id}/notes`, { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ note: noteText, author: 'Admin' }) });
            var d = await r.json();
            if (d.success) {
                $input.val('');
                var r2 = await fetch(`/api/admin/bookings/${id}/notes`);
                var d2 = await r2.json();
                if (d2.success) renderNotesThread(id, d2.notes);
            } else { window.notificationService.showError(d.message || 'Failed to add note.'); }
        } catch(e) { window.notificationService.showError('Network error.'); }
    });

    $(document).off('click.bkdelnote').on('click.bkdelnote', '.bk-delete-note-btn', async function() {
        var bookingId = $(this).data('booking-id');
        var noteId    = $(this).data('note-id');
        if (!(await window.notificationService.showConfirm({ message: 'Delete this note?', isDestructive: true }))) return;
        try {
            var r = await fetch(`/api/admin/bookings/${bookingId}/notes/${noteId}`, { method: 'DELETE' });
            var d = await r.json();
            if (d.success) {
                var r2 = await fetch(`/api/admin/bookings/${bookingId}/notes`);
                var d2 = await r2.json();
                if (d2.success) renderNotesThread(bookingId, d2.notes);
            } else { window.notificationService.showError(d.message || 'Failed to delete note.'); }
        } catch(e) { window.notificationService.showError('Network error.'); }
    });

    // ─── Per-booking buffer save ───
    $(document).off('click.bksavebuffer').on('click.bksavebuffer', '.bk-save-buffer-btn', async function() {
        const id    = $(this).data('id');
        const $inp  = $(`#bk-buf-${id}`);
        const $hint = $(`#bk-buf-hint-${id}`);
        const $btn  = $(this);
        const raw   = $inp.val().trim();
        const mins  = raw === '' ? null : parseInt(raw);
        $btn.prop('disabled', true).text('Saving…');
        try {
            const res = await apiCall(`/api/admin/bookings/${id}/buffer`, 'PATCH', { buffer_minutes: mins });
            if (res.success) {
                const booking = allBookingsCache.find(b => b.id == id);
                if (booking) booking.buffer_minutes = mins;
                $hint.text('✓ saved').css('color', 'var(--atl-sage)');
                $btn.css('color', 'var(--atl-sage)').text('Saved');
                setTimeout(() => {
                    $btn.css('color', 'var(--atl-amber)').text('Save');
                    $hint.text(mins == null ? '← type default' : '').css('color', 'var(--atl-muted-dim)');
                }, 2000);
            } else {
                $hint.text('Error').css('color', 'var(--atl-clay)');
                $btn.prop('disabled', false).text('Save');
            }
        } catch(e) {
            $hint.text('Error').css('color', 'var(--atl-clay)');
            $btn.prop('disabled', false).text('Save');
        }
    });

    // ─── S5-2: Venue / Location Edit Handlers ───
    $(document).off('click.bkvenueedit').on('click.bkvenueedit', '.bk-venue-edit-btn', function() {
        var id = $(this).data('id');
        $(`#venue-edit-row-${id}`).slideDown(150);
        $(this).hide();
    });

    $(document).off('click.bkvenuecancel').on('click.bkvenuecancel', '.bk-venue-cancel-btn', function() {
        var id = $(this).data('id');
        $(`#venue-edit-row-${id}`).slideUp(150);
        $(`.bk-venue-edit-btn[data-id="${id}"]`).show();
    });

    $(document).off('click.bkvenuesave').on('click.bkvenuesave', '.bk-venue-save-btn', async function() {
        var id  = $(this).data('id');
        var loc = $(`#venue-loc-${id}`).val().trim();
        if (!loc) { window.notificationService.showWarning('Required', 'Venue / location name is required.'); return; }
        var payload = {
            event_location: loc,
            venue_address:  $(`#venue-addr-${id}`).val().trim() || null,
            city:           $(`#venue-city-${id}`).val().trim() || null,
            country:        $(`#venue-country-${id}`).val().trim() || null
        };
        try {
            var r = await fetch(`/api/admin/bookings/${id}/venue`, { method: 'PATCH', headers: {'Content-Type':'application/json'}, body: JSON.stringify(payload) });
            var d = await r.json();
            if (d.success) {
                window.notificationService.showSuccess('Venue updated. Calendar synced.');
                $(`#venue-edit-row-${id}`).slideUp(150);
                $(`.bk-venue-edit-btn[data-id="${id}"]`).show();
                await loadBookings();
            } else { window.notificationService.showError(d.message || 'Failed to update venue.'); }
        } catch(e) { window.notificationService.showError('Network error.'); }
    });

    // ─── Promote toggle ───
    function updatePromotePanel(id, isPublic, preview) {
        const $badge   = $(`#promote-badge-${id}`);
        const $preview = $(`#promote-preview-${id}`);

        if (isPublic) {
            $badge.removeClass('bkr-promote-live-badge--off atl-promote-live-badge--off')
                  .addClass('atl-promote-live-badge')
                  .html('LIVE');
            $preview.removeClass('bkr-promote-preview--hidden atl-promote-preview--hidden');
        } else {
            $badge.addClass('bkr-promote-live-badge--off atl-promote-live-badge--off')
                  .removeClass('atl-promote-live-badge')
                  .html('Not Promoted');
            $preview.addClass('bkr-promote-preview--hidden atl-promote-preview--hidden');
        }

        // If server returned a preview, update the ticket link display inside the preview
        if (preview && preview.ticket_link) {
            let $ticketDiv = $preview.find('.bkr-promote-preview__ticket, .atl-promote-preview__ticket');
            if (!$ticketDiv.length) {
                // Check if target is old preview structure or new preview structure
                let $body = $preview.find('.bkr-promote-preview__body');
                if ($body.length) {
                    $body.append('<div class="bkr-promote-preview__ticket"></div>');
                    $ticketDiv = $preview.find('.bkr-promote-preview__ticket');
                } else {
                    $preview.append('<div class="atl-promote-preview__ticket" style="margin-top:8px; padding-top:8px; border-top:1px solid rgba(212,175,55,0.12); font-size:11px;"></div>');
                    $ticketDiv = $preview.find('.atl-promote-preview__ticket');
                }
            }
            $ticketDiv.html(`<i class="fa-solid fa-ticket" style="margin-right:5px;color:var(--atl-amber);"></i><a href="${preview.ticket_link}" target="_blank" rel="noopener" class="atl-det-link" style="word-break:break-all;">${preview.ticket_link}</a>`);
        }

    }

    $(document).off('click.promote').on('click.promote', '.promote-toggle', async function() {
        const id       = $(this).data('id');
        const $btn     = $(this);
        const currentChecked = $btn.attr('aria-checked') === 'true';
        const isPublic = currentChecked ? 0 : 1;
        const ticketLink = $(`#promote-ticket-${id}`).val().trim() || null;

        try {
            const r = await fetch(`/api/admin/bookings/${id}/public`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ is_public: isPublic, ticket_link: ticketLink })
            });
            const d = await r.json();
            if (d.success) {
                window.notificationService.showSuccess(isPublic ? 'Event promoted to Upcoming Shows!' : 'Event removed from public site.');
                $btn.attr('aria-checked', isPublic ? 'true' : 'false');
                // Update panel UI immediately without reload
                updatePromotePanel(id, isPublic, d.preview);
                // Sync local cache
                const b = allBookingsCache.find(x => x.id == id);
                if (b) {
                    b.is_public = isPublic;
                    if (ticketLink) b.ticket_link = ticketLink;
                    b.event_id = d.preview ? d.preview.event_id : null;
                }
                if (isPublic && d.preview) {
                    setTimeout(() => window.notificationService.showSuccess(
                        'Event created as a draft. Open the Events tab to publish it on the site.'), 1800);
                }
            } else {
                window.notificationService.showError(d.message || 'Failed to update promotion status.');
            }
        } catch(e) {
            window.notificationService.showError('Network error.');
        }
    });

    // ─── Ticket link save button ───
    $(document).off('click.promotesave').on('click.promotesave', '.bkr-promote-ticket-save', async function() {
        const id         = $(this).data('id');
        const ticketLink = $(`#promote-ticket-${id}`).val().trim() || null;
        const isPublic   = $(`#promote-${id}`).attr('aria-checked') === 'true' ? 1 : 0;
        const $msg       = $(`#promote-ticket-msg-${id}`);
        const $btn       = $(this);

        $btn.prop('disabled', true).html('<i class="fa-solid fa-spinner fa-spin" style="margin-right:4px;"></i>Saving…');
        $msg.hide().text('');

        try {
            const r = await fetch(`/api/admin/bookings/${id}/public`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ is_public: isPublic, ticket_link: ticketLink })
            });
            const d = await r.json();
            if (d.success) {
                $msg.css('color', 'var(--atl-sage)').text('✓ Ticket link saved.').show();
                updatePromotePanel(id, isPublic, d.preview);
                // Sync local cache
                const b = allBookingsCache.find(x => x.id == id);
                if (b) {
                    b.ticket_link = ticketLink;
                    b.event_id = d.preview ? d.preview.event_id : null;
                }
                setTimeout(() => $msg.fadeOut(400), 3000);
            } else {
                $msg.css('color', 'var(--atl-clay)').text(d.message || 'Save failed.').show();
            }
        } catch(e) {
            $msg.css('color', 'var(--atl-clay)').text('Network error.').show();
        }
        $btn.prop('disabled', false).html('<i class="fa-solid fa-floppy-disk" style="margin-right:4px;"></i>Save');
    });

    // ─── Venue link and unlink handlers ───
    $(document).off('click.bklinkvenuegoogle').on('click.bklinkvenuegoogle', '.bk-link-venue-google-btn', async function() {
        const id = $(this).data('booking-id');
        const payload = $(this).data('payload');
        if (!payload) return;

        const $btn = $(this);
        const origHtml = $btn.html();
        $btn.prop('disabled', true).html('<i class="fa-solid fa-spinner fa-spin"></i> Linking...');

        try {
            const r = await fetch(`/api/admin/bookings/${id}/venue-google`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
            const d = await r.json();
            if (d.success) {
                window.notificationService.showSuccess(d.message || 'Venue linked successfully.');
                loadBookings();
            } else {
                window.notificationService.showError(d.message || 'Failed to link venue.');
                $btn.prop('disabled', false).html(origHtml);
            }
        } catch(e) {
            window.notificationService.showError('Network error linking venue.');
            $btn.prop('disabled', false).html(origHtml);
        }
    });

    $(document).off('click.bkunlinkvenue').on('click.bkunlinkvenue', '.bk-unlink-venue-btn', async function() {
        const id = $(this).data('booking-id');
        if (!id) return;
        
        if (!(await window.notificationService.showConfirm({ message: 'Are you sure you want to unlink this venue?', isDestructive: true }))) {
            return;
        }

        const $btn = $(this);
        const origHtml = $btn.html();
        $btn.prop('disabled', true).html('<i class="fa-solid fa-spinner fa-spin"></i> Unlinking...');

        try {
            const r = await fetch(`/api/admin/bookings/${id}/venue`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ venue_id: null })
            });
            const d = await r.json();
            if (d.success) {
                window.notificationService.showSuccess(d.message || 'Venue unlinked.');
                loadBookings();
            } else {
                window.notificationService.showError(d.message || 'Failed to unlink venue.');
                $btn.prop('disabled', false).html(origHtml);
            }
        } catch(e) {
            window.notificationService.showError('Network error unlinking venue.');
            $btn.prop('disabled', false).html(origHtml);
        }
    });
