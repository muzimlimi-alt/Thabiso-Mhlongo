/* Manual EFT payments - admin side (docs-internal/eft-payments.md).
   (A) Revenue -> Payment Setup -> "Bank Transfer & Banking Details" tab (the Manual EFT card) (administrators only): the on/off switch, the upload limit, the banking details and their version history.
   (B) Finance -> "EFT Payments" tab: the queue of proofs of payment clients have uploaded.
   (C) The review drawer: look at the proof, enter what the BANK shows (amount, reference, date), then approve it (which records the payment on the booking),
       reject it, or ask for a clearer one.

   The one rule behind all of it: a proof of payment is a client's claim, not money. Nothing here changes a booking until Approve - and the server decides,
   so a role that is not allowed gets a 403 whatever the page shows. Plain top-level code, jQuery, window.notificationService for feedback (no alert()). */
(function () {
    'use strict';

    var STATUS_LABEL = { pending: 'Waiting for review', approved: 'Approved', rejected: 'Rejected', replacement_requested: 'New proof requested' };
    var STATUS_BADGE = { pending: 'atl-badge--pending', approved: 'atl-badge--paid', rejected: 'atl-badge--cancelled', replacement_requested: 'atl-badge--warning' };
    var currentReview = null;      // { id, detail }
    var proofUrl = null;           // blob: URL of the proof being reviewed (revoked when the drawer content changes)

    function esc(s) {
        if (window.escHtml) return window.escHtml(s == null ? '' : s);
        return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }
    function money(n) { return 'R ' + (parseFloat(n) || 0).toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
    function day(s) { return String(s || '').slice(0, 10); }
    function toast(kind, title, msg) {
        if (window.notificationService && window.notificationService[kind]) window.notificationService[kind](title, msg);
    }
    function call(method, url, body) {
        var opts = { method: method, credentials: 'same-origin', headers: {} };
        if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
        return fetch(url, opts).then(function (res) {
            return res.json().catch(function () { return {}; }).then(function (json) { return { status: res.status, ok: res.ok, json: json || {} }; });
        });
    }

    /* ───────────────────────────── (B) the queue ───────────────────────────── */

    function setPendingBadge(n) {
        var $b = $('#eftPendingBadge');
        if (n > 0) $b.text(n).show(); else $b.hide();
    }

    function refreshEftBadge() {
        return call('GET', '/api/admin/eft/settings').then(function (r) { if (r.ok) setPendingBadge(r.json.pending_count || 0); }).catch(function () {});
    }

    function loadEftQueue() {
        var status = $('#eftStatusFilter').val();
        var $body = $('#eftQueueBody');
        $body.html('<tr><td colspan="7" class="eft-empty">Loading…</td></tr>');
        return call('GET', '/api/admin/eft/submissions' + (status ? '?status=' + encodeURIComponent(status) : '')).then(function (r) {
            if (!r.ok) { $body.html('<tr><td colspan="7" class="eft-empty">' + esc(r.json.message || 'Could not load the proofs of payment.') + '</td></tr>'); return; }
            setPendingBadge(r.json.pending_count || 0);
            var rows = r.json.submissions || [];
            $('#eftCountBadge').text(rows.length + ' of ' + (r.json.total || 0) + ' shown');
            if (!rows.length) {
                $body.html('<tr><td colspan="7" class="eft-empty">' + (status === 'pending' ? 'Nothing is waiting for review.' : 'No proofs of payment match this filter.') + '</td></tr>');
                return;
            }
            $body.html(rows.map(function (s) {
                var flag = s.same_file_elsewhere ? '<span class="eft-flag" title="The same file was sent for another booking"><i class="fa-solid fa-triangle-exclamation"></i> same file elsewhere</span>' : '';
                return '<tr>' +
                    '<td>' + esc(day(s.created_at)) + '</td>' +
                    '<td><div class="eft-client">' + esc(s.client_name || '') + '</div><div class="eft-sub">Booking #' + s.booking_id + ' · ' + esc(s.event_name || '') + '</div></td>' +
                    '<td class="eft-amount">' + money(s.claimed_amount) + flag + '</td>' +
                    '<td>' + esc(s.invoice_number || '—') + '</td>' +
                    '<td class="eft-amount">' + money(s.amount_outstanding) + '</td>' +
                    '<td><span class="atl-badge ' + (STATUS_BADGE[s.status] || '') + '">' + esc(STATUS_LABEL[s.status] || s.status) + '</span></td>' +
                    '<td style="text-align:right;"><button type="button" class="atl-btn atl-btn--ghost eft-open" data-id="' + s.id + '" style="font-size:12px;">' + (s.status === 'pending' ? 'Review' : 'View') + '</button></td>' +
                    '</tr>';
            }).join(''));
        }).catch(function () { $body.html('<tr><td colspan="7" class="eft-empty">Could not reach the server.</td></tr>'); });
    }

    /* ───────────────────────────── (C) the review drawer ───────────────────────────── */

    function revokeProof() { if (proofUrl) { try { URL.revokeObjectURL(proofUrl); } catch (e) {} proofUrl = null; } }

    function historyHtml(events) {
        return '<ul class="eft-history">' + (events || []).map(function (e) {
            var who = e.actor_type === 'client' ? 'Client' : (e.actor_type === 'admin' ? (e.actor_name || 'Admin') : 'System');
            return '<li><strong>' + esc(e.action.replace(/_/g, ' ')) + '</strong> · ' + esc(who) + ' · ' + esc(String(e.created_at || '').slice(0, 16)) + (e.note ? '<br>' + esc(e.note) : '') + '</li>';
        }).join('') + '</ul>';
    }

    function renderReview(d) {
        var s = d.submission, b = d.booking || {}, inv = d.invoice;
        var pending = s.status === 'pending';
        var h = '';
        h += '<div class="eft-card"><h6>Booking</h6><dl class="eft-kv">' +
            '<dt>Client</dt><dd>' + esc(b.name) + ' <span class="eft-sub">' + esc(b.email) + '</span></dd>' +
            '<dt>Event</dt><dd>' + esc(b.event_name || b.event_type) + ' · ' + esc(b.date) + '</dd>' +
            '<dt>Booking</dt><dd>#' + b.id + ' · ' + esc(b.status) + ' · ' + esc(b.payment_status) + '</dd>' +
            '<dt>Total / paid</dt><dd>' + money(b.total) + ' / ' + money(b.amount_paid) + '</dd>' +
            '<dt>Still outstanding</dt><dd>' + money(b.outstanding) + '</dd>' +
            (inv ? '<dt>Invoice</dt><dd>' + esc(inv.invoice_number) + ' · ' + esc(inv.status) + '</dd>' : '') +
            (d.schedule ? '<dt>For instalment</dt><dd>' + esc(d.schedule.description) + ' (' + money(d.schedule.expected_amount) + ', due ' + esc(d.schedule.due_date) + ')</dd>' : '') +
            '</dl></div>';

        h += '<div class="eft-card"><h6>What the client says</h6><dl class="eft-kv">' +
            '<dt>Amount paid</dt><dd>' + money(s.claimed_amount) + '</dd>' +
            '<dt>Date paid</dt><dd>' + esc(s.claimed_date || 'not given') + '</dd>' +
            '<dt>Their reference</dt><dd>' + esc(s.claimed_reference || 'not given') + '</dd>' +
            (s.client_note ? '<dt>Note</dt><dd>' + esc(s.client_note) + '</dd>' : '') +
            '<dt>Sent</dt><dd>' + esc(String(s.created_at || '').slice(0, 16)) + '</dd>' +
            '<dt>File</dt><dd>' + esc(s.proof_original_name || '') + ' · ' + esc(s.proof_mime) + ' · ' + Math.round((s.proof_size || 0) / 1024) + ' KB</dd>' +
            '</dl></div>';

        var warns = [];
        if (d.same_file_elsewhere && d.same_file_elsewhere.length) warns.push('The very same file was also sent for booking ' + d.same_file_elsewhere.map(function (x) { return '#' + x.booking_id; }).join(', ') + '. Check it is not being reused.');
        if (pending && parseFloat(s.claimed_amount) > (b.outstanding || 0) + 0.009) warns.push('The claimed amount is more than the booking still owes.');
        if (pending && ['CANCELLED', 'EXPIRED'].indexOf(String(b.status).toUpperCase()) >= 0) warns.push('This booking is ' + esc(b.status) + ' - a payment cannot be recorded against it. Reject the proof (and refund the client if they paid).');
        if (warns.length) h += '<div class="eft-warn"><i class="fa-solid fa-triangle-exclamation" style="margin-right:6px;"></i>' + warns.join('<br>') + '</div>';

        h += '<div class="eft-card eft-proof"><h6>Proof of payment</h6><div id="eftProofPreview" class="eft-sub">Loading the file…</div><div class="eft-proof__actions" id="eftProofActions"></div></div>';

        if (pending) {
            var today = new Date().toISOString().slice(0, 10);
            h += '<div class="eft-card" id="eftDecision"><h6>Check it against the bank statement</h6>' +
                '<div class="eft-verify">' +
                '<div><label for="eftVerAmount">Amount received (R)</label><input type="text" id="eftVerAmount" class="atl-input" inputmode="decimal" value="' + esc(parseFloat(s.claimed_amount).toFixed(2)) + '" style="background:var(--atl-card);color:var(--atl-ink);"></div>' +
                '<div><label for="eftVerDate">Date it reached the account</label><input type="date" id="eftVerDate" class="atl-input" max="' + today + '" value="' + esc(s.claimed_date || today) + '" style="background:var(--atl-card);color:var(--atl-ink);"></div>' +
                '<div class="eft-wide"><label for="eftVerRef">Reference on the bank statement</label><input type="text" id="eftVerRef" class="atl-input" maxlength="100" value="' + esc(s.claimed_reference || '') + '" style="background:var(--atl-card);color:var(--atl-ink);"></div>' +
                '<div class="eft-wide"><label for="eftVerNote">Internal note (optional)</label><input type="text" id="eftVerNote" class="atl-input" maxlength="500" style="background:var(--atl-card);color:var(--atl-ink);"></div>' +
                '<div class="eft-wide" id="eftDupRow" style="display:none;"><label style="text-transform:none;letter-spacing:0;font-size:12px;color:var(--atl-ink);"><input type="checkbox" id="eftConfirmDup"> <span id="eftDupText"></span></label></div>' +
                '</div>' +
                '<div id="eftReviewMsg" class="eft-warn" style="display:none;margin-top:10px;" role="alert"></div>' +
                '<div class="eft-actions">' +
                '<button type="button" class="atl-btn atl-btn--primary" id="eftApproveBtn"><i class="fa-solid fa-check" style="margin-right:6px;"></i>Approve &amp; record payment</button>' +
                '<span class="eft-spacer"></span>' +
                '<button type="button" class="atl-btn atl-btn--ghost" id="eftAskBtn">Ask for a new proof</button>' +
                '<button type="button" class="atl-btn atl-btn--ghost eft-danger" id="eftRejectBtn">Reject</button>' +
                '</div>' +
                '<div class="eft-reason" id="eftReasonBox" style="display:none;margin-top:12px;">' +
                '<label for="eftReasonText" id="eftReasonLabel">Reason (the client will read this)</label>' +
                '<textarea id="eftReasonText" class="atl-input" rows="3" maxlength="500" style="background:var(--atl-card);color:var(--atl-ink);width:100%;"></textarea>' +
                '<div class="eft-actions"><button type="button" class="atl-btn atl-btn--primary" id="eftReasonSend">Send to client</button><button type="button" class="atl-btn atl-btn--ghost" id="eftReasonCancel">Cancel</button></div>' +
                '</div></div>';
        } else {
            h += '<div class="eft-card"><h6>Decision</h6><dl class="eft-kv">' +
                '<dt>Status</dt><dd>' + esc(STATUS_LABEL[s.status] || s.status) + '</dd>' +
                (s.status === 'approved' ? '<dt>Verified amount</dt><dd>' + money(s.verified_amount) + '</dd><dt>Bank reference</dt><dd>' + esc(s.verified_reference) + '</dd><dt>Received</dt><dd>' + esc(s.verified_date) + '</dd><dt>Ledger row</dt><dd>#' + s.transaction_id + '</dd>' : '') +
                (s.review_note ? '<dt>Note</dt><dd>' + esc(s.review_note) + '</dd>' : '') +
                '<dt>Reviewed</dt><dd>' + esc(String(s.reviewed_at || '').slice(0, 16)) + '</dd></dl></div>';
        }
        h += '<div class="eft-card"><h6>History</h6>' + historyHtml(d.events) + '</div>';
        return h;
    }

    function loadProof(id, mime) {
        revokeProof();
        return fetch('/api/admin/eft/submissions/' + id + '/proof?inline=1', { credentials: 'same-origin' }).then(function (res) {
            if (!res.ok) throw new Error('missing');
            return res.blob();
        }).then(function (blob) {
            proofUrl = URL.createObjectURL(blob);
            var isImage = /^image\//.test(mime);
            $('#eftProofPreview').html(isImage ? '<img alt="Proof of payment" src="' + proofUrl + '">' : '<i class="fa-solid fa-file-pdf" style="font-size:42px;color:var(--atl-clay);"></i>');
            $('#eftProofActions').html('<a class="atl-btn atl-btn--ghost" href="' + proofUrl + '" target="_blank" rel="noopener" style="font-size:12px;">Open full size</a>' +
                '<a class="atl-btn atl-btn--ghost" href="' + proofUrl + '" download="proof-of-payment-' + id + '" style="font-size:12px;">Download</a>');
        }).catch(function () { $('#eftProofPreview').text('The file could not be loaded.'); });
    }

    function openReview(id) {
        currentReview = { id: id };
        $('#eftReviewBody').html('<div class="eft-done">Loading…</div>');
        if (window.openAtlDrawer) window.openAtlDrawer('eftReviewDrawer');
        return call('GET', '/api/admin/eft/submissions/' + id).then(function (r) {
            if (!r.ok) { $('#eftReviewBody').html('<div class="eft-warn">' + esc(r.json.message || 'Could not load this proof of payment.') + '</div>'); return; }
            currentReview.detail = r.json;
            $('#eftReviewBody').html(renderReview(r.json));
            loadProof(id, r.json.submission.proof_mime);
        });
    }

    function finish(message, kind) {
        revokeProof();
        if (window.closeAtlDrawer) window.closeAtlDrawer('eftReviewDrawer');
        toast(kind || 'showSuccess', kind === 'showError' ? 'Not recorded' : 'Done', message);
        loadEftQueue();
        refreshEftBadge();
        if (typeof window.loadFinancialStats === 'function') { try { window.loadFinancialStats(); } catch (e) {} }
    }

    function showReviewMsg(text) { $('#eftReviewMsg').text(text).show(); }

    function approve() {
        if (!currentReview) return;
        var $btn = $('#eftApproveBtn');
        $('#eftReviewMsg').hide();
        $btn.prop('disabled', true);
        call('POST', '/api/admin/eft/submissions/' + currentReview.id + '/approve', {
            verified_amount: $('#eftVerAmount').val(), verified_reference: $('#eftVerRef').val(), verified_date: $('#eftVerDate').val(),
            note: $('#eftVerNote').val(), confirm_duplicate: $('#eftConfirmDup').is(':checked')
        }).then(function (r) {
            if (r.ok && r.json.success) { finish(r.json.message || 'Payment recorded.'); return; }
            $btn.prop('disabled', false);
            if (r.json.duplicate_warning) { $('#eftDupText').text(r.json.message + ' Tick to record it anyway.'); $('#eftDupRow').show(); }
            showReviewMsg(r.json.message || 'The payment could not be recorded.');
            if (r.status === 409 && /already been reviewed|just reviewed/i.test(r.json.message || '')) { loadEftQueue(); refreshEftBadge(); }
        }).catch(function () { $btn.prop('disabled', false); showReviewMsg('Could not reach the server. Nothing was recorded.'); });
    }

    var pendingKind = null;
    function askReason(kind) {
        pendingKind = kind;
        $('#eftReasonLabel').text(kind === 'reject' ? 'Why is the proof being rejected? (the client will read this)' : 'What should the client fix? (the client will read this)');
        $('#eftReasonBox').show();
        $('#eftReasonText').val('').focus();
    }
    function sendReason() {
        if (!currentReview || !pendingKind) return;
        var path = pendingKind === 'reject' ? 'reject' : 'request-replacement';
        var $btn = $('#eftReasonSend').prop('disabled', true);
        call('POST', '/api/admin/eft/submissions/' + currentReview.id + '/' + path, { note: $('#eftReasonText').val() }).then(function (r) {
            if (r.ok && r.json.success) { finish(r.json.message || 'Saved.'); return; }
            $btn.prop('disabled', false);
            showReviewMsg(r.json.message || 'Could not save.');
        }).catch(function () { $btn.prop('disabled', false); showReviewMsg('Could not reach the server.'); });
    }

    /* ───────────────────────────── (A) settings card ───────────────────────────── */

    var FIELD_ERR = { account_holder: 'errEftHolder', bank_name: 'errEftBank', account_number: 'errEftAccount', account_type: 'errEftType', branch_code: 'errEftBranch', swift_code: 'errEftSwift', reference_note: 'errEftRefNote', payment_instructions: 'errEftInstructions' };

    function clearFieldErrors() { Object.keys(FIELD_ERR).forEach(function (k) { $('#' + FIELD_ERR[k]).hide().text(''); }); }

    // The preview mirrors the block printed on an invoice and shown on the client's booking page, built from what is typed in the form right now
    // (nothing is saved) with a sample invoice number and amount.
    function renderPreview() {
        var v = function (id) { return $.trim($('#' + id).val() || ''); };
        var holder = v('eftHolder'), bank = v('eftBank'), acct = v('eftAccount'), branch = v('eftBranch');
        var $b = $('#eftPreviewBody');
        if (!holder && !bank && !acct && !branch) { $b.html('<div class="eft-preview__empty">Fill in the banking details to see the preview.</div>'); return; }
        var typeLabel = $('#eftType option:selected').text();
        var rows = [['Account holder', holder], ['Bank', bank], ['Account number', acct], ['Account type', typeLabel], ['Branch code', branch]];
        if (v('eftSwift')) rows.push(['SWIFT / BIC', v('eftSwift').toUpperCase()]);
        rows.push(['Invoice number', 'INV-2026-0042'], ['Booking reference', '#42'], ['Amount payable', 'R 2500.00']);
        var h = '<dl class="eft-kv">' + rows.map(function (r) { return '<dt>' + esc(r[0]) + '</dt><dd>' + (esc(r[1]) || '<span class="eft-sub">(not set)</span>') + '</dd>'; }).join('') +
            '<dt>Payment reference</dt><dd class="eft-ref">INV-2026-0042</dd></dl>';
        var notes = [v('eftRefNote'), v('eftInstructions'), 'After you have paid, upload your proof of payment on your booking page. Payment is subject to verification and confirmation of cleared funds in our bank account.'].filter(Boolean);
        h += '<p class="eft-preview__note">' + notes.map(esc).join('<br>') + '</p>';
        $b.html(h);
    }

    function loadEftCard() {
        return call('GET', '/api/admin/eft/bank-details').then(function (r) {
            if (r.status === 403 || !r.ok) { $('#stEftCard').hide(); return; }      // only administrators ever see this card
            $('#stEftCard').show();
            var types = r.json.account_types || {};
            $('#eftType').html(Object.keys(types).map(function (k) { return '<option value="' + esc(k) + '">' + esc(types[k]) + '</option>'; }).join(''));
            var a = r.json.active;
            $('#eftHolder').val(a ? a.account_holder : '');
            $('#eftBank').val(a ? a.bank_name : '');
            $('#eftAccount').val(a ? a.account_number : '');
            $('#eftType').val(a ? a.account_type : 'current');
            $('#eftBranch').val(a ? a.branch_code : '');
            $('#eftSwift').val(a && a.swift_code ? a.swift_code : '');
            $('#eftRefNote').val(a && a.reference_note ? a.reference_note : '');
            $('#eftInstructions').val(a && a.payment_instructions ? a.payment_instructions : '');
            renderPreview();
            var versions = r.json.versions || [];
            $('#eftVersionsWrap').toggle(versions.length > 0);
            $('#eftVersionsBody').html(versions.map(function (v) {
                return '<tr><td><strong>v' + v.version + '</strong>' + (v.is_active ? ' <span class="atl-badge atl-badge--paid">active</span>' : '') + '</td>' +
                    '<td>' + esc(v.bank_name) + ' · ' + esc(v.account_number_masked) + '</td>' +
                    '<td>' + esc(day(v.created_at)) + (v.created_by_name ? ' · ' + esc(v.created_by_name) : '') + '</td>' +
                    '<td>' + (v.retired_at ? esc(day(v.retired_at)) : '—') + '</td>' +
                    '<td>' + (v.invoice_count || 0) + '</td></tr>';
            }).join(''));
            return call('GET', '/api/admin/eft/settings').then(function (s) {
                if (!s.ok) return;
                $('#eftEnabled').prop('checked', !!s.json.settings.enabled);
                $('#eftMaxMb').val(s.json.settings.max_upload_mb);
                $('#eftCardStatus').text(s.json.settings.enabled
                    ? 'Manual EFT is ON: clients can see these details and send a proof of payment. ' + (s.json.pending_count ? s.json.pending_count + ' proof(s) are waiting for review.' : 'Nothing is waiting for review.')
                    : 'Manual EFT is OFF: clients are offered card payment only, and new invoices carry no banking details.');
            });
        }).catch(function () { $('#stEftCard').hide(); });
    }

    function saveSettings() {
        var $btn = $('#eftSaveSettingsBtn').prop('disabled', true);
        call('PUT', '/api/admin/eft/settings', { enabled: $('#eftEnabled').is(':checked'), max_upload_mb: $('#eftMaxMb').val() }).then(function (r) {
            $btn.prop('disabled', false);
            if (r.ok && r.json.success) { toast('showSuccess', 'Saved', r.json.message); loadEftCard(); refreshEftBadge(); }
            else { toast('showError', 'Not saved', r.json.message || 'Could not save.'); loadEftCard(); }
        }).catch(function () { $btn.prop('disabled', false); toast('showError', 'Not saved', 'Could not reach the server.'); });
    }

    function saveDetails() {
        clearFieldErrors();
        $('#eftDetailsMsg').text('');
        var $btn = $('#eftSaveDetailsBtn').prop('disabled', true);
        call('PUT', '/api/admin/eft/bank-details', {
            account_holder: $('#eftHolder').val(), bank_name: $('#eftBank').val(), account_number: $('#eftAccount').val(), account_type: $('#eftType').val(),
            branch_code: $('#eftBranch').val(), swift_code: $('#eftSwift').val(), reference_note: $('#eftRefNote').val(), payment_instructions: $('#eftInstructions').val()
        }).then(function (r) {
            $btn.prop('disabled', false);
            if (r.ok && r.json.success) { $('#eftDetailsMsg').text(r.json.message); toast('showSuccess', 'Banking details', r.json.message); loadEftCard(); return; }
            var errs = r.json.errors || {};
            Object.keys(errs).forEach(function (k) { if (FIELD_ERR[k]) $('#' + FIELD_ERR[k]).text(errs[k]).show(); });
            toast('showError', 'Not saved', r.json.message || 'Could not save.');
        }).catch(function () { $btn.prop('disabled', false); toast('showError', 'Not saved', 'Could not reach the server.'); });
    }

    /* ───────────────────────────── wiring ───────────────────────────── */

    $(document).on('click', '#finTabBar .atl-tab-btn[data-um-tab="finEft"]', loadEftQueue);
    $(document).on('change', '#eftStatusFilter', loadEftQueue);
    $(document).on('click', '#eftRefreshBtn', loadEftQueue);
    $(document).on('click', '.eft-open', function () { openReview($(this).data('id')); });
    $(document).on('click', '#eftApproveBtn', approve);
    $(document).on('click', '#eftRejectBtn', function () { askReason('reject'); });
    $(document).on('click', '#eftAskBtn', function () { askReason('replace'); });
    $(document).on('click', '#eftReasonCancel', function () { pendingKind = null; $('#eftReasonBox').hide(); });
    $(document).on('click', '#eftReasonSend', sendReason);
    $(document).on('input change', '#eftHolder, #eftBank, #eftAccount, #eftType, #eftBranch, #eftSwift, #eftRefNote, #eftInstructions', renderPreview);
    $(document).on('click', '#eftSaveSettingsBtn', saveSettings);
    $(document).on('click', '#eftSaveDetailsBtn', saveDetails);
    $(document).on('shown.bs.tab', 'a[href="#paymentSetupAdmin"]', loadEftCard);
    $(document).on('shown.bs.tab', 'a[href="#financeAdmin"]', refreshEftBadge);
    $(document).on('hidden.bs.modal', function () { revokeProof(); });

    // Expose for the tests and for the Deal View (a booking's own proofs).
    window.loadEftQueue = loadEftQueue;
    window.openEftReview = openReview;
    window.loadEftCard = loadEftCard;
    window.refreshEftBadge = refreshEftBadge;
})();
