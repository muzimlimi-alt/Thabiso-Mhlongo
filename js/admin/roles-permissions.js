/* Roles & Permissions admin section — js/admin/roles-permissions.js
   Drives the #rolesAdmin section: role cards, permission matrix, perm-edit drawer,
   role create/edit drawer, and the RBAC audit log tab. */
(function () {
    'use strict';

    var $ = window.jQuery;
    var esc = typeof window.escHtml === 'function' ? window.escHtml : function (s) {
        return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    };

    var _rolesCache = null;
    var _matrixCache = null;

    function api(method, path, body) {
        var opts = { method: method, credentials: 'include', headers: { 'Content-Type': 'application/json', 'ngrok-skip-browser-warning': 'true' } };
        if (body) opts.body = JSON.stringify(body);
        return fetch(path, opts).then(function (r) { return r.json(); });
    }

    /* ================================================================
       PANEL 1 — Role Cards
    ================================================================ */
    function loadRoles() {
        api('GET', '/api/admin/roles').then(function (d) {
            if (!d.success) return;
            _rolesCache = d.roles;
            renderRoleCards(d.roles);
        });
    }

    function renderRoleCards(roles) {
        var grid = document.getElementById('rbacRolesGrid');
        if (!grid) return;
        if (!roles.length) { grid.innerHTML = '<p class="ntf-empty">No roles found.</p>'; return; }
        grid.innerHTML = roles.map(function (r) {
            var badge = r.is_system ? 'system' : (r.status === 'active' ? 'custom' : 'inactive');
            var badgeLabel = r.is_system ? 'System' : (r.status === 'active' ? 'Custom' : 'Inactive');
            var html = '<div class="rbac-role-card" data-role-id="' + r.id + '">';
            html += '<div class="rbac-role-card__head">';
            html += '<h4 class="rbac-role-card__name">' + esc(r.name) + '</h4>';
            html += '<span class="rbac-role-card__badge rbac-role-card__badge--' + badge + '">' + badgeLabel + '</span>';
            html += '</div>';
            if (r.description) html += '<p class="rbac-role-card__desc">' + esc(r.description) + '</p>';
            html += '<div class="rbac-role-card__stats">';
            html += '<span><i class="fa-solid fa-users"></i> ' + (r.active_user_count || 0) + ' users</span>';
            html += '<span><i class="fa-solid fa-key"></i> ' + (r.permission_count || 0) + ' permissions</span>';
            html += '</div>';
            html += '<div class="rbac-role-card__actions">';
            html += '<button class="atl-btn atl-btn--ghost atl-btn--sm rbac-edit-perms" data-role-id="' + r.id + '"><i class="fa-solid fa-sliders"></i> Permissions</button>';
            if (!r.is_system) {
                html += '<button class="atl-btn atl-btn--ghost atl-btn--sm rbac-edit-role" data-role-id="' + r.id + '"><i class="fa-solid fa-pen"></i> Edit</button>';
                html += '<button class="atl-btn atl-btn--ghost atl-btn--sm rbac-delete-role" data-role-id="' + r.id + '" data-role-name="' + esc(r.name) + '" style="color:var(--atl-clay);"><i class="fa-solid fa-trash"></i> Delete</button>';
            }
            html += '</div></div>';
            return html;
        }).join('');
    }

    /* ================================================================
       PANEL 2 — Permission Matrix (read-only overview)
    ================================================================ */
    function loadMatrix() {
        api('GET', '/api/admin/permissions').then(function (d) {
            if (!d.success) return;
            _matrixCache = d;
            renderMatrix(d);
        });
    }

    function renderMatrix(d) {
        var wrap = document.getElementById('rbacMatrixWrap');
        if (!wrap) return;
        var roles = d.roles || [];
        var perms = d.permissions || [];
        var modules = d.modules || [];

        // Build lookup: module key → sorted list of permission objects
        var byModule = {};
        perms.forEach(function (p) {
            if (!byModule[p.module]) byModule[p.module] = [];
            byModule[p.module].push(p);
        });

        // Build grant set per role: role.id → Set of permission keys
        var grantsByRole = {};
        roles.forEach(function (r) {
            grantsByRole[r.id] = new Set(r.grants || []);
        });

        var html = '<table class="rbac-matrix"><thead><tr><th>Permission</th>';
        roles.forEach(function (r) { html += '<th>' + esc(r.name) + '</th>'; });
        html += '</tr></thead><tbody>';

        modules.forEach(function (mod) {
            var modPerms = byModule[mod.key] || [];
            if (!modPerms.length) return;
            html += '<tr class="rbac-matrix__module"><td colspan="' + (roles.length + 1) + '">' + esc(mod.label || mod.key) + '</td></tr>';
            modPerms.forEach(function (p) {
                html += '<tr><td class="rbac-matrix__perm">' + esc(p.action) + '</td>';
                roles.forEach(function (r) {
                    if (grantsByRole[r.id] && grantsByRole[r.id].has(p.key)) {
                        html += '<td><i class="fa-solid fa-check rbac-matrix__check"></i></td>';
                    } else {
                        html += '<td><span class="rbac-matrix__blank">&mdash;</span></td>';
                    }
                });
                html += '</tr>';
            });
        });
        html += '</tbody></table>';
        wrap.innerHTML = html;
    }

    /* ================================================================
       PANEL 3 — RBAC Audit Log
    ================================================================ */
    function loadAuditLog() {
        api('GET', '/api/admin/audit_log?search=rbac_&limit=100').then(function (d) {
            var list = document.getElementById('rbacAuditList');
            if (!list) return;
            var rows = Array.isArray(d) ? d : (d.logs || d.rows || []);
            if (!rows.length) { list.innerHTML = '<p class="ntf-empty">No RBAC changes recorded yet.</p>'; return; }

            list.innerHTML = rows.map(function (r) {
                var changes = '';
                try { changes = typeof r.changes_json === 'string' ? r.changes_json : JSON.stringify(r.changes_json || ''); } catch (e) { changes = ''; }
                var ts = r.change_timestamp || r.created_at || '';
                var who = r.actor_username || r.actor_full_name || r.changed_by || 'system';
                return '<div class="rbac-audit-row">' +
                    '<div class="rbac-audit-row__icon"><i class="fa-solid fa-shield-halved"></i></div>' +
                    '<div class="rbac-audit-row__detail">' +
                    '<span class="rbac-audit-row__action">' + esc(r.action || '-') + '</span> on <strong>' + esc(r.table_name || '') + '</strong> #' + (r.record_id || '-') +
                    ' by ' + esc(who) +
                    (changes ? '<div style="font-size:11px; color:var(--atl-muted); margin-top:2px; word-break:break-all;">' + esc(changes.substring(0, 200)) + '</div>' : '') +
                    '</div>' +
                    '<span class="rbac-audit-row__time">' + esc(ts) + '</span>' +
                    '</div>';
            }).join('');
        });
    }

    /* ================================================================
       DRAWER — Create / Edit Role
    ================================================================ */
    function nameToKey(name) {
        return name.toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_-]/g, '');
    }

    function openRoleDrawer(roleId) {
        var $form = $('#rbacRoleForm');
        $form[0].reset();
        $('#rbacRoleId').val('');
        $('#rbacRoleBase').closest('.dk-field').show();
        dkMessage('#rbacRoleMsg', '', '');

        // Wire auto-fill: name → key (create mode only; listener is re-set each open)
        $('#rbacRoleName').off('input.rbacKey').on('input.rbacKey', function () {
            $('#rbacRoleKey').val(nameToKey($(this).val()));
        });

        if (roleId) {
            $('#rbacRoleDrawerTitle').text('Edit Role');
            $('#rbacRoleName').off('input.rbacKey'); // no auto-fill in edit mode
            var role = (_rolesCache || []).find(function (r) { return r.id === roleId; });
            if (role) {
                $('#rbacRoleId').val(role.id);
                $('#rbacRoleName').val(role.name);
                $('#rbacRoleKey').val(role.key);
                $('#rbacRoleDesc').val(role.description || '');
                $('#rbacRoleBase').val(role.base_role || 'manager').closest('.dk-field').hide();
            }
        } else {
            $('#rbacRoleDrawerTitle').text('New Role');
            $('#rbacRoleKey').val(''); // start blank; fills as user types
        }
        openAtlDrawer('rbacRoleDrawer');
    }

    function saveRole() {
        var id = $('#rbacRoleId').val();
        var payload = {
            name: $('#rbacRoleName').val().trim(),
            key: $('#rbacRoleKey').val().trim(),
            description: $('#rbacRoleDesc').val().trim(),
            base_role: $('#rbacRoleBase').val()
        };
        if (!payload.name) { dkMessage('#rbacRoleMsg', 'bad', 'Name is required.'); return; }
        if (!payload.key) { dkMessage('#rbacRoleMsg', 'bad', 'Key is required.'); return; }

        var method = id ? 'PUT' : 'POST';
        var url = id ? '/api/admin/roles/' + id : '/api/admin/roles';
        api(method, url, payload).then(function (d) {
            if (d.success) {
                closeAtlDrawer('rbacRoleDrawer');
                loadRoles();
                loadMatrix();
            } else {
                dkMessage('#rbacRoleMsg', 'bad', d.error || d.message || 'Save failed.');
            }
        });
    }

    /* ================================================================
       DRAWER — Edit Permissions (per role)
    ================================================================ */
    var _permEditRoleId = null;
    var _permEditData = null;

    function openPermDrawer(roleId) {
        _permEditRoleId = roleId;
        $('#rbacPermGrid').html('<p class="ntf-empty">Loading…</p>');
        dkMessage('#rbacPermMsg', '', '');

        api('GET', '/api/admin/roles/' + roleId).then(function (d) {
            if (!d.success) return;
            _permEditData = d;
            $('#rbacPermDrawerTitle').text('Permissions: ' + (d.role.name || d.role.key));
            renderPermEditor(d);
            openAtlDrawer('rbacPermDrawer');
        });
    }

    function renderPermEditor(d) {
        var container = document.getElementById('rbacPermGrid');
        if (!container) return;
        var grantedKeys = {};
        (d.permissions || []).forEach(function (p) { grantedKeys[p.key] = true; });
        var isProtected = d.role && d.role.is_protected;

        api('GET', '/api/admin/permissions').then(function (mx) {
            if (!mx.success) return;
            // mx.modules: [{ key, label, actions }]; mx.permissions: flat [{key, module, action, label, is_sensitive}]
            var allPerms = mx.permissions || [];
            var html = '';
            (mx.modules || []).forEach(function (mod) {
                var modPerms = allPerms.filter(function (p) { return p.module === mod.key; });
                if (!modPerms.length) return;
                var checkedCount = modPerms.filter(function (p) { return grantedKeys[p.key]; }).length;
                var allSelected = checkedCount === modPerms.length;
                var someSelected = checkedCount > 0 && !allSelected;
                html += '<div class="rbac-perm-module">';
                html += '<div class="rbac-perm-module__hd">';
                html += '<h5 class="rbac-perm-module__title">' + esc(mod.label || mod.key).replace(/-/g, ' ') + '</h5>';
                if (!isProtected) {
                    html += '<label class="rbac-perm-select-all-label">' +
                        '<input type="checkbox" class="rbac-perm-select-all"' +
                        (allSelected ? ' checked' : '') +
                        (someSelected ? ' data-indeterminate="true"' : '') +
                        '> <span>All</span></label>';
                }
                html += '</div>';
                modPerms.forEach(function (p) {
                    var checked = grantedKeys[p.key] ? ' checked' : '';
                    var disabled = isProtected ? ' disabled' : '';
                    html += '<div class="rbac-perm-row">';
                    html += '<label><input type="checkbox" data-perm-key="' + esc(p.key) + '"' + checked + disabled + '> ' + esc(p.label || p.action || p.key) + '</label>';
                    if (p.is_sensitive) html += '<span style="font-size:10px; color:var(--atl-orange); margin-left:auto;">SENSITIVE</span>';
                    html += '</div>';
                });
                html += '</div>';
            });
            container.innerHTML = html || '<p class="ntf-empty">No permissions found.</p>';
            // indeterminate must be set via JS, not HTML attribute
            container.querySelectorAll('.rbac-perm-select-all[data-indeterminate="true"]').forEach(function (cb) {
                cb.indeterminate = true;
            });
        }).catch(function (e) {
            console.error('[rbac] renderPermEditor fetch failed:', e);
            container.innerHTML = '<p class="ntf-empty" style="color:var(--atl-clay);">Failed to load permissions.</p>';
        });
    }

    function savePermissions() {
        if (!_permEditRoleId) return;
        var perms = [];
        $('#rbacPermGrid input[data-perm-key]:checked').each(function () {
            perms.push($(this).attr('data-perm-key'));
        });
        api('PUT', '/api/admin/roles/' + _permEditRoleId + '/permissions', { permissions: perms }).then(function (d) {
            if (d.success) {
                closeAtlDrawer('rbacPermDrawer');
                loadRoles();
                loadMatrix();
            } else {
                dkMessage('#rbacPermMsg', 'bad', d.error || d.message || 'Save failed.');
            }
        });
    }

    /* ================================================================
       EVENT BINDINGS
    ================================================================ */
    $(function () {
        $(document).on('click', '#rbacCreateRoleBtn', function () { openRoleDrawer(null); });
        $(document).on('click', '.rbac-edit-role', function () { openRoleDrawer(Number($(this).attr('data-role-id'))); });
        $(document).on('click', '.rbac-edit-perms', function () { openPermDrawer(Number($(this).attr('data-role-id'))); });
        $(document).on('click', '.rbac-delete-role', async function () {
            var roleId = Number($(this).attr('data-role-id'));
            var roleName = $(this).attr('data-role-name');
            var confirmed = await window.notificationService.showConfirm({
                message: 'Delete role “' + roleName + '”? This cannot be undone. Any users assigned this role must be reassigned first.',
                isDestructive: true
            });
            if (!confirmed) return;
            api('DELETE', '/api/admin/roles/' + roleId).then(function (d) {
                if (d.success) {
                    window.notificationService.showSuccess('Role “' + roleName + '” deleted.');
                    loadRoles();
                    loadMatrix();
                } else {
                    window.notificationService.showError(d.message || 'Could not delete role.');
                }
            }).catch(function () { window.notificationService.showError('Request failed. Please try again.'); });
        });
        $(document).on('click', '#rbacRoleSaveBtn', saveRole);
        $(document).on('click', '#rbacPermSaveBtn', savePermissions);
        $(document).on('click', '#rbacAuditRefresh', loadAuditLog);

        // Select-all toggle: check/uncheck every perm in the module
        $(document).on('change', '#rbacPermGrid .rbac-perm-select-all', function () {
            var $module = $(this).closest('.rbac-perm-module');
            var checked = this.checked;
            this.indeterminate = false;
            $module.find('input[data-perm-key]:not(:disabled)').prop('checked', checked);
        });

        // Individual perm change: sync the module's select-all state
        $(document).on('change', '#rbacPermGrid input[data-perm-key]', function () {
            var $module = $(this).closest('.rbac-perm-module');
            var $selectAll = $module.find('.rbac-perm-select-all');
            if (!$selectAll.length) return;
            var $perms = $module.find('input[data-perm-key]:not(:disabled)');
            var total = $perms.length;
            var checked = $perms.filter(':checked').length;
            if (checked === 0) {
                $selectAll.prop('checked', false).prop('indeterminate', false);
            } else if (checked === total) {
                $selectAll.prop('checked', true).prop('indeterminate', false);
            } else {
                $selectAll.prop('checked', false).prop('indeterminate', true);
            }
        });
    });

    /* ================================================================
       INIT — called lazily by switchTab when sectionId === 'rolesAdmin'
    ================================================================ */
    window.initRbacSection = function () {
        loadRoles();
        loadMatrix();
        loadAuditLog();
    };
})();
