/*
 * Shared overlay stack — one registry for every layer that can sit over the page:
 * drawers (.atl-drawer, .qb-drawer, .svc-drawer), the notificationService modal, and any
 * future overlay. Loaded on both the public site and the admin portal, before
 * js/notificationService.js.
 *
 * WHY THIS EXISTS — a proven defect, not a refactor for its own sake.
 *
 * Drawers and modals each kept their own independent Escape handler and each drove
 * document.body.style.overflow directly. Opening a confirmation dialog from inside an open
 * drawer and pressing Escape once produced, measured against the running admin:
 *
 *     before Escape:  drawerOpen:true   modalActive:true    bodyOverflow:"hidden"
 *     after  Escape:  drawerOpen:false  modalActive:false   bodyOverflow:"(unset)"
 *
 * Both handlers fired, so the drawer the user was working in vanished along with the dialog,
 * and page scroll unlocked underneath it. Two causes:
 *   1. neither handler checked whether it owned the topmost layer;
 *   2. the modal's close path set body.overflow = '' unconditionally, with no notion of another
 *      overlay still being open.
 *
 * The modal's own focus trap, focus restore and listener cleanup were already correct — they
 * are left alone. What it lacked was any awareness that something else might be open behind it.
 *
 * Modelled on the O'luhle Scents admin's overlayStack (docs-internal/oluhle-admin-reference.md
 * §3.1), with one deliberate difference: the reference hands every overlay a fixed z-index of
 * 1000, while this project already assigns an increasing z-index per open so the most recently
 * opened drawer wins the paint order. That behaviour is better and is preserved — drawer.js
 * keeps owning z-index; this module owns ordering, scroll-lock and focus.
 *
 * NOT implemented, deliberately: the reference also marks the app root `inert` while an overlay
 * is open. That is correct for modal dialogs, but this project's drawers are not uniformly modal
 * — some are used alongside the page behind them — so applying it blanket-fashion would change
 * interaction, not just accessibility. Left as an open item.
 */
(function (global) {
    'use strict';

    var FOCUSABLE_SELECTOR =
        'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]),' +
        ' select:not([disabled]), [tabindex]:not([tabindex="-1"])';

    // Entries are { id, close, restoreFocus }. Order is open order; last is topmost.
    var stack = [];
    // Body overflow as it was before the first overlay opened, so unlocking restores whatever
    // the page actually had rather than assuming ''.
    var savedOverflow = null;

    function lockScroll() {
        if (stack.length !== 1) return;          // only the first push locks
        // Already locked (the same overlay pushed twice, e.g. a double-activated trigger): don't
        // re-record the overflow — it is now 'hidden', and restoring THAT on close would leave the
        // page permanently scroll-locked.
        if (savedOverflow !== null) return;
        savedOverflow = document.body.style.overflow || '';
        document.body.style.overflow = 'hidden';
        // A plain class alongside the scroll-lock, for CSS that needs to react to "something
        // is open" without its own z-index — e.g. the public site's floating back-to-top
        // button hides via this class instead of trying to out-rank an ever-growing drawer
        // z-index. Harmless on pages with no such CSS (the admin has none).
        document.body.classList.add('atl-overlay-open');
    }

    function unlockScroll() {
        if (stack.length !== 0) return;          // only the last pop unlocks
        document.body.style.overflow = savedOverflow === null ? '' : savedOverflow;
        savedOverflow = null;
        document.body.classList.remove('atl-overlay-open');
    }

    /**
     * Register an overlay as open.
     * @param {string}   id        unique per overlay instance
     * @param {Function} close     invoked when Escape is pressed while this layer is topmost
     * @param {Element}  [trigger] element to return focus to on close; defaults to whatever
     *                             held focus at push time
     */
    function push(id, close, trigger) {
        stack = stack.filter(function (e) { return e.id !== id; });
        stack.push({
            id: id,
            close: typeof close === 'function' ? close : function () {},
            restoreFocus: trigger || document.activeElement || null
        });
        lockScroll();
        return stack.length;
    }

    /** Deregister an overlay. Returns the entry that is now topmost, or null. */
    function pop(id) {
        var leaving = null;
        stack = stack.filter(function (e) {
            if (e.id === id) { leaving = e; return false; }
            return true;
        });
        unlockScroll();
        // Only hand focus back to the original trigger when nothing else is open. If a drawer is
        // still beneath this dialog, its own focus-entry logic takes over instead.
        if (leaving && leaving.restoreFocus && !stack.length) {
            try { leaving.restoreFocus.focus(); } catch (e) { /* element left the DOM */ }
        }
        return stack.length ? stack[stack.length - 1] : null;
    }

    /** True when `id` owns the topmost layer — the Escape/close guard. */
    function isTop(id) {
        return stack.length > 0 && stack[stack.length - 1].id === id;
    }

    function depth() { return stack.length; }

    function topEntry() { return stack.length ? stack[stack.length - 1] : null; }

    /**
     * Keep Tab cycling inside `container` while it owns the topmost layer.
     * Returns a teardown function — callers MUST invoke it on close, or the listener leaks.
     * Offered for overlays that have no trap of their own; notificationService's modal already
     * has a correct one and does not use this.
     */
    function trapFocus(container, id) {
        if (!container) return function () {};
        var onKey = function (e) {
            if (e.key !== 'Tab' || !isTop(id)) return;
            var list = Array.prototype.slice.call(container.querySelectorAll(FOCUSABLE_SELECTOR))
                .filter(function (el) { return el.offsetParent !== null || el === document.activeElement; });
            if (!list.length) return;
            var first = list[0], last = list[list.length - 1];
            if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
            else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
        };
        document.addEventListener('keydown', onKey, true);
        return function () { document.removeEventListener('keydown', onKey, true); };
    }

    function prefersReducedMotion() {
        try {
            return !!(global.matchMedia && global.matchMedia('(prefers-reduced-motion: reduce)').matches);
        } catch (e) { return false; }
    }

    global.atlOverlayStack = {
        push: push,
        pop: pop,
        isTop: isTop,
        depth: depth,
        topEntry: topEntry,
        trapFocus: trapFocus,
        prefersReducedMotion: prefersReducedMotion,
        FOCUSABLE_SELECTOR: FOCUSABLE_SELECTOR
    };
})(window);
