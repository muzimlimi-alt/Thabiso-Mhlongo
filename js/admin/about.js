// Phase 6 (HOUSEKEEPING-NOTES.md): relocated from admin.html verbatim — the "2. About Me Logic"
// block, minus its middle "Website Sections" sub-block (admin.html ~13855-13979:
// SECTION_REGISTRY/secEsc/renderSectionsUI/secSetToggle/loadSectionVisibility/secFilter/
// saveSectionVisibility), which stayed behind in admin.html — despite sitting physically inside
// this labeled block, it genuinely belongs to a future System Settings (`preferencesAdmin`)
// extraction: its own tab (`prefPanelSections`) and a static onclick="saveSectionVisibility(this)"
// both live in System Settings' own markup, not About Me's. Confirmed via the section's own tab
// markup that the rest of this file — bio/profile AND the Hero/Services/Features/Announcement
// homepage-content editors — are genuinely all About Me tabs (aboutServicesPanel/
// aboutFeaturesPanel/aboutHeroPanel/aboutAnnouncePanel).
//
// window.atlActivateDrawerTab and uploadFileToServer are called from inside this block but NOT
// moved — both are shared verbatim by other sections, Phase 7 "Shared candidates".

// Live preview — reads from Quill editors (set by initAboutEditors in last script block)
function updateAboutPreview() {
    var p1Html = window.aboutQuill1 ? window.aboutQuill1.root.innerHTML.replace(/<p><br><\/p>/g, '') : '';
    var p2Html = window.aboutQuill2 ? window.aboutQuill2.root.innerHTML.replace(/<p><br><\/p>/g, '') : '';
    var p3Html = window.aboutQuill3 ? window.aboutQuill3.root.innerHTML.replace(/<p><br><\/p>/g, '') : '';
    var fallbackUrl = $('#aboutUrl').val().trim();

    $('#previewAboutP1').html(p1Html || '<em style="color:var(--atl-muted);">No lead text provided yet.</em>');
    $('#previewAboutP2').html(p2Html);
    $('#previewAboutP3').html(p3Html);

    if ($('#aboutFile')[0].files.length === 0 && fallbackUrl) {
        $('#previewAboutImg').attr('src', fallbackUrl);
    }
}
$(document).on('input', '#aboutUrl', updateAboutPreview);

// Loads data from the API into Quill editors — called from last script block after Quill init
async function loadAboutData() {
    try {
        var res = await fetch('/api/admin/about-me', { cache: 'no-store', credentials: 'same-origin' });
        if (res.status === 404) return;            // no record yet — nothing to load
        if (!res.ok) throw new Error('Server returned ' + res.status);
        var data = await res.json();
        if (!data) return;                          // empty record — nothing to load yet
        if (data.image_path) {
            $('#aboutUrl').val(data.image_path);
            $('#previewAboutImg').attr('src', data.image_path);
        }
        if (window.aboutQuill1 && data.paragraph1) window.aboutQuill1.root.innerHTML = data.paragraph1;
        if (window.aboutQuill2 && data.paragraph2) window.aboutQuill2.root.innerHTML = data.paragraph2;
        if (window.aboutQuill3 && data.paragraph3) window.aboutQuill3.root.innerHTML = data.paragraph3;
        updateAboutPreview();
    } catch(e) {
        console.error('Failed to load About Me data:', e);
        window.notificationService.showError('Could not load About Me content — please refresh.');
    }
}
window.loadAboutData = loadAboutData;

// About profile-content drawer open/close (atl-drawer pattern, mirrors career/events).
// Quill's cursor/selection is unreliable inside an ancestor that has a CSS transform, and
// .atl-drawer animates via translateX. So once the drawer has slid open we drop the
// transform (translateX(0) === no offset → no visual change) and focus the editor; the
// transform is restored on close so the slide-out still animates. Done via the
// atl:drawerOpened/Closed events so EVERY close path (button, backdrop, Esc, save) is covered.
$(document).on('click', '#aboutDrawerClose, #aboutDrawerBackdrop', function() { if (window.closeAtlDrawer) closeAtlDrawer('aboutDrawer'); });
document.addEventListener('atl:drawerOpened', function(e) {
    if (!e.detail || e.detail.id !== 'aboutDrawer') return;
    if (window.atlActivateDrawerTab) window.atlActivateDrawerTab('aboutDrawer', 'about-tab-edit');
    if (window.loadChangeHistoryCard) window.loadChangeHistoryCard('aboutChangeHistoryList', 'about_me', 1);
    setTimeout(function() {
        var d = document.getElementById('aboutDrawer');
        if (d && d.classList.contains('atl-drawer--open')) d.style.transform = 'none';
        try { if (window.aboutQuill1) window.aboutQuill1.focus(); } catch (err) {}
    }, 320);
});
document.addEventListener('atl:drawerClosed', function(e) {
    if (!e.detail || e.detail.id !== 'aboutDrawer') return;
    var d = document.getElementById('aboutDrawer'); if (d) d.style.transform = '';
});

// Delegated: the form lives in #aboutDrawer, which is parsed AFTER this script runs,
// so a direct $('#aboutForm').on(...) would bind to nothing. Delegation is order-independent.
$(document).on('submit', '#aboutForm', async function(e) {
    e.preventDefault();
    var urlInput = $('#aboutUrl').val().trim();
    var file = $('#aboutFile')[0].files[0];
    var $btn = $('#aboutSubmitBtn');
    var imagePath = urlInput;

    if (file) {
        if (file.type.startsWith('video/')) { $('#aboutVideoWarning').show(); return; }
        $('#aboutVideoWarning').hide();
        $btn.prop('disabled', true).html('<i class="fa-solid fa-spinner fa-spin"></i> Uploading...');
        try {
            var uploaded = await uploadFileToServer(file, 'about');
            if (uploaded) {
                imagePath = uploaded;
                $('#aboutUrl').val(uploaded);
                $('#previewAboutImg').attr('src', uploaded);
            }
        } catch(uploadErr) {
            window.notificationService.showError('Upload failed: ' + uploadErr.message);
            $btn.prop('disabled', false).html('<i class="fa-solid fa-floppy-disk"></i> Update');
            return;
        }
    }

    var p1 = window.aboutQuill1 ? window.aboutQuill1.root.innerHTML : '';
    var p2 = window.aboutQuill2 ? window.aboutQuill2.root.innerHTML : '';
    var p3 = window.aboutQuill3 ? window.aboutQuill3.root.innerHTML : '';

    $btn.prop('disabled', true).html('<i class="fa-solid fa-spinner fa-spin"></i> Saving...');
    try {
        await apiCall('/api/admin/about-me', 'POST', { image_path: imagePath, paragraph1: p1, paragraph2: p2, paragraph3: p3 });
        updateAboutPreview();
        $('#aboutFile').val('');
        if (window.notificationService) window.notificationService.showSuccess('Profile updated.');
        if (window.closeAtlDrawer) closeAtlDrawer('aboutDrawer');
        $btn.prop('disabled', false).html('<i class="fa-solid fa-floppy-disk"></i> Update');
    } catch(saveErr) {
        window.notificationService.showError('Save failed: ' + (saveErr.message || 'Server error'));
        $btn.prop('disabled', false).html('<i class="fa-solid fa-floppy-disk"></i> Update');
    }
});

// Show a local preview on pick; the actual upload happens once on submit (avoids double-upload).
// Delegated (form is in the drawer, parsed after this script).
$(document).on('change', '#aboutFile', function() {
    var file = this.files[0];
    var text = document.getElementById('aboutUploadText');
    if (text) {
        text.textContent = file ? file.name : 'Select or drop profile picture';
    }
    if (!file) return;
    if (file.type.startsWith('image/')) {
        $('#aboutVideoWarning').hide();
        var reader = new FileReader();
        reader.onload = function(ev) { $('#previewAboutImg').attr('src', ev.target.result); };
        reader.readAsDataURL(file);
    } else if (file.type.startsWith('video/')) {
        $('#aboutVideoWarning').show();
    }
});

// Drag-and-drop highlight for the about upload zone (bound after ready; element persists through docking)
$(function () {
    var zone = document.getElementById('aboutUploadZone');
    if (!zone) return;
    ['dragenter','dragover'].forEach(function(ev){ zone.addEventListener(ev, function(e){ e.preventDefault(); e.stopPropagation(); zone.classList.add('um-upload-zone--dragging'); if (ev === 'dragenter') { var t = document.getElementById('aboutUploadText'); if (t) t.textContent = 'Drop image here'; } }); });
    ['dragleave','drop'].forEach(function(ev){ zone.addEventListener(ev, function(e){ e.preventDefault(); e.stopPropagation(); zone.classList.remove('um-upload-zone--dragging'); }); });
    zone.addEventListener('drop', function(e){
        var dropped = e.dataTransfer && e.dataTransfer.files;
        if (dropped && dropped.length) { var input = document.getElementById('aboutFile'); try { input.files = dropped; } catch(err){} $('#aboutFile').trigger('change'); }
    });
});

// =====================================================================
// HOMEPAGE CONTENT — Hero paragraph + "What I Do" services (admin-editable)
// =====================================================================
var _siteContent = null, _siteContentLoaded = false;
var DEFAULT_SVC_ITEMS = [
    { title: 'Stand-Up', description: 'Solo sets, festivals & comedy nights', image: '' },
    { title: 'MC & Host', description: 'Galas, weddings & corporate events', image: '' },
    { title: 'TV, Podcast & Film', description: 'Acting, presenting & writing', image: '' },
    { title: 'Voice-Over', description: 'Radio & TV ads', image: '' }
];
var DEFAULT_FEAT_ITEMS = [
    { title: '10+ Years', description: 'On stage since 2014' },
    { title: '200+ Shows', description: 'Live performances' },
    { title: '15+ Credits', description: 'TV, film & voice-over' },
    { title: '3 Languages', description: 'English, IsiSwati & Hilarious' }
];
function siteEsc(s) { return $('<span>').text(s == null ? '' : String(s)).html(); }

async function loadSiteContent(force) {
    if (_siteContentLoaded && !force) return;
    try {
        var res = await fetch('/api/public/site-content', { cache: 'no-store', credentials: 'same-origin' });
        var data = await res.json();
        if (!data || !data.success) throw new Error('bad response');
        if (!data.services) data.services = {};
        if (!Array.isArray(data.services.items) || !data.services.items.length) data.services.items = DEFAULT_SVC_ITEMS.slice();
        if (!data.features) data.features = {};
        if (!Array.isArray(data.features.items) || !data.features.items.length) data.features.items = DEFAULT_FEAT_ITEMS.slice();
        if (!data.announcement) data.announcement = {};
        _siteContent = data; _siteContentLoaded = true;
        $('#announceInput').val(data.announcement.text || '');
        $('#announceEnabled').prop('checked', data.announcement.enabled !== false);
        $('#announceRotate').prop('checked', data.announcement.rotate !== false);
        $('#taglineInput').val(data.hero_tagline || '');
        $('#heroInput').val(data.hero_subtitle || '');
        $('#svcEyebrow').val(data.services.eyebrow || '');
        $('#svcHeading').val(data.services.heading || '');
        buildSvcCardEditors(data.services.items);
        buildFeatEditors(data.features.items);
        renderAnnouncePreview();
        renderHeroPreview();
        renderSvcPreview();
        renderFeatPreview();
    } catch (e) {
        if (window.notificationService) window.notificationService.showError('Could not load homepage content — please refresh.');
    }
}

function buildSvcCardEditors(items) {
    var html = (items || []).map(function (it, i) {
        return '<div style="border:1px solid var(--atl-line); border-radius:8px; padding:14px; margin-bottom:14px;">'
            + '<div style="font-weight:700; color:var(--atl-amber); font-size:11px; text-transform:uppercase; letter-spacing:1px; margin-bottom:10px;">Card ' + (i + 1) + '</div>'
            + '<label class="um-label">Title</label>'
            + '<div class="um-input-wrap"><input type="text" class="um-input svc-card-title" data-idx="' + i + '" value="' + siteEsc(it.title) + '"></div>'
            + '<label class="um-label" style="margin-top:10px;">Description</label>'
            + '<div class="um-input-wrap"><input type="text" class="um-input svc-card-desc" data-idx="' + i + '" value="' + siteEsc(it.description) + '"></div>'
            + '<label class="um-label" style="margin-top:10px;">Background image URL</label>'
            + '<div class="um-input-wrap"><input type="text" class="um-input svc-card-image" data-idx="' + i + '" value="' + siteEsc(it.image) + '" placeholder="images/… or https://…"></div>'
            + '<label for="svcCardFile' + i + '" class="um-upload-zone" style="margin-top:8px; padding:14px;">'
            + '<i class="fa-solid fa-image um-upload-icon"></i><p class="um-upload-text" id="svcCardFileText' + i + '">Upload an image</p>'
            + '<input type="file" id="svcCardFile' + i + '" class="um-file-input svc-card-file" data-idx="' + i + '" accept="image/*"></label>'
            + '</div>';
    }).join('');
    $('#svcCardsEditor').html(html);
}

function collectSvcItems() {
    var items = [];
    $('#svcCardsEditor .svc-card-title').each(function () {
        var i = $(this).data('idx');
        items[i] = items[i] || {};
        items[i].title = $(this).val();
        items[i].description = $('#svcCardsEditor .svc-card-desc[data-idx="' + i + '"]').val();
        items[i].image = $('#svcCardsEditor .svc-card-image[data-idx="' + i + '"]').val();
    });
    return items.filter(Boolean);
}

function renderHeroPreview() {
    var t = $('#taglineInput').val();
    $('#taglinePrev').text((t && t.trim()) ? t : '—');
    var v = $('#heroInput').val();
    $('#heroPrev').html((v && v.trim()) ? v : '&mdash;');
}

function renderAnnouncePreview() {
    var on = $('#announceEnabled').is(':checked');
    var rot = $('#announceRotate').is(':checked');
    var txt = $('#announceInput').val();
    $('#announcePrev').html((txt && txt.trim()) ? txt : '&mdash;');
    $('#announcePrevWrap').css('opacity', on ? '1' : '0.35');
    $('#announcePrevOff').toggle(!on);
    $('#announcePrevMotion')
        .html(rot
            ? '<i class="fa-solid fa-arrows-left-right"></i> Rotating &mdash; the text scrolls across the bar'
            : '<i class="fa-solid fa-align-center"></i> Static &mdash; the text stays still and centred')
        .toggle(on);
}

function renderSvcPreview() {
    $('#svcPrevEyebrow').text($('#svcEyebrow').val() || 'What I do');
    $('#svcPrevHeading').html($('#svcHeading').val() || 'From the mic to the <em>moment</em>');
    var items = collectSvcItems();
    var grid = items.map(function (it, i) {
        var bg = (it.image && it.image.trim())
            ? "background-image:url('" + String(it.image).replace(/'/g, '%27') + "'); background-size:cover; background-position:center;"
            : 'background:linear-gradient(135deg, var(--atl-card), var(--atl-line));';
        return '<div style="position:relative; border-radius:8px; overflow:hidden; min-height:130px; ' + bg + ' border:1px solid var(--atl-line);">'
            + '<div style="position:absolute; inset:0; background:linear-gradient(to top, rgba(0,0,0,0.78), rgba(0,0,0,0.1));"></div>'
            + '<div style="position:absolute; left:10px; right:10px; bottom:8px;">'
            + '<div style="color:var(--atl-amber); font-size:10px; font-weight:700;">0' + (i + 1) + '</div>'
            + '<div style="color:#fff; font-weight:600; font-size:13px; line-height:1.2;">' + siteEsc(it.title) + '</div>'
            + '<div style="color:#d4d4d4; font-size:11px;">' + siteEsc(it.description) + '</div>'
            + '</div></div>';
    }).join('');
    $('#svcPrevGrid').html(grid);
}

function buildFeatEditors(items) {
    var html = (items || []).map(function (it, i) {
        return '<div style="border:1px solid var(--atl-line); border-radius:8px; padding:14px; margin-bottom:14px;">'
            + '<div style="font-weight:700; color:var(--atl-amber); font-size:11px; text-transform:uppercase; letter-spacing:1px; margin-bottom:10px;">Stat ' + (i + 1) + '</div>'
            + '<label class="um-label">Number / label</label>'
            + '<div class="um-input-wrap"><input type="text" class="um-input feat-title" data-idx="' + i + '" value="' + siteEsc(it.title) + '"></div>'
            + '<label class="um-label" style="margin-top:10px;">Caption</label>'
            + '<div class="um-input-wrap"><input type="text" class="um-input feat-desc" data-idx="' + i + '" value="' + siteEsc(it.description) + '"></div>'
            + '</div>';
    }).join('');
    $('#featCardsEditor').html(html);
}

function collectFeatItems() {
    var items = [];
    $('#featCardsEditor .feat-title').each(function () {
        var i = $(this).data('idx');
        items[i] = items[i] || {};
        items[i].title = $(this).val();
        items[i].description = $('#featCardsEditor .feat-desc[data-idx="' + i + '"]').val();
    });
    return items.filter(Boolean);
}

function renderFeatPreview() {
    var items = collectFeatItems();
    var grid = items.map(function (it) {
        return '<div>'
            + '<div style="font-size:22px; font-weight:700; color:var(--atl-amber); line-height:1.1;">' + siteEsc(it.title) + '</div>'
            + '<div style="font-size:12px; color:var(--atl-muted); margin-top:2px;">' + siteEsc(it.description) + '</div>'
            + '</div>';
    }).join('');
    $('#featPrevGrid').html(grid);
}

// Live preview wiring (delegated — editors live in drawers parsed after this script)
$(document).on('input', '#taglineInput, #heroInput', renderHeroPreview);
$(document).on('input', '#svcEyebrow, #svcHeading', renderSvcPreview);
$(document).on('input', '#svcCardsEditor input', renderSvcPreview);
$(document).on('input', '#featCardsEditor input', renderFeatPreview);
$(document).on('input', '#announceInput', renderAnnouncePreview);
$(document).on('change', '#announceEnabled', renderAnnouncePreview);
$(document).on('change', '#announceRotate', renderAnnouncePreview);
$(document).on('change', '.svc-card-file', function () {
    var f = this.files[0]; $('#svcCardFileText' + $(this).data('idx')).text(f ? f.name : 'Upload an image');
});

// Drawer open/close (plain inputs → no Quill/transform issue) + lazy content load
$(document).on('click', '#heroDrawerClose, #heroDrawerBackdrop', function () { if (window.closeAtlDrawer) closeAtlDrawer('heroDrawer'); });
$(document).on('click', '#servicesDrawerClose, #servicesDrawerBackdrop', function () { if (window.closeAtlDrawer) closeAtlDrawer('servicesDrawer'); });
$(document).on('click', '#featuresDrawerClose, #featuresDrawerBackdrop', function () { if (window.closeAtlDrawer) closeAtlDrawer('featuresDrawer'); });
$(document).on('click', '#announceDrawerClose, #announceDrawerBackdrop', function () { if (window.closeAtlDrawer) closeAtlDrawer('announceDrawer'); });
$(document).on('click', '[data-um-tab="aboutServicesPanel"], [data-um-tab="aboutFeaturesPanel"], [data-um-tab="aboutHeroPanel"], [data-um-tab="aboutAnnouncePanel"]', function () { loadSiteContent(); });

// Hero save (delegated)
$(document).on('submit', '#heroForm', async function (e) {
    e.preventDefault();
    var $btn = $('#heroSubmitBtn'), orig = $btn.html();
    $btn.prop('disabled', true).html('<i class="fa-solid fa-spinner fa-spin"></i> Saving…');
    try {
        await apiCall('/api/admin/site-content', 'PUT', { hero_tagline: $('#taglineInput').val(), hero_subtitle: $('#heroInput').val() });
        if (_siteContent) { _siteContent.hero_tagline = $('#taglineInput').val(); _siteContent.hero_subtitle = $('#heroInput').val(); }
        renderHeroPreview();
        if (window.notificationService) window.notificationService.showSuccess('Hero content published.');
        if (window.closeAtlDrawer) closeAtlDrawer('heroDrawer');
    } catch (err) {
        if (window.notificationService) window.notificationService.showError('Save failed: ' + (err.message || 'Server error'));
    } finally { $btn.prop('disabled', false).html(orig); }
});

// Features strip save (delegated)
$(document).on('submit', '#featuresForm', async function (e) {
    e.preventDefault();
    var $btn = $('#featuresSubmitBtn'), orig = $btn.html();
    $btn.prop('disabled', true).html('<i class="fa-solid fa-spinner fa-spin"></i> Saving…');
    try {
        var items = collectFeatItems();
        await apiCall('/api/admin/site-content', 'PUT', { features_items: items });
        if (_siteContent) _siteContent.features = { items: items };
        renderFeatPreview();
        if (window.notificationService) window.notificationService.showSuccess('Features strip published.');
        if (window.closeAtlDrawer) closeAtlDrawer('featuresDrawer');
    } catch (err) {
        if (window.notificationService) window.notificationService.showError('Save failed: ' + (err.message || 'Server error'));
    } finally { $btn.prop('disabled', false).html(orig); }
});

// Announcement bar save (delegated)
$(document).on('submit', '#announceForm', async function (e) {
    e.preventDefault();
    var $btn = $('#announceSubmitBtn'), orig = $btn.html();
    $btn.prop('disabled', true).html('<i class="fa-solid fa-spinner fa-spin"></i> Saving…');
    try {
        var enabled = $('#announceEnabled').is(':checked');
        var rotate = $('#announceRotate').is(':checked');
        await apiCall('/api/admin/site-content', 'PUT', { announcement_text: $('#announceInput').val(), announcement_enabled: enabled, announcement_rotate: rotate });
        if (_siteContent) _siteContent.announcement = { text: $('#announceInput').val(), enabled: enabled, rotate: rotate };
        renderAnnouncePreview();
        if (window.notificationService) window.notificationService.showSuccess('Announcement bar published.');
        if (window.closeAtlDrawer) closeAtlDrawer('announceDrawer');
    } catch (err) {
        if (window.notificationService) window.notificationService.showError('Save failed: ' + (err.message || 'Server error'));
    } finally { $btn.prop('disabled', false).html(orig); }
});

// What I Do save (delegated) — uploads any picked card images first
$(document).on('submit', '#servicesForm', async function (e) {
    e.preventDefault();
    var $btn = $('#servicesSubmitBtn'), orig = $btn.html();
    $btn.prop('disabled', true).html('<i class="fa-solid fa-spinner fa-spin"></i> Saving…');
    try {
        var items = [];
        var idxs = $('#svcCardsEditor .svc-card-title').map(function () { return $(this).data('idx'); }).get();
        for (var k = 0; k < idxs.length; k++) {
            var i = idxs[k];
            var image = $('#svcCardsEditor .svc-card-image[data-idx="' + i + '"]').val();
            var fileInput = document.getElementById('svcCardFile' + i);
            if (fileInput && fileInput.files && fileInput.files[0]) {
                var uploaded = await uploadFileToServer(fileInput.files[0], 'about');
                if (uploaded) image = uploaded;
            }
            items.push({
                title: $('#svcCardsEditor .svc-card-title[data-idx="' + i + '"]').val(),
                description: $('#svcCardsEditor .svc-card-desc[data-idx="' + i + '"]').val(),
                image: image
            });
        }
        await apiCall('/api/admin/site-content', 'PUT', {
            services_eyebrow: $('#svcEyebrow').val(),
            services_heading: $('#svcHeading').val(),
            services_items: items
        });
        if (_siteContent) _siteContent.services = { eyebrow: $('#svcEyebrow').val(), heading: $('#svcHeading').val(), items: items };
        buildSvcCardEditors(items); // reflect uploaded URLs back into the editor
        renderSvcPreview();
        if (window.notificationService) window.notificationService.showSuccess('What I Do section published.');
        if (window.closeAtlDrawer) closeAtlDrawer('servicesDrawer');
    } catch (err) {
        if (window.notificationService) window.notificationService.showError('Save failed: ' + (err.message || 'Server error'));
    } finally { $btn.prop('disabled', false).html(orig); }
});
