/* Phase 6 (HOUSEKEEPING-NOTES.md "Section 21 / Bookings sub-batch: Contract Management"):
 * relocated VERBATIM from admin.html’s big Bookings inline <script> (was lines ~15865-16101) —
 * the Contract Management drawer: renderContractStatus (status card), the send / remind /
 * open-drawer / upload / mark-signed / download handlers (all $(document).off().on() delegated or
 * $('#id').off().on(), i.e. idempotent), and two IIFEs (drag&drop, reset-on-close MutationObserver).
 *
 * renderContractStatus stays a bare function declaration (implicit global, as in the original) —
 * its one external caller (admin.html deal-view, typeof-guarded, async) still reaches it.
 *
 * LOAD POSITION: this <script src> sits immediately after the big Bookings <script> and BEFORE the
 * #contractDrawer / #contractDropZone markup (admin.html ~19720). That is deliberate: in the
 * ORIGINAL, this code also ran before that markup existed, so the two IIFEs both hit their
 * `if (!el) return` guard and no-op (drag&drop + reset-on-close are pre-existing dead code).
 * Loading this file later would silently ACTIVATE them — a behaviour change, not housekeeping —
 * see HOUSEKEEPING-NOTES.md "Deferred fixes". */
    // ─── Contract Management ───    // ─── Contract Management ───

    // Helper: render the status card
    function renderContractStatus(c) {
        if (!c) {
            $('#contractCurrentStatus').html('<span style="color: var(--atl-muted);"><i class="fa-solid fa-file-circle-question" style="margin-right:6px;"></i>No contract on file for this booking.</span>');
            $('#contractSignForm, #contractDownloadBtn, #contractSendBtn').hide();
            return;
        }
        const statusMap = {
            draft:  { color: '#aaa',     icon: 'fa-solid fa-file',          label: 'Draft' },
            sent:   { color: '#2196F3',  icon: 'fa-solid fa-paper-plane',    label: 'Sent to Client' },
            signed: { color: 'var(--atl-green)',  icon: 'fa-solid fa-circle-check',  label: 'Signed ✓' }
        };
        const s = statusMap[c.status] || statusMap.draft;
        let html = `
            <div style="display:flex;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:8px;">
                <div>
                    <i class="fa-solid fa-file-pdf" style="color:var(--atl-clay);margin-right:8px;"></i>
                    <span style="font-weight:600;color: var(--atl-ink);">${c.pdf_url || 'contract.pdf'}</span>
                    ${c.uploaded_by ? `<span style="color:#666;font-size:11px;margin-left:8px;">Uploaded by ${c.uploaded_by}</span>` : ''}
                </div>
                <span style="background:rgba(${s.color === '#4CAF50' ? '76,175,80' : s.color === '#2196F3' ? '33,150,243' : '180,180,180'},0.15);color:${s.color};border:1px solid ${s.color};padding:3px 10px;border-radius:20px;font-size:11px;font-weight:700;text-transform:uppercase;">
                    <i class="${s.icon}" style="margin-right:4px;"></i>${s.label}
                </span>
            </div>`;
        if (c.signed_by_client_at) html += `<div style="font-size:12px;color: var(--atl-muted);margin-top:8px;"><i class="fa-solid fa-user-check" style="margin-right:5px;color:var(--atl-green);"></i>Client signed online on ${new Date(c.signed_by_client_at).toLocaleDateString('en-ZA', {day:'2-digit',month:'short',year:'numeric'})}${c.status !== 'signed' ? ' &mdash; awaiting your countersignature' : ''}</div>`;
        if (c.signed_by) html += `<div style="font-size:12px;color: var(--atl-muted);margin-top:8px;"><i class="fa-solid fa-signature" style="margin-right:5px;color:var(--atl-green);"></i>Signed by <strong style="color: var(--atl-ink-dim);">${c.signed_by}</strong>${c.signed_date ? ` on ${new Date(c.signed_date).toLocaleDateString('en-ZA', {day:'2-digit',month:'short',year:'numeric'})}` : ''}</div>`;
        if (c.created_at) html += `<div style="font-size:11px;color:#555;margin-top:4px;"><i class="fa-regular fa-clock" style="margin-right:4px;"></i>Uploaded ${new Date(c.created_at).toLocaleDateString('en-ZA')}</div>`;
        $('#contractCurrentStatus').html(html);
        $('#contractDownloadBtn').show();
        if (c.status !== 'signed') {
            $('#contractSignForm').show();
            $('#contractRemindBtn').show();
            // Send-to-client is the delivery step; offer it while the contract isn't finalised.
            $('#contractSendBtn').show().html('<i class="fa-solid fa-paper-plane" style="margin-right:5px;"></i>' + (c.status === 'draft' ? 'Send to client' : 'Re-send to client'));
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
        $btn.prop('disabled', true).html('<i class="fa-solid fa-spinner fa-spin"></i> Sending…');
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
        $btn.prop('disabled', false).html('<i class="fa-solid fa-paper-plane" style="margin-right:5px;"></i>Send to client');
    });

    // Gap 8: Send contract signature reminder email
    $(document).off('click.bkcontractremind').on('click.bkcontractremind', '#contractRemindBtn', async function() {
        const id = $('#contractBookingId').val();
        if (!id) return;
        $(this).prop('disabled', true).html('<i class="fa-solid fa-spinner fa-spin"></i> Sending…');
        try {
            const r = await fetch('/api/admin/bookings/' + id + '/contract/remind', { method: 'POST', credentials: 'include' });
            const d = await r.json();
            if (d.success) window.notificationService.showSuccess('Reminder Sent', 'Contract reminder email sent to client.');
            else window.notificationService.showError('Failed to send reminder: ' + (d.message || ''));
        } catch(e) { window.notificationService.showError('Failed to send reminder.'); }
        $(this).prop('disabled', false).html('<i class="fa-solid fa-bell"></i> Send Reminder');
    });

    // Open modal
    $(document).off('click.bkcontract').on('click.bkcontract', '.bk-action-contract', async function() {
        const id = $(this).data('id');
        $('#contractBookingId').val(id);
        $('#contractFileInput').val('');
        $('#contractFilePreview').hide();
        $('#contractModalMsg').text('');
        $('#contractSignMsg').text('');
        $('#contractSignatoryName').val('');
        $('#contractSignedDate').val(new Date().toISOString().split('T')[0]);
        $('#contractDownloadBtn').hide();
        $('#contractSignForm').hide();
        $('#contractCurrentStatus').html('<i class="fa-solid fa-spinner fa-spin"></i> Loading…');
        openAtlDrawer('contractDrawer');

        try {
            const r = await fetch('/api/admin/bookings/' + id + '/contract', { credentials: 'include' });
            const d = await r.json();
            renderContractStatus(d.contract || null);
        } catch(e) {
            $('#contractCurrentStatus').html('<span style="color:var(--atl-clay);"><i class="fa-solid fa-triangle-exclamation" style="margin-right:6px;"></i>Failed to load contract info.</span>');
        }
    });

    // Drag & Drop handling
    (function() {
        const zone = document.getElementById('contractDropZone');
        if (!zone) return;
        zone.addEventListener('dragover', function(e) {
            e.preventDefault();
            zone.style.borderColor = 'var(--atl-amber)';
            zone.style.background = 'rgba(212,175,55,0.06)';
        });
        zone.addEventListener('dragleave', function() {
            zone.style.borderColor = '#333';
            zone.style.background = '#0d0d0d';
        });
        zone.addEventListener('drop', function(e) {
            e.preventDefault();
            zone.style.borderColor = '#333';
            zone.style.background = '#0d0d0d';
            const files = e.dataTransfer.files;
            if (files.length) {
                const input = document.getElementById('contractFileInput');
                const dt = new DataTransfer();
                dt.items.add(files[0]);
                input.files = dt.files;
                $(input).trigger('change');
            }
        });
        zone.addEventListener('click', function(e) {
            if (!e.target.closest('a, span, input')) document.getElementById('contractFileInput').click();
        });
    })();

    $('#contractFileInput').off('change').on('change', function() {
        const file = this.files[0];
        if (!file) { $('#contractFilePreview').hide(); return; }
        $('#contractFileName').text(file.name);
        $('#contractFileSize').text('(' + (file.size / 1024).toFixed(0) + ' KB)');
        $('#contractFilePreview').show();
        $('#contractModalMsg').text('');
    });

    // Upload
    $('#contractUploadBtn').off('click').on('click', async function() {
        const id   = $('#contractBookingId').val();
        const file = $('#contractFileInput')[0].files[0];
        if (!file) {
            $('#contractModalMsg').css('color','var(--atl-clay)').html('<i class="fa-solid fa-triangle-exclamation" style="margin-right:5px;"></i>Please select a PDF file first.');
            return;
        }
        if (file.type !== 'application/pdf') {
            $('#contractModalMsg').css('color','var(--atl-clay)').html('<i class="fa-solid fa-triangle-exclamation" style="margin-right:5px;"></i>Only PDF files are accepted.');
            return;
        }
        const $btn = $(this);
        $btn.prop('disabled', true).html('<i class="fa-solid fa-spinner fa-spin" style="margin-right:6px;"></i>Uploading…');
        const fd = new FormData();
        fd.append('contract_file', file);
        try {
            const r = await fetch('/api/admin/bookings/' + id + '/contract', { method: 'POST', credentials: 'include', body: fd });
            const d = await r.json();
            if (d.success) {
                $('#contractModalMsg').css('color','var(--atl-sage)').html('<i class="fa-solid fa-circle-check" style="margin-right:5px;"></i>Contract uploaded successfully.');
                $('#contractFilePreview').hide();
                $('#contractFileInput').val('');
                // Refresh status
                const r2 = await fetch('/api/admin/bookings/' + id + '/contract', { credentials: 'include' });
                const d2 = await r2.json();
                renderContractStatus(d2.contract || null);
            } else {
                $('#contractModalMsg').css('color','var(--atl-clay)').html('<i class="fa-solid fa-triangle-exclamation" style="margin-right:5px;"></i>' + (d.message || 'Upload failed.'));
            }
        } catch(e) {
            $('#contractModalMsg').css('color','var(--atl-clay)').text('Network error. Please try again.');
        } finally {
            $btn.prop('disabled', false).html('<i class="fa-solid fa-cloud-upload-alt" style="margin-right:6px;"></i>Upload Contract');
        }
    });

    // Mark as Signed
    $('#contractConfirmSignBtn').off('click').on('click', async function() {
        const id  = $('#contractBookingId').val();
        const sName = $('#contractSignatoryName').val().trim();
        const sDate = $('#contractSignedDate').val();
        if (!sName) {
            $('#contractSignMsg').css('color','var(--atl-clay)').text('Please enter the signatory full name.');
            return;
        }
        const $btn = $(this);
        $btn.prop('disabled', true).html('<i class="fa-solid fa-spinner fa-spin" style="margin-right:6px;"></i>Saving…');
        try {
            const r = await fetch('/api/admin/bookings/' + id + '/contract/sign', {
                method: 'PUT', credentials: 'include',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ signatory_name: sName, signed_date: sDate })
            });
            const d = await r.json();
            if (d.success) {
                $('#contractSignMsg').css('color','var(--atl-sage)').text('');
                $('#contractModalMsg').css('color','var(--atl-sage)').html('<i class="fa-solid fa-circle-check" style="margin-right:5px;"></i>Contract marked as signed.');
                // Refresh
                const r2 = await fetch('/api/admin/bookings/' + id + '/contract', { credentials: 'include' });
                const d2 = await r2.json();
                renderContractStatus(d2.contract || null);
            } else {
                $('#contractSignMsg').css('color','var(--atl-clay)').text(d.message || 'Failed to mark as signed.');
            }
        } catch(e) {
            $('#contractSignMsg').css('color','var(--atl-clay)').text('Network error. Please try again.');
        } finally {
            $btn.prop('disabled', false).html('<i class="fa-solid fa-circle-check" style="margin-right:6px;"></i>Confirm & Mark as Signed');
        }
    });

    // Download
    $('#contractDownloadBtn').off('click').on('click', function() {
        const id = $('#contractBookingId').val();
        window.location.href = '/api/admin/bookings/' + id + '/contract/download';
    });

    // Reset contract drawer on close
    (function() {
        var _contractDrawerEl = document.getElementById('contractDrawer');
        if (!_contractDrawerEl) return;
        new MutationObserver(function(mutations) {
            mutations.forEach(function(m) {
                if (m.attributeName === 'class' && !_contractDrawerEl.classList.contains('atl-drawer--open')) {
                    $('#contractFileInput').val('');
                    $('#contractFilePreview').hide();
                    $('#contractModalMsg').text('');
                    $('#contractSignMsg').text('');
                    $('#contractSignatoryName').val('');
                    $('#contractSignForm').hide();
                    $('#contractDownloadBtn').hide();
                }
            });
        }).observe(_contractDrawerEl, { attributes: true });
    })();
