/* Site Appearance > Preloader — pick which of the two loading screens the site shows.
   Markup: the #brandPanelPreloader panel in admin.html.   Styling: css/admin/22-preloader-settings.css.
   The loaders themselves: js/tm-preloader.js (it documents both designs and how the choice reaches a page).

   Two things happen on save:
     - the choice is stored (PUT /api/admin/site-content -> the `preloader_style` / `preloader_field` settings), which is what the
       public homepage is served with from then on (lib/homepage-render.js writes it into the page before sending it); and
     - this browser's cache is refreshed, which is what admin.html reads — it is served as a plain file with no server-side fill, so
       without the cache this admin would keep showing the old loader until something else happened to write it.
   The cache is also refreshed on every admin load (bootstrap at the bottom), so an admin signing in on a second machine, or after
   another administrator changed it, picks the new one up on the load after that.

   Plain top-level code, no IIFE — same as js/admin/system-settings.js, so the handlers below are reachable from the markup and from
   the console the way the rest of the Site Appearance panels are. */

var PL_STYLES = ['wordmark', 'portrait'];
var PL_FIELDS = ['onyx', 'bone'];

// what is showing in the panel right now, and what was last read from the server (so Save can tell whether anything changed)
var _plChoice = { style: 'wordmark', field: 'onyx' };
var _plSaved = null;
var _plLoaded = false;

function plCache(choice) {
    try { localStorage.setItem('tm_preloader', JSON.stringify({ style: choice.style, field: choice.field })); } catch (e) {}
}

// Paints the panel from _plChoice. Also drives the Field row, which only means anything for the portrait.
function plRender() {
    PL_STYLES.forEach(function (s) {
        var on = _plChoice.style === s;
        var id = s === 'wordmark' ? 'Wordmark' : 'Portrait';
        $('#plOpt' + id).attr('aria-checked', on ? 'true' : 'false');
        $('#plBadge' + id).text(on ? 'In use' : 'Available')
            .css(on
                ? { background: 'color-mix(in srgb, var(--atl-sage) 18%, transparent)', color: 'var(--atl-sage)' }
                : { background: 'color-mix(in srgb, var(--atl-muted) 16%, transparent)', color: 'var(--atl-muted)' });
    });
    PL_FIELDS.forEach(function (f) {
        $('#plField' + (f === 'onyx' ? 'Onyx' : 'Bone')).attr('aria-checked', _plChoice.field === f ? 'true' : 'false');
    });
    // the portrait sample wears the chosen field, so the tile previews the exact combination that will go live
    $('#plStagePortrait').toggleClass('is-bone', _plChoice.field === 'bone');
    var portrait = _plChoice.style === ‘portrait’;
    $(‘#plFields’).toggleClass(‘pl-fields--off’, true).attr(‘aria-disabled’, ‘true’);
    $(‘#plFieldHint’).text(‘The loading screen background now follows the Public Theme setting automatically.’);
}

async function loadPreloaderSettings(force) {
    if (_plLoaded && !force) return;
    if (!$('#brandPanelPreloader').length) return;
    $('#plLoading').show();
    try {
        var res = await fetch('/api/public/site-content', { cache: 'no-store', credentials: 'same-origin' });
        var data = await res.json();
        if (!data || !data.success) throw new Error('bad response');
        var p = data.preloader || {};
        _plChoice = {
            style: PL_STYLES.indexOf(p.style) !== -1 ? p.style : 'wordmark',
            field: PL_FIELDS.indexOf(p.field) !== -1 ? p.field : 'onyx'
        };
        _plSaved = { style: _plChoice.style, field: _plChoice.field };
        _plLoaded = true;
        plCache(_plChoice);        // keep this browser's admin loader in step with the server
        plRender();
    } catch (e) {
        if (window.notificationService) window.notificationService.showError('Could not load the loading-screen setting. Please refresh.');
    } finally { $('#plLoading').hide(); }
}

// ── choosing ────────────────────────────────────────────────────────────────────────────────────────────────────────────────
$(document).on('click', '.pl-option', function () { _plChoice.style = $(this).data('style'); plRender(); });
$(document).on('click', '.pl-field', function () { _plChoice.field = $(this).data('field'); plRender(); });
// keyboard: both groups are radiogroups, so Space / Enter must pick the focused one
$(document).on('keydown', '.pl-option, .pl-field', function (e) {
    if (e.key !== ' ' && e.key !== 'Enter' && e.key !== 'Spacebar') return;
    e.preventDefault();
    $(this).trigger('click');
});

// ── preview: show the real thing, full screen, without saving ───────────────────────────────────────────────────────────────
$(document).on('click', '#plPreview', function () {
    if (window.tmPreloader && typeof window.tmPreloader.preview === 'function') {
        window.tmPreloader.preview(_plChoice.style, _plChoice.field, 2800);
    } else if (window.notificationService) {
        window.notificationService.showInfo('Preview is not available on this page — reload the admin and try again.');
    }
});

// ── saving ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────
$(document).on('click', '#plSave', async function () {
    var $btn = $(this), orig = $btn.html();
    if (_plSaved && _plSaved.style === _plChoice.style) {
        if (window.notificationService) window.notificationService.showInfo('That is already the loading screen in use.');
        return;
    }
    var name = _plChoice.style === 'portrait' ? 'Portrait' : 'Wordmark';
    var ok = window.notificationService
        ? await window.notificationService.showConfirm({ title: 'Change the loading screen', message: 'Show the ' + name + ' loading screen on the live public website from now on?' })
        : window.confirm('Show the ' + name + ' loading screen on the live public website from now on?');
    if (!ok) return;

    $btn.prop('disabled', true).html('<i class="fa-solid fa-spinner fa-spin" style="margin-right:6px;"></i>Saving…');
    try {
        await apiCall('/api/admin/site-content', 'PUT', { preloader_style: _plChoice.style });
        _plSaved = { style: _plChoice.style, field: _plChoice.field };
        plCache(_plChoice);
        plRender();
        if (window.notificationService) window.notificationService.showSuccess('Loading screen updated. The public site uses it from the next page load; this admin from the next time you reload it.');
    } catch (err) {
        if (window.notificationService) window.notificationService.showError('Save failed: ' + (err.message || 'Server error'));
    } finally { $btn.prop('disabled', false).html(orig); }
});

// ── bootstrap ───────────────────────────────────────────────────────────────────────────────────────────────────────────────
// Lazy-load the saved state the first time the tab is opened (the same pattern the Homepage Sections tab uses).
$(document).on('click', '[data-um-tab="brandPanelPreloader"]', function () { loadPreloaderSettings(); });

$(function () {
    // Refresh this browser's cache in the background on every admin load, so the admin's own loader follows the setting even when
    // nobody opens this tab — and even when it was another administrator who changed it.
    setTimeout(function () {
        fetch('/api/public/site-content', { cache: 'no-store', credentials: 'same-origin' })
            .then(function (r) { return r.json(); })
            .then(function (d) {
                if (!d || !d.success || !d.preloader) return;
                var p = d.preloader;
                plCache({
                    style: PL_STYLES.indexOf(p.style) !== -1 ? p.style : 'wordmark',
                    field: PL_FIELDS.indexOf(p.field) !== -1 ? p.field : 'onyx'
                });
            })
            .catch(function () {});
    }, 2500);
});
