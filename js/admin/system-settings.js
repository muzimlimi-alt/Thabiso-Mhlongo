/* Phase 6 (HOUSEKEEPING-NOTES.md): relocated from admin.html verbatim — System Settings
   (preferencesAdmin), assembled from three pieces that were physically scattered:
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


// ===== Website Sections — public homepage visibility (Settings → Website Sections) =====
// Single source of truth for the admin UI; mirrors SECTION_MAP in js/myscript.js.
// `shared:true` means the row maps to an existing setting instead of the section_visibility map.
var SECTION_REGISTRY = [
    { key: 'announcement', label: 'Announcement Bar', cat: 'Marketing',  shared: true, desc: 'The thin scrolling message bar at the very top of every page (shares the About Me → Announcement toggle).' },
    { key: 'hero',       label: 'Hero',              cat: 'Content',    desc: 'The full-screen intro with the rotating background and headline.' },
    { key: 'features',   label: 'At a Glance',       cat: 'Content',    desc: 'The strip of key stats and highlights just below the hero.' },
    { key: 'services',   label: 'What I Do',         cat: 'Content',    desc: 'The services grid ("From the mic to the moment").' },
    { key: 'about',      label: 'About',             cat: 'Content',    desc: 'Your biography, portrait and story.' },
    { key: 'career',     label: 'Milestones',        cat: 'Content',    desc: 'The career-defining moments panel (data managed in the Career admin section).' },
    { key: 'footprint',  label: 'Footprint',         cat: 'Content',    desc: 'The flag grid of countries you\'ve performed in.' },
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
$(document).on('click', '[data-um-tab="prefPanelSections"]', function () { loadSectionVisibility(); });

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

// ─── System Settings ───
window.loadSystemSettings = async function() {
    var _pl = qs('#prefLoading'); if (_pl) _pl.style.display = 'block';
    try {
        const r = await apiCall('/api/admin/settings');
        if (r && r.settings) {
            const s = r.settings;
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
            if (s.smtp_host) $('#stSmtpHost').val(s.smtp_host);
            if (s.smtp_port) $('#stSmtpPort').val(s.smtp_port);
            if (s.smtp_user) $('#stSmtpUser').val(s.smtp_user);
            if (s.smtp_pass) $('#stSmtpPass').val(s.smtp_pass);
            if (s.smtp_from) $('#stSmtpFrom').val(s.smtp_from);
            if (s.notification_email) $('#stNotificationEmail').val(s.notification_email);
        }
    } catch(e) {
        if (window.notificationService) window.notificationService.showError('Could not load system settings. Please refresh.');
    } finally {
        if (_pl) _pl.style.display = 'none';
    }
};


window.saveSystemSettings = async function(btn) {
    const $btn = btn ? $(btn) : $('#btnSaveSystemSettings');
    const origHtml = $btn.html();
    $btn.prop('disabled', true).html('<i class="fa-solid fa-spinner fa-spin" style="margin-right:6px;"></i>Saving…');
    const settings = {
        payfast_merchant_id: $('#stPayfastId').val(),
        payfast_merchant_key: $('#stPayfastKey').val(),
        payfast_passphrase: $('#stPayfastPass').val(),
        payfast_url: $('#stPayfastUrl').val(),
        smtp_host: $('#stSmtpHost').val(),
        smtp_port: $('#stSmtpPort').val(),
        smtp_user: $('#stSmtpUser').val(),
        smtp_pass: $('#stSmtpPass').val(),
        smtp_from: $('#stSmtpFrom').val(),
        notification_email: $('#stNotificationEmail').val()
    };
    // G5 — inline per-field validation
    const _fe = (id, msg) => { const e = document.getElementById(id); if (e) { e.textContent = msg || ''; e.style.display = msg ? 'block' : 'none'; } };
    _fe('errStPort', ''); _fe('errStFrom', ''); _fe('errStNotif', '');
    const _emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    let _bad = false;
    const _port = String(settings.smtp_port || '').trim();
    if (_port && !/^\d+$/.test(_port)) { _fe('errStPort', 'Port must be a number.'); _bad = true; }
    if (settings.smtp_from && !_emailRe.test(settings.smtp_from)) { _fe('errStFrom', 'Enter a valid email address.'); _bad = true; }
    if (settings.notification_email && !_emailRe.test(settings.notification_email)) { _fe('errStNotif', 'Enter a valid email address.'); _bad = true; }
    if (_bad) { window.notificationService.showError('Please fix the highlighted fields.'); $btn.prop('disabled', false).html(origHtml); return; }
    // Remove blank keys to avoid overwriting with empty strings
    Object.keys(settings).forEach(k => { if (!settings[k]) delete settings[k]; });
    try {
        await apiCall('/api/admin/settings', 'PUT', { settings });
        window.notificationService.showSuccess('System settings saved successfully.');
    } catch(e) {
        window.notificationService.showError('Failed to save settings.');
    } finally {
        $btn.prop('disabled', false).html(origHtml);
    }
};

window.sendTestNotification = async function() {
    const $btn = $('#testNotifBtn');
    const orig = $btn.html();
    $btn.prop('disabled', true).html('<i class="fa-solid fa-spinner fa-spin"></i> Sending...');
    try {
        const r = await apiCall('/api/admin/settings/test-notification', 'POST');
        if (r && r.success) {
            window.notificationService.showSuccess(r.message || 'Test email sent.');
        } else {
            window.notificationService.showError(r.error || 'Failed to send test email.');
        }
    } catch(e) {
        window.notificationService.showError('Failed to send test email.');
    } finally {
        $btn.prop('disabled', false).html(orig);
    }
};
