/* Phase 7 Component 1 — DataTable (HOUSEKEEPING-NOTES.md "Phase 7" section).
 *
 * A configurable renderer for the 12 admin table implementations inventoried in HOUSEKEEPING-NOTES.md.
 * It is deliberately built to REPRODUCE every existing variant through configuration, not to
 * standardise the differences away — where two of the originals differ, this component supports both.
 *
 * Status when created: no call site migrated yet. This file is additive and inert until a section's
 * render function is rewritten to `new DataTable({...})`. Migration order and per-table config
 * mapping are in HOUSEKEEPING-NOTES.md.
 *
 * Vanilla core (no jQuery). jQuery call sites pass `$el[0]` or a selector string.
 *
 *   const dt = new DataTable(config);   // see the config shape in HOUSEKEEPING-NOTES.md
 *   dt.reload();                        // (re)render — the main entry point
 *   dt.setSort('email');               // toggle/set sort column, then reload
 *   dt.getSelectedIds();               // string[] of selected row ids (bulk-select tables)
 *   dt.setSearch('foo'); dt.setPage(2);
 *   dt.destroy();
 */
(function () {
    'use strict';

    function resolveEl(ref) {
        if (!ref) return null;
        if (typeof ref === 'string') return document.querySelector(ref);
        if (ref.jquery) return ref[0] || null;      // a jQuery object passed directly
        return ref;                                  // assume an Element
    }

    function escHtml(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    function DataTable(config) {
        if (!config || (!config.client && !config.server)) {
            throw new Error('DataTable: config needs exactly one of `client` or `server`');
        }
        if (config.client && config.server) {
            throw new Error('DataTable: config has both `client` and `server` — pick one');
        }
        this.cfg = config;
        this.bodyEl = resolveEl(config.body);
        this.tableEl = resolveEl(config.table);
        this.statsEl = config.stats ? resolveEl(config.stats.el) : null;
        this.countEl = resolveEl(config.countEl);
        this.siblingEl = (config.states && config.states.idiom === 'sibling-el')
            ? resolveEl(config.states.siblingEl) : null;

        // Owned state for bulk-select store:'map'
        this._selected = Object.create(null);

        // Owned paging state (server tables track page here; client tables read pageSize from cfg)
        this._page = 1;
        this._search = '';
        this._destroyed = false;

        if (!this.bodyEl) {
            // Not a hard error — the section markup for this tab may just not be in the DOM yet.
            // reload() will no-op until it is.
        }
    }

    DataTable.prototype._colspan = function () {
        if (this.cfg.colspan) return this.cfg.colspan;
        if (Array.isArray(this.cfg.columns)) return this.cfg.columns.length;
        return 1;
    };

    /* ---- empty / loading / error rendering — three idioms ---- */

    DataTable.prototype._stateBody = function (kind, searchActive) {
        // kind: 'loading' | 'empty' | 'error'
        var st = (this.cfg.states && this.cfg.states[kind]) || {};
        var idiom = (this.cfg.states && this.cfg.states.idiom) || 'row-text';
        var msg = st.message || '';
        if (kind === 'empty' && searchActive && st.altMessage) msg = st.altMessage;
        var icon = st.icon || '';
        var sub = st.subMessage || '';

        if (idiom === 'sibling-el') {
            // The <table> is hidden; a separate element carries the state.
            if (this.tableEl) this.tableEl.style.display = 'none';
            if (this.bodyEl) this.bodyEl.innerHTML = '';
            if (this.siblingEl) {
                this.siblingEl.innerHTML =
                    '<i class="' + escHtml(icon) + '" style="font-size:22px;color:var(--atl-amber);display:block;margin-bottom:8px;"></i>' +
                    '<p style="color:var(--atl-muted);margin:0;">' + escHtml(msg) + '</p>' +
                    (sub ? '<p style="color:var(--atl-muted-dim);font-size:12px;margin:4px 0 0;">' + escHtml(sub) + '</p>' : '');
                this.siblingEl.style.display = '';
            }
            return;
        }

        if (this.siblingEl) this.siblingEl.style.display = 'none';
        if (this.tableEl) this.tableEl.style.display = '';
        if (!this.bodyEl) return;

        var cs = this._colspan();
        if (idiom === 'row-component') {
            // <tr><td colspan=N> wrapping the .atl-empty-state component (icon / display / sub)
            var clr = kind === 'error' ? 'var(--atl-clay)' : 'var(--atl-muted)';
            this.bodyEl.innerHTML =
                '<tr><td colspan="' + cs + '" style="border:none;">' +
                    '<div class="atl-empty-state">' +
                        '<i class="' + escHtml(icon) + '" style="font-size:32px; color:' + clr + '; opacity:0.5;"></i>' +
                        '<p class="atl-empty-display">' + escHtml(msg) + '</p>' +
                        (sub ? '<p class="atl-empty-sub">' + escHtml(sub) + '</p>' : '') +
                    '</div>' +
                '</td></tr>';
            return;
        }

        // 'row-text' (default): <tr><td colspan=N> with an icon and a line of text
        var textClr = kind === 'error' ? 'var(--atl-clay)' : 'var(--atl-muted)';
        this.bodyEl.innerHTML =
            '<tr><td colspan="' + cs + '" class="text-center" style="padding:40px 20px; border:none; color:' + textClr + ';">' +
                (icon ? '<i class="' + escHtml(icon) + '" style="font-size:24px; display:block; margin-bottom:10px; opacity:0.6;"></i>' : '') +
                escHtml(msg) +
            '</td></tr>';
    };

    /* ---- row rendering ---- */

    DataTable.prototype._rowHtml = function (row, idx) {
        var cfg = this.cfg;
        var ctx = { index: idx, selected: this._isSelected(row), table: this };

        if (typeof cfg.renderRow === 'function') {
            return cfg.renderRow(row, ctx);
        }

        var tds = (cfg.columns || []).map(function (col) {
            return typeof col.render === 'function' ? col.render(row, ctx) : '<td></td>';
        }).join('');

        var attrs = (typeof cfg.rowAttrs === 'function' && cfg.rowAttrs(row)) || {};
        var attrStr = Object.keys(attrs).map(function (k) {
            return ' ' + k + '="' + escHtml(attrs[k]) + '"';
        }).join('');
        return '<tr' + attrStr + '>' + tds + '</tr>';
    };

    /* ---- bulk-select ---- */

    DataTable.prototype._selCfg = function () { return this.cfg.select || null; };

    DataTable.prototype._isSelected = function (row) {
        var sc = this._selCfg();
        if (!sc) return false;
        if (sc.store === 'map') return !!this._selected[sc.rowId(row)];
        return false; // 'live' — the checkbox's own state is the source of truth, read at action time
    };

    DataTable.prototype.getSelectedIds = function () {
        var sc = this._selCfg();
        if (!sc) return [];
        if (sc.store === 'map') return Object.keys(this._selected);
        // 'live': read the DOM
        if (!this.bodyEl || !sc.checkboxSelector) return [];
        return Array.prototype.slice.call(this.bodyEl.querySelectorAll(sc.checkboxSelector))
            .filter(function (cb) { return cb.checked; })
            .map(function (cb) { return cb.getAttribute('data-id'); });
    };

    DataTable.prototype.clearSelection = function () {
        this._selected = Object.create(null);
        var sc = this._selCfg();
        if (sc && sc.store === 'live' && this.bodyEl && sc.checkboxSelector) {
            this.bodyEl.querySelectorAll(sc.checkboxSelector).forEach(function (cb) { cb.checked = false; });
        }
    };

    DataTable.prototype._wireSelection = function () {
        var sc = this._selCfg();
        if (!sc || !this.bodyEl || !sc.checkboxSelector) return;
        var self = this;
        this.bodyEl.querySelectorAll(sc.checkboxSelector).forEach(function (cb) {
            cb.addEventListener('change', function () {
                if (sc.store === 'map') {
                    var id = this.getAttribute('data-id');
                    if (this.checked) self._selected[id] = true; else delete self._selected[id];
                }
                if (typeof sc.onChange === 'function') sc.onChange();
            });
        });
    };

    /* ---- sort ---- */

    DataTable.prototype.setSort = function (col) {
        var s = this.cfg.sort;
        if (!s || !s.state) return;
        if (s.state.col === col) {
            s.state.order = (s.state.order === 'ASC') ? 'DESC' : 'ASC';
        } else {
            s.state.col = col;
            s.state.order = 'DESC';
        }
        this._page = 1;
        this.reload();
    };

    DataTable.prototype._updateSortIcons = function () {
        var s = this.cfg.sort;
        if (!s || typeof s.iconTarget !== 'function' || !Array.isArray(this.cfg.columns)) return;
        var state = s.state || {};
        this.cfg.columns.forEach(function (col) {
            if (!col.sortable) return;
            var el = document.getElementById(s.iconTarget(col.key));
            if (!el) return;
            var active = state.col === col.key;
            el.className = active
                ? 'fa-solid fa-sort-' + (state.order === 'ASC' ? 'up' : 'down')
                : 'fa-solid fa-sort';
            el.style.opacity = active ? '1' : '0.5';
        });
    };

    /* ---- stats / count ---- */

    DataTable.prototype._updateStats = function (start, end, total) {
        if (this.countEl && typeof this.cfg.countText === 'function') {
            this.countEl.textContent = this.cfg.countText(total);
        } else if (this.countEl) {
            this.countEl.textContent = String(total);
        }
        if (!this.statsEl || !this.cfg.stats) return;
        var joiner = this.cfg.stats.format === 'X-Y' ? '-' : ' to ';
        this.statsEl.textContent = total === 0
            ? 'Showing 0' + (joiner === '-' ? '-0' : ' to 0') + ' of 0 entries'
            : 'Showing ' + start + joiner + end + ' of ' + total + ' entries';
    };

    /* ---- the main render ---- */

    DataTable.prototype.setPage = function (n) { this._page = Math.max(1, n | 0); return this.reload(); };
    DataTable.prototype.setSearch = function (str) { this._search = str || ''; this._page = 1; return this.reload(); };

    DataTable.prototype.reload = function () {
        if (this._destroyed) return Promise.resolve();
        this.bodyEl = this.bodyEl || resolveEl(this.cfg.body);
        if (!this.bodyEl) return Promise.resolve();

        var self = this;
        var cfg = this.cfg;
        var searchActive = !!this._search ||
            (cfg.sort && cfg.sort.state && false); // search-active is caller-driven via setSearch

        this._stateBody('loading', searchActive);

        var sortState = (cfg.sort && cfg.sort.state) || {};

        if (cfg.client) {
            // synchronous path
            try {
                var all = cfg.client.rows() || [];
                var size = cfg.client.pageSize || all.length || 1;
                var totalC = all.length;
                var totalPagesC = Math.max(1, Math.ceil(totalC / size));
                if (this._page > totalPagesC) this._page = totalPagesC;
                var startIdxC = (this._page - 1) * size;
                var pageRowsC = all.slice(startIdxC, startIdxC + size);
                this._paint(pageRowsC, {
                    total: totalC, totalPages: totalPagesC,
                    start: totalC === 0 ? 0 : startIdxC + 1,
                    end: startIdxC + pageRowsC.length,
                    searchActive: searchActive
                });
                return Promise.resolve();
            } catch (e) {
                if (window.console) console.error('[DataTable] client render failed:', e);
                this._stateBody('error', searchActive);
                return Promise.resolve();
            }
        }

        // server path
        var params = {
            page: this._page,
            limit: cfg.server.pageSize,
            sort: sortState.col,
            order: sortState.order,
            search: this._search || undefined
        };
        var extra = (typeof cfg.server.extraParams === 'function' && cfg.server.extraParams()) || null;
        if (extra) Object.keys(extra).forEach(function (k) {
            if (extra[k] != null && extra[k] !== '') params[k] = extra[k];
        });

        return Promise.resolve(cfg.server.fetch(params)).then(function (res) {
            if (self._destroyed) return;
            var rows = (res && res.rows) || [];
            var total = (res && res.total) || 0;
            var totalPages = (res && res.totalPages) || Math.max(1, Math.ceil(total / cfg.server.pageSize));
            var startIdx = total === 0 ? 0 : (self._page - 1) * cfg.server.pageSize + 1;
            var endIdx = Math.min(self._page * cfg.server.pageSize, total);
            self._paint(rows, { total: total, totalPages: totalPages, start: startIdx, end: endIdx, searchActive: searchActive });
        }).catch(function (e) {
            if (self._destroyed) return;
            if (window.console) console.error('[DataTable] server fetch failed:', e);
            self._stateBody('error', searchActive);
        });
    };

    DataTable.prototype._paint = function (rows, info) {
        if (!this.bodyEl) return;

        if (!rows || rows.length === 0) {
            this._stateBody('empty', info.searchActive);
            this._updateStats(0, 0, info.total);
            this._updateSortIcons();
            if (typeof this.cfg.pagination === 'function') this.cfg.pagination({ page: this._page, totalPages: info.totalPages, total: info.total });
            if (typeof this.cfg.onRender === 'function') this.cfg.onRender(this.bodyEl, []);
            return;
        }

        if (this.tableEl) this.tableEl.style.display = '';
        if (this.siblingEl) this.siblingEl.style.display = 'none';

        var self = this;
        this.bodyEl.innerHTML = rows.map(function (row, i) { return self._rowHtml(row, i); }).join('');

        this._updateStats(info.start, info.end, info.total);
        this._updateSortIcons();
        this._wireSelection();
        if (typeof this.cfg.pagination === 'function') {
            this.cfg.pagination({ page: this._page, totalPages: info.totalPages, total: info.total });
        }
        if (typeof this.cfg.onRender === 'function') this.cfg.onRender(this.bodyEl, rows);
    };

    DataTable.prototype.destroy = function () {
        this._destroyed = true;
        this._selected = Object.create(null);
    };

    window.DataTable = DataTable;
})();
