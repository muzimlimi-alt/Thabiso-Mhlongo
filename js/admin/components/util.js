/* Phase 7 Component 5 (FilterBar) — shared admin helpers (HOUSEKEEPING-NOTES.md "Component 5").
 *
 * `debounce` is `lcDebounce` (js/admin/legal-compliance.js) promoted verbatim — trailing debounce,
 * forwards `this` and `arguments` to `fn`, one persistent timer per returned closure. Proven in
 * production (the legal-compliance search box) before promotion.
 *
 * Status: referenced nowhere. Inert until a section's hand-rolled `clearTimeout/setTimeout` search
 * debounce is swapped to `window.debounce(fn, ms)` — see the 6 drop-in rewrites in HOUSEKEEPING-NOTES.md.
 * The live session that does the swaps also adds the <script src> for this file to admin.html.
 */
(function () {
    'use strict';

    window.debounce = function (fn, ms) {
        var t;
        return function () {
            var a = arguments, c = this;
            clearTimeout(t);
            t = setTimeout(function () { fn.apply(c, a); }, ms);
        };
    };
})();
