// Phase 6 (HOUSEKEEPING-NOTES.md): relocated from admin.html verbatim — the "1. Home Slider Logic"
// block, minus uploadFileToServer, which sat at the very top of this labeled block but is a shared
// upload helper (admin.html ~13462) also used by Career/Gallery/Testimonials — Phase 7 "Shared
// candidate", left behind in admin.html. window.atlActivateDrawerTab (admin.html ~14783) is called
// from inside this block but likewise NOT moved, same reason.
//
// openHomeCreateDrawer/openHomeEditDrawer/homeCancelEdit were already window-attached in the
// original source (Home Slider uses genuine inline onclick="" attributes — a dynamically-generated
// onclick="window.openHomeEditDrawer(...)" per card, and a static onclick="homeCancelEdit();" on
// the drawer's own Cancel button) — kept exactly as-is.

// Upload each picked file then create a slider row (ADD mode). Returns count added.
async function uploadHomeFiles(fileList, alt) {
    var added = 0;
    for (const file of fileList) {
        const filePath = await uploadFileToServer(file, 'home');
        if (filePath) {
            const res = await fetch('/api/admin/home-slider', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ url: filePath, alt: alt || '', file_name: file.name, file_size: (file.size / 1024).toFixed(1) + ' KB' })
            });
            if (!res.ok) throw new Error((await res.text()) || 'Server error adding image');
            added++;
        }
    }
    return added;
}

// File pick → update the zone label + show a preview (the actual upload happens on submit).
// Delegated because #homeFile lives in the drawer (parsed after this script runs).
$(document).on('change', '#homeFile', function () {
    var files = this.files;
    var text = document.getElementById('homeUploadText');
    if (files && files.length) {
        if (text) text.textContent = files.length === 1 ? files[0].name : files.length + ' files selected';
        try {
            var rdr = new FileReader();
            rdr.onload = function (ev) { $('#homePreviewImg').attr('src', ev.target.result); $('#homePreview').show(); };
            rdr.readAsDataURL(files[0]);
        } catch (e) {}
    }
});

// Drag-and-drop onto the upload zone — fill the input (bound after ready; the zone persists through docking).
$(function () {
    const zone = document.getElementById('homeUploadZone');
    if (!zone) return;
    ['dragenter', 'dragover'].forEach(function (ev) { zone.addEventListener(ev, function (e) { e.preventDefault(); e.stopPropagation(); zone.classList.add('um-upload-zone--dragging'); var t = document.getElementById('homeUploadText'); if (t && ev === 'dragenter') t.textContent = 'Drop images here'; }); });
    ['dragleave', 'drop'].forEach(function (ev) { zone.addEventListener(ev, function (e) { e.preventDefault(); e.stopPropagation(); zone.classList.remove('um-upload-zone--dragging'); }); });
    zone.addEventListener('drop', function (e) {
        var dropped = e.dataTransfer && e.dataTransfer.files;
        if (dropped && dropped.length) { var input = document.getElementById('homeFile'); try { input.files = dropped; } catch (err) {} $('#homeFile').trigger('change'); }
    });
});

async function fetchHomeSlider() {
    try {
        const data = await apiCall('/api/admin/home-slider');
        renderHomeList(data);
    } catch (err) {
        console.error("Failed to fetch slider items:", err);
        window.notificationService.showError('Could not load slider items — please refresh.');
    }
}
window.fetchHomeSlider = fetchHomeSlider;

function renderHomeList(data) {
    const $list = $('#adminHomeList');
    $list.empty();

    if (!data || data.length === 0) {
        $list.html(`
            <div class="atl-empty-state">
                <i class="fas fa-images" style="font-size: 32px; color: var(--atl-muted-dim); margin-bottom: 14px; display: block;"></i>
                <p style="color: var(--atl-muted); margin: 0; font-size: 13px;">No slides yet. Use “Add Slide” to add your first carousel image.</p>
            </div>
        `);
        $('#clearHomeBtn').hide();
        return;
    }

    $('#clearHomeBtn').show();
    data.forEach((item) => {
        var altText = item.alt ? item.alt : 'No alt text';
        var meta = (item.file_size || '') + (item.uploader_name ? ((item.file_size ? ' • ' : '') + 'By ' + item.uploader_name) : '');
        var encoded = encodeURIComponent(JSON.stringify(item));
        const html = `
        <article class="atl-edit-card" data-id="${item.id}" data-payload="${encoded}">
          <div class="atl-card-inner">
            <div class="atl-edit-card__header">
              <span class="atl-drag-handle" draggable="true" title="Drag to reorder" aria-label="Drag to reorder"><i class="fa-solid fa-grip-vertical"></i></span>
              <div class="atl-edit-card__thumb">
                <img src="${item.url}" onerror="this.onerror=null;this.src='https://placehold.co/72x100/1a1a1a/D4AF37?text=No+Image';" alt="${altText}">
              </div>
              <div style="flex:1; min-width:0;">
                <h3 class="atl-edit-card__title">${item.file_name || 'Web URL Image'}</h3>
                <p class="atl-edit-card__subtitle">${altText}</p>
                <div class="atl-edit-card__desc">${meta || 'Slider image'}</div>
              </div>
              <div style="display:flex; flex-direction:column; align-items:flex-end; gap:6px; flex-shrink:0;">
                <button type="button" class="atl-btn atl-btn--ghost um-btn--sm" onclick="window.openHomeEditDrawer(${item.id})" title="Edit slide" aria-label="Edit slide">
                  <i class="fa-solid fa-pen"></i>
                </button>
                <button type="button" class="um-btn um-btn--danger um-btn--sm remove-home-btn" data-id="${item.id}" title="Remove slide" aria-label="Remove slide">
                  <i class="fas fa-trash-alt"></i>
                </button>
              </div>
            </div>
          </div>
        </article>`;
        $list.append(html);
    });

    initDraggableSlider();
}

// Drag/Drop reorder — listeners attached once (dataset.dragInit guard is load-bearing).
// Drag starts ONLY from the .atl-drag-handle grip, so card-body clicks still expand cleanly.
function initDraggableSlider() {
    const list = document.getElementById('adminHomeList');
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
            const res = await fetch('/api/admin/home-slider/reorder', {
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

// ── HOME SLIDER EDITOR CONTROLLER — #homeForm lives permanently in the homeDrawer ──
var homeEditId = null;
function resetHomeForm() {
    $('#homeForm')[0].reset();
    $('#homeFile').val('');
    $('#homePreview').hide(); $('#homePreviewImg').attr('src', '');
    var t = document.getElementById('homeUploadText'); if (t) t.textContent = 'Drag & drop or click to upload';
    homeEditId = null;
    $('#home-tab-history').hide();
    window.atlActivateDrawerTab('homeDrawer', 'home-tab-edit');
    $('#homeDrawerTitle').html('<i class="fa-solid fa-film"></i> Add Slide');
    $('#homeSubmitBtn').html('<i class="fas fa-plus-circle"></i> Add to Slider').prop('disabled', false);
}
function applyHomeToEditor(item) {
    homeEditId = item.id;
    $('#homeAlt').val(item.alt || '');
    $('#homeUrl').val('');
    $('#homeFile').val('');
    var t = document.getElementById('homeUploadText'); if (t) t.textContent = 'Upload a new image to replace';
    if (item.url) { $('#homePreviewImg').attr('src', item.url); $('#homePreview').show(); }
    else { $('#homePreview').hide(); $('#homePreviewImg').attr('src', ''); }
    $('#homeDrawerTitle').html('<i class="fa-solid fa-film"></i> Edit Slide');
    $('#homeSubmitBtn').html('<i class="fas fa-floppy-disk"></i> Update Slide').prop('disabled', false);
    $('#home-tab-history').show();
    if (window.loadChangeHistoryCard) window.loadChangeHistoryCard('homeChangeHistoryList', 'home_slider', item.id);
}
window.openHomeCreateDrawer = function () {
    resetHomeForm();
    openAtlDrawer('homeDrawer');
    $('#homeAlt').focus();
};
window.openHomeEditDrawer = function (id) {
    var p = $('#adminHomeList .atl-edit-card[data-id="' + id + '"]').attr('data-payload');
    if (!p) return;
    resetHomeForm();
    applyHomeToEditor(JSON.parse(decodeURIComponent(p)));
    openAtlDrawer('homeDrawer');
};
window.homeCancelEdit = function () {
    resetHomeForm();
    closeAtlDrawer('homeDrawer');
};
$('#homeAddNewBtn').on('click', function () { window.openHomeCreateDrawer(); });
$(document).on('click', '#homeDrawerClose, #homeDrawerBackdrop', function () { homeCancelEdit(); });

// Delete a slide
$(document).on('click', '.remove-home-btn', async function (e) {
    e.preventDefault(); e.stopPropagation();
    const id = $(this).data('id');
    if (!(await window.notificationService.showConfirm({ message: "Remove this slider image?", isDestructive: true }))) return;
    try {
        const res = await fetch(`/api/admin/home-slider/${id}`, { method: 'DELETE' });
        if (res.ok) fetchHomeSlider();
        else window.notificationService.showError('Could not remove slide.');
    } catch (e2) {
        console.error("Delete failed:", e2);
        window.notificationService.showError('Could not remove slide.');
    }
});

// Clear all slides
$('#clearHomeBtn').on('click', async function () {
    const ids = $('#adminHomeList .atl-edit-card').map(function () { return $(this).data('id'); }).get();
    if (!ids.length) return;
    if (!(await window.notificationService.showConfirm({ title: 'Clear Slider', message: 'Permanently remove all ' + ids.length + ' slider image(s)? This cannot be undone.', isDestructive: true }))) return;
    try {
        for (const id of ids) {
            await apiCall('/api/admin/home-slider/' + id, 'DELETE');
        }
        window.notificationService.showSuccess('All slider images removed.');
        fetchHomeSlider();
    } catch (e) {
        console.error("Clear all failed:", e);
        window.notificationService.showError('Could not clear all slides.');
    }
});

// Submit — Add (multi-file or URL) / Edit (alt + optional image replace). Delegated (drawer form).
$(document).on('submit', '#homeForm', async function (e) {
    e.preventDefault();
    const urlInput = $('#homeUrl').val().trim();
    const alt      = $('#homeAlt').val().trim();
    const files    = $('#homeFile')[0].files;
    const $btn     = $('#homeSubmitBtn');

    // EDIT mode — PUT alt (+ optional replacement image)
    if (homeEditId !== null) {
        $btn.prop('disabled', true).html('<i class="fas fa-spinner fa-spin"></i> Saving...');
        try {
            var body = { alt: alt };
            if (files && files.length) {
                var uploaded = await uploadFileToServer(files[0], 'home');
                if (uploaded) { body.url = uploaded; body.file_name = files[0].name; }
            } else if (urlInput) {
                body.url = urlInput; body.file_name = 'External URL';
            }
            await apiCall('/api/admin/home-slider/' + homeEditId, 'PUT', body);
            closeAtlDrawer('homeDrawer');
            resetHomeForm();
            await fetchHomeSlider();
            window.notificationService.showSuccess('Slide updated.');
        } catch (err) {
            console.error('Home edit error', err);
            window.notificationService.showError('Could not update slide.');
            $btn.html('<i class="fas fa-floppy-disk"></i> Update Slide').prop('disabled', false);
        }
        return;
    }

    // ADD mode
    if (!urlInput && (!files || files.length === 0)) {
        window.notificationService.showError('Please enter an image URL or select files to upload.');
        return;
    }
    $btn.prop('disabled', true).html('<i class="fas fa-spinner fa-spin"></i> Adding...');
    try {
        if (files && files.length > 0) {
            await uploadHomeFiles(Array.from(files), alt);
        } else {
            const res = await fetch('/api/admin/home-slider', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ url: urlInput, alt: alt, file_name: 'External URL', file_size: 'Unknown' })
            });
            if (!res.ok) throw new Error('Server error adding image');
        }
        closeAtlDrawer('homeDrawer');
        resetHomeForm();
        await fetchHomeSlider();
        window.notificationService.showSuccess('Slide(s) added.');
    } catch (err) {
        console.error('Upload error:', err);
        window.notificationService.showError('Failed to add image(s).');
        $btn.html('<i class="fas fa-plus-circle"></i> Add to Slider').prop('disabled', false);
    }
});


// Initialize (Moved to tab-switch event for reliability)
// fetchHomeSlider();
