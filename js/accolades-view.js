/*
 * Accolades & Recognition presentation — the ONE renderer for how an accolade looks.
 *
 * Used by the public site (renderAccolades() in js/myscript.js, index.html) AND by the admin portal's
 * live preview (js/admin/accolades.js, admin.html), so an accolade can never look different in the
 * two places. The data it is given is lib/accolades.js's public projection; the styles are the .acc-*
 * rules in css/public/redesign.css (loaded by both pages). Requires jQuery.
 *
 * Every value is inserted as TEXT (.text() / .attr()). The server stores exactly what the admin typed
 * (see the header of lib/accolades.js), so nothing here may ever build markup out of those values.
 *
 * The ledger reads as a timeline: newest year first (the server's order). A year is printed once per
 * run of consecutive entries (screen readers still hear it on every entry). A Featured accolade breaks
 * out of the ledger into a framed panel with its year inside it.
 */
(function (global) {
    'use strict';

    var CATEGORIES = {
        win:        { label: 'Win',        plural: 'Wins',        cta: 'View Achievement', featured: 'Winner' },
        nomination: { label: 'Nomination', plural: 'Nominations', cta: 'View Nomination',  featured: 'Nominated' },
        accolade:   { label: 'Accolade',   plural: 'Accolades',   cta: 'View Details',     featured: 'Honoured' }
    };
    var ORDER = ['win', 'nomination', 'accolade'];
    var MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
    // Filters only earn their place with enough entries spread over at least two categories.
    var FILTER_MIN_ITEMS = 4;

    function catOf(item) {
        return item && CATEGORIES[item.category] ? item.category : 'accolade';
    }

    // Defence in depth — the server already publishes only these shapes (lib/accolades.js). A blob:
    // URL is an object URL the page created itself: the admin preview of a file not uploaded yet.
    function safeHref(url) {
        return (typeof url === 'string' && /^https?:\/\/[^\s<>"]+$/i.test(url.trim())) ? url.trim() : '';
    }
    function safeMedia(p) {
        if (typeof p !== 'string') return '';
        if (/^blob:/.test(p)) return p;
        return /^images\/accolades\/[A-Za-z0-9][A-Za-z0-9._-]*$/.test(p) ? p : '';
    }
    function isPdf(p) {
        return /\.pdf$/i.test(p || '');
    }

    // '2025-03-12' -> '12 March 2025' (fixed month names: identical on every browser and locale).
    function formatDate(iso) {
        var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || '');
        return m ? (Number(m[3]) + ' ' + MONTHS[Number(m[2]) - 1] + ' ' + m[1]) : (iso || '');
    }

    // Is there anything to show beyond what the ledger row itself already says?
    function hasDetails(item) {
        return !!(item.description || item.location || item.achievement_date || safeMedia(item.image)
            || safeMedia(item.certificate_file) || safeHref(item.external_url) || safeHref(item.source_url));
    }

    function buildCta(item, meta) {
        return $('<button>').addClass('acc-cta').attr({ type: 'button', 'aria-haspopup': 'dialog', 'data-acc-id': item.id })
            .append($('<span>').text(meta.cta))
            .append($('<span>').addClass('sr-only').text(': ' + (item.title || '')))
            .append($('<span>').addClass('acc-cta__arrow').attr('aria-hidden', 'true').text('→'));
    }

    function buildFeatured($li, item, meta) {
        var $panel = $('<div>').addClass('acc-feature');
        $panel.append($('<time>').addClass('acc-feature__year').attr('datetime', String(item.year)).text(item.year));
        $panel.append($('<p>').addClass('acc-feature__label')
            .append($('<span>').addClass('sr-only').text('Featured ' + meta.label.toLowerCase() + ': '))
            .append(document.createTextNode(item.result || meta.featured)));
        $panel.append($('<h3>').addClass('acc-feature__title').text(item.title || ''));
        var logo = safeMedia(item.organisation_logo);
        if (logo) {
            $panel.append($('<img>').addClass('acc-feature__logo').attr({ src: logo, alt: '', loading: 'lazy' })
                .on('error', function () { $(this).remove(); }));
        }
        var org = [item.organisation, item.event_name].filter(Boolean).join(' · ');
        if (org) $panel.append($('<p>').addClass('acc-feature__org').text(org));
        if (hasDetails(item)) $panel.append(buildCta(item, meta));
        return $li.addClass('acc-entry--featured').append($panel);
    }

    // One ledger entry. opts.repeatYear: the previous entry already printed this year.
    function buildEntry(item, opts) {
        opts = opts || {};
        var cat = catOf(item), meta = CATEGORIES[cat];
        var $li = $('<li>').addClass('acc-entry acc-entry--' + cat)
            .attr({ 'data-id': item.id, 'data-category': cat, 'data-year': item.year });
        if (opts.index != null) $li.css('--i', Math.min(opts.index, 12));
        if (item.featured == 1) return buildFeatured($li, item, meta);

        var $year = $('<div>').addClass('acc-entry__year');
        if (opts.repeatYear) $year.addClass('is-repeat').append($('<span>').addClass('sr-only').text(item.year));
        else $year.append($('<time>').attr('datetime', String(item.year)).text(item.year));

        var $body = $('<div>').addClass('acc-entry__body');
        $body.append($('<p>').addClass('acc-entry__kicker').text(meta.label));
        $body.append($('<h3>').addClass('acc-entry__title').text(item.title || ''));
        var parts = [item.result, item.organisation, item.event_name].filter(Boolean);
        if (parts.length) {
            var $meta = $('<p>').addClass('acc-entry__meta');
            parts.forEach(function (p, i) {
                if (i) $meta.append($('<span>').addClass('acc-entry__sep').attr('aria-hidden', 'true').text('·'));
                $meta.append($('<span>').text(p));
            });
            $body.append($meta);
        }
        $li.append($year, $body);
        if (hasDetails(item)) $li.append($('<div>').addClass('acc-entry__action').append(buildCta(item, meta)));
        return $li;
    }

    // Empty $ledger and fill it with `items`, in the order given. opts.enter animates them in (used
    // when a filter changes; the first render reveals on scroll instead — see renderAccolades()).
    function renderLedger(items, $ledger, opts) {
        opts = opts || {};
        $ledger.empty();
        var prevYear = null, prevFeatured = false;
        items.forEach(function (item, i) {
            var featured = item.featured == 1;
            var $entry = buildEntry(item, { index: i, repeatYear: !featured && !prevFeatured && prevYear === item.year });
            if (opts.enter) $entry.addClass('acc-entry--enter');
            $ledger.append($entry);
            prevYear = item.year;
            prevFeatured = featured;
        });
    }

    function countByCategory(items) {
        var counts = { win: 0, nomination: 0, accolade: 0 };
        items.forEach(function (i) { counts[catOf(i)]++; });
        return counts;
    }

    function shouldShowFilters(items) {
        var counts = countByCategory(items);
        var present = ORDER.filter(function (c) { return counts[c] > 0; }).length;
        return items.length >= FILTER_MIN_ITEMS && present >= 2;
    }

    // ALL + one button per category that actually has entries. Returns whether filters are shown.
    function renderFilters(items, $wrap, current) {
        $wrap.empty();
        if (!shouldShowFilters(items)) { $wrap.prop('hidden', true); return false; }
        var counts = countByCategory(items);
        var defs = [{ key: 'all', label: 'All', n: items.length }].concat(
            ORDER.filter(function (c) { return counts[c] > 0; })
                .map(function (c) { return { key: c, label: CATEGORIES[c].plural, n: counts[c] }; }));
        defs.forEach(function (f) {
            var on = f.key === current;
            $wrap.append($('<button>').addClass('acc-filter' + (on ? ' is-active' : ''))
                .attr({ type: 'button', 'data-filter': f.key, 'aria-pressed': on ? 'true' : 'false' })
                .append($('<span>').text(f.label))
                .append($('<span>').addClass('acc-filter__count').text(f.n)));
        });
        $wrap.prop('hidden', false);
        return true;
    }

    function statusText(n, key) {
        if (key === 'all') return 'Showing all ' + n + ' ' + (n === 1 ? 'entry' : 'entries') + '.';
        var meta = CATEGORIES[key];
        return 'Showing ' + n + ' ' + (n === 1 ? meta.label : meta.plural).toLowerCase() + '.';
    }

    // The full record, for the detail drawer (public) and the admin preview. Fills $container.
    function renderDetail(item, $container) {
        var cat = catOf(item), meta = CATEGORIES[cat];
        var $wrap = $('<div>').addClass('acc-detail acc-detail--' + cat);

        var img = safeMedia(item.image);
        if (img) {
            $wrap.append($('<figure>').addClass('acc-detail__media').append(
                $('<img>').attr({ src: img, alt: item.title || '', loading: 'lazy' })
                    .on('error', function () { $(this).closest('figure').remove(); })));
        }

        $wrap.append($('<p>').addClass('acc-detail__kicker')
            .append(document.createTextNode(meta.label))
            .append($('<span>').addClass('acc-detail__sep').attr('aria-hidden', 'true').text('·'))
            .append($('<time>').attr('datetime', String(item.year)).text(item.year))
            .append(item.featured == 1 ? $('<span>').addClass('acc-detail__featured').text('Featured') : null));
        if (item.result) $wrap.append($('<p>').addClass('acc-detail__result').text(item.result));

        var logo = safeMedia(item.organisation_logo);
        if (item.organisation || logo) {
            var $org = $('<div>').addClass('acc-detail__org');
            if (logo) {
                $org.append($('<img>').addClass('acc-detail__logo')
                    .attr({ src: logo, alt: item.organisation ? item.organisation + ' logo' : 'Organisation logo' })
                    .on('error', function () { $(this).remove(); }));
            }
            if (item.organisation) $org.append($('<span>').text(item.organisation));
            $wrap.append($org);
        }

        var facts = [];
        if (item.achievement_date) facts.push(['Date', formatDate(item.achievement_date), item.achievement_date]);
        if (item.event_name) facts.push(['Event / Ceremony', item.event_name]);
        if (item.location) facts.push(['Location', item.location]);
        facts.push(['Category', meta.label]);
        var $facts = $('<dl>').addClass('acc-detail__facts');
        facts.forEach(function (f) {
            var $dd = $('<dd>');
            if (f[2]) $dd.append($('<time>').attr('datetime', f[2]).text(f[1])); else $dd.text(f[1]);
            $facts.append($('<div>').append($('<dt>').text(f[0]), $dd));
        });
        $wrap.append($facts);

        if (item.description) $wrap.append($('<p>').addClass('acc-detail__desc').text(item.description));

        var links = [];
        var cert = safeMedia(item.certificate_file);
        // certificate_file_name: the admin preview's hint for a not-yet-uploaded file (a blob: URL has no extension).
        if (cert) links.push({ href: cert, label: isPdf(item.certificate_file_name || cert) ? 'View Certificate (PDF)' : 'View Certificate', icon: 'fa-solid fa-file-lines', primary: true });
        var ext = safeHref(item.external_url);
        if (ext) links.push({ href: ext, label: 'Official Page', icon: 'fa-solid fa-arrow-up-right-from-square' });
        var src = safeHref(item.source_url);
        if (src) links.push({ href: src, label: 'Source', icon: 'fa-solid fa-link' });
        if (links.length) {
            var $links = $('<div>').addClass('acc-detail__links');
            links.forEach(function (l) {
                $links.append($('<a>').addClass('btn btn-sm ' + (l.primary ? 'btn-primary' : 'btn-outline'))
                    .attr({ href: l.href, target: '_blank', rel: 'noopener noreferrer', 'aria-label': l.label + ' (opens in a new tab)' })
                    .append($('<i>').addClass(l.icon).attr('aria-hidden', 'true'))
                    .append($('<span>').text(l.label)));
            });
            $wrap.append($links);
        }

        $container.empty().append($wrap);
    }

    // Public-page controller: filters + ledger + "View …" buttons. o = { items, $ledger, $filters,
    // $status, onOpen(item, button) }. The admin preview calls buildEntry/renderDetail directly instead.
    function mount(o) {
        var items = o.items || [];
        var current = 'all';
        var filtersShown = renderFilters(items, o.$filters, current);

        function draw(enter) {
            var list = current === 'all' ? items : items.filter(function (i) { return catOf(i) === current; });
            renderLedger(list, o.$ledger, { enter: enter });
            if (enter && o.$status) o.$status.text(statusText(list.length, current));
        }

        o.$filters.off('click.acc');
        if (filtersShown) {
            o.$filters.on('click.acc', '.acc-filter', function () {
                var key = $(this).attr('data-filter');
                if (key === current) return;
                current = key;
                o.$filters.find('.acc-filter').each(function () {
                    var on = $(this).attr('data-filter') === key;
                    $(this).toggleClass('is-active', on).attr('aria-pressed', on ? 'true' : 'false');
                });
                draw(true);
            });
        }
        o.$ledger.off('click.acc').on('click.acc', '.acc-cta', function () {
            var id = String($(this).attr('data-acc-id'));
            for (var i = 0; i < items.length; i++) {
                if (String(items[i].id) === id) { if (o.onOpen) o.onOpen(items[i], this); return; }
            }
        });
        draw(false);
        return { filtersShown: filtersShown };
    }

    global.AccoladesView = {
        CATEGORIES: CATEGORIES, ORDER: ORDER, FILTER_MIN_ITEMS: FILTER_MIN_ITEMS,
        catOf: catOf, safeHref: safeHref, safeMedia: safeMedia, formatDate: formatDate, hasDetails: hasDetails,
        buildEntry: buildEntry, renderLedger: renderLedger, renderFilters: renderFilters, shouldShowFilters: shouldShowFilters,
        renderDetail: renderDetail, statusText: statusText, mount: mount
    };
})(window);
