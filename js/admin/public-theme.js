/* Site Appearance > Public Theme — pick which visual identity the public website shows.
   Markup: the #brandPanelPublicTheme panel in admin.html.
   The two themes: Onyx (dark, the original) and Bone (light editorial).

   On save:
     - `public_theme` is stored via PUT /api/admin/site-content, which also auto-sets
       preloader_field to match (single source of truth).
     - The public homepage's server-side fill (lib/homepage-render.js) writes the theme into
       the page before sending it, so a visitor gets the right one on the FIRST paint.
   On load:
     - Reads from /api/public/site-content (same as the preloader tab).
     - Caches in localStorage for the preloader boot's fallback. */

var PT_THEMES = ['onyx', 'bone'];
var _ptChoice = 'onyx';
var _ptSaved = null;
var _ptLoaded = false;

function ptRender() {
    PT_THEMES.forEach(function (t) {
        var on = _ptChoice === t;
        var id = t === 'onyx' ? 'Onyx' : 'Bone';
        $('#ptOpt' + id).attr('aria-checked', on ? 'true' : 'false');
        $('#ptBadge' + id).text(on ? 'In use' : 'Available')
            .css(on
                ? { background: 'color-mix(in srgb, var(--atl-sage) 18%, transparent)', color: 'var(--atl-sage)' }
                : { background: 'color-mix(in srgb, var(--atl-muted) 16%, transparent)', color: 'var(--atl-muted)' });
    });
}

async function loadPublicTheme(force) {
    if (_ptLoaded && !force) return;
    if (!$('#brandPanelPublicTheme').length) return;
    $('#ptLoading').show();
    try {
        var res = await fetch('/api/public/site-content', { cache: 'no-store', credentials: 'same-origin' });
        var data = await res.json();
        if (!data || !data.success) throw new Error('bad response');
        _ptChoice = PT_THEMES.indexOf(data.public_theme) !== -1 ? data.public_theme : 'onyx';
        _ptSaved = _ptChoice;
        _ptLoaded = true;
        ptRender();
    } catch (e) {
        if (window.notificationService) window.notificationService.showError('Could not load the public theme setting. Please refresh.');
    } finally { $('#ptLoading').hide(); }
}

$(document).on('click', '.pt-option', function () {
    _ptChoice = $(this).data('theme');
    ptRender();
});
$(document).on('keydown', '.pt-option', function (e) {
    if (e.key !== ' ' && e.key !== 'Enter' && e.key !== 'Spacebar') return;
    e.preventDefault();
    $(this).trigger('click');
});

$(document).on('click', '#ptPreview', function () {
    window.open('/?preview_theme=' + encodeURIComponent(_ptChoice), '_blank');
});

$(document).on('click', '#ptSave', async function () {
    var $btn = $(this), orig = $btn.html();
    if (_ptSaved === _ptChoice) {
        if (window.notificationService) window.notificationService.showInfo('That is already the theme in use.');
        return;
    }
    var name = _ptChoice === 'bone' ? 'Bone (light)' : 'Onyx (dark)';
    var ok = window.notificationService
        ? await window.notificationService.showConfirm({ title: 'Change the public website theme', message: 'Switch the public website to the ' + name + ' identity? This takes effect immediately for all visitors.' })
        : window.confirm('Switch the public website to the ' + name + ' identity?');
    if (!ok) return;

    $btn.prop('disabled', true).html('<i class="fa-solid fa-spinner fa-spin" style="margin-right:6px;"></i>Saving…');
    try {
        await apiCall('/api/admin/site-content', 'PUT', { public_theme: _ptChoice });
        _ptSaved = _ptChoice;
        try { localStorage.setItem('tm_site_theme', _ptChoice); } catch (e) {}
        try { localStorage.setItem('tm_preloader', JSON.stringify({ style: (window.tmPreloader && window.tmPreloader.style) || 'wordmark', field: _ptChoice })); } catch (e) {}
        ptRender();
        if (window.notificationService) window.notificationService.showSuccess('Public website theme updated to ' + name + '. All visitors will see it from their next page load.');
    } catch (err) {
        if (window.notificationService) window.notificationService.showError('Save failed: ' + (err.message || 'Server error'));
    } finally { $btn.prop('disabled', false).html(orig); }
});

$(document).on('click', '[data-um-tab="brandPanelPublicTheme"]', function () { loadPublicTheme(); });
