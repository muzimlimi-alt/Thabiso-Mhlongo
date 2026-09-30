/* Phase 6 (HOUSEKEEPING-NOTES.md): relocated from admin.html verbatim — the Branding tab
   (identity: logo/favicon/accent-colour/theme-font; site: login background). This code sat
   in the middle of the large initFinanceManagement(...) closure (the same one Services/
   Policies were extracted from) with zero cross-reference either direction (verified via grep
   across the whole closure) — safe to remove without disturbing anything around it. Per the
   Email Logs / Services+Policies fix (see HOUSEKEEPING-NOTES.md), the enclosing <script> tag is
   NOT split here — Working Hours' code (just before) and sendTestNotification's code (just
   after) are reunited directly, and this file's <script src> tag sits before the whole
   initFinanceManagement block instead, alongside services.js/policies.js.

   window.uploadBrandingAsset/updateBrandFontPreview/resetBrandFont/resetLoginBackground/
   loadBrandingSettings/saveBranding were already
   window-attached in the original source. updateBrandPreview was NOT — it is called from 3
   inline oninput="" attributes in the markup (brandLogoUrl/brandFaviconUrl/brandLoginBgUrl
   preview fields), which — being closure-scoped inside initFinanceManagement, unreachable from
   inline-attribute global scope — means those oninput calls have likely thrown ReferenceError
   silently for as long as this code has existed, a pre-existing dead code path. A new
   window.updateBrandPreview attachment is added below per this plan's on*= reachability rule;
   this incidentally makes the live preview-as-you-type work, as a side effect of correct
   extraction, not a deliberate fix (confirmed with the user before doing this). */

window.uploadBrandingAsset = async function(fileInputId, targetInputId, previewImgId) {
    const fileInput = document.getElementById(fileInputId);
    if (!fileInput || !fileInput.files.length) return;

    const file = fileInput.files[0];
    const formData = new FormData();
    formData.append('section', 'branding'); // must come before 'file' so Multer reads it before the destination callback fires
    formData.append('file', file);

    try {
        const r = await fetch('/upload', {
            method: 'POST',
            body: formData,
            credentials: 'same-origin'
        });
        const d = await r.json();
        if (d.success) {
            // Store the relative path as-is (matches every other /upload consumer in this
            // codebase — gallery, events, footprint, testimonials, etc.). Prefixing with
            // window.location.origin baked in whatever host was open at upload time (e.g.
            // localhost:3000 during local dev), which then silently broke on any other
            // host/port/deployment. None of the three assets this feeds — site logo,
            // favicon, login background — are ever rendered outside this site's own pages,
            // so none of them need an absolute URL.
            const relativeUrl = d.filePath;
            $('#' + targetInputId).val(relativeUrl);
            if (previewImgId) $('#' + previewImgId).attr('src', relativeUrl).show();
            window.notificationService.showSuccess('Asset uploaded successfully.');
        } else {
            window.notificationService.showError(d.message || 'Upload failed.');
        }
    } catch(e) {
        window.notificationService.showError('Network error during upload.');
    }
};

function updateBrandPreview(urlInputId, previewImgId) {
    const url = $('#' + urlInputId).val().trim();
    const $img = $('#' + previewImgId);
    if (url) { $img.attr('src', url).show(); } else { $img.hide(); }
}
window.updateBrandPreview = updateBrandPreview;

// Render the currently-selected theme font in the live sample box.
window.updateBrandFontPreview = function() {
    const font = $('#brandThemeFont').val() || '"Open Sans", sans-serif';
    $('#brandFontPreview').css('font-family', font);
};

// Reset theme font to the factory default (Open Sans — the empty-value option).
window.resetBrandFont = function() {
    $('#brandThemeFont').val('');
    updateBrandFontPreview();
    if (window.notificationService) window.notificationService.showInfo('Theme font reset to default (Open Sans). Save Identity to apply.');
};

// Clear the login background back to the sign-in screen's built-in default image.
window.resetLoginBackground = function() {
    $('#brandLoginBgUrl').val('');
    updateBrandPreview('brandLoginBgUrl', 'brandLoginBgPreview');
    if (window.notificationService) window.notificationService.showInfo('Login background cleared. Save Site Settings to apply.');
};

window.loadBrandingSettings = async function() {
    var _bl = qs('#brandLoading'); if (_bl) _bl.style.display = 'block';
    try {
        const r = await fetch('/api/public/branding', { credentials: 'same-origin', cache: 'no-store' });
        const data = await r.json();
        if (!data.success) return;
        const b = data.branding;
        if (b.site_logo)     { $('#brandLogoUrl').val(b.site_logo);         updateBrandPreview('brandLogoUrl','brandLogoPreview'); }
        if (b.favicon)       { $('#brandFaviconUrl').val(b.favicon);         updateBrandPreview('brandFaviconUrl','brandFaviconPreview'); }
        if (b.theme_font)    { $('#brandThemeFont').val(b.theme_font); }
        if (b.login_background) { $('#brandLoginBgUrl').val(b.login_background); updateBrandPreview('brandLoginBgUrl','brandLoginBgPreview'); }
        window.tmLoginBg = b.login_background || null;
        updateBrandFontPreview();
    } catch(e) {
        if (window.notificationService) window.notificationService.showError('Could not load branding settings. Please refresh.');
    } finally {
        if (_bl) _bl.style.display = 'none';
    }
};

window.saveBranding = async function(scope) {
    const settings = {};
    const isIdentity = !scope || scope === 'identity';
    const isSite = !scope || scope === 'site';

    if (isIdentity) {
        // Always send site_logo, favicon and theme_font, even empty — clearing any of these
        // fields and saving is meant to remove the custom value.
        settings.site_logo = $('#brandLogoUrl').val().trim();
        settings.favicon = $('#brandFaviconUrl').val().trim();
        settings.theme_font = $('#brandThemeFont').val();
    }

    if (isSite) {
        // Always send the login background (even empty) so it can be set or cleared.
        settings.login_background = $('#brandLoginBgUrl').val().trim();
    }

    try {
        await apiCall('/api/admin/branding', 'PUT', { settings });
        if (isIdentity) {
            if (settings.theme_font) {
                document.documentElement.style.setProperty('--theme-font', settings.theme_font);
            } else {
                document.documentElement.style.setProperty('--theme-font', '"Open Sans", sans-serif');
            }
        }
        if (isSite) {
            // Keep the live login-screen background in sync immediately.
            window.tmLoginBg = settings.login_background || null;
            if (window.applyAdminBackgrounds) window.applyAdminBackgrounds();
        }
        const msg = scope === 'identity' ? 'Identity branding saved successfully.' :
                    scope === 'site' ? 'Site branding saved successfully.' :
                    'Branding saved successfully.';
        window.notificationService.showSuccess(msg);
    } catch(e) {}
};
