/* Phase 7 Component 2 — Pagination (HOUSEKEEPING-NOTES.md "Component 2" section).
 *
 * A configurable renderer for the 10 admin pagination implementations inventoried in
 * HOUSEKEEPING-NOTES.md, in two families:
 *   - mode:'numbered'  — prev + [1..N with ellipsis] + next, buttons built dynamically   (A1–A7)
 *   - mode:'prevnext'  — enable/disable two markup-authored buttons + a "from–to of total" label (B1–B3)
 *
 * Built to REPRODUCE every existing variant through configuration, not to standardise the
 * differences away (e.g. email-logs' '...' / #555 / no->7-guard ellipsis is kept as config, not
 * "fixed"). See the per-impl config mapping in HOUSEKEEPING-NOTES.md.
 *
 * Status when created: referenced nowhere — additive and inert until a section's
 * `renderX*Pagination` is rewritten to `new Pagination({...}).render(...)`. Vanilla core; jQuery
 * call sites pass `$el[0]` or a selector string.
 *
 *   const pg = new Pagination(config);
 *   pg.render(totalPages);              // mode:'numbered'
 *   pg.render(total, pages);            // mode:'prevnext'
 */
(function () {
    'use strict';

    function resolveEl(ref) {
        if (!ref) return null;
        if (typeof ref === 'string') return document.querySelector(ref);
        if (ref.jquery) return ref[0] || null;
        return ref;
    }

    function Pagination(config) {
        if (!config || (config.mode !== 'numbered' && config.mode !== 'prevnext')) {
            throw new Error('Pagination: config.mode must be "numbered" or "prevnext"');
        }
        this.cfg = config;
    }

    Pagination.prototype._container = function () {
        var el = resolveEl(this.cfg.container);
        if (!el && this.cfg.containerFallback) el = resolveEl(this.cfg.containerFallback);
        return el;
    };

    /* ---------- mode: 'numbered' (A1–A7) ---------- */

    // ellipsis: 'none'  — every page number shown                              (A4 umlog)
    //           'gt6'   — collapse 6..N-1 whenever any such i exists (i>5 && i<N, no N guard)  (A1 email-logs)
    //           'gt7'   — collapse only when N > 7  (N>7 && i>5 && i<N)          (A2 A3 A5 A6 A7)
    Pagination.prototype._collapsed = function (i, totalPages) {
        var mode = this.cfg.ellipsis || 'gt7';
        if (mode === 'none') return false;
        if (mode === 'gt6') return i > 5 && i < totalPages;
        return totalPages > 7 && i > 5 && i < totalPages;   // 'gt7'
    };

    Pagination.prototype._navBtn = function (iconClass, disabled) {
        var b = document.createElement('button');
        b.className = 'um-btn um-btn--ghost' + (this.cfg.sizeSm ? ' um-btn--sm' : '') + (disabled ? ' disabled' : '');
        b.innerHTML = '<i class="' + iconClass + '"></i>';
        return b;
    };

    Pagination.prototype._numBtn = function (n, curPage) {
        var b = document.createElement('button');
        b.className = 'um-btn' + (this.cfg.sizeSm ? ' um-btn--sm' : '') + ' ' + (n === curPage ? 'um-btn--primary' : 'um-btn--ghost');
        b.textContent = String(n);
        return b;
    };

    Pagination.prototype._renderNumbered = function (totalPages) {
        var container = this._container();
        if (!container) return;

        if (this.cfg.displayToggle) {
            container.style.display = totalPages > 1 ? 'flex' : 'none';
        }
        container.innerHTML = '';
        if (totalPages <= 1) return;

        var self = this;
        var curPage = this.cfg.getPage();
        var iconL = this.cfg.iconStyle === 'fa-solid' ? 'fa-solid fa-chevron-left'  : 'fa fa-chevron-left';
        var iconR = this.cfg.iconStyle === 'fa-solid' ? 'fa-solid fa-chevron-right' : 'fa fa-chevron-right';

        var prev = this._navBtn(iconL, curPage === 1);
        prev.onclick = function () { var c = self.cfg.getPage(); if (c > 1) self.cfg.onGoto(c - 1); };
        container.appendChild(prev);

        var glyph = this.cfg.ellipsisGlyph || '…';
        var ellColor = (this.cfg.ellipsisColor != null) ? this.cfg.ellipsisColor : 'var(--atl-muted)';
        var ellPad = (this.cfg.ellipsisPadding != null) ? this.cfg.ellipsisPadding : '0 4px';

        for (var i = 1; i <= totalPages; i++) {
            if (this._collapsed(i, totalPages)) {
                if (i === 6) {
                    var sp = document.createElement('span');
                    sp.textContent = glyph;
                    if (ellColor) sp.style.color = ellColor;
                    if (ellPad) sp.style.padding = ellPad;
                    container.appendChild(sp);
                }
                continue;
            }
            (function (p) {
                var b = self._numBtn(p, curPage);
                b.onclick = function () { self.cfg.onGoto(p); };
                container.appendChild(b);
            })(i);
        }

        var next = this._navBtn(iconR, curPage === totalPages);
        next.onclick = function () { var c = self.cfg.getPage(); if (c < totalPages) self.cfg.onGoto(c + 1); };
        container.appendChild(next);
    };

    /* ---------- mode: 'prevnext' (B1–B3) ---------- */

    Pagination.prototype._renderPrevNext = function (total, pages) {
        var container = this._container();
        var prevEl = resolveEl(this.cfg.prevEl);
        var nextEl = resolveEl(this.cfg.nextEl);
        var infoEl = resolveEl(this.cfg.infoEl);

        if (this.cfg.hideWhenEmpty !== false && (total == null || total <= 0)) {
            if (container) container.style.display = 'none';
            return;
        }

        var page = this.cfg.getPage();
        var size = this.cfg.pageSize || 50;
        var from = (page - 1) * size + 1;
        var to = Math.min(page * size, total);

        if (infoEl) {
            var fmt = this.cfg.infoFormat;
            infoEl.textContent = (typeof fmt === 'function')
                ? fmt(from, to, total)
                : from + '–' + to + ' of ' + total;   // "from–to of total"
        }
        if (prevEl) prevEl.disabled = page <= 1;
        if (nextEl) nextEl.disabled = page >= pages;
        if (container) container.style.display = this.cfg.display || 'flex';
    };

    /* ---------- entry point ---------- */

    Pagination.prototype.render = function (a, b) {
        if (this.cfg.mode === 'numbered') return this._renderNumbered(a);      // a = totalPages
        return this._renderPrevNext(a, b);                                    // a = total, b = pages
    };

    window.Pagination = Pagination;
})();
