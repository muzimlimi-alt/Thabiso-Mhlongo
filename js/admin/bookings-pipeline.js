/* Phase 6 (HOUSEKEEPING-NOTES.md "Section 21 / Bookings sub-batch 6: Core Pipeline + Deal View content"):
 * relocated VERBATIM from admin.html’s big Bookings inline <script> (was lines ~12201-14345,
 * everything remaining in that script once sub-batches 1-4 had already been pulled out of it) —
 * the core engine: `allBookingsCache` + `loadBookings()`, the quote/invoice detail formatters,
 * the "next step" / progress-checklist computations, EVERY Deal View tab’s content builder
 * (`buildOverviewPanel`/`buildOfferPanel`/`buildInvoicesPanel`/`buildTimelinePanel`/
 * `buildFilesPanel`/`buildAdvancingPanel`), `renderBookingsTable` (renders both Pipeline and,
 * via its `containerSelector` param, Archive), `bookingNeedsAction`, the shared sort+pagination
 * (Pipeline and Archive both filter client-side over `allBookingsCache`), the Archive tab, and
 * A3 bulk pipeline actions (select mode + CSV export + bulk cancel).
 *
 * This is the single most depended-upon Bookings file: `allBookingsCache`/`loadBookings`/
 * `renderBookingsTable` are referenced from EVERY other bookings-*.js file extracted this session
 * (contracts/finance/quote/actions/dealview) plus far-later, unrelated parts of admin.html —
 * confirmed by grep to be exclusively DEFERRED references (inside event handlers / async
 * functions / setTimeout, never at script-eval time), so this file’s position in the load order
 * doesn’t matter beyond "loads before any user interaction", which every <script src> here does.
 * The reverse is also true and was checked: `buildOverviewPanel`/`buildOfferPanel`/
 * `buildInvoicesPanel`/`buildTimelinePanel`/`buildFilesPanel`/`buildAdvancingPanel`/
 * `buildAdvancingStub` are each called exactly once, from `dvRenderFromRow` in
 * js/admin/bookings-dealview.js (sub-batch 5) — also deferred (fires only when a Deal View is
 * opened), so the cross-file reference is safe regardless of which of these two files loads first.
 *
 * Nothing from sub-batches 1-4 (Contract Management / Finance / Quote Builder / Booking Detail
 * Actions) or sub-batch 5 (Deal View drawer mechanics) is redefined here — confirmed by grep. */
        // --- Bookings ---
        let allBookingsCache = [];

        async function loadBookings() {
            const $container = $('#bookingsListContainer');
            $container.html('<div class="bkr-empty" style="padding:40px 20px;"><i class="fa-solid fa-circle-notch fa-spin" style="font-size:28px;opacity:.4;display:block;margin-bottom:12px;"></i><p>Loading…</p></div>');

            try {
                const data = await apiCall('/api/admin/bookings/full');

                if (!data || data.error || !Array.isArray(data)) {
                    $container.html('<div class="bkr-empty"><i class="fa-solid fa-triangle-exclamation"></i><p>Failed to load bookings. Please refresh.</p></div>');
                    return;
                }

                allBookingsCache = data;

                // Bug fix: the Deal View's once-only lazy-load guards (quote-history/contract/
                // line-items/transactions/payment-schedule/files, notes+comms, advancing pack) never
                // invalidated, so a booking whose Offer/Timeline/Advancing tab was visited earlier in
                // the session kept showing stale data on reopen even after e.g. generating a contract
                // via the separate Legal Contracts drawer. loadBookings() re-fetching the canonical
                // list is the right moment to drop all three — cheap re-fetches, always fresh.
                if (typeof dealViewLoadedIds !== 'undefined') dealViewLoadedIds = {};
                if (typeof dealViewTimelineLoaded !== 'undefined') dealViewTimelineLoaded = {};
                if (typeof dealViewAdvancingLoaded !== 'undefined') dealViewAdvancingLoaded = {};

                // Update pipeline pill counts
                ['NEW','PENDING','QUOTED','ACCEPTED','CONFIRMED','COMPLETED','EXPIRED','CANCELLED'].forEach(s => {
                    $(`#bkStat-${s}`).text(data.filter(b => (b.status||'').toUpperCase() === s).length);
                });

                // Re-apply current filter/search
                applyBookingFilter();
                if (typeof applyArchiveFilter === 'function') applyArchiveFilter();
            } catch(e) {
                console.error('[loadBookings]', e);
                $container.html('<div class="bkr-empty"><i class="fa-solid fa-triangle-exclamation"></i><p>Failed to load bookings. Please refresh.</p></div>');
                window.notificationService.showError('Could not load bookings — please check your connection and refresh.');
            }
        }

        // Parse and format quote_details JSON into a readable HTML breakdown
        function formatQuoteDetails(quoteDetailsJson) {
            if (!quoteDetailsJson) return '';
            let qd;
            try { qd = JSON.parse(quoteDetailsJson); } catch(e) { return `<div style="font-size:12px;color:var(--atl-muted);margin-top:6px;">${quoteDetailsJson}</div>`; }
            if (!qd || !Array.isArray(qd.items)) return `<div style="font-size:12px;color:var(--atl-muted);margin-top:6px;">${quoteDetailsJson}</div>`;

            let html = '<table style="width:100%;font-size:12px;color: var(--atl-ink-dim);margin-top:8px;border-collapse:collapse;">';
            html += '<tr style="color:var(--atl-muted-dim);border-bottom: 1px solid var(--atl-line);"><th style="text-align:left;padding:3px 0;font-weight:normal;">Item</th><th style="text-align:center;padding:3px 0;font-weight:normal;">Qty</th><th style="text-align:right;padding:3px 0;font-weight:normal;">Unit</th><th style="text-align:right;padding:3px 0;font-weight:normal;">Total</th></tr>';
            qd.items.forEach(function(item) {
                const qty = item.quantity_minutes || item.quantity || 1;
                const rowTotal = qty * (item.unit_price || 0);
                html += `<tr><td style="padding:4px 0;">${item.description || ''}</td><td style="text-align:center;">${qty}</td><td style="text-align:right;">R ${parseFloat(item.unit_price || 0).toFixed(2)}</td><td style="text-align:right;color: var(--atl-amber);font-weight:700;">R ${rowTotal.toFixed(2)}</td></tr>`;
            });
            html += '</table>';
            if (parseFloat(qd.discount) > 0) html += `<div style="text-align:right;font-size:11px;color:var(--atl-muted);margin-top:4px;">Discount: &minus;R ${parseFloat(qd.discount).toFixed(2)}</div>`;
            if (qd.apply_vat) html += `<div style="text-align:right;font-size:11px;color:var(--atl-muted);">VAT (15%): R ${parseFloat(qd.vat || 0).toFixed(2)}</div>`;
            if (qd.terms) html += `<div style="font-size:11px;color:var(--atl-muted-dim);margin-top:8px;border-top: 1px solid var(--atl-line);padding-top:6px;"><strong style="color: var(--atl-muted);">Terms:</strong> ${qd.terms}</div>`;
            return html;
        }

        function formatQuoteDetailsAtelier(json, totalAmount, expiryDate, bookingId, quoteSentAt) {
            var prepareBtn = bookingId
                ? '<div class="atl-doc-actions-row" style="margin-top:8px;">'
                  + '<button type="button" class="atl-btn atl-btn--ghost bk-action-quote" data-id="' + bookingId + '">'
                  + '<i class="fa-solid fa-file-pen" style="margin-right:6px;"></i>Prepare Quote</button></div>'
                : '';
            if (!json) return '<p class="atl-det-empty">No line items on record.</p>' + prepareBtn;
            var qd;
            try { qd = JSON.parse(json); } catch(e) { return '<p class="atl-det-empty">Quote details unavailable.</p>' + prepareBtn; }
            if (!qd || !Array.isArray(qd.items)) return '<p class="atl-det-empty">Quote details unavailable.</p>' + prepareBtn;

            var subtotal = 0;
            var rows = qd.items.map(function(item) {
                var qty  = item.quantity_minutes || item.quantity || 1;
                var unit = parseFloat(item.unit_price || 0);
                var tot  = qty * unit;
                subtotal += tot;
                return '<tr>'
                    + '<td data-label="Description">' + (item.description || '—') + '</td>'
                    + '<td data-label="Qty" class="right atl-det-tabular">' + qty + '</td>'
                    + '<td data-label="Unit" class="right atl-det-tabular">R ' + unit.toFixed(2) + '</td>'
                    + '<td data-label="Total" class="right atl-det-tabular" style="font-weight:700;">R ' + tot.toFixed(2) + '</td>'
                    + '</tr>';
            }).join('');

            var discount    = parseFloat(qd.discount || 0);
            var vatAmount   = qd.apply_vat ? Math.round((subtotal - discount) * 0.15) : 0;
            var displayTotal = parseFloat(totalAmount || 0) || (subtotal - discount + vatAmount);

            var tfoot = '<tr>'
                + '<td colspan="3" class="right" style="color:var(--atl-muted);padding-top:8px;">Subtotal</td>'
                + '<td class="right atl-det-tabular" style="padding-top:8px;">R ' + subtotal.toFixed(2) + '</td>'
                + '</tr>';
            if (discount > 0) {
                tfoot += '<tr>'
                    + '<td colspan="3" class="right" style="color:var(--atl-muted);">Discount</td>'
                    + '<td class="right atl-det-tabular" style="color:var(--atl-clay);">&ndash;R ' + discount.toFixed(2) + '</td>'
                    + '</tr>';
            }
            if (qd.apply_vat) {
                tfoot += '<tr>'
                    + '<td colspan="3" class="right" style="color:var(--atl-muted);">VAT (15%)</td>'
                    + '<td class="right atl-det-tabular">R ' + vatAmount.toFixed(2) + '</td>'
                    + '</tr>';
            }
            tfoot += '<tr>'
                + '<td colspan="3" class="right" style="padding-top:6px;font-weight:700;">Total</td>'
                + '<td class="right atl-det-tabular" style="font-weight:700;font-size:14px;color:var(--atl-amber);">'
                + 'R ' + displayTotal.toFixed(2) + '</td>'
                + '</tr>';
            if (qd.terms) {
                tfoot += '<tr><td colspan="4" class="atl-tfoot-terms">'
                    + '<strong style="color:var(--atl-ink);">Terms:</strong> ' + qd.terms
                    + '</td></tr>';
            }

            var html = '<table class="atl-det-table atl-det-table-responsive">'
                + '<thead><tr>'
                + '<th>Description</th>'
                + '<th class="right">Qty</th>'
                + '<th class="right">Unit</th>'
                + '<th class="right">Total</th>'
                + '</tr></thead>'
                + '<tbody>' + rows + '</tbody>'
                + '<tfoot>' + tfoot + '</tfoot>'
                + '</table>';

            if (expiryDate) {
                html += '<p style="font-size:11px;color:var(--atl-muted);margin-top:8px;">Expires: ' + expiryDate + '</p>';
            }
            if (bookingId) {
                var qSendLabel = quoteSentAt ? 'Resend Quote' : 'Send Quote';
                var qSendIcon  = quoteSentAt ? 'fa-rotate-right' : 'fa-paper-plane';
                var qSendFn    = quoteSentAt
                    ? 'resendQuoteFromCard(' + bookingId + ')'
                    : 'sendQuoteFromCard(' + bookingId + ')';
                html += '<div class="atl-doc-actions-row">'
                    + '<a href="/api/admin/bookings/' + bookingId + '/quote/download" target="_blank" class="atl-btn atl-btn--ghost">'
                    + '<i class="fa-solid fa-file-pdf" style="margin-right:6px;"></i>Download Quote PDF'
                    + '</a>'
                    + '<button type="button" class="atl-btn atl-btn--ghost" onclick="' + qSendFn + '" aria-label="' + qSendLabel + '">'
                    + '<i class="fa-solid ' + qSendIcon + '" style="margin-right:6px;"></i>' + qSendLabel
                    + '</button>'
                    + '</div>';
            }
            return html;
        }

        function formatInvoiceDetailsAtelier(json, totalAmount, invoiceNumber, invoiceStatus, bookingId, invoiceId, invoiceSentAt, bookingPaymentStatus) {
            if (!json) return '<p class="atl-det-empty">No line items on record.</p>';
            var qd;
            try { qd = JSON.parse(json); } catch(e) { return '<p class="atl-det-empty">Invoice details unavailable.</p>'; }
            if (!qd || !Array.isArray(qd.items)) return '<p class="atl-det-empty">Invoice details unavailable.</p>';

            var subtotal = 0;
            var rows = qd.items.map(function(item) {
                var qty  = item.quantity_minutes || item.quantity || 1;
                var unit = parseFloat(item.unit_price || 0);
                var tot  = qty * unit;
                subtotal += tot;
                return '<tr>'
                    + '<td data-label="Description">' + (item.description || '—') + '</td>'
                    + '<td data-label="Qty" class="right atl-det-tabular">' + qty + '</td>'
                    + '<td data-label="Unit" class="right atl-det-tabular">R ' + unit.toFixed(2) + '</td>'
                    + '<td data-label="Total" class="right atl-det-tabular" style="font-weight:700;">R ' + tot.toFixed(2) + '</td>'
                    + '</tr>';
            }).join('');

            var discount    = parseFloat(qd.discount || 0);
            var vatAmount   = qd.apply_vat ? Math.round((subtotal - discount) * 0.15) : 0;
            var displayTotal = parseFloat(totalAmount || 0) || (subtotal - discount + vatAmount);

            var tfoot = '<tr>'
                + '<td colspan="3" class="right" style="color:var(--atl-muted);padding-top:8px;">Subtotal</td>'
                + '<td class="right atl-det-tabular" style="padding-top:8px;">R ' + subtotal.toFixed(2) + '</td>'
                + '</tr>';
            if (discount > 0) {
                tfoot += '<tr>'
                    + '<td colspan="3" class="right" style="color:var(--atl-muted);">Discount</td>'
                    + '<td class="right atl-det-tabular" style="color:var(--atl-clay);">&ndash;R ' + discount.toFixed(2) + '</td>'
                    + '</tr>';
            }
            if (qd.apply_vat) {
                tfoot += '<tr>'
                    + '<td colspan="3" class="right" style="color:var(--atl-muted);">VAT (15%)</td>'
                    + '<td class="right atl-det-tabular">R ' + vatAmount.toFixed(2) + '</td>'
                    + '</tr>';
            }
            tfoot += '<tr>'
                + '<td colspan="3" class="right" style="padding-top:6px;font-weight:700;">Total</td>'
                + '<td class="right atl-det-tabular" style="font-weight:700;font-size:14px;color:var(--atl-amber);">'
                + 'R ' + displayTotal.toFixed(2) + '</td>'
                + '</tr>';

            var statusClass = (invoiceStatus || '').toUpperCase() === 'PAID' ? 'bkm-val--green' : 'bkm-val--orange';
            tfoot += '<tr>'
                + '<td colspan="3" class="right" style="color:var(--atl-muted);padding-top:8px;">Invoice Number</td>'
                + '<td class="right bkm-val bkm-val--gold" style="padding-top:8px;font-weight:700;">' + invoiceNumber + '</td>'
                + '</tr>'
                + '<tr>'
                + '<td colspan="3" class="right" style="color:var(--atl-muted);">Status</td>'
                + '<td class="right ' + statusClass + '" style="font-weight:700;">' + (invoiceStatus || 'N/A').toUpperCase() + '</td>'
                + '</tr>';

            var html = '<table class="atl-det-table atl-det-table-responsive">'
                + '<thead><tr>'
                + '<th>Description</th>'
                + '<th class="right">Qty</th>'
                + '<th class="right">Unit</th>'
                + '<th class="right">Total</th>'
                + '</tr></thead>'
                + '<tbody>' + rows + '</tbody>'
                + '<tfoot>' + tfoot + '</tfoot>'
                + '</table>';

            var invSendLabel = invoiceSentAt ? 'Resend Invoice' : 'Send Invoice';
            var invSendIcon  = invoiceSentAt ? 'fa-rotate-right' : 'fa-paper-plane';
            html += '<div class="atl-doc-actions-row">'
                + '<a href="/api/admin/bookings/' + bookingId + '/invoice/download" target="_blank" class="atl-btn atl-btn--ghost">'
                + '<i class="fa-solid fa-file-pdf" style="margin-right:6px;"></i>Download Invoice PDF'
                + '</a>'
                + (invoiceId
                    ? '<button type="button" class="atl-btn atl-btn--ghost" onclick="sendOrResendInvoiceFromCard(' + invoiceId + ')" aria-label="' + invSendLabel + '">'
                      + '<i class="fa-solid ' + invSendIcon + '" style="margin-right:6px;"></i>' + invSendLabel
                      + '</button>'
                    : '')
                + '</div>';

            // NOTE: the real payment schedule (actual milestones + statuses) is rendered separately by
            // loadBookingPaymentSchedule() into #atl-paymentschedule-<id>, loaded on drawer open. A
            // hardcoded "Deposit (50%)/Balance (50%)" block used to sit here too and showed a fake 50/50
            // regardless of the configured split — removed so the drawer has one truthful source.

            return html;
        }

        // ═══ Deal View panel builders ═══
        // Each returns the exact card HTML the old two-column detail region used to stamp
        // inline (same classes/ids/data-ids), just grouped by tab instead of by column.
        // Called on-demand from toggleBookingDetail() rather than eagerly per row.
        // Derives the single most relevant "what should I do next" guidance for a booking, spanning
        // its whole lifecycle (quote → invoice/payment → contract → event → completion). Previously
        // computed inline in renderBookingsTable() as `nextStepHtml` but never actually rendered
        // anywhere (dead code left over from the Pipeline/Archive table redesign) — extracted here so
        // the Deal View can show it, and extended to account for contract status, which the original
        // never considered. Returns null if nothing stands out (e.g. archived/rejected bookings).
        function computeNextStepHint(row) {
            const s  = (row.status || 'PENDING').toUpperCase();
            const ps = (row.payment_status || 'UNPAID').toUpperCase();
            const today = new Date().toISOString().split('T')[0];
            const evDate = row.date || '';
            const eventPassed = evDate && evDate < today;
            const daysUntilEvent = evDate ? Math.ceil((new Date(evDate) - new Date(today)) / 86400000) : Infinity;
            const quotedAgeDays = row.quoted_at ? Math.floor((new Date(today) - new Date(row.quoted_at)) / 86400000) : 0;
            const hasInvoice = !!row.invoice_id;
            const invoiceSent = !!row.invoice_sent_at;
            // Only a SENT invoice can be overdue — a never-emailed DRAFT with a past due_date is not.
            const invoiceOverdue = invoiceSent && row.invoice_due_date && row.invoice_due_date < today && ps !== 'PAID';
            const inv = String(row.invoice_status || '').toUpperCase();
            const hasInv = !!row.invoice_id && inv !== 'VOID';
            const invPaid = inv === 'PAID' || ps === 'PAID';
            const invDraft = inv === 'DRAFT'; // draft-then-send: generated but not yet emailed
            // Stages: none → invoice_draft (needs sending) → invoiced (sent, awaiting payment) → paid
            let acceptedStage = 'none';
            if (invPaid) acceptedStage = 'paid';
            else if (hasInv && invDraft) acceptedStage = 'invoice_draft';
            else if (hasInv) acceptedStage = 'invoiced';
            const invDueDays = row.invoice_due_date ? Math.ceil((new Date(row.invoice_due_date) - new Date(today)) / 86400000) : null;
            const invDueSoon = invDueDays !== null && invDueDays >= 0 && invDueDays <= 5 && ps !== 'PAID';

            // Contract signals — the one lifecycle stage the original nextStepHtml never considered.
            const contractExists = !!row.contract_pdf_url;
            const contractSent = !!row.contract_sent_at;
            const contractClientSigned = !!row.contract_signed_by_client_at;
            const contractFinalised = (row.contract_status || '').toLowerCase() === 'signed' || row.contract_is_frozen === 1;

            const hint = (icon, color, bg, border, label, detail) => ({ icon, color, bg, border, label, detail });

            if (s === 'EXPIRED') return hint('fa-rotate-left', 'var(--atl-clay)', 'rgba(192,54,44,0.08)', 'rgba(192,54,44,0.25)', 'Reopen Booking', 'This enquiry has expired. Use Reopen Booking to restore it to Pending and prepare a fresh quote.');
            if ((s === 'NEW' || s === 'PENDING') && !row.quote_amount) return hint('fa-file-invoice-dollar', 'var(--atl-blue)', 'rgba(96,165,250,0.1)', 'rgba(96,165,250,0.25)', 'Send Quote', 'Review the enquiry details and use the Send Quote button to generate and email a formal quote to the client.');
            if ((s === 'NEW' || s === 'PENDING') && row.quote_amount) return hint('fa-file-pen', 'var(--atl-amber)', 'rgba(212,175,55,0.08)', 'var(--atl-line)', 'Revise Quote', 'A quote has already been sent. Review the booking and resend a revised quote if the client has not yet responded.');
            if (s === 'QUOTED' && !row.accepted_at && quotedAgeDays >= 7) return hint('fa-bell', 'var(--atl-clay)', 'rgba(192,54,44,0.08)', 'rgba(192,54,44,0.25)', 'Follow Up', `The quote has been pending for over ${quotedAgeDays} days. Consider sending a follow-up email to prompt the client to respond.`);
            if (s === 'QUOTED' && !row.accepted_at) return hint('fa-hourglass-half', 'var(--atl-amber)', 'rgba(212,175,55,0.08)', 'var(--atl-line)', 'Awaiting Client', "The quote has been sent. Waiting for the client to accept. No action needed unless you'd like to follow up.");
            if (s === 'ACCEPTED') {
                // Countersigning is the one contract action where the CLIENT is waiting on the
                // business, not the other way round — it wins over any invoice/payment nudge no
                // matter what stage the money side is at, and it only takes a moment to clear.
                if (contractClientSigned && !contractFinalised) return hint('fa-signature', 'var(--atl-amber)', 'rgba(212,175,55,0.08)', 'var(--atl-line)', 'Countersign Contract', 'The client has signed the contract online. Countersign it on the Offer & Contract tab to finalise the agreement.');
                // Nothing in the payment/invoice routes checks contract state — a client can pay in
                // full with no contract ever built or signed. The invoice still wins as the primary
                // next step here (money first), but the contract's own state is now always mentioned
                // in the detail line too, instead of staying silent until the invoice is fully sent.
                const contractFlagNote = contractFinalised ? ''
                    : contractSent ? " The contract is also still awaiting the client's signature."
                    : contractExists ? ' The contract has also been drafted but not sent yet.'
                    : ' No contract has been built yet either.';
                if (acceptedStage === 'none') return hint('fa-file-invoice-dollar', 'var(--atl-blue)', 'rgba(96,165,250,0.1)', 'rgba(96,165,250,0.25)', 'Generate Invoice', 'No invoice yet. Click Generate Invoice to create a draft for review — it is not emailed until you Send it.' + contractFlagNote);
                if (acceptedStage === 'invoice_draft') return hint('fa-paper-plane', 'var(--atl-blue)', 'rgba(96,165,250,0.1)', 'rgba(96,165,250,0.25)', 'Send Invoice', 'A draft invoice is ready. Review it, then use Send Invoice on the Invoices & Payments tab to email it to the client.' + contractFlagNote);
                // Once the invoice is out and there's nothing left to actively chase on the money
                // side, surface the contract if it still needs building/sending/signing — otherwise
                // a booking can sail straight through payment (even auto-confirm on a client's own
                // deposit — see deriveBookingStatusAfterPayment) with an unsigned contract nobody
                // was ever nudged about, since these acceptedStage branches used to be the only ones
                // considered here and never mentioned the contract at all.
                if (acceptedStage === 'invoiced' || acceptedStage === 'paid') {
                    if (!contractExists) return hint('fa-file-contract', 'var(--atl-blue)', 'rgba(96,165,250,0.1)', 'rgba(96,165,250,0.25)', 'Build Contract', "The client has accepted but no contract has been generated yet. Use 'Build Contract' on the Offer & Contract tab.");
                    if (!contractFinalised && !contractSent) return hint('fa-paper-plane', 'var(--atl-blue)', 'rgba(96,165,250,0.1)', 'rgba(96,165,250,0.25)', 'Send Contract', "A contract has been drafted but not yet sent to the client for signature. Use 'Send to Client' on the Offer & Contract tab.");
                    if (!contractFinalised && contractSent && !contractClientSigned) return hint('fa-hourglass-half', 'var(--atl-amber)', 'rgba(212,175,55,0.08)', 'var(--atl-line)', 'Awaiting Signature', 'The contract has been sent. Waiting for the client to sign it online.');
                }
                if (acceptedStage === 'invoiced') return hint('fa-hourglass-half', 'var(--atl-amber-light)', 'rgba(251,146,60,0.1)', 'rgba(251,146,60,0.25)', 'Awaiting Payment', 'Invoice has been sent to the client. Awaiting payment. Record payment once funds are received, then Confirm the booking.');
                if (acceptedStage === 'paid') return hint('fa-clipboard-check', 'var(--atl-sage)', 'rgba(74,222,128,0.1)', 'rgba(74,222,128,0.25)', 'Event Preparation', 'Payment is recorded. Click Confirm to lock in the booking and send the client a confirmation email.');
            }
            if (s === 'CONFIRMED') {
                if (!hasInvoice && ps !== 'PAID' && !eventPassed) return hint('fa-file-circle-plus', 'var(--atl-blue)', 'rgba(96,165,250,0.1)', 'rgba(96,165,250,0.25)', 'Generate Invoice', "Booking is confirmed but no invoice has been generated yet. Use 'Generate Invoice' to create and send the client a formal invoice.");
                if (hasInvoice && !invoiceSent && ps !== 'PAID' && !eventPassed) return hint('fa-paper-plane', 'var(--atl-blue)', 'rgba(96,165,250,0.1)', 'rgba(96,165,250,0.25)', 'Send Invoice', "An invoice has been generated but not yet emailed to the client. Use 'Send Invoice' on the Invoice card to deliver it.");
                if (invoiceOverdue) return hint('fa-triangle-exclamation', 'var(--atl-clay)', 'rgba(192,54,44,0.12)', 'rgba(192,54,44,0.35)', 'Invoice Overdue', `The invoice payment was due on ${row.invoice_due_date} and is now overdue. Follow up with the client immediately.`);
                if (invDueSoon) return hint('fa-clock', 'var(--atl-amber-light)', 'rgba(251,146,60,0.1)', 'rgba(251,146,60,0.3)', `Due in ${invDueDays}d`, `Payment is due in ${invDueDays} day${invDueDays === 1 ? '' : 's'} (${row.invoice_due_date}). Consider sending a payment reminder to the client.`);
                if (hasInvoice && invoiceSent && ps !== 'PAID' && !eventPassed) return hint('fa-hourglass-half', 'var(--atl-amber-light)', 'rgba(251,146,60,0.1)', 'rgba(251,146,60,0.25)', 'Awaiting Payment', 'Invoice has been sent to the client. Awaiting payment. Record payment once funds are received.');
                if (ps !== 'PAID' && eventPassed) return hint('fa-triangle-exclamation', 'var(--atl-clay)', 'rgba(192,54,44,0.08)', 'rgba(192,54,44,0.25)', 'Collect & Close', 'The event has already occurred but payment is still outstanding. Collect payment then mark the booking as completed.');
                if (ps !== 'PAID') return hint('fa-money-bill-wave', 'var(--atl-amber-light)', 'rgba(251,146,60,0.1)', 'rgba(251,146,60,0.25)', 'Collect Payment', 'Booking is confirmed but payment has not been recorded yet. Use Record Payment when funds are received.');
                // Everything from here on is ps === 'PAID' — money's settled, so paperwork/logistics take over.
                if (eventPassed) return hint('fa-flag-checkered', 'var(--atl-blue)', 'rgba(129,140,248,0.1)', 'rgba(129,140,248,0.25)', 'Mark as Completed', 'Payment is settled and the event has passed. Click Mark Completed to close the booking and send the client a completion notification.');
                if (!contractExists) return hint('fa-file-contract', 'var(--atl-blue)', 'rgba(96,165,250,0.1)', 'rgba(96,165,250,0.25)', 'Build Contract', "Payment is settled but no contract has been generated yet. Use 'Build Contract' on the Offer & Contract tab.");
                if (!contractFinalised && !contractSent) return hint('fa-paper-plane', 'var(--atl-blue)', 'rgba(96,165,250,0.1)', 'rgba(96,165,250,0.25)', 'Send Contract', "A contract has been drafted but not yet sent to the client for signature. Use 'Send to Client' on the Offer & Contract tab.");
                if (!contractFinalised && contractSent && !contractClientSigned) return hint('fa-hourglass-half', 'var(--atl-amber)', 'rgba(212,175,55,0.08)', 'var(--atl-line)', 'Awaiting Signature', 'The contract has been sent. Waiting for the client to sign it online.');
                if (!contractFinalised && contractClientSigned) return hint('fa-signature', 'var(--atl-amber)', 'rgba(212,175,55,0.08)', 'var(--atl-line)', 'Countersign Contract', 'The client has signed the contract online. Countersign it on the Offer & Contract tab to finalise the agreement.');
                if (!row.google_event_id) return hint('fa-calendar-plus', 'var(--atl-blue)', 'rgba(96,165,250,0.1)', 'rgba(96,165,250,0.25)', 'Sync to Calendar', 'Booking is confirmed and paid. Sync to Google Calendar to lock in the date and send the client a calendar invite.');
                if (daysUntilEvent <= 14) return hint('fa-calendar-exclamation', 'var(--atl-amber)', 'rgba(212,175,55,0.08)', 'var(--atl-line)', `Event in ${daysUntilEvent}d`, `The event is in ${daysUntilEvent} day${daysUntilEvent === 1 ? '' : 's'}. Review the booking details, confirm logistics, and ensure everything is in order for the client.`);
                return hint('fa-circle-check', 'var(--atl-sage)', 'rgba(74,222,128,0.1)', 'rgba(74,222,128,0.25)', 'All Confirmed', 'Booking is fully confirmed, paid, and contracted. The event is upcoming — no urgent action required.');
            }
            if (s === 'COMPLETED') return hint('fa-star', 'var(--atl-sage)', 'rgba(74,222,128,0.1)', 'rgba(74,222,128,0.25)', 'Request Review', "Booking is complete. Send the client a review request to build Thabiso's profile and gather testimonials.");
            if (s === 'CANCELLED' && row.refund_amount) return hint('fa-calendar-plus', 'var(--atl-blue)', 'rgba(129,140,248,0.1)', 'rgba(129,140,248,0.25)', 'Book Again', 'Refund has been recorded. If the client wishes to rebook, use Book Again to create a new booking from this record.');
            if (s === 'CANCELLED' && !row.refund_amount) return hint('fa-rotate-left', 'var(--atl-amber)', 'rgba(212,175,55,0.08)', 'var(--atl-line)', 'Record Refund', "This booking was cancelled. If a refund is owed, use the Record Refund button to log the payment and update the client's record.");
            return null;
        }

        // Renders computeNextStepHint()'s output as a prominent, always-visible callout (not hidden
        // behind a hover tooltip) at the top of the Deal View's Overview tab.
        function renderNextStepCallout(row) {
            const h = computeNextStepHint(row);
            if (!h) return '';
            return `
          <div class="atl-det-card" style="background:${h.bg};border:1px solid ${h.border};">
            <div style="display:flex;align-items:flex-start;gap:10px;">
              <span style="font-size:16px;color:${h.color};line-height:1.3;"><i class="fa-solid ${h.icon}"></i></span>
              <div>
                <div style="font-size:10.5px;font-weight:700;text-transform:uppercase;letter-spacing:0.1em;color:${h.color};">Next Step &middot; ${h.label}</div>
                <div style="font-size:12.5px;color:var(--atl-ink-dim);margin-top:3px;">${h.detail}</div>
              </div>
            </div>
          </div>`;
        }

        // "Submission Age" — how long ago this enquiry/booking came in, flagged red when it's a
        // status that needs admin attention (matches the same statuses computeNextStepHint() acts
        // on) and marked stale if it's sat in PENDING a week or more. Same dead-code history as
        // computeNextStepHint(): computed per row in renderBookingsTable() as `ageLine` but never
        // rendered anywhere — extracted here so the Deal View can show it.
        function renderSubmissionAgeLine(row) {
            const s = (row.status || 'PENDING').toUpperCase();
            const ps = (row.payment_status || 'UNPAID').toUpperCase();
            const today = new Date().toISOString().split('T')[0];
            const evDate = row.date || '';
            const ageDays = Math.max(0, Math.round((new Date(today) - new Date(row.created_at)) / 86400000));
            const ageLabel = ageDays === 0 ? 'today' : ageDays === 1 ? '1 day ago' : `${ageDays} days ago`;
            const stale = s === 'PENDING' && ageDays >= 7;
            const adminActionRequired = s === 'NEW' || s === 'PENDING' || s === 'ACCEPTED' ||
                (s === 'CONFIRMED' && (ps !== 'PAID' || (evDate && evDate < today)));
            const subDate = new Date(row.created_at).toLocaleDateString('en-ZA', { day:'2-digit', month:'short', year:'numeric' });
            const color = adminActionRequired ? 'var(--atl-clay)' : 'var(--atl-muted)';
            const weight = adminActionRequired ? '600' : '400';
            return `<p class="atl-sub" style="margin-top:6px;color:${color};font-weight:${weight};">${stale ? '⚠ ' : ''}Submitted ${ageLabel} (on ${subDate})</p>`;
        }

        // "Days until event" urgency badge — same dead-code history, extracted from the
        // `daysUntilHtml` computation in renderBookingsTable() (assigned, never rendered).
        function computeDaysUntilEventBadge(row) {
            const s = (row.status || 'PENDING').toUpperCase();
            const evDate = row.date || '';
            if (!evDate || ['CANCELLED', 'COMPLETED'].includes(s)) return '';
            const today = new Date().toISOString().split('T')[0];
            const daysUntil = Math.ceil((new Date(evDate) - new Date(today)) / 86400000);
            if (daysUntil < 0) return '';
            const duColor = daysUntil <= 7 ? 'var(--atl-clay)' : daysUntil <= 30 ? 'var(--atl-amber)' : 'var(--atl-sage)';
            const duLabel = daysUntil === 0 ? 'TODAY' : daysUntil === 1 ? '1 day' : `${daysUntil} days`;
            return `<span style="font-size:10px; background:rgba(212,175,55,0.08); color:${duColor}; border:1px solid var(--atl-line); border-radius:3px; padding:1px 5px; margin-left:6px; font-weight:600;">${duLabel}</span>`;
        }

        // Progress tab — a lifecycle checklist derived from the exact same booleans that used to
        // drive the booking list row's tag badges (hasInvoice/invoiceSent/invoiceOverdue/isAccepted/
        // etc.), just re-expressed as done/pending/overdue instead of a flat row of pills. "Overdue"
        // is reserved for the three signals this codebase already treats as urgent elsewhere (the
        // row's --overdue/--contract-unsigned badges and computeNextStepHint's "Follow Up" branch) —
        // everything else not yet done is "Pending", not "Overdue", to avoid inventing new severity
        // levels the rest of the app doesn't share.
        function computeBookingProgressChecklist(row) {
            const s  = (row.status || 'PENDING').toUpperCase();
            const ps = (row.payment_status || 'UNPAID').toUpperCase();
            const today = new Date().toISOString().split('T')[0];

            const isQuoteSent = !!row.quoted_at;
            const isAccepted  = !!row.accepted_at;
            const quotedAgeDays = row.quoted_at ? Math.floor((new Date(today) - new Date(row.quoted_at)) / 86400000) : 0;
            const quoteStale = s === 'QUOTED' && !isAccepted && quotedAgeDays >= 7;

            const hasInvoice  = !!row.invoice_id;
            const invoiceSent = !!row.invoice_sent_at;
            const invoiceOverdue = invoiceSent && row.invoice_due_date && row.invoice_due_date < today && ps !== 'PAID';
            const isPaid = ps === 'PAID';

            const contractFinalised = (String(row.contract_status || '').toLowerCase() === 'signed') || row.contract_is_frozen === 1;
            const contractUnsigned = ['ACCEPTED', 'CONFIRMED', 'COMPLETED'].includes(s) && !contractFinalised;

            const isCalSynced = !!row.google_event_id;
            const isPopiaDone = !!row.popia_consent;
            const isCompleted = s === 'COMPLETED';

            return [
                { label: 'Quote sent', state: isQuoteSent ? 'done' : (quoteStale ? 'overdue' : 'pending'),
                  detail: isQuoteSent ? (row.quote_amount ? 'R ' + parseFloat(row.quote_amount).toFixed(2) + ' sent to client' : 'Sent to client') : (quoteStale ? `Pending ${quotedAgeDays} days with no response — consider a follow-up.` : 'Not yet sent to the client.') },
                { label: 'Client accepted', state: isAccepted ? 'done' : 'pending',
                  detail: isAccepted ? 'Accepted by the client' : 'Awaiting client acceptance of the quote.' },
                { label: 'Contract signed', state: contractFinalised ? 'done' : (contractUnsigned ? 'overdue' : 'pending'),
                  detail: contractFinalised ? 'Signed and finalised' : (contractUnsigned ? "Booking has moved past acceptance but the contract isn't signed yet." : 'Not needed until the booking is accepted.') },
                { label: 'Invoice generated', state: hasInvoice ? 'done' : 'pending',
                  detail: hasInvoice ? ('Invoice ' + (row.invoice_number ? '#' + row.invoice_number : 'on record')) : 'No invoice generated yet.' },
                { label: 'Invoice sent', state: invoiceSent ? 'done' : 'pending',
                  detail: invoiceSent ? 'Emailed to the client' : (hasInvoice ? 'Drafted but not yet emailed to the client.' : 'Generate the invoice first.') },
                { label: 'Payment received', state: isPaid ? 'done' : (invoiceOverdue ? 'overdue' : 'pending'),
                  detail: isPaid ? 'Paid in full' : (invoiceOverdue ? `Overdue since ${row.invoice_due_date} — follow up with the client.` : 'No payment recorded yet.') },
                { label: 'Synced to calendar', state: isCalSynced ? 'done' : 'pending',
                  detail: isCalSynced ? 'Google Calendar event created' : 'Not yet synced to Google Calendar.' },
                { label: 'POPIA consent', state: isPopiaDone ? 'done' : 'pending',
                  detail: isPopiaDone ? 'Consent on file' : 'No consent recorded yet.' },
                { label: 'Event completed', state: isCompleted ? 'done' : 'pending',
                  detail: isCompleted ? 'Marked as completed' : (s === 'CANCELLED' ? 'Booking was cancelled.' : 'Event has not taken place yet.') }
            ];
        }

        // Tag badges relocated verbatim from the booking list row (renderBookingsTable) — same
        // classes/flags, just rendered once here instead of per-row, and unclamped (the drawer has
        // room to show them all, so the row's 2-line "+more" cap doesn't apply).
        function buildProgressTagsCard(row) {
            const s  = (row.status || 'PENDING').toUpperCase();
            const ps = (row.payment_status || 'UNPAID').toUpperCase();
            const today = new Date().toISOString().split('T')[0];
            const disposition = row.disposition || 'active';
            const hasInvoice = !!row.invoice_id;
            const invoiceSent = !!row.invoice_sent_at;
            const invoiceOverdue = invoiceSent && row.invoice_due_date && row.invoice_due_date < today && ps !== 'PAID';
            const hasAttachments = (function() { try { const f = JSON.parse(row.attachment_files || '[]'); return Array.isArray(f) && f.length > 0; } catch(e) { return false; } })();
            const isCalSynced  = !!row.google_event_id;
            const isQuoteSent  = !!row.quoted_at;
            const isAccepted   = !!row.accepted_at;
            const isPayFast    = row.payment_method === 'payfast';
            const isRefunded   = Number(row.refund_amount) > 0;
            const isPopiaDone  = !!row.popia_consent;
            const contractFinalisedRow = (String(row.contract_status || '').toLowerCase() === 'signed') || row.contract_is_frozen === 1;
            const contractUnsigned = ['ACCEPTED', 'CONFIRMED', 'COMPLETED'].includes(s) && !contractFinalisedRow;
            const isTriaged = disposition !== 'active';
            const hasAnyBadge = !!(row.event_id || row.venue_id || hasInvoice || isCalSynced || isQuoteSent || isAccepted || hasAttachments || isPayFast || isRefunded || isPopiaDone || contractUnsigned || isTriaged || row.rebooked_from_id || row.rebooked_as_id);

            if (!hasAnyBadge) return '';

            return `<div class="atl-det-card">
                <h5 class="atl-det-title"><i class="fa-solid fa-tags"></i> Tags</h5>
                <div class="dv-progress-tags">
                    <span class="atl-tag-badge atl-tag-badge--promoted" style="display:${row.event_id ? 'inline-flex' : 'none'};">Promoted</span>
                    <span class="atl-tag-badge atl-tag-badge--venue" style="display:${row.venue_id ? 'inline-flex' : 'none'};">Venue linked</span>
                    <span class="atl-tag-badge atl-tag-badge--invoice" style="display:${hasInvoice && !invoiceSent && !invoiceOverdue ? 'inline-flex' : 'none'};">Invoice</span>
                    <span class="atl-tag-badge atl-tag-badge--invoice-sent" style="display:${invoiceSent && !invoiceOverdue && ps !== 'PAID' ? 'inline-flex' : 'none'};">Inv. Sent</span>
                    <span class="atl-tag-badge atl-tag-badge--overdue" style="display:${invoiceOverdue ? 'inline-flex' : 'none'};" title="Invoice overdue — payment not received">Overdue</span>
                    <span class="atl-tag-badge atl-tag-badge--cal" style="display:${isCalSynced ? 'inline-flex' : 'none'};">Cal synced</span>
                    <span class="atl-tag-badge atl-tag-badge--quote" style="display:${isQuoteSent ? 'inline-flex' : 'none'};">Quote sent</span>
                    <span class="atl-tag-badge atl-tag-badge--accepted" style="display:${isAccepted ? 'inline-flex' : 'none'};" title="Booking has been accepted by the client.">Accepted</span>
                    <span class="atl-tag-badge atl-tag-badge--contract-unsigned" style="display:${contractUnsigned ? 'inline-flex' : 'none'};" title="Booking has moved past acceptance but the contract isn't signed & finalised yet.">Unsigned Contract</span>
                    <span class="atl-tag-badge atl-tag-badge--triaged" style="display:${isTriaged ? 'inline-flex' : 'none'};" title="Soft-declined — excluded from the active pipeline and conversion counts">${disposition === 'not_a_fit' ? 'Not a Fit' : 'Archived'}</span>
                    <span class="atl-tag-badge atl-tag-badge--attached" style="display:${hasAttachments ? 'inline-flex' : 'none'};">Brief attached</span>
                    <span class="atl-tag-badge atl-tag-badge--popia" style="display:${isPopiaDone ? 'inline-flex' : 'none'};">POPIA</span>
                    <span class="atl-tag-badge atl-tag-badge--refunded" style="display:${isRefunded ? 'inline-flex' : 'none'};">Refunded</span>
                    <span class="atl-tag-badge atl-tag-badge--payfast" style="display:${isPayFast ? 'inline-flex' : 'none'};">PayFast</span>
                    <span class="atl-tag-badge atl-tag-badge--rebooked" style="display:${row.rebooked_from_id ? 'inline-flex' : 'none'};" title="This booking was created from cancelled booking #${row.rebooked_from_id}">&#x21BA; From #${row.rebooked_from_id}</span>
                    <span class="atl-tag-badge atl-tag-badge--rebooked" style="display:${row.rebooked_as_id ? 'inline-flex' : 'none'};" title="This cancelled booking was rebooked as #${row.rebooked_as_id}">Rebooked &#x2192; #${row.rebooked_as_id}</span>
                </div>
            </div>`;
        }

        function buildProgressPanel(row) {
            const checklist = computeBookingProgressChecklist(row);
            const groups = { overdue: [], pending: [], done: [] };
            checklist.forEach(function(item) { groups[item.state].push(item); });

            const stateMeta = {
                overdue: { icon: 'fa-triangle-exclamation', color: 'var(--atl-clay)', label: 'Overdue' },
                pending: { icon: 'fa-hourglass-half',       color: 'var(--atl-amber)', label: 'Pending' },
                done:    { icon: 'fa-circle-check',         color: 'var(--atl-sage)',  label: 'Completed' }
            };
            const itemIcon = { overdue: 'fa-triangle-exclamation', pending: 'fa-circle', done: 'fa-circle-check' };

            function renderGroup(state) {
                const items = groups[state];
                if (!items.length) return '';
                const meta = stateMeta[state];
                const rows = items.map(function(item) {
                    return `<li class="dv-progress-item dv-progress-item--${state}">
                        <i class="fa-solid ${itemIcon[state]}"></i>
                        <div><span class="dv-progress-item__label">${item.label}</span><span class="dv-progress-item__detail">${item.detail}</span></div>
                    </li>`;
                }).join('');
                return `<div class="atl-det-card">
                    <h5 class="atl-det-title" style="color:${meta.color} !important;"><i class="fa-solid ${meta.icon}" style="color:${meta.color};"></i> ${meta.label} <span class="dv-progress-count">${items.length}</span></h5>
                    <ul class="dv-progress-list">${rows}</ul>
                </div>`;
            }

            // Overdue first (needs attention now), then Pending (what's left), then Completed (confirms progress so far).
            return renderGroup('overdue') + renderGroup('pending') + renderGroup('done') + buildProgressTagsCard(row);
        }

        function buildOverviewPanel(row) {
            const s = (row.status || 'PENDING').toUpperCase();
            const payLbl = { PAID:'✓ Paid', DEPOSIT_PAID:'◐ Deposit', PARTIALLY_PAID:'◑ Partial', UNPAID:'○ Unpaid', FAILED:'✕ Failed', CANCELLED:'✕ Cancelled' };
            const ps = (row.payment_status || 'UNPAID').toUpperCase();
            const _typeDefault = (window.typeBuffersCache && row.event_type && window.typeBuffersCache[row.event_type] != null)
                ? window.typeBuffersCache[row.event_type]
                : (window.defaultGapCache || 30);
            const _bufVal   = row.buffer_minutes != null ? row.buffer_minutes : _typeDefault;
            const _isCustom = row.buffer_minutes != null;

            return `
      <div class="atl-det-col">
          ${renderNextStepCallout(row)}
          <!-- Client Card -->
          <div class="atl-det-card">
            <h5 class="atl-det-title"><i class="fa-solid fa-user"></i>Client</h5>
            <p class="atl-lead">
              ${row.name}${row.company ? ` <span class="co">· ${row.company}</span>` : ''}
            </p>
            <p class="atl-sub">
              <a href="mailto:${row.email}" class="atl-det-link">${row.email}</a>
              ${row.cell ? ` · <a href="tel:${row.cell.replace(/\s/g,'')}" class="atl-det-link">${row.cell}</a>` : ''}
            </p>
            ${renderSubmissionAgeLine(row)}
            <div class="atl-doc-actions-row" style="margin-top:8px;">
              <button type="button" class="atl-btn atl-btn--ghost bk-view-client-history" data-email="${row.email}">
                <i class="fa-solid fa-clock-rotate-left" style="margin-right:6px;"></i>View All Bookings
              </button>
            </div>
          </div>

          <!-- Event Card -->
          <div class="atl-det-card">
            <h5 class="atl-det-title"><i class="fa-solid fa-calendar-day"></i>Event</h5>
            <p class="atl-lead" style="margin-bottom:8px;">
              ${row.event_name || row.event_type || '—'}
            </p>
            <dl class="atl-det-dl">
              <dt>Date</dt>
              <dd>${row.date || '—'}${row.event_start_time ? ' · ' + row.event_start_time : ''}${computeDaysUntilEventBadge(row)}</dd>
              <dt>Location</dt>
              <dd>${row.event_location || '—'}</dd>
              ${row.performance_slot     ? `<dt>Slot</dt><dd>${row.performance_slot}</dd>` : ''}
              ${row.performance_duration ? `<dt>Duration</dt><dd>${row.performance_duration}</dd>` : ''}
              ${row.venue_type           ? `<dt>Venue type</dt><dd>${row.venue_type}</dd>` : ''}
              ${row.alternative_dates    ? `<dt>Alternative dates</dt><dd>${row.alternative_dates}</dd>` : ''}
              ${row.content_notes        ? `<dt>Content suitability</dt><dd>${row.content_notes}</dd>` : ''}
            </dl>
            <div style="border-top:1px solid var(--atl-line);margin-top:10px;padding-top:10px;">
              <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
                <span style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.07em;color:var(--atl-muted);white-space:nowrap;">
                  <i class="fa-solid fa-clock-rotate-left" style="margin-right:4px;opacity:.7;"></i>Travel &amp; logistics buffer
                </span>
                <input type="number" class="bk-buffer-input atl-input"
                       id="bk-buf-${row.id}" data-id="${row.id}" data-default="${_typeDefault}"
                       value="${_bufVal}" min="0" max="480" step="5"
                       style="width:68px;padding:4px 8px;font-size:12px;text-align:center;">
                <span style="font-size:11px;color:var(--atl-muted);">min</span>
                <button type="button" class="bk-save-buffer-btn atl-btn"
                        data-id="${row.id}"
                        style="font-size:11px;padding:4px 10px;min-height:28px;background:rgba(212,175,55,0.10);border:1px solid rgba(212,175,55,0.35);color:var(--atl-amber);border-radius:6px;cursor:pointer;">
                  Save
                </button>
                <span class="bk-buf-hint" id="bk-buf-hint-${row.id}"
                      style="font-size:10px;color:var(--atl-muted-dim);">
                  ${_isCustom ? '' : '← type default'}
                </span>
              </div>
              <p style="font-size:10px;color:var(--atl-muted-dim);margin:5px 0 0;">
                Post-event buffer for travel, weather &amp; logistics
              </p>
            </div>
          </div>

          <!-- Audience & Budget Card (conditional) -->
          ${(row.audience_size || row.audience_demographic || row.budget_range || row.heard_about || row.travel_accommodation != null) ? `
          <div class="atl-det-card">
            <h5 class="atl-det-title"><i class="fa-solid fa-chart-pie"></i>Audience &amp; Budget</h5>
            <dl class="atl-det-dl">
              ${row.audience_size        ? `<dt>Audience size</dt><dd>${row.audience_size}</dd>` : ''}
              ${row.audience_demographic ? `<dt>Demographic</dt><dd>${row.audience_demographic}</dd>` : ''}
              ${row.budget_range         ? `<dt>Budget range</dt><dd class="atl-det-gold">${row.budget_range}</dd>` : ''}
              ${row.heard_about          ? `<dt>How they heard about us</dt><dd>${row.heard_about}</dd>` : ''}
              ${row.travel_accommodation != null
                ? `<dt>Travel provided</dt>
                   <dd style="color:${row.travel_accommodation && row.travel_accommodation !== 'Not required' && row.travel_accommodation !== 0 && row.travel_accommodation !== '0' ? 'var(--atl-sage)' : 'var(--atl-muted)'}; font-weight:600;">
                     ${row.travel_accommodation && row.travel_accommodation !== 'Not required' && row.travel_accommodation !== 0 && row.travel_accommodation !== '0' ? 'Yes' : 'No'}
                   </dd>` : ''}
            </dl>
          </div>` : ''}

          <!-- Ledger Card -->
          <div class="atl-det-card">
            <h5 class="atl-det-title"><i class="fa-solid fa-table-list"></i>Ledger</h5>
            <dl class="atl-det-dl">
              <dt>Payment</dt>
              <dd>${payLbl[ps] || ps}</dd>
              <dt>Quoted total</dt>
              <dd class="atl-det-tabular">R ${parseFloat(row.quote_amount||0).toFixed(2)}</dd>
              <dt>Paid</dt>
              <dd class="atl-det-tabular">R ${parseFloat(row.amount_paid||0).toFixed(2)}</dd>
              <dt>Outstanding</dt>
              <dd class="atl-det-tabular ${parseFloat(row.amount_outstanding)>0 ? 'atl-det-negative' : 'atl-det-positive'}">
                R ${parseFloat(row.amount_outstanding||0).toFixed(2)}
              </dd>
              ${row.payment_date
                ? `<dt>Last payment</dt>
                   <dd>${new Date(row.payment_date).toLocaleDateString('en-ZA')}
                       ${row.payment_reference ? ' · ' + row.payment_reference : ''}</dd>`
                : ''}
            </dl>
          </div>

          <!-- Venue Card -->
          ${row.venue_id ? `
          <div class="atl-det-card">
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px;">
              <h5 class="atl-det-title" style="margin:0;"><i class="fa-solid fa-location-dot"></i>Venue</h5>
              <button type="button" class="bk-unlink-venue-btn atl-btn atl-btn--ghost" data-booking-id="${row.id}" style="font-size:11px; padding:2px 8px; min-height:24px; color:var(--atl-clay);">
                <i class="fa-solid fa-link-slash" style="margin-right:4px;"></i>Unlink
              </button>
            </div>
            <p class="atl-lead" style="font-family:'Cormorant Garamond',serif; font-size:clamp(15px,4.5vw,17px);">
              ${row.venue_name || row.event_location || '—'}
            </p>
            <p class="atl-sub">
              ${row.venue_city ? row.venue_city + ' · ' : ''}
              ${row.venue_capacity ? 'Cap. ' + row.venue_capacity.toLocaleString() + ' · ' : ''}
              ${row.venue_contact
                ? `<a href="mailto:${row.venue_contact}" class="atl-det-link">${row.venue_contact}</a>`
                : ''}
            </p>
            ${row.venue_contact_phone
              ? `<p style="font-size:12px;color:var(--atl-muted);margin-top:4px;">${row.venue_contact_phone}</p>`
              : ''}
            ${row.venue_notes
              ? `<p style="font-size:11px;color:var(--atl-muted);margin-top:6px;font-style:italic;">${row.venue_notes}</p>`
              : ''}
          </div>` : `
          <div class="atl-det-card">
            <h5 class="atl-det-title"><i class="fa-solid fa-location-dot"></i>Venue
              <span style="font-size:10px;color:var(--atl-clay);margin-left:2px;font-weight:400;text-transform:none;letter-spacing:normal;">· Unlinked</span>
            </h5>
            <p class="atl-sub" style="margin-bottom:10px;">${row.event_location || '—'}</p>
            <div class="bkr-venue-edit-row" id="venue-edit-row-${row.id}" style="display:none; margin-top:8px;">
              <input type="text" id="venue-loc-${row.id}" placeholder="Venue / location name" value="${row.event_location || ''}" class="atl-venue-input" style="margin-bottom:6px;">
              <input type="text" id="venue-addr-${row.id}" placeholder="Street address (optional)" value="${row.venue_address || ''}" class="atl-venue-input" style="margin-bottom:6px;">
              <div style="display:flex; gap:6px; margin-bottom:6px;">
                <input type="text" id="venue-city-${row.id}" placeholder="City" value="${row.city || ''}" class="atl-venue-input">
                <input type="text" id="venue-country-${row.id}" placeholder="Country" value="${row.country || ''}" class="atl-venue-input">
              </div>
              <div style="display:flex; gap:6px;">
                <button type="button" class="bk-venue-save-btn atl-btn atl-btn--primary" data-id="${row.id}" style="flex:1; min-height:44px;">Save Location</button>
                <button type="button" class="bk-venue-cancel-btn atl-btn atl-btn--ghost" data-id="${row.id}" style="flex:1; min-height:44px;">Cancel</button>
              </div>
            </div>
            <div class="bkr-venue-link-row" style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:10px;width:100%;">
              <label for="venueLinkGoogle-${row.id}" class="atl-panel-label" style="margin:0;flex-shrink:0;">Link a venue</label>
              <input type="text"
                     class="atl-venue-autocomplete-input atl-venue-input"
                     id="venueLinkGoogle-${row.id}"
                     placeholder="Search Google for a venue..."
                     style="flex:1;min-width:160px;margin-bottom:0;"
                     data-booking-id="${row.id}">
              <button type="button"
                      class="bkr-venue-link-google-btn bk-link-venue-google-btn atl-btn atl-btn--primary"
                      id="venueLinkGoogleBtn-${row.id}"
                      data-booking-id="${row.id}"
                      disabled>
                <i class="fa-solid fa-link"></i> Link
              </button>
            </div>
            <button type="button" class="bk-venue-edit-btn atl-btn atl-btn--ghost" data-id="${row.id}" style="margin-top:8px;"><i class="fa-solid fa-pen-to-square" style="margin-right:6px;"></i>Edit Location</button>
          </div>`}

          <!-- Public Promotion Card -->
          ${['ACCEPTED','CONFIRMED','COMPLETED'].includes(s) ? `
          <div class="atl-det-card" id="promote-panel-${row.id}">
            <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:16px;flex-wrap:wrap;">
              <div style="flex:1;min-width:140px;">
                <h5 class="atl-det-title" id="promoLabel-${row.id}" style="margin-bottom:4px;">
                  <i class="fa-solid fa-bullhorn" aria-hidden="true" style="color:var(--atl-amber);margin-right:6px;"></i>
                  Public Promotion
                  <span class="atl-promote-live-badge ${row.is_public ? '' : 'atl-promote-live-badge--off'}" id="promote-badge-${row.id}">
                    ${row.is_public ? 'LIVE' : 'Not Promoted'}
                  </span>
                </h5>
                <p style="font-size:clamp(12px,3vw,13px);color:var(--atl-muted);margin:0;">
                  List this booking on the public events page.
                </p>
              </div>
              <button type="button"
                      class="atl-switch promote-toggle"
                      role="switch"
                      id="promote-${row.id}"
                      data-id="${row.id}"
                      aria-checked="${row.is_public ? 'true' : 'false'}"
                      aria-labelledby="promoLabel-${row.id}"
                      style="flex-shrink:0;">
              </button>
            </div>

            <!-- Missing field warnings -->
            ${(!row.event_name && !row.event_type) || !row.event_location ? `
            <div class="atl-promote-warn" id="promote-warn-${row.id}">
              <i class="fa-solid fa-triangle-exclamation" style="margin-top:2px;"></i>
              <span>Missing info for a good public listing:
                ${!row.event_name && !row.event_type ? '<span class="atl-promote-warn-item">event name</span>' : ''}
                ${!row.event_location ? '<span class="atl-promote-warn-item">venue / location</span>' : ''}
              </span>
            </div>` : ''}

            <!-- Live preview card -->
            <div class="atl-promote-preview ${row.is_public ? '' : 'atl-promote-preview--hidden'}" id="promote-preview-${row.id}">
              <div class="atl-promote-preview__eyebrow"><i class="fa-solid fa-eye" style="margin-right:4px;"></i>Public listing preview</div>
              <div>
                <div class="atl-promote-preview__name">${row.event_name || row.event_type || '— No event name set —'}</div>
                <div class="atl-promote-preview__meta">
                  <span><i class="fa-regular fa-calendar" style="margin-right:4px; opacity:.6;"></i>${row.date || '—'}</span>
                  ${row.event_start_time ? `<span><i class="fa-regular fa-clock" style="margin-right:4px; opacity:.6;"></i>${row.event_start_time}</span>` : ''}
                  <span><i class="fa-solid fa-location-dot" style="margin-right:4px; opacity:.6;"></i>${row.event_location || row.venue_name || '— No venue set —'}</span>
                  ${row.event_type ? `<span><i class="fa-solid fa-tag" style="margin-right:4px; opacity:.6;"></i>${row.event_type}</span>` : ''}
                </div>
                ${row.ticket_link ? `<div style="margin-top:8px; font-size:12px;"><i class="fa-solid fa-ticket" style="margin-right:6px; color:var(--atl-amber);"></i><a href="${row.ticket_link}" target="_blank" rel="noopener" class="atl-det-link" style="word-break:break-all;">${row.ticket_link}</a></div>` : ''}
              </div>
            </div>

            <!-- Ticket URL input -->
            <div id="promote-ticket-area-${row.id}" style="margin-top: 12px; border-top: 1px solid var(--atl-line); padding-top: 12px;">
              <label class="atl-panel-label" for="promote-ticket-${row.id}" style="margin-bottom:6px; display:block;">
                <i class="fa-solid fa-ticket" style="margin-right:6px;"></i>Ticket / RSVP Link <span style="font-weight:400; text-transform:none;">(optional)</span>
              </label>
              <div style="display:flex; gap:8px; align-items:center;">
                <input type="url" class="atl-venue-input bkr-promote-ticket-input" id="promote-ticket-${row.id}"
                  placeholder="https://tickets.example.com/event"
                  value="${row.ticket_link || ''}" style="margin-bottom:0;">
                <button type="button" class="atl-btn bkr-promote-ticket-save atl-promote-ticket-save" data-id="${row.id}">
                  <i class="fa-solid fa-floppy-disk" style="margin-right:6px;"></i>Save
                </button>
              </div>
              <div class="bkr-promote-ticket-msg" id="promote-ticket-msg-${row.id}" style="font-size:11px; margin-top:6px; display:none;"></div>
            </div>
          </div>` : ''}
      </div>`;
        }

        function buildOfferPanel(row) {
            return `
      <div class="atl-det-col">
          <!-- Quote Card -->
          <div class="atl-det-card">
            <h5 class="atl-det-title"><i class="fa-solid fa-file-pen"></i>Quote</h5>
            ${row.quote_amount
              ? `<div class="atl-det-table-wrap">${formatQuoteDetailsAtelier(row.quote_details, row.quote_amount, row.quote_expiry_date, row.id, row.quote_sent_at)}</div>`
              : `<p class="atl-det-empty" style="margin-bottom:10px;">No quote prepared yet.</p>
                 <div class="atl-doc-actions-row">
                   <button type="button" class="atl-btn atl-btn--ghost bk-action-quote" data-id="${row.id}">
                     <i class="fa-solid fa-file-pen" style="margin-right:6px;"></i>Prepare Quote
                   </button>
                 </div>`}
          </div>

          <!-- Contract Card placeholder (populated via lazy-load) -->
          <div class="atl-det-card" id="atl-contract-${row.id}">
            <h5 class="atl-det-title"><i class="fa-solid fa-file-contract"></i>Contract</h5>
            <div class="atl-det-loading">
              <span class="atl-spinner" aria-hidden="true"></span>
              <span>Loading contract status…</span>
            </div>
          </div>

          <!-- Quote History placeholder -->
          <div id="atl-history-${row.id}"></div>
      </div>`;
        }

        function buildInvoicesPanel(row) {
            return `
      <div class="atl-det-col">
          <!-- Invoice Card -->
          <div class="atl-det-card">
            <h5 class="atl-det-title"><i class="fa-solid fa-file-invoice-dollar"></i>Invoice</h5>
            ${row.invoice_number
              ? `<div class="atl-det-table-wrap">${formatInvoiceDetailsAtelier(row.quote_details, row.total_amount, row.invoice_number, row.invoice_status, row.id, row.invoice_id, row.invoice_sent_at, row.payment_status)}</div>`
              : row.status === 'CONFIRMED'
                ? `<p class="atl-det-empty" style="margin-bottom:10px;">No invoice prepared yet.</p>
                   <div class="atl-doc-actions-row">
                     <button type="button" class="atl-btn atl-btn--ghost bk-action-gen-invoice" data-id="${row.id}">
                       <i class="fa-solid fa-file-circle-plus" style="margin-right:6px;"></i>Generate Invoice
                     </button>
                   </div>`
                : `<p class="atl-det-empty">No invoice prepared yet.</p>`}
          </div>

          <!-- Line Items placeholder -->
          <div id="atl-lineitems-${row.id}">
            <div class="atl-det-card">
              <h5 class="atl-det-title"><i class="fa-solid fa-list"></i>Line items</h5>
              <div class="atl-det-loading">
                <span class="atl-spinner" aria-hidden="true"></span><span>Loading…</span>
              </div>
            </div>
          </div>

          <!-- Transactions placeholder -->
          <div id="atl-transactions-${row.id}">
            <div class="atl-det-card">
              <h5 class="atl-det-title"><i class="fa-solid fa-arrow-right-arrow-left"></i>Transactions</h5>
              <div class="atl-det-loading">
                <span class="atl-spinner" aria-hidden="true"></span><span>Loading…</span>
              </div>
            </div>
          </div>

          <!-- Payment Schedule placeholder -->
          <div id="atl-paymentschedule-${row.id}"></div>
      </div>`;
        }

        function buildTimelinePanel(row) {
            const s = (row.status || 'PENDING').toUpperCase();
            return `
      <div class="atl-det-col">
          <!-- Activity timeline placeholder (populated via lazy-load) -->
          <div id="atl-activity-${row.id}"></div>

          <!-- Client Message Card -->
          ${row.message ? `
          <div class="atl-det-card">
            <h5 class="atl-det-title"><i class="fa-solid fa-quote-left"></i>Client message</h5>
            <p style="font-family:'Cormorant Garamond',Georgia,serif;
                       font-size:clamp(14px,4vw,15px);
                       font-style:italic;
                       line-height:1.6;
                       color:var(--atl-muted);
                       margin:0;
                       word-wrap:break-word;
                       overflow-wrap:break-word;">
              &ldquo;${row.message}&rdquo;
            </p>
          </div>` : ''}

          <!-- Cancellation Card (conditional) -->
          ${s === 'CANCELLED' ? `
          <div class="atl-det-card atl-det-card--cancel" id="atl-cancel-${row.id}">
            <div class="atl-det-loading">
              <span class="atl-spinner" aria-hidden="true"></span>
              <span>Loading cancellation details…</span>
            </div>
          </div>` : ''}

          <!-- Internal Notes Card -->
          <div class="atl-det-card">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;gap:8px;">
              <h5 class="atl-det-title" style="margin:0;"><i class="fa-solid fa-note-sticky"></i>Internal notes</h5>
              <button type="button" class="bk-notes-load-btn atl-btn atl-btn--ghost"
                      data-id="${row.id}"
                      style="font-size:10px;padding:8px 12px;white-space:nowrap;min-height:36px;">
                <i class="fa-solid fa-rotate" style="margin-right:4px;"></i>Load
              </button>
            </div>
            <div class="bk-notes-thread" id="notes-thread-${row.id}"
                 style="max-height:180px;overflow-y:auto;
                        background:var(--atl-input-bg);
                        border:1px solid var(--atl-line);
                        border-radius:8px;
                        padding:10px;
                        margin-bottom:10px;
                        font-family:'Outfit',sans-serif;
                        font-size:12px;
                        line-height:1.5;
                        color:var(--atl-muted);
                        display:none;
                        -webkit-overflow-scrolling:touch;">
              No notes yet.
            </div>
            <div style="display:flex;gap:8px;align-items:flex-end;">
              <textarea class="bk-note-input atl-textarea" id="note-input-${row.id}" rows="2" aria-label="Add a private note"
                        placeholder="Add a private note…"></textarea>
              <button type="button" class="bk-add-note-btn atl-btn"
                      data-id="${row.id}"
                      style="background:rgba(212,175,55,0.10);
                             border:1px solid rgba(212,175,55,0.35);
                             color:var(--atl-amber);
                             border-radius:8px;
                             padding:10px 14px;
                             min-height:44px;
                             white-space:nowrap;
                             font-size:12px;
                             font-weight:600;
                             display:flex;
                             align-items:center;
                             gap:6px;
                             cursor:pointer;
                             transition:background 0.15s ease;
                             flex-shrink:0;">
                <i class="fa-solid fa-plus"></i> Add
              </button>
            </div>
          </div>

          <!-- Email History card -->
          <div class="atl-det-card">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;gap:8px;">
              <h5 class="atl-det-title" style="margin:0;"><i class="fa-solid fa-envelope"></i>Email history</h5>
              <button type="button" class="bk-comms-load-btn atl-btn atl-btn--ghost"
                      data-id="${row.id}"
                      style="font-size:10px;padding:8px 12px;white-space:nowrap;min-height:36px;">
                <i class="fa-solid fa-arrows-rotate" style="margin-right:4px;"></i>Refresh
              </button>
            </div>
            <div class="bk-comms-thread" id="comms-thread-${row.id}"
                 style="max-height:160px;overflow-y:auto;font-size:12px;color:var(--atl-muted);">
              <p style="color:var(--atl-muted);font-size:12px;margin:0;">Loading email history…</p>
            </div>
          </div>

          <!-- Change History card — who edited this booking's own fields and when (distinct from the
               Activity timeline above, which is the business-lifecycle story: quoted/accepted/paid/etc). -->
          <div class="atl-det-card">
            <h5 class="atl-det-title" style="margin:0 0 10px;"><i class="fa-solid fa-timeline"></i>Change history</h5>
            <div id="dv-change-history-${row.id}" style="font-size:12px;color:var(--atl-muted);"></div>
          </div>
      </div>`;
        }

        // Human-readable size for a client attachment (server stores raw bytes; nothing else on
        // this row lends itself to a "file" reading otherwise — no upload timestamp is captured).
        function formatFileSize(bytes) {
            var n = parseInt(bytes, 10);
            if (!n || n <= 0) return '';
            if (n < 1024) return n + ' B';
            if (n < 1024 * 1024) return (n / 1024).toFixed(0) + ' KB';
            return (n / (1024 * 1024)).toFixed(1) + ' MB';
        }
        // Icon by mime type — client uploads are arbitrary files, unlike the generated documents
        // below which always know their own type.
        function attachmentIcon(mimeType) {
            var t = (mimeType || '').toLowerCase();
            if (t === 'application/pdf') return 'fa-file-pdf';
            if (t.indexOf('image/') === 0) return 'fa-file-image';
            if (t.indexOf('word') !== -1) return 'fa-file-word';
            if (t.indexOf('sheet') !== -1 || t.indexOf('excel') !== -1) return 'fa-file-excel';
            return 'fa-file';
        }

        // Files tab: two clearly separated groups sharing one visual language (.dv-file cards) —
        // what the CLIENT sent in versus what the BUSINESS generated — rather than the old mismatch
        // of small amber pill-badges for attachments alongside full file-cards for documents.
        function buildFilesPanel(row) {
            let attachmentsInner = '<p class="atl-det-empty">No client attachments on this booking.</p>';
            try {
                const files = JSON.parse(row.attachment_files || '[]');
                if (files && files.length) {
                    attachmentsInner = '<div class="dv-filegrid">' + files.map(function(f) {
                        var icon = attachmentIcon(f.mime_type);
                        var size = formatFileSize(f.size);
                        return `<a class="dv-file" href="/api/admin/booking-attachments/${encodeURIComponent(f.filename)}" target="_blank" rel="noopener">`
                             + `<span class="ico" style="background:rgba(74,222,128,0.12);color:var(--atl-sage);"><i class="fa-solid ${icon}"></i></span>`
                             + `<span><span class="fn">${f.original_name}</span><span class="fm">${size || 'Client upload'}</span></span>`
                             + `</a>`;
                    }).join('') + '</div>';
                }
            } catch (e) { /* no attachments */ }

            // Advancing only actually fetches once the Advancing tab itself is activated on a
            // CONFIRMED/COMPLETED booking (see dvActivateTab) — Files never triggers that fetch on
            // its own. So: show the always-true "locked" fact when it's genuinely locked; otherwise
            // a neutral hint rather than either an empty-looking card or a "Loading…" claim for a
            // fetch that may never run this session (misleading if the admin never visits Advancing).
            var advStatusUC = (row.status || '').toUpperCase();
            var advLocked = advStatusUC !== 'CONFIRMED' && advStatusUC !== 'COMPLETED';
            var advPlaceholder = '<p class="atl-det-empty">' + (advLocked
                ? 'Confirm this booking to unlock its advancing pack.'
                : 'Open the Advancing tab to view or generate a pack.') + '</p>';

            // Generated documents split into three phase cards that mirror the Deal View's own
            // tabs (Quote & Contract / Invoices & Payments / Advancing) — so "which tab manages
            // this document" is legible straight from the Files list, not just one undifferentiated
            // pile of chips.
            return `
      <div class="atl-det-col">
        <div class="atl-det-card">
          <h5 class="atl-det-title"><i class="fa-solid fa-paperclip"></i>Client Attachments</h5>
          ${attachmentsInner}
        </div>
        <div class="atl-det-card">
          <h5 class="atl-det-title"><i class="fa-solid fa-file-signature"></i>Quote &amp; Contract</h5>
          <div id="atl-filedocs-qc-${row.id}"><p class="atl-det-empty">Loading&hellip;</p></div>
        </div>
        <div class="atl-det-card">
          <h5 class="atl-det-title"><i class="fa-solid fa-file-invoice-dollar"></i>Invoices &amp; Payments</h5>
          <div id="atl-filedocs-inv-${row.id}"><p class="atl-det-empty">Loading&hellip;</p></div>
        </div>
        <div class="atl-det-card">
          <h5 class="atl-det-title"><i class="fa-solid fa-clipboard-list"></i>Advancing</h5>
          <div id="atl-filedocs-advancing-${row.id}">${advPlaceholder}</div>
        </div>
      </div>`;
        }

        // Shown only for bookings that haven't reached CONFIRMED yet — the real editor
        // (buildAdvancingPanel) takes over once the gate opens, fetched lazily on first tab activation.
        function buildAdvancingStub(row) {
            return `
      <div class="dv-empty">
        <div class="ico">◈</div>
        <h3>Confirm this booking to unlock its advancing pack</h3>
        <p>Once confirmed, build the run-of-show, technical rider, hospitality and show-day contacts here, then send one pack to the client and the venue.</p>
        <button type="button" class="atl-btn atl-btn--primary" disabled title="Confirm this booking first"><i class="fa-solid fa-lock" style="margin-right:6px;"></i>Advancing pack locked</button>
      </div>
      <div class="dv-ghost-label">— what this tab will hold —</div>
      <div class="dv-ghost-sketch">
        <div class="dv-ghost-card"><div class="gt">Run-of-show</div><div class="dv-ghost-line m"></div><div class="dv-ghost-line s"></div><div class="dv-ghost-line m"></div></div>
        <div class="dv-ghost-grid">
          <div class="dv-ghost-card"><div class="gt">Technical</div><div class="dv-ghost-line m"></div><div class="dv-ghost-line s"></div></div>
          <div class="dv-ghost-card"><div class="gt">Hospitality</div><div class="dv-ghost-line m"></div><div class="dv-ghost-line s"></div></div>
          <div class="dv-ghost-card"><div class="gt">Contacts</div><div class="dv-ghost-line s"></div><div class="dv-ghost-line m"></div></div>
          <div class="dv-ghost-card"><div class="gt">Travel &amp; stay</div><div class="dv-ghost-line m"></div><div class="dv-ghost-line s"></div></div>
        </div>
      </div>
      <div class="atl-callout"><i class="fa-solid fa-circle-info"></i>Contacts &amp; load-in time are already on the linked venue record — the pack would pre-fill from there rather than re-typing.</div>`;
        }

        // A labelled text field bound to PUT /advancing via data-field — collected by
        // advCollectFields() when the Save Draft button is clicked.
        function advField(field, label, value) {
            const safe = value ? String(value).replace(/"/g, '&quot;') : '';
            return `<div style="margin-bottom:10px;"><label class="atl-panel-label" style="margin-bottom:4px;display:block;">${label}</label>`
                 + `<input type="text" class="atl-input adv-field" data-field="${field}" value="${safe}" style="width:100%;"></div>`;
        }

        // Real Advancing tab editor — replaces buildAdvancingStub() once a booking reaches
        // CONFIRMED. `data` is the GET /advancing response: { pack, run_of_show, contacts,
        // auto_contacts, venue }. Rebuilt wholesale (advReloadPanel) after every save/CRUD action
        // rather than patched in place — simplest way to stay in sync with server-assigned ids
        // (new ROS rows, new contacts) and re-derived state (status, sent/confirmed timestamps).
        function buildAdvancingPanel(data, bookingId) {
            const pack = data.pack || {};
            const ros = data.run_of_show || [];
            const contacts = data.contacts || [];
            const autoContacts = data.auto_contacts || [];
            const statusLbl = { draft: 'Draft', sent: 'Sent', confirmed: 'Confirmed' };
            const statusColor = pack.status === 'confirmed' ? 'var(--atl-sage)' : pack.status === 'sent' ? 'var(--atl-blue)' : 'var(--atl-muted)';
            const venueHasEmail = !!(data.venue && data.venue.contact_email);

            const rosRowsHtml = ros.map(function(item, idx) {
                return `
            <div class="atl-adv-ros-row" data-id="${item.id}">
              <input type="text" class="atl-input adv-ros-time" data-field="time_label" value="${item.time_label || ''}" placeholder="18:30" style="width:76px;">
              <input type="text" class="atl-input adv-ros-title" data-field="title" value="${item.title || ''}" placeholder="Title" style="flex:1;min-width:120px;">
              <input type="text" class="atl-input adv-ros-detail" data-field="detail" value="${item.detail || ''}" placeholder="Detail" style="flex:2;min-width:140px;">
              <input type="text" class="atl-input adv-ros-resp" data-field="responsible" value="${item.responsible || ''}" placeholder="Responsible" style="width:120px;">
              <button type="button" class="atl-btn atl-btn--ghost adv-ros-up" data-id="${item.id}" ${idx === 0 ? 'disabled' : ''} title="Move up"><i class="fa-solid fa-arrow-up"></i></button>
              <button type="button" class="atl-btn atl-btn--ghost adv-ros-down" data-id="${item.id}" ${idx === ros.length - 1 ? 'disabled' : ''} title="Move down"><i class="fa-solid fa-arrow-down"></i></button>
              <button type="button" class="atl-btn atl-btn--ghost adv-ros-delete" data-id="${item.id}" style="color:var(--atl-clay);" title="Delete"><i class="fa-solid fa-trash-can"></i></button>
            </div>`;
            }).join('');

            const autoContactsHtml = autoContacts.map(function(c) {
                const originLbl = c.source === 'booking' ? 'client' : c.source === 'comedians' ? 'artist record' : c.source === 'manager_details' ? 'manager record' : 'linked venue';
                return `
            <div class="atl-adv-contact">
              <div class="atl-lead" style="font-size:13px;">${c.role} <span class="co">· auto-sourced from ${originLbl}</span></div>
              <div class="atl-sub">${c.name || '—'}${c.phone ? ' · ' + c.phone : ''}${c.email ? ' · ' + c.email : ''}</div>
            </div>`;
            }).join('');

            const extraContactsHtml = contacts.map(function(c) {
                return `
            <div class="atl-adv-contact" data-id="${c.id}">
              <div class="atl-lead" style="font-size:13px;">${c.role || 'Contact'}
                <button type="button" class="adv-contact-delete" data-id="${c.id}" style="background:none;border:none;color:var(--atl-clay);cursor:pointer;font-size:11px;margin-left:8px;" title="Remove"><i class="fa-solid fa-trash-can"></i></button>
              </div>
              <div class="atl-sub">${c.name || '—'}${c.phone ? ' · ' + c.phone : ''}${c.email ? ' · ' + c.email : ''}</div>
            </div>`;
            }).join('');

            return `
      <div class="atl-det-col" data-booking-id="${bookingId}">
        <div class="atl-det-card">
          <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;">
            <h5 class="atl-det-title" style="margin:0;"><i class="fa-solid fa-clipboard-list"></i>Advancing Pack</h5>
            <span class="atl-status-badge" style="background:${statusColor}22;color:${statusColor};">${statusLbl[pack.status] || 'Draft'}</span>
          </div>
          <div class="atl-doc-actions-row" style="margin-top:12px;">
            <button type="button" class="atl-btn atl-btn--primary adv-save-btn" data-id="${bookingId}"><i class="fa-solid fa-floppy-disk" style="margin-right:6px;"></i>Save Draft</button>
            <button type="button" class="atl-btn adv-preview-btn" data-id="${bookingId}"><i class="fa-solid fa-file-pdf" style="margin-right:6px;"></i>Preview PDF</button>
            <button type="button" class="atl-btn adv-send-btn" data-id="${bookingId}" ${venueHasEmail ? '' : 'disabled title="Link a venue with a contact email first"'}><i class="fa-solid fa-paper-plane" style="margin-right:6px;"></i>Send to Client &amp; Venue</button>
            <button type="button" class="atl-btn atl-btn--ghost adv-confirm-btn" data-id="${bookingId}"><i class="fa-solid fa-circle-check" style="margin-right:6px;"></i>Mark Confirmed</button>
          </div>
          ${pack.sent_to_client_at ? `<p class="atl-sub" style="margin-top:8px;">Sent ${new Date(pack.sent_to_client_at).toLocaleString('en-ZA')}</p>` : ''}
        </div>

        <div class="atl-det-card">
          <h5 class="atl-det-title"><i class="fa-solid fa-list-check"></i>Run of Show</h5>
          <div class="atl-adv-ros-list" id="adv-ros-list-${bookingId}">${rosRowsHtml || '<p class="atl-det-empty">No run-of-show items yet.</p>'}</div>
          <div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap;">
            <input type="text" class="atl-input adv-ros-new-time" placeholder="Time (e.g. 18:30)" style="width:120px;">
            <input type="text" class="atl-input adv-ros-new-title" placeholder="Title (e.g. Doors open)" style="flex:1;min-width:140px;">
            <button type="button" class="atl-btn adv-ros-add" data-id="${bookingId}"><i class="fa-solid fa-plus"></i></button>
          </div>
        </div>

        <div class="atl-det-card">
          <h5 class="atl-det-title"><i class="fa-solid fa-sliders"></i>Technical</h5>
          ${advField('mic_type', 'Mic type', pack.mic_type)}
          ${advField('pa_spec', 'PA spec', pack.pa_spec)}
          ${advField('monitors', 'Monitors', pack.monitors)}
          ${advField('lighting', 'Lighting', pack.lighting)}
          ${advField('stage_layout', 'Stage layout', pack.stage_layout)}
          ${advField('equipment_responsibility', 'Equipment responsibility', pack.equipment_responsibility)}
        </div>

        <div class="atl-det-card">
          <h5 class="atl-det-title"><i class="fa-solid fa-mug-hot"></i>Hospitality</h5>
          ${!pack.id && pack.green_room_notes ? '<div class="atl-callout"><i class="fa-solid fa-circle-info"></i>Green room notes pre-filled from the linked venue.</div>' : ''}
          ${advField('green_room_notes', 'Green room notes', pack.green_room_notes)}
          ${advField('meals', 'Meals', pack.meals)}
          ${advField('dietary', 'Dietary', pack.dietary)}
          ${advField('parking_wifi', 'Parking / Wi-Fi', pack.parking_wifi)}
        </div>

        <div class="atl-det-card">
          <h5 class="atl-det-title"><i class="fa-solid fa-address-book"></i>Contacts</h5>
          <div class="atl-adv-contacts-auto">${autoContactsHtml}</div>
          <div class="atl-adv-contacts-extra" id="adv-contacts-extra-${bookingId}">${extraContactsHtml}</div>
          <div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap;">
            <input type="text" class="atl-input adv-contact-new-role" placeholder="Role (e.g. Stage Manager)" style="width:150px;">
            <input type="text" class="atl-input adv-contact-new-name" placeholder="Name" style="flex:1;min-width:100px;">
            <input type="text" class="atl-input adv-contact-new-phone" placeholder="Phone" style="width:120px;">
            <input type="text" class="atl-input adv-contact-new-email" placeholder="Email" style="width:170px;">
            <button type="button" class="atl-btn adv-contact-add" data-id="${bookingId}"><i class="fa-solid fa-plus"></i></button>
          </div>
        </div>

        <div class="atl-det-card">
          <h5 class="atl-det-title"><i class="fa-solid fa-plane"></i>Travel &amp; Accommodation</h5>
          <label class="atl-panel-label" style="margin-bottom:4px;display:block;">Travel type</label>
          <select class="atl-input adv-field" data-field="travel_type" style="margin-bottom:10px;width:100%;">
            <option value="" ${!pack.travel_type ? 'selected' : ''}>—</option>
            <option value="local" ${pack.travel_type === 'local' ? 'selected' : ''}>Local</option>
            <option value="out_of_town" ${pack.travel_type === 'out_of_town' ? 'selected' : ''}>Out of town</option>
          </select>
          ${advField('flights', 'Flights', pack.flights)}
          ${advField('hotel', 'Hotel', pack.hotel)}
          ${advField('ground_transport', 'Ground transport', pack.ground_transport)}
        </div>

        <div class="atl-det-card">
          <h5 class="atl-det-title"><i class="fa-solid fa-note-sticky"></i>Notes</h5>
          <textarea class="atl-textarea adv-field" data-field="internal_notes" rows="3" placeholder="Internal notes — never sent to the client or venue…" style="width:100%;">${pack.internal_notes || ''}</textarea>
        </div>
      </div>`;
        }

        function renderBookingsTable(data, containerSelector) {
            const $container = $(containerSelector || '#bookingsListContainer');
            if (!$container.length) return;
            $container.empty();

            if (!data.length) {
                $container.append(`
                    <div class="atl-empty-state">
                        <i class="fa-solid fa-calendar-xmark" style="font-size:32px; color:var(--atl-muted); display:block; margin-bottom:12px;"></i>
                        <p class="atl-empty-mono" style="margin:0;">No bookings match the current filter.</p>
                    </div>
                `);
                return;
            }

            const payLbl = { PAID:'✓ Paid', DEPOSIT_PAID:'◐ Deposit', PARTIALLY_PAID:'◑ Partial', UNPAID:'○ Unpaid', FAILED:'✕ Failed', CANCELLED:'✕ Cancelled' };
            // Gap 4 (Phase 2): 'RESPONDED' removed — it was a legacy status retired in Phase 2.
            const sLbl   = { NEW:'New', PENDING:'Pending', QUOTED:'Quoted', ACCEPTED:'Accepted', CONFIRMED:'Confirmed', COMPLETED:'Completed', EXPIRED:'Expired', CANCELLED:'Cancelled', REJECTED:'Rejected' };
            let rowsHtml = '';

            data.forEach(function(row, _idx) {
                const s  = (row.status || 'PENDING').toUpperCase();
                const ps = (row.payment_status || 'UNPAID').toUpperCase();
                const disposition = row.disposition || 'active';
                const evDate = row.date || '';
                const subDate = new Date(row.created_at).toLocaleDateString('en-ZA', { day:'2-digit', month:'short', year:'numeric' });

                // Days until event urgency warning
                const today = new Date().toISOString().split('T')[0];
                let daysUntilHtml = '';
                if (evDate && !['CANCELLED','COMPLETED'].includes(s)) {
                    const daysUntil = Math.ceil((new Date(evDate) - new Date(today)) / 86400000);
                    if (daysUntil >= 0) {
                        const duColor = daysUntil <= 7 ? 'var(--atl-clay)' : daysUntil <= 30 ? 'var(--atl-amber)' : 'var(--atl-sage)';
                        const duLabel = daysUntil === 0 ? 'TODAY' : daysUntil === 1 ? '1 day' : `${daysUntil} days`;
                        daysUntilHtml = `<span style="font-size:10px; background:rgba(212,175,55,0.08); color:${duColor}; border:1px solid var(--atl-line); border-radius:3px; padding:1px 5px; margin-left:6px; font-weight:600;">${duLabel}</span>`;
                    }
                }

                // Submission Age Calculation
                const ageDays = Math.max(0, Math.round((new Date(today) - new Date(row.created_at)) / 86400000));
                const ageLabel = ageDays === 0 ? 'today' : ageDays === 1 ? '1 day ago' : `${ageDays} days ago`;
                const stale = s === 'PENDING' && ageDays >= 7;
                const adminActionRequired = s === 'NEW' || s === 'PENDING' || s === 'ACCEPTED' ||
                    (s === 'CONFIRMED' && (ps !== 'PAID' || (evDate && evDate < today)));
                const ageLine = `<span style="color:${adminActionRequired ? 'var(--atl-clay)' : 'var(--atl-muted)'}; font-weight:${adminActionRequired ? '600' : '400'}">${stale ? '⚠ ' : ''}Submitted ${ageLabel} (on ${subDate})</span>`;

                // Badge colors
                const colors = window.statusColors(s);

                // Next-step indicator hint
                const quotedAgeDays  = row.quoted_at ? Math.floor((new Date(today) - new Date(row.quoted_at)) / 86400000) : 0;
                const eventPassed    = evDate && evDate < today;
                const daysUntilEvent = evDate ? Math.ceil((new Date(evDate) - new Date(today)) / 86400000) : Infinity;
                const hasInvoice     = !!row.invoice_id;
                const invoiceSent    = !!row.invoice_sent_at;
                // Only a SENT invoice can be overdue — a never-emailed DRAFT with a past due_date is not.
                const invoiceOverdue = invoiceSent && row.invoice_due_date && row.invoice_due_date < today && ps !== 'PAID';
                // Normalised invoice signal — drives ACCEPTED card lifecycle (Option A)
                const inv         = String(row.invoice_status || '').toUpperCase();
                const invId       = row.invoice_id || null;
                const hasInv      = !!invId && inv !== 'VOID';
                const invPaid     = inv === 'PAID' || ps === 'PAID';
                const invDraft    = inv === 'DRAFT'; // draft-then-send: generated, not yet emailed
                // Stages: none → invoice_draft (needs sending) → invoiced (sent) → paid
                let acceptedStage = 'none';
                if (invPaid)                 acceptedStage = 'paid';
                else if (hasInv && invDraft) acceptedStage = 'invoice_draft';
                else if (hasInv)             acceptedStage = 'invoiced';
                const invDueDays     = row.invoice_due_date ? Math.ceil((new Date(row.invoice_due_date) - new Date(today)) / 86400000) : null;
                const invDueSoon     = invDueDays !== null && invDueDays >= 0 && invDueDays <= 5 && ps !== 'PAID';
                let nextStepHtml = '';
                if (s === 'EXPIRED') {
                    nextStepHtml = `<span class="atl-status-badge" title="This enquiry has expired. Use Reopen Booking to restore it to Pending and prepare a fresh quote." aria-label="Next step: Reopen booking" style="background:rgba(192,54,44,0.08); color:var(--atl-clay); border:1px solid rgba(192,54,44,0.25);"><i class="fa-solid fa-rotate-left"></i> Reopen Booking</span>`;
                } else if ((s === 'NEW' || s === 'PENDING') && !row.quote_amount) {
                    nextStepHtml = `<span class="atl-status-badge" title="Review the enquiry details and use the Send Quote button below to generate and email a formal quote to the client." aria-label="Next step: Send a quote" style="background:rgba(96,165,250,0.1); color:var(--atl-blue); border:1px solid rgba(96,165,250,0.25);"><i class="fa-solid fa-file-invoice-dollar"></i> Send Quote</span>`;
                } else if ((s === 'NEW' || s === 'PENDING') && row.quote_amount) {
                    nextStepHtml = `<span class="atl-status-badge" title="A quote has already been sent. Review the booking and resend a revised quote if the client has not yet responded." aria-label="Next step: Revise the quote" style="background:rgba(212,175,55,0.08); color:var(--atl-amber); border:1px solid var(--atl-line);"><i class="fa-solid fa-file-pen"></i> Revise Quote</span>`;
                } else if (s === 'QUOTED' && !row.accepted_at && quotedAgeDays >= 7) {
                    nextStepHtml = `<span class="atl-status-badge" title="The quote has been pending for over ${quotedAgeDays} days. Consider sending a follow-up email to prompt the client to respond." aria-label="Next step: Follow up with client — quote is stale" style="background:rgba(192,54,44,0.08); color:var(--atl-clay); border:1px solid rgba(192,54,44,0.25);"><i class="fa-solid fa-bell"></i> Follow Up</span>`;
                } else if (s === 'QUOTED' && !row.accepted_at) {
                    nextStepHtml = `<span class="atl-status-badge" title="The quote has been sent. Waiting for the client to accept. No action needed unless you'd like to follow up." aria-label="Next step: Awaiting client response" style="background:rgba(212,175,55,0.08); color:var(--atl-amber); border:1px solid var(--atl-line);"><i class="fa-solid fa-hourglass-half"></i> Awaiting Client</span>`;
                } else if (s === 'ACCEPTED' && acceptedStage === 'none') {
                    nextStepHtml = `<span class="atl-status-badge" title="No invoice has been generated yet. Click Generate Invoice to create and send the client a formal invoice." aria-label="Next step: generate the client's invoice" style="background:rgba(96,165,250,0.1); color:var(--atl-blue); border:1px solid rgba(96,165,250,0.25);"><i class="fa-solid fa-file-invoice-dollar"></i> Generate Invoice</span>`;
                } else if (s === 'ACCEPTED' && acceptedStage === 'invoiced') {
                    nextStepHtml = `<span class="atl-status-badge" title="Invoice has been sent to the client. Awaiting payment. Record payment once funds are received, then Confirm the booking." aria-label="Next step: awaiting client payment" style="background:rgba(251,146,60,0.1); color:var(--atl-amber-light); border:1px solid rgba(251,146,60,0.25);"><i class="fa-solid fa-hourglass-half"></i> Awaiting Payment</span>`;
                } else if (s === 'ACCEPTED' && acceptedStage === 'paid') {
                    nextStepHtml = `<span class="atl-status-badge" title="Payment is recorded. Click Confirm to lock in the booking and send the client a confirmation email." aria-label="Next step: prepare for the event" style="background:rgba(74,222,128,0.1); color:var(--atl-sage); border:1px solid rgba(74,222,128,0.25);"><i class="fa-solid fa-clipboard-check"></i> Event Preparation</span>`;
                } else if (s === 'CONFIRMED' && !hasInvoice && ps !== 'PAID' && !eventPassed) {
                    nextStepHtml = `<span class="atl-status-badge" title="Booking is confirmed but no invoice has been generated yet. Use 'Generate Invoice' below to create and send the client a formal invoice." aria-label="Next step: Generate invoice" style="background:rgba(96,165,250,0.1); color:var(--atl-blue); border:1px solid rgba(96,165,250,0.25);"><i class="fa-solid fa-file-circle-plus"></i> Generate Invoice</span>`;
                } else if (s === 'CONFIRMED' && hasInvoice && !invoiceSent && ps !== 'PAID' && !eventPassed) {
                    nextStepHtml = `<span class="atl-status-badge" title="An invoice has been generated but not yet emailed to the client. Use 'Send Invoice' on the Invoice card below to deliver it." aria-label="Next step: Send invoice to client" style="background:rgba(96,165,250,0.1); color:var(--atl-blue); border:1px solid rgba(96,165,250,0.25);"><i class="fa-solid fa-paper-plane"></i> Send Invoice</span>`;
                } else if (s === 'CONFIRMED' && invoiceOverdue) {
                    nextStepHtml = `<span class="atl-status-badge" title="The invoice payment was due on ${row.invoice_due_date} and is now overdue. Follow up with the client immediately." aria-label="Next step: Invoice overdue — follow up now" style="background:rgba(192,54,44,0.12); color:var(--atl-clay); border:1px solid rgba(192,54,44,0.35);"><i class="fa-solid fa-triangle-exclamation"></i> Invoice Overdue</span>`;
                } else if (s === 'CONFIRMED' && invDueSoon) {
                    nextStepHtml = `<span class="atl-status-badge" title="Payment is due in ${invDueDays} day${invDueDays === 1 ? '' : 's'} (${row.invoice_due_date}). Consider sending a payment reminder to the client." aria-label="Next step: Payment due soon" style="background:rgba(251,146,60,0.1); color:var(--atl-amber-light); border:1px solid rgba(251,146,60,0.3);"><i class="fa-solid fa-clock"></i> Due in ${invDueDays}d</span>`;
                } else if (s === 'CONFIRMED' && hasInvoice && invoiceSent && ps !== 'PAID' && !eventPassed) {
                    nextStepHtml = `<span class="atl-status-badge" title="Invoice has been sent to the client. Awaiting payment. Record payment below once funds are received." aria-label="Next step: Awaiting invoice payment" style="background:rgba(251,146,60,0.1); color:var(--atl-amber-light); border:1px solid rgba(251,146,60,0.25);"><i class="fa-solid fa-hourglass-half"></i> Awaiting Payment</span>`;
                } else if (s === 'CONFIRMED' && ps !== 'PAID' && eventPassed) {
                    nextStepHtml = `<span class="atl-status-badge" title="The event has already occurred but payment is still outstanding. Collect payment then mark the booking as completed." aria-label="Next step: Collect payment — event has passed" style="background:rgba(192,54,44,0.08); color:var(--atl-clay); border:1px solid rgba(192,54,44,0.25);"><i class="fa-solid fa-triangle-exclamation"></i> Collect &amp; Close</span>`;
                } else if (s === 'CONFIRMED' && ps !== 'PAID') {
                    nextStepHtml = `<span class="atl-status-badge" title="Booking is confirmed but payment has not been recorded yet. Use Record Payment below when funds are received." aria-label="Next step: Collect payment" style="background:rgba(251,146,60,0.1); color:var(--atl-amber-light); border:1px solid rgba(251,146,60,0.25);"><i class="fa-solid fa-money-bill-wave"></i> Collect Payment</span>`;
                } else if (s === 'CONFIRMED' && ps === 'PAID' && eventPassed) {
                    nextStepHtml = `<span class="atl-status-badge" title="Payment is settled and the event has passed. Click Mark Completed below to close the booking and send the client a completion notification." aria-label="Next step: Mark booking as completed" style="background:rgba(129,140,248,0.1); color:var(--atl-blue); border:1px solid rgba(129,140,248,0.25);"><i class="fa-solid fa-flag-checkered"></i> Mark as Completed</span>`;
                } else if (s === 'CONFIRMED' && ps === 'PAID' && !eventPassed && !row.google_event_id) {
                    nextStepHtml = `<span class="atl-status-badge" title="Booking is confirmed and paid. Sync to Google Calendar to lock in the date and send the client a calendar invite." aria-label="Next step: Sync booking to Google Calendar" style="background:rgba(96,165,250,0.1); color:var(--atl-blue); border:1px solid rgba(96,165,250,0.25);"><i class="fa-solid fa-calendar-plus"></i> Sync to Calendar</span>`;
                } else if (s === 'CONFIRMED' && ps === 'PAID' && !eventPassed && daysUntilEvent <= 14) {
                    nextStepHtml = `<span class="atl-status-badge" title="The event is in ${daysUntilEvent} day${daysUntilEvent === 1 ? '' : 's'}. Review the booking details, confirm logistics, and ensure everything is in order for the client." aria-label="Next step: Event approaching — review final details" style="background:rgba(212,175,55,0.08); color:var(--atl-amber); border:1px solid var(--atl-line);"><i class="fa-solid fa-calendar-exclamation"></i> Event in ${daysUntilEvent}d</span>`;
                } else if (s === 'CONFIRMED' && ps === 'PAID' && !eventPassed) {
                    nextStepHtml = `<span class="atl-status-badge" title="Booking is fully confirmed and payment is recorded. The event is upcoming — no urgent action required." aria-label="Booking status: All confirmed and on track" style="background:rgba(74,222,128,0.1); color:var(--atl-sage); border:1px solid rgba(74,222,128,0.25);"><i class="fa-solid fa-circle-check"></i> All Confirmed</span>`;
                } else if (s === 'COMPLETED') {
                    nextStepHtml = `<span class="atl-status-badge" title="Booking is complete. Send the client a review request to build Thabiso's profile and gather testimonials." aria-label="Next step: Request a client review" style="background:rgba(74,222,128,0.1); color:var(--atl-sage); border:1px solid rgba(74,222,128,0.25);"><i class="fa-solid fa-star"></i> Request Review</span>`;
                } else if (s === 'CANCELLED' && row.refund_amount) {
                    nextStepHtml = `<span class="atl-status-badge" title="Refund has been recorded. If the client wishes to rebook, use Book Again to create a new booking from this record." aria-label="Next step: Book Again" style="background:rgba(129,140,248,0.1); color:var(--atl-blue); border:1px solid rgba(129,140,248,0.25);"><i class="fa-solid fa-calendar-plus"></i> Book Again</span>`;
                } else if (s === 'CANCELLED' && !row.refund_amount) {
                    nextStepHtml = `<span class="atl-status-badge" title="This booking was cancelled. If a refund is owed, use the Record Refund button to log the payment and update the client's record." aria-label="Next step: Record the refund" style="background:rgba(212,175,55,0.08); color:var(--atl-amber); border:1px solid var(--atl-line);"><i class="fa-solid fa-rotate-left"></i> Record Refund</span>`;
                }

                // Quote panel display
                const quoteDisplay = row.quote_amount ? `
                <div class="atl-sub-panel mb-4" style="border: 1px solid var(--atl-line); margin-top: 12px;">
                  <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px;">
                    <span style="font-size:12px; font-weight:600; color:var(--atl-amber);"><i class="fa-solid fa-file-invoice-dollar" style="margin-right:6px;"></i>Quote Sent</span>
                    <strong style="font-family:'Cormorant Garamond', serif; font-size:18px; color:var(--atl-ink);">R ${parseFloat(String(row.quote_amount||0).replace(/[^0-9.-]/g, '')).toFixed(2)}</strong>
                  </div>
                  <div>${formatQuoteDetails(row.quote_details)}</div>
                  ${row.quote_expiry_date ? `<div style="font-size:11px; color:var(--atl-muted); margin-top:8px;">Expires: ${row.quote_expiry_date}</div>` : ''}
                </div>` : '';

                // Header actions / action buttons HTML
                // Inline bar carries the primary next-step CTA; secondary actions are demoted
                // into the existing "More" menu (below) to cut mobile clutter. Handlers are
                // class-delegated, so a demoted item keeps its exact behaviour.
                let actionButtonsHtml = '';
                let demotedMoreItems = '';
                const moreConfirm  = `<button type="button" class="atl-actions-dropdown-item bk-action-status" data-id="${row.id}" data-status="CONFIRMED"><i class="fa-solid fa-circle-check" style="color:var(--atl-sage);width:14px;"></i> Confirm Booking</button>`;
                const morePayment  = `<button type="button" class="atl-actions-dropdown-item bk-action-record-payment" data-id="${row.id}" data-quote="${row.quote_amount||''}"><i class="fa-solid fa-money-bill-wave" style="color:var(--atl-amber);width:14px;"></i> Record Payment</button>`;
                const moreComplete = `<button type="button" class="atl-actions-dropdown-item bk-action-complete" data-id="${row.id}"><i class="fa-solid fa-flag-checkered" style="color:var(--atl-sage);width:14px;"></i> Mark Completed</button>`;
                if ((s === 'NEW' || s === 'PENDING') && !row.quote_amount) {
                    actionButtonsHtml += `<button type="button" class="atl-btn atl-btn--primary atl-primary-cta bk-action-quote" data-id="${row.id}"><i class="fa-solid fa-file-invoice-dollar" style="margin-right:6px;"></i>Send Quote</button>`;
                }
                if ((s === 'NEW' || s === 'PENDING') && row.quote_amount) {
                    actionButtonsHtml += `<button type="button" class="atl-btn atl-btn--primary atl-primary-cta bk-action-quote" data-id="${row.id}"><i class="fa-solid fa-file-invoice-dollar" style="margin-right:6px;"></i>Revise &amp; Send Quote</button>`;
                }
                if (s === 'QUOTED') {
                    actionButtonsHtml += `<button type="button" class="atl-btn atl-btn--primary atl-primary-cta bk-action-status" data-id="${row.id}" data-status="ACCEPTED"><i class="fa-solid fa-handshake" style="margin-right:6px;"></i>Accept</button>`;
                }
                if (s === 'ACCEPTED') {
                    if (acceptedStage === 'none') {
                        actionButtonsHtml += `<button type="button" class="atl-btn atl-btn--primary atl-primary-cta bk-action-gen-invoice" data-id="${row.id}"><i class="fa-solid fa-file-invoice-dollar" style="margin-right:6px;"></i>Generate Invoice</button>`;
                        demotedMoreItems += moreConfirm + morePayment;
                    } else if (acceptedStage === 'invoice_draft') {
                        // Draft invoice exists but hasn't been emailed — sending is the next step, not payment.
                        actionButtonsHtml += `<button type="button" class="atl-btn atl-btn--primary atl-primary-cta bk-action-send-invoice" data-id="${row.id}" data-invoice-id="${row.invoice_id}"><i class="fa-solid fa-paper-plane" style="margin-right:6px;"></i>Send Invoice</button>`;
                        demotedMoreItems += moreConfirm + morePayment;
                    } else if (acceptedStage === 'invoiced') {
                        actionButtonsHtml += `<button type="button" class="atl-btn atl-btn--primary atl-primary-cta bk-action-record-payment" data-id="${row.id}" data-quote="${row.quote_amount||''}"><i class="fa-solid fa-money-bill-wave" style="margin-right:6px;"></i>Record Payment</button>`;
                        demotedMoreItems += moreConfirm;
                    } else {
                        actionButtonsHtml += `<button type="button" class="atl-btn atl-btn--primary atl-primary-cta bk-action-status" data-id="${row.id}" data-status="CONFIRMED"><i class="fa-solid fa-circle-check" style="margin-right:6px;"></i>Confirm</button>`;
                        // "Open Booking" dropped from inline — the More menu's "Booking Info" (bk-action-info) is the same action.
                    }
                }
                if (s === 'CONFIRMED' && !hasInvoice && ps !== 'PAID') {
                    actionButtonsHtml += `<button type="button" class="atl-btn atl-btn--primary atl-primary-cta bk-action-gen-invoice" data-id="${row.id}"><i class="fa-solid fa-file-circle-plus" style="margin-right:6px;"></i>Generate Invoice</button>`;
                    demotedMoreItems += morePayment;
                }
                if (s === 'CONFIRMED' && hasInvoice && !invoiceSent && ps !== 'PAID') {
                    actionButtonsHtml += `<button type="button" class="atl-btn atl-btn--primary atl-primary-cta bk-action-send-invoice" data-id="${row.id}" data-invoice-id="${row.invoice_id}"><i class="fa-solid fa-paper-plane" style="margin-right:6px;"></i>Send Invoice</button>`;
                    demotedMoreItems += morePayment;
                }
                if (s === 'CONFIRMED' && hasInvoice && invoiceSent && ps !== 'PAID') {
                    actionButtonsHtml += `<button type="button" class="atl-btn atl-btn--primary atl-primary-cta bk-action-record-payment" data-id="${row.id}" data-quote="${row.quote_amount||''}"><i class="fa-solid fa-money-bill-wave" style="margin-right:6px;"></i>Record Payment</button>`;
                    demotedMoreItems += moreComplete;
                }
                if (s === 'CONFIRMED' && ps === 'PAID') {
                    actionButtonsHtml += `<button type="button" class="atl-btn atl-btn--primary atl-primary-cta bk-action-complete" data-id="${row.id}"><i class="fa-solid fa-flag-checkered" style="margin-right:6px;"></i>Mark Completed</button>`;
                }
                if (s === 'COMPLETED') {
                    actionButtonsHtml += `<button type="button" class="atl-btn atl-btn--ghost bk-action-review-request" data-id="${row.id}"><i class="fa-solid fa-star" style="margin-right:6px;"></i>Request Review</button>`;
                }
                if (s === 'EXPIRED') {
                    actionButtonsHtml += `<button type="button" class="atl-btn atl-btn--primary atl-primary-cta bk-action-reopen" data-id="${row.id}"><i class="fa-solid fa-rotate-left" style="margin-right:6px;"></i>Reopen Booking</button>`;
                }
                if (s === 'CANCELLED') {
                    actionButtonsHtml += `<button type="button" class="atl-btn atl-btn--ghost bk-action-refund" data-id="${row.id}"><i class="fa-solid fa-rotate-left" style="margin-right:6px;"></i>Record Refund</button>`;
                    // "Book Again" dropped from inline — it already lives in the More menu below (bk-action-book-again).
                }

                // Add "More" dropdown
                actionButtonsHtml += `
                <div class="bkr-more-menu" style="position:relative;">
                  <button type="button" class="atl-btn atl-btn--ghost bk-action-more" data-id="${row.id}">
                    <i class="fa-solid fa-ellipsis-vertical" style="margin-right:4px;"></i> More
                  </button>
                  <div class="atl-actions-dropdown-panel bkr-more-dropdown" data-id="${row.id}" style="display:none;">
                    <button type="button" class="atl-actions-dropdown-item bk-action-info" data-id="${row.id}"><i class="fa-solid fa-id-card" style="color:var(--atl-blue);width:14px;"></i> Booking Info</button>
                    <button type="button" class="atl-actions-dropdown-item bk-action-financials" data-id="${row.id}"><i class="fa-solid fa-chart-line" style="color:var(--atl-amber);width:14px;"></i> Financial Controls</button>
                    <button type="button" class="atl-actions-dropdown-item bk-action-email" data-id="${row.id}"><i class="fa-solid fa-envelope" style="color:var(--atl-sage);width:14px;"></i> Email Client</button>
                    ${demotedMoreItems}
                    ${s === 'ACCEPTED' ? `<button type="button" class="atl-actions-dropdown-item bk-action-status" data-id="${row.id}" data-status="QUOTED"><i class="fa-solid fa-rotate-left" style="color:var(--atl-amber-light);width:14px;"></i> Rescind Acceptance</button>` : ''}
                    ${s === 'ACCEPTED' && acceptedStage === 'none' ? `<button type="button" class="atl-actions-dropdown-item bk-action-gen-invoice" data-id="${row.id}"><i class="fa-solid fa-file-invoice-dollar" style="color:var(--atl-blue);width:14px;"></i> Generate Invoice</button>` : ''}
                    ${s === 'ACCEPTED' && (acceptedStage === 'invoiced' || acceptedStage === 'paid') ? `<button type="button" class="atl-actions-dropdown-item bk-action-send-invoice" data-id="${row.id}" data-invoice-id="${row.invoice_id}"><i class="fa-solid fa-rotate-right" style="color:var(--atl-blue);width:14px;"></i> Resend Invoice</button>` : ''}
                    ${!['CANCELLED','COMPLETED','CONFIRMED'].includes(s)&&evDate ? `<button type="button" class="atl-actions-dropdown-item bk-action-hold-date" data-id="${row.id}" data-date="${evDate}"><i class="fa-solid fa-calendar-xmark" style="color:var(--atl-clay);width:14px;"></i> Hold Date</button>` : ''}
                    ${['QUOTED','ACCEPTED','CONFIRMED'].includes(s) ? `<button type="button" class="atl-actions-dropdown-item bk-action-resend-quote" data-id="${row.id}"><i class="fa-solid fa-rotate-right" style="color:var(--atl-amber-light);width:14px;"></i> Resend Quote</button>` : ''}
                    ${['CONFIRMED','COMPLETED'].includes(s) ? `<button type="button" class="atl-actions-dropdown-item bk-action-resend-confirm" data-id="${row.id}"><i class="fa-solid fa-rotate-right" style="color:var(--atl-sage);width:14px;"></i> Resend Confirmation</button>` : ''}
                    ${s === 'CONFIRMED' && !hasInvoice ? `<button type="button" class="atl-actions-dropdown-item bk-action-gen-invoice" data-id="${row.id}"><i class="fa-solid fa-file-circle-plus" style="color:var(--atl-blue);width:14px;"></i> Generate Invoice</button>` : ''}
                    ${s === 'CONFIRMED' && hasInvoice && !invoiceSent ? `<button type="button" class="atl-actions-dropdown-item bk-action-send-invoice" data-id="${row.id}" data-invoice-id="${row.invoice_id}"><i class="fa-solid fa-paper-plane" style="color:var(--atl-blue);width:14px;"></i> Send Invoice</button>` : ''}
                    ${s === 'CONFIRMED' && hasInvoice && invoiceSent && ps !== 'PAID' ? `<button type="button" class="atl-actions-dropdown-item bk-action-send-invoice" data-id="${row.id}" data-invoice-id="${row.invoice_id}"><i class="fa-solid fa-rotate-right" style="color:var(--atl-blue);width:14px;"></i> Resend Invoice</button>` : ''}
                    <button type="button" class="atl-actions-dropdown-item bk-action-contract" data-id="${row.id}"><i class="fa-solid fa-file-contract" style="color:#9575CD;width:14px;"></i> Contract</button>
                    <button type="button" class="atl-actions-dropdown-item bk-action-sync-cal" data-id="${row.id}"><i class="fa-solid fa-rotate" style="color:var(--atl-blue);width:14px;"></i> Sync to Calendar</button>
                    ${s === 'EXPIRED' ? `<button type="button" class="atl-actions-dropdown-item bk-action-reopen" data-id="${row.id}"><i class="fa-solid fa-rotate-left" style="color:var(--atl-sage);width:14px;"></i> Reopen Booking</button>` : ''}
                    ${s === 'CANCELLED' ? `<button type="button" class="atl-actions-dropdown-item bk-action-book-again" data-id="${row.id}"><i class="fa-solid fa-rotate-right" style="color:var(--atl-amber);width:14px;"></i> Book Again</button>` : ''}
                    <div class="atl-actions-dropdown-sep"></div>
                    ${disposition !== 'active'
                        ? `<button type="button" class="atl-actions-dropdown-item bk-action-disposition" data-id="${row.id}" data-disposition="active"><i class="fa-solid fa-rotate-left" style="color:var(--atl-sage);width:14px;"></i> Restore to Active</button>`
                        : `<button type="button" class="atl-actions-dropdown-item bk-action-disposition" data-id="${row.id}" data-disposition="not_a_fit"><i class="fa-solid fa-thumbs-down" style="color:var(--atl-amber-light);width:14px;"></i> Mark Not a Fit</button>
                           <button type="button" class="atl-actions-dropdown-item bk-action-disposition" data-id="${row.id}" data-disposition="archived"><i class="fa-solid fa-box-archive" style="color:var(--atl-muted);width:14px;"></i> Archive</button>`}
                    <div class="atl-actions-dropdown-sep"></div>
                    ${s!=='CANCELLED'?`<button type="button" class="atl-actions-dropdown-item atl-actions-dropdown-item--danger cancel-booking-btn" data-id="${row.id}"><i class="fa-solid fa-ban" style="width:14px;"></i> Cancel Booking</button>`:''}
                    ${(parseFloat(row.amount_paid || 0) > 0 || hasInvoice || row.quoted_at) ? 
                    `<button type="button" class="atl-actions-dropdown-item atl-actions-dropdown-item--danger" style="opacity:0.5; cursor:not-allowed;" title="Cannot delete a booking with financial or quotation records. Cancel it instead." disabled><i class="fa fa-trash" style="width:14px;"></i> Delete Booking</button>` :
                    `<button type="button" class="atl-actions-dropdown-item atl-actions-dropdown-item--danger delete-btn" data-type="bookings" data-id="${row.id}"><i class="fa fa-trash" style="width:14px;"></i> Delete Booking</button>`}
                  </div>
                </div>`;

                // quote_amount/total_amount can arrive as pre-formatted currency strings (e.g. "R 45,000.00")
                // on some legacy rows — strip everything but digits/./- before parsing, or the Fee column shows NaN.
                const feeRaw = row.quote_amount || row.total_amount;
                const feeParsed = feeRaw != null ? parseFloat(String(feeRaw).replace(/[^0-9.-]/g, '')) : NaN;
                const feeAmount = isFinite(feeParsed) ? feeParsed : null;

                // Compact table row (Pipeline + Archive) — mirrors atelier-deal-view-mockup.html's
                // reference table. The inline next-step hint, per-row action buttons, and tag badges
                // are all dropped from the visible row — the Deal View drawer's own header/action-bar
                // and Progress tab cover that now — but actionButtonsHtml is still rendered, just
                // hidden — toggleBookingDetail() clones it into the drawer, so every delegated
                // handler keeps working unchanged.
                rowsHtml += `
<tr class="atl-bk-row" data-id="${row.id}" tabindex="0">
  <td class="atl-bk-select-cell"><label class="bk-select-box" title="Select booking"><input type="checkbox" class="bk-select-cb" data-id="${row.id}" aria-label="Select booking #${row.id}"></label></td>
  <td class="atl-bk-ref">#${row.id}</td>
  <td>
    <div class="atl-bk-ev">${row.event_name || row.event_type || '—'}</div>
    <div class="atl-card-actions-bar" style="display:none;" aria-hidden="true">${actionButtonsHtml}</div>
  </td>
  <td class="atl-bk-client">${row.name}${row.company ? ` · ${row.company}` : ''}</td>
  <td class="atl-bk-date">${evDate || '—'}</td>
  <td class="atl-bk-status">
    <span class="atl-status-badge" style="background:${colors.tint}; color:${colors.color}; padding:4px 10px; border-radius:999px; font-weight:600; display:inline-flex; align-items:center; gap:6px;">
      <span class="atl-pill-dot" style="background:${colors.color}; width:7px; height:7px; border-radius:50%; display:inline-block;"></span>
      ${s === 'ACCEPTED' ? (acceptedStage === 'paid' ? 'Paid · Confirmed' : acceptedStage === 'invoiced' ? 'Invoiced' : 'Accepted') : (sLbl[s] || s)}
    </span>
    <span class="atl-payment-badge">${payLbl[ps] || ps}</span>
  </td>
  <td class="atl-bk-fee">${feeAmount ? 'R ' + feeAmount.toFixed(2) : '—'}</td>
</tr>`;
            }); // end forEach

            $container.html(`
                <div class="atl-bk-table-wrap">
                  <table class="atl-bk-table">
                    <thead>
                      <tr>
                        <th class="atl-bk-select-th"></th>
                        <th class="atl-bk-th-ref">Ref</th>
                        <th>Event</th>
                        <th>Client</th>
                        <th class="atl-bk-th-date">Date</th>
                        <th>Status</th>
                        <th class="r">Fee</th>
                      </tr>
                    </thead>
                    <tbody>${rowsHtml}</tbody>
                  </table>
                </div>
            `);

            // Click a row (or Enter/Space while focused) to open its Deal View
            $(document).off('click.bkrdet').on('click.bkrdet', '.atl-bk-row', function(e) {
                if ($(e.target).closest('label, input, a').length) return;
                const bookingId = $(this).data('id');
                window.toggleBookingDetail(bookingId);
            });
            $(document).off('keydown.bkrdet').on('keydown.bkrdet', '.atl-bk-row', function(e) {
                if (e.key !== 'Enter' && e.key !== ' ') return;
                if ($(e.target).closest('label, input, a').length) return;
                e.preventDefault();
                window.toggleBookingDetail($(this).data('id'));
            });

        } // end renderBookingsTable

// Filter Bookings Dropdown
        function bookingNeedsAction(b) {
            const s  = (b.status || 'PENDING').toUpperCase();
            const ps = (b.payment_status || 'UNPAID').toUpperCase();
            const today = new Date().toISOString().split('T')[0];
            return (
                s === 'NEW' ||
                (s === 'PENDING'   && !b.quote_amount) ||
                (s === 'QUOTED'    && !b.accepted_at) ||
                (s === 'ACCEPTED'  && (ps === 'UNPAID' || ps === 'FAILED')) ||
                (s === 'CONFIRMED' && ps !== 'PAID') ||
                (s === 'CONFIRMED' && (b.date || '') < today)
            );
        }

        // Bookings that have reached a final state live in the Archive tab (data-um-tab="bkPanelArchive")
        // instead — Pipeline never shows them, under any filter mode (status, payment, or Needs Action).
        const ARCHIVED_STATUSES = ['COMPLETED', 'EXPIRED', 'CANCELLED'];

        // ── Sort + pagination — shared by Pipeline and Archive, both of which already filter
        // client-side over the fully-cached allBookingsCache (same array the search box already
        // filters), so sorting/paging is pure in-memory slicing with no new API calls needed. ──
        const BK_PAGE_SIZE = 20;
        let bkCurrentPage = 1;
        let bkArchiveCurrentPage = 1;

        function bkFeeValue(b) {
            // quote_amount/total_amount can arrive as a pre-formatted currency string (e.g. "R 45,000.00")
            // on legacy rows — strip everything but digits/./- before parsing (same fix used elsewhere
            // in this file for the Fee column). A booking with no quote yet sorts as R0, which is
            // genuinely accurate and needs no special-casing on either sort direction.
            const raw = b.quote_amount || b.total_amount;
            const n = raw != null ? parseFloat(String(raw).replace(/[^0-9.-]/g, '')) : NaN;
            return isFinite(n) ? n : 0;
        }
        function bkEventDateValue(b) {
            return b.date ? new Date(b.date).getTime() : null;
        }
        function bkSortRows(rows, sortValue) {
            const sorted = rows.slice();
            if (sortValue === 'created_asc') {
                sorted.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
            } else if (sortValue === 'event_asc' || sortValue === 'event_desc') {
                // Bookings without an event date yet (fresh enquiries) always sort last, regardless
                // of direction — a soonest/latest sort would otherwise be meaningless for them.
                const dir = sortValue === 'event_asc' ? 1 : -1;
                sorted.sort((a, b) => {
                    const da = bkEventDateValue(a), db = bkEventDateValue(b);
                    if (da === null && db === null) return 0;
                    if (da === null) return 1;
                    if (db === null) return -1;
                    return (da - db) * dir;
                });
            } else if (sortValue === 'fee_desc') {
                sorted.sort((a, b) => bkFeeValue(b) - bkFeeValue(a));
            } else if (sortValue === 'fee_asc') {
                sorted.sort((a, b) => bkFeeValue(a) - bkFeeValue(b));
            } else {
                sorted.sort((a, b) => new Date(b.created_at) - new Date(a.created_at)); // created_desc (default)
            }
            return sorted;
        }
        // Slices `rows` to the given 1-indexed page (clamped to the valid range) and updates the
        // pagination bar's Prev/Next state + "Page X of Y" indicator. Returns the clamped page so
        // the caller can persist it back into its own currentPage variable (e.g. after a filter
        // change shrinks the result set below the page the admin was previously on).
        function bkPaginate(rows, page, barSel, prevSel, nextSel, indicatorSel) {
            const totalPages = Math.max(1, Math.ceil(rows.length / BK_PAGE_SIZE));
            const clampedPage = Math.min(Math.max(1, page), totalPages);
            const start = (clampedPage - 1) * BK_PAGE_SIZE;
            $(barSel).css('display', rows.length > BK_PAGE_SIZE ? 'flex' : 'none');
            $(indicatorSel).text('Page ' + clampedPage + ' of ' + totalPages);
            $(prevSel).prop('disabled', clampedPage <= 1);
            $(nextSel).prop('disabled', clampedPage >= totalPages);
            return { pageRows: rows.slice(start, start + BK_PAGE_SIZE), page: clampedPage };
        }

        function applyBookingFilter() {
            const status = $('#bookingStatusFilter').val();
            const q      = ($('#bkSearchInput').val() || '').trim().toLowerCase();
            const disposition = $('#bookingDispositionFilter').val() || 'active';
            const sort   = $('#bkSortSelect').val() || 'created_desc';
            const paymentFilters = ['PAID', 'DEPOSIT_PAID', 'PARTIALLY_PAID', 'UNPAID', 'FAILED'];
            let filtered = allBookingsCache.filter(b => !ARCHIVED_STATUSES.includes((b.status || '').toUpperCase()));
            // Triage (soft-decline): hides not_a_fit/archived leads from the pipeline view by
            // default — they were never a live deal — without touching `status`/ALLOWED_TRANSITIONS.
            if (disposition !== 'ALL') {
                filtered = filtered.filter(b => (b.disposition || 'active') === disposition);
            }
            if (status === 'NEEDS_ACTION') {
                filtered = filtered.filter(bookingNeedsAction);
            } else if (status && status !== 'All') {
                if (paymentFilters.includes(status)) {
                    filtered = filtered.filter(b => (b.payment_status || 'UNPAID').toUpperCase() === status);
                } else {
                    filtered = filtered.filter(b => (b.status || '').toUpperCase() === status.toUpperCase());
                }
            }
            if (q) {
                filtered = filtered.filter(b =>
                    (b.name  || '').toLowerCase().includes(q) ||
                    (b.email || '').toLowerCase().includes(q) ||
                    (b.event_name || '').toLowerCase().includes(q) ||
                    (b.event_location || '').toLowerCase().includes(q) ||
                    String(b.id).includes(q)
                );
            }
            filtered = bkSortRows(filtered, sort);
            const { pageRows, page } = bkPaginate(filtered, bkCurrentPage, '#bkPaginationBar', '#bkPagePrev', '#bkPageNext', '#bkPageIndicator');
            bkCurrentPage = page;
            const rangeStart = filtered.length ? (page - 1) * BK_PAGE_SIZE + 1 : 0;
            const rangeEnd = Math.min(page * BK_PAGE_SIZE, filtered.length);
            $('#bkResultCount').text(filtered.length
                ? (rangeStart + '–' + rangeEnd + ' of ' + filtered.length + ' booking' + (filtered.length !== 1 ? 's' : ''))
                : '0 bookings');
            renderBookingsTable(pageRows);
            if (typeof bkUpdateBulkCount === 'function') bkUpdateBulkCount(); // A3: keep bulk count in sync after re-render
        }

        $('#bookingStatusFilter').on('change', function() {
            bkCurrentPage = 1;
            applyBookingFilter();
            if (typeof window.updatePills === 'function') window.updatePills();
        });

        $('#bookingDispositionFilter').on('change', function() {
            bkCurrentPage = 1;
            applyBookingFilter();
        });

        $('#bkSortSelect').on('change', function() {
            bkCurrentPage = 1;
            applyBookingFilter();
        });

        $('#bkPagePrev').on('click', function() {
            bkCurrentPage = Math.max(1, bkCurrentPage - 1);
            applyBookingFilter();
        });
        $('#bkPageNext').on('click', function() {
            bkCurrentPage = bkCurrentPage + 1;
            applyBookingFilter();
        });

        // Live search
        $(document).on('input.bkrsearch', '#bkSearchInput', function() {
            bkCurrentPage = 1;
            applyBookingFilter();
        });

        // ── Archive tab (Completed / Expired / Cancelled) — mirrors applyBookingFilter() above,
        // reusing the same allBookingsCache and the same renderBookingsTable(), just targeting the
        // Archive panel's own container and pill/search controls instead of Pipeline's. ──
        let archiveStatus = 'All';
        function applyArchiveFilter() {
            const q = ($('#bkArchiveSearchInput').val() || '').trim().toLowerCase();
            const sort = $('#bkArchiveSortSelect').val() || 'created_desc';
            let filtered = (allBookingsCache || []).filter(b => ARCHIVED_STATUSES.includes((b.status || '').toUpperCase()));
            if (archiveStatus !== 'All') {
                filtered = filtered.filter(b => (b.status || '').toUpperCase() === archiveStatus);
            }
            if (q) {
                filtered = filtered.filter(b =>
                    (b.name  || '').toLowerCase().includes(q) ||
                    (b.email || '').toLowerCase().includes(q) ||
                    (b.event_name || '').toLowerCase().includes(q) ||
                    (b.event_location || '').toLowerCase().includes(q) ||
                    String(b.id).includes(q)
                );
            }
            $('#bkArchiveStat-All').text((allBookingsCache || []).filter(b => ARCHIVED_STATUSES.includes((b.status || '').toUpperCase())).length);

            filtered = bkSortRows(filtered, sort);
            const { pageRows, page } = bkPaginate(filtered, bkArchiveCurrentPage, '#bkArchivePaginationBar', '#bkArchivePagePrev', '#bkArchivePageNext', '#bkArchivePageIndicator');
            bkArchiveCurrentPage = page;
            const rangeStart = filtered.length ? (page - 1) * BK_PAGE_SIZE + 1 : 0;
            const rangeEnd = Math.min(page * BK_PAGE_SIZE, filtered.length);
            $('#bkArchiveResultCount').text(filtered.length
                ? (rangeStart + '–' + rangeEnd + ' of ' + filtered.length + ' booking' + (filtered.length !== 1 ? 's' : ''))
                : '0 bookings');

            renderBookingsTable(pageRows, '#bookingsArchiveListContainer');
            $('.bk-archive-pill').each(function() {
                const s = $(this).data('status');
                const isActive = s === archiveStatus;
                $(this).attr('aria-pressed', String(isActive));
                const colors = window.statusColors(s);
                if (isActive) {
                    $(this).css({ 'border-color': colors.color, 'background': colors.tint, 'color': colors.color });
                    $(this).find('.atl-pill-count').css('color', colors.color);
                } else {
                    $(this).css({ 'border-color': '', 'background': '', 'color': '' });
                    $(this).find('.atl-pill-count').css('color', '');
                }
            });
        }
        $(document).on('click', '.bk-archive-pill', function() {
            archiveStatus = $(this).data('status');
            $('#bkArchiveSearchInput').val('');
            bkArchiveCurrentPage = 1;
            applyArchiveFilter();
        });
        $(document).on('input.bkarchivesearch', '#bkArchiveSearchInput', function() {
            bkArchiveCurrentPage = 1;
            applyArchiveFilter();
        });
        $('#bkArchiveSortSelect').on('change', function() {
            bkArchiveCurrentPage = 1;
            applyArchiveFilter();
        });
        $('#bkArchivePagePrev').on('click', function() {
            bkArchiveCurrentPage = Math.max(1, bkArchiveCurrentPage - 1);
            applyArchiveFilter();
        });
        $('#bkArchivePageNext').on('click', function() {
            bkArchiveCurrentPage = bkArchiveCurrentPage + 1;
            applyArchiveFilter();
        });
        $(document).on('click', '[data-um-tab="bkPanelArchive"]', function() {
            if (typeof applyArchiveFilter === 'function') applyArchiveFilter();
        });

        // ── A3: bulk pipeline actions — select mode + CSV export + bulk cancel ─────
        // Client-side only: export builds a CSV from allBookingsCache; cancel loops the
        // existing PUT /api/admin/bookings/:id, so every transition + cascade + RBAC guard
        // the single-row path enforces is preserved.
        function bkSelectedIds() {
            return $('#bookingsListContainer .bk-select-cb:checked').map(function() { return $(this).data('id'); }).get();
        }
        function bkUpdateBulkCount() {
            var n = bkSelectedIds().length;
            $('#bkBulkCount').text(n);
            var shown = $('#bookingsListContainer .bk-select-cb').length;
            $('#bkSelectAll').prop('checked', shown > 0 && n === shown);
        }
        $('#bkSelectToggle').on('click', function() {
            var on = $('#bookingsListContainer').toggleClass('bk-select-mode').hasClass('bk-select-mode');
            $('#bkBulkBar').toggle(on);
            $(this).html(on ? '<i class="fa-solid fa-xmark" style="margin-right:5px;"></i>Done'
                            : '<i class="fa-solid fa-square-check" style="margin-right:5px;"></i>Select');
            if (!on) $('#bookingsListContainer .bk-select-cb, #bkSelectAll').prop('checked', false);
            bkUpdateBulkCount();
        });
        $(document).on('change', '.bk-select-cb', bkUpdateBulkCount);
        $(document).on('click', '.bk-select-box', function(e) { e.stopPropagation(); }); // don't trigger card expand
        $('#bkSelectAll').on('change', function() {
            $('#bookingsListContainer .bk-select-cb').prop('checked', $(this).is(':checked'));
            bkUpdateBulkCount();
        });
        $('#bkBulkExport').on('click', function() {
            var ids = bkSelectedIds();
            var rows = (allBookingsCache || []).filter(function(b) { return ids.indexOf(b.id) !== -1; });
            if (!rows.length) { window.notificationService && window.notificationService.showWarning('Nothing selected', 'Select one or more bookings to export.'); return; }
            var cols = ['id','name','company','email','cell','event_name','event_type','date','event_location','status','payment_status','total_amount','amount_paid','amount_outstanding','created_at'];
            var esc = function(v) { v = (v == null ? '' : String(v)); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
            var csv = cols.join(',') + '\n' + rows.map(function(r) { return cols.map(function(c) { return esc(r[c]); }).join(','); }).join('\n');
            var blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
            var a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = 'bookings-selected-' + new Date().toISOString().slice(0, 10) + '.csv';
            document.body.appendChild(a); a.click(); document.body.removeChild(a);
            setTimeout(function() { URL.revokeObjectURL(a.href); }, 1000);
        });
        $('#bkBulkCancel').on('click', async function() {
            var ids = bkSelectedIds();
            if (!ids.length) { window.notificationService && window.notificationService.showWarning('Nothing selected', 'Select one or more bookings to cancel.'); return; }
            var confirmed = window.notificationService ? await window.notificationService.showConfirm({
                title: 'Cancel ' + ids.length + ' booking' + (ids.length !== 1 ? 's' : '') + '?',
                message: 'This cancels each selected booking (voiding invoices, releasing holds, applying the refund policy) — exactly like cancelling them one by one. It cannot be undone.',
                confirmText: 'Cancel ' + ids.length,
                isDestructive: true
            }) : confirm('Cancel ' + ids.length + ' bookings?');
            if (!confirmed) return;
            var $btn = $(this); $btn.prop('disabled', true).html('<i class="fa fa-spinner fa-spin"></i> Cancelling…');
            var ok = 0, fail = 0;
            for (var i = 0; i < ids.length; i++) {
                try {
                    var res = await apiCall('/api/admin/bookings/' + ids[i], 'PUT', { status: 'CANCELLED', reason: 'Bulk cancelled by admin' });
                    if (res && res.success) ok++; else fail++;
                } catch (e) { fail++; }
            }
            $btn.prop('disabled', false).html('<i class="fa-solid fa-ban" style="margin-right:5px;"></i>Cancel selected');
            if (window.notificationService) {
                if (fail === 0) window.notificationService.showSuccess(ok + ' booking' + (ok !== 1 ? 's' : '') + ' cancelled.');
                else window.notificationService.showWarning('Partially done', ok + ' cancelled, ' + fail + ' skipped (invalid transition or error).');
            }
            if (typeof loadBookings === 'function') loadBookings();
        });
        // Bulk "Send reminder" — each selected booking gets the reminder appropriate to its state
        // (quote follow-up / contract signing / balance due); nothing-due bookings are skipped.
        $('#bkBulkRemind').on('click', async function() {
            var ids = bkSelectedIds();
            if (!ids.length) { window.notificationService && window.notificationService.showWarning('Nothing selected', 'Select one or more bookings to remind.'); return; }
            var $btn = $(this); $btn.prop('disabled', true).html('<i class="fa fa-spinner fa-spin"></i> Sending…');
            try {
                var res = await apiCall('/api/admin/bookings/bulk-remind', 'POST', { ids: ids });
                if (res && res.success) {
                    var b = res.breakdown || {};
                    var detail = res.sent + ' sent (' + (b.quote||0) + ' quote, ' + (b.contract||0) + ' contract, ' + (b.balance||0) + ' balance), ' + res.skipped + ' skipped' + (res.failed ? ', ' + res.failed + ' failed' : '');
                    if (res.failed) window.notificationService.showWarning('Reminders sent', detail);
                    else window.notificationService.showSuccess('Reminders sent', detail);
                } else {
                    window.notificationService.showError(res && res.message ? res.message : 'Could not send reminders.');
                }
            } catch (e) { window.notificationService.showError('Could not send reminders.'); }
            $btn.prop('disabled', false).html('<i class="fa-solid fa-bell" style="margin-right:5px;"></i>Send reminder');
        });

        // More dropdown — opens below by default, flips upward only when near viewport bottom
        $(document).on('click', '.bk-action-more', function(e) {
            e.stopPropagation();
            var $btn = $(this);
            var $dd  = $btn.closest('.bkr-more-menu').find('.bkr-more-dropdown');
            $('.bkr-more-dropdown').not($dd).hide();
            if ($dd.is(':visible')) { $dd.hide(); return; }

            var rect       = $btn[0].getBoundingClientRect();
            var ddH        = 300; // estimated max dropdown height
            var spaceBelow = window.innerHeight - rect.bottom;
            var openUp     = spaceBelow < ddH + 8;
            var alignRight = rect.left > window.innerWidth / 2;

            $dd.css({
                top:    openUp ? 'auto' : (rect.bottom + 5) + 'px',
                bottom: openUp ? (window.innerHeight - rect.top + 5) + 'px' : 'auto',
                left:   alignRight ? 'auto' : rect.left + 'px',
                right:  alignRight ? (window.innerWidth - rect.right) + 'px' : 'auto'
            }).show();
        });
        $(document).on('click', function(e) {
            if (!$(e.target).closest('.bkr-more-menu').length) $('.bkr-more-dropdown').hide();
        });
        $(document).on('click', '.bkr-more-item', function() { $('.bkr-more-dropdown').hide(); });

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
            const travelVal = booking.travel_accommodation;
            const isProvided = travelVal && travelVal !== 0 && travelVal !== 'Not required';
            const travelText = (!travelVal || travelVal === 0 || travelVal === 'Not required')
                ? 'Not required'
                : (travelVal === 1 || travelVal === true ? 'Provided' : travelVal);
            $('#bi-travel').text(travelText)
                .css('color', isProvided ? 'var(--atl-green)' : 'var(--atl-muted)')
                .css('font-weight', isProvided ? 'bold' : 'normal');

            // Venue notes
            let vnHtml = '';
            if (booking.venue_notes) vnHtml += '<div style="color:#aaa;margin-bottom:6px;"><strong style="color: var(--atl-ink-dim);">Venue Notes:</strong><br>' + booking.venue_notes + '</div>';
            if (booking.green_room_notes) vnHtml += '<div style="color:#aaa;margin-bottom:6px;"><strong style="color: var(--atl-ink-dim);">Green Room:</strong><br>' + booking.green_room_notes + '</div>';
            if (booking.venue_negotiated_rates) vnHtml += '<div style="color: var(--atl-amber);"><strong>Negotiated Rates:</strong><br>' + booking.venue_negotiated_rates + '</div>';
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

            openAtlDrawer('bookingInfoDrawer');
        });

        // ═══════════════════════════════════════════════
        // MODAL 2 — FINANCIAL CONTROLS  (.bk-action-financials)
        // ═══════════════════════════════════════════════
        $(document).on('click', '.bk-action-financials', function() {
            const bookingId = $(this).data('id');
            const booking = allBookingsCache.find(b => b.id == bookingId);
            if (!booking) return;

            // Store booking ID on drawer for sub-actions
            $('#bookingFinancialsDrawer').data('booking-id', bookingId);

            // Title
            $('#bf-modal-title').text('Booking #' + booking.id + ' — ' + (booking.name || ''));

            // Payment ledger
            const ps = (booking.payment_status || 'UNPAID').toUpperCase();
            const payColor = { PAID:'var(--atl-green)', PARTIALLY_PAID:'var(--atl-orange)', DEPOSIT_PAID:'var(--atl-blue)', UNPAID:'var(--atl-clay)', FAILED:'var(--atl-clay)' };
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
            $('#bf-pl-card').html('<i class="fa-solid fa-spinner fa-spin" style="color: var(--atl-muted);"></i> Loading P&L…');
            apiCall('/api/admin/bookings/' + bookingId + '/expenses', 'GET').then(d => {
                const gross = parseFloat(d.gross_revenue || 0);
                const exp = parseFloat(d.total_expenses || 0);
                const net = gross - exp;
                const netClr = net >= 0 ? 'var(--atl-green)' : 'var(--atl-clay)';
                let expRows = '';
                if (d.expenses && d.expenses.length) {
                    d.expenses.forEach(e => {
                        expRows += '<div style="display:flex;justify-content:space-between;font-size:11px;color:#bbb;margin-top:4px;">'
                            + '<span>' + (e.category || 'Misc') + ': ' + (e.description || '') + '</span>'
                            + '<span style="color:var(--atl-clay);">- R ' + parseFloat(e.amount || 0).toFixed(2) + '</span></div>';
                    });
                }
                $('#bf-pl-card').html(
                    '<div style="font-size:11px;color: var(--atl-muted);font-weight:700;text-transform:uppercase;letter-spacing:.5px;margin-bottom:8px;"><i class="fa-solid fa-chart-pie" style="margin-right:5px;color: var(--atl-amber);"></i>Profit & Loss</div>'
                    + '<div style="display:flex;justify-content:space-between;font-size:13px;margin-bottom:4px;"><span style="color: var(--atl-muted);">Revenue</span><span style="color:var(--atl-green);font-weight:700;">R ' + gross.toFixed(2) + '</span></div>'
                    + '<div style="display:flex;justify-content:space-between;font-size:13px;margin-bottom:4px;"><span style="color: var(--atl-muted);">Expenses</span><span style="color:var(--atl-clay);font-weight:700;">R ' + exp.toFixed(2) + '</span></div>'
                    + expRows
                    + '<div style="display:flex;justify-content:space-between;font-size:14px;padding-top:8px;border-top:1px solid rgba(212,175,55,.2);margin-top:8px;"><span style="color: var(--atl-amber);font-weight:700;">Net Profit</span><span style="color:' + netClr + ';font-weight:700;">R ' + net.toFixed(2) + '</span></div>'
                );
            }).catch(() => {
                $('#bf-pl-card').html('<div style="color:var(--atl-clay);font-size:12px;">Failed to load P&L data.</div>');
            });

            // Document links
            $('#bf-doc-links').html('<i class="fa-solid fa-spinner fa-spin" style="color:#555;"></i>');
            fetch('/api/admin/bookings/' + bookingId + '/financials').then(r => r.json()).then(fin => {
                let html = '';
                if (fin && fin.quote) {
                    html += '<div style="margin-bottom:5px;"><i class="fa-solid fa-paperclip" style="margin-right:5px;"></i>Quote: <a href="/api/admin/bookings/' + bookingId + '/quote/download" target="_blank" style="color: var(--atl-amber);">View Generated Quote</a></div>';
                }
                if (fin && fin.invoice) {
                    html += '<div style="margin-bottom:5px;"><i class="fa-solid fa-paperclip" style="margin-right:5px;"></i>Invoice: <a href="/api/admin/bookings/' + bookingId + '/invoice/download" target="_blank" style="color: var(--atl-amber);">View Generated Invoice</a></div>';
                }
                $('#bf-doc-links').html(html || '<div style="font-style:italic;color:#555;">No documents generated yet.</div>');
            }).catch(() => {
                $('#bf-doc-links').html('<div style="color:var(--atl-clay);">Failed to load documents.</div>');
            });

            // Wire up action buttons
            $('#bf-btn-quote').data('id', bookingId);
            $('#bf-btn-invoice').off('click.bfinv').on('click.bfinv', function() {
                const invoiceBtn = this;
                closeAtlDrawer('bookingFinancialsDrawer');
                setTimeout(() => { generateInvoice(bookingId, invoiceBtn); }, 400);
            });
            $('#bf-btn-expense').off('click.bfexp').on('click.bfexp', function() {
                openExpenseModal(bookingId);
            });

            openAtlDrawer('bookingFinancialsDrawer');
        });

        // When Generate Quote is clicked inside Financials drawer, hide it first
        $(document).on('click', '#bf-btn-quote', function() {
            closeAtlDrawer('bookingFinancialsDrawer');
        });

        // Generate Invoice CTA — delegates to window.generateInvoice (same as Financial Controls modal button)
        $(document).off('click.bkgeninv').on('click.bkgeninv', '.bk-action-gen-invoice', async function() {
            const bookingId = $(this).data('id');
            await window.generateInvoice(bookingId, this);
        });

        // Send / Resend Invoice CTA — delegates to window.sendInvoice via sendOrResendInvoiceFromCard; refreshes card on success
        $(document).off('click.bksendinv').on('click.bksendinv', '.bk-action-send-invoice', async function() {
            const invoiceId = $(this).data('invoice-id');
            if (invoiceId) {
                await window.sendOrResendInvoiceFromCard(invoiceId);
                await loadBookings();
            }
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
            $('#bookingEmailClientName').text(booking.name || 'Booking #' + bookingId);
            $('#be-to').text(booking.email || '');
            $('#be-subject').val('Re: Thabiso Mhlongo Booking - ' + (booking.event_type || ''));
            $('#be-template').val('');
            $('#be-alert').hide().text('');

            // Show drawer BEFORE initialising Quill — Quill must mount into a visible container
            // or the toolbar will be invisible and the editor will not render correctly.
            openAtlDrawer('bookingEmailDrawer');

            // Init Quill (only once) — container is now visible
            if (!beQuillInstance) {
                if (typeof Quill === 'undefined') {
                    $('#be-alert').css('color', 'var(--atl-clay)').text('Rich text editor failed to load. Please refresh the page and try again.').show();
                    return;
                }
                beQuillInstance = new Quill('#be-quill-container', {
                    theme: 'snow',
                    placeholder: 'Type your message here…',
                    modules: {
                        toolbar: [['bold', 'italic', 'underline'], ['link'], [{ list: 'ordered' }, { list: 'bullet' }], ['clean']]
                    }
                });
                var qlEditor = document.querySelector('#be-quill-container .ql-editor');
                if (qlEditor) { qlEditor.style.color = '#ddd'; }
            }
            if (beQuillInstance) beQuillInstance.setText('');
        });

        // S2-7: Hold the booking's event date from within the booking workflow
        $(document).on('click', '.bk-action-hold-date', async function() {
            const id   = $(this).data('id');
            const date = $(this).data('date');
            if (!date) {
                window.notificationService && window.notificationService.showWarning('No event date set for this booking.');
                return;
            }
            const confirmed = window.notificationService ? await window.notificationService.showConfirm({
                title: 'Create Date Hold',
                message: `Create a date hold for ${date}?\n\nThis will flag this date as held for Booking #${id}. You can manage holds in the Calendar Holds section.`
            }) : confirm(`Create a date hold for ${date}?\n\nThis will flag this date as held for Booking #${id}. You can manage holds in the Calendar Holds section.`);
            if (!confirmed) return;
            const $btn = $(this).prop('disabled', true);
            try {
                const result = await apiCall('/api/admin/calendar/hold', 'POST', {
                    date: date,
                    reason: 'Held for Booking #' + id,
                    block_type: 'booking_hold'
                });
                if (result.success) {
                    window.notificationService && window.notificationService.showSuccess('Date ' + date + ' held for Booking #' + id + '.');
                } else {
                    window.notificationService && window.notificationService.showError(result.message || 'Could not create hold — date may already be held.');
                }
            } catch(e) {
                window.notificationService && window.notificationService.showError('Failed to hold date.');
            }
            $btn.prop('disabled', false);
        });

        // Email template switcher for new modal
        $(document).on('change', '#be-template', function() {
            const tmpl = $(this).val();
            const booking = allBookingsCache.find(b => b.id == $('#be-booking-id').val());
            const clientName = booking ? (booking.name || '').split(' ')[0] || 'there' : 'there';
            let text = '';

            if (tmpl === 'pricing') {
                text = 'Hi ' + clientName + ',\n\nThank you for reaching out regarding Thabiso\'s availability for your event. Please find our standard rate card below:\n\n- Corporate Event (45 mins): R 35,000.00\n- Private Function (30 mins): R 20,000.00\n- Festival Appearance (15 mins): R 15,000.00\n*(Prices exclude VAT and travel/accommodation outside Gauteng)*\n\nPlease let us know if this aligns with your budget and we can proceed with a formal contract.\n\nBest Regards,\nThabiso Mhlongo Management';
            } else if (tmpl === 'available') {
                text = 'Hi ' + clientName + ',\n\nGreat news! Thabiso is available on your requested date. We would love to be part of your event.\n\nPlease reply to this email to confirm you would like to proceed with the booking, and we will draw up the invoice and contract.\n\nBest Regards,\nThabiso Mhlongo Management';
            } else if (tmpl === 'decline') {
                text = 'Hi ' + clientName + ',\n\nThank you for considering Thabiso for your upcoming event. Unfortunately, he is already booked or unavailable on that specific date.\n\nWe appreciate the inquiry and hope to work together in the future!\n\nBest Regards,\nThabiso Mhlongo Management';
            } else if (tmpl === 'call') {
                text = 'Hi ' + clientName + ',\n\nThank you for your inquiry. To best understand your event requirements and ensure Thabiso is the perfect fit, we would love to jump on a quick phone call.\n\nPlease let us know what time works best for you this week, or feel free to call our management number at +27 74 341 9681.\n\nBest Regards,\nThabiso Mhlongo Management';
            }
            if (beQuillInstance && text) {
                beQuillInstance.setText(text.replace(/\\n/g, '\n'));
            }
        });

        // Send email handler
        $(document).on('click', '#be-send-btn', async function() {
            const bookingId = $('#be-booking-id').val();
            const subject = $('#be-subject').val().trim();
            // Use root.innerHTML to preserve rich-text formatting; getText() for the empty check
            const messageHtml = beQuillInstance ? beQuillInstance.root.innerHTML : '';
            const messageText = beQuillInstance ? beQuillInstance.getText().trim() : '';
            const booking = allBookingsCache.find(b => b.id == bookingId);
            if (!booking) return;

            if (!subject || !messageText) {
                $('#be-alert').css('color', 'var(--atl-clay)').text('Subject and message are required.').show();
                return;
            }

            const $btn = $('#be-send-btn');
            const origHtml = $btn.html();
            $btn.prop('disabled', true).html('<i class="fa fa-spinner fa-spin"></i> Sending…');

            try {
                const res = await apiCall('/api/admin/bookings/' + bookingId + '/respond', 'POST', {
                    email: booking.email,
                    subject: subject,
                    message: messageHtml
                });
                if (res.error || !res.success) {
                    window.notificationService.showError(res.error || res.message || 'Failed to send email.');
                    $btn.prop('disabled', false).html(origHtml);
                } else {
                    window.notificationService.showSuccess('Email dispatched successfully.');
                    booking.status = 'Responded';
                    setTimeout(() => {
                        closeAtlDrawer('bookingEmailDrawer');
                        $('#bookingStatusFilter').trigger('change');
                        $btn.prop('disabled', false).html(origHtml);
                    }, 1500);
                }
            } catch (err) {
                window.notificationService.showError('Network error sending email.');
                $btn.prop('disabled', false).html(origHtml);
            }
        });


        // Generic Event Handlers for Table actions
        $(document).on('change', '.status-select', async function() {
            const type = $(this).data('type');
            const id = $(this).data('id');
            const newStatus = $(this).val();
            
            await apiCall('/api/admin/' + type + '/' + id, 'PUT', { status: newStatus });
            if (type === 'inquiries') loadInquiries();
            else if (type === 'bookings') loadBookings();
        });

        $(document).on('click', '.delete-btn', async function() {
            if(!(await window.notificationService.showConfirm({ message: "Are you sure you want to permanently delete this record?", isDestructive: true }))) return;
            const $row = $(this).closest('tr, .atl-booking-card');
            const type = $(this).data('type');
            const id = $(this).data('id');
            
            if ($row.length) $row.css('opacity', '0.5'); // Instant UX Feedback
            
            try {
                const res = await apiCall('/api/admin/' + type + '/' + id, 'DELETE');
                if (res && res.success) {
                     if ($row.length) $row.remove(); // Force instant visual clear
                }
            } catch (err) {
                if ($row.length) $row.css('opacity', '1');
            } finally {
                if (type === 'inquiries') loadInquiries();
                else if (type === 'bookings') loadBookings();
            }
        });
