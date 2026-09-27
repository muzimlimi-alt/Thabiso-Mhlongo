/*
 * Multilevel sidebar behaviour.
 *
 * Owns only the group expand/collapse state, PLUS (below) the rail-mode flyout portal.
 * Section NAVIGATION still belongs to window.switchTab — this file never changes
 * sections, and the leaf links are untouched <a class="tm-nav-link" href="#sectionId">
 * elements that the existing delegated handler picks up exactly as before.
 *
 * Modelled on the O'luhle/TOCA sidebar (docs-internal/oluhle-admin-reference.md):
 *   · expanded groups persist across reloads
 *   · the group owning the current section auto-expands, without collapsing a
 *     group the admin deliberately opened
 *   · a collapsed group that owns the current section is still marked, so you can
 *     see where you are when its children are hidden
 */
(function ($) {
    'use strict';

    var KEY = 'atl-nav-expanded';

    function loadExpanded() {
        try {
            var raw = localStorage.getItem(KEY);
            var arr = raw ? JSON.parse(raw) : [];
            return Array.isArray(arr) ? arr : [];
        } catch (e) { return []; }
    }

    function saveExpanded(ids) {
        try { localStorage.setItem(KEY, JSON.stringify(ids)); } catch (e) { /* private mode */ }
    }

    function expandedIds() {
        return $('.atl-nav-group.open > .atl-nav-sub').map(function () { return this.id; }).get();
    }

    function isRailed() {
        var sb = document.getElementById('tmAdminSidebar');
        return !!(sb && sb.classList.contains('collapsed'));
    }

    function setGroupOpen($group, open) {
        $group.toggleClass('open', !!open);
        $group.children('.atl-nav-parent').attr('aria-expanded', open ? 'true' : 'false');
    }

    /* Mark the group that owns the current section. switchTab sets .active on the
       leaf's <li>; this surfaces that one level up so a collapsed group still
       shows it is the current one. Portalled submenus are checked too — while
       railed, a group's .atl-nav-sub lives under <body>, not under its group. */
    function syncCurrentGroup() {
        $('.atl-nav-group').removeClass('atl-nav-group--current');
        $('.atl-nav-sub > li.active').each(function () {
            var $sub = $(this).parent();
            var groupId = $sub.data('ownerGroupId');
            var $group = groupId ? $('#' + groupId) : $sub.closest('.atl-nav-group');
            $group.addClass('atl-nav-group--current');
        });
    }

    /* Auto-expand the group containing the active leaf. Deliberately only ever
       ADDS — collapsing others here would fight an admin who opened two groups
       on purpose, which is the behaviour the reference calls out. */
    function revealActive() {
        var $activeLeaf = $('.atl-nav-sub > li.active').first();
        if ($activeLeaf.length) {
            var $sub = $activeLeaf.parent();
            var groupId = $sub.data('ownerGroupId');
            var $group = groupId ? $('#' + groupId) : $activeLeaf.closest('.atl-nav-group');
            if ($group.length && !$group.hasClass('open')) {
                setGroupOpen($group, true);
                saveExpanded(expandedIds());
            }
        }
        syncCurrentGroup();
    }

    /* ────────────────────────── Rail-mode flyout portal ──────────────────────────
     * See the long comment on .atl-nav-sub--portalled in css/admin/sidebar-nav.css
     * for WHY this exists: .tm-admin-sidebar-scroll's overflow-x:hidden clips a
     * plain position:absolute flyout completely out of view, for every input method,
     * not just hover-vs-click — confirmed with a direct measurement and a
     * screenshot. CSS alone cannot escape an overflow-clipping ancestor, so the
     * flyout is moved to a direct child of <body> while open and returned to its
     * original place — with the group li it came from remembered via a data
     * attribute rather than DOM position, since by definition it no longer HAS a
     * DOM position under that group while portalled — the moment it closes.
     */
    var portal = { sub: null, group: null, originalNext: null, hideTimer: null };

    function clearHideTimer() {
        if (portal.hideTimer) { clearTimeout(portal.hideTimer); portal.hideTimer = null; }
    }

    function positionPortal(sub, trigger) {
        var r = trigger.getBoundingClientRect();
        var top = r.top;
        // Clamp so a flyout opened near the bottom of a tall list doesn't run off
        // the viewport — menus are short (at most 6 items) so a flat "pull up by
        // however much it overflows" is enough, no need to measure before paint.
        var estimatedHeight = sub.children.length * 36 + 40;
        if (top + estimatedHeight > window.innerHeight - 8) {
            top = Math.max(8, window.innerHeight - estimatedHeight - 8);
        }
        sub.style.top = top + 'px';
        sub.style.left = r.right + 'px';
    }

    function openPortal(groupEl) {
        if (!isRailed() || !groupEl) return;
        var sub = groupEl.querySelector(':scope > .atl-nav-sub');
        var trigger = groupEl.querySelector(':scope > .atl-nav-parent');
        if (!sub || !trigger) return;

        if (portal.sub === sub) { clearHideTimer(); return; } // already open, just cancel any pending close
        if (portal.sub) closePortal(); // a different group's flyout is open — swap it out

        portal.sub = sub;
        portal.group = groupEl;
        portal.originalNext = sub.nextSibling; // null is a valid "was last child" marker
        $(sub).data('ownerGroupId', groupEl.id || (groupEl.id = 'atlNavGroup_' + Math.random().toString(36).slice(2, 8)));

        document.body.appendChild(sub);
        sub.classList.add('atl-nav-sub--portalled');
        positionPortal(sub, trigger);
        groupEl.setAttribute('aria-expanded', 'true');
        clearHideTimer();
    }

    function closePortal() {
        clearHideTimer();
        if (!portal.sub) return;
        var sub = portal.sub, group = portal.group;
        sub.classList.remove('atl-nav-sub--portalled');
        sub.style.top = '';
        sub.style.left = '';
        // Put it back exactly where it came from, so DOM order / tab order are
        // identical to a session where it was never opened.
        group.insertBefore(sub, portal.originalNext);
        if (group) group.querySelector(':scope > .atl-nav-parent').setAttribute('aria-expanded',
            group.classList.contains('open') ? 'true' : 'false');
        portal.sub = null;
        portal.group = null;
        portal.originalNext = null;
    }

    function scheduleClosePortal() {
        clearHideTimer();
        // Long enough to move the cursor from the trigger icon across the small gap
        // onto the flyout itself without it vanishing first; short enough that it
        // doesn't linger once you've genuinely moved on.
        portal.hideTimer = setTimeout(closePortal, 220);
    }

    // Hover: trigger -> open (delegated, since portalled flyouts live outside the
    // sidebar and can't be targeted by a plain child selector at bind time).
    $(document).on('mouseenter', '.atl-nav-group', function () {
        if (isRailed()) openPortal(this);
    });
    $(document).on('mouseleave', '.atl-nav-group', function () {
        if (isRailed()) scheduleClosePortal();
    });
    // Hover: the portalled flyout itself. Without this, moving the cursor onto it
    // still counts as "left the trigger" and the close timer fires underneath you.
    $(document).on('mouseenter', '.atl-nav-sub--portalled', clearHideTimer);
    $(document).on('mouseleave', '.atl-nav-sub--portalled', function () {
        if (isRailed()) scheduleClosePortal();
    });

    // Keyboard: Tab reaching the trigger or landing inside the flyout opens it;
    // Tab leaving BOTH closes it. relatedTarget/activeElement on focusout tells us
    // where focus is actually going, so tabbing from the trigger straight into its
    // own flyout (the normal case) does not cause a flash of closing-then-reopening.
    $(document).on('focusin', '.atl-nav-group, .atl-nav-sub--portalled', function () {
        if (!isRailed()) return;
        var group = this.classList.contains('atl-nav-sub--portalled') ? portal.group : this;
        openPortal(group);
    });
    $(document).on('focusout', '.atl-nav-group, .atl-nav-sub--portalled', function () {
        if (!isRailed()) return;
        setTimeout(function () {
            var active = document.activeElement;
            var stillInside = (portal.group && portal.group.contains(active)) ||
                               (portal.sub && portal.sub.contains(active));
            if (!stillInside) closePortal();
        }, 0);
    });

    // Force-close if the sidebar leaves rail mode while a flyout is open (e.g. the
    // admin expands it mid-hover) — the expanded state's own grid-based reveal
    // takes over and a stray portalled node would otherwise be orphaned.
    (function watchCollapsedState() {
        var sb = document.getElementById('tmAdminSidebar');
        if (!sb || !window.MutationObserver) return;
        var obs = new MutationObserver(function () { if (!isRailed() && portal.sub) closePortal(); });
        obs.observe(sb, { attributes: true, attributeFilter: ['class'] });
    })();

    // Reposition an open flyout if the viewport changes under it — or if it was opened while
    // the sidebar was still animating to rail width (its trigger's rect was measured at an
    // intermediate width, leaving the flyout floating off to the right of the icon).
    function repositionPortal() {
        if (portal.sub && portal.group) positionPortal(portal.sub, portal.group.querySelector(':scope > .atl-nav-parent'));
    }
    $(window).on('resize', repositionPortal);
    (function () {
        var sb = document.getElementById('tmAdminSidebar');
        if (sb) sb.addEventListener('transitionend', function (e) {
            if (e.target === sb && e.propertyName === 'width') repositionPortal();
        });
    })();

    $(document).on('click', '.atl-nav-parent', function (e) {
        e.preventDefault();
        var $group = $(this).closest('.atl-nav-group');
        var willOpen = !$group.hasClass('open');
        setGroupOpen($group, willOpen);
        saveExpanded(expandedIds());
        // In rail mode the CSS .open selectors can't reach a portalled node, so the
        // portal's own open/close is driven explicitly here too — this is what
        // makes a plain click (no hover, e.g. touch or a fast click-before-hover)
        // work on its own. mouseleave will still schedule a close afterward if the
        // cursor isn't resting on the trigger or the flyout.
        if (isRailed()) { if (willOpen) openPortal($group[0]); else closePortal(); }
    });

    // Close the portal once a nested leaf is actually clicked — navigating away, it
    // has done its job. (No-op outside rail mode / outside a portalled flyout.)
    $(document).on('click', '.atl-nav-sub--portalled > li > a.tm-nav-link', function () {
        closePortal();
    });

    /* Keyboard: Right/Left open and close a group without toggling, matching the
       tree-view convention. Enter/Space already work — it is a <button>. */
    $(document).on('keydown', '.atl-nav-parent', function (e) {
        var $group = $(this).closest('.atl-nav-group');
        if (e.key === 'ArrowRight' && !$group.hasClass('open')) {
            setGroupOpen($group, true); saveExpanded(expandedIds());
            if (isRailed()) openPortal($group[0]);
            e.preventDefault();
        } else if (e.key === 'ArrowLeft' && $group.hasClass('open')) {
            setGroupOpen($group, false); saveExpanded(expandedIds());
            if (isRailed()) closePortal();
            e.preventDefault();
        }
    });

    // switchTab moves .active; re-sync after it has run.
    $(document).on('click', '.atl-nav-sub > li > a.tm-nav-link', function () {
        setTimeout(revealActive, 0);
    });

    $(function () {
        var saved = loadExpanded();
        saved.forEach(function (id) {
            var el = document.getElementById(id);
            if (el) setGroupOpen($(el).closest('.atl-nav-group'), true);
        });
        // Runs after the restore so the active group is expanded even on a first
        // visit, and after switchTab's own restore of the last section.
        setTimeout(revealActive, 150);
    });

    window.atlSidebarNav = { revealActive: revealActive, syncCurrentGroup: syncCurrentGroup };
})(jQuery);
