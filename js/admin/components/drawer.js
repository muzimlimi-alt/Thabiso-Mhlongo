/* Phase 7 Component 4 — Drawer (HOUSEKEEPING-NOTES.md "Component 4" section).
 *
 * Relocated VERBATIM (byte-identical) from where Phase 6 left it:
 *   - the drawer-stacking model + window.openAtlDrawer/closeAtlDrawer + the Esc handler
 *     were in js/admin/services.js (carried there with the Services extraction);
 *   - window.atlActivateDrawerTab + its click.atldrawertab delegated binding were in
 *     js/admin/events.js (carried there with the Events extraction).
 *
 * Both are cross-cutting: ~92 call sites across 15 admin modules. This file loads before every
 * section <script src> (admin.html), so window.openAtlDrawer etc. are now defined ~10k lines
 * earlier than before (services.js loads near end of body) — strictly safer ordering, no
 * behaviour change. atlDrawerPush/atlDrawerPop/atlDrawerFocusEntry stay plain function
 * declarations (already global in a classic script) so services.js’s svcDrawerOpen /
 * openQuoteDrawer, left in place, still reach them by bare identifier.
 *
 * The 4-space indentation on the stacking block is a pre-existing artifact from admin.html,
 * preserved for byte-identity (a future cosmetic pass may de-indent it).
 */

    // ── Drawer stacking — shared by every drawer system on this page (.atl-drawer, the Quote
    // Builder's .qb-drawer, the Services form's .svc-drawer, and the bespoke Booking-Recovery
    // quick view) ──
    // Every drawer of a given type shares one static CSS z-index, so when two are open at
    // once — e.g. a secondary drawer launched from the More menu of a still-open Deal View, or
    // the Quote Builder opened via Deal View's own "Send Quote" CTA — whichever happened to
    // come later in the HTML source would otherwise win the paint-order tie regardless of
    // which was actually opened more recently, burying the drawer the user just asked for
    // behind the one they were already in. atlDrawerStack tracks every currently-open drawer
    // (id + its own close function, since not every drawer type closes the same way) in open
    // order; each push hands out a fresh, always-higher z-index pair so the most-recently-
    // opened drawer is always on top, older ones stay visible-but-dimmed underneath, body
    // scroll only unlocks once the whole stack empties (not on every single close), and Escape
    // closes just the top of the stack — stepping back one drawer at a time — instead of every
    // open drawer at once, so the user never loses their place in whatever's underneath.
    // Admin-consolidation change: ordering, scroll-lock and focus-restore now live in the
    // SHARED js/overlay-stack.js, which modals also register with. Previously this stack and
    // notificationService's modal each tracked their own state and each bound their own Escape
    // handler, so a confirm dialog opened from inside a drawer closed BOTH on one Escape press
    // and unlocked body scroll underneath the still-open drawer. See overlay-stack.js's header
    // for the measured before/after. The z-index laddering below is unchanged and is still
    // owned here — it is the part this project does better than the reference.
    let atlDrawerZ = 1050;
    const atlStack = function() { return window.atlOverlayStack; };
    // Kept as a live view for the Escape handler and any caller that inspected it.
    let atlDrawerStack = [];
    function atlDrawerPush(id, closeFn) {
        atlDrawerStack = atlDrawerStack.filter(function(e) { return e.id !== id; });
        atlDrawerStack.push({ id: id, close: closeFn });
        var s = atlStack();
        if (s) s.push(id, closeFn);
        else document.body.style.overflow = 'hidden';   // stack not loaded — previous behaviour
        atlDrawerZ += 2;
        return { backdropZ: atlDrawerZ, drawerZ: atlDrawerZ + 1 };
    }
    function atlDrawerPop(id) {
        atlDrawerStack = atlDrawerStack.filter(function(e) { return e.id !== id; });
        var s = atlStack();
        if (s) s.pop(id);
        else if (!atlDrawerStack.length) document.body.style.overflow = '';
        return atlDrawerStack.length ? atlDrawerStack[atlDrawerStack.length - 1] : null;
    }
    // Moves focus into whichever drawer is now topmost (a fresh open, or the one revealed once
    // a stacked drawer above it closes) — tries each drawer type's own close button first, then
    // falls back to the drawer element itself so this works regardless of internal markup.
    function atlDrawerFocusEntry(entry) {
        if (!entry) return;
        setTimeout(function() {
            var $el = $('#' + entry.id);
            if (!$el.length) return;
            var $target = $el.find('.atl-drawer__close, [aria-label="Close"]').first();
            if (!$target.length) {
                if (!$el.attr('tabindex')) $el.attr('tabindex', '-1');
                $target = $el;
            }
            // A control can be briefly un-focusable while the drawer's slide-in / any visibility
            // transition is still settling, so a single attempt isn't reliable: retry (bounded,
            // ~600ms) while focus is still nowhere, and stop the moment it lands or the user
            // has deliberately moved it elsewhere.
            var tries = 0;
            (function attempt() {
                $target.trigger('focus');
                if (document.activeElement === $target[0]) return;
                if (document.activeElement && document.activeElement !== document.body) return;
                if (++tries < 12) setTimeout(attempt, 50);
            })();
        }, 50);
    }

    // Opt-in modal semantics (data-atl-modal on the drawer element) — used by the public site's
    // Booking and Track-Booking drawers, which are true modal dialogs: Tab is trapped inside, and
    // everything else on the page is made inert (unreachable by keyboard and screen readers).
    // Admin drawers don't set the attribute, so their interaction is unchanged.
    // Layers that must stay interactive on top of / alongside a modal drawer are left alone:
    // other drawers, Bootstrap modals (e.g. Privacy Policy opened from the booking form), the
    // cookie dialog, Places autocomplete, and notificationService's own roots.
    var ATL_INERT_EXEMPT = '.atl-drawer, .atl-drawer-backdrop, .modal, .modal-backdrop, .cookie-modal, .pac-container,' +
        ' #tm-toast-container, #tm-modal-root, #tm-http-error-root, #tm-live-region';
    var atlTrapOff = {};      // drawer id -> focus-trap teardown
    var atlInerted = {};      // drawer id -> elements this drawer marked inert (and only those)
    function atlModalEnter(id) {
        var el = document.getElementById(id);
        if (!el || !el.hasAttribute('data-atl-modal')) return;
        el.inert = false;
        // Idempotent: a second open of an already-open drawer (double-activated trigger, Enter
        // pressed twice) must not re-mark siblings — they're already inert, so the record of what
        // this drawer owns would be overwritten with an empty list and the page left frozen.
        if (atlInerted[id]) return;
        var s = atlStack();
        if (s && s.trapFocus) atlTrapOff[id] = s.trapFocus(el, id);
        var marked = [];
        for (var node = el; node && node !== document.body; node = node.parentNode) {
            Array.prototype.forEach.call(node.parentNode.children, function(sib) {
                if (sib === node || sib.inert) return;
                if (/^(SCRIPT|STYLE|LINK|NOSCRIPT|TEMPLATE)$/.test(sib.tagName)) return;
                if (sib.matches(ATL_INERT_EXEMPT)) return;
                sib.inert = true;
                marked.push(sib);
            });
        }
        atlInerted[id] = marked;
    }
    function atlModalExit(id) {
        if (atlTrapOff[id]) { atlTrapOff[id](); delete atlTrapOff[id]; }
        (atlInerted[id] || []).forEach(function(sib) { sib.inert = false; });
        delete atlInerted[id];
        // A closed modal drawer is inert: not focusable, not in the accessibility tree — even
        // for a child (e.g. the close button) that sets its own visibility during the slide-out.
        var el = document.getElementById(id);
        if (el && el.hasAttribute('data-atl-modal')) el.inert = true;
    }
    $(function() {
        $('.atl-drawer[data-atl-modal]').each(function() {
            if (!$(this).hasClass('atl-drawer--open')) this.inert = true;
        });
    });
    // Backdrop fade is JS-driven (jQuery), so the CSS prefers-reduced-motion rules don't cover it.
    function atlFadeMs() {
        var s = atlStack();
        return (s && s.prefersReducedMotion && s.prefersReducedMotion()) ? 0 : 200;
    }

    window.openAtlDrawer = function(id) {
        var $drawer = $('#' + id);
        var $backdrop = $('#' + id + 'Backdrop');
        var z = atlDrawerPush(id, function() { closeAtlDrawer(id); });
        $backdrop.css('z-index', z.backdropZ).fadeIn(atlFadeMs());
        $drawer.css('z-index', z.drawerZ).addClass('atl-drawer--open');
        $drawer.find('.atl-drawer__body').scrollTop(0);
        atlModalEnter(id);
        document.dispatchEvent(new CustomEvent('atl:drawerOpened', { detail: { id: id } }));
        atlDrawerFocusEntry({ id: id });
    };
    window.closeAtlDrawer = function(id) {
        $('#' + id).removeClass('atl-drawer--open');
        $('#' + id + 'Backdrop').fadeOut(atlFadeMs());
        atlModalExit(id);
        atlDrawerFocusEntry(atlDrawerPop(id));
        // Fallback focus target for a drawer whose opener no longer exists once it closes (the
        // public site's mobile-menu links disappear with the menu): if nothing took focus back,
        // use the selector named in data-atl-return-focus.
        var fallbackSel = $('#' + id).attr('data-atl-return-focus');
        if (fallbackSel) setTimeout(function() {
            if (atlDrawerStack.length) return;
            if (document.activeElement && document.activeElement !== document.body) return;
            $(fallbackSel).filter(':visible').first().trigger('focus');
        }, 80);
        document.dispatchEvent(new CustomEvent('atl:drawerClosed', { detail: { id: id } }));
    };
    // A Bootstrap modal opened while a drawer is open (Privacy Policy / Terms from the booking
    // form) joins the same overlay stack, so Escape closes just that modal — not the drawer
    // underneath it — and body scroll stays locked until the drawer itself closes. Modals opened
    // with no drawer open are left entirely to Bootstrap.
    $(document).off('show.bs.modal.atlDrawer hidden.bs.modal.atlDrawer')
        .on('show.bs.modal.atlDrawer', '.modal', function() {
            var s = atlStack();
            if (!s || !atlDrawerStack.length) return;
            var $m = $(this), mid = 'bs-modal:' + (this.id || 'anon');
            $m.data('atlStackId', mid);
            s.push(mid, function() { $m.modal('hide'); });
        })
        .on('hidden.bs.modal.atlDrawer', '.modal', function() {
            var s = atlStack(), mid = $(this).data('atlStackId');
            if (!s || !mid) return;
            $(this).removeData('atlStackId');
            s.pop(mid);
        });
    $(document).off('keydown.atlDrawer').on('keydown.atlDrawer', function(e) {
        if (e.key !== 'Escape' || !atlDrawerStack.length) return;
        // Only act when a DRAWER owns the topmost layer. Without this guard, Escape pressed on a
        // confirmation dialog opened from inside a drawer closed the drawer too.
        var s = atlStack();
        var top = atlDrawerStack[atlDrawerStack.length - 1];
        if (s && !s.isTop(top.id)) return;
        top.close();
    });

// Generic Edit/Change History tab switcher, shared by every drawer that uses this two-tab
// .dv-tabs/.dv-panel toggle (Events, Banner-style Gallery/Career/Home Slider/Testimonials/
// Footprint) — one implementation instead of a per-section copy. Not the full Deal View
// dv-tab system (no lazy panel loading, no arrow-key roving tabindex) since these are always
// exactly two static panels.
window.atlActivateDrawerTab = function(drawerId, tabId) {
    $('#' + drawerId + ' .dv-tab').attr({ 'aria-selected': 'false', 'tabindex': '-1' });
    var $tab = $('#' + tabId).attr({ 'aria-selected': 'true', 'tabindex': '0' });
    $('#' + drawerId + ' .dv-panel').attr('hidden', true);
    $('#' + $tab.attr('aria-controls')).removeAttr('hidden');
};
$(document).off('click.atldrawertab').on('click.atldrawertab', '.atl-drawer .dv-tab', function() {
    var drawerId = $(this).closest('.atl-drawer').attr('id');
    window.atlActivateDrawerTab(drawerId, this.id);
});
