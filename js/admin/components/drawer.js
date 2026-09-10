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
    let atlDrawerZ = 1050;
    let atlDrawerStack = [];
    function atlDrawerPush(id, closeFn) {
        atlDrawerStack = atlDrawerStack.filter(function(e) { return e.id !== id; });
        atlDrawerStack.push({ id: id, close: closeFn });
        document.body.style.overflow = 'hidden';
        atlDrawerZ += 2;
        return { backdropZ: atlDrawerZ, drawerZ: atlDrawerZ + 1 };
    }
    function atlDrawerPop(id) {
        atlDrawerStack = atlDrawerStack.filter(function(e) { return e.id !== id; });
        if (!atlDrawerStack.length) document.body.style.overflow = '';
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
            if ($target.length) { $target.trigger('focus'); return; }
            if (!$el.attr('tabindex')) $el.attr('tabindex', '-1');
            $el.trigger('focus');
        }, 50);
    }

    window.openAtlDrawer = function(id) {
        var $drawer = $('#' + id);
        var $backdrop = $('#' + id + 'Backdrop');
        var z = atlDrawerPush(id, function() { closeAtlDrawer(id); });
        $backdrop.css('z-index', z.backdropZ).fadeIn(200);
        $drawer.css('z-index', z.drawerZ).addClass('atl-drawer--open');
        $drawer.find('.atl-drawer__body').scrollTop(0);
        document.dispatchEvent(new CustomEvent('atl:drawerOpened', { detail: { id: id } }));
        atlDrawerFocusEntry({ id: id });
    };
    window.closeAtlDrawer = function(id) {
        $('#' + id).removeClass('atl-drawer--open');
        $('#' + id + 'Backdrop').fadeOut(200);
        atlDrawerFocusEntry(atlDrawerPop(id));
        document.dispatchEvent(new CustomEvent('atl:drawerClosed', { detail: { id: id } }));
    };
    $(document).off('keydown.atlDrawer').on('keydown.atlDrawer', function(e) {
        if (e.key !== 'Escape' || !atlDrawerStack.length) return;
        atlDrawerStack[atlDrawerStack.length - 1].close();
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
