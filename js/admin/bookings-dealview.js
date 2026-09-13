/* Phase 6 (HOUSEKEEPING-NOTES.md "Section 21 / Bookings sub-batch 5: Deal View"):
 * relocated VERBATIM from the MIDDLE of admin.html’s foundational inline <script> (was lines
 * ~11291-12284) — the Deal View drawer’s own rendering logic: the inline Contract panel
 * (renderInlineContractPanel/ctbField/ctbCollectClauses/buildContractEditorPanel), the inline
 * Cancellation panel, the Timeline & Notes tab data loader, the Advancing-pack panel, Deal View’s
 * own tab system (dvActivateTab — richer than the generic atlActivateDrawerTab: lazy panel
 * loading + arrow-key roving tabindex), toggleBookingDetail (open/populate the drawer from a
 * cached row), dvRenderFromRow, refreshDealView, and the Google-Places venue autocomplete.
 *
 * This foundational script (admin.html ~10946-12317, NOT wrapped in any IIFE) is otherwise left
 * untouched: `// --- Admin Panel Global Helpers ---` (qs/qsa/escHtml), the shared "Last Updated By"
 * meta-footer registry (renderMetaFooterHtml/showMetaFooter/_metaFooterOverrides/applyLastUpdatedMeta),
 * `// --- Atelier Redesign Helpers ---` (statusColors/updatePills/initThemeToggleUI), and
 * uploadFileToServer all stay exactly where they were — confirmed by grep that none of them are
 * redefined in this file, and that this file only READS them (all inside deferred contexts: event
 * handler bodies, or a synchronous-but-safe registration `_metaFooterOverrides['dealViewDrawer'] =
 * ...` which only needs the registry OBJECT to already exist — it does, initialised earlier in the
 * same, now-reunited script, which still executes first).
 *
 * <script src> for this file is placed right after that foundational script’s (reunited) </script>
 * closes, guaranteeing qs/qsa/escHtml/_metaFooterOverrides/statusColors/updatePills have already
 * run by the time this file evaluates.
 *
 * Cross-file dependency confirmed safe (grepped, not assumed): dealViewLoadedIds/
 * dealViewTimelineLoaded/dealViewAdvancingLoaded are reset by `loadBookings()` (admin.html’s big
 * Bookings script, ~13218-13220) via a `typeof x !== 'undefined'` guard — loadBookings() only runs
 * on-demand (never at script-eval time), so by the time it’s ever called every script has loaded.
 * `window.toggleBookingDetail` is called from a `jQuery.fn.collapse` override further up in this
 * same foundational script (admin.html ~11181/11183, kept in place) — also deferred (fires only
 * when something later calls `.collapse('show'|'hide')`), and from the already-extracted
 * bookings-actions.js / a setTimeout elsewhere in admin.html — all deferred, all safe regardless
 * of load order. `allBookingsCache`/`loadBookings`/`applyBookingFilter` (admin.html’s big Bookings
 * script), `openAtlDrawer`/`closeAtlDrawer` (components/drawer.js), and `window.notificationService`
 * are used, not moved. */
        // Contracts are only legal once the client has accepted the quote (server enforces this
        // in generateContract/send/upload — see CONTRACT_ELIGIBLE_STATUSES in server.js). Mirrored
        // here so the button itself doesn't invite a doomed click on a NEW/QUOTED booking, and so a
        // booking that got reset to QUOTED by a re-quote (see reQuotingCommitted) doesn't keep
        // showing "Send to Client" for the leftover draft contract it just invalidated.
        var CONTRACT_ELIGIBLE_STATUSES = ['ACCEPTED', 'CONFIRMED', 'COMPLETED'];
        function renderInlineContractPanel(id, c) {
            var $panel = $('#atl-contract-' + id);
            if (!$panel.length) return;
            var driftBk = (typeof allBookingsCache !== 'undefined') ? allBookingsCache.find(function(b){ return b.id == id; }) : null;
            var bkStatus = driftBk ? String(driftBk.status || '').toUpperCase() : null;
            // If the booking isn't cached (shouldn't normally happen — the Deal View always loads it
            // first), don't block on missing info; the server still enforces this either way.
            var isEligible = !bkStatus || CONTRACT_ELIGIBLE_STATUSES.indexOf(bkStatus) !== -1;
            var notEligibleNote = '<p class="atl-det-empty" style="font-size:12px;"><i class="fa-solid fa-circle-info" style="margin-right:4px;"></i>The client needs to accept the quote before a contract can be built or sent.</p>';
            var genBtn = function(label) {
                return '<button type="button" class="atl-btn atl-btn--ghost bk-gen-contract" data-id="' + id + '">'
                    + '<i class="fa-solid fa-file-circle-plus" style="margin-right:6px;"></i>' + label + '</button>';
            };
            var sendBtn = function(label) {
                return '<button type="button" class="atl-btn atl-btn--ghost bk-send-contract-inline" data-id="' + id + '">'
                    + '<i class="fa-solid fa-paper-plane" style="margin-right:6px;"></i>' + label + '</button>';
            };
            if (!c || c.error) {
                var emptyActions = isEligible
                    ? ('<div class="atl-doc-actions-row" style="margin-top:10px;">' + genBtn('Build Contract') + '</div>')
                    : notEligibleNote;
                $panel.html('<h5 class="atl-det-title">Contract</h5><p class="atl-det-empty">No contract on file.</p>' + emptyActions);
                return;
            }
            var states = {
                draft:  { color: 'var(--atl-muted)',  label: 'Draft' },
                sent:   { color: 'var(--atl-amber)',  label: 'Sent to client' },
                signed: { color: 'var(--atl-sage)',   label: 'Signed ✓' }
            };
            var st = states[c.status] || states.draft;
            var html = '<h5 class="atl-det-title">Contract</h5>';
            html += '<p style="font-size:13px;margin:0 0 6px;">Status: <strong style="color:' + st.color + '">' + st.label + '</strong></p>';
            // Amount-drift warning: the contract's snapshotted amount vs the booking's current total.
            // A mismatch means the quote changed (e.g. a re-quote) after this contract was generated —
            // regenerate so the contract reflects the current figure before sending/signing.
            var driftBk = (typeof allBookingsCache !== 'undefined') ? allBookingsCache.find(function(b){ return b.id == id; }) : null;
            if (driftBk && c.contract_amount != null) {
                var bkTotal = parseFloat(driftBk.total_amount) || parseFloat(String(driftBk.quote_amount||'').replace(/[^0-9.-]/g,'')) || 0;
                var conAmt = parseFloat(c.contract_amount) || 0;
                if (bkTotal > 0 && Math.abs(bkTotal - conAmt) > 0.01) {
                    html += '<div class="atl-callout" style="border-color:var(--atl-amber);color:var(--atl-amber);margin:0 0 8px;">'
                        + '<i class="fa-solid fa-triangle-exclamation"></i>'
                        + '<span>This contract was generated for <strong>R ' + conAmt.toFixed(2) + '</strong> but the booking total is now <strong>R ' + bkTotal.toFixed(2) + '</strong>. Regenerate the contract so it reflects the current amount' + (c.source_quote_number ? ' (was per quote ' + c.source_quote_number + ')' : '') + '.</span></div>';
                }
            }
            if (c.pdf_url) {
                var href = '/api/admin/bookings/' + id + '/contract/download';
                html += '<p style="font-size:12px;color:var(--atl-muted);margin:0 0 6px;">'
                    + '<i class="fa-solid fa-file-pdf" style="color:var(--atl-clay);margin-right:6px;"></i>'
                    + '<a href="' + href + '" target="_blank" rel="noopener" class="atl-det-link">'
                    + (c.pdf_url.split('/').pop() || 'contract.pdf') + '</a></p>';
            }
            if (c.signed_by) {
                html += '<p style="font-size:12px;color:var(--atl-muted);margin:0 0 4px;">Signed by <strong style="color:var(--atl-ink)">'
                    + c.signed_by + '</strong>'
                    + (c.signed_date ? ' on ' + new Date(c.signed_date).toLocaleDateString('en-ZA') : '') + '</p>';
            }
            // Countersign re-hashes the PDF and compares it to the hash captured when the client
            // signed (see PUT /contract/sign in server.js). integrity_verified is NULL when there was
            // nothing to compare against (e.g. a forced countersign before the client signed).
            if (c.integrity_verified === 1) {
                html += '<p style="font-size:11px;color:var(--atl-sage);margin:0 0 4px;"><i class="fa-solid fa-shield-halved" style="margin-right:4px;"></i>Document integrity verified — unchanged since the client signed.</p>';
            } else if (c.integrity_verified === 0) {
                html += '<div class="atl-callout" style="border-color:var(--atl-clay);color:var(--atl-clay);margin:0 0 8px;"><i class="fa-solid fa-triangle-exclamation"></i><span>Integrity check FAILED — this PDF changed after the client signed it. Investigate before relying on this contract.</span></div>';
            }
            if (c.uploaded_by) {
                html += '<p style="font-size:11px;color:var(--atl-muted);margin:0;">' + (c.uploaded_by === 'system' ? 'Auto-generated' : 'Uploaded by ' + c.uploaded_by) + '</p>';
            }
            // Build/edit — hidden once the contract is signed & frozen, or once the booking is no
            // longer in an accepted-or-later status (e.g. a re-quote just reset this contract to
            // draft and rolled the booking back to QUOTED).
            if (c.status !== 'signed' && c.is_frozen !== 1) {
                if (isEligible) {
                    var contractActions = genBtn(c.pdf_url ? 'Edit & Regenerate' : 'Build Contract');
                    // Send-to-client is the delivery step; needs a PDF to attach, offered while unsigned.
                    if (c.pdf_url) contractActions += sendBtn(c.status === 'draft' ? 'Send to Client' : 'Re-send to Client');
                    html += '<div class="atl-doc-actions-row" style="margin-top:10px;">' + contractActions + '</div>';
                } else {
                    html += notEligibleNote;
                }
            }
            $panel.html(html);
        }

        // A labelled clause textarea bound to POST /contract/generate + /preview via data-field —
        // collected by ctbCollectClauses() (mirrors advField()/advCollectFields() for Advancing).
        function ctbField(field, label, value, rows) {
            const safe = value ? String(value).replace(/</g, '&lt;').replace(/>/g, '&gt;') : '';
            return '<div style="margin-bottom:10px;"><label class="atl-panel-label" style="margin-bottom:4px;display:block;">' + label + '</label>'
                 + '<textarea class="atl-textarea ctb-field" data-field="' + field + '" rows="' + (rows || 3) + '" style="width:100%;">' + safe + '</textarea></div>';
        }

        function ctbCollectClauses(bookingId) {
            const clauses = {};
            $('.ctb-editor[data-booking-id="' + bookingId + '"] .ctb-field').each(function() {
                clauses[$(this).data('field')] = $(this).val();
            });
            return clauses;
        }

        // Contract Builder editor — clause-by-clause form pre-filled from GET /contract/builder-data.
        // Parties/Performance/Fee are read-only display (they're facts sourced from the booking/quote —
        // editing them belongs on those records, not the contract). Payment Terms/Cancellation/Force
        // Majeure/Travel & Hospitality/Rights & Recording/Additional Clauses are editable free text.
        function buildContractEditorPanel(data, bookingId) {
            const b = data.booking || {};
            const artist = data.artist || {};
            const fee = data.fee || {};
            const c = data.clauses || {};
            const money = function(n) { return 'R ' + (parseFloat(n) || 0).toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); };
            return `
      <div class="atl-det-col ctb-editor" data-booking-id="${bookingId}">
        <div class="atl-det-card">
          <h5 class="atl-det-title"><i class="fa-solid fa-users"></i>Parties</h5>
          <p class="atl-sub">Artist: ${artist.name || '—'} (${artist.email || '—'})</p>
          <p class="atl-sub">Client: ${b.name || '—'}${b.company ? ' / ' + b.company : ''} (${b.email || '—'}${b.cell ? ' · ' + b.cell : ''})</p>
          ${b.vat_number ? `<p class="atl-sub">Client VAT No: ${b.vat_number}</p>` : ''}
          <div class="atl-callout"><i class="fa-solid fa-circle-info"></i>Sourced from the booking &amp; client record — edit there, not here.</div>
        </div>

        <div class="atl-det-card">
          <h5 class="atl-det-title"><i class="fa-solid fa-calendar-day"></i>Performance Details</h5>
          <p class="atl-sub">${b.event_name || b.event_type || '—'}${b.event_type ? ' · ' + b.event_type : ''}</p>
          <p class="atl-sub">${b.date || 'TBC'} · ${b.event_location || 'TBC'}</p>
        </div>

        <div class="atl-det-card">
          <h5 class="atl-det-title"><i class="fa-solid fa-file-invoice-dollar"></i>Fee &amp; Payment</h5>
          <p class="atl-sub">Total fee: <strong>${money(fee.total)}${fee.applyVat ? ' (VAT incl.)' : ''}</strong></p>
          ${!fee.total ? '<div class="atl-callout"><i class="fa-solid fa-circle-info"></i>No accepted quote found — the contract will still generate with a placeholder fee line.</div>' : ''}
          ${ctbField('paymentTerms', 'Payment Terms', c.paymentTerms, 3)}
        </div>

        <div class="atl-det-card">
          <h5 class="atl-det-title"><i class="fa-solid fa-ban"></i>Cancellation</h5>
          ${ctbField('cancellation', 'Cancellation Policy', c.cancellation, 4)}
        </div>

        <div class="atl-det-card">
          <h5 class="atl-det-title"><i class="fa-solid fa-cloud-bolt"></i>Force Majeure</h5>
          ${ctbField('forceMajeure', 'Force Majeure Clause', c.forceMajeure, 4)}
        </div>

        <div class="atl-det-card">
          <h5 class="atl-det-title"><i class="fa-solid fa-plane"></i>Travel &amp; Hospitality</h5>
          ${ctbField('travelHospitality', 'Travel & Hospitality Terms (optional)', c.travelHospitality, 3)}
        </div>

        <div class="atl-det-card">
          <h5 class="atl-det-title"><i class="fa-solid fa-video"></i>Rights &amp; Recording</h5>
          ${ctbField('rightsRecording', 'Rights & Recording Terms (optional)', c.rightsRecording, 3)}
        </div>

        <div class="atl-det-card">
          <h5 class="atl-det-title"><i class="fa-solid fa-plus"></i>Additional Clauses</h5>
          ${ctbField('additionalClauses', 'Additional Clauses (optional)', c.additionalClauses, 3)}
        </div>

        <div class="atl-det-card">
          <h5 class="atl-det-title"><i class="fa-solid fa-signature"></i>E-Sign Settings</h5>
          <p class="atl-sub">Template: Standard Agreement</p>
          <p class="atl-sub">Once sent, ${b.email || 'the client'} will receive a signing link by email — no separate settings needed here.</p>
        </div>

        <div class="atl-det-card" id="ctb-preview-card-${bookingId}" style="display:none;">
          <h5 class="atl-det-title"><i class="fa-solid fa-eye"></i>Preview</h5>
          <iframe class="ctb-preview-frame" style="width:100%;height:420px;border:1px solid var(--atl-border);border-radius:6px;background:#fff;"></iframe>
        </div>

        <div class="atl-det-card">
          <div class="atl-doc-actions-row">
            <button type="button" class="atl-btn ctb-preview-btn" data-id="${bookingId}"><i class="fa-solid fa-eye" style="margin-right:6px;"></i>Preview</button>
            <button type="button" class="atl-btn atl-btn--primary ctb-generate-btn" data-id="${bookingId}"><i class="fa-solid fa-file-circle-plus" style="margin-right:6px;"></i>Generate &amp; Save</button>
            <button type="button" class="atl-btn atl-btn--ghost ctb-cancel-btn" data-id="${bookingId}">Cancel</button>
          </div>
        </div>
      </div>`;
        }

        // Opens the Contract Builder editor inline, replacing the status card. Fetches fresh every
        // time (contract edits are infrequent enough that a cache isn't worth the complexity).
        $(document).on('click', '.bk-gen-contract', async function() {
            var id = $(this).data('id');
            var $panel = $('#atl-contract-' + id);
            $panel.html('<h5 class="atl-det-title">Contract</h5><div class="atl-det-loading"><span class="atl-spinner"></span><span>Loading contract builder…</span></div>');
            try {
                var res = await apiCall('/api/admin/bookings/' + id + '/contract/builder-data', 'GET');
                if (res && res.success) {
                    if (res.locked) {
                        if (window.notificationService) window.notificationService.showError('This contract has already been signed and cannot be edited.');
                        var lockedFresh = await fetch('/api/admin/bookings/' + id + '/contract', { credentials: 'same-origin' }).then(function(r){ return r.json(); }).catch(function(){ return null; });
                        renderInlineContractPanel(id, lockedFresh && lockedFresh.contract);
                        return;
                    }
                    $panel.html('<h5 class="atl-det-title">Contract</h5>' + buildContractEditorPanel(res, id));
                } else if (window.notificationService) {
                    window.notificationService.showError((res && res.message) || 'Could not load the contract builder.');
                }
            } catch (e) {
                console.error('Error loading contract builder:', e);
                if (window.notificationService) window.notificationService.showError((e && e.message) || 'Could not load the contract builder.');
            }
        });

        // Emails the current draft PDF to the client for online signing (advances draft -> sent).
        // Same route/behavior as the legacy #contractDrawer's Send button — just reachable from the
        // Deal View now too, so both surfaces share one source of truth (GET /contract) after acting.
        $(document).on('click', '.bk-send-contract-inline', async function() {
            var id = $(this).data('id');
            var $btn = $(this), orig = $btn.html();
            $btn.prop('disabled', true).html('<i class="fa fa-spinner fa-spin"></i> Sending…');
            try {
                var res = await apiCall('/api/admin/bookings/' + id + '/contract/send', 'POST', {});
                if (res && res.success) {
                    if (window.notificationService) window.notificationService.showSuccess('Contract sent — the client can now review and sign it online.');
                    var fresh = await fetch('/api/admin/bookings/' + id + '/contract', { credentials: 'same-origin' }).then(function(r){ return r.json(); }).catch(function(){ return null; });
                    renderInlineContractPanel(id, fresh && fresh.contract);
                    // Keep the legacy standalone drawer in sync too, if it happens to be open on the same booking.
                    if ($('#contractBookingId').val() == id && typeof renderContractStatus === 'function') {
                        renderContractStatus(fresh && fresh.contract);
                    }
                } else {
                    $btn.prop('disabled', false).html(orig);
                    if (window.notificationService) window.notificationService.showError((res && res.message) || 'Could not send the contract.');
                }
            } catch (e) {
                $btn.prop('disabled', false).html(orig);
                if (window.notificationService) window.notificationService.showError((e && e.message) || 'Could not send the contract.');
            }
        });

        $(document).on('click', '.ctb-cancel-btn', async function() {
            var id = $(this).data('id');
            var fresh = await fetch('/api/admin/bookings/' + id + '/contract', { credentials: 'same-origin' }).then(function(r){ return r.json(); }).catch(function(){ return null; });
            renderInlineContractPanel(id, fresh && fresh.contract);
        });

        $(document).on('click', '.ctb-preview-btn', async function() {
            var id = $(this).data('id');
            var $btn = $(this), orig = $btn.html();
            $btn.prop('disabled', true).html('<i class="fa fa-spinner fa-spin"></i> Rendering…');
            try {
                var res = await apiCall('/api/admin/bookings/' + id + '/contract/preview', 'POST', { clauses: ctbCollectClauses(id) });
                if (res && res.success) {
                    $('#ctb-preview-card-' + id).show().find('.ctb-preview-frame').attr('srcdoc', res.content_html);
                } else if (window.notificationService) {
                    window.notificationService.showError((res && res.message) || 'Could not render preview.');
                }
            } catch (e) {
                console.error('Error rendering contract preview:', e);
                if (window.notificationService) window.notificationService.showError((e && e.message) || 'Could not render preview.');
            } finally {
                $btn.prop('disabled', false).html(orig);
            }
        });

        $(document).on('click', '.ctb-generate-btn', async function() {
            var id = $(this).data('id');
            var $btn = $(this), orig = $btn.html();
            $btn.prop('disabled', true).html('<i class="fa fa-spinner fa-spin"></i> Generating…');
            try {
                var res = await apiCall('/api/admin/bookings/' + id + '/contract/generate', 'POST', { clauses: ctbCollectClauses(id) });
                if (res && res.success) {
                    if (window.notificationService) window.notificationService.showSuccess('Contract generated as a draft.');
                    var fresh = await fetch('/api/admin/bookings/' + id + '/contract', { credentials: 'same-origin' }).then(function(r){ return r.json(); }).catch(function(){ return null; });
                    renderInlineContractPanel(id, fresh && fresh.contract);
                } else {
                    $btn.prop('disabled', false).html(orig);
                    if (window.notificationService) window.notificationService.showError((res && res.message) || 'Could not generate the contract.');
                }
            } catch (e) {
                $btn.prop('disabled', false).html(orig);
                if (window.notificationService) window.notificationService.showError((e && e.message) || 'Could not generate the contract.');
            }
        });

        function renderInlineCancellationPanel(id, d) {
            var $panel = $('#atl-cancel-' + id);
            if (!$panel.length) return;
            var c = d.cancellation;
            if (!c) { $panel.remove(); return; }
            var html = '<h5 class="atl-det-title">Cancellation</h5>';
            if (c.reason) html += '<p style="font-size:13px;color:var(--atl-ink);margin:0 0 6px;">' + c.reason + '</p>';
            html += '<p style="font-size:12px;color:var(--atl-muted);margin:0 0 4px;">';
            if (c.cancelled_by) html += 'By <strong style="color:var(--atl-ink)">' + c.cancelled_by + '</strong>';
            if (c.refund_amount > 0) html += ' · Refund R ' + parseFloat(c.refund_amount).toFixed(2);
            html += '</p>';
            if (c.notes) html += '<p style="font-size:12px;color:var(--atl-muted);margin:0;font-style:italic;">' + c.notes + '</p>';
            $panel.html(html);
        }

        // Once-only guards, keyed per booking id — mirror the old per-row $region.data('loaded'),
        // but keyed on id instead of a DOM node since the drawer's panels are now rebuilt per open.
        let dealViewLoadedIds = {};
        let dealViewTimelineLoaded = {};
        let dealViewAdvancingLoaded = {};
        let dealViewTriggerBookingId = null;

        function loadDealViewTimelineData(bookingId) {
            fetch('/api/admin/bookings/' + bookingId + '/notes', { credentials: 'same-origin' })
                .then(r => r.json())
                .then(d => {
                    if (d.success && d.notes) {
                        renderNotesThread(bookingId, d.notes);
                        $(`#notes-thread-${bookingId}`).show();
                    }
                }).catch(function(err) {
                    console.error('Error loading notes:', err);
                    if (window.notificationService) window.notificationService.showError('Could not load notes for this booking.');
                });

            fetch('/api/admin/bookings/' + bookingId + '/communications', { credentials: 'same-origin' })
                .then(r => r.json())
                .then(function(d) { renderCommsThread(bookingId, d.logs); })
                .catch(function(err) {
                    console.error('Error loading communications:', err);
                    if (window.notificationService) window.notificationService.showError('Could not load email history for this booking.');
                });
        }

        // Advancing tab is rebuilt wholesale from a fresh GET after every save/CRUD action —
        // simplest way to stay in sync with server-assigned ids and re-derived status/timestamps.
        function advReloadPanel(bookingId) {
            fetch('/api/admin/bookings/' + bookingId + '/advancing', { credentials: 'same-origin' })
                .then(function(r) { return r.json(); })
                .then(function(d) {
                    if (d.success) {
                        $('#dv-panel-advancing').html(buildAdvancingPanel(d, bookingId));
                        // Files tab has its own dedicated slot for this so it never races with, or
                        // overwrites, the Quote/Contract/Invoice chips the main lazy-load populates.
                        var $advFiles = $('#atl-filedocs-advancing-' + bookingId);
                        if ($advFiles.length) {
                            var packStatusLbl = { draft: 'Draft', sent: 'Sent', confirmed: 'Confirmed' }[d.pack && d.pack.status] || 'Draft';
                            $advFiles.html(d.pack && d.pack.pdf_url
                                ? '<div class="dv-filegrid"><a class="dv-file" href="/api/admin/bookings/' + bookingId + '/advancing/download" target="_blank" rel="noopener"><span class="ico" style="background:rgba(212,175,55,0.14);color:var(--atl-amber);"><i class="fa-solid fa-clipboard-list"></i></span><span><span class="fn">Advancing Pack</span><span class="fm">' + packStatusLbl + '</span></span></a></div>'
                                : '<p class="atl-det-empty">No advancing pack generated yet.</p>');
                        }
                    } else if (window.notificationService) window.notificationService.showError(d.message || 'Could not load the advancing pack.');
                })
                .catch(function(err) {
                    console.error('Error loading advancing pack:', err);
                    if (window.notificationService) window.notificationService.showError('Could not load the advancing pack.');
                });
        }
        function loadDealViewAdvancingData(bookingId) { advReloadPanel(bookingId); }

        // Collects every .adv-field (Technical/Hospitality/Travel/Notes) for the Save Draft button —
        // scoped to this booking's panel via the data-booking-id wrapper, not a global selector.
        function advCollectFields(bookingId) {
            const fields = {};
            $(`.atl-det-col[data-booking-id="${bookingId}"] .adv-field`).each(function() {
                fields[$(this).data('field')] = $(this).val();
            });
            return fields;
        }

        // ARIA tabs controller for the Deal View drawer (mirrors the .cal-sidebar-tab pattern).
        // Deliberately NOT named switchTab — that name is already the admin-section navigator.
        function dvActivateTab(tabEl, moveFocus) {
            if (!tabEl) return;
            var tabs = Array.prototype.slice.call(document.querySelectorAll('#dvTabs .dv-tab'));
            tabs.forEach(function(t) {
                var on = t === tabEl;
                t.setAttribute('aria-selected', on ? 'true' : 'false');
                t.setAttribute('tabindex', on ? '0' : '-1');
                var panel = document.getElementById(t.getAttribute('aria-controls'));
                if (panel) panel.hidden = !on;
            });
            if (moveFocus !== false) tabEl.focus();
            $('#dealViewDrawer .atl-drawer__body').scrollTop(0);

            if (tabEl.id === 'dv-tab-timeline') {
                var bookingId = $('#dealViewDrawer').data('bookingId');
                if (bookingId && !dealViewTimelineLoaded[bookingId]) {
                    dealViewTimelineLoaded[bookingId] = true;
                    loadDealViewTimelineData(bookingId);
                }
            }
            if (tabEl.id === 'dv-tab-advancing') {
                var advBookingId = $('#dealViewDrawer').data('bookingId');
                if (advBookingId && !dealViewAdvancingLoaded[advBookingId]) {
                    var advRow = allBookingsCache.find(function(b) { return b.id == advBookingId; });
                    var advStatus = advRow ? (advRow.status || '').toUpperCase() : '';
                    if (advStatus === 'CONFIRMED' || advStatus === 'COMPLETED') {
                        dealViewAdvancingLoaded[advBookingId] = true;
                        loadDealViewAdvancingData(advBookingId);
                    }
                }
            }
        }
        $(document).off('click.dvtab').on('click.dvtab', '#dvTabs .dv-tab', function() {
            dvActivateTab(this, false);
        });

        // "Last Updated By" — Deal View covers many tabs, each backed by a different record/table
        // (Overview -> bookings, Offer & Contract -> quotations/contracts, Invoices -> invoices,
        // etc.), so per the per-tab scoping decision the footer must land inside whichever tab panel
        // is currently visible, not the drawer's single shared footer bar. Registered once here;
        // applyLastUpdatedMeta (admin.html global helpers) looks this up by the open drawer's id.
        window._metaFooterOverrides['dealViewDrawer'] = function(meta) {
            var activePanel = document.querySelector('#dealViewDrawer .dv-panel:not([hidden])');
            if (activePanel) window.showMetaFooter(activePanel, meta);
        };
        $(document).off('keydown.dvtab').on('keydown.dvtab', '#dvTabs .dv-tab', function(e) {
            var tabs = Array.prototype.slice.call(document.querySelectorAll('#dvTabs .dv-tab'));
            var i = tabs.indexOf(this);
            var idx = null;
            if (e.key === 'ArrowRight') idx = (i + 1) % tabs.length;
            else if (e.key === 'ArrowLeft') idx = (i - 1 + tabs.length) % tabs.length;
            else if (e.key === 'Home') idx = 0;
            else if (e.key === 'End') idx = tabs.length - 1;
            if (idx !== null) { e.preventDefault(); dvActivateTab(tabs[idx]); }
        });
        // Return focus to the triggering row when the Deal View drawer closes (any close path —
        // overlay click, close button, or the global Esc handler already wired to .atl-drawer--open).
        document.addEventListener('atl:drawerClosed', function(e) {
            if (!e.detail || e.detail.id !== 'dealViewDrawer' || !dealViewTriggerBookingId) return;
            var $row = $(`.atl-bk-row[data-id="${dealViewTriggerBookingId}"]`);
            if ($row.length) { $row.attr('tabindex', '-1').trigger('focus'); }
            dealViewTriggerBookingId = null;
        });

        // ═══ Advancing Pack — actions bar ═══
        $(document).on('click', '.adv-save-btn', async function() {
            const id = $(this).data('id');
            try {
                const res = await apiCall('/api/admin/bookings/' + id + '/advancing', 'PUT', advCollectFields(id));
                if (res && res.success) { if (window.notificationService) window.notificationService.showSuccess('Advancing pack saved.'); }
                else if (window.notificationService) window.notificationService.showError((res && res.message) || 'Could not save the advancing pack.');
            } catch (e) {
                console.error('Advancing save failed:', e);
                if (window.notificationService) window.notificationService.showError('Could not save the advancing pack.');
            }
        });

        $(document).on('click', '.adv-preview-btn', async function() {
            const id = $(this).data('id');
            try {
                const res = await apiCall('/api/admin/bookings/' + id + '/advancing/pdf', 'POST', {});
                if (res && res.success) window.open('/api/admin/bookings/' + id + '/advancing/download', '_blank');
                else if (window.notificationService) window.notificationService.showError((res && res.message) || 'Could not generate the PDF.');
            } catch (e) {
                console.error('Advancing PDF generation failed:', e);
                if (window.notificationService) window.notificationService.showError('Could not generate the PDF.');
            }
        });

        $(document).on('click', '.adv-send-btn', async function() {
            const id = $(this).data('id');
            const ok = await window.notificationService.showConfirm({ message: 'Send the advancing pack to the client and venue now?' });
            if (!ok) return;
            try {
                const res = await apiCall('/api/admin/bookings/' + id + '/advancing/send', 'POST', {});
                if (res && res.success) { if (window.notificationService) window.notificationService.showSuccess('Advancing pack sent.'); advReloadPanel(id); }
                else if (window.notificationService) window.notificationService.showError((res && res.message) || 'Could not send the advancing pack.');
            } catch (e) {
                console.error('Advancing send failed:', e);
                if (window.notificationService) window.notificationService.showError('Could not send the advancing pack.');
            }
        });

        $(document).on('click', '.adv-confirm-btn', async function() {
            const id = $(this).data('id');
            try {
                const res = await apiCall('/api/admin/bookings/' + id + '/advancing/confirm', 'POST', {});
                if (res && res.success) { if (window.notificationService) window.notificationService.showSuccess('Advancing pack marked confirmed.'); advReloadPanel(id); }
                else if (window.notificationService) window.notificationService.showError((res && res.message) || 'Could not confirm the advancing pack.');
            } catch (e) {
                console.error('Advancing confirm failed:', e);
                if (window.notificationService) window.notificationService.showError('Could not confirm the advancing pack.');
            }
        });

        // ═══ Advancing Pack — run-of-show ═══
        $(document).on('click', '.adv-ros-add', async function() {
            const bookingId = $(this).data('id');
            const $card = $(this).closest('.atl-det-card');
            const time_label = $card.find('.adv-ros-new-time').val();
            const title = $card.find('.adv-ros-new-title').val();
            if (!title || !title.trim()) { if (window.notificationService) window.notificationService.showWarning('Title required', 'Enter a run-of-show title.'); return; }
            try {
                const res = await apiCall('/api/admin/bookings/' + bookingId + '/advancing/run-of-show', 'POST', { time_label, title });
                if (res && res.success) advReloadPanel(bookingId);
                else if (window.notificationService) window.notificationService.showError((res && res.message) || 'Could not add the item.');
            } catch (e) {
                console.error('ROS add failed:', e);
                if (window.notificationService) window.notificationService.showError('Could not add the run-of-show item.');
            }
        });

        $(document).on('change', '.atl-adv-ros-row input', async function() {
            const $row = $(this).closest('.atl-adv-ros-row');
            const body = {
                time_label: $row.find('.adv-ros-time').val(),
                title: $row.find('.adv-ros-title').val(),
                detail: $row.find('.adv-ros-detail').val(),
                responsible: $row.find('.adv-ros-resp').val(),
                booking_id: $row.closest('.atl-det-col').data('booking-id')
            };
            if (!body.title || !body.title.trim()) { if (window.notificationService) window.notificationService.showWarning('Title required', 'A run-of-show item needs a title.'); return; }
            try {
                await apiCall('/api/admin/advancing/run-of-show/' + $row.data('id'), 'PUT', body);
            } catch (e) {
                console.error('ROS update failed:', e);
                if (window.notificationService) window.notificationService.showError('Could not save that change.');
            }
        });

        $(document).on('click', '.adv-ros-delete', async function() {
            const itemId = $(this).data('id');
            const bookingId = $(this).closest('.atl-det-col').data('booking-id');
            try {
                const res = await apiCall('/api/admin/advancing/run-of-show/' + itemId, 'DELETE', { booking_id: bookingId });
                if (res && res.success) advReloadPanel(bookingId);
            } catch (e) {
                console.error('ROS delete failed:', e);
                if (window.notificationService) window.notificationService.showError('Could not delete the item.');
            }
        });

        $(document).on('click', '.adv-ros-up, .adv-ros-down', async function() {
            const up = $(this).hasClass('adv-ros-up');
            const bookingId = $(this).closest('.atl-det-col').data('booking-id');
            const ids = $(this).closest('.atl-adv-ros-list').find('.atl-adv-ros-row').map(function() { return $(this).data('id'); }).get();
            const idx = ids.indexOf($(this).data('id'));
            const swapWith = up ? idx - 1 : idx + 1;
            if (swapWith < 0 || swapWith >= ids.length) return;
            const tmp = ids[idx]; ids[idx] = ids[swapWith]; ids[swapWith] = tmp;
            try {
                const res = await apiCall('/api/admin/bookings/' + bookingId + '/advancing/run-of-show/reorder', 'PUT', { orderedIds: ids });
                if (res && res.success) advReloadPanel(bookingId);
            } catch (e) {
                console.error('ROS reorder failed:', e);
                if (window.notificationService) window.notificationService.showError('Could not reorder the run-of-show.');
            }
        });

        // ═══ Advancing Pack — extra contacts ═══
        $(document).on('click', '.adv-contact-add', async function() {
            const bookingId = $(this).data('id');
            const $card = $(this).closest('.atl-det-card');
            const role = $card.find('.adv-contact-new-role').val();
            const name = $card.find('.adv-contact-new-name').val();
            const phone = $card.find('.adv-contact-new-phone').val();
            const email = $card.find('.adv-contact-new-email').val();
            if (!name || !name.trim()) { if (window.notificationService) window.notificationService.showWarning('Name required', 'Enter a contact name.'); return; }
            try {
                const res = await apiCall('/api/admin/bookings/' + bookingId + '/advancing/contacts', 'POST', { role, name, phone, email });
                if (res && res.success) advReloadPanel(bookingId);
                else if (window.notificationService) window.notificationService.showError((res && res.message) || 'Could not add the contact.');
            } catch (e) {
                console.error('Contact add failed:', e);
                if (window.notificationService) window.notificationService.showError('Could not add the contact.');
            }
        });

        $(document).on('click', '.adv-contact-delete', async function() {
            const contactId = $(this).data('id');
            const bookingId = $(this).closest('.atl-det-col').data('booking-id');
            try {
                const res = await apiCall('/api/admin/advancing/contacts/' + contactId, 'DELETE', { booking_id: bookingId });
                if (res && res.success) advReloadPanel(bookingId);
            } catch (e) {
                console.error('Contact delete failed:', e);
                if (window.notificationService) window.notificationService.showError('Could not delete the contact.');
            }
        });

        window.toggleBookingDetail = function(bookingId, forceOpen) {
            const row = allBookingsCache.find(function(b) { return b.id == bookingId; });
            if (!row) return;

            const $drawer = $('#dealViewDrawer');
            const isThisOneOpen = $drawer.hasClass('atl-drawer--open') && $drawer.data('bookingId') == bookingId;
            const nextOpen = (forceOpen !== undefined) ? forceOpen : !isThisOneOpen;

            if (!nextOpen) {
                window.closeAtlDrawer('dealViewDrawer');
                return;
            }

            dealViewTriggerBookingId = bookingId;
            dvRenderFromRow(row, false);
        };

        // Renders the whole Deal View drawer (header/chips/actions/all tab panels) from a booking
        // row. Shared by toggleBookingDetail (a fresh open — lands on Overview, opens/focuses the
        // drawer) and refreshDealView (isRefresh=true — re-renders in place on whichever tab is
        // already active, and force-fetches every tab's data regardless of lazy-load state, since a
        // manual refresh shouldn't depend on which tabs the admin happens to have clicked into).
        function dvRenderFromRow(row, isRefresh) {
            const bookingId = row.id;
            const $drawer = $('#dealViewDrawer');
            $drawer.data('bookingId', bookingId);
            const $card = $(`.atl-bk-row[data-id="${bookingId}"]`);

            const s  = (row.status || 'PENDING').toUpperCase();
            const ps = (row.payment_status || 'UNPAID').toUpperCase();
            const sLbl   = { NEW:'New', PENDING:'Pending', QUOTED:'Quoted', ACCEPTED:'Accepted', CONFIRMED:'Confirmed', COMPLETED:'Completed', EXPIRED:'Expired', CANCELLED:'Cancelled', REJECTED:'Rejected' };
            const payLbl = { PAID:'✓ Paid', DEPOSIT_PAID:'◐ Deposit', PARTIALLY_PAID:'◑ Partial', UNPAID:'○ Unpaid', FAILED:'✕ Failed', CANCELLED:'✕ Cancelled' };
            const colors = window.statusColors(s);

            // ── Header ──
            $('#dvBreadcrumbCur').text('#' + row.id);
            $('#dvTitle').text(row.event_name || row.event_type || '—');
            $('#dvSubtitle').html(`${row.event_type ? row.event_type + ' · ' : ''}<b>${row.name}</b>${row.company ? ' · ' + row.company : ''}`);
            const dvDisposition = row.disposition || 'active';
            $('#dvStatusRow').html(
                `<span class="atl-status-badge" style="background:${colors.tint}; color:${colors.color}; padding:4px 10px; border-radius:999px; font-weight:600; display:inline-flex; align-items:center; gap:6px;">
                    <span class="atl-pill-dot" style="background:${colors.color}; width:7px; height:7px; border-radius:50%; display:inline-block;"></span>
                    ${s === 'ACCEPTED' ? 'Accepted' : (sLbl[s] || s)}
                 </span>
                 <span class="atl-payment-badge">${payLbl[ps] || ps}</span>
                 ${dvDisposition !== 'active' ? `<span class="atl-tag-badge atl-tag-badge--triaged" title="Soft-declined — excluded from the active pipeline and conversion counts">${dvDisposition === 'not_a_fit' ? 'Not a Fit' : 'Archived'}</span>` : ''}`
            );
            const chips = [];
            if (row.date) chips.push(`<span class="dv-chip"><i class="fa-regular fa-calendar"></i>&nbsp;${row.date}${row.event_start_time ? ' · ' + row.event_start_time : ''}</span>`);
            if (row.event_location) chips.push(`<span class="dv-chip"><i class="fa-solid fa-location-dot"></i>&nbsp;${row.event_location}</span>`);
            if (row.quote_amount) chips.push(`<span class="dv-chip gold"><span class="m">R ${parseFloat(row.quote_amount).toFixed(2)}</span></span>`);
            if (parseFloat(row.amount_outstanding) > 0) chips.push(`<span class="dv-chip"><span class="m">Outstanding R ${parseFloat(row.amount_outstanding).toFixed(2)}</span></span>`);
            $('#dvChips').html(chips.join(''));

            // Actions — reuse the row's own already-rendered action bar verbatim, so every
            // delegated handler (bk-action-quote, bk-action-gen-invoice, etc.) keeps working untouched.
            $('#dvActions').html($card.find('.atl-card-actions-bar').first().html() || '');
            // Refresh is always the first button — re-inserted every render since #dvActions'
            // contents get fully replaced above (both on open and on refresh).
            $('#dvActions').prepend(
                '<button type="button" class="atl-btn atl-btn--ghost" id="dvRefreshBtn" title="Refresh this booking\'s data" aria-label="Refresh booking data">'
                + '<i class="fa-solid fa-arrows-rotate" style="margin-right:6px;"></i>Refresh</button>'
            );

            // ── Panels ──
            $('#dv-panel-overview').html(buildOverviewPanel(row));
            $('#dv-panel-progress').html(buildProgressPanel(row));
            $('#dv-panel-offer').html(buildOfferPanel(row));
            $('#dv-panel-invoices').html(buildInvoicesPanel(row));
            // Real editor loads lazily on first Advancing-tab activation (dvActivateTab) once
            // CONFIRMED+ — until then (or while waiting), show the locked stub / a loading state.
            $('#dv-panel-advancing').html(
                (s === 'CONFIRMED' || s === 'COMPLETED')
                    ? '<div class="atl-det-loading"><span class="atl-spinner" aria-hidden="true"></span><span>Loading advancing pack…</span></div>'
                    : buildAdvancingStub(row)
            );
            $('#dv-panel-timeline').html(buildTimelinePanel(row));
            $('#dv-panel-files').html(buildFilesPanel(row));
            if (window.loadChangeHistoryCard) window.loadChangeHistoryCard('dv-change-history-' + row.id, 'bookings', row.id);

            if (!isRefresh) {
                // Always land on Overview when opening (possibly a different) booking.
                dvActivateTab(document.getElementById('dv-tab-overview'), false);

                window.openAtlDrawer('dealViewDrawer');
                $drawer.find('.atl-drawer__close').trigger('focus');
            }

            // Venue autocomplete lives on the Overview panel — re-run every open (F5).
            if (typeof window.initBookingVenueAutocomplete === 'function') {
                window.initBookingVenueAutocomplete(bookingId);
            }

            // A refresh forces the Timeline (notes+comms) and, when relevant, Advancing pack to
            // re-fetch immediately regardless of which tab is active — normally these are lazy,
            // only loading the first time their tab is clicked (see dvActivateTab).
            if (isRefresh) {
                dealViewTimelineLoaded[bookingId] = true;
                loadDealViewTimelineData(bookingId);
                if (s === 'CONFIRMED' || s === 'COMPLETED') {
                    dealViewAdvancingLoaded[bookingId] = true;
                    loadDealViewAdvancingData(bookingId);
                }
            }

            // Once-only guard (F3) — fetch the heavier resources at most once per booking per
            // list-render, matching the old $region.data('loaded') behaviour. loadBookings() (called
            // by refreshDealView before this function runs) clears this map globally, so a refresh
            // naturally passes this check and re-fetches too.
            if (dealViewLoadedIds[bookingId]) return;
            dealViewLoadedIds[bookingId] = true;

            Promise.all([
                fetch('/api/admin/bookings/' + bookingId + '/details',       { credentials:'same-origin' }).then(r => r.json()),
                fetch('/api/admin/bookings/' + bookingId + '/quote-history',  { credentials:'same-origin' }).then(r => r.json()).catch(() => []),
                fetch('/api/admin/bookings/' + bookingId + '/contract',       { credentials:'same-origin' }).then(r => r.json()).catch(() => null)
            ]).then(function([d, history, contract]) {
                // 1. Line Items Panel
                let lineItemsHtml = '';
                if (d.line_items && d.line_items.length) {
                    var liRows = d.line_items.map(function(li) {
                        var qty  = li.quantity_minutes || li.quantity || 0;
                        var unit = parseFloat(li.unit_price);
                        var tot  = parseFloat(li.total_price || unit * qty);
                        return '<tr>'
                            + '<td data-label="Service">'      + (li.service_name || li.description || '—') + '</td>'
                            + '<td data-label="Qty" class="right atl-det-tabular">'   + qty + ' ' + (li.display_unit || 'min') + '</td>'
                            + '<td data-label="Unit" class="right atl-det-tabular">R ' + unit.toFixed(2) + '</td>'
                            + '<td data-label="Total" class="right atl-det-tabular" style="font-weight:700;">R ' + tot.toFixed(2) + '</td>'
                            + '</tr>';
                    }).join('');

                    lineItemsHtml =
                        '<div class="atl-det-card">'
                        + '<h5 class="atl-det-title">Line items</h5>'
                        + '<div class="atl-det-table-wrap">'
                        + '<table class="atl-det-table atl-det-table-responsive">'
                        + '<thead><tr>'
                        + '<th>Service</th>'
                        + '<th class="right">Qty</th>'
                        + '<th class="right">Unit</th>'
                        + '<th class="right">Total</th>'
                        + '</tr></thead>'
                        + '<tbody>' + liRows + '</tbody>'
                        + '</table></div></div>';
                }
                var emptyLineItemsHtml = '<div class="atl-det-card">'
                    + '<h5 class="atl-det-title">Line items</h5>'
                    + '<p class="atl-det-empty">No line items on record.</p>'
                    + '</div>';
                $('#atl-lineitems-' + bookingId).html(lineItemsHtml || emptyLineItemsHtml);

                // 2. Transactions Panel
                let transactionsHtml = '';
                if (d.transactions && d.transactions.length) {
                    var txRows = d.transactions.map(function(t) {
                        var isRefund = (t.transaction_type || '').toLowerCase() === 'refund';
                        var sc = isRefund ? 'var(--atl-clay)'
                               : t.status === 'completed' ? 'var(--atl-sage)'
                               : t.status === 'failed'    ? 'var(--atl-clay)'
                               : 'var(--atl-orange)';
                        var amtStyle  = isRefund ? 'color:var(--atl-clay);font-weight:700;' : 'font-weight:700;';
                        var refundBadge = isRefund
                            ? '<span style="font-size:9px;background:rgba(248,113,113,0.12);color:var(--atl-clay);'
                              + 'padding:1px 5px;border-radius:3px;margin-right:4px;font-weight:700;">REFUND</span>'
                            : '';
                        var dateStr = t.transaction_date
                            ? new Date(t.transaction_date).toLocaleDateString('en-ZA') : '—';
                        return '<tr>'
                            + '<td data-label="Date">' + dateStr + '</td>'
                            + '<td data-label="Method">' + refundBadge + (t.payment_method || '—') + '</td>'
                            + '<td data-label="Reference" style="font-size:11px;opacity:.75;">'
                              + (t.reference || t.reference_number || '—') + '</td>'
                            + '<td data-label="Amount" class="right atl-det-tabular" style="' + amtStyle + '">'
                              + (isRefund ? '–' : '') + 'R ' + parseFloat(t.amount).toFixed(2) + '</td>'
                            + '<td data-label="Status" style="color:' + sc + ';font-size:11px;">' + t.status + '</td>'
                            + '</tr>';
                    }).join('');

                    transactionsHtml =
                        '<div class="atl-det-card">'
                        + '<h5 class="atl-det-title">Transactions</h5>'
                        + '<div class="atl-det-table-wrap">'
                        + '<table class="atl-det-table atl-det-table-responsive">'
                        + '<thead><tr>'
                        + '<th>Date</th><th>Method</th><th>Reference</th>'
                        + '<th class="right">Amount</th><th>Status</th>'
                        + '</tr></thead>'
                        + '<tbody>' + txRows + '</tbody>'
                        + '</table></div></div>';
                } else {
                    transactionsHtml =
                        '<div class="atl-det-card">'
                        + '<h5 class="atl-det-title">Transactions</h5>'
                        + '<p class="atl-det-empty">No transactions recorded.</p>'
                        + '</div>';
                }
                $('#atl-transactions-' + bookingId).html(transactionsHtml);

                // 3. History Panel
                let historyHtml = '';
                if (history.length >= 2) {
                    var histRows = history.map(function(q) {
                        var active  = !q.archived;
                        var qDate   = q.created_at ? new Date(q.created_at).toLocaleDateString('en-ZA') : '—';
                        var pdfLink = q.pdf_url
                            ? '<a href="' + q.pdf_url + '" target="_blank" rel="noopener" class="atl-det-link">View PDF</a>'
                            : '—';
                        var stHtml = active
                            ? '<span style="color:var(--atl-sage);font-weight:600;">● Active</span>'
                            : '<span style="color:var(--atl-muted);">Superseded</span>';
                        return '<tr class="' + (active ? 'atl-det-active-row' : '') + '">'
                            + '<td data-label="Version" style="color:' + (active ? 'var(--atl-amber)' : 'var(--atl-muted)') + ';">'
                              + 'v' + q.version + (active ? ' ✦' : '') + '</td>'
                            + '<td data-label="Date">' + qDate + '</td>'
                            + '<td data-label="Total" class="right atl-det-tabular">R ' + parseFloat(q.total_amount||0).toFixed(2) + '</td>'
                            + '<td data-label="Status">' + stHtml + '</td>'
                            + '<td data-label="PDF">' + pdfLink + '</td>'
                            + '</tr>';
                    }).join('');

                    historyHtml =
                        '<div class="atl-det-card">'
                        + '<h5 class="atl-det-title">Quote history</h5>'
                        + '<div class="atl-det-table-wrap">'
                        + '<table class="atl-det-table atl-det-table-responsive">'
                        + '<thead><tr>'
                        + '<th>Version</th><th>Date</th>'
                        + '<th class="right">Total</th><th>Status</th><th>PDF</th>'
                        + '</tr></thead>'
                        + '<tbody>' + histRows + '</tbody>'
                        + '</table></div></div>';
                }
                $('#atl-history-' + bookingId).html(historyHtml || '');

                // 4. Contract panel
                // GET /contract returns an envelope { success, contract } — pass the row, not the
                // envelope, or pdf_url/status read as undefined and the panel falsely shows
                // "Generate Contract" with no PDF (same unwrap as the post-generate path below).
                renderInlineContractPanel(bookingId, contract && contract.contract);

                // 5. Cancellation panel
                if (s === 'CANCELLED') {
                    renderInlineCancellationPanel(bookingId, d);
                }

                // 6. Payment schedule lazy loading
                if (typeof window.loadBookingPaymentSchedule === 'function') {
                    window.loadBookingPaymentSchedule(bookingId);
                }

                // 7. Activity timeline (Timeline & Notes) — synthesized from fields already on
                // hand, no new endpoint. Only entries with a real timestamp are shown.
                var fmtTlWhen = function(iso) {
                    var d = new Date(iso);
                    if (isNaN(d)) return '';
                    var day = d.toLocaleDateString('en-ZA', { day: '2-digit', month: 'short' }).toUpperCase();
                    var time = d.toLocaleTimeString('en-ZA', { hour: '2-digit', minute: '2-digit', hour12: false });
                    return day + ' · ' + time;
                };
                var tlEntries = [];
                if (row.created_at) tlEntries.push({ when: row.created_at, what: 'Enquiry received', meta: 'Booking submitted' });
                if (row.quoted_at) tlEntries.push({ when: row.quoted_at, what: 'Quote sent', meta: row.quote_amount ? ('R ' + parseFloat(row.quote_amount).toFixed(2)) : '' });
                if (row.accepted_at) tlEntries.push({ when: row.accepted_at, what: 'Quote accepted', meta: 'By client' });
                if (contract && contract.contract && contract.contract.signed_date) {
                    tlEntries.push({ when: contract.contract.signed_date, what: 'Contract signed', meta: contract.contract.signed_by ? ('Signed by ' + contract.contract.signed_by) : 'IP logged' });
                }
                if (row.payment_date) {
                    tlEntries.push({ when: row.payment_date, what: 'Payment received', meta: [row.amount_paid ? 'R ' + parseFloat(row.amount_paid).toFixed(2) : '', row.payment_method === 'payfast' ? 'PayFast' : ''].filter(Boolean).join(' · ') });
                }
                tlEntries.sort(function(a, b) { return new Date(a.when) - new Date(b.when); });
                var activityHtml = tlEntries.length
                    ? '<div class="atl-det-card"><h5 class="atl-det-title"><i class="fa-solid fa-clock-rotate-left"></i>Activity</h5><div class="atl-timeline">'
                      + tlEntries.map(function(e) {
                          return '<div class="atl-tl-item"><div class="atl-tl-when">' + fmtTlWhen(e.when) + '</div><div class="atl-tl-what">' + e.what + '</div>'
                              + (e.meta ? '<div class="atl-tl-meta">' + e.meta + '</div>' : '') + '</div>';
                      }).join('')
                      + '</div></div>'
                    : '';
                $('#atl-activity-' + bookingId).html(activityHtml);

                // 8. Files tab — generated document chips, alongside the client attachments
                // buildFilesPanel() already rendered synchronously from row.attachment_files. Split
                // across two phase cards that mirror the Deal View's own tabs (Quote & Contract /
                // Invoices & Payments), each keeping the same accent colour it uses everywhere else
                // (contract=purple, quote=amber-light, invoice=blue) so the colour itself is a
                // recognisable label across surfaces, not just here.
                var qcChips = [];
                if (contract && contract.contract && contract.contract.pdf_url) {
                    var cStatus = contract.contract.status === 'signed' ? 'Signed'
                                : contract.contract.status === 'sent' ? 'Sent · awaiting signature'
                                : 'Draft';
                    qcChips.push('<a class="dv-file" href="/api/admin/bookings/' + bookingId + '/contract/download" target="_blank" rel="noopener"><span class="ico" style="background:rgba(149,117,205,0.14);color:#9575CD;"><i class="fa-solid fa-file-contract"></i></span><span><span class="fn">Contract</span><span class="fm">' + cStatus + '</span></span></a>');
                }
                var activeQuote = history && history.length ? (history.find(function(q) { return !q.archived; }) || history[history.length - 1]) : null;
                if (activeQuote && activeQuote.pdf_url) {
                    var qStatus = activeQuote.archived ? 'Superseded' : 'Active';
                    qcChips.push('<a class="dv-file" href="' + activeQuote.pdf_url + '" target="_blank" rel="noopener"><span class="ico" style="background:rgba(212,175,55,0.14);color:var(--atl-amber-light);"><i class="fa-solid fa-file-invoice-dollar"></i></span><span><span class="fn">Quote v' + activeQuote.version + '</span><span class="fm">' + qStatus + '</span></span></a>');
                }
                $('#atl-filedocs-qc-' + bookingId).html(qcChips.length ? '<div class="dv-filegrid">' + qcChips.join('') + '</div>' : '<p class="atl-det-empty">No quote or contract generated yet.</p>');

                var invChips = [];
                if (row.invoice_number) {
                    var invRaw = row.invoice_status || 'DRAFT';
                    var invStatusLbl = invRaw.charAt(0).toUpperCase() + invRaw.slice(1).toLowerCase();
                    invChips.push('<a class="dv-file" href="/api/admin/bookings/' + bookingId + '/invoice/download" target="_blank" rel="noopener"><span class="ico" style="background:rgba(96,165,250,0.14);color:var(--atl-blue);"><i class="fa-solid fa-file-invoice"></i></span><span><span class="fn">Invoice ' + row.invoice_number + '</span><span class="fm">' + invStatusLbl + '</span></span></a>');
                }
                $('#atl-filedocs-inv-' + bookingId).html(invChips.length ? '<div class="dv-filegrid">' + invChips.join('') + '</div>' : '<p class="atl-det-empty">No invoice generated yet.</p>');
            }).catch(function(err) {
                console.error("Error loading lazy details: ", err);
                if (window.notificationService) window.notificationService.showError("Could not load this booking's financial details.");
                $('#atl-lineitems-' + bookingId).html('<div class="atl-det-card"><p class="atl-det-empty">Failed to load details.</p></div>');
                $('#atl-transactions-' + bookingId).html('<div class="atl-det-card"><p class="atl-det-empty">Failed to load details.</p></div>');
            });
        }

        // Manual refresh — pulls the freshest booking data via the same canonical fetch loadBookings()
        // already uses (avoids the "3 overlapping booking endpoints" trap: mixing a different
        // single-booking route here risks a field-shape mismatch with what the row list/drawer
        // otherwise expect), then re-renders the already-open drawer in place without switching tabs
        // or replaying the open animation.
        window.refreshDealView = async function() {
            const bookingId = $('#dealViewDrawer').data('bookingId');
            if (!bookingId) return;
            const $btn = $('#dvRefreshBtn');
            $btn.prop('disabled', true).find('i').addClass('fa-spin');
            try {
                await loadBookings();
                const row = allBookingsCache.find(function(b) { return b.id == bookingId; });
                if (!row) {
                    // Booking no longer exists (deleted elsewhere) — nothing left to refresh.
                    window.closeAtlDrawer('dealViewDrawer');
                    return;
                }
                dvRenderFromRow(row, true);
                if (window.notificationService) window.notificationService.showSuccess('Booking data refreshed.');
            } catch (e) {
                console.error('Deal View refresh failed:', e);
                if (window.notificationService) window.notificationService.showError('Could not refresh this booking.');
            } finally {
                $('#dvRefreshBtn').prop('disabled', false).find('i').removeClass('fa-spin');
            }
        };
        $(document).off('click.dvrefresh').on('click.dvrefresh', '#dvRefreshBtn', function() {
            window.refreshDealView();
        });

        window.initBookingVenueAutocomplete = function(bookingId) {
            const input = document.getElementById(`venueLinkGoogle-${bookingId}`);
            if (!input || input._placesInited) return;

            if (!window.google || !window.google.maps || !window.google.maps.places) {
                console.warn('Google Maps Places library is not loaded.');
                return;
            }

            input._placesInited = true;
            const autocomplete = new google.maps.places.Autocomplete(input, {
                fields: ['place_id', 'name', 'formatted_address', 'address_components', 'geometry']
            });

            autocomplete.addListener('place_changed', function() {
                const place = autocomplete.getPlace();
                const $btn = $(`#venueLinkGoogleBtn-${bookingId}`);
                if (!place || !place.place_id) {
                    $btn.prop('disabled', true);
                    return;
                }

                // Parse address components
                let city = '';
                let state = '';
                let country = '';
                if (place.address_components) {
                    place.address_components.forEach(function(comp) {
                        const types = comp.types || [];
                        if (types.includes('locality')) {
                            city = comp.long_name;
                        } else if (!city && types.includes('administrative_area_level_2')) {
                            city = comp.long_name;
                        }
                        if (types.includes('administrative_area_level_1')) {
                            state = comp.long_name;
                        }
                        if (types.includes('country')) {
                            country = comp.long_name;
                        }
                    });
                }

                if (!city && place.address_components) {
                    place.address_components.forEach(function(comp) {
                        const types = comp.types || [];
                        if (types.includes('sublocality') || types.includes('sublocality_level_1')) {
                            city = comp.long_name;
                        } else if (!city && types.includes('administrative_area_level_1')) {
                            city = comp.long_name;
                        }
                    });
                }

                const payload = {
                    place_id: place.place_id,
                    name: place.name || input.value,
                    address: place.formatted_address || '',
                    city: city,
                    state: state,
                    country: country,
                    latitude: place.geometry && place.geometry.location ? place.geometry.location.lat() : null,
                    longitude: place.geometry && place.geometry.location ? place.geometry.location.lng() : null
                };

                $btn.data('payload', payload).prop('disabled', false);
            });

            // If user types to change input, disable link button
            $(input).on('input', function() {
                $(`#venueLinkGoogleBtn-${bookingId}`).prop('disabled', true).removeData('payload');
            });
        };
