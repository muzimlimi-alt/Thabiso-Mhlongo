/* Phase 6 (HOUSEKEEPING-NOTES.md): relocated from admin.html verbatim — the ENTIRE
   initUserManagement(...) closure (User Management tab: own CRUD — load/render/paginate/
   sort/delete/update users, bulk controls — plus its own separate "Login Activity Logs" panel,
   distinct from the sitewide Email Logs admin tab). Moved as one atomic unit, kept wrapped in
   its own original (function initUserManagement() {...})(); — unlike every other Phase 6
   section so far, nothing was left behind: the Email Logs code that used to sit in the middle
   of this closure was already extracted (see the Email Logs / Services+Policies fix entry)
   before this move, so what remains here is 100% User Management's own code. Verified before
   this move: the whole closure parses standalone, and there are zero external references
   anywhere else in admin.html to any of its internal (non-window-attached) names — every
   onclick in this section's own markup already explicitly calls window.toggleUserSort(...) /
   window.toggleLogSort(...), so no new window attachments were needed. */

(function initUserManagement() {
    'use strict';

    /* ---- Helpers ---- */
    function qs(sel, ctx) { return (ctx || document).querySelector(sel); }
    function qsa(sel, ctx) { return Array.from((ctx || document).querySelectorAll(sel)); }
    function esc(str) { return String(str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
    function initial(name) { return (name || '?').charAt(0).toUpperCase(); }
    function fmtDate(dt) {
        if (!dt) return '—';
        try { return new Date(dt).toLocaleDateString('en-ZA', { year:'numeric', month:'short', day:'numeric' }); } catch(e) { return dt; }
    }

    /* ---- Feedback helper ---- */
    function showFeedback(el, msg, type, autoClear) {
        if (!el) return;
        el.textContent = msg;
        el.className = 'um-feedback show ' + (type || 'info');
        if (autoClear !== false) {
            setTimeout(function() { el.className = 'um-feedback'; el.textContent = ''; }, 4500);
        }
    }

    /* ---- State ---- */
    var currentUserId = null;
    var allUsersCache = [];
    var moduleLoaded   = false;
    var birthdayModuleLoaded = false;
    var itiUmPhone     = null;  // intl-tel-input instance for the Add/Edit drawer phone field

    /* ================================================================
       TAB SWITCHING
    ================================================================ */
    function initTabs() {
        qsa('.atl-tab-btn').forEach(function(btn) {
            btn.addEventListener('click', function() {
                var target = this.dataset.umTab;
                var tabBar = this.closest('.atl-tab-bar');
                var container = tabBar ? tabBar.parentElement : null;
                // Deactivate buttons in the same tab bar only
                var siblingBtns = tabBar ? tabBar.querySelectorAll('.atl-tab-btn') : qsa('.atl-tab-btn');
                siblingBtns.forEach(function(b) { b.classList.remove('active'); b.setAttribute('aria-selected','false'); });
                // Deactivate panels in the same container only
                var siblingPanels = container ? container.querySelectorAll('.um-panel') : qsa('.um-panel');
                siblingPanels.forEach(function(p) { p.classList.remove('active'); });
                this.classList.add('active');
                this.setAttribute('aria-selected','true');
                var panel = qs('#' + target);
                if (panel) panel.classList.add('active');

                // Lazy-load users on first open
                if (target === 'umPanelUsers' && !moduleLoaded) {
                    loadAllUsers();
                    moduleLoaded = true;
                }
                // Lazy-load birthday automation settings on first open (not on every admin login)
                if (target === 'newsletterBirthdayPanel' && !birthdayModuleLoaded) {
                    if (typeof window.loadBirthdaySettings === 'function') window.loadBirthdaySettings();
                    birthdayModuleLoaded = true;
                }
            });
        });
    }

    /* ================================================================
       PANEL 1: MY PROFILE – load session + save
    ================================================================ */
    function initProfile() {
        // Load session info
        fetch('/api/admin/session', { credentials: 'include' })
            .then(function(r) { return r.json(); })
            .then(function(data) {
                if (!data || data.error) return;
                var id       = data.id || data.adminId;
                var username = data.username || '';
                var email    = data.email    || '';
                var fullName = data.full_name || '';
                var phone    = data.phone    || '';
                var role     = data.role     || '';
                var joined   = data.created_at || '';
                currentUserId = id;

                var emailEl      = qs('#umMyEmail');
                var fullNameEl   = qs('#umMyFullName');
                var phoneEl      = qs('#umMyPhone');
                var hiddenId     = qs('#umMyUserId');
                var displayName  = qs('#umMyDisplayName');
                var avatarHero   = qs('#umMyAvatarHero');
                var joinDateEl   = qs('#umMyJoinDate');
                var roleTextEl   = qs('#umMyRoleText');

                var shownName = fullName || email || username;
                if (emailEl) emailEl.value = email;
                if (fullNameEl) fullNameEl.value = fullName;
                if (phoneEl) phoneEl.value = phone;
                if (hiddenId) hiddenId.value = id;
                if (displayName) displayName.textContent = shownName;
                if (avatarHero) avatarHero.textContent = initial(shownName);
                if (joinDateEl) joinDateEl.textContent = joined ? 'Member since ' + fmtDate(joined) : 'Member since —';
                if (roleTextEl) roleTextEl.textContent = role ? (role.charAt(0).toUpperCase() + role.slice(1)) : '—';
            })
            .catch(function() { /* silent */ });

        // Profile form submit
        var profileForm  = qs('#umProfileForm');
        var profileFb    = qs('#umProfileFeedback');
        var resetBtn     = qs('#umProfileResetBtn');

        if (profileForm) {
            profileForm.addEventListener('submit', function(e) {
                e.preventDefault();
                var id       = qs('#umMyUserId').value;
                var email    = qs('#umMyEmail').value.trim().toLowerCase();
                var fullName = (qs('#umMyFullName') ? qs('#umMyFullName').value : '').trim();
                var phone    = (qs('#umMyPhone') ? qs('#umMyPhone').value : '').trim();

                if (!id || !email) {
                    showFeedback(profileFb, 'Email is required.', 'error');
                    return;
                }
                if (!fullName) { showFeedback(profileFb, 'Full name is required.', 'error'); return; }
                if (!phone) { showFeedback(profileFb, 'Phone number is required.', 'error'); return; }

                var saveBtn = qs('#umProfileSaveBtn');
                if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = 'Saving…'; }

                fetch('/api/admin/users/' + id, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    credentials: 'include',
                    body: JSON.stringify({ email: email, full_name: fullName, phone: phone })
                })
                .then(function(r) { return r.json(); })
                .then(function(data) {
                    if (saveBtn) { saveBtn.disabled = false; saveBtn.innerHTML = '<i class="fa-solid fa-floppy-disk"></i> Save Profile'; }
                    if (data.success) {
                        showFeedback(profileFb, '✓ Profile updated successfully.', 'success');
                        // Update hero display
                        var shownName = fullName || email;
                        var dn = qs('#umMyDisplayName');
                        var ah = qs('#umMyAvatarHero');
                        if (dn) dn.textContent = shownName;
                        if (ah) ah.textContent = initial(shownName);
                        // Refresh the header profile chip via the existing helper (exposed on window).
                        if (typeof window.updateProfileDisplay === 'function') window.updateProfileDisplay();
                        loadAllUsers();
                    } else {
                        showFeedback(profileFb, '✗ ' + (data.message || 'Update failed.'), 'error');
                    }
                })
                .catch(function() {
                    if (saveBtn) { saveBtn.disabled = false; saveBtn.innerHTML = '<i class="fa-solid fa-floppy-disk"></i> Save Profile'; }
                    showFeedback(profileFb, '✗ Network error. Please try again.', 'error');
                });
            });
        }

        if (resetBtn && profileForm) {
            resetBtn.addEventListener('click', function() {
                // Re-load from server
                fetch('/api/admin/session', { credentials: 'include' })
                    .then(function(r) { return r.json(); })
                    .then(function(data) {
                        if (!data || data.error) return;
                        var em = qs('#umMyEmail');
                        var fn = qs('#umMyFullName');
                        var ph = qs('#umMyPhone');
                        if (em) em.value = data.email || '';
                        if (fn) fn.value = data.full_name || '';
                        if (ph) ph.value = data.phone || '';
                        showFeedback(qs('#umProfileFeedback'), 'Fields reset to current values.', 'info');
                    });
            });
        }
    }

    /* ================================================================
       PANEL 2: CHANGE PASSWORD
    ================================================================ */
    function initPasswordPanel() {
        var pwdForm    = qs('#umPasswordForm');
        var newPwdIn   = qs('#umNewPwd');
        var confirmIn  = qs('#umConfirmPwd');
        var matchHint  = qs('#umMatchHint');
        var pwdFb      = qs('#umPasswordFeedback');

        /* Show/hide eye toggles */
        qsa('.um-eye-btn').forEach(function(btn) {
            btn.addEventListener('click', function() {
                var targetId = this.dataset.target;
                var inp = qs('#' + targetId);
                if (!inp) return;
                var isPass = inp.type === 'password';
                inp.type = isPass ? 'text' : 'password';
                var icon = this.querySelector('i');
                if (icon) icon.className = isPass ? 'fa-regular fa-eye-slash' : 'fa-regular fa-eye';
            });
        });

        /* Strength meter */
        if (newPwdIn) {
            newPwdIn.addEventListener('input', function() {
                updateStrength(this.value);
                checkMatch();
            });
        }
        if (confirmIn) {
            confirmIn.addEventListener('input', checkMatch);
        }

        function checkMatch() {
            if (!newPwdIn || !confirmIn || !matchHint) return;
            var nv = newPwdIn.value;
            var cv = confirmIn.value;
            if (!cv) { matchHint.textContent = ''; matchHint.className = 'um-match-hint'; return; }
            if (nv === cv) { matchHint.textContent = '✓ Passwords match'; matchHint.className = 'um-match-hint match'; }
            else { matchHint.textContent = '✗ Passwords do not match'; matchHint.className = 'um-match-hint no-match'; }
        }

        function updateStrength(pwd) {
            var scores = [false,false,false,false];
            var label  = qs('#umStrengthLabel');
            var segs   = [qs('#umSeg1'), qs('#umSeg2'), qs('#umSeg3'), qs('#umSeg4')];
            if (!pwd) {
                segs.forEach(function(s) { if(s) s.className = 'um-strength-seg'; });
                if (label) label.textContent = 'Enter a new password';
                return;
            }
            var score = 0;
            if (pwd.length >= 8) score++;
            if (/[A-Z]/.test(pwd)) score++;
            if (/[0-9]/.test(pwd)) score++;
            if (/[^A-Za-z0-9]/.test(pwd)) score++;

            var classes = ['s-weak','s-fair','s-good','s-strong'];
            var labels  = ['Weak','Fair','Good','Strong'];
            segs.forEach(function(s, i) {
                if (!s) return;
                s.className = 'um-strength-seg' + (i < score ? ' ' + classes[score - 1] : '');
            });
            if (label) label.textContent = score > 0 ? labels[score - 1] : 'Too weak';
        }

        /* Submit */
        if (pwdForm) {
            pwdForm.addEventListener('submit', function(e) {
                e.preventDefault();
                var curPwd  = (qs('#umCurrentPwd')  || {}).value || '';
                var newPwd  = (qs('#umNewPwd')       || {}).value || '';
                var confPwd = (qs('#umConfirmPwd')   || {}).value || '';
                var id      = (qs('#umMyUserId')     || {}).value || currentUserId;

                if (!curPwd) { showFeedback(pwdFb, 'Current password is required.', 'error'); return; }
                if (!newPwd || newPwd.length < 8) { showFeedback(pwdFb, 'New password must be at least 8 characters.', 'error'); return; }
                if (newPwd !== confPwd) { showFeedback(pwdFb, 'New passwords do not match.', 'error'); return; }
                if (!id) { showFeedback(pwdFb, 'Session error. Please reload the page.', 'error'); return; }

                /* Verify current password by attempting login */
                fetch('/api/admin/users/' + id, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    credentials: 'include',
                    body: JSON.stringify({ email: qs('#umMyEmail') ? qs('#umMyEmail').value.trim().toLowerCase() : '', password: newPwd, currentPassword: curPwd })
                })
                .then(function(r) { return r.json(); })
                .then(function(data) {
                    if (data.success) {
                        showFeedback(pwdFb, '✓ Password updated successfully.', 'success');
                        pwdForm.reset();
                        qsa('#umSeg1,#umSeg2,#umSeg3,#umSeg4').forEach(function(s) { s.className = 'um-strength-seg'; });
                        if (qs('#umStrengthLabel')) qs('#umStrengthLabel').textContent = 'Enter a new password';
                        if (matchHint) { matchHint.textContent = ''; matchHint.className = 'um-match-hint'; }
                        loadAllUsers();
                    } else {
                        showFeedback(pwdFb, '✗ ' + (data.message || 'Update failed. Check your current password.'), 'error');
                    }
                })
                .catch(function() { showFeedback(pwdFb, '✗ Network error. Please try again.', 'error'); });
            });
        }
    }

    /* ================================================================
       PANEL 3: MANAGE USERS
    ================================================================ */
    /* ---- Drawer open/close (shared by Add button and per-card Edit) ---- */
    function umCloseDrawer() {
        var drawer = qs('#umAddUserDrawer');
        if (window.closeAtlDrawer) window.closeAtlDrawer('umAddUserDrawer');
    }

    function umResetDrawer() {
        ['#umNewUserEmail', '#umNewUserFullName', '#umNewUserPwd'].forEach(function(sel) {
            var el = qs(sel); if (el) el.value = '';
        });
        if (qs('#umNewUserRole')) qs('#umNewUserRole').value = 'manager';
        if (qs('#umNewUserStatus')) qs('#umNewUserStatus').value = '1';
        if (itiUmPhone && typeof itiUmPhone.setNumber === 'function') itiUmPhone.setNumber('');
        else if (qs('#umNewUserPhone')) qs('#umNewUserPhone').value = '';
        var fb = qs('#umAddUserFeedback'); if (fb) { fb.className = 'um-feedback'; fb.textContent = ''; }
        umRenderStrength('', ['#umDSeg1', '#umDSeg2', '#umDSeg3', '#umDSeg4'], '#umDStrengthLabel');
        umClearUserFieldErrs();
    }

    /* Inline per-field validation helpers (G5). */
    function umSetFieldErr(errSel, msg) {
        var el = qs(errSel);
        if (el) { el.textContent = msg || ''; el.style.display = msg ? 'block' : 'none'; }
    }
    function umClearUserFieldErrs() {
        ['#errNewUserEmail', '#errNewUserFullName', '#errNewUserPhone', '#errNewUserPwd'].forEach(function(id) { umSetFieldErr(id, ''); });
    }

    /* Generic password-strength meter renderer (shared by the Add/Edit drawer). */
    function umRenderStrength(pwd, segIds, labelId) {
        var label = qs(labelId);
        var segs = segIds.map(function(id) { return qs(id); });
        if (!pwd) {
            segs.forEach(function(s) { if (s) s.className = 'um-strength-seg'; });
            if (label) label.textContent = 'Enter a password';
            return;
        }
        var score = 0;
        if (pwd.length >= 8) score++;
        if (/[A-Z]/.test(pwd)) score++;
        if (/[0-9]/.test(pwd)) score++;
        if (/[^A-Za-z0-9]/.test(pwd)) score++;
        var classes = ['s-weak', 's-fair', 's-good', 's-strong'];
        var labels  = ['Weak', 'Fair', 'Good', 'Strong'];
        segs.forEach(function(s, i) {
            if (!s) return;
            s.className = 'um-strength-seg' + (i < score ? ' ' + classes[score - 1] : '');
        });
        if (label) label.textContent = score > 0 ? labels[score - 1] : 'Too weak';
    }

    /* user === null → create mode; user object → edit mode */
    function umOpenDrawer(user) {
        var drawer      = qs('#umAddUserDrawer');
        var title       = qs('#umDrawerTitle');
        var idField     = qs('#umDrawerUserId');
        var statusGroup = qs('#umNewUserStatusGroup');
        var pwdGroup    = qs('#umNewUserPwdGroup');
        var pwdTips     = qs('#umDrawerPwdTips');
        var inviteNote  = qs('#umInviteNotice');
        var pwdLabel    = qs('#umPwdLabelText');
        var pwdInput    = qs('#umNewUserPwd');
        var submitBtn   = qs('#umAddUserSubmit');

        umResetDrawer();

        if (user) {
            // Edit mode: admin may optionally set a new password; show the password field + tips.
            if (pwdGroup) pwdGroup.style.display = '';
            if (pwdTips) pwdTips.style.display = '';
            if (inviteNote) inviteNote.style.display = 'none';
            if (idField) idField.value = user.id;
            if (title) title.innerHTML = '<i class="fa-solid fa-user-pen"></i> Edit Admin Account';
            if (qs('#umNewUserEmail')) qs('#umNewUserEmail').value = user.email || '';
            if (qs('#umNewUserFullName')) qs('#umNewUserFullName').value = user.full_name || '';
            if (qs('#umNewUserRole')) qs('#umNewUserRole').value = user.role || 'manager';
            if (statusGroup) statusGroup.style.display = '';
            if (qs('#umNewUserStatus')) qs('#umNewUserStatus').value = (user.is_active === 0 ? '0' : '1');
            if (user.phone) {
                if (itiUmPhone && typeof itiUmPhone.setNumber === 'function') itiUmPhone.setNumber(user.phone);
                else if (qs('#umNewUserPhone')) qs('#umNewUserPhone').value = user.phone;
            }
            if (pwdLabel) pwdLabel.textContent = 'New Password (leave blank to keep current)';
            if (pwdInput) pwdInput.placeholder = 'Leave blank to keep current';
            if (submitBtn) submitBtn.innerHTML = '<i class="fa-solid fa-floppy-disk"></i> Save Changes';

            // Populate Audit information in edit mode
            var auditGroup = qs('#umAuditGroup');
            if (auditGroup) {
                auditGroup.style.display = 'block';
                var creatorDisplay = user.creator_name ? (user.creator_name + ' (' + user.creator_email + ')') : (user.creator_email || 'System / Initial');
                var modifierDisplay = user.modifier_name ? (user.modifier_name + ' (' + user.modifier_email + ')') : (user.modifier_email || '—');
                
                qs('#umAuditCreatedBy').textContent = creatorDisplay;
                qs('#umAuditCreatedOn').textContent = user.created_on ? fmtDate(user.created_on) : (user.created_at ? fmtDate(user.created_at) : '—');
                qs('#umAuditModifiedBy').textContent = modifierDisplay;
                qs('#umAuditModifiedOn').textContent = user.modified_on ? fmtDate(user.modified_on) : '—';
            }
            var histGroup = qs('#umChangeHistoryGroup');
            if (histGroup) {
                histGroup.style.display = 'block';
                if (window.loadChangeHistoryCard) window.loadChangeHistoryCard('umChangeHistoryList', 'admins', user.id);
            }
        } else {
            // Create mode: invitation flow — no admin-set password; hide the password field + tips.
            if (pwdGroup) pwdGroup.style.display = 'none';
            if (pwdTips) pwdTips.style.display = 'none';
            if (inviteNote) inviteNote.style.display = 'flex';
            if (idField) idField.value = '';
            if (title) title.innerHTML = '<i class="fa-solid fa-user-plus"></i> Create New Admin Account';
            if (statusGroup) statusGroup.style.display = 'none';
            if (pwdLabel) pwdLabel.textContent = 'Password';
            if (pwdInput) pwdInput.placeholder = 'Minimum 8 characters';
            if (submitBtn) submitBtn.innerHTML = '<i class="fa-solid fa-user-plus"></i> Create Account';

            // Hide audit group + change history in create mode (no record exists yet)
            var auditGroup = qs('#umAuditGroup');
            if (auditGroup) auditGroup.style.display = 'none';
            var histGroupNew = qs('#umChangeHistoryGroup');
            if (histGroupNew) histGroupNew.style.display = 'none';
        }

        if (window.openAtlDrawer) window.openAtlDrawer('umAddUserDrawer');
    }

    function initManageUsers() {

        /* Phone field — intl-tel-input, mirroring the #managerCell pattern */
        var phoneInput = qs('#umNewUserPhone');
        if (phoneInput && window.intlTelInput && !itiUmPhone) {
            itiUmPhone = window.intlTelInput(phoneInput, {
                utilsScript: "https://cdnjs.cloudflare.com/ajax/libs/intl-tel-input/17.0.19/js/utils.js",
                separateDialCode: true,
                initialCountry: "za"
            });
        }

        /* Password strength meter (Add/Edit drawer) */
        var drawerPwd = qs('#umNewUserPwd');
        if (drawerPwd) drawerPwd.addEventListener('input', function() {
            umRenderStrength(this.value, ['#umDSeg1', '#umDSeg2', '#umDSeg3', '#umDSeg4'], '#umDStrengthLabel');
        });

        /* Drawer toggle */
        var addToggle   = qs('#umAddUserToggle');
        var drawerClose = qs('#umDrawerClose');
        var addCancel   = qs('#umAddUserCancel');

        if (addToggle) addToggle.addEventListener('click', function() { umOpenDrawer(null); });
        if (drawerClose) drawerClose.addEventListener('click', umCloseDrawer);
        if (addCancel) addCancel.addEventListener('click', umCloseDrawer);

        /* Search — filters the table view and resets to page 1 */
        var searchIn = qs('#umUserSearch');
        if (searchIn) {
            searchIn.addEventListener('input', function() {
                umTable.search = this.value.trim();
                umTable.page = 1;
                renderUsersTable();
            });
        }

        /* Bulk select / delete controls */
        initUsersBulkControls();

        /* Add/Edit User form — POST when create, PUT when editing */
        var addForm = qs('#umAddUserForm');
        var addFb   = qs('#umAddUserFeedback');
        if (addForm) {
            [['#umNewUserEmail','#errNewUserEmail'],['#umNewUserFullName','#errNewUserFullName'],['#umNewUserPhone','#errNewUserPhone'],['#umNewUserPwd','#errNewUserPwd']].forEach(function(pair){
                var inp = qs(pair[0]);
                if (inp) inp.addEventListener('input', function(){ umSetFieldErr(pair[1], ''); });
            });
            addForm.addEventListener('submit', async function(e) {
                e.preventDefault();
                var userId   = (qs('#umDrawerUserId') || {}).value || '';
                var isEdit   = !!userId;
                var email    = ((qs('#umNewUserEmail') || {}).value || '').trim().toLowerCase();
                var fullName = ((qs('#umNewUserFullName') || {}).value || '').trim();
                var role     = (qs('#umNewUserRole') || {}).value || 'manager';
                var password = (qs('#umNewUserPwd') || {}).value || '';
                var phone    = (itiUmPhone && typeof itiUmPhone.getNumber === 'function')
                                 ? itiUmPhone.getNumber()
                                 : ((qs('#umNewUserPhone') || {}).value || '').trim();

                umClearUserFieldErrs();
                var bad = false;
                if (!email) { umSetFieldErr('#errNewUserEmail', 'Email is required.'); bad = true; }
                else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { umSetFieldErr('#errNewUserEmail', 'Enter a valid email address.'); bad = true; }
                if (!fullName) { umSetFieldErr('#errNewUserFullName', 'Full name is required.'); bad = true; }
                if (!phone) { umSetFieldErr('#errNewUserPhone', 'Phone number is required.'); bad = true; }
                // Create uses the emailed invitation (no admin-set password); only edit may set one.
                if (isEdit && password && password.length < 8) { umSetFieldErr('#errNewUserPwd', 'Password must be at least 8 characters.'); bad = true; }
                if (bad) { showFeedback(addFb, 'Please fix the highlighted fields.', 'error'); return; }

                var payload = { email: email, full_name: fullName, phone: phone, role: role };
                if (isEdit && password) payload.password = password;
                if (isEdit) payload.is_active = (parseInt((qs('#umNewUserStatus') || {}).value, 10) === 0) ? 0 : 1;

                var submitBtn = qs('#umAddUserSubmit');
                var origHtml  = submitBtn ? submitBtn.innerHTML : '';
                if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = isEdit ? 'Saving…' : 'Creating…'; }

                try {
                    var data = await apiCall('/api/admin/users' + (isEdit ? '/' + userId : ''), isEdit ? 'PUT' : 'POST', payload);
                    if (data && data.success) {
                        // "Last Updated By": populate straight from this save's own response rather
                        // than waiting on the next drawer-open's LEFT JOIN — that only reflected fresh
                        // data on a subsequent reopen, never immediately after the save that caused it.
                        if (data.last_updated) {
                            var mBy = qs('#umAuditModifiedBy'), mOn = qs('#umAuditModifiedOn');
                            var roleLabel = data.last_updated.role ? (data.last_updated.role.charAt(0).toUpperCase() + data.last_updated.role.slice(1)) : '';
                            if (mBy) mBy.textContent = data.last_updated.name + (roleLabel ? ' (' + roleLabel + ')' : '');
                            if (mOn) mOn.textContent = data.last_updated.at ? fmtDate(data.last_updated.at) : '—';
                        }
                        umCloseDrawer();
                        loadAllUsers();
                        if (isEdit) {
                            if (window.notificationService) window.notificationService.showSuccess('User updated', 'Changes saved successfully.');
                        } else if (data.email_sent) {
                            if (window.notificationService) window.notificationService.showSuccess('Invitation sent', 'A set-password invite was emailed to ' + email + '.');
                        } else {
                            if (window.notificationService) window.notificationService.showInfo('User created', 'But the invitation email could not be sent. Use “Resend invite” on their row.');
                        }
                    } else {
                        showFeedback(addFb, '✗ ' + ((data && data.message) || (isEdit ? 'Failed to update user.' : 'Failed to create user.')), 'error');
                    }
                } catch (err) {
                    // apiCall already surfaced a toast and handled 401 re-login; mirror to the inline banner otherwise.
                    if (!err || err.message !== 'Session expired. Please log in.') {
                        showFeedback(addFb, '✗ ' + String((err && err.message) || 'Network error. Please try again.').replace(/^API Error:\s*/, ''), 'error');
                    }
                } finally {
                    if (submitBtn) { submitBtn.disabled = false; submitBtn.innerHTML = origHtml; }
                }
            });
        }
    }

    /* ---- Load & Render All Users ---- */
    /* ================================================================
       MANAGE USERS — table state + render (pagination, sort, bulk)
    ================================================================ */
    var umTable = { page: 1, limit: 10, sort: 'created_at', order: 'DESC', search: '', selected: {} };
    var UM_ROLES = ['assistant', 'manager', 'administrator']; // keep in sync with backend VALID_ADMIN_ROLES + Add User drawer

    function umDisplayName(u) { return u.full_name || u.username || u.email || ''; }

    function loadAllUsers() {
        var body = qs('#umUsersTableBody');
        if (body) body.innerHTML = '<tr><td colspan="8" class="text-center" style="padding:40px; border:none; opacity:0.5;"><i class="fa-solid fa-circle-notch fa-spin" style="margin-right:8px;"></i> Loading users…</td></tr>';

        fetch('/api/admin/users', { credentials: 'include' })
            .then(function(r) { return r.json(); })
            .then(function(users) {
                allUsersCache = Array.isArray(users) ? users : [];
                renderUsersTable();
            })
            .catch(function() {
                if (body) body.innerHTML = '<tr><td colspan="8" class="text-center" style="padding:40px; border:none; color:var(--atl-clay);"><i class="fa-solid fa-triangle-exclamation" style="margin-right:8px;"></i> Failed to load users. Please try again.</td></tr>';
                if (window.notificationService) window.notificationService.showError('Could not load users. Please try again.');
            });
    }

    function getUsersView() {
        var q = (umTable.search || '').toLowerCase();
        var qid = q.replace(/^#/, ''); // allow "#1003" or "1003" to match the ID column
        var rows = allUsersCache.filter(function(u) {
            if (!q) return true;
            return (String(u.full_name || '').toLowerCase().indexOf(q) !== -1) ||
                   (String(u.email || '').toLowerCase().indexOf(q) !== -1) ||
                   (String(u.username || '').toLowerCase().indexOf(q) !== -1) ||
                   (qid !== '' && String(u.id).indexOf(qid) !== -1);
        });
        var key = umTable.sort, dir = (umTable.order === 'ASC') ? 1 : -1;
        rows.sort(function(a, b) {
            var av, bv;
            if (key === 'name')        { av = umDisplayName(a).toLowerCase();  bv = umDisplayName(b).toLowerCase(); }
            else if (key === 'status') { av = (a.is_active === 0 ? 0 : 1);      bv = (b.is_active === 0 ? 0 : 1); }
            else if (key === 'id')     { av = parseInt(a.id, 10) || 0;          bv = parseInt(b.id, 10) || 0; }
            else if (key === 'last_login_at' || key === 'created_at') {
                var an = a[key] ? new Date(a[key]).getTime() : null;
                var bn = b[key] ? new Date(b[key]).getTime() : null;
                // nulls (e.g. never logged in) always sort to the bottom regardless of direction
                if (an === null && bn === null) return 0;
                if (an === null) return 1;
                if (bn === null) return -1;
                av = an; bv = bn;
            }
            else { av = String(a[key] || '').toLowerCase(); bv = String(b[key] || '').toLowerCase(); }
            if (av < bv) return -1 * dir;
            if (av > bv) return 1 * dir;
            return 0;
        });
        return rows;
    }

    function renderUsersTable() {
        var body    = qs('#umUsersTableBody');
        var countEl = qs('#umUserCount');
        var statsEl = qs('#umUserStats');
        if (!body) return;

        var view  = getUsersView();
        var total = view.length;
        if (countEl) countEl.textContent = allUsersCache.length + ' user' + (allUsersCache.length === 1 ? '' : 's');

        var totalPages = Math.max(1, Math.ceil(total / umTable.limit));
        if (umTable.page > totalPages) umTable.page = totalPages;
        var start    = (umTable.page - 1) * umTable.limit;
        var pageRows = view.slice(start, start + umTable.limit);

        if (!total) {
            body.innerHTML = '<tr><td colspan="8" class="text-center" style="padding:48px; border:none; color:var(--atl-muted);"><i class="fa-solid fa-users-slash" style="font-size:28px; opacity:0.4; display:block; margin-bottom:10px;"></i>' + (umTable.search ? 'No users match your search.' : 'No admin accounts found.') + '</td></tr>';
            if (statsEl) statsEl.textContent = 'Showing 0 to 0 of 0 entries';
            renderUserPagination(1);
            updateSortIconsUsers();
            updateSelectAllState();
            updateBulkBar();
            return;
        }

        body.innerHTML = pageRows.map(function(u) {
            var isSelf      = (currentUserId && parseInt(u.id) === parseInt(currentUserId));
            var role        = u.role || 'manager';
            var roleLabel   = role.charAt(0).toUpperCase() + role.slice(1);
            var isSuspended = (u.is_active === 0);
            var pending     = (parseInt(u.must_change_password, 10) === 1 && !u.last_login_at); // invited but not yet onboarded
            var name        = umDisplayName(u);
            var checked     = umTable.selected[u.id] ? ' checked' : '';

            // Role: inline dropdown for others, static badge for self (you can't demote yourself here).
            var roleCell = isSelf
                ? '<span class="um-role-badge um-role-badge--' + esc(role) + '">' + esc(roleLabel) + '</span>'
                : '<select class="atl-input um-role-change" data-id="' + esc(u.id) + '" aria-label="Change role for ' + esc(name) + '" style="width:auto; background:var(--atl-card); color:var(--atl-ink); border-color:var(--atl-line); font-size:12px;">' +
                      UM_ROLES.map(function(r) {
                          return '<option value="' + r + '"' + (r === role ? ' selected' : '') + '>' + (r.charAt(0).toUpperCase() + r.slice(1)) + '</option>';
                      }).join('') +
                  '</select>';

            // Status: toggle switch for others, static badge for self. Pending overrides the "Active" label.
            var statusWord  = isSuspended ? 'Suspended' : (pending ? 'Pending' : 'Active');
            var statusClass = isSuspended ? 'suspended' : (pending ? 'pending' : 'active');
            var statusCell = isSelf
                ? '<span class="um-status-badge um-status-badge--' + statusClass + '">' + statusWord + '</span>'
                : '<span class="um-status-cell">' +
                      '<label class="um-toggle"><input type="checkbox" class="um-status-toggle" data-id="' + esc(u.id) + '"' + (isSuspended ? '' : ' checked') + ' aria-label="Toggle active status for ' + esc(name) + '"><span class="um-toggle__track"><span class="um-toggle__thumb"></span></span></label>' +
                      (pending
                          ? '<span class="um-status-badge um-status-badge--pending" title="Invitation sent — awaiting first sign-in">Pending</span>'
                          : '<span class="um-status-cell__label">' + statusWord + '</span>') +
                  '</span>';

            var createdDate = u.created_on || u.created_at;
            var creatorDisplay = u.creator_email ? u.creator_email : 'System / Initial';
            var modifierDisplay = u.modifier_email ? u.modifier_email : '—';
            var modifiedDate = u.modified_on ? fmtDate(u.modified_on) : '—';
            var auditTooltip = 'Created by: ' + creatorDisplay + ' on ' + fmtDate(createdDate) + '\nLast modified by: ' + modifierDisplay + ' on ' + modifiedDate;

            return '<tr class="um-user-row" data-user-id="' + esc(u.id) + '">' +
                '<td style="border:none; padding:12px; border-radius:8px 0 0 8px;">' +
                    (isSelf ? '' : '<input type="checkbox" class="um-check um-row-check" data-id="' + esc(u.id) + '"' + checked + ' aria-label="Select ' + esc(u.email || u.username) + '">') +
                '</td>' +
                '<td style="border:none; padding:12px; color:var(--atl-muted); font-family:\'JetBrains Mono\',monospace; font-size:12px;" title="' + esc(auditTooltip) + '">#' + esc(u.id) + ' <i class="fa-solid fa-circle-info" style="font-size:10px; margin-left:2px; opacity:0.6;"></i></td>' +
                '<td style="border:none; padding:12px;">' +
                    '<div class="um-user-cell">' +
                        '<div class="um-avatar-sm">' + initial(name) + '</div>' +
                        '<div style="min-width:0;">' +
                            '<div style="color:var(--atl-ink); font-weight:600; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">' + esc(name) + (isSelf ? ' <span class="um-user-card__badge um-user-card__badge--you" style="margin-left:4px;">You</span>' : '') + '</div>' +
                            '<div style="color:var(--atl-muted); font-size:11px;">@' + esc(u.username) + '</div>' +
                        '</div>' +
                    '</div>' +
                '</td>' +
                '<td style="border:none; padding:12px; color:var(--atl-ink-dim);">' + esc(u.email || '—') + '</td>' +
                '<td style="border:none; padding:12px;">' + roleCell + '</td>' +
                '<td class="um-lastlogin-cell" style="border:none; padding:12px; font-size:12px;">' + (u.last_login_at ? fmtDate(u.last_login_at) : '<span style="color:var(--atl-muted-dim);">Never</span>') + '</td>' +
                '<td style="border:none; padding:12px;">' + statusCell + '</td>' +
                '<td style="border:none; padding:12px; border-radius:0 8px 8px 0; white-space:nowrap;">' +
                    (isSelf
                        ? '<span style="font-size:11px; color:var(--atl-muted-dim);">—</span>'
                        : (pending ? '<button class="um-icon-btn um-resend-btn" data-id="' + esc(u.id) + '" data-name="' + esc(u.email || u.username) + '" title="Resend invitation" aria-label="Resend invitation"><i class="fa-solid fa-paper-plane"></i></button>' : '') +
                          '<button class="um-icon-btn um-edit-btn" data-id="' + esc(u.id) + '" title="Edit" aria-label="Edit user"><i class="fa-solid fa-pen"></i></button>' +
                          '<button class="um-icon-btn um-icon-btn--danger um-del-btn" data-id="' + esc(u.id) + '" data-name="' + esc(u.email || u.username) + '" title="Delete" aria-label="Delete user"><i class="fa-solid fa-trash-can"></i></button>'
                    ) +
                '</td>' +
            '</tr>';
        }).join('');

        if (statsEl) statsEl.textContent = 'Showing ' + (start + 1) + ' to ' + (start + pageRows.length) + ' of ' + total + ' entries';

        renderUserPagination(totalPages);
        updateSortIconsUsers();
        updateSelectAllState();
        updateBulkBar();

        /* Row edit */
        qsa('.um-edit-btn', body).forEach(function(btn) {
            btn.addEventListener('click', function() {
                var id = parseInt(this.dataset.id, 10);
                var user = allUsersCache.filter(function(x) { return parseInt(x.id, 10) === id; })[0];
                if (user) umOpenDrawer(user);
            });
        });
        /* Row delete */
        qsa('.um-del-btn', body).forEach(function(btn) {
            btn.addEventListener('click', function() {
                var id = this.dataset.id;
                var name = this.dataset.name || ('user #' + id);
                deleteUsers([id], 'Delete ' + name + '? This cannot be undone.');
            });
        });
        /* Row checkboxes */
        qsa('.um-row-check', body).forEach(function(cb) {
            cb.addEventListener('change', function() {
                if (this.checked) umTable.selected[this.dataset.id] = true;
                else delete umTable.selected[this.dataset.id];
                updateSelectAllState();
                updateBulkBar();
            });
        });
        /* Inline role change */
        qsa('.um-role-change', body).forEach(function(sel) {
            sel.addEventListener('change', function() {
                umUpdateUser(this.dataset.id, { role: this.value }, 'Role updated.');
            });
        });
        /* Inline status toggle (activate / deactivate) */
        qsa('.um-status-toggle', body).forEach(function(tg) {
            tg.addEventListener('change', function() {
                var active = this.checked;
                umUpdateUser(this.dataset.id, { is_active: active ? 1 : 0 }, active ? 'User activated.' : 'User deactivated.');
            });
        });
        /* Resend invitation (pending users) */
        qsa('.um-resend-btn', body).forEach(function(btn) {
            btn.addEventListener('click', function() {
                var id = this.dataset.id;
                var name = this.dataset.name || ('user #' + id);
                var icon = this.querySelector('i');
                var self = this;
                self.disabled = true;
                if (icon) icon.className = 'fa-solid fa-circle-notch fa-spin';
                apiCall('/api/admin/users/' + id + '/resend-invite', 'POST', {})
                    .then(function(data) {
                        if (data && data.success && data.email_sent) {
                            if (window.notificationService) window.notificationService.showSuccess('Invitation re-sent', 'A new set-password link was emailed to ' + name + '.');
                        } else {
                            if (window.notificationService) window.notificationService.showInfo('Could not send', 'The invitation email could not be sent. Please try again.');
                        }
                    })
                    .catch(function(err) {
                        if (!err || err.message !== 'Session expired. Please log in.') {
                            if (window.notificationService) window.notificationService.showError('Failed to resend the invitation. Please try again.');
                        }
                    })
                    .finally(function() {
                        self.disabled = false;
                        if (icon) icon.className = 'fa-solid fa-paper-plane';
                    });
            });
        });
    }

    function renderUserPagination(totalPages) {
        var container = qs('#umUserPagination');
        if (!container) return;
        container.innerHTML = '';
        if (totalPages <= 1) return;

        var prev = document.createElement('button');
        prev.className = 'um-btn um-btn--ghost um-btn--sm' + (umTable.page === 1 ? ' disabled' : '');
        prev.innerHTML = '<i class="fa fa-chevron-left"></i>';
        prev.onclick = function() { if (umTable.page > 1) { umTable.page--; renderUsersTable(); } };
        container.appendChild(prev);

        for (var i = 1; i <= totalPages; i++) {
            if (totalPages > 7 && i > 5 && i < totalPages) {
                if (i === 6) { var sp = document.createElement('span'); sp.textContent = '…'; sp.style.color = 'var(--atl-muted)'; sp.style.padding = '0 4px'; container.appendChild(sp); }
                continue;
            }
            var b = document.createElement('button');
            b.className = 'um-btn um-btn--sm ' + (umTable.page === i ? 'um-btn--primary' : 'um-btn--ghost');
            b.textContent = i;
            (function(p) { b.onclick = function() { umTable.page = p; renderUsersTable(); }; })(i);
            container.appendChild(b);
        }

        var next = document.createElement('button');
        next.className = 'um-btn um-btn--ghost um-btn--sm' + (umTable.page === totalPages ? ' disabled' : '');
        next.innerHTML = '<i class="fa fa-chevron-right"></i>';
        next.onclick = function() { if (umTable.page < totalPages) { umTable.page++; renderUsersTable(); } };
        container.appendChild(next);
    }

    window.toggleUserSort = function(col) {
        if (umTable.sort === col) {
            umTable.order = (umTable.order === 'ASC') ? 'DESC' : 'ASC';
        } else {
            umTable.sort = col;
            umTable.order = (col === 'last_login_at' || col === 'id') ? 'DESC' : 'ASC';
        }
        umTable.page = 1;
        renderUsersTable();
    };

    function updateSortIconsUsers() {
        qsa('.um-th-sort i').forEach(function(icon) { icon.className = 'fa-solid fa-sort'; icon.style.opacity = '0.4'; });
        var active = qs('#umsort-' + umTable.sort);
        if (active) { active.className = (umTable.order === 'ASC') ? 'fa-solid fa-sort-up' : 'fa-solid fa-sort-down'; active.style.opacity = '1'; }
    }

    /* ---- Bulk selection ---- */
    function eligibleIdsOnPage() {
        return qsa('#umUsersTableBody .um-row-check').map(function(cb) { return cb.dataset.id; });
    }
    function updateSelectAllState() {
        var sa = qs('#umSelectAll');
        if (!sa) return;
        var ids = eligibleIdsOnPage();
        var sel = ids.filter(function(id) { return umTable.selected[id]; });
        sa.checked = ids.length > 0 && sel.length === ids.length;
        sa.indeterminate = sel.length > 0 && sel.length < ids.length;
    }
    function selectedCount() { return Object.keys(umTable.selected).length; }
    function updateBulkBar() {
        var bar = qs('#umBulkBar');
        var cnt = qs('#umBulkCount');
        var n = selectedCount();
        if (cnt) cnt.textContent = n;
        if (bar) bar.style.display = n > 0 ? 'flex' : 'none';
    }

    function deleteUsers(ids, confirmMsg) {
        if (!ids.length) return;
        Promise.resolve(
            window.notificationService
                ? window.notificationService.showConfirm({ message: confirmMsg, isDestructive: true })
                : window.confirm(confirmMsg)
        ).then(function(ok) {
            if (!ok) return;
            var failed = [];
            var runs = ids.map(function(id) {
                return fetch('/api/admin/users/' + id, { method: 'DELETE', credentials: 'include' })
                    .then(function(r) { return r.json(); })
                    .then(function(data) {
                        if (data && data.success) { delete umTable.selected[id]; }
                        else { failed.push((data && data.message) || ('user #' + id)); }
                    })
                    .catch(function() { failed.push('user #' + id + ' (network)'); });
            });
            Promise.all(runs).then(function() {
                if (failed.length && window.notificationService) {
                    window.notificationService.showError('Could not delete: ' + failed.join('; '));
                }
                loadAllUsers();
            });
        });
    }

    /* Single inline update (role dropdown or status toggle).
       Reuses PUT /api/admin/users/:id, which preserves all other fields and enforces
       the last-administrator guard server-side. Re-renders from cache on success, or
       reverts to cached truth on failure. */
    function umUpdateUser(id, changes, successMsg) {
        var user = allUsersCache.filter(function(x) { return parseInt(x.id, 10) === parseInt(id, 10); })[0];
        if (!user) return;
        var payload = Object.assign({ email: user.email }, changes);
        fetch('/api/admin/users/' + id, {
            method: 'PUT',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        })
            .then(function(r) { return r.json().then(function(d) { return { ok: r.ok, data: d }; }); })
            .then(function(res) {
                if (res.ok && res.data && res.data.success) {
                    if (successMsg && window.notificationService) window.notificationService.showSuccess(successMsg);
                    loadAllUsers();
                } else {
                    if (window.notificationService) window.notificationService.showError((res.data && res.data.message) || 'Update failed.');
                    renderUsersTable();
                }
            })
            .catch(function() {
                if (window.notificationService) window.notificationService.showError('Network error. Please try again.');
                renderUsersTable();
            });
    }

    /* Bulk activate / deactivate selected users. */
    function umBulkSetActive(ids, makeActive) {
        if (!ids.length) return;
        var verb = makeActive ? 'Activate' : 'Deactivate';
        Promise.resolve(
            window.notificationService
                ? window.notificationService.showConfirm({
                    message: verb + ' ' + ids.length + ' selected user' + (ids.length === 1 ? '' : 's') + '?',
                    confirmText: verb,
                    isDestructive: !makeActive
                  })
                : window.confirm(verb + ' ' + ids.length + ' user(s)?')
        ).then(function(ok) {
            if (!ok) return;
            var failed = [];
            var runs = ids.map(function(id) {
                var user = allUsersCache.filter(function(x) { return parseInt(x.id, 10) === parseInt(id, 10); })[0];
                if (!user) return Promise.resolve();
                return fetch('/api/admin/users/' + id, {
                    method: 'PUT',
                    credentials: 'include',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ email: user.email, is_active: makeActive ? 1 : 0 })
                })
                    .then(function(r) { return r.json().then(function(d) { return { ok: r.ok, data: d }; }); })
                    .then(function(res) {
                        if (!(res.ok && res.data && res.data.success)) failed.push((res.data && res.data.message) || ('user #' + id));
                    })
                    .catch(function() { failed.push('user #' + id + ' (network)'); });
            });
            Promise.all(runs).then(function() {
                if (window.notificationService) {
                    if (failed.length) window.notificationService.showError('Could not ' + verb.toLowerCase() + ': ' + failed.join('; '));
                    else window.notificationService.showSuccess(ids.length + ' user' + (ids.length === 1 ? '' : 's') + ' ' + (makeActive ? 'activated.' : 'deactivated.'));
                }
                loadAllUsers();
            });
        });
    }

    function initUsersBulkControls() {
        var sa = qs('#umSelectAll');
        if (sa) sa.addEventListener('change', function() {
            var ids = eligibleIdsOnPage();
            if (this.checked) ids.forEach(function(id) { umTable.selected[id] = true; });
            else ids.forEach(function(id) { delete umTable.selected[id]; });
            qsa('#umUsersTableBody .um-row-check').forEach(function(cb) { cb.checked = !!umTable.selected[cb.dataset.id]; });
            updateBulkBar();
        });
        var del = qs('#umBulkDeleteBtn');
        if (del) del.addEventListener('click', function() {
            var ids = Object.keys(umTable.selected);
            if (!ids.length) return;
            deleteUsers(ids, 'Delete ' + ids.length + ' selected user' + (ids.length === 1 ? '' : 's') + '? This cannot be undone.');
        });
        var act = qs('#umBulkActivateBtn');
        if (act) act.addEventListener('click', function() {
            umBulkSetActive(Object.keys(umTable.selected), true);
        });
        var deact = qs('#umBulkDeactivateBtn');
        if (deact) deact.addEventListener('click', function() {
            umBulkSetActive(Object.keys(umTable.selected), false);
        });
        var clr = qs('#umBulkClearBtn');
        if (clr) clr.addEventListener('click', function() {
            umTable.selected = {};
            qsa('#umUsersTableBody .um-row-check').forEach(function(cb) { cb.checked = false; });
            updateSelectAllState();
            updateBulkBar();
        });
    }

    /* Phase 6 (HOUSEKEEPING-NOTES.md): the "EMAIL LOGS MODULE" block (logState/
       logSearchTimer, loadEmailLogs/renderLogPagination/toggleLogSort/updateSortIcons/
       applyLogFilters/debounceLogSearch) moved to js/admin/email-logs.js. Every publicly-
       needed function was already window-attached in the original source (inline onclick/
       oninput/onchange attributes in the markup call these) — no new attachments needed. */
    // Phase 6 (HOUSEKEEPING-NOTES.md) FIX: the "EMAIL LOGS MODULE" block that used to sit here
    // was moved to js/admin/email-logs.js. It originally lived inside this same
    // initUserManagement(...) closure — removing it left a hole that broke this IIFE across two
    // <script> tags (a bug, now fixed). Unlike Services/Policies, the surrounding code here DOES
    // depend on this closure (esc/initTabs/moduleLoaded/loadAllUsers), so this IIFE is reunited
    // as one continuous block and the <script src> tag was moved to just before this whole block
    // instead — see that file's header comment for full detail.

    /* ================================================================
       PANEL 5: LOGIN ACTIVITY LOGS — state, API fetch, pagination, sort
       ================================================================ */
    var allLogsCache = [];
    var logsLoaded = false;
    var logTableState = { page: 1, limit: 10, sort: 'login_at', order: 'DESC', search: '' };

    function initManageLogs() {
        var refreshBtn = qs('#umRefreshLogsBtn');
        if (refreshBtn) {
            refreshBtn.addEventListener('click', function() {
                loadAllLogs();
            });
        }

        var searchIn = qs('#umLogSearch');
        if (searchIn) {
            searchIn.addEventListener('input', function() {
                logTableState.search = this.value.trim();
                logTableState.page = 1;
                renderLogsTable();
            });
        }

        // Lazy load logs when its tab is clicked
        qsa('.atl-tab-btn').forEach(function(btn) {
            if (btn.dataset.umTab === 'umPanelLogs') {
                btn.addEventListener('click', function() {
                    if (!logsLoaded) {
                        loadAllLogs();
                        logsLoaded = true;
                    }
                });
            }
        });
    }

    function loadAllLogs() {
        var body = qs('#umLogsTableBody');
        if (body) body.innerHTML = '<tr><td colspan="6" class="text-center" style="padding:40px; border:none; opacity:0.5;"><i class="fa-solid fa-circle-notch fa-spin" style="margin-right:8px;"></i> Loading activity logs…</td></tr>';

        fetch('/api/admin/user-login-logs', { credentials: 'include' })
            .then(function(r) { return r.json(); })
            .then(function(logs) {
                allLogsCache = Array.isArray(logs) ? logs : [];
                renderLogsTable();
            })
            .catch(function() {
                if (body) body.innerHTML = '<tr><td colspan="6" class="text-center" style="padding:40px; border:none; color:var(--atl-clay);"><i class="fa-solid fa-triangle-exclamation" style="margin-right:8px;"></i> Failed to load activity logs. Please try again.</td></tr>';
                if (window.notificationService) window.notificationService.showError('Could not load activity logs. Please try again.');
            });
    }

    function getLogsView() {
        var q = (logTableState.search || '').toLowerCase();
        var rows = allLogsCache.filter(function(l) {
            if (!q) return true;
            return (String(l.full_name || '').toLowerCase().indexOf(q) !== -1) ||
                   (String(l.email || '').toLowerCase().indexOf(q) !== -1) ||
                   (String(l.username || '').toLowerCase().indexOf(q) !== -1) ||
                   (String(l.ip_address || '').toLowerCase().indexOf(q) !== -1);
        });

        var key = logTableState.sort, dir = (logTableState.order === 'ASC') ? 1 : -1;
        rows.sort(function(a, b) {
            var av, bv;
            if (key === 'name') {
                av = (a.full_name || a.username || a.email || '').toLowerCase();
                bv = (b.full_name || b.username || b.email || '').toLowerCase();
            } else if (key === 'login_at' || key === 'last_activity_at') {
                av = a[key] ? new Date(a[key]).getTime() : 0;
                bv = b[key] ? new Date(b[key]).getTime() : 0;
            } else if (key === 'duration') {
                av = parseInt(a.duration_seconds, 10) || 0;
                bv = parseInt(b.duration_seconds, 10) || 0;
            } else {
                av = String(a[key] || '').toLowerCase();
                bv = String(b[key] || '').toLowerCase();
            }

            if (av < bv) return -1 * dir;
            if (av > bv) return 1 * dir;
            return 0;
        });
        return rows;
    }

    function formatDuration(seconds) {
        if (!seconds || seconds <= 0) return 'Under a minute';
        var m = Math.floor(seconds / 60);
        var s = seconds % 60;
        var h = Math.floor(m / 60);
        m = m % 60;

        var parts = [];
        if (h > 0) parts.push(h + 'h');
        if (m > 0) parts.push(m + 'm');
        if (s > 0 && h === 0) parts.push(s + 's');

        return parts.join(' ') || 'Under a minute';
    }

    function formatUserAgent(ua) {
        if (!ua) return 'Unknown Browser';
        var browser = 'Unknown Browser';
        var os = 'Unknown OS';

        if (ua.indexOf('Chrome') !== -1) browser = 'Chrome';
        else if (ua.indexOf('Safari') !== -1) browser = 'Safari';
        else if (ua.indexOf('Firefox') !== -1) browser = 'Firefox';
        else if (ua.indexOf('Edge') !== -1) browser = 'Edge';
        else if (ua.indexOf('MSIE') !== -1 || ua.indexOf('Trident/') !== -1) browser = 'IE';

        if (ua.indexOf('Windows') !== -1) os = 'Windows';
        else if (ua.indexOf('Macintosh') !== -1 || ua.indexOf('Mac OS') !== -1) os = 'macOS';
        else if (ua.indexOf('iPhone') !== -1 || ua.indexOf('iPad') !== -1) os = 'iOS';
        else if (ua.indexOf('Android') !== -1) os = 'Android';
        else if (ua.indexOf('Linux') !== -1) os = 'Linux';

        return browser + ' (' + os + ')';
    }

    function formatDateTimeLocal(isoString) {
        if (!isoString) return '—';
        try {
            var d = new Date(isoString);
            var pad = function(n) { return n < 10 ? '0' + n : n; };
            return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' +
                   pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
        } catch (e) {
            return isoString;
        }
    }

    function renderLogsTable() {
        var body = qs('#umLogsTableBody');
        var countEl = qs('#umLogCount');
        var statsEl = qs('#umLogStats');
        if (!body) return;

        var view = getLogsView();
        var total = view.length;
        if (countEl) countEl.textContent = allLogsCache.length + ' log' + (allLogsCache.length === 1 ? '' : 's');

        var totalPages = Math.max(1, Math.ceil(total / logTableState.limit));
        if (logTableState.page > totalPages) logTableState.page = totalPages;
        var start = (logTableState.page - 1) * logTableState.limit;
        var pageRows = view.slice(start, start + logTableState.limit);

        if (!total) {
            body.innerHTML = '<tr><td colspan="6" class="text-center" style="padding:48px; border:none; color:var(--atl-muted);"><i class="fa-solid fa-clock-rotate-left" style="font-size:28px; opacity:0.4; display:block; margin-bottom:10px;"></i>' + (logTableState.search ? 'No logs match your search.' : 'No activity logs found.') + '</td></tr>';
            if (statsEl) statsEl.textContent = 'Showing 0 to 0 of 0 entries';
            renderLogPagination(1);
            updateSortIconsLogs();
            return;
        }

        body.innerHTML = pageRows.map(function(l) {
            var userName = l.full_name || l.username || l.email || 'Deleted User';
            var userDetail = l.email ? '<span class="um-row-email" style="display:block; font-size:11px; opacity:0.7;">' + esc(l.email) + '</span>' : '';
            var duration = formatDuration(l.duration_seconds);
            var isSessionOngoing = (!l.logout_at && (Date.now() - new Date(l.last_activity_at).getTime() < 120000));

            var statusBadge = '';
            if (isSessionOngoing) {
                statusBadge = '<span style="display:inline-flex; align-items:center; gap:4px; font-size:11px; color:#10b981; font-weight:600;"><span class="atl-pulse-dot" style="width:6px; height:6px; background:#10b981; border-radius:50%; display:inline-block; animation: pulse-dot 1.5s infinite ease-in-out;"></span> Active Now</span>';
            } else {
                statusBadge = '<span style="font-size:11px; opacity:0.7; color:var(--atl-muted);">Session ended</span>';
            }

            return '<tr class="um-row" style="background: var(--atl-surface2); border-radius: var(--atl-r-md); transition: background var(--atl-t-fast);">' +
                   '  <td style="border:none; padding:12px; font-weight:600; color:var(--atl-ink);">' + esc(userName) + userDetail + '</td>' +
                   '  <td style="border:none; padding:12px; font-family:\'JetBrains Mono\', monospace; font-size:12px;">' + formatDateTimeLocal(l.login_at) + '</td>' +
                   '  <td style="border:none; padding:12px; font-family:\'JetBrains Mono\', monospace; font-size:12px;">' + formatDateTimeLocal(l.last_activity_at) + '</td>' +
                   '  <td style="border:none; padding:12px; font-family:\'JetBrains Mono\', monospace; font-size:12px;">' + duration + ' ' + statusBadge + '</td>' +
                   '  <td style="border:none; padding:12px; font-family:\'JetBrains Mono\', monospace; font-size:12px;">' + esc(l.ip_address || '—') + '</td>' +
                   '  <td style="border:none; padding:12px; font-size:12px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width:180px;" title="' + esc(l.user_agent) + '">' + esc(formatUserAgent(l.user_agent)) + '</td>' +
                   '</tr>';
        }).join('');

        if (statsEl) {
            var end = Math.min(start + logTableState.limit, total);
            statsEl.textContent = 'Showing ' + (start + 1) + ' to ' + end + ' of ' + total + ' entries';
        }

        renderLogPagination(totalPages);
        updateSortIconsLogs();
    }

    function renderLogPagination(totalPages) {
        var wrapper = qs('#umLogsPagination');
        if (!wrapper) {
            wrapper = qs('#umLogsFooter .um-pagination-btns');
        }
        if (!wrapper) return;
        wrapper.innerHTML = '';

        var prev = document.createElement('button');
        prev.className = 'um-btn um-btn--ghost um-btn--sm' + (logTableState.page === 1 ? ' disabled' : '');
        prev.innerHTML = '<i class="fa-solid fa-chevron-left"></i>';
        prev.onclick = function() { if (logTableState.page > 1) { logTableState.page--; renderLogsTable(); } };
        wrapper.appendChild(prev);

        for (var i = 1; i <= totalPages; i++) {
            var b = document.createElement('button');
            b.className = 'um-btn um-btn--sm ' + (logTableState.page === i ? 'um-btn--primary' : 'um-btn--ghost');
            b.textContent = i;
            (function(p) { b.onclick = function() { logTableState.page = p; renderLogsTable(); }; })(i);
            wrapper.appendChild(b);
        }

        var next = document.createElement('button');
        next.className = 'um-btn um-btn--ghost um-btn--sm' + (logTableState.page === totalPages ? ' disabled' : '');
        next.innerHTML = '<i class="fa-solid fa-chevron-right"></i>';
        next.onclick = function() { if (logTableState.page < totalPages) { logTableState.page++; renderLogsTable(); } };
        wrapper.appendChild(next);
    }

    window.toggleLogSort = function(col) {
        if (logTableState.sort === col) {
            logTableState.order = (logTableState.order === 'ASC') ? 'DESC' : 'ASC';
        } else {
            logTableState.sort = col;
            logTableState.order = (col === 'login_at' || col === 'last_activity_at') ? 'DESC' : 'ASC';
        }
        logTableState.page = 1;
        renderLogsTable();
    };

    function updateSortIconsLogs() {
        qsa('[id^="umlogsort-"]').forEach(function(i) {
            i.className = 'fa-solid fa-sort';
            i.style.opacity = '0.5';
        });
        var active = qs('#umlogsort-' + logTableState.sort);
        if (active) {
            active.className = (logTableState.order === 'ASC') ? 'fa-solid fa-sort-up' : 'fa-solid fa-sort-down';
            active.style.opacity = '1';
        }
    }

    function initEmailLogs() {
        // Bootstrap tab event
        if (typeof $ !== 'undefined') {
            $('a[href="#emailLogsAdmin"]').on('shown.bs.tab', function() {
                loadEmailLogs();
            });
        }
    }

    /* ================================================================
       BOOTSTRAP: initialise when #usersAdmin tab becomes active
    ================================================================ */
    function bootstrap() {
        initTabs();
        initProfile();
        initPasswordPanel();
        initManageUsers();
        initEmailLogs();
        initManageLogs();

        /* Auto-load profile on very first render (panel is already active) */
        var activePanel = qs('.um-panel.active');
        if (activePanel && activePanel.id === 'umPanelUsers') {
            loadAllUsers();
            moduleLoaded = true;
        }

        /* Also hook into Bootstrap tab show event for the parent #usersAdmin tab */
        var usersTab = qs('[href="#usersAdmin"], [data-target="#usersAdmin"], a[href="#usersAdmin"]');
        if (usersTab) {
            usersTab.addEventListener('shown.bs.tab', function() { /* already handled via um-tab-btn */ });
        }
        /* jQuery tab show fallback */
        if (typeof $ !== 'undefined') {
            $('a[href="#usersAdmin"]').on('shown.bs.tab', function() {
                if (!moduleLoaded) { loadAllUsers(); moduleLoaded = true; }
            });
        }
    }

    /* Run after DOM is ready */
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', bootstrap);
    } else {
        bootstrap();
    }

})();
