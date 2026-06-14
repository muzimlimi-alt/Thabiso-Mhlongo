
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

    /* ================================================================
       TAB SWITCHING
    ================================================================ */
    function initTabs() {
        qsa('.um-tab-btn').forEach(function(btn) {
            btn.addEventListener('click', function() {
                var target = this.dataset.umTab;
                var tabBar = this.closest('.um-tab-bar');
                var container = tabBar ? tabBar.parentElement : null;
                // Deactivate buttons in the same tab bar only
                var siblingBtns = tabBar ? tabBar.querySelectorAll('.um-tab-btn') : qsa('.um-tab-btn');
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
                var joined   = data.created_at || '';
                currentUserId = id;

                var usernameEl   = qs('#umMyUsername');
                var emailEl      = qs('#umMyEmail');
                var hiddenId     = qs('#umMyUserId');
                var displayName  = qs('#umMyDisplayName');
                var avatarHero   = qs('#umMyAvatarHero');
                var joinDateEl   = qs('#umMyJoinDate');

                if (usernameEl) usernameEl.value = username;
                if (emailEl) emailEl.value = email;
                if (hiddenId) hiddenId.value = id;
                if (displayName) displayName.textContent = username;
                if (avatarHero) avatarHero.textContent = initial(username);
                if (joinDateEl) joinDateEl.textContent = joined ? 'Member since ' + fmtDate(joined) : 'Member since —';
            })
            .catch(function() { /* silent */ });

        // Profile form submit
        var profileForm  = qs('#umProfileForm');
        var profileFb    = qs('#umProfileFeedback');
        var resetBtn     = qs('#umProfileResetBtn');
        var _origUser = '', _origEmail = '';

        // Capture originals on any input focus
        if (profileForm) {
            profileForm.addEventListener('submit', function(e) {
                e.preventDefault();
                var id       = qs('#umMyUserId').value;
                var username = qs('#umMyUsername').value.trim();
                var email    = qs('#umMyEmail').value.trim();

                if (!id || !username || !email) {
                    showFeedback(profileFb, 'Username and email are required.', 'error');
                    return;
                }

                var saveBtn = qs('#umProfileSaveBtn');
                if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = 'Saving…'; }

                fetch('/api/admin/users/' + id, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    credentials: 'include',
                    body: JSON.stringify({ username: username, email: email })
                })
                .then(function(r) { return r.json(); })
                .then(function(data) {
                    if (saveBtn) { saveBtn.disabled = false; saveBtn.innerHTML = '<i class="fa-solid fa-floppy-disk"></i> Save Profile'; }
                    if (data.success) {
                        showFeedback(profileFb, '✓ Profile updated successfully.', 'success');
                        // Update hero display
                        var dn = qs('#umMyDisplayName');
                        var ah = qs('#umMyAvatarHero');
                        if (dn) dn.textContent = username;
                        if (ah) ah.textContent = initial(username);
                        // Refresh header profile chip if present
                        var adpNameEl = qs('#adm-profile-name');
                        if (adpNameEl) adpNameEl.textContent = username;
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
                        var un = qs('#umMyUsername');
                        var em = qs('#umMyEmail');
                        if (un) un.value = data.username || '';
                        if (em) em.value = data.email || '';
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
                    body: JSON.stringify({ username: qs('#umMyUsername') ? qs('#umMyUsername').value : '', email: qs('#umMyEmail') ? qs('#umMyEmail').value : '', password: newPwd, currentPassword: curPwd })
                })
                .then(function(r) { return r.json(); })
                .then(function(data) {
                    if (data.success) {
                        showFeedback(pwdFb, '✓ Password updated successfully.', 'success');
                        pwdForm.reset();
                        qsa('#umSeg1,#umSeg2,#umSeg3,#umSeg4').forEach(function(s) { s.className = 'um-strength-seg'; });
                        if (qs('#umStrengthLabel')) qs('#umStrengthLabel').textContent = 'Enter a new password';
                        if (matchHint) { matchHint.textContent = ''; matchHint.className = 'um-match-hint'; }
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
    function initManageUsers() {

        /* Drawer toggle */
        var addToggle   = qs('#umAddUserToggle');
        var drawer      = qs('#umAddUserDrawer');
        var drawerClose = qs('#umDrawerClose');
        var addCancel   = qs('#umAddUserCancel');

        function openDrawer()  { if (drawer) { drawer.classList.add('open'); drawer.setAttribute('aria-hidden','false'); } }
        function closeDrawer() { if (drawer) { drawer.classList.remove('open'); drawer.setAttribute('aria-hidden','true'); } }

        if (addToggle) addToggle.addEventListener('click', openDrawer);
        if (drawerClose) drawerClose.addEventListener('click', closeDrawer);
        if (addCancel) addCancel.addEventListener('click', closeDrawer);

        /* Search */
        var searchIn = qs('#umUserSearch');
        if (searchIn) {
            searchIn.addEventListener('input', function() {
                filterCards(this.value.trim().toLowerCase());
            });
        }

        /* Add User form */
        var addForm = qs('#umAddUserForm');
        var addFb   = qs('#umAddUserFeedback');
        if (addForm) {
            addForm.addEventListener('submit', function(e) {
                e.preventDefault();
                var username = (qs('#umNewUsername') || {}).value.trim();
                var email    = (qs('#umNewUserEmail') || {}).value.trim();
                var password = (qs('#umNewUserPwd') || {}).value.trim();

                if (!username || !email || !password) {
                    showFeedback(addFb, 'All fields are required.', 'error');
                    return;
                }
                if (password.length < 8) {
                    showFeedback(addFb, 'Password must be at least 8 characters.', 'error');
                    return;
                }

                var submitBtn = qs('#umAddUserSubmit');
                if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = 'Creating…'; }

                fetch('/api/admin/users', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    credentials: 'include',
                    body: JSON.stringify({ username: username, email: email, password: password })
                })
                .then(function(r) { return r.json(); })
                .then(function(data) {
                    if (submitBtn) { submitBtn.disabled = false; submitBtn.innerHTML = '<i class="fa-solid fa-user-plus"></i> Create Account'; }
                    if (data.success) {
                        showFeedback(addFb, '✓ Account created successfully.', 'success');
                        addForm.reset();
                        closeDrawer();
                        loadAllUsers(); // refresh grid
                    } else {
                        showFeedback(addFb, '✗ ' + (data.message || 'Failed to create user.'), 'error');
                    }
                })
                .catch(function() {
                    if (submitBtn) { submitBtn.disabled = false; submitBtn.innerHTML = '<i class="fa-solid fa-user-plus"></i> Create Account'; }
                    showFeedback(addFb, '✗ Network error. Please try again.', 'error');
                });
            });
        }
    }

    /* ---- Load & Render All Users ---- */
    function loadAllUsers() {
        var grid = qs('#umUsersGrid');
        if (!grid) return;
        grid.innerHTML = '<div class="um-loading-state"><i class="fa-solid fa-circle-notch fa-spin"></i> Loading users…</div>';

        fetch('/api/admin/users', { credentials: 'include' })
            .then(function(r) { return r.json(); })
            .then(function(users) {
                allUsersCache = Array.isArray(users) ? users : [];
                renderUserCards(allUsersCache);
            })
            .catch(function() {
                grid.innerHTML = '<div class="um-empty-state"><i class="fa-solid fa-triangle-exclamation"></i><p>Failed to load users. Please try again.</p></div>';
            });
    }

    function renderUserCards(users) {
        var grid     = qs('#umUsersGrid');
        var countEl  = qs('#umUserCount');
        if (!grid) return;
        if (countEl) countEl.textContent = users.length + ' user' + (users.length === 1 ? '' : 's');

        if (!users.length) {
            grid.innerHTML = '<div class="um-empty-state"><i class="fa-solid fa-users-slash"></i><p>No admin accounts found.</p></div>';
            return;
        }

        grid.innerHTML = users.map(function(u) {
            var isSelf = (currentUserId && parseInt(u.id) === parseInt(currentUserId));
            return '<div class="um-user-card" data-user-id="' + esc(u.id) + '" data-username="' + esc(u.username) + '" data-email="' + esc(u.email) + '">' +
                '<div class="um-user-card__top">' +
                    '<div class="um-avatar-sm">' + initial(u.username) + '</div>' +
                    '<div style="flex:1;min-width:0;">' +
                        '<p class="um-user-card__name">' + esc(u.username) + '</p>' +
                        '<p class="um-user-card__email">' + esc(u.email || '—') + '</p>' +
                    '</div>' +
                '</div>' +
                '<div class="um-user-card__meta">' +
                    '<span class="um-user-card__joined"><i class="fa-regular fa-calendar" style="margin-right:4px;"></i>' + fmtDate(u.created_at) + '</span>' +
                    (isSelf ? '<span class="um-user-card__badge um-user-card__badge--you">You</span>' : '<span class="um-user-card__badge">Admin</span>') +
                '</div>' +
                '<div class="um-user-card__actions">' +
                    (!isSelf
                        ? '<button class="um-btn um-btn--danger um-btn--sm um-del-btn" data-id="' + esc(u.id) + '" data-name="' + esc(u.username) + '">' +
                              '<i class="fa-solid fa-trash-can"></i> Delete' +
                          '</button>' +
                          '<div class="um-user-card__confirm" id="umConfirm-' + esc(u.id) + '">' +
                              '<span>Confirm delete?</span>' +
                              '<button class="um-btn um-btn--danger-solid um-btn--sm um-confirm-del-btn" data-id="' + esc(u.id) + '">Yes, Delete</button>' +
                              '<button class="um-btn um-btn--ghost um-btn--sm um-cancel-del-btn" data-id="' + esc(u.id) + '">Cancel</button>' +
                          '</div>'
                        : '<span style="font-size:11px;color:#555;">Cannot delete your own session account.</span>'
                    ) +
                '</div>' +
            '</div>';
        }).join('');

        /* Attach delete handlers */
        qsa('.um-del-btn', grid).forEach(function(btn) {
            btn.addEventListener('click', function() {
                var id = this.dataset.id;
                var confirmEl = qs('#umConfirm-' + id, grid);
                if (confirmEl) { confirmEl.classList.add('visible'); this.style.display = 'none'; }
            });
        });
        qsa('.um-cancel-del-btn', grid).forEach(function(btn) {
            btn.addEventListener('click', function() {
                var id = this.dataset.id;
                var confirmEl = qs('#umConfirm-' + id, grid);
                if (confirmEl) confirmEl.classList.remove('visible');
                var delBtn = grid.querySelector('.um-del-btn[data-id="' + id + '"]');
                if (delBtn) delBtn.style.display = '';
            });
        });
        qsa('.um-confirm-del-btn', grid).forEach(function(btn) {
            btn.addEventListener('click', function() {
                var id   = this.dataset.id;
                var card = grid.querySelector('[data-user-id="' + id + '"]');
                this.disabled = true;
                this.textContent = 'Deleting…';

                fetch('/api/admin/users/' + id, { method: 'DELETE', credentials: 'include' })
                    .then(function(r) { return r.json(); })
                    .then(function(data) {
                        if (data.success) {
                            if (card) { card.style.opacity = '0'; card.style.transform = 'scale(0.95)'; card.style.transition = 'all 0.25s'; setTimeout(function() { card.remove(); updateCount(); }, 250); }
                        } else {
                            window.notificationService.showError(data.message || 'Could not delete user.');
                        }
                    })
                    .catch(function() { window.notificationService.showError('Network error. Please try again.'); });
            });
        });
    }

    function updateCount() {
        var grid    = qs('#umUsersGrid');
        var countEl = qs('#umUserCount');
        if (!grid || !countEl) return;
        var remaining = grid.querySelectorAll('.um-user-card').length;
        countEl.textContent = remaining + ' user' + (remaining === 1 ? '' : 's');
    }

    function filterCards(query) {
        var grid = qs('#umUsersGrid');
        if (!grid) return;
        var cards = qsa('.um-user-card', grid);
        var visible = 0;
        cards.forEach(function(card) {
            var uname = (card.dataset.username || '').toLowerCase();
            var email = (card.dataset.email || '').toLowerCase();
            var matches = !query || uname.includes(query) || email.includes(query);
            card.style.display = matches ? '' : 'none';
            if (matches) visible++;
        });
        var countEl = qs('#umUserCount');
        if (countEl) countEl.textContent = visible + ' user' + (visible === 1 ? '' : 's') + (query ? ' found' : '');
    }

    /* ================================================================
       EMAIL LOGS MODULE (Advanced: Search, Sort, Filter, Page)
    ================================================================ */
    let logState = {
        page: 1,
        limit: 15,
        search: '',
        status: '',
        trigger: '',
        sort: 'sent_at',
        order: 'DESC'
    };
    let logSearchTimer;

    window.loadEmailLogs = async function() {
        const body = qs('#emailLogsBody');
        const empty = qs('#emailLogsEmpty');
        const stats = qs('#logStats');
        const pagination = qs('#logPagination');
        if (!body) return;

        body.innerHTML = `<tr><td colspan="5" class="text-center" style="padding: 40px; border:none; opacity: 0.5;"><i class="fa fa-spinner fa-spin" style="margin-right: 10px;"></i> Fetching logs...</td></tr>`;

        try {
            const query = new URLSearchParams(logState).toString();
            const response = await fetch(`/api/admin/email-logs?${query}`, { credentials: 'include' });
            
            if (response.status === 401) {
                if (body) body.innerHTML = '<tr><td colspan="5" class="text-center text-danger">Unauthorized. Redirecting to login...</td></tr>';
                setTimeout(() => window.location.reload(), 2000);
                return;
            }

            const res = await response.json();
            
            if (res && res.success) {
                body.innerHTML = '';
                updateSortIcons();

                if (!res.logs || res.logs.length === 0) {
                    empty.style.display = 'block';
                    stats.textContent = 'Showing 0 logs';
                    pagination.innerHTML = '';
                    return;
                }
                
                empty.style.display = 'none';
                res.logs.forEach(log => {
                    const tr = document.createElement('tr');
                    tr.style.background = 'rgba(255,255,255,0.03)';
                    tr.style.transition = '0.2s';
                    tr.onmouseover = () => tr.style.background = 'rgba(255,255,255,0.06)';
                    tr.onmouseout = () => tr.style.background = 'rgba(255,255,255,0.03)';
                    
                    const date = new Date(log.sent_at).toLocaleString();
                    const statusClass = log.status === 'success' ? 'text-success' : (log.status === 'pending' ? 'text-warning' : 'text-danger');
                    const triggerIcon = (log.trigger_event||'').includes('Newsletter') ? 'fa-envelopes-bulk' : 
                                       (log.trigger_event||'').includes('Booking') ? 'fa-calendar-check' : 
                                       (log.trigger_event||'').includes('Admin') ? 'fa-user-shield' : 'fa-paper-plane';

                    const escape = (str) => {
                        const div = document.createElement('div');
                        div.textContent = str || '';
                        return div.innerHTML;
                    };

                    tr.innerHTML = `
                        <td style="padding: 15px; border:none; font-size: 13px; color: #aaa;">${escape(date)}</td>
                        <td style="padding: 15px; border:none; font-weight: 500;">${escape(log.recipient_email)}</td>
                        <td style="padding: 15px; border:none; color: #ddd;">${escape(log.subject)}</td>
                        <td style="padding: 15px; border:none; font-size: 12px;"><i class="fa-solid ${triggerIcon}" style="margin-right:6px; opacity:0.6;"></i>${escape(log.trigger_event)}</td>
                        <td style="padding: 15px; border:none;"><span class="${statusClass}" style="font-weight:bold; text-transform:uppercase; font-size:11px;"><i class="fa-solid ${log.status === 'success' ? 'fa-check-circle' : (log.status === 'pending' ? 'fa-clock' : 'fa-circle-xmark')}" style="margin-right:4px;"></i>${escape(log.status)}</span></td>
                    `;
                    body.appendChild(tr);
                });

                // Update Stats
                const total = parseInt(res.total) || 0;
                const pageNum = parseInt(res.page) || logState.page;
                const limitNum = parseInt(logState.limit) || 15;
                const startNum = total === 0 ? 0 : (pageNum - 1) * limitNum + 1;
                const endNum = Math.min(pageNum * limitNum, total);
                
                
                if (stats) stats.textContent = `Showing ${startNum}-${endNum} of ${total} logs`;

                // Update Pagination
                renderLogPagination(parseInt(res.totalPages) || 0);
            }
        } catch (e) {
            console.error("❌ Failed to load email logs:", e);
            const bodyErr = window.qs('#emailLogsBody');
            if (bodyErr) bodyErr.innerHTML = '<tr><td colspan="6" class="text-center text-danger" style="padding:20px;">Failed to load logs. Session may have expired.</td></tr>';
        }
    }

    function renderLogPagination(totalPages) {
        const container = qs('#logPagination');
        if (!container) return;
        container.innerHTML = '';

        if (totalPages <= 1) return;

        // Prev
        const prevBtn = document.createElement('button');
        prevBtn.className = `um-btn um-btn--ghost ${logState.page === 1 ? 'disabled' : ''}`;
        prevBtn.innerHTML = '<i class="fa fa-chevron-left"></i>';
        prevBtn.onclick = () => { if (logState.page > 1) { logState.page--; window.loadEmailLogs(); } };
        container.appendChild(prevBtn);

        // Simple page numbers
        for (let i = 1; i <= totalPages; i++) {
            if (i > 5 && i < totalPages) { // Simple ellipsis logic
                if (i === 6) {
                    const span = document.createElement('span');
                    span.textContent = '...';
                    span.style.color = '#555';
                    container.appendChild(span);
                }
                continue;
            }
            const btn = document.createElement('button');
            btn.className = `um-btn ${logState.page === i ? 'um-btn--primary' : 'um-btn--ghost'}`;
            btn.textContent = i;
            btn.onclick = () => { logState.page = i; window.loadEmailLogs(); };
            container.appendChild(btn);
        }

        // Next
        const nextBtn = document.createElement('button');
        nextBtn.className = `um-btn um-btn--ghost ${logState.page === totalPages ? 'disabled' : ''}`;
        nextBtn.innerHTML = '<i class="fa fa-chevron-right"></i>';
        nextBtn.onclick = () => { if (logState.page < totalPages) { logState.page++; window.loadEmailLogs(); } };
        container.appendChild(nextBtn);
    }

    window.toggleLogSort = function(col) {
        if (logState.sort === col) {
            logState.order = logState.order === 'ASC' ? 'DESC' : 'ASC';
        } else {
            logState.sort = col;
            logState.order = 'DESC';
        }
        logState.page = 1;
        loadEmailLogs();
    }

    function updateSortIcons() {
        qsa('#logSortHeaders i').forEach(icon => {
            icon.className = 'fa-solid fa-sort';
            icon.style.opacity = '0.3';
        });
        const activeIcon = qs(`#sort-${logState.sort}`);
        if (activeIcon) {
            activeIcon.className = logState.order === 'ASC' ? 'fa-solid fa-sort-up' : 'fa-solid fa-sort-down';
            activeIcon.style.opacity = '1';
        }
    }

    window.applyLogFilters = function() {
        logState.status = qs('#logStatusFilter').value;
        logState.trigger = qs('#logTriggerFilter').value;
        logState.page = 1;
        loadEmailLogs();
    }

    window.debounceLogSearch = function() {
        clearTimeout(logSearchTimer);
        logSearchTimer = setTimeout(() => {
            logState.search = qs('#logSearch').value;
            logState.page = 1;
            loadEmailLogs();
        }, 400);
    }

    function initEmailLogs() {
        // Bootstrap tab event
        if (typeof $ !== 'undefined') {
            $('a[href="#emailLogsAdmin"]').on('shown.bs.tab shown', function() {
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
            $('a[href="#usersAdmin"]').on('shown.bs.tab shown', function() {
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
