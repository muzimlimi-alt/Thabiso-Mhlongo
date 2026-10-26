/* PayFast safety net - admin side (docs-internal/payfast.md, lib/payfast-reconcile.js).
   The panel at the top of Finance -> Reconciliation: how the safety net is doing, "Check PayFast now" (and a preview that changes nothing), and the
   payments it could not record by itself, each of which a person marks as dealt with once they have decided what to do.

   The rule behind it: the server only ever records a payment PayFast's own records show and that matches a payment attempt exactly. Everything else is
   REPORTED here, never credited - and the server decides who may use any of it (administrators and managers), whatever this page shows.
   Plain top-level code, jQuery, window.notificationService for feedback (no alert()). */
(function () {
    'use strict';

    var KIND_LABEL = { recovered: 'Recovered automatically', mismatch: 'Does not match', duplicate_payment: 'Paid twice', blocked: 'Could not be recorded' };
    var KIND_BADGE = { recovered: 'atl-badge--paid', mismatch: 'atl-badge--warning', duplicate_payment: 'atl-badge--warning', blocked: 'atl-badge--cancelled' };
    var busy = false;

    function esc(s) {
        if (window.escHtml) return window.escHtml(s == null ? '' : s);
        return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }
    function money(n) { return 'R ' + (parseFloat(n) || 0).toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
    function when(s) { return s ? String(s).replace('T', ' ').slice(0, 16) : 'never'; }
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

    function renderStatus(s) {
        var $mode = $('#pfsMode');
        $mode.text(s.sandbox ? 'Sandbox' : 'Live').attr('class', 'atl-badge ' + (s.sandbox ? 'atl-badge--pending' : 'atl-badge--paid')).show();
        var h = [];
        if (!s.enabled) {
            h.push('<span class="pfs-problem">Switched off (PAYFAST_RECONCILE=off). A payment whose notification is lost will not be found.</span>');
        } else if (!s.configured) {
            h.push('<span class="pfs-problem">No PayFast merchant id is configured, so PayFast cannot be asked.</span>');
        } else {
            h.push('<span>Last checked: <strong>' + esc(when(s.lastRunAt)) + ' UTC</strong></span>');
            h.push('<span>Last successful: <strong>' + esc(when(s.lastSuccessAt)) + ' UTC</strong></span>');
            h.push('<span>Payments waiting to be confirmed: <strong>' + (s.waitingAttempts || 0) + '</strong></span>');
            h.push('<span>Needing attention: <strong>' + (s.openFindings || 0) + '</strong></span>');
            if (s.lastError) {
                h.push('<span class="pfs-problem">PayFast could not be read (' + esc(s.lastErrorCategory || 'error') + '): ' + esc(s.lastError) + ' - failed ' + (s.consecutiveFailures || 0) +
                    ' time(s), next automatic try after ' + esc(when(s.retryAfter)) + ' UTC.</span>');
            }
        }
        $('#pfsStatus').html(h.join(''));
        $('#pfsRunBtn, #pfsDryBtn').prop('disabled', !s.enabled || !s.configured || busy);
    }

    function renderFindings(rows) {
        var $w = $('#pfsFindings');
        var open = rows.filter(function (f) { return f.status === 'open'; });
        if (!rows.length) { $w.html('<div class="pfs-empty">Nothing to report: every payment PayFast has told us about was recorded.</div>'); return; }
        var h = '<h6>' + open.length + ' needing attention · ' + (rows.length - open.length) + ' dealt with</h6>' +
            '<div class="table-responsive"><table class="table pfs-table"><thead><tr><th>Seen</th><th>Booking</th><th>PayFast payment</th><th style="text-align:right;">Amount</th><th>What happened</th><th></th></tr></thead><tbody>';
        rows.forEach(function (f) {
            var isOpen = f.status === 'open';
            h += '<tr data-finding="' + f.id + '">' +
                '<td class="pfs-sub2">' + esc(when(f.first_seen_at)) + '</td>' +
                '<td>' + (f.booking_id ? '#' + f.booking_id : '') + '<div class="pfs-sub2">' + esc(f.client_name || '') + (f.event_name ? ' · ' + esc(f.event_name) : '') + '</div></td>' +
                '<td>' + esc(f.pf_payment_id) + '<div class="pfs-sub2">' + esc(f.m_payment_id || '') + '</div></td>' +
                '<td class="pfs-amount" style="text-align:right;">' + money(f.gross_amount) + '</td>' +
                '<td><span class="atl-badge ' + (KIND_BADGE[f.kind] || '') + '">' + esc(KIND_LABEL[f.kind] || f.kind) + '</span><div class="pfs-detail">' + esc(f.detail || '') + '</div>' +
                    (!isOpen && f.resolution_note && f.kind !== 'recovered' ? '<div class="pfs-sub2">Dealt with ' + esc(when(f.resolved_at)) + ': ' + esc(f.resolution_note) + '</div>' : '') + '</td>' +
                '<td class="pfs-act">' + (isOpen ? '<button type="button" class="atl-btn atl-btn--ghost pfs-resolve-open" data-id="' + f.id + '">Mark dealt with</button>' : '<span class="pfs-sub2">Dealt with</span>') + '</td>' +
                '</tr>';
        });
        $w.html(h + '</tbody></table></div>');
    }

    function load() {
        if (!$('#pfSafetyPanel').length) return $.Deferred().resolve().promise();
        return call('GET', '/api/admin/payfast/reconcile').then(function (r) {
            if (!r.ok) {
                $('#pfsStatus').html('<span class="pfs-problem">' + esc(r.status === 403 ? 'Only administrators and managers can see the PayFast safety net.' : (r.json.message || 'Could not load the PayFast safety net.')) + '</span>');
                $('#pfsRunBtn, #pfsDryBtn').prop('disabled', true);
                $('#pfsFindings').empty();
                return;
            }
            renderStatus(r.json.status || {});
            renderFindings(r.json.findings || []);
        }).catch(function () { $('#pfsStatus').html('<span class="pfs-problem">Could not load the PayFast safety net.</span>'); });
    }

    function showResult(kind, html) {
        $('#pfsResult').attr('class', 'pfs-result is-shown is-' + kind).html(html);
    }

    function run(dry) {
        if (busy) return;
        busy = true;
        $('#pfsRunBtn, #pfsDryBtn').prop('disabled', true);
        showResult('ok', dry ? 'Looking at PayFast (nothing will be changed)…' : 'Asking PayFast…');
        call('POST', '/api/admin/payfast/reconcile/run', { dry_run: !!dry }).then(function (r) {
            var j = r.json;
            if (r.status === 409) { showResult('warn', esc(j.message || 'A check is already running.')); return; }
            if (!r.ok) { showResult('bad', esc(j.message || 'PayFast could not be read.') + (j.error ? ' (' + esc(j.error) + ')' : '')); return; }
            var rec = j.recovered || [], fnd = j.findings || [];
            if (j.skipped) { showResult('warn', esc(j.message || 'Nothing was checked.')); return; }
            if (!j.checked) { showResult('ok', 'No payment is waiting to be confirmed, so there was nothing to look for.'); return; }
            var h = '<strong>' + (dry ? 'Preview: ' : '') + j.checked + ' payment attempt(s) checked against PayFast\'s records.</strong>';
            var items = [];
            rec.forEach(function (x) { items.push((dry ? 'Would record ' : 'Recorded ') + money(x.amount) + ' on booking #' + x.bookingId + ' (PayFast payment ' + esc(x.pfPaymentId) + ').'); });
            fnd.forEach(function (x) { items.push(esc(KIND_LABEL[x.kind] || x.kind) + ' - booking #' + x.bookingId + ': ' + esc(x.detail)); });
            if (items.length) h += '<ul><li>' + items.join('</li><li>') + '</li></ul>'; else h += ' PayFast has not reported a payment for any of them yet.';
            showResult(fnd.length ? 'warn' : 'ok', h);
            if (!dry && rec.length) toast('showSuccess', 'PayFast', rec.length + ' payment(s) recorded.');
        }).catch(function () { showResult('bad', 'Could not reach the website. Try again.'); })
          .then(function () { busy = false; return load(); });
    }

    function openResolve($btn) {
        var id = $btn.data('id');
        $btn.closest('td').html('<div class="pfs-resolve"><input type="text" class="atl-input pfs-note" maxlength="300" placeholder="What was done? (e.g. refunded the extra)" aria-label="What was done">' +
            '<button type="button" class="atl-btn atl-btn--primary pfs-resolve-save" data-id="' + id + '">Save</button>' +
            '<button type="button" class="atl-btn atl-btn--ghost pfs-resolve-cancel">Cancel</button></div>');
    }
    function saveResolve($btn) {
        var $row = $btn.closest('tr'), note = $.trim($row.find('.pfs-note').val());
        if (note.length < 3) { toast('showError', 'PayFast', 'Write a few words on what was done.'); return; }
        $btn.prop('disabled', true);
        call('POST', '/api/admin/payfast/reconcile/findings/' + encodeURIComponent($btn.data('id')) + '/resolve', { note: note }).then(function (r) {
            if (r.ok) toast('showSuccess', 'PayFast', 'Marked as dealt with.'); else toast('showError', 'PayFast', r.json.message || 'Could not save.');
            return load();
        }).catch(function () { toast('showError', 'PayFast', 'Could not save.'); $btn.prop('disabled', false); });
    }

    $(document).on('click', '#finTabBar .atl-tab-btn[data-um-tab="finReconciliation"]', load);
    $(document).on('click', '#pfsRefreshBtn', load);
    $(document).on('click', '#pfsRunBtn', function () { run(false); });
    $(document).on('click', '#pfsDryBtn', function () { run(true); });
    $(document).on('click', '.pfs-resolve-open', function () { openResolve($(this)); });
    $(document).on('click', '.pfs-resolve-cancel', load);
    $(document).on('click', '.pfs-resolve-save', function () { saveResolve($(this)); });
    $(document).on('keydown', '.pfs-note', function (e) { if (e.key === 'Enter') { e.preventDefault(); $(this).closest('tr').find('.pfs-resolve-save').click(); } });

    window.payfastReconcile = { load: load };
})();
