/*
 * Accolades & Recognition — admin controller (#accoladesAdmin section + #aclDrawer editor, admin.html).
 *
 * Same architecture as the other content sections (closest: js/admin/team.js): cards + the shared
 * slide-out drawer, built on the shared admin globals — apiCall, uploadFileToServer (the shared /upload
 * route, section=accolades), openAtlDrawer / closeAtlDrawer / atlActivateDrawerTab
 * (js/admin/components/drawer.js), loadChangeHistoryCard (js/admin/security-audit.js) and
 * window.notificationService — plus the shared Pagination component (js/admin/components/pagination.js)
 * and window.debounce (js/admin/components/util.js). The live preview is drawn by js/accolades-view.js,
 * the renderer the public site uses.
 *
 * The server decides what is public and in which order (lib/accolades.js, via GET /api/admin/accolades).
 * This file only searches, filters, sorts and pages the list it is given, and never re-derives "is this
 * on the website?" — is_public / public_position come from the server.
 *
 * Values are put into the DOM as text or through esc(): the server stores exactly what the admin typed
 * (see lib/accolades.js), so nothing here may build markup from them unescaped.
 */
(function () {
    'use strict';

    var PAGE_SIZE = 10;
    var MAX_UPLOAD_BYTES = 15 * 1024 * 1024;          // the shared upload limit (lib/uploads.js)
    var CAT_LABELS = { win: 'Win', nomination: 'Nomination', accolade: 'Accolade' };
    var MEDIA = {
        image:             { input: 'aclImageFile', preview: 'aclImagePreview', text: 'aclImageText', err: 'aclImageErr', label: 'Achievement image', prompt: 'Drag & drop or select an image', accept: 'image' },
        organisation_logo: { input: 'aclLogoFile',  preview: 'aclLogoPreview',  text: 'aclLogoText',  err: 'aclLogoErr',  label: 'Organisation logo', prompt: 'Drag & drop or select a logo', accept: 'image' },
        certificate_file:  { input: 'aclCertFile',  preview: 'aclCertPreview',  text: 'aclCertText',  err: 'aclCertErr',  label: 'Certificate', prompt: 'Drag & drop or select a PDF or image', accept: 'cert' }
    };
    // API field -> form control id (its error element is the same id + "Err").
    var FIELDS = {
        title: 'aclTitle', category: 'aclCategory', year: 'aclYear', achievement_date: 'aclDate', result: 'aclResult',
        organisation: 'aclOrganisation', event_name: 'aclEvent', location: 'aclLocation', description: 'aclDescription',
        external_url: 'aclExternalUrl', source_url: 'aclSourceUrl', display_order: 'aclDisplayOrder'
    };
    var TEXT_DEFAULT_LIMITS = { title: 160, organisation: 160, event_name: 160, result: 80, location: 120, description: 2000, url: 500 };

    var state = {
        items: [], sectionVisible: true, limits: {}, loaded: false,
        search: '', category: '', year: '', status: '', featured: '', sort: 'site', page: 1,
        selecting: false, selected: {}
    };
    var editor = { id: null, saving: false, media: {} };
    var pager = null;
    var menu = { el: null, forId: null, trigger: null };

    // ── helpers ──
    function esc(s) {
        return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }
    function notify(kind, msg) {
        if (!window.notificationService) return;
        if (kind === 'error') window.notificationService.showError(msg);
        else window.notificationService.showSuccess(msg);
    }
    function el(id) { return document.getElementById(id); }
    function val(id) { var e = el(id); return e ? String(e.value || '').trim() : ''; }
    function switchOn(id) { return $('#' + id).attr('aria-checked') === 'true'; }
    function setSwitch(id, on) { $('#' + id).attr('aria-checked', on ? 'true' : 'false'); }
    function limit(k) { return (state.limits && state.limits[k]) || TEXT_DEFAULT_LIMITS[k]; }
    function byId(id) {
        for (var i = 0; i < state.items.length; i++) if (String(state.items[i].id) === String(id)) return state.items[i];
        return null;
    }
    function catOf(item) { return CAT_LABELS[item && item.category] ? item.category : 'accolade'; }
    // SQLite CURRENT_TIMESTAMP is UTC, 'YYYY-MM-DD HH:MM:SS'.
    function parseTs(ts) {
        if (!ts) return NaN;
        var s = String(ts);
        return Date.parse(/[T ]/.test(s) && !/[zZ]$|[+-]\d\d:?\d\d$/.test(s) ? s.replace(' ', 'T') + 'Z' : s);
    }
    function fmtDay(ts) {
        var t = parseTs(ts);
        return isNaN(t) ? '' : new Date(t).toLocaleDateString('en-ZA', { year: 'numeric', month: 'short', day: 'numeric' });
    }
    function isAdministrator() { return window.currentUserRole === 'administrator'; }
    function siteIds() { return state.items.map(function (a) { return Number(a.id); }); }

    // ── load ──
    async function loadAccolades() {
        var $list = $('#adminAccoladesList');
        if (!$list.length) return;
        try {
            var data = await apiCall('/api/admin/accolades');
            state.items = (data && Array.isArray(data.accolades)) ? data.accolades : [];
            state.sectionVisible = !(data && data.section_visible === false);
            state.limits = (data && data.limits) || {};
            state.loaded = true;
            syncYearFilter();
            renderNotice();
            render();
        } catch (err) {
            console.error('Failed to load accolades:', err);
            $list.html('<div class="atl-empty-state">'
                + '<i class="fa-solid fa-triangle-exclamation" style="font-size:28px; color:var(--atl-clay); margin-bottom:14px; display:block;" aria-hidden="true"></i>'
                + '<p style="color:var(--atl-muted); margin:0; font-size:13px;">Could not load the accolades. Please refresh and try again.</p></div>');
            $('#aclResultsMeta').text('');
            $('#aclPagination').hide();
        }
    }
    window.loadAccolades = loadAccolades;

    function syncYearFilter() {
        var $sel = $('#aclFilterYear');
        var current = $sel.val() || '';
        var years = [];
        state.items.forEach(function (a) { if (years.indexOf(a.year) === -1) years.push(a.year); });
        years.sort(function (a, b) { return b - a; });
        $sel.empty().append($('<option value="">').text('All years'));
        years.forEach(function (y) { $sel.append($('<option>').attr('value', String(y)).text(String(y))); });
        if (current && years.map(String).indexOf(current) === -1) current = '';
        $sel.val(current);
        state.year = current;
    }

    function renderNotice() {
        var $n = $('#aclSectionNotice');
        var live = state.items.filter(function (a) { return a.is_public; }).length;
        if (!state.sectionVisible) {
            $n.removeClass('acl-notice--info').html('<i class="fa-solid fa-triangle-exclamation" aria-hidden="true"></i><span>The <strong>Accolades &amp; Recognition</strong> section is switched off in <strong>Settings &rarr; Website Sections</strong>, so nothing below is shown on the public site until it is switched back on.</span>').prop('hidden', false);
        } else if (state.items.length && !live) {
            $n.addClass('acl-notice--info').html('<i class="fa-solid fa-circle-info" aria-hidden="true"></i><span>Nothing is published yet, so the section is hidden on the website. Switch an accolade to <strong>Active</strong> to show it.</span>').prop('hidden', false);
        } else {
            $n.prop('hidden', true).empty();
        }
    }

    // ── list: search / filter / sort / page ──
    function stamp(a) { var t = parseTs(a.updated_at || a.created_at); return isNaN(t) ? 0 : t; }

    function visibleList() {
        var q = state.search.trim().toLowerCase();
        var index = {};
        state.items.forEach(function (a, i) { index[a.id] = i; });   // website order, the tie-breaker
        var list = state.items.filter(function (a) {
            if (state.category && catOf(a) !== state.category) return false;
            if (state.year && String(a.year) !== state.year) return false;
            if (state.status === 'active' && !a.is_public) return false;
            if (state.status === 'inactive' && a.is_public) return false;
            if (state.featured === '1' && a.featured != 1) return false;
            if (state.featured === '0' && a.featured == 1) return false;
            if (q) {
                var hay = [a.title, a.organisation, a.event_name, a.result, a.location, a.description, a.year, CAT_LABELS[catOf(a)]].join(' ').toLowerCase();
                if (hay.indexOf(q) === -1) return false;
            }
            return true;
        });
        var site = function (a, b) { return index[a.id] - index[b.id]; };
        var cmp = {
            site: site,
            year_desc: function (a, b) { return (b.year - a.year) || site(a, b); },
            year_asc: function (a, b) { return (a.year - b.year) || site(a, b); },
            title: function (a, b) { return String(a.title).localeCompare(String(b.title), undefined, { sensitivity: 'base' }) || site(a, b); },
            updated: function (a, b) { return (stamp(b) - stamp(a)) || site(a, b); }
        }[state.sort] || site;
        return list.sort(cmp);
    }

    function filtersActive() {
        return !!(state.search.trim() || state.category || state.year || state.status || state.featured);
    }

    function cardHtml(item) {
        var id = Number(item.id);
        var title = esc(item.title);
        var cat = catOf(item);
        var sub = [item.organisation, item.result, item.event_name].filter(Boolean).map(esc).join(' &middot; ');
        var V = window.AccoladesView;
        var thumbSrc = V ? (V.safeMedia(item.image) || V.safeMedia(item.organisation_logo)) : '';
        var status;
        if (!item.is_public) status = '<span class="atl-badge atl-badge--unpaid" title="Inactive accolades are not shown on the website">Hidden &middot; Inactive</span>';
        else if (!state.sectionVisible) status = '<span class="atl-badge atl-badge--info" title="Active, but the whole section is switched off in Settings">Active &middot; section off</span>';
        else status = '<span class="atl-badge atl-badge--confirmed" title="Shown on the website">Live on site</span>';
        var featured = item.featured == 1 ? '<span class="atl-badge atl-badge--info"><i class="fa-solid fa-star" aria-hidden="true"></i> Featured</span>' : '';
        var meta = [item.is_public && item.public_position ? 'Site position ' + item.public_position : 'Not on site'];
        if (item.updated_at) meta.push('Updated ' + esc(fmtDay(item.updated_at)) + (item.updated_by_name ? ' by ' + esc(item.updated_by_name) : ''));
        else if (item.created_at) meta.push('Added ' + esc(fmtDay(item.created_at)) + (item.created_by_name ? ' by ' + esc(item.created_by_name) : ''));
        var selected = !!state.selected[id];
        return ''
            + '<article class="atl-edit-card acl-card' + (item.featured == 1 ? ' acl-card--featured' : '') + (selected ? ' is-selected' : '') + '" data-id="' + id + '" data-year="' + esc(item.year) + '">'
            +   '<div class="atl-card-inner"><div class="atl-edit-card__header">'
            +     '<label class="acl-select" title="Select"><input type="checkbox" class="acl-select-cb" data-id="' + id + '"' + (selected ? ' checked' : '') + ' aria-label="Select ' + title + '"></label>'
            +     '<span class="atl-drag-handle acl-drag" draggable="true" title="Drag to reorder within ' + esc(item.year) + '" aria-hidden="true"><i class="fa-solid fa-grip-vertical"></i></span>'
            +     '<div class="acl-card__year">' + esc(item.year) + '</div>'
            +     (thumbSrc ? '<div class="acl-card__thumb"><img src="' + esc(thumbSrc) + '" alt="" loading="lazy"></div>' : '')
            +     '<div class="acl-card__main">'
            +       '<h3 class="atl-edit-card__title">' + title + '</h3>'
            +       (sub ? '<p class="atl-edit-card__subtitle">' + sub + '</p>' : '')
            +       '<div class="acl-card__badges"><span class="acl-cat acl-cat--' + cat + '">' + CAT_LABELS[cat] + '</span> ' + featured + ' ' + status + '</div>'
            +       '<p class="acl-card__meta">' + meta.join(' &middot; ') + '</p>'
            +     '</div>'
            +     '<div class="acl-card__actions">'
            +       '<button type="button" class="atl-btn atl-btn--ghost um-btn--sm acl-edit-btn" data-id="' + id + '" aria-label="Edit ' + title + '"><i class="fa-solid fa-pen" aria-hidden="true"></i> Edit</button>'
            +       '<button type="button" class="atl-btn atl-btn--ghost um-btn--sm acl-more-btn" data-id="' + id + '" aria-haspopup="menu" aria-expanded="false" aria-controls="aclMoreMenu" aria-label="More actions for ' + title + '"><i class="fa-solid fa-ellipsis-vertical" aria-hidden="true"></i> More</button>'
            +     '</div>'
            +   '</div></div>'
            + '</article>';
    }

    function getPager() {
        if (!pager && window.Pagination) {
            pager = new window.Pagination({
                mode: 'numbered', container: '#aclPagination', displayToggle: true, sizeSm: true, iconStyle: 'fa-solid',
                getPage: function () { return state.page; },
                onGoto: function (p) {
                    state.page = p;
                    render();
                    var top = el('accoladesConfigPanel');
                    if (top && top.scrollIntoView) top.scrollIntoView({ block: 'start' });
                }
            });
        }
        return pager;
    }

    // The shared Pagination component draws icon-only prev/next buttons with no accessible name, and
    // no "current page" state — add both here rather than change a component six other sections use.
    function labelPagination() {
        var $btns = $('#aclPagination button');
        if (!$btns.length) return;
        $btns.first().attr('aria-label', 'Previous page');
        $btns.last().attr('aria-label', 'Next page');
        $btns.slice(1, -1).each(function () {
            var n = $(this).text();
            $(this).attr('aria-label', 'Page ' + n);
            if (String(n) === String(state.page)) $(this).attr('aria-current', 'page'); else $(this).removeAttr('aria-current');
        });
    }

    function render() {
        var $list = $('#adminAccoladesList');
        var p = getPager();
        $('#accoladesAdmin').toggleClass('acl-can-drag', state.sort === 'site' && !state.selecting);
        if (!state.items.length) {
            $list.html('<div class="atl-empty-state">'
                + '<i class="fa-solid fa-award" style="font-size:32px; color:var(--atl-muted-dim); margin-bottom:14px; display:block;" aria-hidden="true"></i>'
                + '<p style="color:var(--atl-muted); margin:0 0 14px; font-size:13px;">No accolades have been added yet.</p>'
                + '<button type="button" class="atl-btn atl-btn--primary um-btn--sm" id="aclEmptyAddBtn"><i class="fa-solid fa-plus" aria-hidden="true"></i> Add Accolade</button>'
                + '</div>');
            $('#aclResultsMeta').text('');
            if (p) p.render(0);
            updateBulkBar();
            return;
        }
        var list = visibleList();
        // A selection only ever covers what is currently listed — acting on hidden rows would surprise.
        var listed = {};
        list.forEach(function (a) { listed[a.id] = true; });
        Object.keys(state.selected).forEach(function (k) { if (!listed[k]) delete state.selected[k]; });

        if (!list.length) {
            $list.html('<div class="atl-empty-state">'
                + '<p style="color:var(--atl-muted); margin:0 0 14px; font-size:13px;">No accolades match these filters.</p>'
                + '<button type="button" class="atl-btn atl-btn--ghost um-btn--sm" id="aclClearFilters"><i class="fa-solid fa-filter-circle-xmark" aria-hidden="true"></i> Clear filters</button>'
                + '</div>');
            $('#aclResultsMeta').text('No matches (' + state.items.length + ' accolade' + (state.items.length === 1 ? '' : 's') + ' in total).');
            if (p) p.render(0);
            updateBulkBar();
            return;
        }
        var pages = Math.max(1, Math.ceil(list.length / PAGE_SIZE));
        if (state.page > pages) state.page = pages;
        var start = (state.page - 1) * PAGE_SIZE;
        var pageItems = list.slice(start, start + PAGE_SIZE);
        $list.html(pageItems.map(cardHtml).join(''));
        $list.find('.acl-card__thumb img').on('error', function () { $(this).closest('.acl-card__thumb').remove(); });
        $('#aclResultsMeta').text('Showing ' + (start + 1) + '–' + (start + pageItems.length) + ' of ' + list.length
            + (list.length !== state.items.length ? ' matching (' + state.items.length + ' in total)' : '')
            + (state.sort === 'site' && !state.selecting ? ' · drag the handle to reorder within a year' : ''));
        if (p) { p.render(pages); labelPagination(); }
        updateBulkBar();
    }

    // Brings a card onto the current page (jumping pages if needed), scrolls to it and briefly
    // highlights it; optionally moves keyboard focus to one of its buttons.
    function revealCard(id, focusSelector) {
        var list = visibleList();
        var idx = -1;
        for (var i = 0; i < list.length; i++) if (String(list[i].id) === String(id)) { idx = i; break; }
        if (idx === -1) return;
        var page = Math.floor(idx / PAGE_SIZE) + 1;
        if (page !== state.page) { state.page = page; render(); }
        var $card = $('#adminAccoladesList .acl-card[data-id="' + id + '"]');
        if (!$card.length) return;
        if ($card[0].scrollIntoView) $card[0].scrollIntoView({ block: 'nearest' });
        $card.addClass('acl-card--flash');
        setTimeout(function () { $card.removeClass('acl-card--flash'); }, 1600);
        if (focusSelector) $card.find(focusSelector).first().trigger('focus');
    }

    // ── toolbar ──
    var debounce = window.debounce || function (fn) { return fn; };
    $(document).on('input', '#aclSearch', debounce(function () {
        state.search = $('#aclSearch').val() || '';
        state.page = 1;
        render();
    }, 200));
    $(document).on('change', '#aclFilterCategory, #aclFilterYear, #aclFilterStatus, #aclFilterFeatured, #aclSort', function () {
        state.category = $('#aclFilterCategory').val() || '';
        state.year = $('#aclFilterYear').val() || '';
        state.status = $('#aclFilterStatus').val() || '';
        state.featured = $('#aclFilterFeatured').val() || '';
        state.sort = $('#aclSort').val() || 'site';
        state.page = 1;
        render();
    });
    $(document).on('click', '#aclClearFilters', function () {
        $('#aclSearch').val('');
        $('#aclFilterCategory, #aclFilterYear, #aclFilterStatus, #aclFilterFeatured').val('');
        state.search = state.category = state.year = state.status = state.featured = '';
        state.page = 1;
        render();
        $('#aclSearch').trigger('focus');
    });

    // ── cards ──
    $(document).on('click', '#aclEmptyAddBtn', function () { openCreate(); });
    $(document).on('click', '.acl-edit-btn', function (e) { e.stopPropagation(); openEdit($(this).attr('data-id')); });
    // A click on the card itself edits it (or, in Select mode, selects it). Its own controls keep theirs.
    $(document).on('click', '#adminAccoladesList .acl-card', function (e) {
        if ($(e.target).closest('button, a, input, label, .acl-drag').length) return;
        var id = $(this).attr('data-id');
        if (state.selecting) {
            var cb = $(this).find('.acl-select-cb')[0];
            if (cb) { cb.checked = !cb.checked; $(cb).trigger('change'); }
            return;
        }
        openEdit(id);
    });

    // ── selection + bulk actions ──
    function setSelecting(on) {
        state.selecting = on;
        if (!on) state.selected = {};
        $('#accoladesAdmin').toggleClass('acl-selectable', on);
        $('#aclBulkToggle').toggleClass('atl-btn--primary', on).attr('aria-pressed', on ? 'true' : 'false');
        if (on) $('#aclBulkBar').show(); else $('#aclBulkBar').hide();
        render();
    }
    function updateBulkBar() {
        var n = Object.keys(state.selected).length;
        $('#aclBulkCount').text(n + ' selected');
        $('.acl-bulk-btn').prop('disabled', n === 0);
        var $cbs = $('#adminAccoladesList .acl-select-cb');
        var checked = $cbs.filter(':checked').length;
        var all = el('aclSelectAll');
        if (all) {
            all.checked = $cbs.length > 0 && checked === $cbs.length;
            all.indeterminate = checked > 0 && checked < $cbs.length;
        }
    }
    $(document).on('click', '#aclBulkToggle', function () { setSelecting(!state.selecting); });
    $(document).on('click', '#aclBulkCancel', function () { setSelecting(false); $('#aclBulkToggle').trigger('focus'); });
    $(document).on('change', '.acl-select-cb', function () {
        var id = $(this).attr('data-id');
        if (this.checked) state.selected[id] = true; else delete state.selected[id];
        $(this).closest('.acl-card').toggleClass('is-selected', this.checked);
        updateBulkBar();
    });
    $(document).on('change', '#aclSelectAll', function () {
        var on = this.checked;
        $('#adminAccoladesList .acl-select-cb').each(function () {
            this.checked = on;
            var id = $(this).attr('data-id');
            if (on) state.selected[id] = true; else delete state.selected[id];
            $(this).closest('.acl-card').toggleClass('is-selected', on);
        });
        updateBulkBar();
    });

    var BULK_DONE = { publish: 'published', unpublish: 'hidden from the website', feature: 'marked Featured', unfeature: 'no longer Featured', delete: 'deleted' };
    $(document).on('click', '.acl-bulk-btn', async function () {
        var action = $(this).attr('data-bulk');
        var ids = Object.keys(state.selected).map(Number);
        if (!ids.length || !BULK_DONE[action]) return;
        if (action === 'delete') {
            var ok = await window.notificationService.showConfirm({
                title: 'Delete accolades',
                message: 'Permanently delete ' + ids.length + ' accolade' + (ids.length === 1 ? '' : 's') + '? This cannot be undone. To take them off the website but keep them, use Unpublish instead.',
                isDestructive: true
            });
            if (!ok) return;
        }
        $('.acl-bulk-btn').prop('disabled', true);
        try {
            var res = await apiCall('/api/admin/accolades/bulk', 'POST', { action: action, ids: ids });
            var changed = res && typeof res.changed === 'number' ? res.changed : ids.length;
            var msg = changed + ' accolade' + (changed === 1 ? '' : 's') + ' ' + BULK_DONE[action] + '.';
            if (changed < ids.length) msg += ' ' + (ids.length - changed) + ' already ' + (ids.length - changed === 1 ? 'was' : 'were') + '.';
            notify('success', msg);
            state.selected = {};
        } catch (e) { /* apiCall has already shown the server's message */ }
        await loadAccolades();
    });

    // ── ordering: drag within a year (website order only) + keyboard "Move up / down" ──
    function canMove(item, dir) {
        var ids = siteIds(), i = ids.indexOf(Number(item.id)), j = i + dir;
        return i !== -1 && j >= 0 && j < ids.length && state.items[j].year === item.year;
    }
    async function saveOrder(order, message) {
        try {
            await apiCall('/api/admin/accolades/reorder', 'PUT', { order: order });
            if (message) notify('success', message);
        } catch (e) { /* apiCall has already shown the server's message */ }
        await loadAccolades();   // every card's "Site position" is re-read from the server
    }
    async function moveWithinYear(id, dir) {
        var item = byId(id);
        if (!item || !canMove(item, dir)) return;
        var ids = siteIds(), i = ids.indexOf(Number(id)), j = i + dir;
        ids[i] = ids[j];
        ids[j] = Number(id);
        await saveOrder(ids, dir < 0 ? 'Moved up within ' + item.year + '.' : 'Moved down within ' + item.year + '.');
        revealCard(id, '.acl-more-btn');
    }
    // The cards on screen are a slice of the website order (a page, maybe filtered). Re-seat their new
    // order into the slots they occupy in the full order; everything else keeps its place.
    function mergeOrder(before, after) {
        var full = siteIds();
        var slots = before.map(function (id) { return full.indexOf(Number(id)); }).sort(function (a, b) { return a - b; });
        slots.forEach(function (slot, i) { full[slot] = Number(after[i]); });
        return full;
    }
    function initDrag() {
        var list = el('adminAccoladesList');
        if (!list || list.dataset.dragInit) return;
        list.dataset.dragInit = '1';
        var dragged = null, before = null;
        var pageIds = function () { return Array.prototype.map.call(list.querySelectorAll('.acl-card'), function (c) { return c.getAttribute('data-id'); }); };
        list.addEventListener('dragstart', function (e) {
            var handle = e.target && e.target.closest ? e.target.closest('.acl-drag') : null;
            if (!handle || state.sort !== 'site' || state.selecting) { if (handle) e.preventDefault(); return; }
            dragged = handle.closest('.acl-card');
            if (!dragged) return;
            before = pageIds();
            e.dataTransfer.effectAllowed = 'move';
            try { e.dataTransfer.setData('text/plain', dragged.getAttribute('data-id')); } catch (err) { /* old browsers */ }
            try { e.dataTransfer.setDragImage(dragged, 24, 24); } catch (err) { /* the handle alone is dragged */ }
            setTimeout(function () { if (dragged) dragged.classList.add('acl-card--dragging'); }, 0);
        });
        list.addEventListener('dragover', function (e) {
            if (!dragged) return;
            var over = e.target && e.target.closest ? e.target.closest('.acl-card') : null;
            // Only within the same year: the website always lists newest year first.
            if (!over || over.getAttribute('data-year') !== dragged.getAttribute('data-year')) return;
            e.preventDefault();
            if (over === dragged) return;
            var r = over.getBoundingClientRect();
            list.insertBefore(dragged, e.clientY < r.top + r.height / 2 ? over : over.nextSibling);
        });
        list.addEventListener('drop', function (e) { if (dragged) e.preventDefault(); });
        list.addEventListener('dragend', function () {
            if (!dragged) return;
            var id = dragged.getAttribute('data-id');
            dragged.classList.remove('acl-card--dragging');
            dragged = null;
            var after = pageIds();
            if (after.join(',') === before.join(',')) return;
            saveOrder(mergeOrder(before, after), 'New order saved.').then(function () { revealCard(id); });
        });
    }

    // ── "More" menu: one element portalled to <body> (see css/admin/accolades.css), keyboard-operable ──
    function ensureMenu() {
        if (menu.el) return menu.el;
        var m = document.createElement('div');
        m.id = 'aclMoreMenu';
        m.className = 'atl-actions-dropdown-panel acl-menu';
        m.setAttribute('role', 'menu');
        m.hidden = true;
        document.body.appendChild(m);
        $(m).on('click', '[data-acl-action]', function () {
            if (this.disabled) return;
            var action = $(this).attr('data-acl-action');
            var id = menu.forId;
            closeMenu(false);
            runAction(action, id);
        });
        $(m).on('keydown', function (e) {
            var $items = $(m).find('[role="menuitem"]:not(:disabled)');
            var cur = $items.index(document.activeElement);
            var go = function (i) { if ($items.length) $items.eq((i + $items.length) % $items.length).trigger('focus'); };
            if (e.key === 'ArrowDown') { e.preventDefault(); go(cur + 1); }
            else if (e.key === 'ArrowUp') { e.preventDefault(); go(cur - 1); }
            else if (e.key === 'Home') { e.preventDefault(); go(0); }
            else if (e.key === 'End') { e.preventDefault(); go($items.length - 1); }
            else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeMenu(true); }
            else if (e.key === 'Tab') { closeMenu(false); }
        });
        menu.el = m;
        return m;
    }
    function menuItem(action, icon, label, disabled, extraClass) {
        return '<button type="button" role="menuitem" tabindex="-1" class="atl-actions-dropdown-item' + (extraClass ? ' ' + extraClass : '') + '" data-acl-action="' + action + '"'
            + (disabled ? ' disabled aria-disabled="true"' : '') + '><i class="' + icon + '" aria-hidden="true"></i> ' + esc(label) + '</button>';
    }
    function openMenu(btn) {
        var m = ensureMenu();
        if (menu.trigger === btn && !m.hidden) { closeMenu(true); return; }
        closeMenu(false);
        var item = byId($(btn).attr('data-id'));
        if (!item) return;
        var live = item.status === 'active';
        var html = menuItem('toggle-status', live ? 'fa-solid fa-eye-slash' : 'fa-solid fa-globe', live ? 'Unpublish (hide from the website)' : 'Publish (show on the website)')
            + menuItem('toggle-featured', item.featured == 1 ? 'fa-regular fa-star' : 'fa-solid fa-star', item.featured == 1 ? 'Remove Featured' : 'Mark as Featured')
            + menuItem('up', 'fa-solid fa-arrow-up', 'Move up within ' + item.year, !canMove(item, -1))
            + menuItem('down', 'fa-solid fa-arrow-down', 'Move down within ' + item.year, !canMove(item, 1));
        if (item.is_public && state.sectionVisible) html += menuItem('view', 'fa-solid fa-arrow-up-right-from-square', 'View on the website');
        if (isAdministrator()) {
            html += '<div class="atl-actions-dropdown-sep" role="separator"></div>'
                + menuItem('delete', 'fa-solid fa-trash-can', 'Delete…', false, 'atl-actions-dropdown-item--danger acl-delete-btn');
        }
        m.innerHTML = html;
        m.setAttribute('aria-label', 'Actions for ' + (item.title || 'accolade'));
        menu.forId = String(item.id);
        menu.trigger = btn;
        m.hidden = false;
        var r = btn.getBoundingClientRect(), h = m.offsetHeight, w = m.offsetWidth;
        var top = r.bottom + 6;
        if (top + h > window.innerHeight - 8 && r.top - h - 6 > 8) top = r.top - h - 6;
        m.style.top = Math.max(8, top) + 'px';
        m.style.left = Math.max(8, Math.min(r.right - w, window.innerWidth - w - 8)) + 'px';
        btn.setAttribute('aria-expanded', 'true');
        var first = m.querySelector('[role="menuitem"]:not(:disabled)');
        if (first) first.focus();
    }
    function closeMenu(returnFocus) {
        if (!menu.el || menu.el.hidden) return;
        menu.el.hidden = true;
        var t = menu.trigger;
        menu.trigger = null;
        menu.forId = null;
        if (t) {
            t.setAttribute('aria-expanded', 'false');
            if (returnFocus && document.body.contains(t)) t.focus();
        }
    }
    $(document).on('click', '.acl-more-btn', function (e) { e.stopPropagation(); openMenu(this); });
    $(document).on('keydown', '.acl-more-btn', function (e) {
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); openMenu(this); }
    });
    $(document).on('click', function (e) {
        if (menu.el && !menu.el.hidden && !$(e.target).closest('#aclMoreMenu, .acl-more-btn').length) closeMenu(false);
    });
    // The menu is fixed to where its button was — close it rather than leave it floating when anything scrolls.
    document.addEventListener('scroll', function (e) {
        if (menu.el && !menu.el.hidden && !menu.el.contains(e.target)) closeMenu(false);
    }, true);
    $(window).on('resize', function () { closeMenu(false); });

    async function runAction(action, id) {
        var item = byId(id);
        if (!item) return;
        if (action === 'up' || action === 'down') { await moveWithinYear(id, action === 'up' ? -1 : 1); return; }
        if (action === 'view') { window.open('/#accolades', '_blank', 'noopener'); return; }
        try {
            if (action === 'toggle-status') {
                var next = item.status === 'active' ? 'inactive' : 'active';
                await apiCall('/api/admin/accolades/' + item.id, 'PUT', { status: next });
                notify('success', next === 'active' ? '“' + item.title + '” is now on the website.' : '“' + item.title + '” is hidden from the website.');
            } else if (action === 'toggle-featured') {
                var feat = item.featured != 1;
                await apiCall('/api/admin/accolades/' + item.id, 'PUT', { featured: feat });
                notify('success', feat ? '“' + item.title + '” is now Featured.' : '“' + item.title + '” is no longer Featured.');
            } else if (action === 'delete') {
                var ok = await window.notificationService.showConfirm({
                    title: 'Delete accolade',
                    message: 'Permanently delete “' + item.title + '”? This cannot be undone. To take it off the website but keep it, use Unpublish instead.',
                    isDestructive: true
                });
                if (!ok) return;
                await apiCall('/api/admin/accolades/' + item.id, 'DELETE');
                notify('success', 'Accolade deleted.');
                await loadAccolades();
                return;
            }
        } catch (e) { /* apiCall has already shown the server's message */ }
        await loadAccolades();
        revealCard(id, '.acl-more-btn');
    }

    // ── editor drawer ──
    function revokeMedia(m) { if (m && m.url) { try { URL.revokeObjectURL(m.url); } catch (e) { /* ignore */ } } }

    function setDate(value) {
        var input = el('aclDate');
        if (!input) return;
        if (input._flatpickr) { if (value) input._flatpickr.setDate(value, false); else input._flatpickr.clear(false); }
        input.value = value || '';
    }

    function renderMedia(key) {
        var cfg = MEDIA[key], m = editor.media[key] || {};
        var $box = $('#' + cfg.preview);
        var src = m.url || m.path;
        $('#' + cfg.text).text(m.file ? m.file.name : cfg.prompt);
        if (!src) { $box.prop('hidden', true).empty(); return; }
        var name = m.file ? m.file.name : String(m.path).split('/').pop();
        var $thumb = $('<div class="acl-media__thumb">');
        if (/\.pdf$/i.test(name)) $thumb.append('<i class="fa-solid fa-file-pdf" aria-hidden="true"></i>');
        else $thumb.append($('<img alt="">').attr('src', src).on('error', function () { $(this).replaceWith('<i class="fa-solid fa-image" aria-hidden="true"></i>'); }));
        var $info = $('<div class="acl-media__info">')
            .append($('<strong>').text(m.file ? 'New file — uploaded when you save' : 'Current file'))
            .append($('<span>').text(name));
        if (!m.file && m.path) $info.append(' ').append($('<a target="_blank" rel="noopener noreferrer">').attr('href', '/' + m.path).text('Open'));
        var $remove = $('<button type="button" class="atl-btn atl-btn--ghost um-btn--sm">')
            .attr({ 'data-acl-clear': key, 'aria-label': 'Remove the ' + cfg.label.toLowerCase() })
            .html('<i class="fa-solid fa-xmark" aria-hidden="true"></i> Remove');
        $box.empty().append($thumb, $info, $remove).prop('hidden', false);
    }

    function resetMedia() {
        Object.keys(MEDIA).forEach(function (k) {
            revokeMedia(editor.media[k]);
            editor.media[k] = { path: null, file: null, url: null };
            var input = el(MEDIA[k].input);
            if (input) input.value = '';
            renderMedia(k);
        });
    }

    function checkFile(file, accept) {
        if (file.size > MAX_UPLOAD_BYTES) return 'That file is larger than 15 MB.';
        var name = String(file.name || '').toLowerCase();
        if (accept === 'image' && !/\.(jpe?g|png|gif|webp|svg)$/.test(name)) return 'Please choose an image (JPG, PNG, WEBP, GIF or SVG).';
        if (accept === 'cert' && !/\.(pdf|jpe?g|png|webp)$/.test(name)) return 'Please choose a PDF or an image (JPG, PNG or WEBP).';
        return null;
    }

    function keyForInput(inputId) {
        for (var k in MEDIA) if (MEDIA[k].input === inputId) return k;
        return null;
    }

    function clearErrors() {
        $('#aclForm .acl-field-error').text('');
        $('#aclForm [aria-invalid="true"]').removeAttr('aria-invalid');
    }
    function showFieldError(key, message) {
        if (MEDIA[key]) {
            $('#' + MEDIA[key].err).text(message);
            $('#' + MEDIA[key].input).attr('aria-invalid', 'true');
            return MEDIA[key].input;
        }
        var id = FIELDS[key];
        if (!id) return null;
        $('#' + id + 'Err').text(message);
        $('#' + id).attr('aria-invalid', 'true');
        return id;
    }

    function updateCounter() {
        $('#aclDescriptionCount').text(val('aclDescription').length + ' / ' + limit('description'));
    }

    function setSubmitLabel() {
        $('#aclSubmitBtn').prop('disabled', editor.saving).html(editor.id === null
            ? '<i class="fa-solid fa-plus-circle" aria-hidden="true"></i> Add Accolade'
            : '<i class="fa-solid fa-floppy-disk" aria-hidden="true"></i> Update Accolade');
    }

    // The form as the website would receive it: lib/accolades.js's public fields, nothing else.
    function formItem() {
        var mediaSrc = function (k) { var m = editor.media[k] || {}; return m.url || m.path || null; };
        var cert = editor.media.certificate_file || {};
        return {
            id: editor.id || 0,
            title: val('aclTitle') || 'Accolade title',
            category: $('#aclCategory').val() || 'accolade',
            year: parseInt(val('aclYear'), 10) || new Date().getFullYear(),
            achievement_date: /^\d{4}-\d{2}-\d{2}$/.test(val('aclDate')) ? val('aclDate') : null,
            organisation: val('aclOrganisation') || null,
            event_name: val('aclEvent') || null,
            result: val('aclResult') || null,
            description: val('aclDescription') || null,
            location: val('aclLocation') || null,
            image: mediaSrc('image'),
            organisation_logo: mediaSrc('organisation_logo'),
            certificate_file: mediaSrc('certificate_file'),
            certificate_file_name: cert.file ? cert.file.name : null,
            external_url: val('aclExternalUrl') || null,
            source_url: val('aclSourceUrl') || null,
            featured: switchOn('aclFeaturedSwitch') ? 1 : 0
        };
    }

    function refreshPreview() {
        var V = window.AccoladesView;
        if (!V || !$('#aclPreviewLedger').length) return;
        var item = formItem();
        $('#aclPreviewLedger').empty().append(V.buildEntry(item, {}));
        V.renderDetail(item, $('#aclPreviewDetail'));
        var active = switchOn('aclActiveSwitch');
        var saved = editor.id !== null ? byId(editor.id) : null;
        var text, cls;
        if (!state.sectionVisible) { text = 'Hidden — the Accolades section is switched off in Settings'; cls = 'is-hidden'; }
        else if (!active) { text = 'Hidden — Inactive (a draft). Switch on Active to publish.'; cls = 'is-hidden'; }
        else if (saved && saved.is_public) { text = 'Live on the website · position ' + saved.public_position; cls = 'is-live'; }
        else { text = 'Will be published under ' + item.year + ' when you save'; cls = 'is-live'; }
        $('#aclPreviewState').text(text).removeClass('is-live is-hidden').addClass(cls);
        $('#aclPublicPreview > .acl-preview__stage').toggleClass('is-hidden', cls === 'is-hidden');
    }
    window.refreshAccoladePreview = refreshPreview;

    function resetEditor() {
        var form = el('aclForm');
        if (form) form.reset();
        editor.id = null;
        setDate('');
        resetMedia();
        clearErrors();
        setSwitch('aclActiveSwitch', false);
        setSwitch('aclFeaturedSwitch', false);
        $('#aclDisplayOrder').val('');
        $('#acl-tab-history').hide();
        if (window.atlActivateDrawerTab) window.atlActivateDrawerTab('aclDrawer', 'acl-tab-edit');
        $('#aclDrawerTitle').html('<i class="fa-solid fa-award" aria-hidden="true"></i> Add Accolade');
        $('#aclPublicPreview .acl-preview__detail').prop('open', false);
        setSubmitLabel();
        updateCounter();
        refreshPreview();
    }

    function applyToEditor(item) {
        editor.id = Number(item.id);
        $('#aclTitle').val(item.title || '');
        $('#aclCategory').val(catOf(item));
        $('#aclYear').val(item.year || '');
        setDate(item.achievement_date || '');
        $('#aclResult').val(item.result || '');
        $('#aclOrganisation').val(item.organisation || '');
        $('#aclEvent').val(item.event_name || '');
        $('#aclLocation').val(item.location || '');
        $('#aclDescription').val(item.description || '');
        $('#aclExternalUrl').val(item.external_url || '');
        $('#aclSourceUrl').val(item.source_url || '');
        $('#aclDisplayOrder').val(item.display_order != null ? item.display_order : '');
        // Server-derived (lib/accolades.js) — never re-derive "is this public?" from the raw status here.
        setSwitch('aclActiveSwitch', !!item.is_public);
        setSwitch('aclFeaturedSwitch', item.featured == 1);
        Object.keys(MEDIA).forEach(function (k) {
            editor.media[k] = { path: item[k] || null, file: null, url: null };
            renderMedia(k);
        });
        $('#aclDrawerTitle').html('<i class="fa-solid fa-award" aria-hidden="true"></i> Edit Accolade');
        setSubmitLabel();
        $('#acl-tab-history').show();
        if (window.loadChangeHistoryCard) window.loadChangeHistoryCard('aclChangeHistoryList', 'accolades', editor.id);
        updateCounter();
        refreshPreview();
    }

    function openCreate() {
        closeMenu(false);
        resetEditor();
        openAtlDrawer('aclDrawer');
        setTimeout(function () { $('#aclTitle').trigger('focus'); }, 60);
    }
    function openEdit(id) {
        var item = byId(id);
        if (!item) return;
        closeMenu(false);
        resetEditor();
        // openAtlDrawer() fires atl:drawerOpened synchronously, which creates the date picker —
        // so the values are applied after it (same order as js/admin/events.js).
        openAtlDrawer('aclDrawer');
        applyToEditor(item);
    }
    window.openAccoladeCreateDrawer = openCreate;
    window.openAccoladeEditDrawer = openEdit;

    $(document).on('click', '#accoladesAddNewBtn', function () { openCreate(); });
    $(document).on('click', '#aclDrawerClose, #aclDrawerBackdrop, #aclCancelBtn', function () {
        closeAtlDrawer('aclDrawer');
        resetEditor();
    });

    // Google Places autocomplete on Location — js/admin/places-autocomplete.js (shared with the
    // Manual Booking drawer's #mbLocation and the Events drawer's venue search; 2026-09-29
    // location-search consolidation). Accolades has nowhere to store a place_id/lat/lng (unlike a
    // booking's venue), so a selection simply fills the same plain text field with a clean
    // "city, else province" value — the same display rule #mbLocation and #eventsVenue already
    // use (TMLocation.cityOrState) — while free typing (no Google suggestion picked) still works.
    function initAccoladeLocation() {
        var input = el('aclLocation');
        if (!input || !window.AdminPlacesAutocomplete) return;
        window.AdminPlacesAutocomplete.init(input, {
            fields: ['name', 'formatted_address', 'address_components'],
            onPlace: function (loc) {
                input.value = window.TMLocation ? window.TMLocation.cityOrState(loc) : (loc.city || loc.state || loc.name || '');
                $(input).trigger('input');   // clears any validation error and refreshes the preview
            }
        });
    }
    document.addEventListener('atl:drawerClosed', function (e) {
        if (!e.detail || e.detail.id !== 'aclDrawer') return;
        var input = el('aclLocation');
        if (input && window.AdminPlacesAutocomplete) window.AdminPlacesAutocomplete.reset(input);
    });

    // The date picker is created lazily by the shared initAdminDateTimePickers() (admin.html) when a
    // drawer opens; hook it once for the live preview, and to fill an empty Year from the date.
    document.addEventListener('atl:drawerOpened', function (e) {
        if (!e.detail || e.detail.id !== 'aclDrawer') return;
        initAccoladeLocation();
        var input = el('aclDate');
        if (input && input._flatpickr && !input._aclHooked) {
            input._aclHooked = true;
            input._flatpickr.config.onChange.push(function (dates, str) {
                if (str && !val('aclYear')) {
                    $('#aclYear').val(str.slice(0, 4)).removeAttr('aria-invalid');
                    $('#aclYearErr').text('');
                }
                input.removeAttribute('aria-invalid');
                $('#aclDateErr').text('');
                refreshPreview();
            });
        }
    });
    $(document).on('click', '#aclDateClear', function () { setDate(''); refreshPreview(); });

    $(document).on('input change', '#aclForm :input', function (e) {
        // Editing a field clears its error. A bare `change` fired by a blur must not: validation moves
        // focus to the first invalid field, which blurs the others and would wipe their fresh messages.
        if ((e.type === 'input' || this.tagName === 'SELECT') && this.getAttribute('aria-invalid') === 'true') {
            this.removeAttribute('aria-invalid');
            $('#' + this.id + 'Err').text('');
        }
        if (this.id === 'aclDescription') updateCounter();
        refreshPreview();
    });
    $(document).on('click', '#aclActiveSwitch, #aclFeaturedSwitch', function () {
        setSwitch(this.id, !switchOn(this.id));
        refreshPreview();
    });
    // "View …" in the preview opens the detail preview below it — what the button does on the website.
    $(document).on('click', '#aclPreviewLedger .acc-cta', function (e) {
        e.preventDefault();
        var d = $('#aclPublicPreview .acl-preview__detail').prop('open', true)[0];
        if (d && d.scrollIntoView) d.scrollIntoView({ block: 'nearest' });
    });

    $(document).on('change', '#aclImageFile, #aclLogoFile, #aclCertFile', function () {
        var key = keyForInput(this.id);
        var file = this.files && this.files[0];
        if (!key || !file) return;
        $('#' + MEDIA[key].err).text('');
        this.removeAttribute('aria-invalid');
        var problem = checkFile(file, MEDIA[key].accept);
        if (problem) { showFieldError(key, problem); this.value = ''; return; }
        revokeMedia(editor.media[key]);
        editor.media[key] = { path: (editor.media[key] || {}).path || null, file: file, url: URL.createObjectURL(file) };
        renderMedia(key);
        refreshPreview();
    });
    $(document).on('click', '[data-acl-clear]', function () {
        var key = $(this).attr('data-acl-clear');
        if (!MEDIA[key]) return;
        revokeMedia(editor.media[key]);
        editor.media[key] = { path: null, file: null, url: null };
        var input = el(MEDIA[key].input);
        if (input) input.value = '';
        renderMedia(key);
        refreshPreview();
        $('#' + MEDIA[key].input).closest('.um-field-group').find('.acl-upload-zone').trigger('focus');
    });
    // Drag-and-drop onto an upload zone (the same idea as the Events poster zone).
    $(document).on('dragenter dragover', '.acl-upload-zone', function (e) { e.preventDefault(); $(this).addClass('um-upload-zone--dragging'); });
    $(document).on('dragleave drop', '.acl-upload-zone', function (e) { e.preventDefault(); $(this).removeClass('um-upload-zone--dragging'); });
    $(document).on('drop', '.acl-upload-zone', function (e) {
        var files = e.originalEvent && e.originalEvent.dataTransfer && e.originalEvent.dataTransfer.files;
        var input = $(this).find('input[type="file"]')[0];
        if (!files || !files.length || !input) return;
        try { input.files = files; } catch (err) { return; }
        $(input).trigger('change');
    });

    // Mirrors lib/accolades.js prepareAccolade(); the server re-checks everything.
    function validate() {
        clearErrors();
        var errs = [];
        var add = function (k, m) { errs.push([k, m]); };
        var title = val('aclTitle');
        if (!title) add('title', 'Title is required.');
        else if (title.length > limit('title')) add('title', 'Title is limited to ' + limit('title') + ' characters.');
        var year = val('aclYear');
        var yMin = state.limits.year_min || 1950, yMax = state.limits.year_max || new Date().getFullYear() + 1;
        if (!year) add('year', 'Year is required.');
        else if (!/^\d{4}$/.test(year) || +year < yMin || +year > yMax) add('year', 'Enter a four-digit year between ' + yMin + ' and ' + yMax + '.');
        var date = val('aclDate');
        if (date) {
            if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) add('achievement_date', 'Pick the date from the calendar.');
            else if (/^\d{4}$/.test(year) && Math.abs(+date.slice(0, 4) - +year) > 1) add('achievement_date', 'The date (' + date.slice(0, 4) + ') does not match the year (' + year + ').');
        }
        [['result', 'Result'], ['organisation', 'Awarding organisation'], ['event_name', 'Event / ceremony'], ['location', 'Location'], ['description', 'Description']].forEach(function (f) {
            var v = val(FIELDS[f[0]]);
            if (v.length > limit(f[0])) add(f[0], f[1] + ' is limited to ' + limit(f[0]) + ' characters.');
        });
        [['external_url', 'External URL'], ['source_url', 'Source / reference URL']].forEach(function (f) {
            var v = val(FIELDS[f[0]]);
            if (v && (!/^https?:\/\/[^\s<>"]+$/i.test(v) || v.length > limit('url'))) add(f[0], f[1] + ' must be a full link starting with https:// (or http://).');
        });
        var order = val('aclDisplayOrder');
        if (order !== '' && !/^\d+$/.test(order)) add('display_order', 'Display order must be a whole number (0 or more).');
        var firstId = null;
        errs.forEach(function (e) { var id = showFieldError(e[0], e[1]); if (!firstId) firstId = id; });
        return { count: errs.length, firstId: firstId };
    }

    function collect() {
        var body = {
            title: val('aclTitle'),
            category: $('#aclCategory').val(),
            year: parseInt(val('aclYear'), 10),
            achievement_date: val('aclDate'),
            result: val('aclResult'),
            organisation: val('aclOrganisation'),
            event_name: val('aclEvent'),
            location: val('aclLocation'),
            description: val('aclDescription'),
            external_url: val('aclExternalUrl'),
            source_url: val('aclSourceUrl'),
            status: switchOn('aclActiveSwitch') ? 'active' : 'inactive',
            featured: switchOn('aclFeaturedSwitch')
        };
        Object.keys(MEDIA).forEach(function (k) { body[k] = (editor.media[k] && editor.media[k].path) || ''; });
        var order = val('aclDisplayOrder');
        if (order !== '') body.display_order = parseInt(order, 10);
        return body;
    }

    $(document).on('submit', '#aclForm', async function (e) {
        e.preventDefault();
        if (editor.saving) return;   // a second click while saving is ignored (the server also refuses duplicates)
        var v = validate();
        if (v.count) {
            notify('error', v.count === 1 ? 'Please fix the highlighted field.' : 'Please fix the ' + v.count + ' highlighted fields.');
            if (v.firstId) $('#' + v.firstId).trigger('focus');
            return;
        }
        var isEdit = editor.id !== null;
        editor.saving = true;
        $('#aclSubmitBtn').prop('disabled', true).html('<i class="fa-solid fa-spinner fa-spin" aria-hidden="true"></i> Saving…');
        try {
            // New files go up first through the shared upload route; nothing is saved if one fails.
            var keys = Object.keys(MEDIA);
            for (var i = 0; i < keys.length; i++) {
                var m = editor.media[keys[i]];
                if (!m || !m.file) continue;
                var path = await uploadFileToServer(m.file, 'accolades');
                if (!path) {
                    showFieldError(keys[i], 'This file could not be uploaded — please try again.');
                    throw new Error('upload');
                }
                revokeMedia(m);
                editor.media[keys[i]] = { path: path, file: null, url: null };
                renderMedia(keys[i]);
            }
            var body = collect();
            var res = isEdit
                ? await apiCall('/api/admin/accolades/' + editor.id, 'PUT', body)
                : await apiCall('/api/admin/accolades', 'POST', body);
            var savedId = isEdit ? editor.id : (res && res.id);
            notify('success', isEdit ? 'Accolade updated.'
                : (body.status === 'active' ? 'Accolade added and published.' : 'Accolade added as a draft (Inactive).'));
            editor.saving = false;
            closeAtlDrawer('aclDrawer');
            resetEditor();
            await loadAccolades();
            if (savedId) revealCard(savedId, '.acl-edit-btn');
        } catch (err) {
            if (err && err.message === 'upload') notify('error', 'A file could not be uploaded, so nothing was saved.');
            // Anything else: apiCall has already shown the server's message (e.g. a duplicate).
        } finally {
            editor.saving = false;
            setSubmitLabel();
        }
    });

    $(function () { initDrag(); });
})();
