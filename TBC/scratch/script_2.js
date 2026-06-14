
        document.addEventListener("DOMContentLoaded", function(event) {
            // Restore last active section (scroll position is always top; no restore needed)
            var activeSection = sessionStorage.getItem('admin_active_section') || sessionStorage.getItem('admin_active_tab');
            if (activeSection) {
                activeSection = activeSection.replace('#', '');
                // Defer until after auth check shows the dashboard wrapper
                setTimeout(function() {
                    if (typeof switchTab === 'function' && document.getElementById(activeSection)) {
                        switchTab(activeSection);
                    }
                }, 600);
            }
        });

        // ==========================================
        // Authentication Logic
        // ==========================================
        document.addEventListener("DOMContentLoaded", async function() {
            // Check session
            try {
                const response = await fetch('/api/admin/session', {
                    credentials: 'include',
                    headers: { 'ngrok-skip-browser-warning': 'true' }
                });
                
                const responseText = await response.text();
                let result;
                try {
                    result = JSON.parse(responseText);
                } catch(e) {
                    console.error("Session parse error. Server returned:", responseText.substring(0, 50));
                    result = { success: false };
                }

                if (result.success) {
                    // Authenticated
                    document.getElementById('loginSection').style.display = 'none';
                    document.getElementById('dashboardSection').style.display = 'flex';
                    document.body.classList.remove('login-state-active');
                    const adminHeader = document.getElementById('adminHeader');
                    if(adminHeader) adminHeader.style.display = 'block';
                    const navArrows = document.querySelector('.admin-nav-arrows');
                    if(navArrows) navArrows.style.display = '';
                    const adminFooter = document.getElementById('adminFooter');
                    if(adminFooter) adminFooter.style.display = 'block';
                    
                    // Trigger data loads here
                    if (typeof fetchHomeSlider === 'function') fetchHomeSlider();
                    loadAboutData();
                    loadSocialData();
                    renderEventsList();
                    // renderCareerList(); // Remove crashing undefined function call
                    loadContactData();
                    loadInquiries();
                    loadBookings();
                    loadHighlights();
                    loadGallery();
                    if (window.applyAdminBackgrounds) window.applyAdminBackgrounds();

                    // Force password change on first login
                    if (sessionStorage.getItem('admin_force_password_change') === '1') {
                        const overlay = document.getElementById('forcePasswordChangeOverlay');
                        if (overlay) overlay.style.display = 'flex';
                    }

                } else {
                    // Not Authenticated
                    const adminHeader = document.getElementById('adminHeader');
                    if(adminHeader) adminHeader.style.display = 'none';
                    document.getElementById('dashboardSection').style.display = 'none';
                    document.getElementById('loginSection').style.display = 'block';
                    document.body.classList.add('login-state-active');
                    const navArrows = document.querySelector('.admin-nav-arrows');
                    if(navArrows) navArrows.style.display = 'none';
                    const adminFooter = document.getElementById('adminFooter');
                    if(adminFooter) adminFooter.style.display = 'none';

                    if (window.applyAdminBackgrounds) window.applyAdminBackgrounds();
                }
            } catch (error) {
                console.error("Auth check failed", error);
                const adminHeader = document.getElementById('adminHeader');
                if(adminHeader) adminHeader.style.display = 'none';
                document.getElementById('dashboardSection').style.display = 'none'; // Ensure dashboard stays hidden
                document.getElementById('loginError').innerText = "Unable to connect to server.";
                document.getElementById('loginError').style.display = 'block';
                document.getElementById('loginSection').style.display = 'block';
                document.body.classList.add('login-state-active');
                const navArrows = document.querySelector('.admin-nav-arrows');
                if(navArrows) navArrows.style.display = 'none';
                document.getElementById('adminFooter').style.display = 'none';
                if (window.applyAdminBackgrounds) window.applyAdminBackgrounds();
            }
        });

        // Render footer social icons and show footer after successful login

        // Handle Login Submission
        document.getElementById('adminLoginForm').addEventListener('submit', async function(e) {
            e.preventDefault();
            const btn = document.getElementById('loginBtn');
            const errorDiv = document.getElementById('loginError');
            
            btn.disabled = true;
            btn.innerText = 'Authenticating...';
            errorDiv.style.display = 'none';

            try {
                const response = await fetch('/api/admin/login', {
                    method: 'POST',
                    credentials: 'include',
                    headers: { 
                        'Content-Type': 'application/json',
                        'ngrok-skip-browser-warning': 'true'
                    },
                    body: JSON.stringify({
                        username: document.getElementById('adminUsername').value.trim(),
                        password: document.getElementById('adminPassword').value
                    })
                });
                
                const responseText = await response.text();
                let result;
                try {
                    result = JSON.parse(responseText);
                } catch (parseError) {
                    throw new Error(`Server returned unexpected response. Please ensure the server is running.`);
                }

                if (result.success) {
                    btn.innerText = 'COME THROUGH...';
                    if (result.must_change_password) {
                        sessionStorage.setItem('admin_force_password_change', '1');
                    }

                    // Activate dashboard in-place — no reload needed; session cookie is already set.
                    document.getElementById('loginSection').style.display = 'none';
                    document.getElementById('dashboardSection').style.display = 'flex';
                    document.body.classList.remove('login-state-active');
                    const _adminHeader = document.getElementById('adminHeader');
                    if (_adminHeader) _adminHeader.style.display = 'block';
                    const _navArrows = document.querySelector('.admin-nav-arrows');
                    if (_navArrows) _navArrows.style.display = '';
                    const _adminFooter = document.getElementById('adminFooter');
                    if (_adminFooter) _adminFooter.style.display = 'block';

                    if (typeof fetchHomeSlider === 'function') fetchHomeSlider();
                    loadAboutData();
                    loadSocialData();
                    renderEventsList();
                    loadContactData();
                    loadInquiries();
                    loadBookings();
                    loadHighlights();
                    loadGallery();
                    if (window.applyAdminBackgrounds) window.applyAdminBackgrounds();

                    if (sessionStorage.getItem('admin_force_password_change') === '1') {
                        const overlay = document.getElementById('forcePasswordChangeOverlay');
                        if (overlay) overlay.style.display = 'flex';
                    }
                } else {
                    errorDiv.innerText = result.message || "Invalid credentials. Please try again.";
                    errorDiv.style.display = 'block';
                    btn.innerText = 'Login';
                    btn.disabled = false;
                }
            } catch (error) {
                console.error("Login fetch error:", error);
                errorDiv.innerText = "Connection error. Please check that the server is running at port 3000.";
                errorDiv.style.display = 'block';
                btn.innerText = 'Login';
                btn.disabled = false;
            }
        });

        // Handle Logout
        document.getElementById('logoutBtn').addEventListener('click', async function(e) {
            e.preventDefault();
            try {
                await fetch('/api/admin/logout', { method: 'POST' });
                window.location.reload();
            } catch (error) {
                console.error("Logout error", error);
            }
        });

        // ==========================================
        // Inactivity Timeout Logic
        // ==========================================
        (function() {
            let inactivityTimeout;
            const TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

            async function autoLogout() {
                // Only act if user is on the dashboard (logged in)
                if (document.getElementById('dashboardSection').style.display === 'flex') {
                    try {
                        await fetch('/api/admin/logout', { method: 'POST' });
                        window.notificationService.showInfo("You have been logged out due to inactivity.");
                        window.location.reload();
                    } catch (error) {
                        console.error("Auto logout error", error);
                        window.location.reload();
                    }
                }
            }

            function resetTimer() {
                clearTimeout(inactivityTimeout);
                inactivityTimeout = setTimeout(autoLogout, TIMEOUT_MS);
            }

            // Attach event listeners to reset the timer on activity
            window.onload = resetTimer;
            document.onmousemove = resetTimer;
            document.onkeydown = resetTimer;
            document.onclick = resetTimer;
            document.onscroll = resetTimer;
        })();

        // ==========================================
        // 13. User Management
        // ==========================================
        async function loadUsers() {
            const data = await apiCall('/api/admin/users');
            const container = document.getElementById('usersListContainer');
            if(!container) return; // Fallback check
            container.innerHTML = '';
            
            if (data.error || data.success === false) {
                container.innerHTML = `<div class="alert alert-danger">Failed to load users: ${data.message || data.error || 'Unauthorized'}</div>`;
                return;
            }
            if (!Array.isArray(data) || data.length === 0) {
                container.innerHTML = '<div class="text-center text-muted" style="padding: 20px;">No users found.</div>';
                return;
            }
            
            data.forEach(user => {
                const dateStr = new Date(user.created_at).toLocaleString();
                const initial = (user.username && user.username.length > 0) ? user.username.charAt(0).toUpperCase() : 'U';
                container.innerHTML += `
                <div class="embed-list-item" style="display:flex; justify-content:space-between; align-items:center; padding: 12px; background: #1a1a1a; border-radius: 8px; margin-bottom: 12px; border: 1px solid #333; transition: background 0.2s;">
                    <div style="display:flex; gap:16px; align-items:center; flex: 1; overflow: hidden;">
                        <div style="width:40px; height:40px; border-radius:50%; background:#222; border: 1px solid #444; color:#D4AF37; display:flex; justify-content:center; align-items:center; font-size:18px; font-weight:bold; flex-shrink:0;">
                            ${initial}
                        </div>
                        <div style="display: flex; flex-direction: column; justify-content: center; flex: 1;">
                            <strong style="font-size: 15px; color: #f1f1f1; margin-bottom: 4px;">${user.username} <span style="color:#aaa; font-weight:normal; font-size:12px;">(ID: ${user.id})</span></strong>
                            <div style="font-size:13px; color:#aaa;">${user.email || 'No email provided'} &nbsp;&bull;&nbsp; Created: ${dateStr}</div>
                        </div>
                    </div>
                    <div style="position:relative; padding-left: 15px;">
                        <div class="dropdown">
                            <button class="btn btn-link dropdown-toggle embed-kebab-btn" type="button" data-toggle="dropdown" aria-haspopup="true" aria-expanded="true" style="color: #ccc; font-size: 18px; text-decoration: none; padding: 5px 10px; border: none; outline: none;">
                                <i class="fa-solid fa-ellipsis-vertical"></i>
                            </button>
                            <ul class="dropdown-menu dropdown-menu-right" style="background: #282828; border: 1px solid #444; box-shadow: 0 4px 12px rgba(0,0,0,0.5); min-width: 120px;">
                                <li><a href="#" onclick="editUser(${user.id}, '${user.username.replace(/'/g, "\\'")}', '${(user.email || '').replace(/'/g, "\\'")}')" style="color: #fff; padding: 8px 20px;"><i class="fa-solid fa-pencil" style="margin-right: 12px; color: #D4AF37;"></i>Edit User</a></li>
                                <li class="divider" style="background-color: #444; margin: 4px 0;"></li>
                                <li><a href="#" onclick="deleteUser(${user.id})" style="color: #ff4d4d; padding: 8px 20px;"><i class="fa-solid fa-trash" style="margin-right: 12px;"></i>Delete User</a></li>
                            </ul>
                        </div>
                    </div>
                </div>`;
            });
        }

        document.getElementById('userAdminForm').addEventListener('submit', async function(e) {
            e.preventDefault();
            const id = document.getElementById('userId').value;
            const username = document.getElementById('userUsername').value;
            const email = document.getElementById('userEmail').value;
            const password = document.getElementById('userPassword').value;

            const url = id ? `/api/admin/users/${id}` : '/api/admin/users';
            const method = id ? 'PUT' : 'POST';

            const result = await apiCall(url, method, { username, email, password });
            if (result.success) {
                window.notificationService.showSuccess(result.message);
                document.getElementById('userAdminForm').reset();
                document.getElementById('userId').value = '';
                document.getElementById('userFormTitle').innerText = 'Add New System User';
                document.getElementById('userCancelBtn').style.display = 'none';
                document.getElementById('userSubmitBtn').innerText = 'Save User';
                loadUsers();
            } else {
                window.notificationService.showError(result.message || result.error || "Failed to save user.");
            }
        });

        window.editUser = function(id, username, email) {
            document.getElementById('userId').value = id;
            document.getElementById('userUsername').value = username;
            document.getElementById('userEmail').value = email;
            document.getElementById('userPassword').value = ''; // Don't prefill password
            document.getElementById('userFormTitle').innerText = 'Edit System User';
            document.getElementById('userSubmitBtn').innerText = 'Update User';
            document.getElementById('userCancelBtn').style.display = 'block';
            window.scrollTo(0, 0); // scroll to top to see form
        };

        document.getElementById('userCancelBtn').addEventListener('click', function() {
            document.getElementById('userAdminForm').reset();
            document.getElementById('userId').value = '';
            document.getElementById('userFormTitle').innerText = 'Add New System User';
            document.getElementById('userSubmitBtn').innerText = 'Save User';
            this.style.display = 'none';
        });

        window.deleteUser = async function(id) {
            if (await window.notificationService.showConfirm({ 
                title: "Delete User",
                message: "Are you sure you want to delete this user? This cannot be undone.", 
                isDestructive: true 
            })) {
                const result = await apiCall(`/api/admin/users/${id}`, 'DELETE');
                if (result.success) {
                    loadUsers();
                } else {
                    window.notificationService.showError(result.message || result.error || "Failed to delete user.");
                }
            }
        };

        // Add reload trigger for User Management Panel
        $('a[href="#usersAdmin"]').on('shown.bs.tab', function (e) {
            loadUsers();
        });

        window.onbeforeunload = function(e) {
            sessionStorage.setItem('admin_scrollpos', window.scrollY);
        };
    