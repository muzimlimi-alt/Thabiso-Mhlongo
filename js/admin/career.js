// Phase 6 (HOUSEKEEPING-NOTES.md): relocated from admin.html verbatim — the "5. Career Accordion
// Logic" block. window.atlActivateDrawerTab (admin.html ~14783) and uploadFileToServer (admin.html
// ~13462) are called from inside this block but NOT moved here: both are shared verbatim by other
// sections — Phase 7 "Shared candidates", left in admin.html untouched.
//
// openCareerCreateDrawer/openCareerEditDrawer/careerCancelEdit were already window-attached in the
// original source (Career uses genuine inline onclick="" attributes — a dynamically-generated
// onclick="window.openCareerEditDrawer(...)" per card, and a static onclick="careerCancelEdit();"
// on the drawer's own Cancel button) — kept exactly as-is.
function initCareerYears() {
    var $yearSelect = $('#careerYear');
    if (!$yearSelect.length) return;            // drawer not parsed yet (runs again after ready)
    $yearSelect.empty();                        // idempotent — avoid duplicate option lists
    var currentYear = new Date().getFullYear();
    for (var y = currentYear; y >= 1985; y--) {
        $yearSelect.append('<option value="' + y + '">' + y + '</option>');
    }
}
// #careerYear lives in the drawer (parsed after this script) — populate once the DOM is ready.
$(function () { initCareerYears(); });

// Global state for edit mode (set when a card is expanded for editing; null = add mode)
var editingHighlightId = null;
var careerImageCleared = false;

async function loadHighlights() {
    var $list = $('#adminCareerList');
    try {
        const data = await apiCall('/api/admin/highlights');

        if (!Array.isArray(data) || data.length === 0) {
            $list.html(`
                <div class="atl-empty-state">
                    <i class="fa-solid fa-star" style="font-size:32px; color:var(--atl-muted-dim); margin-bottom:14px; display:block;"></i>
                    <p style="color:var(--atl-muted); margin:0; font-size:13px;">No career highlights yet. Use “Add Career Highlight” to create your first one.</p>
                </div>
            `);
            $('#clearCareerBtn').hide();
            return;
        }

        $list.empty();
        $('#clearCareerBtn').show();

        data.forEach(function (item) {
            let mediaUrl = item.image_path || 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
            var isVideo = mediaUrl.includes('youtube') || mediaUrl.includes('vimeo');
            var ytCareerMatch = isVideo ? mediaUrl.match(/(?:youtu\.be\/|youtube\.com\/(?:embed\/|v\/|watch\?v=|watch\?.+&v=))([\w-]{11})/) : null;
            var safeThumb = isVideo
                ? (ytCareerMatch && ytCareerMatch[1] ? 'https://img.youtube.com/vi/' + ytCareerMatch[1] + '/hqdefault.jpg' : 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7')
                : mediaUrl;

            var title = item.title || 'Untitled';
            var subtitleParts = [];
            if (item.year) subtitleParts.push(item.year);
            if (item.location) subtitleParts.push(item.location);
            if (item.badge) subtitleParts.push(item.badge);
            var subtitle = subtitleParts.join(' • ');
            var descText = (item.description || '').substring(0, 110) + ((item.description || '').length > 110 ? '...' : '');
            var encoded = encodeURIComponent(JSON.stringify(item));

            var html = `
            <article class="atl-edit-card" data-id="${item.id}" data-payload="${encoded}">
              <div class="atl-card-inner">
                <div class="atl-edit-card__header">
                  <div class="atl-edit-card__thumb">
                    <img src="${safeThumb}" onerror="this.onerror=null;this.src='data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';" alt="Thumbnail">
                    ${isVideo ? `<div class="atl-edit-card__video-badge"><i class="fa fa-play"></i> VIDEO</div>` : ''}
                  </div>
                  <div style="flex:1; min-width:0;">
                    <h3 class="atl-edit-card__title">${title}</h3>
                    <p class="atl-edit-card__subtitle">${subtitle}</p>
                    <div class="atl-edit-card__desc">${descText}</div>
                  </div>
                  <div style="display:flex; flex-direction:column; align-items:flex-end; gap:6px; flex-shrink:0;">
                    <button type="button" class="atl-btn atl-btn--ghost um-btn--sm" onclick="window.openCareerEditDrawer(${item.id})" title="Edit highlight" aria-label="Edit highlight">
                      <i class="fa-solid fa-pen"></i>
                    </button>
                    <button type="button" class="um-btn um-btn--danger um-btn--sm remove-career-action" data-id="${item.id}" title="Delete highlight" aria-label="Delete highlight">
                      <i class="fa-solid fa-trash-can"></i>
                    </button>
                  </div>
                </div>
              </div>
            </article>`;
            $list.append(html);
        });
    } catch (err) {
        console.error('Failed to load career highlights:', err);
        window.notificationService.showError('Could not load career highlights — please refresh.');
        $list.html(`
            <div class="atl-empty-state">
                <i class="fa-solid fa-triangle-exclamation" style="font-size:28px; color:var(--atl-clay); margin-bottom:14px; display:block;"></i>
                <p style="color:var(--atl-muted); margin:0; font-size:13px;">Could not load career highlights. Please refresh and try again.</p>
            </div>
        `);
        $('#clearCareerBtn').hide();
    }
}
window.loadHighlights = loadHighlights;

// ── CAREER HIGHLIGHT EDITOR CONTROLLER — #careerForm lives permanently in the careerDrawer ──
function resetCareerForm() {
    $('#careerForm')[0].reset();
    $('#careerFile').val('');
    initCareerYears();
    $('#careerVideoWarning').hide();
    $('#careerPosterPreview').hide(); $('#careerPosterPreviewImg').attr('src', '');
    editingHighlightId = null;
    careerImageCleared = false;
    var text = document.getElementById('careerUploadText');
    if (text) {
        text.textContent = 'Select or drop a highlight image';
    }
    $('#career-tab-history').hide();
    window.atlActivateDrawerTab('careerDrawer', 'career-tab-edit');
    $('#careerDrawerTitle').html('<i class="fa-solid fa-star"></i> Add Highlight');
    $('#careerSubmitBtn').html('<i class="fa-solid fa-plus-circle"></i> Add Highlight').prop('disabled', false);
}

function applyCareerToEditor(item) {
    editingHighlightId = item.id;
    careerImageCleared = false;
    initCareerYears();                       // ensure year options exist before setting
    $('#careerYear').val(item.year);
    $('#careerTitle').val(item.title || '');
    $('#careerBadge').val(item.badge || '');
    $('#careerLocation').val(item.location || '');
    $('#careerDesc').val(item.description || '');
    $('#careerUrl').val('');
    $('#careerFile').val('');
    $('#careerVideoWarning').hide();
    var text = document.getElementById('careerUploadText');
    if (text) {
        text.textContent = item.image_path ? 'Upload a new image to replace' : 'Select or drop a highlight image';
    }
    if (item.image_path && (item.image_path.startsWith('http') || item.image_path.includes('youtube'))) {
        $('#careerUrl').val(item.image_path);
    }
    if (item.image_path) {
        // A YouTube/Vimeo fallback URL isn't an image resource — putting it straight into
        // <img src> gives a broken image. Extract the real YouTube thumbnail instead (same
        // logic as the card list's safeThumb), matching how loadHighlights() renders it.
        var isVideoMedia = item.image_path.includes('youtube') || item.image_path.includes('vimeo');
        var ytEditMatch = isVideoMedia ? item.image_path.match(/(?:youtu\.be\/|youtube\.com\/(?:embed\/|v\/|watch\?v=|watch\?.+&v=))([\w-]{11})/) : null;
        var previewSrc = isVideoMedia
            ? (ytEditMatch && ytEditMatch[1] ? 'https://img.youtube.com/vi/' + ytEditMatch[1] + '/hqdefault.jpg' : '')
            : item.image_path;
        if (previewSrc) {
            $('#careerPosterPreviewImg').attr('src', previewSrc);
            $('#careerPosterPreview').show();
        } else {
            $('#careerPosterPreview').hide(); $('#careerPosterPreviewImg').attr('src', '');
        }
    } else {
        $('#careerPosterPreview').hide(); $('#careerPosterPreviewImg').attr('src', '');
    }
    $('#careerDrawerTitle').html('<i class="fa-solid fa-star"></i> Edit Highlight');
    $('#careerSubmitBtn').html('<i class="fa-solid fa-floppy-disk"></i> Update Highlight').prop('disabled', false);
    $('#career-tab-history').show();
    if (window.loadChangeHistoryCard) window.loadChangeHistoryCard('careerChangeHistoryList', 'career_highlights', item.id);
}

window.openCareerCreateDrawer = function () {
    resetCareerForm();
    openAtlDrawer('careerDrawer');
    $('#careerTitle').focus();
};

window.openCareerEditDrawer = function (id) {
    var payload = $('#adminCareerList .atl-edit-card[data-id="' + id + '"]').attr('data-payload');
    if (!payload) return;
    resetCareerForm();
    applyCareerToEditor(JSON.parse(decodeURIComponent(payload)));
    openAtlDrawer('careerDrawer');
};

// Cancel from the drawer (Cancel button / close / backdrop) or programmatically
window.careerCancelEdit = function () {
    resetCareerForm();
    closeAtlDrawer('careerDrawer');
};

// Add New Highlight → open the drawer in "add" mode
$('#careerAddNewBtn').on('click', function () { window.openCareerCreateDrawer(); });

// Drawer close / backdrop
$(document).on('click', '#careerDrawerClose, #careerDrawerBackdrop', function () {
    careerCancelEdit();
});

// Delete a highlight
$(document).on('click', '.remove-career-action', async function (e) {
    e.preventDefault(); e.stopPropagation();
    var id = $(this).data('id');
    if (await window.notificationService.showConfirm({ message: 'Are you sure you want to permanently delete this career highlight?', isDestructive: true })) {
        await apiCall('/api/admin/highlights/' + id, 'DELETE');
        loadHighlights();
    }
});

// Form submission Engine for Career Highlights (one form serves Add + inline Edit).
// Delegated: #careerForm lives in the drawer, which is parsed after this script runs.
$(document).on('submit', '#careerForm', async function (e) {
    e.preventDefault();

    var file = $('#careerFile')[0].files[0];
    var fallbackUrl = $('#careerUrl').val().trim();
    if (fallbackUrl) {
        careerImageCleared = false;
    }
    var $btn = $('#careerSubmitBtn');
    var isEdit = editingHighlightId !== null;

    $btn.prop('disabled', true).html('<i class="fa-solid fa-spinner fa-spin"></i> Saving...');

    var formData = new FormData();
    formData.append('year', $('#careerYear').val());
    formData.append('title', $('#careerTitle').val().trim());
    formData.append('icon', '');
    formData.append('badge', $('#careerBadge').val().trim());
    formData.append('location', $('#careerLocation').val().trim());
    formData.append('description', $('#careerDesc').val().trim());
    formData.append('fallback_url', fallbackUrl);

    if (file) {
        formData.append('file', file);
    }

    try {
        let url = '/api/admin/highlights';

        if (isEdit) {
            // Edit existing row via PUT (backend PUT is JSON-only, not multer).
            url = '/api/admin/highlights/' + editingHighlightId;
            const jsonBody = {};
            formData.forEach((value, key) => jsonBody[key] = value);
            if (careerImageCleared) {
                jsonBody.clear_image = true;
            }
            // If a new image file was chosen, upload it first and pass its path as fallback_url
            // so the backend updates image_path on THIS row (instead of creating a duplicate).
            if (file) {
                const uploaded = await uploadFileToServer(file, 'career');
                if (uploaded) jsonBody.fallback_url = uploaded;
            }
            await apiCall(url, 'PUT', jsonBody);
        } else {
            // New create (multipart — apiCall forces JSON, so raw fetch + res.ok)
            const res = await fetch(url, { method: 'POST', body: formData });
            if (!res.ok) throw new Error('Server error saving highlight');
        }

        closeAtlDrawer('careerDrawer');
        resetCareerForm();
        await loadHighlights();          // re-docks the form home (guard) and rebuilds the list
        window.notificationService.showSuccess(isEdit ? 'Highlight updated.' : 'Highlight added.');
    } catch (err) {
        console.error("Career save error", err);
        window.notificationService.showError('An error occurred while saving.');
        $btn.html(isEdit ? '<i class="fa-solid fa-floppy-disk"></i> Update Highlight' : '<i class="fa-solid fa-plus-circle"></i> Add Highlight').prop('disabled', false);
    }
});

// Clear image button handler
$(document).on('click', '#btnCareerClearImage', function() {
    careerImageCleared = true;
    $('#careerFile').val('');
    $('#careerUrl').val('');
    $('#careerPosterPreview').hide();
    $('#careerPosterPreviewImg').attr('src', '');
    var text = document.getElementById('careerUploadText');
    if (text) {
        text.textContent = 'Select or drop a highlight image';
    }
});

// Block video selection on change (delegated — #careerFile is inside the drawer)
$(document).on('change', '#careerFile', function() {
    var file = this.files[0];
    var text = document.getElementById('careerUploadText');
    if (text) {
        text.textContent = file ? file.name : 'Select or drop a highlight image';
    }
    if (file && file.type.startsWith('video/')) {
        $('#careerVideoWarning').show();
    } else {
        $('#careerVideoWarning').hide();
        if (file) {
            careerImageCleared = false;
            var reader = new FileReader();
            reader.onload = function(ev) {
                $('#careerPosterPreviewImg').attr('src', ev.target.result);
                $('#careerPosterPreview').show();
            };
            reader.readAsDataURL(file);
        }
    }
});

// Drag-and-drop highlighting + drop-to-fill for the career upload zone.
// Bound after DOM ready (the zone is in the drawer); the element persists through dock moves,
// so its listeners travel with it.
$(function () {
    const zone = document.getElementById('careerUploadZone');
    if (!zone) return;
    ['dragenter', 'dragover'].forEach(function (ev) {
        zone.addEventListener(ev, function (e) {
            e.preventDefault(); e.stopPropagation();
            zone.classList.add('um-upload-zone--dragging');
            if (ev === 'dragenter') {
                var t = document.getElementById('careerUploadText');
                if (t) t.textContent = 'Drop image here';
            }
        });
    });
    ['dragleave', 'drop'].forEach(function (ev) {
        zone.addEventListener(ev, function (e) { e.preventDefault(); e.stopPropagation(); zone.classList.remove('um-upload-zone--dragging'); });
    });
    zone.addEventListener('drop', function (e) {
        const dropped = e.dataTransfer && e.dataTransfer.files;
        if (dropped && dropped.length) {
            const input = document.getElementById('careerFile');
            try { input.files = dropped; } catch (err) { /* some browsers disallow direct assignment */ }
            $('#careerFile').trigger('change');
        }
    });
});

// Clear All Highlights (administrator-gated deletes; confirm is destructive)
$('#clearCareerBtn').on('click', async function () {
    const ids = $('#adminCareerList .atl-edit-card').map(function () { return $(this).data('id'); }).get();
    if (!ids.length) return;
    if (!(await window.notificationService.showConfirm({ title: 'Clear Highlights', message: 'Permanently remove all ' + ids.length + ' career highlight(s)? This cannot be undone.', isDestructive: true }))) return;
    try {
        for (const id of ids) {
            await apiCall('/api/admin/highlights/' + id, 'DELETE');
        }
        window.notificationService.showSuccess('All career highlights removed.');
        loadHighlights();
    } catch (e) {
        console.error('Clear all highlights failed:', e);
        window.notificationService.showError('Could not clear all highlights.');
    }
});
