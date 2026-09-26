/*
 * Appearance system — three independent axes on <html>.
 *
 *     data-theme     Finish    dark (Obsidian, default) · light (Ivory) · ember (Ember)
 *     data-accent    Accent    gold (default) · vetiver · cassis · cuivre
 *     data-presence  Presence  editorial (default) · boutique · operations
 *
 * Styling lives in css/core/appearance.css. This file owns STATE: reading it,
 * validating it, writing the attributes, persisting, and telling the rest of the
 * admin to re-read colours.
 *
 * ADMIN ONLY. index.html does not load core/tokens.css (finding F1, gate G1), so
 * it cannot resolve --atl-* and has nothing for these axes to act on.
 *
 * ── STORAGE / MIGRATION ─────────────────────────────────────────────────────
 * Finish keeps the EXISTING key, 'atl-theme'. That is the migration: the values
 * already stored there are 'dark' and 'light', both of which remain valid Finish
 * values, so an admin with a saved preference lands on exactly the look they had
 * with no translation step and no chance of a mistranslation. 'ember' simply
 * joins the set. The two new axes get their own keys rather than being folded
 * into one blob, because a blob would have required rewriting the pre-paint
 * script's read path and migrating every existing value to get there.
 *
 * ── PRE-PAINT ───────────────────────────────────────────────────────────────
 * The blocking inline script at the top of admin.html applies all three
 * attributes before first paint. It has to be inline and blocking: a deferred
 * script paints Obsidian/Gold/Editorial for a frame first, which is a visible
 * flash for anyone not on the defaults. This file re-applies on load as a
 * belt-and-braces measure and owns every change from then on.
 *
 * ── SINGLE WRITER ───────────────────────────────────────────────────────────
 * Nothing else in the codebase may write these three attributes. If you need to
 * change appearance, call window.atlAppearance.set(axis, value).
 */
(function (global) {
    'use strict';

    var AXES = {
        theme:    { attr: 'data-theme',    key: 'atl-theme',    values: ['dark', 'light', 'ember'],                 def: 'dark' },
        accent:   { attr: 'data-accent',   key: 'atl-accent',   values: ['gold', 'vetiver', 'cassis', 'cuivre'],    def: 'gold' },
        presence: { attr: 'data-presence', key: 'atl-presence', values: ['editorial', 'boutique', 'operations'],    def: 'editorial' }
    };

    // Swatch colours for the picker. Two sets, because the accent you get under
    // Ivory is the deep variant — the dot must preview what will actually apply.
    var SWATCH = {
        bright: { gold: '#D4AF37', vetiver: '#8CC084', cassis: '#DB8FA6', cuivre: '#E0A07A' },
        deep:   { gold: '#8a6a14', vetiver: '#2F6B3A', cassis: '#8E2F4E', cuivre: '#9A4F1E' }
    };

    function readStored(axis) {
        var spec = AXES[axis];
        var raw = null;
        try { raw = global.localStorage.getItem(spec.key); } catch (e) { /* private mode */ }
        // Validate on read — anything not in the known set is discarded and never
        // reaches the DOM, so a stale or hand-edited value can't wedge the UI.
        return spec.values.indexOf(raw) === -1 ? spec.def : raw;
    }

    function current(axis) {
        var spec = AXES[axis];
        var v = document.documentElement.getAttribute(spec.attr);
        return spec.values.indexOf(v) === -1 ? spec.def : v;
    }

    /** Write all three attributes. The ONLY place that touches them. */
    function apply(state) {
        var el = document.documentElement;
        Object.keys(AXES).forEach(function (axis) {
            var spec = AXES[axis];
            var v = state && state[axis];
            if (spec.values.indexOf(v) === -1) v = readStored(axis);
            el.setAttribute(spec.attr, v);
        });
    }

    function get() {
        return { theme: current('theme'), accent: current('accent'), presence: current('presence') };
    }

    function set(axis, value) {
        var spec = AXES[axis];
        if (!spec || spec.values.indexOf(value) === -1) return get();
        document.documentElement.setAttribute(spec.attr, value);
        try { global.localStorage.setItem(spec.key, value); } catch (e) { /* still applies for the session */ }
        afterChange();
        return get();
    }

    function reset() {
        Object.keys(AXES).forEach(function (axis) {
            document.documentElement.setAttribute(AXES[axis].attr, AXES[axis].def);
            try { global.localStorage.removeItem(AXES[axis].key); } catch (e) {}
        });
        afterChange();
        return get();
    }

    /*
     * Everything that has to happen after ANY axis changes.
     *
     * The event name and its `theme` field are unchanged from the old two-state
     * toggle, because other code already listens for them — the two new axes are
     * added alongside rather than replacing the payload.
     *
     * The re-render calls below are carried over verbatim from that toggle's
     * handler so nothing regresses, plus the dashboard reload the old toggle did
     * NOT do: ApexCharts bakes resolved colours into its series at render time
     * and will happily keep painting the previous accent otherwise.
     */
    function afterChange() {
        var state = get();
        syncPanel();

        if (typeof global.updatePills === 'function') global.updatePills();
        if (typeof global.applyBookingFilter === 'function') global.applyBookingFilter();
        if (typeof global.adminCalendar !== 'undefined' && global.adminCalendar) {
            try { global.adminCalendar.render(); } catch (e) {}
        }
        // Charts cache colours — re-run the loaders so they re-read the tokens.
        if (typeof global.loadDashboardKPIs === 'function') { try { global.loadDashboardKPIs(); } catch (e) {} }
        if (typeof global.loadAnalyticsDashboard === 'function') { try { global.loadAnalyticsDashboard(); } catch (e) {} }

        document.dispatchEvent(new CustomEvent('atl-theme-change', {
            detail: { theme: state.theme, accent: state.accent, presence: state.presence }
        }));
    }

    // ── Panel ──────────────────────────────────────────────────────────────

    var LABEL = {
        theme:    { dark: 'Obsidian', light: 'Ivory', ember: 'Ember' },
        accent:   { gold: 'Gold', vetiver: 'Vetiver', cassis: 'Cassis', cuivre: 'Cuivre' },
        presence: { editorial: 'Editorial', boutique: 'Boutique', operations: 'Operations' }
    };
    var GROUP_LABEL = { theme: 'Finish', accent: 'House accent', presence: 'Presence' };

    function buildPanel(host) {
        if (!host || host.getAttribute('data-appearance-built') === '1') return;
        var state = get();
        var uid = 'app-' + Math.random().toString(36).slice(2, 8);
        var html = '<div class="atl-appearance">';

        Object.keys(AXES).forEach(function (axis) {
            html += '<fieldset class="atl-appearance__group">' +
                    '<legend class="atl-appearance__legend">' + GROUP_LABEL[axis] + '</legend>' +
                    '<div class="atl-appearance__options">';
            AXES[axis].values.forEach(function (v) {
                var id = uid + '-' + axis + '-' + v;
                var swatch = axis === 'accent'
                    ? '<span class="atl-appearance__swatch" data-accent-swatch="' + v + '"></span>' : '';
                html += '<input class="atl-appearance__input" type="radio" name="' + uid + '-' + axis + '"' +
                        ' id="' + id + '" value="' + v + '" data-axis="' + axis + '"' +
                        (state[axis] === v ? ' checked' : '') + '>' +
                        '<label class="atl-appearance__option" for="' + id + '">' + swatch +
                        '<span>' + LABEL[axis][v] + '</span>' +
                        '<i class="fa-solid fa-check atl-appearance__check" aria-hidden="true"></i></label>';
            });
            html += '</div></fieldset>';
        });

        html += '<button type="button" class="atl-appearance__reset">Reset to house default</button>' +
                '<p class="atl-appearance__status tm-sr-only" role="status" aria-live="polite"></p>' +
                '</div>';
        host.innerHTML = html;
        host.setAttribute('data-appearance-built', '1');
        syncPanel();
    }

    /** Push current state back into every rendered panel (there can be two). */
    function syncPanel() {
        var state = get();
        var deep = state.theme === 'light';
        document.querySelectorAll('.atl-appearance__input').forEach(function (input) {
            input.checked = (state[input.getAttribute('data-axis')] === input.value);
        });
        // Swatches preview the variant that will actually apply under this Finish.
        document.querySelectorAll('[data-accent-swatch]').forEach(function (dot) {
            var name = dot.getAttribute('data-accent-swatch');
            dot.style.background = (deep ? SWATCH.deep : SWATCH.bright)[name] || '';
        });
    }

    function announce(msg) {
        document.querySelectorAll('.atl-appearance__status').forEach(function (el) { el.textContent = msg; });
    }

    // Delegated, so both panel instances are covered and neither needs re-binding.
    document.addEventListener('change', function (e) {
        var input = e.target;
        if (!input || !input.classList || !input.classList.contains('atl-appearance__input')) return;
        var axis = input.getAttribute('data-axis');
        set(axis, input.value);
        announce(LABEL[axis][input.value] + ' applied');
    });

    document.addEventListener('click', function (e) {
        var btn = e.target && e.target.closest && e.target.closest('.atl-appearance__reset');
        if (!btn) return;
        reset();
        announce('Reset to house default: Obsidian, Gold, Editorial');
    });

    global.atlAppearance = {
        apply: apply, get: get, set: set, reset: reset,
        buildPanel: buildPanel, syncPanel: syncPanel,
        AXES: AXES, SWATCH: SWATCH
    };

    // Re-assert on load. The pre-paint script has already done this; repeating it
    // costs nothing and covers the case where markup was replaced after paint.
    apply(get());

    // The Preferences copy is always visible once its section is shown, so it is built
    // eagerly. The header popover builds lazily on first open — building it up front
    // would put a second set of radios in the DOM for a control most sessions never use.
    function buildPrefsPanel() {
        var host = document.getElementById('atlAppearancePanelPrefs');
        if (host) buildPanel(host);
    }
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', buildPrefsPanel);
    } else {
        buildPrefsPanel();
    }
})(window);
