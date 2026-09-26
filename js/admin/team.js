// Management Team admin controller — mirrors js/admin/gallery.js structurally (list render, drag
// reorder, create/edit drawer, delete), borrowing the monogram-avatar fallback from
// js/admin/testimonials.js and the is_active-switch pattern from Website Sections
// (js/admin/system-settings.js's .sec-toggle). window.atlActivateDrawerTab and uploadFileToServer
// are shared globals defined elsewhere in admin.html (same ones Gallery/Testimonials/etc. use).

// Referenced from an inline onerror="" attribute, so it must hang off window.
window.tmThumbFallback = function (imgEl) {
    var initial = (imgEl.alt || '?').trim().charAt(0).toUpperCase() || '?';
    var div = document.createElement('div');
    div.style.cssText = 'width:100%; height:100%; display:flex; align-items:center; justify-content:center; background:var(--atl-amber); color:var(--atl-bg, #0a0a0a); font-family:var(--atl-font-display, serif); font-size:22px; font-weight:600;';
    div.textContent = initial;
    if (imgEl.parentElement) {
        imgEl.parentElement.innerHTML = '';
        imgEl.parentElement.appendChild(div);
    }
};

async function loadTeam() {
    var $list = $('#adminTeamList');
    try {
        const data = await apiCall('/api/admin/team');

        if (!Array.isArray(data) || data.length === 0) {
            $list.html(`
                <div class="atl-empty-state">
                    <i class="fa-solid fa-user-tie" style="font-size:32px; color:var(--atl-muted-dim); margin-bottom:14px; display:block;"></i>
                    <p style="color:var(--atl-muted); margin:0 0 14px; font-size:13px;">No management team members have been added yet.</p>
                    <button type="button" class="atl-btn atl-btn--primary um-btn--sm" onclick="window.openTeamCreateDrawer()">
                        <i class="fa-solid fa-plus"></i> Add Team Member
                    </button>
                </div>
            `);
            return;
        }

        $list.empty();

        data.forEach(function (item) {
            var safeName = $('<span>').text(item.name || '').html();
            var safeRole = $('<span>').text(item.role || '').html();
            var isActive = item.status !== 'inactive';
            var updated = item.updated_at || item.created_at;
            var updatedStr = updated ? new Date(updated).toLocaleDateString('en-ZA', { year: 'numeric', month: 'short', day: 'numeric' }) : '';
            var encoded = encodeURIComponent(JSON.stringify(item));
            var initial = (item.name || '?').trim().charAt(0).toUpperCase();
            var thumb = item.image_path
                ? `<img src="${item.image_path}" alt="${safeName}" onerror="window.tmThumbFallback(this)">`
                : `<div style="width:100%; height:100%; display:flex; align-items:center; justify-content:center; background:var(--atl-amber); color:var(--atl-bg, #0a0a0a); font-family:var(--atl-font-display, serif); font-size:22px; font-weight:600;">${initial}</div>`;

            var statusBadge = isActive
                ? '<span class="atl-badge atl-badge--confirmed">Active</span>'
                : '<span class="atl-badge atl-badge--unpaid">Inactive</span>';
            var featuredBadge = (item.featured == 1)
                ? '<span class="atl-badge atl-badge--info"><i class="fa-solid fa-star"></i> Featured</span>'
                : '';

            var metaText = [];
            if (safeRole) metaText.push(safeRole);
            metaText.push('Order ' + (item.display_order != null ? item.display_order : 0));
            if (updatedStr) metaText.push('Updated ' + updatedStr);
            var subtitle = metaText.length > 0 ? metaText.join(' &middot; ') : 'Team member';

            var html = `
            <article class="atl-edit-card" data-id="${item.id}" data-payload="${encoded}">
              <div class="atl-card-inner">
                <div class="atl-edit-card__header">
                  <span class="atl-drag-handle" draggable="true" title="Drag to reorder" aria-label="Drag to reorder"><i class="fa-solid fa-grip-vertical"></i></span>
                  <div class="atl-edit-card__thumb">${thumb}</div>
                  <div style="flex:1; min-width:0;">
                    <h3 class="atl-edit-card__title">${safeName}</h3>
                    <p class="atl-edit-card__subtitle">${subtitle}</p>
                    <div class="atl-edit-card__desc">${statusBadge} ${featuredBadge}</div>
                  </div>
                  <div style="display:flex; flex-direction:column; align-items:flex-end; gap:6px; flex-shrink:0;">
                    <button type="button" class="atl-btn atl-btn--ghost um-btn--sm" onclick="window.openTeamEditDrawer(${item.id})" title="Edit team member" aria-label="Edit ${safeName}">
                      <i class="fa-solid fa-pen"></i>
                    </button>
                    <button type="button" class="um-btn um-btn--danger um-btn--sm team-delete-btn" data-id="${item.id}" title="Delete team member" aria-label="Delete ${safeName}">
                      <i class="fa-solid fa-trash-can"></i>
                    </button>
                  </div>
                </div>
              </div>
            </article>`;
            $list.append(html);
        });

        initDraggableTeam();
    } catch (err) {
        console.error('Failed to load team members:', err);
        $list.html(`
            <div class="atl-empty-state">
                <i class="fa-solid fa-triangle-exclamation" style="font-size:28px; color:var(--atl-clay); margin-bottom:14px; display:block;"></i>
                <p style="color:var(--atl-muted); margin:0; font-size:13px;">Could not load the team. Please refresh and try again.</p>
            </div>
        `);
    }
}
window.loadTeam = loadTeam;

// Drag/Drop reorder — mirrors initDraggableGallery() in js/admin/gallery.js.
function initDraggableTeam() {
    const list = document.getElementById('adminTeamList');
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

        const newOrder = Array.from(list.querySelectorAll('.atl-edit-card')).map(el => el.dataset.id);
        try {
            const res = await fetch('/api/admin/team/reorder', {
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

// ── TEAM MEMBER EDITOR CONTROLLER — #teamForm lives permanently in the teamDrawer ──
var teamEditId = null;
var teamImageCleared = false;

function resetTeamForm() {
    $('#teamForm')[0].reset();
    $('#teamFile').val('');
    $('#teamPreview').hide();
    $('#teamPreviewImg').attr('src', '');
    teamImageCleared = false;
    var text = document.getElementById('teamUploadText');
    if (text) text.textContent = 'Drag & drop or select a photo';
    $('#teamActiveSwitch').attr('aria-checked', 'true');
    $('#teamFeaturedSwitch').attr('aria-checked', 'false');
    teamEditId = null;
    $('#team-tab-history').hide();
    window.atlActivateDrawerTab('teamDrawer', 'team-tab-edit');
    $('#teamDrawerTitle').html('<i class="fa-solid fa-user-tie"></i> Add Team Member');
    $('#teamSubmitBtn').html('<i class="fa-solid fa-plus-circle"></i> Add Team Member').prop('disabled', false);
}
window.resetTeamForm = resetTeamForm;

function applyTeamToEditor(item) {
    teamEditId = item.id;
    $('#teamName').val(item.name || '');
    $('#teamRole').val(item.role || '');
    $('#teamBio').val(item.biography || '');
    $('#teamEmail').val(item.email || '');
    $('#teamPhone').val(item.phone || '');
    $('#teamWebsite').val(item.website || '');
    $('#teamTwitter').val(item.twitter || '');
    $('#teamLinkedin').val(item.linkedin || '');
    $('#teamInstagram').val(item.instagram || '');
    $('#teamBehance').val(item.behance || '');
    $('#teamDisplayOrder').val(item.display_order || 0);
    $('#teamActiveSwitch').attr('aria-checked', item.status !== 'inactive' ? 'true' : 'false');
    $('#teamFeaturedSwitch').attr('aria-checked', item.featured == 1 ? 'true' : 'false');
    $('#teamFile').val('');
    teamImageCleared = false;
    var text = document.getElementById('teamUploadText');
    if (text) text.textContent = 'Upload a new photo to replace';
    if (item.image_path) { $('#teamPreviewImg').attr('src', item.image_path); $('#teamPreview').show(); }
    else { $('#teamPreview').hide(); $('#teamPreviewImg').attr('src', ''); }
    $('#teamDrawerTitle').html('<i class="fa-solid fa-user-tie"></i> Edit Team Member');
    $('#teamSubmitBtn').html('<i class="fa-solid fa-floppy-disk"></i> Update Team Member').prop('disabled', false);
    $('#team-tab-history').show();
    if (window.loadChangeHistoryCard) window.loadChangeHistoryCard('teamChangeHistoryList', 'team_members', item.id);
}
window.openTeamCreateDrawer = function () {
    resetTeamForm();
    openAtlDrawer('teamDrawer');
    $('#teamName').focus();
};
window.openTeamEditDrawer = function (id) {
    var p = $('#adminTeamList .atl-edit-card[data-id="' + id + '"]').attr('data-payload');
    if (!p) return;
    resetTeamForm();
    applyTeamToEditor(JSON.parse(decodeURIComponent(p)));
    openAtlDrawer('teamDrawer');
};
window.teamCancelEdit = function () {
    resetTeamForm();
    closeAtlDrawer('teamDrawer');
};
$('#teamAddNewBtn').on('click', function () { window.openTeamCreateDrawer(); });
$(document).on('click', '#teamDrawerClose, #teamDrawerBackdrop, #teamCancelBtn', function () { window.teamCancelEdit(); });

// Active / Featured toggle switches (same click-to-flip-aria-checked pattern as the Website
// Sections .sec-toggle switches in js/admin/system-settings.js).
$(document).on('click', '#teamActiveSwitch, #teamFeaturedSwitch', function () {
    $(this).attr('aria-checked', $(this).attr('aria-checked') === 'true' ? 'false' : 'true');
});

$(document).on('change', '#teamFile', function () {
    var file = this.files[0];
    var text = document.getElementById('teamUploadText');
    if (text) text.textContent = file ? file.name : (teamEditId !== null ? 'Upload a new photo to replace' : 'Drag & drop or select a photo');
    if (file) {
        teamImageCleared = false;
        var reader = new FileReader();
        reader.onload = function (ev) {
            $('#teamPreviewImg').attr('src', ev.target.result);
            $('#teamPreview').show();
        };
        reader.readAsDataURL(file);
    }
});

$(document).on('click', '#btnTeamClearImage', function () {
    teamImageCleared = true;
    $('#teamFile').val('');
    $('#teamPreview').hide();
    $('#teamPreviewImg').attr('src', '');
    var text = document.getElementById('teamUploadText');
    if (text) text.textContent = 'Drag & drop or select a photo';
});

// Add / Edit submit (delegated — #teamForm lives in the drawer)
$(document).on('submit', '#teamForm', async function (e) {
    e.preventDefault();
    var name = $('#teamName').val().trim();
    if (!name) {
        window.notificationService.showError('Name is required.');
        return;
    }
    var isEdit = teamEditId !== null;
    var $btn = $('#teamSubmitBtn');
    $btn.prop('disabled', true).html('<i class="fa-solid fa-spinner fa-spin"></i> Saving...');

    var fields = {
        name: name,
        role: $('#teamRole').val().trim(),
        biography: $('#teamBio').val().trim(),
        email: $('#teamEmail').val().trim(),
        phone: $('#teamPhone').val().trim(),
        website: $('#teamWebsite').val().trim(),
        twitter: $('#teamTwitter').val().trim(),
        linkedin: $('#teamLinkedin').val().trim(),
        instagram: $('#teamInstagram').val().trim(),
        behance: $('#teamBehance').val().trim(),
        status: $('#teamActiveSwitch').attr('aria-checked') === 'true' ? 'active' : 'inactive',
        featured: $('#teamFeaturedSwitch').attr('aria-checked') === 'true'
    };

    try {
        var file = $('#teamFile')[0].files[0];
        if (isEdit) {
            var body = Object.assign({}, fields, { display_order: parseInt($('#teamDisplayOrder').val(), 10) || 0 });
            if (teamImageCleared) {
                body.clear_image = true;
            } else if (file) {
                var uploaded = await uploadFileToServer(file, 'team');
                if (uploaded) body.fallback_url = uploaded;
            }
            await apiCall('/api/admin/team/' + teamEditId, 'PUT', body);
            window.notificationService.showSuccess('Team member updated.');
        } else {
            var fd = new FormData();
            fd.append('section', 'team');
            Object.keys(fields).forEach(function (k) { fd.append(k, fields[k]); });
            if (file) fd.append('file', file);
            var r = await fetch('/api/admin/team', { method: 'POST', credentials: 'include', body: fd });
            if (!r.ok) throw new Error('Save failed');
            window.notificationService.showSuccess('Team member added.');
        }
        closeAtlDrawer('teamDrawer');
        resetTeamForm();
        await loadTeam();
    } catch (err) {
        console.error('Team member save error', err);
        window.notificationService.showError('An error occurred while saving.');
        $btn.prop('disabled', false).html(isEdit ? '<i class="fa-solid fa-floppy-disk"></i> Update Team Member' : '<i class="fa-solid fa-plus-circle"></i> Add Team Member');
    }
});

// Delete a team member (server-side already enforces administrator-only via requireRole; the
// .team-delete-btn class is also hidden for Manager/Assistant in css/admin/19-role-gating.css).
$(document).on('click', '.team-delete-btn', async function (e) {
    e.preventDefault(); e.stopPropagation();
    var id = $(this).data('id');
    if (await window.notificationService.showConfirm({ title: 'Delete Team Member', message: 'Permanently remove this team member? This cannot be undone.', isDestructive: true })) {
        try {
            await apiCall('/api/admin/team/' + id, 'DELETE');
            window.notificationService.showSuccess('Team member removed.');
            loadTeam();
        } catch (err) {
            console.error('Delete team member failed:', err);
            window.notificationService.showError('Could not delete this team member.');
        }
    }
});
