/* Phase 6 (HOUSEKEEPING-NOTES.md): relocated from admin.html verbatim — the Branding tab
   (identity: logo/favicon/accent-colour/theme-font; site: login background). This code sat
   in the middle of the large initFinanceManagement(...) closure (the same one Services/
   Policies were extracted from) with zero cross-reference either direction (verified via grep
   across the whole closure) — safe to remove without disturbing anything around it. Per the
   Email Logs / Services+Policies fix (see HOUSEKEEPING-NOTES.md), the enclosing <script> tag is
   NOT split here — Working Hours' code (just before) and sendTestNotification's code (just
   after) are reunited directly, and this file's <script src> tag sits before the whole
   initFinanceManagement block instead, alongside services.js/policies.js.

   window.uploadBrandingAsset/updateBrandFontPreview/updateBrandColorPreview/resetBrandColor/
   resetBrandFont/resetLoginBackground/loadBrandingSettings/saveBranding were already
   window-attached in the original source. updateBrandPreview was NOT — it is called from 3
   inline oninput="" attributes in the markup (brandLogoUrl/brandFaviconUrl/brandLoginBgUrl
   preview fields), which — being closure-scoped inside initFinanceManagement, unreachable from
   inline-attribute global scope — means those oninput calls have likely thrown ReferenceError
   silently for as long as this code has existed, a pre-existing dead code path. A new
   window.updateBrandPreview attachment is added below per this plan's on*= reachability rule;
   this incidentally makes the live preview-as-you-type work, as a side effect of correct
   extraction, not a deliberate fix (confirmed with the user before doing this). */

// A favicon is shown at 16-48px, but the admin usually picks their full logo (the live one was 1536px and 1.8 MB). Shrink it to
// a 192x192 PNG in the browser before uploading, centred on a transparent square so a non-square logo isn't stretched.
// SVG / ICO files, and anything already small, are uploaded untouched; if the browser can't decode it, so is the original.
async function shrinkFavicon(file) {
    try {
        if (!/^image\/(png|jpeg|webp|gif|bmp)$/.test(file.type)) return file;
        const bmp = await createImageBitmap(file);
        const SIZE = 192;
        if (bmp.width <= SIZE && bmp.height <= SIZE && file.size <= 200 * 1024) return file;
        const scale = Math.min(SIZE / bmp.width, SIZE / bmp.height);
        const w = Math.round(bmp.width * scale), h = Math.round(bmp.height * scale);
        const canvas = document.createElement('canvas');
        canvas.width = SIZE; canvas.height = SIZE;
        const ctx = canvas.getContext('2d');
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(bmp, (SIZE - w) / 2, (SIZE - h) / 2, w, h);
        const blob = await new Promise(function (res) { canvas.toBlob(res, 'image/png'); });
        return blob ? new File([blob], file.name.replace(/\.[^.]+$/, '') + '.png', { type: 'image/png' }) : file;
    } catch (e) {
        return file;
    }
}

// What each Branding upload accepts. Mirrors the server's filter in lib/uploads.js (ICO is allowed for the favicon only).
// The <input accept> only nudges the file picker - drag & drop and "All files" bypass it - so check again here.
const BRANDING_UPLOAD_RULES = {
    brandFaviconFile: { exts: ['png', 'ico', 'svg', 'jpg', 'jpeg', 'webp', 'gif'], label: 'PNG, ICO, SVG, JPG, WEBP or GIF', maxMb: 5 },
    _default:         { exts: ['png', 'svg', 'jpg', 'jpeg', 'webp', 'gif'],        label: 'PNG, SVG, JPG, WEBP or GIF',      maxMb: 15 }
};

// Resolve true if the browser can actually render the file as an image (catches a renamed .txt/.pdf or a corrupt file).
function canDecodeImage(file) {
    return new Promise(function (resolve) {
        const url = URL.createObjectURL(file);
        const img = new Image();
        img.onload = function () { URL.revokeObjectURL(url); resolve(img.naturalWidth > 0 || /svg/.test(file.type)); };
        img.onerror = function () { URL.revokeObjectURL(url); resolve(false); };
        img.src = url;
    });
}

// Returns an error message, or '' when the file is fine to upload.
async function validateBrandingFile(fileInputId, file) {
    const rule = BRANDING_UPLOAD_RULES[fileInputId] || BRANDING_UPLOAD_RULES._default;
    const ext = (file.name.split('.').pop() || '').toLowerCase();
    if (!file.name.includes('.') || rule.exts.indexOf(ext) === -1) {
        return '"' + file.name + '" is not a supported format. Please upload a ' + rule.label + ' image.';
    }
    if (file.size === 0) return '"' + file.name + '" is empty.';
    if (file.size > rule.maxMb * 1024 * 1024) {
        return '"' + file.name + '" is ' + (file.size / 1048576).toFixed(1) + ' MB. The limit is ' + rule.maxMb + ' MB.';
    }
    if (!(await canDecodeImage(file))) {
        return '"' + file.name + '" could not be read as an image. It may be damaged or not really a ' + ext.toUpperCase() + ' file.';
    }
    return '';
}

window.uploadBrandingAsset = async function(fileInputId, targetInputId, previewImgId) {
    const fileInput = document.getElementById(fileInputId);
    if (!fileInput || !fileInput.files.length) return;

    let file = fileInput.files[0];
    const problem = await validateBrandingFile(fileInputId, file);
    if (problem) {
        fileInput.value = '';   // so picking the same file again still fires onchange
        window.notificationService.showError(problem);
        return;
    }
    if (fileInputId === 'brandFaviconFile') file = await shrinkFavicon(file);
    const formData = new FormData();
    formData.append('section', 'branding'); // must come before 'file' so Multer reads it before the destination callback fires
    formData.append('file', file);

    try {
        const r = await fetch('/upload', {
            method: 'POST',
            body: formData,
            credentials: 'same-origin'
        });
        // A rejected upload used to come back as the HTML error page, so r.json() threw and every failure - wrong format,
        // too big, signed out - was reported as "Network error". /upload now always answers JSON; still guard for HTML.
        let d;
        try { d = await r.json(); }
        catch (_) { d = { success: false, message: 'Upload failed (server responded ' + r.status + '). Please try again.' }; }
        fileInput.value = '';
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

// Reflect the currently-chosen accent colour in the swatch + sample button.
// The accent-colour inputs were removed from the Branding screen (see saveBranding). $(...).val() returns undefined for a
// missing element, so the old `.val().trim()` threw a TypeError inside loadBrandingSettings - which caught it and showed
// "Could not load branding settings" every time the tab opened (twice, as two listeners load it). Tolerate their absence.
window.updateBrandColorPreview = function() {
    const c = (($('#brandColorHex').val() || '').trim() || $('#brandPrimaryColor').val() || '#D4AF37');
    $('#brandColorSwatch').css('background', c);
    $('#brandColorSample').css('background', c);
};

// Reset accent colour to the factory default gold.
window.resetBrandColor = function() {
    const DEFAULT_COLOR = '#D4AF37';
    $('#brandPrimaryColor').val(DEFAULT_COLOR);
    $('#brandColorHex').val(DEFAULT_COLOR);
    $('#errBrandColor').hide().text('');
    updateBrandColorPreview();
    if (window.notificationService) window.notificationService.showInfo('Accent colour reset to default (#D4AF37). Save Identity to apply.');
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

// Opening the tab fires two listeners (the section switcher and the shown.bs.tab handler in admin.html), so one click ran
// this twice in parallel - two requests and, on failure, two identical toasts. Share the in-flight load instead.
var _brandingLoadInFlight = null;
window.loadBrandingSettings = function() {
    if (_brandingLoadInFlight) return _brandingLoadInFlight;
    _brandingLoadInFlight = _loadBrandingSettings().finally(function () { _brandingLoadInFlight = null; });
    return _brandingLoadInFlight;
};

async function _loadBrandingSettings() {
    var _bl = document.querySelector('#brandLoading'); if (_bl) _bl.style.display = 'block';
    try {
        const r = await fetch('/api/public/branding', { credentials: 'same-origin', cache: 'no-store' });
        const data = await r.json();
        if (!r.ok || !data.success) throw new Error('HTTP ' + r.status + ' ' + (data.error || data.message || ''));
        const b = data.branding || {};
        if (b.site_logo)     { $('#brandLogoUrl').val(b.site_logo);         updateBrandPreview('brandLogoUrl','brandLogoPreview'); }
        if (b.favicon)       { $('#brandFaviconUrl').val(b.favicon);         updateBrandPreview('brandFaviconUrl','brandFaviconPreview'); }
        if (b.primary_color) { $('#brandPrimaryColor').val(b.primary_color); $('#brandColorHex').val(b.primary_color); }
        if (b.theme_font)    { $('#brandThemeFont').val(b.theme_font); }
        if (b.login_background) { $('#brandLoginBgUrl').val(b.login_background); updateBrandPreview('brandLoginBgUrl','brandLoginBgPreview'); }
        window.tmLoginBg = b.login_background || null;
        updateBrandFontPreview();
        updateBrandColorPreview();
    } catch(e) {
        console.error('[branding] load failed:', e);
        if (window.notificationService) window.notificationService.showError('Could not load branding settings. Please refresh.');
    } finally {
        if (_bl) _bl.style.display = 'none';
    }
}

window.saveBranding = async function(scope) {
    const settings = {};
    const isIdentity = !scope || scope === 'identity';
    const isSite = !scope || scope === 'site';

    if (isIdentity) {
        // G5 — accent-colour hex validation (no other Branding fields are mandatory)
        const _fe = (id, msg) => { const e = document.getElementById(id); if (e) { e.textContent = msg || ''; e.style.display = msg ? 'block' : 'none'; } };
        _fe('errBrandColor', '');
        // The accent-colour inputs (#brandColorHex / #brandPrimaryColor) were removed from the Branding screen by an earlier
        // admin refactor. $(...).val() is undefined for a missing element, so the old `.val().trim()` threw and "Save Identity"
        // crashed before sending anything - no favicon, logo or font change could be saved. Tolerate their absence.
        const _hex = ($('#brandColorHex').val() || '').trim();
        if (_hex && !/^#[0-9a-fA-F]{6}$/.test(_hex)) {
            _fe('errBrandColor', 'Enter a 6-digit hex colour, e.g. #D4AF37.');
            window.notificationService.showError('Please fix the highlighted fields.');
            return;
        }
        const _siteLogo = $('#brandLogoUrl').val().trim();
        const _favicon = $('#brandFaviconUrl').val().trim();
        const _themeFont = $('#brandThemeFont').val();
        settings.primary_color = _hex || $('#brandPrimaryColor').val();   // empty when the fields are gone: dropped below, so the saved colour is left alone
        Object.keys(settings).forEach(k => { if (!settings[k]) delete settings[k]; });
        // Always send site_logo, favicon and theme_font, even empty — clearing any of these
        // fields and saving is meant to remove the custom value, but the strip-if-falsy loop
        // above was deleting them from the payload whenever empty, so the request silently
        // omitted them, the old value stayed in the settings table forever, and it reloaded
        // right back into the field on the next visit. primary_color never hit this because its
        // own reset button sets an actual default hex value, never an empty string.
        settings.site_logo = _siteLogo;
        settings.favicon = _favicon;
        settings.theme_font = _themeFont;
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
