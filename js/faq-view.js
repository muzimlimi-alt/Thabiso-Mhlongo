/* FAQ view - ONE renderer for the public FAQ section (index.html, via renderFaq() in js/myscript.js) AND the admin's live preview
   (js/admin/faq.js), so the preview can never show a question differently from the website. What is published and in which order is decided
   on the server (lib/faq.js); this file only lays it out.

   Accordion: native <details>/<summary> - keyboard and screen-reader support come with the element. Text is ALWAYS inserted with textContent
   (questions and answers are stored as typed, not escaped - see lib/faq.js); an answer's blank lines become paragraphs and single line
   breaks become <br>, nothing else is interpreted. Plain browser JS, no dependencies. */
(function (root) {
    'use strict';

    var ORDER = ['bookings', 'payments', 'events', 'general'];

    function el(tag, cls, text) {
        var n = document.createElement(tag);
        if (cls) n.className = cls;
        if (text !== undefined && text !== null) n.textContent = text;
        return n;
    }

    // Plain text -> paragraphs (blank line) and line breaks (single newline), as DOM nodes - never HTML.
    function answerNodes(text) {
        var frag = document.createDocumentFragment();
        String(text || '').split(/\n{2,}/).forEach(function (para) {
            var p = el('p', 'faq-item__p');
            para.split('\n').forEach(function (line, i) {
                if (i) p.appendChild(document.createElement('br'));
                p.appendChild(document.createTextNode(line));
            });
            frag.appendChild(p);
        });
        return frag;
    }

    function matches(item, query) {
        if (!query) return true;
        var hay = (item.question + ' ' + item.answer).toLowerCase();
        return String(query).toLowerCase().split(/\s+/).filter(Boolean).every(function (w) { return hay.indexOf(w) >= 0; });
    }

    function groupsOf(items) {
        var by = {};
        items.forEach(function (it) { (by[it.category] = by[it.category] || []).push(it); });
        return ORDER.filter(function (c) { return by[c]; }).map(function (c) { return { category: c, label: by[c][0].category_label || c, items: by[c] }; });
    }

    // Render the list into `list` (an element). opts: { category, query, idPrefix ('faq-'), headings (true), collapsible (false), expanded (false) }.
    // collapsible: each topic becomes its own <details> (heading + question count as the summary) so a long FAQ takes little room; it starts
    // closed unless `expanded` (a chosen topic or a search shows its results open). Returns how many questions are shown.
    function renderList(list, items, opts) {
        opts = opts || {};
        var prefix = opts.idPrefix === undefined ? 'faq-' : opts.idPrefix;
        var shown = (items || []).filter(function (it) { return (!opts.category || it.category === opts.category) && matches(it, opts.query); });
        while (list.firstChild) list.removeChild(list.firstChild);
        var groups = groupsOf(shown);
        var headings = opts.headings !== false && !opts.category;
        groups.forEach(function (g) {
            var section;
            if (headings && opts.collapsible) {
                section = el('details', 'faq-group faq-group--collapsible');
                if (opts.expanded) section.open = true;
                var sum = el('summary', 'faq-group__summary');
                sum.appendChild(el('h3', 'faq-group__title', g.label));
                sum.appendChild(el('span', 'faq-group__count', g.items.length + (g.items.length === 1 ? ' question' : ' questions')));
                var chev = el('span', 'faq-group__chev');
                chev.setAttribute('aria-hidden', 'true');
                sum.appendChild(chev);
                section.appendChild(sum);
            } else {
                section = el('div', 'faq-group');
                if (headings) section.appendChild(el('h3', 'faq-group__title', g.label));
            }
            g.items.forEach(function (it) {
                var d = el('details', 'faq-item');
                if (prefix) d.id = prefix + it.id;
                var s = el('summary', 'faq-item__q');
                s.appendChild(el('span', 'faq-item__qtext', it.question));
                var icon = el('span', 'faq-item__icon');
                icon.setAttribute('aria-hidden', 'true');
                s.appendChild(icon);
                d.appendChild(s);
                var a = el('div', 'faq-item__a');
                a.appendChild(answerNodes(it.answer));
                d.appendChild(a);
                if (opts.open) d.open = true;
                section.appendChild(d);
            });
            list.appendChild(section);
        });
        return shown.length;
    }

    // The public section: category chips (when there are 2+ categories), search (when there are 6+ questions), live status for screen readers,
    // and deep links (#faq-12 opens and scrolls to that question). els: { list, filters, search, searchWrap, empty, status }.
    function mount(items, els) {
        var state = { category: '', query: '' };
        var cats = groupsOf(items);
        function update(announce) {
            // topics start folded; a search opens the topics that have matches
            var n = renderList(els.list, items, { category: state.category, query: state.query, collapsible: true, expanded: !!state.query });
            if (els.empty) els.empty.hidden = n > 0;
            if (els.status && announce) els.status.textContent = n ? (n + (n === 1 ? ' question' : ' questions') + ' shown') : 'No questions match your search.';
        }
        if (els.filters) {
            while (els.filters.firstChild) els.filters.removeChild(els.filters.firstChild);
            els.filters.hidden = cats.length < 2;
            if (cats.length >= 2) {
                [{ category: '', label: 'All' }].concat(cats).forEach(function (c) {
                    var b = el('button', 'faq-chip' + (c.category === '' ? ' is-active' : ''), c.label);
                    b.type = 'button';
                    b.setAttribute('aria-pressed', c.category === '' ? 'true' : 'false');
                    b.addEventListener('click', function () {
                        state.category = c.category;
                        Array.prototype.forEach.call(els.filters.querySelectorAll('.faq-chip'), function (x) { var on = x === b; x.classList.toggle('is-active', on); x.setAttribute('aria-pressed', on ? 'true' : 'false'); });
                        update(true);
                    });
                    els.filters.appendChild(b);
                });
            }
        }
        if (els.search) {
            if (els.searchWrap) els.searchWrap.hidden = items.length < 6;
            var t = null;
            els.search.addEventListener('input', function () {
                clearTimeout(t);
                t = setTimeout(function () { state.query = els.search.value.trim(); update(true); }, 150);
            });
        }
        update(false);
        openFromHash();
        root.addEventListener('hashchange', openFromHash);
        function openFromHash() {
            var m = /^#faq-(\d+)$/.exec(root.location.hash || '');
            if (!m) return;
            var d = document.getElementById('faq-' + m[1]);
            if (!d) return;
            d.open = true;
            var group = d.closest ? d.closest('details.faq-group') : null;   // its topic must be open too
            if (group) group.open = true;
            setTimeout(function () { d.scrollIntoView({ block: 'center' }); }, 50);
        }
    }

    root.FaqView = { renderList: renderList, mount: mount, answerNodes: answerNodes, ORDER: ORDER };
})(window);
