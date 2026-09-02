// Phase 6 (HOUSEKEEPING-NOTES.md): relocated from admin.html verbatim — the "7. Existing Gallery
// Logic" block. window.atlActivateDrawerTab (admin.html ~14783) and uploadFileToServer (admin.html
// ~13462) are called from inside this block but NOT moved here: both are shared verbatim by other
// sections — Phase 7 "Shared candidates", left in admin.html untouched.
//
// openGalleryCreateDrawer/openGalleryEditDrawer/galleryCancelEdit were already window-attached in
// the original source (Gallery uses genuine inline onclick="" attributes — a dynamically-generated
// onclick="window.openGalleryEditDrawer(...)" per card, and a static onclick="galleryCancelEdit();"
// on the drawer's own Cancel button) — kept exactly as-is.
async function loadGallery() {
    var $list = $('#adminGalleryList');
    try {
        const data = await apiCall('/api/public/gallery');

        if (!Array.isArray(data) || data.length === 0) {
            $list.html(`
                <div class="atl-empty-state">
                    <i class="fa-solid fa-images" style="font-size:32px; color:var(--atl-muted-dim); margin-bottom:14px; display:block;"></i>
                    <p style="color:var(--atl-muted); margin:0; font-size:13px;">No gallery items yet. Use “Add Gallery Media” to add your first image.</p>
                </div>
            `);
            $('#clearGalleryBtn').hide();
            return;
        }

        $list.empty();
        $('#clearGalleryBtn').show();

        data.forEach(function (item) {
            var urlLower = item.image_path ? item.image_path.toLowerCase() : '';
            var isVideo = urlLower.startsWith('data:video') || /\.(mp4|webm|ogg)$/.test(urlLower);
            var title = item.title || 'Untitled';
            var uploaded = item.created_at ? new Date(item.created_at).toLocaleDateString('en-ZA', { year:'numeric', month:'short', day:'numeric' }) : '';
            var encoded = encodeURIComponent(JSON.stringify(item));
            var thumb = isVideo
                ? `<video src="${item.image_path}" muted playsinline style="width:100%; height:100%; object-fit:cover;"></video>`
                : `<img src="${item.image_path || ''}" alt="${title}" onerror="this.onerror=null;this.src='https://placehold.co/72x100/1a1a1a/D4AF37?text=No+Image';">`;

            var metaText = [];
            if (item.uploader_name) metaText.push('By ' + item.uploader_name);
            if (item.location) metaText.push(item.location);
            if (uploaded) metaText.push('Uploaded ' + uploaded);
            var subtitle = metaText.length > 0 ? metaText.join(' &middot; ') : 'Gallery image';

            var html = `
            <article class="atl-edit-card" data-id="${item.id}" data-payload="${encoded}">
              <div class="atl-card-inner">
                <div class="atl-edit-card__header">
                  <span class="atl-drag-handle" draggable="true" title="Drag to reorder" aria-label="Drag to reorder"><i class="fa-solid fa-grip-vertical"></i></span>
                  <div class="atl-edit-card__thumb">
                    ${thumb}
                    ${isVideo ? `<div class="atl-edit-card__video-badge"><i class="fa fa-play"></i> VIDEO</div>` : ''}
                  </div>
                  <div style="flex:1; min-width:0;">
                    <h3 class="atl-edit-card__title">${title}</h3>
                    <p class="atl-edit-card__subtitle">${subtitle}</p>
                  </div>
                  <div style="display:flex; flex-direction:column; align-items:flex-end; gap:6px; flex-shrink:0;">
                    <button type="button" class="atl-btn atl-btn--ghost um-btn--sm" onclick="window.openGalleryEditDrawer(${item.id})" title="Edit media" aria-label="Edit media">
                      <i class="fa-solid fa-pen"></i>
                    </button>
                    <button type="button" class="um-btn um-btn--danger um-btn--sm remove-gallery-action" data-id="${item.id}" title="Delete media" aria-label="Delete media">
                      <i class="fa-solid fa-trash-can"></i>
                    </button>
                  </div>
                </div>
              </div>
            </article>`;
            $list.append(html);
        });

        initDraggableGallery();
    } catch (err) {
        console.error('Failed to load gallery:', err);
        $list.html(`
            <div class="atl-empty-state">
                <i class="fa-solid fa-triangle-exclamation" style="font-size:28px; color:var(--atl-clay); margin-bottom:14px; display:block;"></i>
                <p style="color:var(--atl-muted); margin:0; font-size:13px;">Could not load the gallery. Please refresh and try again.</p>
            </div>
        `);
        $('#clearGalleryBtn').hide();
    }
}
window.loadGallery = loadGallery;

// Drag/Drop reorder — listeners attached once (dataset.dragInit guard is load-bearing).
// Drag starts ONLY from the .atl-drag-handle grip, so card-body clicks still open the editor.
// Mirrors initDraggableSlider() in the Home Slider section above.
function initDraggableGallery() {
    const list = document.getElementById('adminGalleryList');
    if (!list || list.dataset.dragInit) return;
    list.dataset.dragInit = '1';
    let draggedItem = null;

    list.addEventListener('dragstart', (e) => {
        if (!e.target.closest('.atl-drag-handle')) { e.preventDefault(); return; }
        draggedItem = e.target.closest('.atl-edit-card');
        if (!draggedItem) return;
        e.dataTransfer.effectAllowed = 'move';
        setTimeout(() => { if (draggedItem) draggedItem.style.opacity = '0.4'; }, 0);
    });

    list.addEventListener('dragend', async () => {
        if (!draggedItem) return;
        draggedItem.style.opacity = '1';

        // Save new order to DB
        const newOrder = Array.from(list.querySelectorAll('.atl-edit-card')).map(el => el.dataset.id);
        try {
            const res = await fetch('/api/admin/gallery/reorder', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ order: newOrder })
            });
            if (!res.ok) window.notificationService.showError('Reorder failed — please refresh and try again.');
        } catch (e) {
            console.error("Reorder failed:", e);
            window.notificationService.showError('Reorder failed — please refresh and try again.');
        }
        draggedItem = null;
    });

    list.addEventListener('dragover', (e) => {
        if (!draggedItem) return;
        e.preventDefault();
        const overItem = e.target.closest('.atl-edit-card');
        if (overItem && overItem !== draggedItem) {
            const rect = overItem.getBoundingClientRect();
            const midpoint = rect.top + rect.height / 2;
            if (e.clientY < midpoint) {
                list.insertBefore(draggedItem, overItem);
            } else {
                list.insertBefore(draggedItem, overItem.nextSibling);
            }
        }
    });
}

// Block video selection (delegated — #mediaFile is in the drawer)
$(document).on('change', '#mediaFile', function () {
    var hasVideo = false;
    for (var i = 0; i < this.files.length; i++) { if (this.files[i].type.startsWith('video/')) { hasVideo = true; break; } }
    $('#videoWarning').toggle(hasVideo);

    var files = this.files;
    var text = document.getElementById('galleryUploadText');
    if (text) {
        if (files && files.length) {
            text.textContent = files.length === 1 ? files[0].name : files.length + ' files selected';
        } else {
            text.textContent = galleryEditId !== null ? 'Upload a new image to replace' : 'Drag & drop or select gallery images';
        }
    }
});

// ── GALLERY MEDIA EDITOR CONTROLLER — #addMediaForm lives permanently in the galleryDrawer ──
var galleryEditId = null;
function resetGalleryForm() {
    $('#addMediaForm')[0].reset();
    $('#mediaFile').val('');
    $('#galleryImageFields').show();
    var text = document.getElementById('galleryUploadText');
    if (text) {
        text.textContent = 'Drag & drop or select gallery images';
    }
    $('#videoWarning').hide();
    $('#galleryPreview').hide(); $('#galleryPreviewImg').attr('src', '');
    galleryEditId = null;
    $('#gallery-tab-history').hide();
    window.atlActivateDrawerTab('galleryDrawer', 'gallery-tab-edit');
    $('#galleryDrawerTitle').html('<i class="fa-solid fa-images"></i> Add Media');
    $('#submitBtn').html('<i class="fa-solid fa-plus-circle"></i> Add to Gallery').prop('disabled', false);
}
function applyGalleryToEditor(item) {
    galleryEditId = item.id;
    $('#galleryImageFields').show();   // image fields stay visible so the image can be replaced
    $('#mediaFile').val('');
    $('#mediaUrl').val('');
    $('#videoWarning').hide();
    $('#mediaAlt').val(item.title || '');
    var text = document.getElementById('galleryUploadText');
    if (text) {
        text.textContent = 'Upload a new image to replace';
    }
    if (item.image_path) { $('#galleryPreviewImg').attr('src', item.image_path); $('#galleryPreview').show(); }
    else { $('#galleryPreview').hide(); $('#galleryPreviewImg').attr('src', ''); }
    $('#galleryDrawerTitle').html('<i class="fa-solid fa-images"></i> Edit Media');
    $('#submitBtn').html('<i class="fa-solid fa-floppy-disk"></i> Update Media').prop('disabled', false);
    $('#gallery-tab-history').show();
    if (window.loadChangeHistoryCard) window.loadChangeHistoryCard('galleryChangeHistoryList', 'gallery_images', item.id);
}
window.openGalleryCreateDrawer = function () {
    resetGalleryForm();
    openAtlDrawer('galleryDrawer');
    $('#mediaAlt').focus();
};
window.openGalleryEditDrawer = function (id) {
    var p = $('#adminGalleryList .atl-edit-card[data-id="' + id + '"]').attr('data-payload');
    if (!p) return;
    resetGalleryForm();
    applyGalleryToEditor(JSON.parse(decodeURIComponent(p)));
    openAtlDrawer('galleryDrawer');
};
window.galleryCancelEdit = function () {
    resetGalleryForm();
    closeAtlDrawer('galleryDrawer');
};
$('#galleryAddNewBtn').on('click', function () { window.openGalleryCreateDrawer(); });
$(document).on('click', '#galleryDrawerClose, #galleryDrawerBackdrop', function () { galleryCancelEdit(); });

// Add / Edit submit (delegated — #addMediaForm lives in the drawer)
$(document).on('submit', '#addMediaForm', async function (e) {
    e.preventDefault();
    var $btn = $('#submitBtn');
    var titleInput = $('#mediaAlt').val().trim();

    // EDIT mode — update title, and optionally replace the image (upload file or paste URL)
    if (galleryEditId !== null) {
        var editFile = $('#mediaFile')[0].files[0];
        var editUrl  = $('#mediaUrl').val().trim();
        if (editFile && editFile.type.startsWith('video/')) {
            window.notificationService.showError('Videos cannot be used as gallery images.');
            return;
        }
        $btn.prop('disabled', true).html('<i class="fa-solid fa-spinner fa-spin"></i> Saving...');
        try {
            var body = {
                title: titleInput
            };
            if (editFile) {
                var uploaded = await uploadFileToServer(editFile, 'gallery');
                if (uploaded) body.fallback_url = uploaded;
            } else if (editUrl) {
                body.fallback_url = editUrl;
            }
            await apiCall('/api/admin/gallery/' + galleryEditId, 'PUT', body);
            closeAtlDrawer('galleryDrawer');
            resetGalleryForm();
            await loadGallery();
            window.notificationService.showSuccess('Media updated.');
        } catch (err) {
            console.error('Gallery edit error', err);
            window.notificationService.showError('Could not update media.');
            $btn.html('<i class="fa-solid fa-floppy-disk"></i> Update Media').prop('disabled', false);
        }
        return;
    }

    // ADD mode — multi-file or URL create (gallery is images only; videos are skipped)
    var urlInput = $('#mediaUrl').val().trim();
    var allFiles = $('#mediaFile')[0].files;
    var imageFiles = Array.prototype.slice.call(allFiles).filter(function (f) { return !f.type.startsWith('video/'); });
    var hadVideo = imageFiles.length < allFiles.length;
    if (!urlInput && imageFiles.length === 0) {
        window.notificationService.showError(hadVideo
            ? 'Videos cannot be uploaded to the gallery — please choose image files or paste a URL.'
            : 'Please provide either an image URL or choose files to upload.');
        return;
    }
    $btn.prop('disabled', true).html('<i class="fa-solid fa-spinner fa-spin"></i> Processing...');
    try {
        if (imageFiles.length > 0) {
            for (var i = 0; i < imageFiles.length; i++) {
                var fd = new FormData();
                fd.append('section', 'gallery');
                fd.append('title', titleInput || imageFiles[i].name);
                fd.append('file', imageFiles[i]);
                var r = await fetch('/api/admin/gallery', { method: 'POST', credentials: 'include', body: fd });
                if (!r.ok) throw new Error('Upload failed');
            }
        } else {
            var fd2 = new FormData();
            fd2.append('section', 'gallery');
            fd2.append('title', titleInput || 'Web Image');
            fd2.append('fallback_url', urlInput);
            var r2 = await fetch('/api/admin/gallery', { method: 'POST', credentials: 'include', body: fd2 });
            if (!r2.ok) throw new Error('Upload failed');
        }
        closeAtlDrawer('galleryDrawer');
        resetGalleryForm();
        await loadGallery();
        window.notificationService.showSuccess(hadVideo ? 'Images added (video files were skipped).' : 'Media added to gallery.');
    } catch (err) {
        console.error("Gallery upload error", err);
        window.notificationService.showError("An error occurred while uploading.");
        $btn.html('<i class="fa-solid fa-plus-circle"></i> Add to Gallery').prop('disabled', false);
    }
});

// Delete a gallery item
$(document).on('click', '.remove-gallery-action', async function (e) {
    e.preventDefault(); e.stopPropagation();
    var id = $(this).data('id');
    if (await window.notificationService.showConfirm({ message: 'Are you sure you want to permanently remove this image?', isDestructive: true })) {
        await apiCall('/api/admin/gallery/' + id, 'DELETE');
        loadGallery();
    }
});

// Clear All gallery images
$('#clearGalleryBtn').on('click', async function () {
    var ids = $('#adminGalleryList .atl-edit-card').map(function () { return $(this).data('id'); }).get();
    if (!ids.length) return;
    if (!(await window.notificationService.showConfirm({ title: 'Clear Gallery', message: 'Permanently remove all ' + ids.length + ' image(s)? This cannot be undone.', isDestructive: true }))) return;
    try {
        for (const gid of ids) { await apiCall('/api/admin/gallery/' + gid, 'DELETE'); }
        window.notificationService.showSuccess('All gallery images removed.');
        loadGallery();
    } catch (err) {
        console.error('Clear gallery failed:', err);
        window.notificationService.showError('Could not clear the gallery.');
    }
});
