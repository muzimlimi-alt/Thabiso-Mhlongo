
(function() {
    'use strict';

    /* ---- Helpers ---- */
    function qs(sel) { return document.querySelector(sel); }
    function qsa(sel) { return document.querySelectorAll(sel); }
    /* ---- Sidebar & Mobile Nav ---- */
    const sidebar = qs('#tmAdminSidebar');
    const overlay = qs('#tmSidebarOverlay');
    const toggleBtn = qs('#tmSidebarToggle');
    const mobileOpenBtn = qs('#tmMobileAdminOpen');

    function toggleSidebar() {
        if (!sidebar) return;
        var isLocked = sidebar.dataset.locked === '1';
        var mainEl = qs('.tm-admin-main');

        if (isLocked) {
            sidebar.dataset.locked = '0';
            sidebar.classList.add('collapsed');
            if (mainEl) mainEl.style.paddingLeft = '';
        } else {
            sidebar.dataset.locked = '1';
            sidebar.classList.remove('collapsed');
            if (mainEl && window.innerWidth >= 769) {
                mainEl.style.paddingLeft = 'calc(var(--sidebar-width-expanded) + 20px)';
            }
        }

        try { sessionStorage.setItem('admin_sidebar_locked', isLocked ? '0' : '1'); } catch(e) {}
    }

    function openMobileSidebar() {
        if (!sidebar || !overlay) return;
        sidebar.classList.add('mobile-open');
        overlay.classList.add('active');
        overlay.classList.add('show'); // Support both classes
        document.body.style.overflow = 'hidden'; 
    }

    function closeMobileSidebar() {
        if (!sidebar || !overlay) return;
        sidebar.classList.remove('mobile-open');
        overlay.classList.remove('active');
        overlay.classList.remove('show');
        document.body.style.overflow = '';
    }

    if (toggleBtn) toggleBtn.addEventListener('click', toggleSidebar);

    // Restore sidebar locked state across page navigations
    (function() {
        var locked = '';
        try { locked = sessionStorage.getItem('admin_sidebar_locked'); } catch(e) {}
        if (locked === '1' && sidebar) {
            sidebar.dataset.locked = '1';
            sidebar.classList.remove('collapsed');
            var mainEl = qs('.tm-admin-main');
            if (mainEl) mainEl.style.paddingLeft = 'calc(var(--sidebar-width-expanded) + 20px)';
        }
    })();

    if (mobileOpenBtn) mobileOpenBtn.addEventListener('click', openMobileSidebar);
    if (overlay) overlay.addEventListener('click', function() {
        closeMobileSidebar();
        closeAllDropdowns(null);
    });

    // Close on nav link click (mobile)
    qsa('.admin-sidebar a').forEach(function(link) {
        link.addEventListener('click', function() {
            if (window.innerWidth <= 768) closeMobileSidebar();
        });
    });

    function timeAgo(dateStr) {
        if (!dateStr) return '';
        const d = new Date(dateStr);
        if (isNaN(d)) return '';
        const diff = Math.floor((Date.now() - d) / 1000);
        if (diff < 60) return 'Just now';
        if (diff < 3600) return Math.floor(diff/60) + 'm ago';
        if (diff < 86400) return Math.floor(diff/3600) + 'h ago';
        return Math.floor(diff/86400) + 'd ago';
    }

    /* ---- Dropdown manager ---- */
    const dropdowns = [
        { trigger: 'admCreateTrigger', menu: 'admCreateMenu', wrapper: 'admCreateDropdown' },
        { trigger: 'admNotiTrigger',   menu: 'admNotiMenu',   wrapper: 'admNotiDropdown' },
        { trigger: 'admProfileTrigger',menu: 'admProfileMenu', wrapper: 'admProfileDropdown' },
    ];

    function closeAllDropdowns(except) {
        dropdowns.forEach(function(d) {
            if (d.wrapper === except) return;
            var t = qs('#' + d.trigger);
            var m = qs('#' + d.menu);
            if (t) t.setAttribute('aria-expanded', 'false');
            if (m) m.classList.remove('open');
        });
    }

    dropdowns.forEach(function(d) {
        var trigger = qs('#' + d.trigger);
        var menu    = qs('#' + d.menu);
        if (!trigger || !menu) return;

        trigger.addEventListener('click', function(e) {
            e.stopPropagation();
            var isOpen = menu.classList.contains('open');
            closeAllDropdowns(d.wrapper);
            if (isOpen) {
                menu.classList.remove('open');
                trigger.setAttribute('aria-expanded', 'false');
            } else {
                menu.classList.add('open');
                trigger.setAttribute('aria-expanded', 'true');
            }
        });
    });

    // Close on outside click
    document.addEventListener('click', function() {
        closeAllDropdowns(null);
    });

    /* ---- Logout shortcut ---- */
    var admLogoutBtn = qs('#admLogoutBtn');
    if (admLogoutBtn) {
        admLogoutBtn.addEventListener('click', function() {
            // Delegate to existing sidebar logout
            var existingLogout = qs('#logoutBtn');
            if (existingLogout) { existingLogout.click(); }
            else {
                fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' })
                    .finally(function() { location.reload(); });
            }
        });
    }

    /* ---- Create shortcuts ---- */
    /* ------------------------------------------------------------------
       switchTab / switchSection — custom section navigation
       Replaces Bootstrap tab system so scroll is 100% predictable.
       The main content div (.tm-admin-main) is the scroll container;
       scrollTop on it always works, regardless of scroll-behavior on html.
    ------------------------------------------------------------------ */
    window.switchTab = function(sectionId) {
        // Hide every main section panel
        qsa('.admin-section').forEach(function(s) {
            s.style.display = 'none';
        });

        // Show the requested section
        var target = qs('#' + sectionId);
        if (target) {
            target.style.display = 'block';
        }

        // Scroll the content container to top — works even with scroll-behavior:smooth on html
        var mainEl = qs('.tm-admin-main');
        if (mainEl) mainEl.scrollTop = 0;

        // Update breadcrumb & active sidebar state
        if (typeof updateBreadcrumb === 'function') updateBreadcrumb(sectionId);

        var items = qsa('.admin-sidebar li');
        items.forEach(function(li) { li.classList.remove('active'); });
        var activeLink = qs('.admin-sidebar a[href="#' + sectionId + '"]');
        if (activeLink && activeLink.parentElement) {
            activeLink.parentElement.classList.add('active');
        }

        // Persist active section so page-refresh restores it
        try { sessionStorage.setItem('admin_active_section', sectionId); } catch(e) {}

        // Init calendar lazily
        if (sectionId === 'calendarAdmin' && typeof initAdminCalendar === 'function') {
            initAdminCalendar();
        }

        // Fire synthetic shown.bs.tab on the sidebar link so that data-loader
        // handlers registered elsewhere (loadEmailLogs, loadFinancialStats, etc.)
        // still trigger without requiring changes throughout the codebase.
        if (activeLink && typeof $ !== 'undefined') {
            $(activeLink).trigger({ type: 'shown.bs.tab', target: activeLink });
        }

        if (typeof closeAllDropdowns === 'function') closeAllDropdowns(null);
    };

    var admNewBooking = qs('#admNewBooking');
    if (admNewBooking) { admNewBooking.addEventListener('click', function() { switchTab('bookingsAdmin'); }); }

    var admNewInquiry = qs('#admNewInquiry');
    if (admNewInquiry) {
        admNewInquiry.addEventListener('click', function() {
            switchTab('inquiriesAdmin');
            // Trigger compose if button exists
            setTimeout(function() {
                var composeBtn = qs('.inq-compose-btn');
                if (composeBtn) composeBtn.click();
            }, 300);
        });
    }

    var admNewEvent = qs('#admNewEvent');
    if (admNewEvent) { admNewEvent.addEventListener('click', function() { switchTab('eventsAdmin'); }); }

    /* ---- Breadcrumb updater ---- */
    var sectionMap = {
        dashboardAdmin:   { label: 'Dashboard',        icon: 'fa-gauge-high' },
        homeAdmin:        { label: 'Home Slider',       icon: 'fa-images' },
        aboutAdmin:       { label: 'About Me',          icon: 'fa-user-astronaut' },
        careerAdmin:      { label: 'Career',            icon: 'fa-star' },
        galleryAdmin:     { label: 'Gallery',           icon: 'fa-image' },
        socialAdmin:      { label: 'Socials',           icon: 'fa-share-nodes' },
        eventsAdmin:      { label: 'Events',            icon: 'fa-calendar-days' },
        contactAdmin:     { label: 'Contact',           icon: 'fa-address-book' },
        inquiriesAdmin:   { label: 'Inquiries',         icon: 'fa-envelope-open-text' },
        bookingsAdmin:    { label: 'Bookings',          icon: 'fa-calendar-check' },
        calendarAdmin:    { label: 'Calendar',          icon: 'fa-calendar-days' },
        newsletterAdmin:  { label: 'Newsletter',        icon: 'fa-envelopes-bulk' },
        emailLogsAdmin:   { label: 'System Logs',       icon: 'fa-clock-rotate-left' },
        securityAdmin:    { label: 'Security & Audit',  icon: 'fa-shield-halved' },
        preferencesAdmin: { label: 'Preferences',       icon: 'fa-paint-roller' },
        usersAdmin:       { label: 'User Management',   icon: 'fa-users-gear' },
    };

    function updateBreadcrumb(tabId) {
        var bc = qs('#admBreadcrumb');
        if (!bc) return;
        var info = sectionMap[tabId];
        if (!info) return;
        if (tabId === 'dashboardAdmin') {
            bc.innerHTML = '<span class="adm-breadcrumb__root"><i class="fa-solid fa-gauge-high" aria-hidden="true"></i><span>Dashboard</span></span>';
        } else {
            bc.innerHTML =
                '<span class="adm-breadcrumb__root"><i class="fa-solid fa-gauge-high" aria-hidden="true"></i><span>Dashboard</span></span>' +
                '<i class="fa-solid fa-chevron-right adm-breadcrumb__sep" aria-hidden="true"></i>' +
                '<span class="adm-breadcrumb__current"><i class="fa-solid ' + info.icon + '" style="margin-right:5px;" aria-hidden="true"></i>' + info.label + '</span>';
        }
    }

    // Sidebar navigation — intercept .tm-nav-link clicks, delegate to switchTab()
    document.addEventListener('click', function(e) {
        var link = e.target.closest('.admin-sidebar .tm-nav-link');
        if (!link) return;
        var href = link.getAttribute('href') || '';
        var sectionId = href.replace('#', '');
        if (sectionId && qs('#' + sectionId + '.admin-section')) {
            e.preventDefault();
            switchTab(sectionId);
        }
    });

    /* ---- Profile display ---- */
    function updateProfileDisplay() {
        fetch('/api/auth/session', { credentials: 'same-origin' })
            .then(function(r) { return r.ok ? r.json() : null; })
            .then(function(data) {
                if (!data || !data.username) return;
                var name = data.username;
                var initial = name.charAt(0).toUpperCase();
                var avatarEls = qsa('.adm-avatar');
                avatarEls.forEach(function(el) { el.textContent = initial; });
                var nameEl = qs('#admProfileName');
                if (nameEl) nameEl.textContent = name;
                var cardName = qs('#admProfileCardName');
                if (cardName) cardName.textContent = name;
            })
            .catch(function() {});
    }

    // Try to read username from existing session state
    setTimeout(function() {
        // Try existing global variable if set by auth code
        if (typeof currentAdminUser !== 'undefined' && currentAdminUser) {
            var name = currentAdminUser.username || currentAdminUser;
            var initial = String(name).charAt(0).toUpperCase();
            qsa('.adm-avatar').forEach(function(el) { el.textContent = initial; });
            var nameEl = qs('#admProfileName');
            if (nameEl) nameEl.textContent = name;
            var cardName = qs('#admProfileCardName');
            if (cardName) cardName.textContent = name;
        } else {
            updateProfileDisplay();
        }
    }, 800);

    /* ---- Unified Calendar Logic ---- */
    let adminCalendar = null;

    function showCalEventPopup(info) {
        var props = info.event.extendedProps;
        var existing = document.getElementById('calEventPopup');
        if (existing) existing.remove();

        var rect = info.el.getBoundingClientRect();
        var popup = document.createElement('div');
        popup.id = 'calEventPopup';
        popup.style.cssText = 'position:fixed;z-index:9999;background:#1a1a1a;border:1px solid #333;border-radius:10px;padding:18px 20px;min-width:260px;max-width:320px;box-shadow:0 8px 30px rgba(0,0,0,0.6);';
        popup.style.top = Math.min(rect.bottom + 6, window.innerHeight - 220) + 'px';
        popup.style.left = Math.min(rect.left, window.innerWidth - 340) + 'px';

        if (props.type === 'booking') {
            var statusColor = props.status === 'CONFIRMED' ? '#D4AF37' : props.status === 'PENDING' ? '#aaa' : '#8a6d3b';
            popup.innerHTML = '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">' +
                '<strong style="color:#D4AF37;font-size:14px;"><i class="fa-solid fa-calendar-check"></i> Booking</strong>' +
                '<button onclick="document.getElementById(\'calEventPopup\').remove()" style="background:none;border:none;color:#666;font-size:16px;cursor:pointer;">&times;</button>' +
                '</div>' +
                '<div style="font-size:13px;line-height:1.8;color:#ccc;">' +
                '<div><strong style="color:#fff;">' + info.event.title + '</strong></div>' +
                '<div>Date: ' + (info.event.startStr || '').split('T')[0] + '</div>' +
                '<div>Status: <span style="color:' + statusColor + ';font-weight:700;">' + (props.status || '—') + '</span></div>' +
                '<div>Payment: <span style="color:#aaa;">' + (props.payment || '—') + '</span></div>' +
                '</div>' +
                '<div style="margin-top:14px;display:flex;gap:8px;">' +
                '<button onclick="switchTab(\'bookingsAdmin\'); $(\'#bookingStatusFilter\').val(\'ALL\').trigger(\'change\'); setTimeout(() => { const el = document.getElementById(\'bookingDetail-\' + \'' + props.dbId + '\'); if(el) { $(el).collapse(\'show\'); el.scrollIntoView({behavior:\'smooth\',block:\'center\'}); } }, 300); document.getElementById(\'calEventPopup\').remove();" style="flex:1;background:#D4AF37;color:#111;border:none;border-radius:6px;padding:7px;font-size:12px;font-weight:700;cursor:pointer;"><i class="fa-solid fa-eye"></i> View</button>' +
                '</div>';
        } else if (props.type === 'hold') {
            popup.innerHTML = '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">' +
                '<strong style="color:#aaa;font-size:14px;"><i class="fa-solid fa-ban"></i> Date Hold</strong>' +
                '<button onclick="document.getElementById(\'calEventPopup\').remove()" style="background:none;border:none;color:#666;font-size:16px;cursor:pointer;">&times;</button>' +
                '</div>' +
                '<div style="font-size:13px;color:#ccc;margin-bottom:14px;">' + info.event.title.replace('[HOLD] ', '') + '</div>' +
                '<button onclick="window.handleRemoveHold(\'' + props.dbId + '\')" style="width:100%;background:#c0392b;color:#fff;border:none;border-radius:6px;padding:7px;font-size:12px;font-weight:700;cursor:pointer;"><i class="fa-solid fa-trash"></i> Remove Hold</button>';
        } else if (props.type === 'public_event') {
            popup.innerHTML = '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">' +
                '<strong style="color:#17a2b8;font-size:14px;"><i class="fa-solid fa-star"></i> Public Event</strong>' +
                '<button onclick="document.getElementById(\'calEventPopup\').remove()" style="background:none;border:none;color:#666;font-size:16px;cursor:pointer;">&times;</button>' +
                '</div>' +
                '<div style="font-size:13px;line-height:1.8;color:#ccc;">' +
                '<div><strong style="color:#fff;">' + info.event.title.replace('[EVENT] ', '') + '</strong></div>' +
                '<div>Date: ' + (info.event.startStr || '').split('T')[0] + '</div>' +
                (props.venue ? '<div>Venue: <span style="color:#aaa;">' + props.venue + '</span></div>' : '') +
                '</div>' +
                '<div style="margin-top:14px;display:flex;gap:8px;">' +
                '<button onclick="$(\'.um-tab-btn[data-target=&quot;#eventsAdmin&quot;]\').click(); setTimeout(() => { $(\'.edit-events-action[data-id=&quot;' + props.dbId + '&quot;]\').click(); }, 300); document.getElementById(\'calEventPopup\').remove();" style="flex:1;background:#17a2b8;color:#fff;border:none;border-radius:6px;padding:7px;font-size:12px;font-weight:700;cursor:pointer;"><i class="fa-solid fa-pen-to-square"></i> Edit Event</button>' +
                '</div>';
        } else {
            popup.innerHTML = '<div style="display:flex;justify-content:space-between;align-items:center;">' +
                '<strong style="color:#17a2b8;font-size:13px;">' + info.event.title + '</strong>' +
                '<button onclick="document.getElementById(\'calEventPopup\').remove()" style="background:none;border:none;color:#666;font-size:16px;cursor:pointer;">&times;</button>' +
                '</div>';
        }
    
    window.handleRemoveHold = async function(dbId) {
        if (await window.notificationService.showConfirm({
            title: "Remove Hold",
            message: "Remove this hold?",
            isDestructive: true
        })) {
            try {
                const r = await fetch('/api/admin/calendar/hold/' + dbId, { method: 'DELETE' });
                const d = await r.json();
                if (d.success) {
                    if (adminCalendar) adminCalendar.refetchEvents();
                    const popup = document.getElementById('calEventPopup');
                    if (popup) popup.remove();
                    window.notificationService.showSuccess("Hold removed successfully.");
                } else {
                    window.notificationService.showError(d.message || "Failed to remove hold.");
                }
            } catch (e) {
                window.notificationService.showError("Network error while removing hold.");
            }
        }
    };

        document.body.appendChild(popup);
        setTimeout(() => { document.addEventListener('click', function dismiss(e) { if (!popup.contains(e.target)) { popup.remove(); document.removeEventListener('click', dismiss); } }); }, 50);
    }

    function initAdminCalendar() {
        var calendarEl = document.getElementById('calendar');
        if (!calendarEl) return;

        if (!adminCalendar) {
            adminCalendar = new FullCalendar.Calendar(calendarEl, {
                initialView: 'dayGridMonth',
                headerToolbar: {
                    left: 'prev,next today',
                    center: 'title',
                    right: 'dayGridMonth,timeGridWeek,listMonth'
                },
                events: '/api/admin/calendar/events',
                editable: true,
                eventStartEditable: true,
                eventResourceEditable: false,
                eventAllow: function(dropInfo, draggedEvent) {
                    return draggedEvent && draggedEvent.extendedProps && draggedEvent.extendedProps.type === 'booking';
                },
                eventClick: function(info) {
                    showCalEventPopup(info);
                },
                eventDrop: function(info) {
                    var props = info.event.extendedProps;
                    if (!props || props.type !== 'booking') { info.revert(); return; }
                    var newDate = info.event.startStr.split('T')[0];
                    fetch('/api/admin/bookings/' + props.dbId + '/date', {
                        method: 'PATCH',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ date: newDate })
                    }).then(r => r.json()).then(d => {
                        if (!d.success) { info.revert(); window.notificationService.showError('Could not update booking date.'); }
                        else { renderWorkingSchedule(); }
                    }).catch(() => { info.revert(); });
                },
                eventTimeFormat: { hour: 'numeric', minute: '2-digit', meridiem: 'short' }
            });
            adminCalendar.render();
        } else {
            adminCalendar.render();
        }

        // Initialize sidebar enhancements
        initMiniCalendar();
        renderWorkingSchedule();
    }

    /* ---- Mini Calendar Logic ---- */
    let miniCalDate = new Date();
    function initMiniCalendar() {
        const body = document.getElementById('miniCalendarBody');
        const display = document.getElementById('miniMonthYearDisplay');
        const prev = document.getElementById('prevMiniMonth');
        const next = document.getElementById('nextMiniMonth');
        if (!body || !display) return;

        function render() {
            body.innerHTML = '';
            const year = miniCalDate.getFullYear();
            const month = miniCalDate.getMonth();
            const monthNames = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
            display.textContent = monthNames[month] + ' ' + year;

            const firstDay = new Date(year, month, 1).getDay();
            const daysInMonth = new Date(year, month + 1, 0).getDate();
            const today = new Date();

            let row = document.createElement('tr');
            // Fill padding
            for (let i = 0; i < firstDay; i++) {
                row.appendChild(document.createElement('td'));
            }

            for (let day = 1; day <= daysInMonth; day++) {
                if (row.children.length === 7) {
                    body.appendChild(row);
                    row = document.createElement('tr');
                }
                const cell = document.createElement('td');
                cell.textContent = day;
                if (year === today.getFullYear() && month === today.getMonth() && day === today.getDate()) {
                    cell.classList.add('current-day');
                }
                cell.onclick = () => {
                    if (adminCalendar) adminCalendar.gotoDate(new Date(year, month, day));
                };
                row.appendChild(cell);
            }
            while (row.children.length < 7) {
                row.appendChild(document.createElement('td'));
            }
            body.appendChild(row);
        }

        prev.onclick = () => { miniCalDate.setMonth(miniCalDate.getMonth() - 1); render(); };
        next.onclick = () => { miniCalDate.setMonth(miniCalDate.getMonth() + 1); render(); };
        render();
    }

    /* ---- Working Schedule List ---- */
    async function renderWorkingSchedule() {
        const listContainer = document.getElementById('upcomingScheduleList');
        if (!listContainer) return;

        try {
            const res = await fetch('/api/admin/calendar/events');
            const events = await res.json();
            
            if (!events || events.length === 0) {
                listContainer.innerHTML = '<li style="color: #666; padding: 20px; text-align: center;">No upcoming events.</li>';
                return;
            }

            // Slice to show only next 6 events
            const upcoming = events.slice(0, 6);
            listContainer.innerHTML = upcoming.map(ev => {
                const date = new Date(ev.start);
                const dateStr = date.toLocaleDateString('en-ZA', { month: 'short', day: 'numeric' });
                const timeStr = date.toLocaleTimeString('en-ZA', { hour: '2-digit', minute: '2-digit' });
                
                let dotColor = '#D4AF37'; // Default gold
                if (ev.extendedProps) {
                    if (ev.extendedProps.type === 'booking') dotColor = '#D4AF37';
                    if (ev.extendedProps.type === 'hold') dotColor = '#777';
                    if (ev.extendedProps.type === 'event') dotColor = '#17a2b8';
                }

                return `
                    <li class="schedule-item">
                        <div class="schedule-item-header">
                            <span class="schedule-item-dot" style="background: ${dotColor};"></span>
                            <span class="schedule-item-title">${ev.title}</span>
                        </div>
                        <div class="schedule-item-time">${dateStr} • ${timeStr}</div>
                        <div class="schedule-item-meta">${ev.extendedProps ? (ev.extendedProps.type || 'Event').toUpperCase() : 'EVENT'}</div>
                    </li>
                `;
            }).join('');

        } catch (err) {
            console.error('Error fetching schedule:', err);
            listContainer.innerHTML = '<li style="color: #666; padding: 20px; text-align: center;">Error loading events.</li>';
        }
    }

    // Copy ICS Feed URL handler
    const btnCopyIcsFeed = document.getElementById('btnCopyIcsFeed');
    if (btnCopyIcsFeed) {
        btnCopyIcsFeed.onclick = async () => {
            try {
                const r = await fetch('/api/admin/settings');
                const d = await r.json();
                const token = (d.settings && d.settings.CALENDAR_FEED_SECRET) || '';
                const baseUrl = window.location.origin;
                const feedUrl = baseUrl + '/api/calendar/feed.ics' + (token ? '?token=' + encodeURIComponent(token) : '');
                await navigator.clipboard.writeText(feedUrl);
                btnCopyIcsFeed.innerHTML = '<i class="fa-solid fa-check"></i> Copied!';
                setTimeout(() => { btnCopyIcsFeed.innerHTML = '<i class="fa-solid fa-link"></i> Copy Feed URL'; }, 2000);
            } catch (e) {
                window.notificationService.showError('Could not copy: ' + e.message);
            }
        };
    }

    // Manual Hold Handler
    const btnNewDateHold = document.getElementById('btnNewDateHold');
    if (btnNewDateHold) {
        btnNewDateHold.onclick = () => $('#modalDateHold').modal('show');
    }

    const btnSaveHold = document.getElementById('btnSaveHold');
    if (btnSaveHold) {
        btnSaveHold.onclick = async () => {
            const dateInput = document.getElementById('hold_date');
            const reasonInput = document.getElementById('hold_reason');
            const categorySelect = document.getElementById('hold_category');
            
            if (!dateInput.value || !reasonInput.value) {
                window.notificationService.showError('Date and reason are required.');
                return;
            }

            const res = await fetch('/api/admin/calendar/hold', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    date: dateInput.value,
                    reason: reasonInput.value,
                    category: categorySelect.value
                })
            });
            const data = await res.json();
            if (data.success) {
                $('#modalDateHold').modal('hide');
                document.getElementById('formDateHold').reset();
                if (adminCalendar) adminCalendar.refetchEvents();
            }
        };
    }

    /* ---- Notifications ---- */
    function buildNotifications() {
        var items = [];

        // Pull from inquiry cache (unread inquiries)
        if (typeof allInquiriesCache !== 'undefined' && Array.isArray(allInquiriesCache)) {
            allInquiriesCache
                .filter(function(q) { return q.status === 'unread'; })
                .slice(0, 5)
                .forEach(function(q) {
                    items.push({
                        type: 'inquiry',
                        icon: 'fa-solid fa-envelope',
                        title: (q.name || 'Unknown') + ': ' + (q.subject || q.type || 'Inquiry'),
                        meta: timeAgo(q.created_at),
                        action: function() { switchTab('inquiriesAdmin'); },
                        unread: true
                    });
                });
        }

        // Pull from bookings cache (pending)
        if (typeof allBookingsCache !== 'undefined' && Array.isArray(allBookingsCache)) {
            allBookingsCache
                .filter(function(b) { return (b.status || '').toLowerCase() === 'pending'; })
                .slice(0, 5)
                .forEach(function(b) {
                    items.push({
                        type: 'booking',
                        icon: 'fa-solid fa-calendar-check',
                        title: (b.event_name || b.company_name || 'Booking') + ' — Pending',
                        meta: timeAgo(b.created_at || b.date),
                        action: function() { switchTab('bookingsAdmin'); },
                        unread: true
                    });
                });
        }

        // Pull from events cache (upcoming)
        if (typeof allEventsCache !== 'undefined' && Array.isArray(allEventsCache)) {
            allEventsCache.slice(0, 3).forEach(function(ev) {
                items.push({
                    type: 'event',
                    icon: 'fa-regular fa-calendar-days',
                    title: ev.event_name || ev.title || 'Event',
                    meta: ev.date || '',
                    action: function() { switchTab('eventsAdmin'); },
                    unread: false
                });
            });
        }

        var list = qs('#admNotiList');
        var badge = qs('#admNotiBadge');
        if (!list) return;

        var unreadCount = items.filter(function(i) { return i.unread; }).length;

        if (badge) {
            if (unreadCount > 0) {
                badge.textContent = unreadCount > 99 ? '99+' : unreadCount;
                badge.style.display = 'flex';
                badge.setAttribute('aria-label', unreadCount + ' unread notifications');
            } else {
                badge.style.display = 'none';
            }
        }

        if (items.length === 0) {
            list.innerHTML = '<div class="adm-noti-empty"><i class="fa-regular fa-bell-slash"></i><p>No recent activity</p></div>';
            return;
        }

        list.innerHTML = items.slice(0, 8).map(function(item) {
            return '<button class="adm-noti-item" style="border:none;width:100%;">' +
                '<span class="adm-noti-item__icon adm-noti-item__icon--' + item.type + '">' +
                    '<i class="' + item.icon + '"></i>' +
                '</span>' +
                '<span class="adm-noti-item__body">' +
                    '<span class="adm-noti-item__title">' + (item.title || '') + '</span>' +
                    '<span class="adm-noti-item__meta">' + (item.meta || '') + '</span>' +
                '</span>' +
                (item.unread ? '<span class="adm-noti-item__dot"></span>' : '') +
            '</button>';
        }).join('');

        // Attach click handlers
        var btns = list.querySelectorAll('.adm-noti-item');
        btns.forEach(function(btn, idx) {
            if (items[idx] && items[idx].action) {
                btn.addEventListener('click', items[idx].action);
            }
        });
    }

    // Notification refresh button
    var admNotiRefresh = qs('#admNotiRefresh');
    if (admNotiRefresh) {
        admNotiRefresh.addEventListener('click', function(e) {
            e.stopPropagation();
            buildNotifications();
            this.querySelector('i').style.transform = 'rotate(360deg)';
            this.querySelector('i').style.transition = 'transform 0.5s ease';
            var self = this;
            setTimeout(function() {
                self.querySelector('i').style.transform = '';
                self.querySelector('i').style.transition = '';
            }, 600);
        });
    }

    // "View all" in notifications -> go to inquiries
    var admNotiViewAll = qs('#admNotiViewAll');
    if (admNotiViewAll) {
        admNotiViewAll.addEventListener('click', function(e) {
            e.preventDefault();
            switchTab('inquiriesAdmin');
            closeAllDropdowns(null);
        });
    }

    // Auto-refresh notifications once caches load
    setTimeout(buildNotifications, 2000);
    // Re-check every 60 seconds
    setInterval(buildNotifications, 60000);

    /* ---- Global Search ---- */
    var searchInput  = qs('#admGlobalSearch');
    var searchPanel  = qs('#admSearchResults');
    var searchTimer  = null;

    if (searchInput && searchPanel) {

        // Open panel on focus if input has value
        searchInput.addEventListener('focus', function() {
            if (this.value.trim().length >= 2) {
                searchPanel.style.display = 'block';
                this.setAttribute('aria-expanded', 'true');
            }
        });

        searchInput.addEventListener('input', function() {
            clearTimeout(searchTimer);
            var q = this.value.trim();
            if (q.length < 2) {
                searchPanel.style.display = 'none';
                this.setAttribute('aria-expanded', 'false');
                return;
            }
            searchTimer = setTimeout(function() { runSearch(q); }, 280);
        });

        // Close on Escape
        searchInput.addEventListener('keydown', function(e) {
            if (e.key === 'Escape') {
                searchPanel.style.display = 'none';
                this.setAttribute('aria-expanded', 'false');
                this.blur();
            }
        });

        // Close search results on outside click
        document.addEventListener('click', function(e) {
            if (!searchInput.contains(e.target) && !searchPanel.contains(e.target)) {
                searchPanel.style.display = 'none';
            }
        });

        // Keyboard shortcut "/" to focus search
        document.addEventListener('keydown', function(e) {
            if (e.key === '/' && document.activeElement !== searchInput &&
                !['INPUT','TEXTAREA','SELECT'].includes(document.activeElement.tagName)) {
                e.preventDefault();
                searchInput.focus();
                searchInput.select();
            }
        });
    }

    function runSearch(q) {
        if (!searchPanel) return;
        var ql = q.toLowerCase();
        var html = '';
        var totalResults = 0;

        // -- Inquiries --
        if (typeof allInquiriesCache !== 'undefined' && Array.isArray(allInquiriesCache)) {
            var inqResults = allInquiriesCache.filter(function(item) {
                return (item.name||'').toLowerCase().includes(ql) ||
                       (item.email||'').toLowerCase().includes(ql) ||
                       (item.subject||'').toLowerCase().includes(ql) ||
                       (item.message||'').toLowerCase().includes(ql);
            }).slice(0, 5);

            if (inqResults.length) {
                html += '<div class="adm-search__group-label">Inquiries</div>';
                inqResults.forEach(function(item) {
                    var id = item.inquiry_id;
                    html += '<button class="adm-search__result" data-type="inquiry" data-id="' + id + '">' +
                        '<i class="fa-solid fa-envelope"></i>' +
                        '<span class="adm-search__result-main">' +
                            '<span class="adm-search__result-title">' + escHtml(item.name||'') + ' — ' + escHtml(item.subject||item.type||'') + '</span>' +
                            '<span class="adm-search__result-sub">' + escHtml(item.email||'') + '</span>' +
                        '</span>' +
                        '<span class="adm-search__result-badge adm-search__result-badge--inquiry">' + escHtml(item.status||'') + '</span>' +
                    '</button>';
                });
                totalResults += inqResults.length;
                if (totalResults) html += '<div class="adm-search__divider"></div>';
            }
        }

        // -- Bookings --
        if (typeof allBookingsCache !== 'undefined' && Array.isArray(allBookingsCache)) {
            var bkResults = allBookingsCache.filter(function(item) {
                return (item.event_name||item.company_name||'').toLowerCase().includes(ql) ||
                       (item.email||'').toLowerCase().includes(ql) ||
                       (item.client_name||item.contact_name||'').toLowerCase().includes(ql);
            }).slice(0, 5);

            if (bkResults.length) {
                html += '<div class="adm-search__group-label">Bookings</div>';
                bkResults.forEach(function(item) {
                    var id = item.booking_id;
                    var title = item.event_name || item.company_name || 'Booking';
                    var sub   = item.client_name || item.contact_name || item.email || '';
                    html += '<button class="adm-search__result" data-type="booking" data-id="' + id + '">' +
                        '<i class="fa-solid fa-calendar-check"></i>' +
                        '<span class="adm-search__result-main">' +
                            '<span class="adm-search__result-title">' + escHtml(title) + '</span>' +
                            '<span class="adm-search__result-sub">' + escHtml(sub) + '</span>' +
                        '</span>' +
                        '<span class="adm-search__result-badge adm-search__result-badge--booking">' + escHtml(item.status||'') + '</span>' +
                    '</button>';
                });
                totalResults += bkResults.length;
                if (bkResults.length) html += '<div class="adm-search__divider"></div>';
            }
        }

        // -- Events --
        if (typeof allEventsCache !== 'undefined' && Array.isArray(allEventsCache)) {
            var evResults = allEventsCache.filter(function(item) {
                return (item.event_name||item.title||'').toLowerCase().includes(ql) ||
                       (item.venue||'').toLowerCase().includes(ql) ||
                       (item.description||'').toLowerCase().includes(ql);
            }).slice(0, 4);

            if (evResults.length) {
                html += '<div class="adm-search__group-label">Events</div>';
                evResults.forEach(function(item) {
                    var title = item.event_name || item.title || 'Event';
                    html += '<button class="adm-search__result" data-type="event">' +
                        '<i class="fa-regular fa-calendar-days"></i>' +
                        '<span class="adm-search__result-main">' +
                            '<span class="adm-search__result-title">' + escHtml(title) + '</span>' +
                            '<span class="adm-search__result-sub">' + escHtml(item.venue||item.date||'') + '</span>' +
                        '</span>' +
                        '<span class="adm-search__result-badge adm-search__result-badge--event">Event</span>' +
                    '</button>';
                });
                totalResults += evResults.length;
            }
        }

        if (totalResults === 0) {
            html = '<div class="adm-search__empty"><i class="fa-solid fa-magnifying-glass" style="margin-bottom:6px; font-size:20px; display:block; color:#333;"></i>No results for "' + escHtml(q) + '"</div>';
        }

        searchPanel.innerHTML = html;
        searchPanel.style.display = 'block';
        searchInput.setAttribute('aria-expanded', 'true');

        // Result click handlers
        searchPanel.querySelectorAll('.adm-search__result').forEach(function(btn) {
            btn.addEventListener('click', function() {
                var type = this.dataset.type;
                searchPanel.style.display = 'none';
                searchInput.value = '';
                if (type === 'inquiry') switchTab('inquiriesAdmin');
                else if (type === 'booking') switchTab('bookingsAdmin');
                else if (type === 'event') switchTab('eventsAdmin');
            });
        });
    }

    function escHtml(str) {
        return String(str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    }

})();
