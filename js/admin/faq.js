/* FAQ - admin side. Site Content -> FAQ: the list grouped by topic (move up / down, publish / hide, edit, delete), the Preview tab and the
   editor drawer with a live preview. Both previews use js/faq-view.js, the renderer the public page uses, so what you see here is what the
   website shows. The server decides everything (lib/faq.js, routes/admin/faq.js); a role that may not delete gets a 403 whatever this page shows.
   Questions and answers are stored as typed (not escaped): every value goes into the page with .text() / textContent, never .html(). */
(function () {
    'use strict';

    var state = { items: [], categories: [], sectionVisible: true, editing: null };

    function toast(kind, title, msg) { if (window.notificationService && window.notificationService[kind]) window.notificationService[kind](title, msg); }
    function call(method, url, body) {
        var opts = { method: method, credentials: 'same-origin', headers: {} };
        if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
        return fetch(url, opts).then(function (res) {
            return res.json().catch(function () { return {}; }).then(function (json) { return { status: res.status, ok: res.ok, json: json || {} }; });
        });
    }
    function role() { return window.currentUserRole || 'assistant'; }
    function ago(iso) {
        var t = Date.parse(iso); if (!t) return '';
        var s = Math.max(0, Math.floor((Date.now() - t) / 1000));
        if (s < 60) return 'just now'; if (s < 3600) return Math.floor(s / 60) + ' min ago'; if (s < 86400) return Math.floor(s / 3600) + ' h ago';
        return new Date(t).toLocaleDateString('en-ZA', { day: 'numeric', month: 'short', year: 'numeric' });
    }

    function apply(data) {
        state.items = data.items || [];
        state.categories = data.categories || state.categories;
        state.sectionVisible = data.section_visible !== false;
        fillCategorySelects();
        renderList();
        renderPreview();
        renderNotice(data.published);
    }

    function load() {
        return call('GET', '/api/admin/faqs').then(function (r) {
            if (!r.ok) { $('#faqAdminList').empty().append($('<p class="faqa-empty">').text(r.json.message || 'Could not load the FAQ.')); return; }
            apply(r.json);
        }).catch(function () { $('#faqAdminList').empty().append($('<p class="faqa-empty">').text('Could not reach the server.')); });
    }

    function fillCategorySelects() {
        var $f = $('#faqFilterCategory'), $c = $('#faqCategory');
        if ($f.children().length <= 1) state.categories.forEach(function (c) { $f.append($('<option>').val(c.value).text(c.label)); });
        if (!$c.children().length) state.categories.forEach(function (c) { $c.append($('<option>').val(c.value).text(c.label)); });
    }

    function renderNotice(published) {
        var $n = $('#faqNotice');
        if (!state.sectionVisible) { $n.text('The FAQ section is switched off in Site Appearance → Homepage Sections, so nothing here shows on the website until it is switched back on.').prop('hidden', false); return; }
        if (!published) { $n.text('Nothing is published yet, so the FAQ section is hidden on the website. Publish a question to show it.').prop('hidden', false); return; }
        $n.prop('hidden', true).text('');
    }

    function filtered() {
        var q = String($('#faqAdminSearch').val() || '').trim().toLowerCase();
        var cat = $('#faqFilterCategory').val(), st = $('#faqFilterStatus').val();
        return state.items.filter(function (it) {
            if (cat && it.category !== cat) return false;
            if (st && it.status !== st) return false;
            return !q || (it.question + ' ' + it.answer).toLowerCase().indexOf(q) >= 0;
        });
    }

    function renderList() {
        var $list = $('#faqAdminList').empty();
        var rows = filtered();
        var published = state.items.filter(function (i) { return i.status === 'active'; }).length;
        $('#faqCount').text(rows.length + ' of ' + state.items.length + ' shown · ' + published + ' published');
        if (!state.items.length) { $list.append($('<p class="faqa-empty">').text('No questions yet. Add the first one with "Add Question".')); return; }
        if (!rows.length) { $list.append($('<p class="faqa-empty">').text('No questions match these filters.')); return; }
        var narrowed = !!(String($('#faqAdminSearch').val() || '').trim() || $('#faqFilterStatus').val());
        state.categories.forEach(function (c) {
            var group = rows.filter(function (r) { return r.category === c.value; });
            if (!group.length) return;
            var all = state.items.filter(function (r) { return r.category === c.value; });
            var $g = $('<section class="faqa-group">').append($('<h3 class="faqa-group__title">').text(c.label + ' (' + all.length + ')'));
            group.forEach(function (it) {
                var pos = all.indexOf(it);
                var $row = $('<article class="faqa-row-item">').attr('data-id', it.id).toggleClass('is-hidden', it.status !== 'active');
                var $main = $('<div class="faqa-row-item__main">');
                $main.append($('<div class="faqa-row-item__top">')
                    .append($('<span class="atl-badge">').addClass(it.status === 'active' ? 'atl-badge--paid' : 'atl-badge--pending').text(it.status === 'active' ? 'Published' : 'Hidden'))
                    .append($('<span class="faqa-row-item__when">').text('Updated ' + ago(it.updated_at) + (it.updated_by ? ' by ' + it.updated_by : ''))));
                $main.append($('<h4 class="faqa-row-item__q">').text(it.question));
                $main.append($('<p class="faqa-row-item__a">').text(it.answer.length > 180 ? it.answer.slice(0, 180).replace(/\s+\S*$/, '') + '…' : it.answer));
                var $acts = $('<div class="faqa-row-item__acts">');
                // moving is only meaningful in the full, unfiltered list of a topic
                $acts.append($('<button type="button" class="atl-btn atl-btn--ghost atl-btn--sm" data-faq-act="up">').attr('aria-label', 'Move up: ' + it.question).prop('disabled', narrowed || pos <= 0).append('<i class="fa-solid fa-arrow-up" aria-hidden="true"></i>'));
                $acts.append($('<button type="button" class="atl-btn atl-btn--ghost atl-btn--sm" data-faq-act="down">').attr('aria-label', 'Move down: ' + it.question).prop('disabled', narrowed || pos >= all.length - 1).append('<i class="fa-solid fa-arrow-down" aria-hidden="true"></i>'));
                $acts.append($('<button type="button" class="atl-btn atl-btn--ghost atl-btn--sm" data-faq-act="toggle">').text(it.status === 'active' ? 'Hide' : 'Publish'));
                $acts.append($('<button type="button" class="atl-btn atl-btn--ghost atl-btn--sm" data-faq-act="edit">').text('Edit'));
                if (role() === 'administrator') $acts.append($('<button type="button" class="atl-btn atl-btn--ghost atl-btn--sm faqa-del" data-faq-act="delete">').text('Delete'));
                $row.append($main, $acts);
                $g.append($row);
            });
            $list.append($g);
        });
    }

    function renderPreview() {
        var pub = state.items.filter(function (i) { return i.status === 'active'; });
        var list = document.getElementById('faqPreviewList');
        if (!list || !window.FaqView) return;
        window.FaqView.renderList(list, pub, { idPrefix: '', collapsible: true });   // folded topics, exactly as the website shows them
        $('#faqPreviewEmpty').prop('hidden', pub.length > 0);
    }

    /* ── drawer ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────── */
    function openEditor(item) {
        state.editing = item ? item.id : null;
        $('#faqDrawerTitle').empty().append('<i class="fa-solid fa-circle-question"></i> ').append(document.createTextNode(item ? 'Edit Question' : 'Add Question'));
        $('#faqQuestion').val(item ? item.question : '');
        $('#faqAnswer').val(item ? item.answer : '');
        $('#faqCategory').val(item ? item.category : ($('#faqFilterCategory').val() || 'general'));
        $('input[name="faqStatus"][value="' + (item ? item.status : 'inactive') + '"]').prop('checked', true);
        $('#faqMeta').text(item ? 'Last updated ' + ago(item.updated_at) + (item.updated_by ? ' by ' + item.updated_by : '') : 'New questions start Hidden unless you choose Published.');
        $('#faqQuestionErr, #faqAnswerErr').text('');
        counts(); livePreview();
        if (window.openAtlDrawer) window.openAtlDrawer('faqDrawer');
        setTimeout(function () { $('#faqQuestion').trigger('focus'); }, 120);
    }
    function closeEditor() { if (window.closeAtlDrawer) window.closeAtlDrawer('faqDrawer'); state.editing = null; }
    function counts() {
        $('#faqQuestionCount').text(String($('#faqQuestion').val() || '').length);
        $('#faqAnswerCount').text(String($('#faqAnswer').val() || '').length.toLocaleString('en-ZA'));
    }
    function livePreview() {
        var list = document.getElementById('faqLiveList');
        if (!list || !window.FaqView) return;
        var q = String($('#faqQuestion').val() || '').trim(), a = String($('#faqAnswer').val() || '').trim();
        var cat = $('#faqCategory').val() || 'general';
        var label = ($.grep(state.categories, function (c) { return c.value === cat; })[0] || {}).label || cat;
        window.FaqView.renderList(list, [{ id: 0, question: q || 'Your question appears here', answer: a || 'Your answer appears here.', category: cat, category_label: label }], { idPrefix: '', headings: false, open: true });
    }
    function save() {
        var body = { question: $('#faqQuestion').val(), answer: $('#faqAnswer').val(), category: $('#faqCategory').val(), status: $('input[name="faqStatus"]:checked').val() || 'inactive' };
        var $btn = $('#faqSaveBtn').prop('disabled', true);
        $('#faqQuestionErr, #faqAnswerErr').text('');
        call(state.editing ? 'PUT' : 'POST', '/api/admin/faqs' + (state.editing ? '/' + state.editing : ''), body).then(function (r) {
            $btn.prop('disabled', false);
            if (!r.ok) {
                var e = r.json.errors || {};
                if (e.question) $('#faqQuestionErr').text(e.question);
                if (e.answer) $('#faqAnswerErr').text(e.answer);
                toast('showError', 'Not saved', r.json.message || 'Please check the form.');
                return;
            }
            toast('showSuccess', 'Saved', body.status === 'active' ? 'It is on the website now.' : 'Saved as hidden - publish it when it is ready.');
            closeEditor();
            apply(r.json);
        }).catch(function () { $btn.prop('disabled', false); toast('showError', 'Not saved', 'Could not reach the server.'); });
    }

    /* ── row actions ────────────────────────────────────────────────────────────────────────────────────────────────────────────────── */
    function onRowAction() {
        var act = $(this).attr('data-faq-act');
        var id = Number($(this).closest('[data-id]').attr('data-id'));
        var it = $.grep(state.items, function (x) { return x.id === id; })[0];
        if (!it) return;
        if (act === 'edit') { openEditor(it); return; }
        if (act === 'up' || act === 'down') {
            call('POST', '/api/admin/faqs/' + id + '/move', { direction: act }).then(function (r) {
                if (!r.ok) { toast('showError', 'Not moved', r.json.message || ''); return; }
                apply(r.json);
                $('#faqAdminList [data-id="' + id + '"] [data-faq-act="' + act + '"]').trigger('focus');
            });
            return;
        }
        if (act === 'toggle') {
            var next = it.status === 'active' ? 'inactive' : 'active';
            call('PUT', '/api/admin/faqs/' + id, { status: next }).then(function (r) {
                if (!r.ok) { toast('showError', 'Not changed', r.json.message || ''); return; }
                toast('showSuccess', next === 'active' ? 'Published' : 'Hidden', next === 'active' ? 'It is on the website now.' : 'It is no longer on the website.');
                apply(r.json);
            });
            return;
        }
        if (act === 'delete') {
            var go = function () {
                call('DELETE', '/api/admin/faqs/' + id).then(function (r) {
                    if (!r.ok) { toast('showError', 'Not deleted', r.json.message || ''); return; }
                    toast('showSuccess', 'Deleted', ''); apply(r.json);
                });
            };
            var ask = window.notificationService && window.notificationService.showConfirm;
            if (ask) Promise.resolve(window.notificationService.showConfirm({ message: 'Delete "' + it.question + '"? To take it off the website but keep it, use Hide instead.', isDestructive: true })).then(function (ok) { if (ok) go(); });
            else go();
        }
    }

    /* ── wiring ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────── */
    $(document).on('shown.bs.tab', 'a[href="#faqAdmin"]', load);
    $(document).on('click', '#faqAdmin .atl-tab-btn[data-um-tab="faqPreviewPanel"]', renderPreview);
    $(document).on('click', '#faqAddBtn', function () { openEditor(null); });
    $(document).on('click', '#faqAdminList [data-faq-act]', onRowAction);
    $(document).on('input change', '#faqAdminSearch, #faqFilterCategory, #faqFilterStatus', renderList);
    $(document).on('input', '#faqQuestion, #faqAnswer', function () { counts(); livePreview(); });
    $(document).on('change', '#faqCategory', livePreview);
    $(document).on('click', '#faqSaveBtn', save);
    $(document).on('click', '#faqCancelBtn, #faqDrawerClose', closeEditor);
    $(document).on('submit', '#faqForm', function (e) { e.preventDefault(); save(); });

    window.loadFaqAdmin = load;
})();
