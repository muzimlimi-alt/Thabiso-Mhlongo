// Phase 6 (HOUSEKEEPING-NOTES.md): relocated from admin.html verbatim — the "5c. Testimonials
// Logic" block. window.atlActivateDrawerTab (admin.html ~14783) and uploadFileToServer (admin.html
// ~13462) are called from inside this block but NOT moved here: both are shared verbatim by other
// sections (atlActivateDrawerTab by Events/Gallery/Career/Home Slider/Footprint/Testimonials;
// uploadFileToServer by Home Slider/About Me/Testimonials) — Phase 7 "Shared candidates", left in
// admin.html untouched.
let editingTestimonialId = null;
let testimonialImageCleared = false;

function resetTestimonialsForm() {
    $('#testimonialsForm')[0].reset();
    $('#testimonialFile').val('');
    $('#testimonialPhotoPreview').hide();
    $('#testimonialPhotoPreviewImg').attr('src', '');
    $('#err-testimonialsForm').hide();
    editingTestimonialId = null;
    testimonialImageCleared = false;
    var text = document.getElementById('testimonialUploadText');
    if (text) text.textContent = 'Select or drop a photo';
    $('#testimonials-tab-history').hide();
    window.atlActivateDrawerTab('testimonialsDrawer', 'testimonials-tab-edit');
    $('#testimonialsDrawerTitle').html('<i class="fa-solid fa-quote-left"></i> Add Testimonial');
    $('#testimonialsSubmitBtn').html('<i class="fa-solid fa-plus-circle"></i> Add Testimonial').prop('disabled', false);
}
window.resetTestimonialsForm = resetTestimonialsForm;

function openTestimonialEditor(item) {
    resetTestimonialsForm();
    editingTestimonialId = item.id;
    $('#testimonialName').val(item.name || '');
    $('#testimonialDesignation').val(item.designation || '');
    $('#testimonialQuote').val(item.quote || '');
    if (item.image_path) {
        $('#testimonialPhotoPreviewImg').attr('src', item.image_path);
        $('#testimonialPhotoPreview').show();
    }
    var text = document.getElementById('testimonialUploadText');
    if (text) text.textContent = 'Upload a new photo to replace';
    $('#testimonialsDrawerTitle').html('<i class="fa-solid fa-quote-left"></i> Edit Testimonial');
    $('#testimonialsSubmitBtn').html('<i class="fa-solid fa-floppy-disk"></i> Update Testimonial');
    $('#testimonials-tab-history').show();
    if (window.loadChangeHistoryCard) window.loadChangeHistoryCard('testimonialsChangeHistoryList', 'testimonials', item.id);
    openAtlDrawer('testimonialsDrawer');
}
window.openTestimonialEditor = openTestimonialEditor;

// Referenced from an inline onerror="" attribute, so it must hang off window regardless
// of which <script> block this one turns out to be (re-)loaded inside.
window.tsThumbFallback = function (imgEl) {
    var initial = (imgEl.alt || '?').trim().charAt(0).toUpperCase() || '?';
    var div = document.createElement('div');
    div.style.cssText = 'width:100%; height:100%; display:flex; align-items:center; justify-content:center; background:var(--atl-amber); color:var(--atl-bg, #0a0a0a); font-family:var(--atl-font-display, serif); font-size:22px; font-weight:600;';
    div.textContent = initial;
    if (imgEl.parentElement) {
        imgEl.parentElement.innerHTML = '';
        imgEl.parentElement.appendChild(div);
    }
};

async function loadTestimonials() {
    var $list = $('#adminTestimonialsList');
    $list.html('<div class="um-empty-state" style="grid-column:1/-1; padding:30px 20px;"><i class="fa-solid fa-circle-notch fa-spin" style="font-size:22px;color:var(--atl-amber);display:block;margin-bottom:8px;"></i>Loading testimonials…</div>');
    try {
        const statusFilter = $('#testimonialsStatusFilter').val();
        const url = '/api/admin/testimonials' + (statusFilter ? '?status=' + statusFilter : '');
        const rows = await apiCall(url);
        const items = Array.isArray(rows) ? rows : [];

        // Pending count badge — always reflects the true total, independent of the current filter.
        const allRows = statusFilter ? await apiCall('/api/admin/testimonials') : items;
        const pendingCount = (Array.isArray(allRows) ? allRows : []).filter(r => r.status === 'pending').length;
        const $badge = $('#testimonialsPendingBadge');
        if (pendingCount > 0) $badge.text(pendingCount + ' Pending Review').show(); else $badge.hide();

        $list.empty();
        if (!items.length) {
            $list.html('<div class="um-empty-state" style="grid-column:1/-1; padding:30px 20px;"><i class="fa-solid fa-quote-left" style="font-size:22px;color:var(--atl-muted-dim);display:block;margin-bottom:8px;"></i>No testimonials here yet.</div>');
            return;
        }
        items.forEach(function (item) {
            var safeName = $('<span>').text(item.name || '').html();
            var safeDesignation = $('<span>').text(item.designation || '').html();
            var safeQuote = $('<span>').text(item.quote || '').html();
            var initial = (item.name || '?').trim().charAt(0).toUpperCase();
            var monogramHtml = `<div style="width:100%; height:100%; display:flex; align-items:center; justify-content:center; background:var(--atl-amber); color:var(--atl-bg, #0a0a0a); font-family:var(--atl-font-display, serif); font-size:22px; font-weight:600;">${initial}</div>`;
            var thumbHtml = item.image_path
                ? `<img src="${$('<span>').text(item.image_path).html()}" alt="${safeName}" onerror="window.tsThumbFallback(this)">`
                : monogramHtml;
            var statusBadge = item.status === 'approved'
                ? '<span class="atl-badge atl-badge--confirmed">Approved</span>'
                : item.status === 'rejected'
                    ? '<span class="atl-badge atl-badge--cancelled">Rejected</span>'
                    : '<span class="atl-badge atl-badge--pending">Pending</span>';
            var moderationBtns = item.status === 'pending'
                ? `<button type="button" class="atl-btn atl-btn--ghost um-btn--sm testimonial-approve-btn" data-id="${item.id}" title="Approve" style="color:#34d399;"><i class="fa-solid fa-check"></i></button>
                   <button type="button" class="atl-btn atl-btn--ghost um-btn--sm testimonial-reject-btn" data-id="${item.id}" title="Reject" style="color:var(--atl-clay);"><i class="fa-solid fa-xmark"></i></button>`
                : `<button type="button" class="atl-btn atl-btn--ghost um-btn--sm testimonial-retract-btn" data-id="${item.id}" title="${item.status === 'approved' ? 'Retract from public site (back to Pending Review)' : 'Move back to Pending Review'}" style="color:var(--atl-amber);"><i class="fa-solid fa-rotate-left"></i></button>`;
            var html = `
                <article class="atl-edit-card" data-id="${item.id}">
                    <div class="atl-card-inner">
                        <div class="atl-edit-card__header">
                            <div class="atl-edit-card__thumb">${thumbHtml}</div>
                            <div style="flex:1; min-width:0;">
                                <h3 class="atl-edit-card__title">${safeName}</h3>
                                <p class="atl-edit-card__subtitle">${safeDesignation}</p>
                                <div class="atl-edit-card__desc">${statusBadge} <span style="margin-left:8px;">${safeQuote}</span></div>
                            </div>
                            <div style="display:flex; flex-direction:column; align-items:flex-end; gap:6px; flex-shrink:0;">
                                ${moderationBtns}
                                <button type="button" class="atl-btn atl-btn--ghost um-btn--sm testimonial-edit-btn" data-id="${item.id}" title="Edit" aria-label="Edit ${safeName}"><i class="fa-solid fa-pen"></i></button>
                                <button type="button" class="um-btn um-btn--danger um-btn--sm testimonial-delete-btn" data-id="${item.id}" title="Delete" aria-label="Delete ${safeName}"><i class="fa-solid fa-trash"></i></button>
                            </div>
                        </div>
                    </div>
                </article>`;
            $list.append(html);
        });
    } catch (err) {
        console.error('Failed to load testimonials:', err);
        $list.html('<div class="um-empty-state" style="grid-column:1/-1; padding:30px 20px;"><i class="fa-solid fa-triangle-exclamation" style="font-size:22px;color:var(--atl-clay);display:block;margin-bottom:8px;"></i>Could not load testimonials.</div>');
    }
}
window.loadTestimonials = loadTestimonials;

$(document).on('change', '#testimonialsStatusFilter', function () { loadTestimonials(); });

$(document).on('click', '#testimonialsAddNewBtn', function () {
    resetTestimonialsForm();
    openAtlDrawer('testimonialsDrawer');
});
$(document).on('click', '#testimonialsDrawerClose, #testimonialsDrawerBackdrop, #testimonialsCancelBtn', function () {
    if (window.closeAtlDrawer) closeAtlDrawer('testimonialsDrawer');
});
$(document).on('click', '.testimonial-edit-btn', async function () {
    var id = $(this).data('id');
    try {
        const rows = await apiCall('/api/admin/testimonials');
        const item = (Array.isArray(rows) ? rows : []).find(r => r.id === id);
        if (item) openTestimonialEditor(item);
    } catch (err) {
        console.error('Failed to load testimonial for edit:', err);
    }
});
$(document).on('click', '.testimonial-delete-btn', async function () {
    var id = $(this).data('id');
    if (!(await window.notificationService.showConfirm({ title: 'Delete Testimonial', message: 'Permanently remove this testimonial? This cannot be undone.', isDestructive: true }))) return;
    try {
        await apiCall('/api/admin/testimonials/' + id, 'DELETE');
        window.notificationService.showSuccess('Testimonial removed.');
        loadTestimonials();
    } catch (err) {
        console.error('Delete testimonial failed:', err);
        window.notificationService.showError('Could not delete this testimonial.');
    }
});
$(document).on('click', '.testimonial-approve-btn', async function () {
    var id = $(this).data('id');
    try {
        await apiCall('/api/admin/testimonials/' + id, 'PUT', { status: 'approved' });
        window.notificationService.showSuccess('Testimonial approved — now live on the public site.');
        loadTestimonials();
    } catch (err) {
        console.error('Approve testimonial failed:', err);
        window.notificationService.showError('Could not approve this testimonial.');
    }
});
$(document).on('click', '.testimonial-reject-btn', async function () {
    var id = $(this).data('id');
    try {
        await apiCall('/api/admin/testimonials/' + id, 'PUT', { status: 'rejected' });
        window.notificationService.showSuccess('Testimonial rejected.');
        loadTestimonials();
    } catch (err) {
        console.error('Reject testimonial failed:', err);
        window.notificationService.showError('Could not reject this testimonial.');
    }
});
$(document).on('click', '.testimonial-retract-btn', async function () {
    var id = $(this).data('id');
    try {
        await apiCall('/api/admin/testimonials/' + id, 'PUT', { status: 'pending' });
        window.notificationService.showSuccess('Moved back to Pending Review — no longer visible on the public site.');
        loadTestimonials();
    } catch (err) {
        console.error('Retract testimonial failed:', err);
        window.notificationService.showError('Could not update this testimonial.');
    }
});

$(document).on('click', '#btnTestimonialClearImage', function () {
    testimonialImageCleared = true;
    $('#testimonialFile').val('');
    $('#testimonialPhotoPreview').hide();
    $('#testimonialPhotoPreviewImg').attr('src', '');
    var text = document.getElementById('testimonialUploadText');
    if (text) text.textContent = 'Select or drop a photo';
});

$(document).on('change', '#testimonialFile', function () {
    var file = this.files[0];
    var text = document.getElementById('testimonialUploadText');
    if (text) text.textContent = file ? file.name : 'Select or drop a photo';
    if (file) {
        testimonialImageCleared = false;
        var reader = new FileReader();
        reader.onload = function (ev) {
            $('#testimonialPhotoPreviewImg').attr('src', ev.target.result);
            $('#testimonialPhotoPreview').show();
        };
        reader.readAsDataURL(file);
    }
});

$(function () {
    const zone = document.getElementById('testimonialUploadZone');
    if (!zone) return;
    ['dragenter', 'dragover'].forEach(function (ev) {
        zone.addEventListener(ev, function (e) {
            e.preventDefault(); e.stopPropagation();
            zone.classList.add('um-upload-zone--dragging');
            if (ev === 'dragenter') {
                var t = document.getElementById('testimonialUploadText');
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
            const input = document.getElementById('testimonialFile');
            try { input.files = dropped; } catch (err) { /* some browsers disallow direct assignment */ }
            $('#testimonialFile').trigger('change');
        }
    });
});

$(document).on('submit', '#testimonialsForm', async function (e) {
    e.preventDefault();
    var name = $('#testimonialName').val().trim();
    var designation = $('#testimonialDesignation').val().trim();
    var quote = $('#testimonialQuote').val().trim();
    var file = $('#testimonialFile')[0].files[0];
    var isEdit = editingTestimonialId !== null;

    if (!name || !quote) {
        $('#err-testimonialsForm').text('Name and testimonial text are required.').show();
        return;
    }
    $('#err-testimonialsForm').hide();

    var $btn = $('#testimonialsSubmitBtn');
    $btn.prop('disabled', true).html('<i class="fa-solid fa-spinner fa-spin"></i> Saving...');

    try {
        if (isEdit) {
            var jsonBody = { name: name, designation: designation, quote: quote };
            if (testimonialImageCleared) {
                jsonBody.clear_image = true;
            } else if (file) {
                const uploaded = await uploadFileToServer(file, 'testimonials');
                if (uploaded) jsonBody.fallback_url = uploaded;
            }
            await apiCall('/api/admin/testimonials/' + editingTestimonialId, 'PUT', jsonBody);
        } else {
            var formData = new FormData();
            formData.append('name', name);
            formData.append('designation', designation);
            formData.append('quote', quote);
            formData.append('section', 'testimonials');
            if (file) formData.append('file', file);
            const res = await fetch('/api/admin/testimonials', { method: 'POST', body: formData });
            if (!res.ok) throw new Error('Server error saving testimonial');
        }

        closeAtlDrawer('testimonialsDrawer');
        resetTestimonialsForm();
        await loadTestimonials();
        window.notificationService.showSuccess(isEdit ? 'Testimonial updated.' : 'Testimonial added.');
    } catch (err) {
        console.error('Testimonial save error', err);
        window.notificationService.showError('An error occurred while saving.');
        $btn.prop('disabled', false).html(isEdit ? '<i class="fa-solid fa-floppy-disk"></i> Update Testimonial' : '<i class="fa-solid fa-plus-circle"></i> Add Testimonial');
    }
});
