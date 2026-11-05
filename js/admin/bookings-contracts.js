/* Contract Management drawer (#contractDrawer): the status panel (renderContractStatus), and the send / remind / open / upload / mark-signed / download
 * handlers, the drag-and-drop zone and the reset-on-close. Relocated from admin.html's big Bookings inline script in Phase 6 (HOUSEKEEPING-NOTES.md), now in the
 * admin drawer kit's building blocks (css/admin/drawer-kit.css, js/admin/drawer-kit.js dkMessage).
 *
 * renderContractStatus stays a bare function declaration (an implicit global): its one external caller (the Deal View, typeof-guarded, async) reaches it.
 *
 * WHY EVERYTHING IS DELEGATED OR WAITS FOR THE PAGE: this <script src> sits BEFORE the #contractDrawer markup in admin.html. The Upload, Confirm-signed,
 * Download and file-picker buttons used to be bound directly ($('#contractUploadBtn').on(...)) at load, when those elements did not exist yet, so they attached
 * to nothing: in the live admin none of those four buttons did anything, the drop zone never worked, and the reset-on-close never ran (only Send, Remind and
 * the opener, which were already delegated, did). They are now delegated from document, and the drop zone + reset use delegation / DOM ready, so they work. */

    // ─── Contract Management ───
    const ctDec = (v) => (window.decodeStoredText ? window.decodeStoredText(v == null ? '' : String(v)) : String(v == null ? '' : v));   // stored text is entity-encoded once
    const ctDate = (d, opts) => new Date(d).toLocaleDateString('en-ZA', opts || { day: '2-digit', month: 'short', year: 'numeric' });
    const ctRow = (label, $value) => $('<div class="dk-row"></div>').append($('<dt class="dk-k"></dt>').text(label)).append($('<dd class="dk-v"></dd>').append($value));
    const ctText = (t) => $('<span class="dk-v--plain"></span>').text(t);
    const CT_ACTION_BTNS = '#contractSignForm, #contractDownloadBtn, #contractSendBtn, #contractRemindBtn';

    // Helper: render the status panel (text nodes only: a file name or a person's name can never become markup)
    function renderContractStatus(c) {
        const $box = $('#contractCurrentStatus').empty();
        if (!c) {
            $box.append($('<div class="dk-empty"></div>').append($('<i class="fa-solid fa-file-circle-question" aria-hidden="true"></i>')).append(document.createTextNode(' No contract on file for this booking.')));
            $(CT_ACTION_BTNS).hide();
            return;
        }
        const statusMap = {
            draft:  { variant: 'neutral', icon: 'fa-file',         label: 'Draft' },
            sent:   { variant: 'info',    icon: 'fa-paper-plane',  label: 'Sent to client' },
            signed: { variant: 'ok',      icon: 'fa-circle-check', label: 'Signed' }
        };
        const s = statusMap[c.status] || statusMap.draft;
        const $rows = $('<dl class="dk-rows"></dl>');
        $rows.append(ctRow('File', $('<span></span>').text(c.pdf_url || 'contract.pdf')));
        $rows.append(ctRow('Status', $('<span class="dk-badge dk-badge--' + s.variant + '"></span>').append($('<i class="fa-solid ' + s.icon + '" aria-hidden="true"></i>')).append(document.createTextNode(' ' + s.label))));
        if (c.created_at) $rows.append(ctRow('Uploaded', ctText(ctDate(c.created_at, undefined) + (c.uploaded_by ? ' by ' + ctDec(c.uploaded_by) : ''))));
        if (c.signed_by_client_at) $rows.append(ctRow('Client signed online', ctText(ctDate(c.signed_by_client_at) + (c.status !== 'signed' ? ' — awaiting your countersignature' : ''))));
        if (c.signed_by) $rows.append(ctRow('Signed by', ctText(ctDec(c.signed_by) + (c.signed_date ? ' on ' + ctDate(c.signed_date) : ''))));
        $box.append($rows);
        $('#contractDownloadBtn').show();
        if (c.status !== 'signed') {
            $('#contractSignForm').show();
            $('#contractRemindBtn').show();
            // Send-to-client is the delivery step; offer it while the contract isn't finalised.
            $('#contractSendBtn').show().html('<i class="fa-solid fa-paper-plane" aria-hidden="true"></i> ' + (c.status === 'draft' ? 'Send to client' : 'Re-send to client'));
        } else {
            $('#contractSignForm').hide();
            $('#contractRemindBtn').hide();
            $('#contractSendBtn').hide();
        }
    }

    // Send the contract to the client for online signing (advances draft -> sent)
    $(document).off('click.bkcontractsend').on('click.bkcontractsend', '#contractSendBtn', async function() {
        const id = $('#contractBookingId').val();
        if (!id) return;
        const $btn = $(this);
        $btn.prop('disabled', true).html('<i class="fa-solid fa-spinner fa-spin" aria-hidden="true"></i> Sending…');
        try {
            const r = await fetch('/api/admin/bookings/' + id + '/contract/send', { method: 'POST', credentials: 'include' });
            const d = await r.json();
            if (r.ok && d.success) {
                window.notificationService.showSuccess('Contract Sent', 'The client can now review and sign it online.');
                if (typeof window.loadContractForBooking === 'function') window.loadContractForBooking(id);
                else { const cr = await fetch('/api/admin/bookings/' + id + '/contract', { credentials: 'include' }); const cj = await cr.json(); renderContractStatus(cj.contract); }
            } else {
                window.notificationService.showError('Failed to send contract: ' + (d.message || ''));
            }
        } catch(e) { window.notificationService.showError('Failed to send contract.'); }
        $btn.prop('disabled', false).html('<i class="fa-solid fa-paper-plane" aria-hidden="true"></i> Send to client');
    });

    // Gap 8: Send contract signature reminder email
    $(document).off('click.bkcontractremind').on('click.bkcontractremind', '#contractRemindBtn', async function() {
        const id = $('#contractBookingId').val();
        if (!id) return;
        $(this).prop('disabled', true).html('<i class="fa-solid fa-spinner fa-spin" aria-hidden="true"></i> Sending…');
        try {
            const r = await fetch('/api/admin/bookings/' + id + '/contract/remind', { method: 'POST', credentials: 'include' });
            const d = await r.json();
            if (d.success) window.notificationService.showSuccess('Reminder Sent', 'Contract reminder email sent to client.');
            else window.notificationService.showError('Failed to send reminder: ' + (d.message || ''));
        } catch(e) { window.notificationService.showError('Failed to send reminder.'); }
        $(this).prop('disabled', false).html('<i class="fa-solid fa-bell" aria-hidden="true"></i> Send reminder');
    });

    // Puts the drawer back to a clean state (used when it opens and when it closes)
    function resetContractDrawer() {
        $('#contractFileInput').val('');
        $('#contractFilePreview').hide();
        $('#contractDropZone').removeClass('is-over');
        dkMessage('#contractModalMsg', '', '');
        dkMessage('#contractSignMsg', '', '');
        $('#contractSignatoryName').val('');
        $(CT_ACTION_BTNS).hide();   // includes Remind, which used to stay visible from the previous booking
    }

    // Open modal
    $(document).off('click.bkcontract').on('click.bkcontract', '.bk-action-contract', async function() {
        const id = $(this).data('id');
        resetContractDrawer();
        $('#contractBookingId').val(id);
        $('#contractSignedDate').val(new Date().toISOString().split('T')[0]);
        $('#contractCurrentStatus').html('<div class="dk-empty"><i class="fa-solid fa-spinner fa-spin" aria-hidden="true"></i> Loading…</div>');
        openAtlDrawer('contractDrawer');

        try {
            const r = await fetch('/api/admin/bookings/' + id + '/contract', { credentials: 'include' });
            const d = await r.json();
            renderContractStatus(d.contract || null);
        } catch(e) {
            $('#contractCurrentStatus').html('<div class="dk-empty dk-empty--bad"><i class="fa-solid fa-triangle-exclamation" aria-hidden="true"></i> Failed to load contract info.</div>');
        }
    });

    // Drag & drop, and clicking the zone, to choose the PDF (delegated: the zone is not on the page yet when this file loads)
    $(document).off('.bkcdz');
    $(document).on('dragenter.bkcdz dragover.bkcdz', '#contractDropZone', function(e) { e.preventDefault(); $(this).addClass('is-over'); });
    $(document).on('dragleave.bkcdz', '#contractDropZone', function() { $(this).removeClass('is-over'); });
    $(document).on('drop.bkcdz', '#contractDropZone', function(e) {
        e.preventDefault();
        $(this).removeClass('is-over');
        const files = e.originalEvent && e.originalEvent.dataTransfer && e.originalEvent.dataTransfer.files;
        if (files && files.length) {
            const input = document.getElementById('contractFileInput');
            const dt = new DataTransfer();
            dt.items.add(files[0]);
            input.files = dt.files;
            $(input).trigger('change');
        }
    });
    $(document).on('click.bkcdz', '#contractDropZone', function(e) {
        if (!$(e.target).closest('input').length) document.getElementById('contractFileInput').click();
    });
    $(document).on('keydown.bkcdz', '#contractDropZone', function(e) {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); document.getElementById('contractFileInput').click(); }
    });

    // The chosen file
    $(document).off('change.bkcontractfile').on('change.bkcontractfile', '#contractFileInput', function() {
        const file = this.files[0];
        if (!file) { $('#contractFilePreview').hide(); return; }
        $('#contractFileName').text(file.name);
        $('#contractFileSize').text('(' + (file.size / 1024).toFixed(0) + ' KB)');
        $('#contractFilePreview').show();
        dkMessage('#contractModalMsg', '', '');
    });
    $(document).off('click.bkcontractclear').on('click.bkcontractclear', '#contractFileClear', function(e) {
        e.preventDefault();
        $('#contractFileInput').val('');
        $('#contractFilePreview').hide();
    });

    // Upload
    $(document).off('click.bkcontractupload').on('click.bkcontractupload', '#contractUploadBtn', async function() {
        const id   = $('#contractBookingId').val();
        const file = $('#contractFileInput')[0].files[0];
        if (!file) {
            dkMessage('#contractModalMsg', 'bad', 'Please select a PDF file first.');
            return;
        }
        if (file.type !== 'application/pdf') {
            dkMessage('#contractModalMsg', 'bad', 'Only PDF files are accepted.');
            return;
        }
        const $btn = $(this);
        $btn.prop('disabled', true).html('<i class="fa-solid fa-spinner fa-spin" aria-hidden="true"></i> Uploading…');
        const fd = new FormData();
        fd.append('contract_file', file);
        try {
            const r = await fetch('/api/admin/bookings/' + id + '/contract', { method: 'POST', credentials: 'include', body: fd });
            const d = await r.json();
            if (d.success) {
                dkMessage('#contractModalMsg', 'ok', 'Contract uploaded successfully.');
                $('#contractFilePreview').hide();
                $('#contractFileInput').val('');
                // Refresh status
                const r2 = await fetch('/api/admin/bookings/' + id + '/contract', { credentials: 'include' });
                const d2 = await r2.json();
                renderContractStatus(d2.contract || null);
            } else {
                dkMessage('#contractModalMsg', 'bad', d.message || 'Upload failed.');
            }
        } catch(e) {
            dkMessage('#contractModalMsg', 'bad', 'Network error. Please try again.');
        } finally {
            $btn.prop('disabled', false).html('<i class="fa-solid fa-cloud-arrow-up" aria-hidden="true"></i> Upload contract');
        }
    });

    // Mark as Signed
    $(document).off('click.bkcontractsign').on('click.bkcontractsign', '#contractConfirmSignBtn', async function() {
        const id  = $('#contractBookingId').val();
        const sName = $('#contractSignatoryName').val().trim();
        const sDate = $('#contractSignedDate').val();
        if (!sName) {
            dkMessage('#contractSignMsg', 'bad', 'Please enter the signatory full name.');
            return;
        }
        const $btn = $(this);
        $btn.prop('disabled', true).html('<i class="fa-solid fa-spinner fa-spin" aria-hidden="true"></i> Saving…');
        try {
            const r = await fetch('/api/admin/bookings/' + id + '/contract/sign', {
                method: 'PUT', credentials: 'include',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ signatory_name: sName, signed_date: sDate })
            });
            const d = await r.json();
            if (d.success) {
                dkMessage('#contractSignMsg', '', '');
                dkMessage('#contractModalMsg', 'ok', 'Contract marked as signed.');
                // Refresh
                const r2 = await fetch('/api/admin/bookings/' + id + '/contract', { credentials: 'include' });
                const d2 = await r2.json();
                renderContractStatus(d2.contract || null);
            } else {
                // Two-party signing: the client signs online first, the admin countersigns. The server's own text for this case talks about an API flag
                // ({ force: true }), which means nothing to an admin, so say what to do instead.
                dkMessage('#contractSignMsg', 'bad', d.requires_client_signature
                    ? 'The client has not signed this contract online yet. Use "Send to client" first; once they have signed, you can countersign here.'
                    : (d.message || 'Failed to mark as signed.'));
            }
        } catch(e) {
            dkMessage('#contractSignMsg', 'bad', 'Network error. Please try again.');
        } finally {
            $btn.prop('disabled', false).html('<i class="fa-solid fa-circle-check" aria-hidden="true"></i> Confirm &amp; mark as signed');
        }
    });

    // Download
    $(document).off('click.bkcontractdl').on('click.bkcontractdl', '#contractDownloadBtn', function() {
        const id = $('#contractBookingId').val();
        window.location.href = '/api/admin/bookings/' + id + '/contract/download';
    });

    // Reset the drawer whenever it closes (looked up once the page is parsed: the markup sits below this script)
    $(function() {
        var _contractDrawerEl = document.getElementById('contractDrawer');
        if (!_contractDrawerEl) return;
        new MutationObserver(function(mutations) {
            mutations.forEach(function(m) {
                if (m.attributeName === 'class' && !_contractDrawerEl.classList.contains('atl-drawer--open')) resetContractDrawer();
            });
        }).observe(_contractDrawerEl, { attributes: true });
    });
