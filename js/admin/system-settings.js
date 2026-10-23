/* Phase 6 (HOUSEKEEPING-NOTES.md): relocated from admin.html verbatim — the old Admin Settings page
   (preferencesAdmin). That page has since been split up (docs-internal/admin-nav-map.md): this file now serves
   Revenue > Payment Setup, System > Email Setup, System > Integrations, Site Appearance > Homepage Sections and
   System > Admin Portal. The history below is how it was assembled, from three pieces that were physically scattered: from three pieces that were physically scattered:
   (A) the "Website Sections" carve-out left over from the About Me extraction
   (SECTION_REGISTRY/renderSectionsUI/loadSectionVisibility/saveSectionVisibility and their
   delegated handlers) — plain top-level code, not inside any IIFE;
   (B) loadSystemSettings/saveSystemSettings (PayFast + SMTP config) and
   (C) sendTestNotification — both of which sat inside the large initFinanceManagement(...)
   closure (the same one Services/Policies/Branding/Security & Audit came from), with a
   "Working Hours" block sandwiched between them that was NOT moved — confirmed via its own
   markup IDs (#workingHoursTbody/#btnSaveWorkingHours) that it actually belongs to the Unified
   Calendar tab. Per the Email Logs / Services+Policies fix, that enclosing closure is kept
   whole — the <script src> tag for this file sits before the whole initFinanceManagement block
   instead, alongside services.js/policies.js/branding.js/security-audit.js.

   All of loadSystemSettings/saveSystemSettings/sendTestNotification were already
   window-attached in the original source. saveSectionVisibility is referenced from a static
   onclick="saveSectionVisibility(this)" in the markup; as plain top-level code (not inside an
   IIFE), it and every other name here is already reachable exactly as it was before. */


// ===== Website Sections — public homepage visibility (Site Appearance → Homepage Sections) =====
// Single source of truth for the admin UI; mirrors SECTION_MAP in js/myscript.js.
// `shared:true` means the row maps to an existing setting instead of the section_visibility map.
var SECTION_REGISTRY = [
    { key: 'announcement', label: 'Announcement Bar', cat: 'Marketing',  shared: true, desc: 'The thin scrolling message bar at the very top of every page (shares the About Me → Announcement toggle).' },
    { key: 'hero',       label: 'Hero',              cat: 'Content',    desc: 'The full-screen intro with the rotating background and headline.' },
    { key: 'features',   label: 'At a Glance',       cat: 'Content',    desc: 'The strip of key stats and highlights just below the hero.' },
    { key: 'services',   label: 'What I Do',         cat: 'Content',    desc: 'The services grid ("From the mic to the moment").' },
    { key: 'about',      label: 'About',             cat: 'Content',    desc: 'Your biography, portrait and story.' },
    { key: 'career',     label: 'Milestones',        cat: 'Content',    desc: 'The career-defining moments panel (data managed in the Career admin section).' },
    { key: 'accolades',  label: 'Accolades & Recognition', cat: 'Content', desc: 'The ledger of wins, nominations and honours (data managed in the Accolades admin section). Stays hidden until at least one accolade is Active.' },
    { key: 'footprint',  label: 'Footprint',         cat: 'Content',    desc: 'The flag grid of countries you\'ve performed in.' },
    { key: 'team',       label: 'Management Team',   cat: 'Content',    desc: 'The team photo grid and member list (data managed in the Management Team admin section).' },
    { key: 'gallery',    label: 'Gallery',           cat: 'Engagement', desc: 'The photo grid of moments from road, stage & studio.' },
    { key: 'events',     label: 'Events',            cat: 'Engagement', desc: 'Upcoming and past public events.' },
    { key: 'social',     label: 'Social Media',      cat: 'Marketing',  desc: 'Social profile links and embedded posts.' },
    { key: 'newsletter', label: 'Newsletter',        cat: 'Marketing',  desc: 'The email newsletter sign-up form.' },
    { key: 'testimonials', label: 'Testimonials',    cat: 'Engagement', desc: 'The rotating quote carousel of approved visitor testimonials.' },
    { key: 'contact',    label: 'Contact',           cat: 'Contact',    desc: 'The contact form and manager details.' },
    { key: 'footer',     label: 'Footer',            cat: 'Footer',     desc: 'The site footer with brand, links and legal bar.' }
];
var SECTION_CATS = ['Content', 'Marketing', 'Engagement', 'Contact', 'Footer'];
var _sectionsRendered = false, _sectionsLoaded = false;

function secEsc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

function renderSectionsUI() {
    if (_sectionsRendered) return;
    var $list = $('#sectionsList'); if (!$list.length) return;
    var html = '';
    SECTION_CATS.forEach(function (cat) {
        var rows = SECTION_REGISTRY.filter(function (s) { return s.cat === cat; });
        if (!rows.length) return;
        html += '<div class="sec-group" data-cat="' + cat + '" style="margin-bottom:22px;">'
             +    '<h5 class="um-section-label" style="font-size:12px; text-transform:uppercase; letter-spacing:1px; color:var(--atl-muted) !important; margin:0 0 10px;">' + cat + '</h5>';
        rows.forEach(function (s) {
            html += '<div class="sec-row" data-key="' + s.key + '" data-search="' + secEsc((s.label + ' ' + s.desc).toLowerCase()) + '" '
                 +      'style="display:flex; align-items:center; gap:14px; padding:12px 14px; border:1px solid var(--atl-line); border-radius:10px; margin-bottom:8px; background:var(--atl-card);">'
                 +      '<div style="flex:1; min-width:0;">'
                 +        '<div style="display:flex; align-items:center; gap:8px; flex-wrap:wrap;">'
                 +          '<span style="font-weight:600; color:var(--atl-ink);">' + secEsc(s.label) + '</span>'
                 +          '<span class="sec-badge" id="secBadge-' + s.key + '" style="font-size:10px; font-weight:700; letter-spacing:.5px; text-transform:uppercase; padding:2px 8px; border-radius:999px;"></span>'
                 +        '</div>'
                 +        '<p class="um-section-desc" style="margin:4px 0 0; font-size:12.5px;">' + secEsc(s.desc) + '</p>'
                 +      '</div>'
                 +      '<button type="button" class="atl-switch sec-toggle" role="switch" id="secToggle-' + s.key + '" data-key="' + s.key + '" aria-checked="false" aria-label="Show ' + secEsc(s.label) + ' section"></button>'
                 +    '</div>';
        });
        html += '</div>';
    });
    $list.html(html);
    _sectionsRendered = true;
}

function secSetToggle(key, on) {
    $('#secToggle-' + key).attr('aria-checked', on ? 'true' : 'false');
    var $b = $('#secBadge-' + key);
    if (on) $b.text('Visible').css({ background: 'color-mix(in srgb, var(--atl-sage) 18%, transparent)', color: 'var(--atl-sage)' });
    else    $b.text('Hidden').css({ background: 'color-mix(in srgb, var(--atl-clay) 16%, transparent)', color: 'var(--atl-clay)' });
}

async function loadSectionVisibility(force) {
    renderSectionsUI();
    if (_sectionsLoaded && !force) return;
    $('#secLoading').show();
    try {
        var res = await fetch('/api/public/site-content', { cache: 'no-store', credentials: 'same-origin' });
        var data = await res.json();
        if (!data || !data.success) throw new Error('bad response');
        var sec = data.sections || {};
        SECTION_REGISTRY.forEach(function (s) {
            var on = s.shared === true
                ? (data.announcement && data.announcement.enabled !== false)
                : (sec[s.key] !== false);
            secSetToggle(s.key, on);
        });
        _sectionsLoaded = true;
    } catch (e) {
        if (window.notificationService) window.notificationService.showError('Could not load website sections — please refresh.');
    } finally { $('#secLoading').hide(); }
}

function secFilter() {
    var q = ($('#secSearch').val() || '').trim().toLowerCase();
    var any = false;
    $('#sectionsList .sec-row').each(function () {
        var match = !q || ($(this).attr('data-search') || '').indexOf(q) !== -1;
        $(this).toggle(match); if (match) any = true;
    });
    $('#sectionsList .sec-group').each(function () { $(this).toggle($(this).find('.sec-row:visible').length > 0); });
    $('#secEmpty').toggle(!any);
}

$(document).on('click', '.sec-toggle', function () {
    secSetToggle($(this).data('key'), $(this).attr('aria-checked') !== 'true');
});
$(document).on('click', '#secEnableAll',  function () { SECTION_REGISTRY.forEach(function (s) { secSetToggle(s.key, true); }); });
$(document).on('click', '#secDisableAll', function () { SECTION_REGISTRY.forEach(function (s) { secSetToggle(s.key, false); }); });
$(document).on('click', '#secReset',      function () { loadSectionVisibility(true); });
$(document).on('input', '#secSearch', secFilter);
// Lazy-load the saved state the first time the tab is opened.
$(document).on('click', '[data-um-tab="brandPanelHomepage"]', function () { loadSectionVisibility(); });

async function saveSectionVisibility(btn) {
    var $btn = $(btn), orig = $btn.html();
    var ok = window.notificationService
        ? await window.notificationService.showConfirm({ title: 'Publish section changes', message: 'Apply these visibility settings to the live public website now?' })
        : window.confirm('Apply these visibility settings to the live public website now?');
    if (!ok) return;
    var payload = { section_visibility: {} }, announcement;
    SECTION_REGISTRY.forEach(function (s) {
        var on = $('#secToggle-' + s.key).attr('aria-checked') === 'true';
        if (s.shared === true) announcement = on; else payload.section_visibility[s.key] = on;
    });
    if (typeof announcement !== 'undefined') payload.announcement_enabled = announcement;
    $btn.prop('disabled', true).html('<i class="fa-solid fa-spinner fa-spin" style="margin-right:6px;"></i>Saving…');
    try {
        await apiCall('/api/admin/site-content', 'PUT', payload);
        if (_siteContent) {
            _siteContent.sections = payload.section_visibility;
            if (typeof announcement !== 'undefined') { _siteContent.announcement = _siteContent.announcement || {}; _siteContent.announcement.enabled = announcement; }
        }
        if (window.notificationService) window.notificationService.showSuccess('Website sections updated.');
    } catch (err) {
        if (window.notificationService) window.notificationService.showError('Save failed: ' + (err.message || 'Server error'));
    } finally { $btn.prop('disabled', false).html(orig); }
}

// ─── Settings cards (PayFast, Email, Integrations: each page has its own load and Save) ───
// Email (SMTP): the server never sends the password back. `r.smtp` carries only whether one is saved (and where it comes
// from); administrators get it, other roles do not (and then the whole card is hidden - they cannot change it either).
var _smtpEditable = false;

function stSmtpStatusText(m) {
    if (!m) return '';
    if (m.legacyApi) return 'The server is still running the previous version of the app - restart it to load the update. You can still save email settings, but Test Connection, OAuth and encrypted storage only work after the restart.';
    if (m.loadError) return 'The email settings could not be loaded just now - reload the page. Nothing has been changed.';
    if (m.source === 'legacy-env') {
        var inc = (m.incomplete || []).length ? ' The email settings are incomplete (' + m.incomplete.join('; ') + ').' : '';
        return 'Currently sending through the legacy server settings (' + (m.active.host || '?') + (m.active.user ? ' as ' + m.active.user : '') + ').' + inc + ' Enter your Microsoft 365 details below and save to switch over.';
    }
    if (!m.ok) return 'Not fully configured: ' + (m.problems || []).join('; ') + '.';
    var via = m.active.user + ' via ' + m.active.host + ':' + m.active.port + ' (' + (m.secure === 'ssl' ? 'SSL' : 'STARTTLS') + ')';
    if (m.auth === 'oauth') return 'Active: ' + via + ' using Microsoft 365 OAuth \u2014 ' + (m.secretSource === 'environment' ? 'client secret supplied by the server environment' : 'client secret saved (encrypted)') + '.';
    var pw = m.passwordSource === 'environment' ? 'password supplied by the server environment' : 'password saved (encrypted)';
    return 'Active: ' + via + ' \u2014 ' + pw + '.';
}

// An older server (not restarted since the update) still returns the SMTP fields inside the generic settings map and has no
// "smtp" section. An administrator must not lose the card because of that, so build the same shape from the old response.
function stSmtpFromLegacyApi(s) {
    return {
        host: s.smtp_host || '', port: s.smtp_port || '', secure: s.smtp_secure === 'ssl' ? 'ssl' : 'starttls', user: s.smtp_user || '',
        from: s.smtp_from || '', fromName: s.smtp_from_name || '', passwordSet: !!s.smtp_pass, passwordSource: 'settings', source: 'settings',
        auth: 'password', oauthTenant: '', oauthClient: '', secretSet: false, secretSource: null,
        legacyApi: true, active: { host: s.smtp_host || '', port: s.smtp_port || '', user: s.smtp_user || '', source: 'settings' },
        ok: true, problems: [], incomplete: [], warnings: []
    };
}

// Show the password box for password sign-in, the three Microsoft fields for OAuth.
function stToggleAuth() {
    var oauth = $('#stSmtpAuth').val() === 'oauth';
    $('#stSmtpPassGroup').toggle(!oauth);
    $('#stSmtpOauthGroup').toggle(oauth);
}
$(document).on('change', '#stSmtpAuth', stToggleAuth);

function stApplySmtp(m) {
    if (!m) { _smtpEditable = false; $('#stSmtpCard').hide(); $('#stInboxBlock').hide(); return; }
    _smtpEditable = true;
    $('#stSmtpCard').show();
    $('#stSmtpHost').val(m.host || '');
    $('#stSmtpPort').val(m.port || '');
    $('#stSmtpSecure').val(m.secure === 'ssl' ? 'ssl' : 'starttls');
    $('#stSmtpAuth').val(m.auth === 'oauth' ? 'oauth' : 'password');
    $('#stSmtpUser').val(m.user || '');
    $('#stSmtpFrom').val(m.from || '');
    $('#stSmtpFromName').val(m.fromName || '');
    $('#stSmtpTenant').val(m.oauthTenant || '');
    $('#stSmtpClient').val(m.oauthClient || '');
    // Never render a secret - only a masked indicator so the admin knows one is saved (blank = keep it)
    var dots = '\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022  (saved \u2014 leave blank to keep current)';
    $('#stSmtpPass').val('').attr('placeholder', m.passwordSet ? dots : 'mailbox password');
    $('#stSmtpSecret').val('').attr('placeholder', m.secretSet ? dots : 'secret VALUE');
    stToggleAuth();
    $('#stSmtpStatus').text(stSmtpStatusText(m));
    loadInboxSyncStatus();
}

// ---- Customer replies (inbox): administrator-only controls for lib/inbox-sync.js ----
var _inboxEnabled = false;
function stInboxStatusText(s) {
    if (!s) return 'The status could not be loaded.';
    function when(iso) { return iso ? new Date(iso).toLocaleString() : 'never'; }
    if (!s.enabled) return 'Off. Customers\u2019 answers to your replies stay in Outlook only.';
    var t = 'On \u2014 last checked ' + when(s.lastRunAt) + (s.lastStats ? ' (' + s.lastStats.replies + ' repl' + (s.lastStats.replies === 1 ? 'y' : 'ies') + ', ' + s.lastStats.new_inquiries + ' new inquir' + (s.lastStats.new_inquiries === 1 ? 'y' : 'ies') + ', ' + s.lastStats.bounces + ' bounced)' : '') + '.';
    if (s.lastError) t += ' Last problem: ' + s.lastError + (s.retryAfter ? ' Trying again after ' + when(s.retryAfter) + '.' : '');
    return t;
}
function renderInboxSync(s) {
    _inboxEnabled = !!(s && s.enabled);
    $('#stInboxStatus').text(stInboxStatusText(s)).css('color', s && s.lastError ? 'var(--atl-clay)' : '');
    $('#stInboxToggleBtn span').text(_inboxEnabled ? 'Switch off' : 'Switch on');
    $('#stInboxRunBtn').prop('disabled', !_inboxEnabled);
}
window.loadInboxSyncStatus = async function() {
    if (window.currentUserRole !== 'administrator') return;
    try {
        const res = await fetch('/api/admin/inbox-sync', { credentials: 'same-origin', cache: 'no-store' });
        if (!res.ok) { $('#stInboxBlock').toggle(res.status !== 404); return; }   // an older server without the feature: hide the block quietly
        $('#stInboxBlock').show();
        renderInboxSync(await res.json());
    } catch (e) { /* the rest of the card still works */ }
};
function stInboxSteps(steps) { return (steps || []).map(function (s) { return (s.ok ? '\u2713 ' : '\u2717 ') + s.label + ': ' + s.message; }).join('\n'); }
window.toggleInboxSync = async function() {
    const $btn = $('#stInboxToggleBtn'), orig = $btn.html(), $out = $('#stInboxResult');
    $btn.prop('disabled', true).html('<i class="fa-solid fa-spinner fa-spin"></i> Checking...');
    $out.text('').css('color', '');
    try {
        const res = await fetch('/api/admin/inbox-sync', { method: 'PUT', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: !_inboxEnabled }) });
        const r = await res.json();
        if (res.ok && r.success) { renderInboxSync(r); window.notificationService.showSuccess(r.enabled ? 'Customer replies will now be read from the mailbox.' : 'Reading customer replies is switched off.'); }
        else { $out.text((r.message || 'The setting was not changed.') + (r.steps ? '\n' + stInboxSteps(r.steps) : '')).css('color', 'var(--atl-clay)'); }
    } catch (e) { $out.text('The setting could not be changed. Please try again.').css('color', 'var(--atl-clay)'); }
    finally { $btn.prop('disabled', false).html(orig); renderInboxSync({ enabled: _inboxEnabled }); loadInboxSyncStatus(); }
};
window.testInboxAccess = async function() {
    const $btn = $('#stInboxTestBtn'), orig = $btn.html(), $out = $('#stInboxResult');
    $btn.prop('disabled', true).html('<i class="fa-solid fa-spinner fa-spin"></i> Testing...');
    $out.text('').css('color', '');
    try {
        const r = await apiCall('/api/admin/settings/m365/test-mailbox-read', 'POST');
        // textContent only: the messages can quote Microsoft's replies
        $out.text(stInboxSteps(r.steps)).css('color', r.ok ? 'var(--atl-sage)' : 'var(--atl-clay)');
    } catch (e) { /* apiCall has already shown the reason */ }
    finally { $btn.prop('disabled', false).html(orig); }
};
window.runInboxSync = async function() {
    const $btn = $('#stInboxRunBtn'), orig = $btn.html(), $out = $('#stInboxResult');
    $btn.prop('disabled', true).html('<i class="fa-solid fa-spinner fa-spin"></i> Checking...');
    $out.text('').css('color', '');
    try {
        const r = await apiCall('/api/admin/inbox-sync/run', 'POST');
        const x = r.result || {};
        if (x.ok && x.stats) $out.text('Checked the inbox: ' + x.stats.seen + ' message(s) seen, ' + x.stats.replies + ' repl' + (x.stats.replies === 1 ? 'y' : 'ies') + ' added, ' + x.stats.new_inquiries + ' new inquir' + (x.stats.new_inquiries === 1 ? 'y' : 'ies') + ', ' + x.stats.bounces + ' bounced.').css('color', 'var(--atl-sage)');
        else $out.text(x.skipped ? x.skipped : ('The check failed: ' + (x.error || 'unknown problem'))).css('color', x.skipped ? '' : 'var(--atl-clay)');
        if (r.status) renderInboxSync(r.status);
    } catch (e) { /* apiCall has already shown the reason */ }
    finally { $btn.prop('disabled', false).html(orig); renderInboxSync({ enabled: _inboxEnabled }); loadInboxSyncStatus(); }
};

// Each page loads its own cards. They all read the same GET /api/admin/settings; fetchSettings() only shares a request that is already in flight
// (opening two pages in quick succession), it is not a cache - every page open is fresh.
var _settingsInFlight = null;
function fetchSettings() {
    if (!_settingsInFlight) _settingsInFlight = apiCall('/api/admin/settings').finally(function () { _settingsInFlight = null; });
    return _settingsInFlight;
}
function fillPayfast(s) {
    if (s.payfast_merchant_id) $('#stPayfastId').val(s.payfast_merchant_id);
    if (s.payfast_merchant_key) $('#stPayfastKey').val(s.payfast_merchant_key);
    // Never render the passphrase — only show a masked indicator so the admin knows one is set
    if (s.payfast_passphrase) {
        $('#stPayfastPass').val('').attr('placeholder', '••••••••  (set — leave blank to keep current)');
        $('#stPayfastPass').data('has-existing', true);
    } else {
        $('#stPayfastPass').attr('placeholder', '(leave blank if none)');
        $('#stPayfastPass').data('has-existing', false);
    }
    if (s.payfast_url) $('#stPayfastUrl').val(s.payfast_url);
}

// Email Setup page: Outgoing Mail (SMTP / Microsoft 365), Customer Replies (inbox) and the alert address.
window.loadEmailSetup = async function() {
    var _pl = qs('#emLoading'); if (_pl) _pl.style.display = 'block';
    try {
        const r = await fetchSettings();
        if (r && r.settings) {
            const s = r.settings;
            // Only administrators may see the SMTP card (the role comes from the session, not from what the response happens to contain).
            var smtpView = r.smtp;
            if (!smtpView && window.currentUserRole === 'administrator') {
                smtpView = r.smtpError
                    ? { host: '', port: '', secure: 'starttls', user: '', from: '', fromName: '', passwordSet: false, source: 'none', loadError: true, active: {}, ok: false, problems: [], incomplete: [], warnings: [] }
                    : stSmtpFromLegacyApi(s);
            }
            stApplySmtp(smtpView);   // also loads the Customer Replies status
            if (s.notification_email) $('#stNotificationEmail').val(s.notification_email);
        }
    } catch(e) {
        if (window.notificationService) window.notificationService.showError('Could not load email settings. Please refresh.');
    } finally {
        if (_pl) _pl.style.display = 'none';
    }
};

// Payment cards (PayFast; the bank-transfer card loads itself in js/admin/eft.js).
window.loadPaymentSetup = async function() {
    var _pl = qs('#payLoading'); if (_pl) _pl.style.display = 'block';
    try {
        const r = await fetchSettings();
        if (r && r.settings) fillPayfast(r.settings);
    } catch(e) {
        if (window.notificationService) window.notificationService.showError('Could not load payment settings. Please refresh.');
    } finally {
        if (_pl) _pl.style.display = 'none';
    }
};

// Google Calendar card: its own endpoint (js/admin/google-calendar.js).
window.loadIntegrations = function() {
    if (window.loadGoogleCalendarCard) window.loadGoogleCalendarCard();
};

// The SMTP form as the API wants it. Passwords/secrets are read with the native .value (not jQuery's patched .val()) so they
// reach the server exactly as typed. Only the fields of the chosen sign-in method are sent.
function stSmtpFormValues() {
    var oauth = $('#stSmtpAuth').val() === 'oauth';
    var v = {
        smtp_host: $('#stSmtpHost').val(),
        smtp_port: $('#stSmtpPort').val(),
        smtp_secure: $('#stSmtpSecure').val(),
        smtp_auth: oauth ? 'oauth' : 'password',
        smtp_user: $('#stSmtpUser').val(),
        smtp_from: $('#stSmtpFrom').val(),
        smtp_from_name: $('#stSmtpFromName').val()
    };
    if (oauth) {
        v.smtp_oauth_tenant = $('#stSmtpTenant').val();
        v.smtp_oauth_client = $('#stSmtpClient').val();
        v.smtp_oauth_secret = document.getElementById('stSmtpSecret').value;
    } else {
        v.smtp_pass = document.getElementById('stSmtpPass').value;
    }
    return v;
}

// Inline per-field checks shared by Save and Test Connection. Returns true when everything entered is acceptable.
function stValidateSmtp(v) {
    const _fe = (id, msg) => { const e = document.getElementById(id); if (e) { e.textContent = msg || ''; e.style.display = msg ? 'block' : 'none'; } };
    ['errStHost', 'errStPort', 'errStSecure', 'errStAuth', 'errStUser', 'errStTenant', 'errStClient', 'errStSecret', 'errStFrom', 'errStFromName'].forEach(function (id) { _fe(id, ''); });
    const _emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    const _guid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    let bad = false;
    const host = String(v.smtp_host || '').trim();
    if (host && !/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/i.test(host)) { _fe('errStHost', 'Enter just the server name, e.g. smtp.office365.com.'); bad = true; }
    const port = String(v.smtp_port || '').trim();
    if (port && (!/^\d+$/.test(port) || +port < 1 || +port > 65535)) { _fe('errStPort', 'Port must be a number between 1 and 65535.'); bad = true; }
    if (port === '587' && v.smtp_secure === 'ssl') { _fe('errStSecure', 'Port 587 uses STARTTLS.'); bad = true; }
    if (port === '465' && v.smtp_secure === 'starttls') { _fe('errStSecure', 'Port 465 uses SSL/TLS.'); bad = true; }
    if (v.smtp_from && !_emailRe.test(v.smtp_from)) { _fe('errStFrom', 'Enter a valid email address.'); bad = true; }
    if (/[\r\n]/.test(v.smtp_from_name || '')) { _fe('errStFromName', 'No line breaks, please.'); bad = true; }
    if (v.smtp_auth === 'oauth') {
        const user = String(v.smtp_user || '').trim();
        if (user && user.indexOf('@') < 0) { _fe('errStUser', 'For OAuth this must be the mailbox address.'); bad = true; }
        const tenant = String(v.smtp_oauth_tenant || '').trim();
        if (tenant && !_guid.test(tenant) && !/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}$/i.test(tenant)) { _fe('errStTenant', 'Enter the tenant ID (a GUID) or your tenant domain.'); bad = true; }
        const client = String(v.smtp_oauth_client || '').trim();
        if (client && !_guid.test(client)) { _fe('errStClient', 'Enter the Application (client) ID - a GUID.'); bad = true; }
        const secret = String(v.smtp_oauth_secret || '');
        if (secret && /\s/.test(secret)) { _fe('errStSecret', 'The secret VALUE has no spaces.'); bad = true; }
        else if (secret && _guid.test(secret.trim())) { _fe('errStSecret', 'That looks like the Secret ID. Use the secret VALUE.'); bad = true; }
    }
    return !bad;
}

// PayFast: only its four keys. (It used to share one Save button, and one PUT, with the email settings and the alert address, so a
// failed mail-server test refused the PayFast save too.)
window.savePayfastSettings = async function(btn) {
    const $btn = btn ? $(btn) : $('#btnSavePayfast');
    const origHtml = $btn.html();
    $btn.prop('disabled', true).html('<i class="fa-solid fa-spinner fa-spin" style="margin-right:6px;"></i>Saving…');
    const settings = {
        payfast_merchant_id: $('#stPayfastId').val(),
        payfast_merchant_key: $('#stPayfastKey').val(),
        payfast_passphrase: $('#stPayfastPass').val(),
        payfast_url: $('#stPayfastUrl').val()
    };
    // Remove blank keys to avoid overwriting with empty strings (a blank passphrase therefore means "keep the saved one")
    Object.keys(settings).forEach(k => { if (!settings[k]) delete settings[k]; });
    try {
        await apiCall('/api/admin/settings', 'PUT', { settings });
        window.notificationService.showSuccess('PayFast settings saved.');
    } catch(e) {
        // apiCall has already shown the server's reason
    } finally {
        $btn.prop('disabled', false).html(origHtml);
    }
};

// Outgoing Mail: the whole SMTP form travels in ONE request, so the server's connection test stays all-or-nothing: if changed connection
// details do not work, none of them is saved.
window.saveEmailSettings = async function(btn) {
    if (!_smtpEditable) return;   // only administrators ever see (or send) the SMTP card
    const $btn = btn ? $(btn) : $('#btnSaveSmtp');
    const origHtml = $btn.html();
    const settings = stSmtpFormValues();
    if (!stValidateSmtp(settings)) { window.notificationService.showError('Please fix the highlighted fields.'); return; }
    $btn.prop('disabled', true).html('<i class="fa-solid fa-spinner fa-spin" style="margin-right:6px;"></i>Saving…');
    // Remove blank keys (a blank password therefore means "keep the saved one")
    Object.keys(settings).forEach(k => { if (!settings[k]) delete settings[k]; });
    try {
        const r = await apiCall('/api/admin/settings', 'PUT', { settings });
        if (r && r.smtp) stApplySmtp(r.smtp);
        $('#stSmtpTestResult').text('');
        window.notificationService.showSuccess('Email settings saved.');
        (r && r.warnings || []).forEach(function (w) { window.notificationService.showWarning('Email settings', w); });
    } catch(e) {
        // apiCall has already shown the server's reason (e.g. "the connection test failed ... NOT saved") - nothing was overwritten.
    } finally {
        $btn.prop('disabled', false).html(origHtml);
    }
};

// Alert address: where new-booking alerts and other admin notices are delivered.
window.saveAlertEmail = async function(btn) {
    const $btn = btn ? $(btn) : $('#btnSaveAlertEmail');
    const origHtml = $btn.html();
    const _fe = (id, msg) => { const e = document.getElementById(id); if (e) { e.textContent = msg || ''; e.style.display = msg ? 'block' : 'none'; } };
    const addr = String($('#stNotificationEmail').val() || '').trim();
    _fe('errStNotif', '');
    if (!addr) { _fe('errStNotif', 'Enter the address that should receive alerts.'); window.notificationService.showError('Please fix the highlighted fields.'); return; }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(addr)) { _fe('errStNotif', 'Enter a valid email address.'); window.notificationService.showError('Please fix the highlighted fields.'); return; }
    $btn.prop('disabled', true).html('<i class="fa-solid fa-spinner fa-spin" style="margin-right:6px;"></i>Saving…');
    try {
        await apiCall('/api/admin/settings', 'PUT', { settings: { notification_email: addr } });
        window.notificationService.showSuccess('Alert address saved.');
    } catch(e) {
        // apiCall has already shown the server's reason
    } finally {
        $btn.prop('disabled', false).html(origHtml);
    }
};

// Connection test: signs in with what is on screen (saved or not) without sending an email.
window.testSmtpConnection = async function() {
    const $btn = $('#stSmtpTestBtn');
    const orig = $btn.html();
    const $out = $('#stSmtpTestResult');
    const v = stSmtpFormValues();
    if (!stValidateSmtp(v)) { window.notificationService.showError('Please fix the highlighted fields.'); return; }
    Object.keys(v).forEach(function (k) { if (!v[k]) delete v[k]; });
    $btn.prop('disabled', true).html('<i class="fa-solid fa-spinner fa-spin"></i> Testing...');
    $out.text('').css('color', '');
    try {
        const r = await apiCall('/api/admin/settings/smtp/test-connection', 'POST', v);
        const res = (r && r.result) || {};
        // textContent only: the message can quote the mail server's reply
        if (res.ok) $out.text('✓ ' + res.message).css('color', 'var(--atl-sage)');
        else $out.text('✗ ' + (res.stage ? '[' + res.stage + '] ' : '') + (res.message || 'The connection test failed.')).css('color', 'var(--atl-clay)');
        (r.warnings || []).forEach(function (w) { window.notificationService.showWarning('Email settings', w); });
    } catch(e) {
        // apiCall has already shown the reason
    } finally {
        $btn.prop('disabled', false).html(orig);
    }
};

// Test Google Places (2026-10 Places audit): runs one real venue search through lib/places.js and shows what Google
// answered - which API version is in use, or exactly what to fix in Google Cloud. Never shows the key.
window.testPlacesConfig = async function() {
    const $btn = $('#testPlacesBtn');
    const $out = $('#stPlacesResult');
    const orig = $btn.html();
    $btn.prop('disabled', true).html('<i class="fa-solid fa-spinner fa-spin"></i> Checking...');
    $out.removeClass('is-ok is-bad').text('');
    try {
        const r = await fetch('/api/admin/places/status', { credentials: 'same-origin', cache: 'no-store', bypassInterceptor: true, retry: false });
        const d = await r.json().catch(() => null);
        if (!r.ok || !d || !d.success) {
            $out.addClass('is-bad').text(r.status === 403 ? 'Only an administrator can run this check.' : 'The check could not run. Please try again.');
            return;
        }
        if (d.ok) {
            const api = d.provider === 'legacy' ? 'the legacy Places API' : 'Places API (New)';
            $out.addClass('is-ok').text('Working: Google returned ' + d.sample + ' result(s) through ' + api + '.' + (d.hint ? '\n' + d.hint : ''));
        } else {
            $out.addClass('is-bad').text('Not working (' + d.code + '). ' + (d.hint || '') + (d.detail ? '\nGoogle said: ' + d.detail : ''));
        }
    } catch (e) {
        $out.addClass('is-bad').text('The check could not reach the server. Please try again.');
    } finally {
        $btn.prop('disabled', false).html(orig);
    }
};

// Send Test: a real message through the saved SMTP settings to the Notifications inbox. "Success" = the mail server accepted
// it for delivery (submission) - not proof that it reached the inbox.
window.sendTestNotification = async function() {
    const $btn = $('#testNotifBtn');
    const orig = $btn.html();
    $btn.prop('disabled', true).html('<i class="fa-solid fa-spinner fa-spin"></i> Sending...');
    try {
        const r = await apiCall('/api/admin/settings/test-notification', 'POST');
        if (r && r.success) {
            window.notificationService.showSuccess(r.message || 'The mail server accepted the test email.');
        } else {
            window.notificationService.showError((r && r.message) || 'The test email was not sent.');
        }
    } catch(e) {
        // apiCall has already shown the reason
    } finally {
        $btn.prop('disabled', false).html(orig);
    }
};
