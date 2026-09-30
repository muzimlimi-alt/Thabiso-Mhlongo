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
<<<<<<< Updated upstream
    // Grab the parent first: clearing it detaches the <img>, after which imgEl.parentElement is null.
    var parent = imgEl.parentElement;
    if (parent) {
        parent.innerHTML = '';
        parent.appendChild(div);
    }
};

// The Website Sections switch (Settings) hides the whole Team section on the public site, whatever
// its members' own status — say so here, or a fully populated list would sit next to an empty page.
function renderTeamSectionNotice() {
    var $n = $('#teamSectionNotice');
    if (window.teamSectionVisible === false) {
        $n.html('<i class="fa-solid fa-triangle-exclamation" aria-hidden="true"></i><span>The <strong>Team</strong> section is switched off in <strong>Settings &rarr; Website Sections</strong>, so nothing below is shown on the public site until it is switched back on.</span>').prop('hidden', false);
    } else {
        $n.prop('hidden', true).empty();
    }
}

=======
    if (imgEl.parentElement) {
        imgEl.parentElement.innerHTML = '';
        imgEl.parentElement.appendChild(div);
    }
};

>>>>>>> Stashed changes
async function loadTeam() {
    var $list = $('#adminTeamList');
    try {
        const data = await apiCall('/api/admin/team');
<<<<<<< Updated upstream
        // /api/admin/team is built by lib/team.js — the module the public API also uses — so the
        // order here IS the website's order, and is_public / public_position say exactly what the
        // website does with each member. Nothing below re-derives visibility or position.
        var members = Array.isArray(data) ? data : ((data && data.members) || []);
        window.teamSectionVisible = !(data && data.section_visible === false);
        if (data && Array.isArray(data.public_fields)) window.teamPublicFields = data.public_fields;
        renderTeamSectionNotice();

        if (members.length === 0) {
=======

        if (!Array.isArray(data) || data.length === 0) {
>>>>>>> Stashed changes
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

<<<<<<< Updated upstream
        members.forEach(function (item) {
            var safeName = $('<span>').text(item.name || '').html();
            var safeRole = $('<span>').text(item.role || '').html();
            var isPublic = item.is_public !== undefined ? !!item.is_public : item.status !== 'inactive';
            var updated = item.updated_at || item.created_at;
            var updatedStr = updated ? new Date(updated).toLocaleDateString('en-ZA', { year: 'numeric', month: 'short', day: 'numeric' }) : '';
            var encoded = encodeURIComponent(JSON.stringify(item));
            var initial = window.TeamView ? TeamView.initialOf(item) : ((item.name || '?').trim().charAt(0).toUpperCase() || '?');
=======
        data.forEach(function (item) {
            var safeName = $('<span>').text(item.name || '').html();
            var safeRole = $('<span>').text(item.role || '').html();
            var isActive = item.status !== 'inactive';
            var updated = item.updated_at || item.created_at;
            var updatedStr = updated ? new Date(updated).toLocaleDateString('en-ZA', { year: 'numeric', month: 'short', day: 'numeric' }) : '';
            var encoded = encodeURIComponent(JSON.stringify(item));
            var initial = (item.name || '?').trim().charAt(0).toUpperCase();
>>>>>>> Stashed changes
            var thumb = item.image_path
                ? `<img src="${item.image_path}" alt="${safeName}" onerror="window.tmThumbFallback(this)">`
                : `<div style="width:100%; height:100%; display:flex; align-items:center; justify-content:center; background:var(--atl-amber); color:var(--atl-bg, #0a0a0a); font-family:var(--atl-font-display, serif); font-size:22px; font-weight:600;">${initial}</div>`;

<<<<<<< Updated upstream
            var statusBadge;
            if (!isPublic) {
                statusBadge = '<span class="atl-badge atl-badge--unpaid" title="Inactive members are not shown on the website">Hidden &middot; Inactive</span>';
            } else if (window.teamSectionVisible === false) {
                statusBadge = '<span class="atl-badge atl-badge--info" title="Active, but the whole Team section is switched off in Settings">Active &middot; section off</span>';
            } else {
                statusBadge = '<span class="atl-badge atl-badge--confirmed" title="Shown on the website">Live on site</span>';
            }
=======
            var statusBadge = isActive
                ? '<span class="atl-badge atl-badge--confirmed">Active</span>'
                : '<span class="atl-badge atl-badge--unpaid">Inactive</span>';
>>>>>>> Stashed changes
            var featuredBadge = (item.featured == 1)
                ? '<span class="atl-badge atl-badge--info"><i class="fa-solid fa-star"></i> Featured</span>'
                : '';

            var metaText = [];
            if (safeRole) metaText.push(safeRole);
<<<<<<< Updated upstream
            metaText.push(isPublic && item.public_position ? 'Site position ' + item.public_position : 'Not on site');
=======
            metaText.push('Order ' + (item.display_order != null ? item.display_order : 0));
>>>>>>> Stashed changes
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
<<<<<<< Updated upstream
            else await loadTeam(); // re-read from the server so every card's "site position" is the real one
=======
>>>>>>> Stashed changes
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

<<<<<<< Updated upstream
// ── Live "Public preview" ──
// Built from the form, filtered to the fields the SERVER publishes (window.teamPublicFields, from
// lib/team.js via GET /api/admin/team — so email/phone are dropped here exactly as they are there),
// then rendered by js/team-view.js: the same code the public page uses.
var TEAM_PUBLIC_FIELDS_FALLBACK = ['id', 'name', 'role', 'biography', 'image_path', 'website', 'twitter', 'linkedin', 'instagram', 'behance', 'featured'];

function teamFormPublicMember() {
    var hasImg = !teamImageCleared && $('#teamPreview').css('display') !== 'none' && $('#teamPreviewImg').attr('src');
    var raw = {
        id: teamEditId || 0,
        name: $('#teamName').val().trim() || 'Full name',
        role: $('#teamRole').val().trim(),
        biography: $('#teamBio').val().trim(),
        image_path: hasImg ? $('#teamPreviewImg').attr('src') : null,
        website: $('#teamWebsite').val().trim(),
        twitter: $('#teamTwitter').val().trim(),
        linkedin: $('#teamLinkedin').val().trim(),
        instagram: $('#teamInstagram').val().trim(),
        behance: $('#teamBehance').val().trim(),
        featured: $('#teamFeaturedSwitch').attr('aria-checked') === 'true' ? 1 : 0,
        // Present in the form, but not in the published field list — dropped below like the server does.
        email: $('#teamEmail').val().trim(),
        phone: $('#teamPhone').val().trim()
    };
    var fields = (window.teamPublicFields && window.teamPublicFields.length) ? window.teamPublicFields : TEAM_PUBLIC_FIELDS_FALLBACK;
    var out = {};
    fields.forEach(function (k) { out[k] = raw[k] === undefined ? null : raw[k]; });
    return out;
}

function refreshTeamPreview() {
    if (!window.TeamView || !$('#teamPreviewList').length) return;
    TeamView.render([teamFormPublicMember()], $('#teamPreviewPhotos'), $('#teamPreviewList'), { active: true });
    var active = $('#teamActiveSwitch').attr('aria-checked') === 'true';
    var sectionOn = window.teamSectionVisible !== false;
    var text, cls;
    if (!sectionOn) { text = 'Hidden — the Team section is switched off in Settings'; cls = 'is-hidden'; }
    else if (!active) { text = 'Hidden — Inactive members are not shown'; cls = 'is-hidden'; }
    else { text = teamEditId === null ? 'Will appear at the end of the list' : 'Shown on the website'; cls = 'is-live'; }
    $('#teamPreviewState').text(text).removeClass('is-live is-hidden').addClass(cls);
    $('#teamPublicPreview .team-preview__stage').toggleClass('is-hidden', cls === 'is-hidden');
}
window.refreshTeamPreview = refreshTeamPreview;
$(document).on('input change', '#teamForm :input', refreshTeamPreview);

=======
>>>>>>> Stashed changes
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
<<<<<<< Updated upstream
    refreshTeamPreview();
=======
>>>>>>> Stashed changes
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
<<<<<<< Updated upstream
    // Server-derived (lib/team.js) — never re-derive "is this member public?" from the raw status here.
    var editorActive = item.is_public !== undefined ? !!item.is_public : item.status !== 'inactive';
    $('#teamActiveSwitch').attr('aria-checked', editorActive ? 'true' : 'false');
=======
    $('#teamActiveSwitch').attr('aria-checked', item.status !== 'inactive' ? 'true' : 'false');
>>>>>>> Stashed changes
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
<<<<<<< Updated upstream
    refreshTeamPreview();
=======
>>>>>>> Stashed changes
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
<<<<<<< Updated upstream
    refreshTeamPreview();
=======
>>>>>>> Stashed changes
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
<<<<<<< Updated upstream
            refreshTeamPreview();
=======
>>>>>>> Stashed changes
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
<<<<<<< Updated upstream
    refreshTeamPreview();
=======
>>>>>>> Stashed changes
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
