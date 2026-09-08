/* Phase 6 (HOUSEKEEPING-NOTES.md): relocated from admin.html verbatim — the ENTIRE "Legal &
   Compliance Centre" module (Privacy Policy/Terms/Cookie Policy draft-save & publish, version
   restore, Consent Audit with CSV export, Contract Registry with a "View Booking"/"Send
   Contract" bridge into Bookings, and Version History). Moved as one atomic unit, kept wrapped
   in its own original (function () {...})();.

   CORRECTION (see HOUSEKEEPING-NOTES.md): this module's own IIFE is self-contained (shares no
   state with the larger initFinanceManagement closure it physically sat inside), which was
   correctly verified before this move — but that fact only means the REMOVED content needed no
   cross-reference checking. It does NOT mean the surrounding initFinanceManagement <script> tag
   is safe to same-position-split around it — that tag still needed the reunite-and-relocate
   pattern like every other piece pulled from this same closure (Services/Policies/Branding/
   Security & Audit/System Settings/Financials). A first attempt used a same-position split and
   broke initFinanceManagement's own tag into two unparseable halves; caught immediately,
   reverted, and redone correctly here — this file's <script src> tag sits before the whole
   initFinanceManagement block instead, alongside the six already there.

   Verified before this move: the isolated IIFE parses standalone; every externally-called
   function (saveLegalDraft, publishLegalDocument, lcActivateTab, exportConsentCsv, etc.) is
   called from markup onclick="" attributes, already window-attached; loadLegalOverview is
   called via a typeof guard from initFinanceManagement's own tab-bootstrap code — already safe
   since it's window-attached. lcViewBooking calls window.toggleBookingDetail(...) via a typeof
   guard, a cross-reference into deferred Bookings territory (see the Bookings reconnaissance
   entry) — already safe (window-prefixed on both ends), no Bookings code touched by this move. */

    (function () {
        if (typeof window.formatDate !== 'function') {
            window.formatDate = function (dateStr) {
                if (!dateStr) return '—';
                var d = new Date(dateStr);
                return isNaN(d.getTime()) ? dateStr :
                    (d.toLocaleDateString('en-ZA', { day: '2-digit', month: 'short', year: 'numeric' }) +
                     ' ' + d.toLocaleTimeString('en-ZA', { hour: '2-digit', minute: '2-digit' }));
            };
        }
        function esc(s) { return (window.escHtml ? window.escHtml(s) : String(s == null ? '' : s)); }
        function lcIsAdmin() { return window.currentUserRole === 'administrator'; }
        function lcDebounce(fn, ms) { var t; return function () { var a = arguments, c = this; clearTimeout(t); t = setTimeout(function () { fn.apply(c, a); }, ms); }; }

        // Activate a legal tab programmatically (quick actions + cross-links)
        window.lcActivateTab = function (panelId) {
            var btn = document.querySelector('#lcTabBar .atl-tab-btn[data-um-tab="' + panelId + '"]');
            if (btn) btn.click();
        };

        // Lazy-load each tab's data on activation (runs in addition to initTabs' panel switch)
        $(document).on('click', '#lcTabBar .atl-tab-btn', function () {
            switch (this.getAttribute('data-um-tab')) {
                case 'lcPanelOverview': loadLegalOverview(); break;
                case 'lcPanelPrivacy': lcInitEditor('privacy_policy'); break;
                case 'lcPanelTerms': lcInitEditor('terms_of_use'); break;
                case 'lcPanelCookie': lcInitEditor('cookie_policy'); break;
                case 'lcPanelConsentAudit': loadConsentAudit(true); break;
                case 'lcPanelContracts': loadLegalContracts(true); break;
                case 'lcPanelVersionHistory': loadLegalVersionHistory(); break;
            }
        });

        // ---- Document editors (Tabs 2/3/4) ----
        var LC_DOC = {
            privacy_policy: { panel: 'lcPanelPrivacy', editor: 'legalPrivacyEditor', quill: 'lcPrivacyQuill', init: 'lcPrivacyQuillInit', status: 'lcPrivacyStatus', meta: 'lcPrivacyMeta', versions: 'lcPrivacyVersions', summary: 'lcPrivacyChangeSummary' },
            terms_of_use:   { panel: 'lcPanelTerms',   editor: 'legalTermsEditor',   quill: 'lcTermsQuill',   init: 'lcTermsQuillInit',   status: 'lcTermsStatus',   meta: 'lcTermsMeta',   versions: 'lcTermsVersions',   summary: 'lcTermsChangeSummary' },
            cookie_policy:  { panel: 'lcPanelCookie',  editor: 'legalCookieEditor',  quill: 'lcCookieQuill',  init: 'lcCookieQuillInit',  status: 'lcCookieStatus',  meta: 'lcCookieMeta',  versions: 'lcCookieVersions',  summary: 'lcCookieChangeSummary' }
        };

        // Hide the write controls + lock the editor for non-administrators (legal writes are admin-only on the backend).
        function lcApplyEditorGating(cfg) {
            var admin = lcIsAdmin();
            if (window[cfg.quill]) window[cfg.quill].enable(admin);
            var panel = document.getElementById(cfg.panel);
            if (!panel) return;
            panel.querySelectorAll('button[onclick^="saveLegalDraft"], button[onclick^="publishLegalDocument"]').forEach(function (b) { b.style.display = admin ? '' : 'none'; });
            var sum = document.getElementById(cfg.summary); if (sum) sum.style.display = admin ? '' : 'none';
            var noticeId = cfg.panel + '-roNotice';
            var existing = document.getElementById(noticeId);
            if (!admin && !existing) {
                var host = document.getElementById(cfg.editor);
                var card = host && host.closest('.atl-card');
                if (card) {
                    var n = document.createElement('div');
                    n.id = noticeId; n.className = 'um-security-tips'; n.style.marginTop = '14px';
                    n.innerHTML = '<i class="fa-solid fa-lock"></i><span>Read-only — administrator access is required to edit legal documents.</span>';
                    card.appendChild(n);
                }
            } else if (admin && existing) { existing.remove(); }
        }
        var legalDocToolbar = [[{ header: [1, 2, 3, false] }], ['bold', 'italic', 'underline'], [{ list: 'ordered' }, { list: 'bullet' }], ['link', 'blockquote'], ['clean']];

        window.lcInitEditor = function (type) {
            var cfg = LC_DOC[type]; if (!cfg) return;
            if (!window[cfg.init]) {
                if (typeof Quill === 'undefined') { window.notificationService.showError('Editor library unavailable.'); return; }
                window[cfg.quill] = new Quill('#' + cfg.editor, { theme: 'snow', modules: { toolbar: legalDocToolbar } });
                window[cfg.init] = true;
            }
            loadLegalDocument(type);
        };

        function lcRenderMiniVersions(containerId, type, versions) {
            var host = document.getElementById(containerId);
            if (!host) return;
            if (!versions.length) { host.innerHTML = '<p class="text-muted" style="font-size:12px;">No versions yet.</p>'; return; }
            host.innerHTML = versions.map(function (v) {
                var badge = v.is_published == 1
                    ? '<span class="lc-doc-status lc-doc-status--published" style="padding:2px 8px;font-size:9px;">Published</span>'
                    : '<span class="lc-doc-status lc-doc-status--draft" style="padding:2px 8px;font-size:9px;">Draft</span>';
                var restoreBtn = lcIsAdmin() ? '<button class="um-btn um-btn--ghost um-btn--sm" onclick="restoreLegalVersion(\'' + type + '\',' + v.id + ')">Restore</button>' : '';
                return '<div class="lc-version-item"><div style="min-width:0;"><span class="lc-version-num">v' + esc(v.version_number) + '</span> ' + badge +
                    '<div class="lc-version-meta">' + formatDate(v.created_at) + '</div></div>' + restoreBtn + '</div>';
            }).join('');
        }

        window.loadLegalDocument = async function (type) {
            var cfg = LC_DOC[type]; if (!cfg) return;
            try {
                var r = await apiCall('/api/admin/legal/documents/' + type);
                if (!r || !r.success) throw new Error('load failed');
                var doc = r.document;
                if (window[cfg.quill]) window[cfg.quill].root.innerHTML = doc.current_content_html || '';
                var statusEl = document.getElementById(cfg.status);
                var published = doc.status === 'published';
                statusEl.textContent = published ? 'Published' : 'Draft';
                statusEl.className = 'lc-doc-status ' + (published ? 'lc-doc-status--published' : 'lc-doc-status--draft');
                document.getElementById(cfg.meta).textContent = 'Version ' + (doc.current_version_number || '—') +
                    (doc.last_published_by ? ' · by ' + doc.last_published_by : '') +
                    (doc.last_published_at ? ' · ' + formatDate(doc.last_published_at) : '');
                lcRenderMiniVersions(cfg.versions, type, (doc.versions || []).slice(0, 5));
                lcApplyEditorGating(cfg);
            } catch (e) { window.notificationService.showError('Could not load document.'); }
        };

        window.saveLegalDraft = async function (type) {
            var cfg = LC_DOC[type]; if (!cfg || !window[cfg.quill]) return;
            var content = window[cfg.quill].root.innerHTML;
            if (!content || !window[cfg.quill].getText().trim()) { window.notificationService.showError('Content cannot be empty.'); return; }
            var summary = (document.getElementById(cfg.summary).value || '').substring(0, 500);
            try {
                var r = await apiCall('/api/admin/legal/documents/' + type + '/draft', 'POST', { content_html: content, change_summary: summary });
                if (!r || !r.success) throw new Error('save failed');
                window.notificationService.showSuccess('Draft saved (version ' + r.version.version_number + ').');
                document.getElementById(cfg.summary).value = '';
                loadLegalDocument(type);
            } catch (e) { window.notificationService.showError('Could not save draft.'); }
        };

        window.publishLegalDocument = async function (type) {
            if (!(await window.notificationService.showConfirm({ message: 'Publish the latest version of this document? It becomes the live version.', isDestructive: false }))) return;
            try {
                var r = await apiCall('/api/admin/legal/documents/' + type + '/publish', 'POST', {});
                if (!r || !r.success) throw new Error('publish failed');
                window.notificationService.showSuccess('Published version ' + r.version_number + '.');
                loadLegalDocument(type);
            } catch (e) { window.notificationService.showError('Could not publish document.'); }
        };

        window.restoreLegalVersion = async function (type, versionId) {
            if (!(await window.notificationService.showConfirm({ message: 'Restore this version as a new draft? Your current content is kept as history.', isDestructive: false }))) return;
            try {
                var r = await apiCall('/api/admin/legal/documents/' + type + '/restore/' + versionId, 'POST', {});
                if (!r || !r.success) throw new Error('restore failed');
                window.notificationService.showSuccess('Restored as a new draft.');
                lcInitEditor(type);
                var vhPanel = document.getElementById('lcPanelVersionHistory');
                if (vhPanel && vhPanel.classList.contains('active')) loadLegalVersionHistory();
            } catch (e) { window.notificationService.showError('Could not restore version.'); }
        };

        // ---- Overview (Tab 1) ----
        window.loadLegalOverview = async function () {
            try {
                var r = await apiCall('/api/admin/legal/overview');
                if (!r || !r.success) throw new Error('overview failed');
                var s = r.stats || {};
                document.getElementById('lcStatDocs').textContent = s.active_documents != null ? s.active_documents : '—';
                document.getElementById('lcStatVersions').textContent = s.published_versions != null ? s.published_versions : '—';
                document.getElementById('lcStatConsent').textContent = s.total_consent_records != null ? s.total_consent_records : '—';
                document.getElementById('lcStatSigned').textContent = s.signed_contracts != null ? s.signed_contracts : '—';
                document.getElementById('lcStatDraft').textContent = s.draft_contracts != null ? s.draft_contracts : '—';
                var act = r.recent_activity || [];
                var host = document.getElementById('lcRecentActivity');
                host.innerHTML = act.length ? act.map(function (a) {
                    return '<div class="lc-version-item"><div style="min-width:0;"><span class="lc-version-num">v' + esc(a.version_number) + '</span> <strong style="color:var(--atl-ink);font-size:12px;">' + esc(a.title) + '</strong>' +
                        '<div class="lc-version-meta">' + (a.is_published == 1 ? 'Published' : 'Draft') + ' · ' + formatDate(a.created_at) + (a.change_summary ? ' · ' + esc(a.change_summary) : '') + '</div></div></div>';
                }).join('') : '<p class="text-muted">No recent activity.</p>';
            } catch (e) {
                ['lcStatDocs', 'lcStatVersions', 'lcStatConsent', 'lcStatSigned', 'lcStatDraft'].forEach(function (id) { var el = document.getElementById(id); if (el) el.textContent = '—'; });
                window.notificationService.showError('Could not load legal overview.');
            }
        };

        // ---- Consent Audit (Tab 5) ----
        var lcConsentPage = 1;
        window.loadConsentAudit = async function (reset) {
            if (reset) lcConsentPage = 1;
            var search = document.getElementById('lcConsentSearch').value || '';
            var type = document.getElementById('lcConsentType').value || 'all';
            var limit = document.getElementById('lcConsentLimit').value || 20;
            try {
                var r = await apiCall('/api/admin/legal/consent-audit?page=' + lcConsentPage + '&limit=' + limit + '&type=' + encodeURIComponent(type) + '&search=' + encodeURIComponent(search));
                if (!r || !r.success) throw new Error('consent failed');
                var tb = document.getElementById('lcConsentTable');
                if (!r.records.length) { tb.innerHTML = ''; document.getElementById('lcConsentEmpty').style.display = 'block'; }
                else {
                    document.getElementById('lcConsentEmpty').style.display = 'none';
                    tb.innerHTML = r.records.map(function (rec) {
                        return '<tr><td>' + rec.id + '</td><td>' + formatDate(rec.consented_at) + '</td>' +
                            '<td><span class="atl-badge atl-badge--info">' + esc(rec.consent_source || 'public_form') + '</span></td>' +
                            '<td>' + esc(rec.booking_name || '—') + '<br><small style="color:var(--atl-muted)">' + esc(rec.booking_email || rec.source_email || '—') + '</small></td>' +
                            '<td style="font-family:var(--atl-mono,monospace);font-size:11px;">' + esc(rec.ip_address || '—') + '</td>' +
                            '<td>' + esc(rec.consent_type || 'booking') + '</td><td>' + esc(rec.policy_version || '—') + '</td></tr>';
                    }).join('');
                }
                document.getElementById('lcConsentPageInfo').textContent = 'Page ' + r.page + ' of ' + (r.pages || 1) + ' · ' + r.total + ' records';
                document.getElementById('lcConsentPrev').disabled = r.page <= 1;
                document.getElementById('lcConsentNext').disabled = r.page >= (r.pages || 1);
            } catch (e) { window.notificationService.showError('Could not load consent records.'); }
        };
        window.exportConsentCsv = async function () {
            try {
                var type = document.getElementById('lcConsentType').value || 'all';
                var search = document.getElementById('lcConsentSearch').value || '';
                var r = await apiCall('/api/admin/legal/consent-audit?page=1&limit=10000&type=' + encodeURIComponent(type) + '&search=' + encodeURIComponent(search));
                if (!r || !r.success) throw new Error('export failed');
                var rows = [['ID', 'Date', 'Consent Type', 'Source', 'Name', 'Email', 'IP Address', 'Policy Version']];
                r.records.forEach(function (rec) { rows.push([rec.id, rec.consented_at, rec.consent_type || 'booking', rec.consent_source || '', rec.booking_name || '', rec.booking_email || rec.source_email || '', rec.ip_address || '', rec.policy_version || '']); });
                var csv = rows.map(function (row) { return row.map(function (c) { return '"' + String(c == null ? '' : c).replace(/"/g, '""') + '"'; }).join(','); }).join('\r\n');
                var blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
                var a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'consent-audit-' + new Date().toISOString().slice(0, 10) + '.csv';
                document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(a.href);
            } catch (e) { window.notificationService.showError('Export failed — try again or reduce the range.'); }
        };
        $(document).on('input', '#lcConsentSearch', lcDebounce(function () { loadConsentAudit(true); }, 300));
        $(document).on('change', '#lcConsentType, #lcConsentLimit', function () { loadConsentAudit(true); });
        $(document).on('click', '#lcConsentPrev', function () { if (lcConsentPage > 1) { lcConsentPage--; loadConsentAudit(); } });
        $(document).on('click', '#lcConsentNext', function () { lcConsentPage++; loadConsentAudit(); });

        // ---- Contract Registry (Tab 7) ----
        var lcContractPage = 1;
        window.loadLegalContracts = async function (reset) {
            if (reset) lcContractPage = 1;
            var search = document.getElementById('lcContractSearch').value || '';
            var status = document.getElementById('lcContractStatus').value || 'all';
            var limit = document.getElementById('lcContractLimit').value || 20;
            try {
                var r = await apiCall('/api/admin/legal/contracts?page=' + lcContractPage + '&limit=' + limit + '&status=' + encodeURIComponent(status) + '&search=' + encodeURIComponent(search));
                if (!r || !r.success) throw new Error('contracts failed');
                var tb = document.getElementById('lcContractsTbody');
                if (!r.contracts.length) { tb.innerHTML = ''; document.getElementById('lcContractsEmpty').style.display = 'block'; }
                else {
                    document.getElementById('lcContractsEmpty').style.display = 'none';
                    tb.innerHTML = r.contracts.map(function (c) {
                        var st = c.status === 'signed' ? '<span class="atl-badge atl-badge--confirmed">Signed</span>' : '<span class="atl-badge atl-badge--pending">' + esc(c.status || 'draft') + '</span>';
                        var client = c.client_name ? esc(c.client_name) : '<em style="color:var(--atl-muted)">Deleted Booking</em>';
                        var act = c.booking_id ? '<button class="um-btn um-btn--ghost um-btn--sm" onclick="lcViewBooking(' + c.booking_id + ')">View Booking</button>' : '—';
                        if (c.booking_id && c.pdf_url && c.status !== 'signed' && c.is_frozen !== 1) {
                            act += ' <button class="um-btn um-btn--ghost um-btn--sm" onclick="lcSendContract(' + c.booking_id + ', this)">' + (c.status === 'draft' ? 'Send' : 'Re-send') + '</button>';
                        }
                        // Booking/payment column exists to catch the exact risk this registry can't
                        // otherwise show: a booking that's moved past acceptance (or already fully
                        // paid — including via a client's own self-service deposit, which can
                        // auto-confirm with no admin click at all) while this contract is still
                        // unsigned. Flag that specific combination in clay; otherwise render plainly.
                        var bStatus = c.booking_status || '—';
                        var pStatus = c.booking_payment_status || '';
                        var payLblMap = { PAID: '✓ Paid', DEPOSIT_PAID: '◐ Deposit', PARTIALLY_PAID: '◑ Partial', UNPAID: '○ Unpaid' };
                        var payText = payLblMap[pStatus] || pStatus || '';
                        var riskyGap = ['ACCEPTED', 'CONFIRMED', 'COMPLETED'].includes(bStatus) && c.status !== 'signed' && c.is_frozen !== 1;
                        var bookingCell = '<span' + (riskyGap ? ' style="color:var(--atl-clay);font-weight:600;" title="Booking has moved past acceptance but this contract is not signed"' : '') + '>' + esc(bStatus) + (payText ? ' · ' + esc(payText) : '') + '</span>';
                        return '<tr><td>' + c.id + '</td><td>' + client + '<br><small style="color:var(--atl-muted)">' + esc(c.client_email || '') + '</small></td>' +
                            '<td>' + esc(c.event_name || '—') + '</td><td>' + (c.event_date ? formatDate(c.event_date) : '—') + '</td><td>' + st + '</td>' +
                            '<td>' + bookingCell + '</td>' +
                            '<td>' + esc(c.template_version || '—') + '</td><td>' + esc(c.signed_by || '—') + '</td><td>' + (c.signed_date ? formatDate(c.signed_date) : '—') + '</td><td>' + act + '</td></tr>';
                    }).join('');
                }
                document.getElementById('lcContractsPageInfo').textContent = 'Page ' + r.page + ' of ' + (r.pages || 1) + ' · ' + r.total + ' contracts';
                document.getElementById('lcContractsPrev').disabled = r.page <= 1;
                document.getElementById('lcContractsNext').disabled = r.page >= (r.pages || 1);
            } catch (e) { window.notificationService.showError('Could not load contracts.'); }
        };
        window.lcViewBooking = function (bookingId) {
            if (typeof switchTab === 'function') switchTab('bookingsAdmin');
            try { $('#bookingStatusFilter').val('All').trigger('change'); } catch (e) {}
            setTimeout(function () {
                if (typeof window.toggleBookingDetail === 'function') window.toggleBookingDetail(bookingId, true);
            }, 400);
        };
        // Emails the contract straight from the registry list — same route as the Deal View's
        // Send to Client button, so both surfaces share one source of truth (no duplicated logic).
        window.lcSendContract = async function (bookingId, btn) {
            var $btn = $(btn);
            var orig = $btn.html();
            $btn.prop('disabled', true).html('<i class="fa-solid fa-spinner fa-spin"></i>');
            try {
                var r = await apiCall('/api/admin/bookings/' + bookingId + '/contract/send', 'POST', {});
                if (r && r.success) {
                    window.notificationService.showSuccess('Contract sent — the client can now review and sign it online.');
                    loadLegalContracts();
                } else {
                    window.notificationService.showError((r && r.message) || 'Could not send the contract.');
                    $btn.prop('disabled', false).html(orig);
                }
            } catch (e) {
                window.notificationService.showError((e && e.message) || 'Could not send the contract.');
                $btn.prop('disabled', false).html(orig);
            }
        };
        $(document).on('input', '#lcContractSearch', lcDebounce(function () { loadLegalContracts(true); }, 300));
        $(document).on('change', '#lcContractStatus, #lcContractLimit', function () { loadLegalContracts(true); });
        $(document).on('click', '#lcContractsPrev', function () { if (lcContractPage > 1) { lcContractPage--; loadLegalContracts(); } });
        $(document).on('click', '#lcContractsNext', function () { lcContractPage++; loadLegalContracts(); });

        // ---- Version History (Tab 8) ----
        window.loadLegalVersionHistory = async function () {
            var type = document.getElementById('lcVhType').value || 'all';
            var host = document.getElementById('lcVhList');
            host.innerHTML = '<p class="text-muted">Loading…</p>';
            try {
                var types = type === 'all' ? ['privacy_policy', 'terms_of_use', 'cookie_policy'] : [type];
                var results = await Promise.all(types.map(function (t) { return apiCall('/api/admin/legal/documents/' + t + '/history').catch(function () { return { versions: [] }; }); }));
                var merged = [];
                results.forEach(function (res, i) { (res.versions || []).forEach(function (v) { v.__type = types[i]; merged.push(v); }); });
                merged.sort(function (a, b) { return new Date(b.created_at) - new Date(a.created_at); });
                var search = (document.getElementById('lcVhSearch').value || '').toLowerCase().trim();
                if (search) merged = merged.filter(function (v) { return (v.change_summary || '').toLowerCase().indexOf(search) !== -1 || String(v.version_number || '').toLowerCase().indexOf(search) !== -1; });
                if (!merged.length) { host.innerHTML = '<p class="text-muted">No versions found.</p>'; return; }
                var titles = { privacy_policy: 'Privacy Policy', terms_of_use: 'Terms of Use', cookie_policy: 'Cookie & Consent' };
                host.innerHTML = merged.map(function (v) {
                    var badge = v.is_published == 1 ? '<span class="lc-doc-status lc-doc-status--published">Published</span>' : '<span class="lc-doc-status lc-doc-status--draft">Draft</span>';
                    return '<div class="lc-version-item" style="align-items:flex-start;"><div style="min-width:0;"><div style="margin-bottom:4px;"><span class="lc-version-num">' + esc(titles[v.__type] || v.__type) + ' — v' + esc(v.version_number) + '</span> ' + badge + '</div>' +
                        '<div class="lc-version-meta">' + (v.published_by ? 'By ' + esc(v.published_by) + ' · ' : '') + formatDate(v.created_at) + (v.change_summary ? ' · ' + esc(v.change_summary) : '') + '</div></div>' +
                        '<div style="display:flex;gap:6px;flex-shrink:0;"><button class="um-btn um-btn--ghost um-btn--sm" onclick="lcPreviewVersion(' + v.id + ',\'' + v.__type + '\')">Preview</button>' +
                        (lcIsAdmin() ? '<button class="um-btn um-btn--ghost um-btn--sm" onclick="restoreLegalVersion(\'' + v.__type + '\',' + v.id + ')">Restore</button>' : '') + '</div></div>';
                }).join('');
            } catch (e) { host.innerHTML = '<p class="text-muted">Could not load version history.</p>'; }
        };
        window.lcPreviewVersion = async function (versionId, type) {
            try {
                var r = await apiCall('/api/admin/legal/documents/' + type + '/history');
                var v = (r.versions || []).find(function (x) { return x.id === versionId; });
                if (!v) { window.notificationService.showError('Version not found.'); return; }
                var titles = { privacy_policy: 'Privacy Policy', terms_of_use: 'Terms of Use', cookie_policy: 'Cookie & Consent' };
                document.getElementById('lcPreviewModalTitle').textContent = (titles[type] || type) + ' — v' + v.version_number;
                document.getElementById('lcPreviewModalBody').innerHTML = v.content_html || '<p>(empty)</p>';
                $('#lcPreviewModal').modal('show');
            } catch (e) { window.notificationService.showError('Could not preview version.'); }
        };
        $(document).on('change', '#lcVhType', function () { loadLegalVersionHistory(); });
        $(document).on('input', '#lcVhSearch', lcDebounce(function () { loadLegalVersionHistory(); }, 300));
    })();
