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

    // This page runs jQuery 2.1.1 (predates CSS custom properties): $el.css('--i', n) silently no-ops
    // — no inline style is written at all, not even a wrong one — so every var(--i) reader would
    // quietly fall back to its default. Setting it through the native DOM API works in every browser
    // this site supports.
    function setVar($el, name, value) {
        var el = $el.jquery ? $el[0] : $el;
        if (el && el.style) el.style.setProperty(name, value);
        return $el;
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
        if (opts.index != null) setVar($li, '--i', Math.min(opts.index, 12));
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

    // ============================================================================================
    // HORIZONTAL TIMELINE — desktop/tablet (>=768px) presentation. A year-by-year scrubber: a row of
    // years, a rail with a tick per year, and a caption under each year that has something published.
    // Mobile keeps the vertical ledger above (mount()) instead — js/myscript.js's renderAccolades()
    // picks one or the other per viewport, the same way this design's own reference component swaps
    // a desktop and a mobile layout rather than squeezing one into the other. Every plain-text rule
    // and every safety check above (safeMedia/safeHref/hasDetails/catOf) is reused unchanged — this
    // section only adds a different arrangement of the same data.
    var TL_CAT_TAG = { win: 'Win', nomination: 'Nom', accolade: 'Hon' };

    // One accolade's caption block inside its year's column. A plain (non-interactive) block when
    // there is nothing more to show (hasDetails false) — same rule buildEntry() uses for the CTA.
    function buildTimelineCaption(item) {
        var cat = catOf(item), meta = CATEGORIES[cat];
        var $cap = $('<div>').addClass('acc-tl__cap acc-tl__cap--' + cat).attr('data-id', item.id);
        if (item.featured == 1) $cap.addClass('acc-tl__cap--featured');

        var $kicker = $('<p>').addClass('acc-tl__kicker');
        if (item.featured == 1) {
            $kicker.append($('<i>').addClass('fa-solid fa-star').attr('aria-hidden', 'true'))
                .append($('<span>').addClass('sr-only').text('Featured '));
        }
        $kicker.append(document.createTextNode(TL_CAT_TAG[cat]));
        $cap.append($kicker);

        // title="…": the CSS never wraps this and truncates only an outlying long one — the native
        // tooltip carries the full text on hover/focus for that rare case.
        if (hasDetails(item)) {
            $cap.append($('<button>').addClass('acc-tl__title').attr({ type: 'button', title: item.title || '', 'data-acc-id': item.id, 'aria-haspopup': 'dialog' })
                .append($('<span>').text(item.title || ''))
                .append($('<span>').addClass('sr-only').text(' — ' + meta.cta)));
        } else {
            $cap.append($('<p>').addClass('acc-tl__title acc-tl__title--static').attr('title', item.title || '').text(item.title || ''));
        }

        var sub = [item.result, item.organisation].filter(Boolean).join(' · ');
        if (sub) $cap.append($('<p>').addClass('acc-tl__meta').text(sub));
        return $cap;
    }

    // Builds the three aligned rows (years / rail+ticks / captions) as one column per calendar year
    // from the earliest item's year through at least the current year, so the rail always reaches
    // "now" even when the most recent accolade is a little further back. `items` is already filtered.
    function buildTimelineRows(items) {
        var now = new Date().getFullYear();
        var years = items.map(function (i) { return i.year; });
        var minYear = years.length ? Math.min.apply(null, years) : now;
        var maxYear = Math.max(now, years.length ? Math.max.apply(null, years) : now);
        var byYear = {};
        items.forEach(function (i) { (byYear[i.year] = byYear[i.year] || []).push(i); });

        var $years = $('<div>').addClass('acc-tl__row acc-tl__row--years');
        var $rail = $('<div>').addClass('acc-tl__row acc-tl__row--rail');
        var $caps = $('<div>').addClass('acc-tl__row acc-tl__row--caps');
        $rail.append($('<div>').addClass('acc-tl__rail-line').attr('aria-hidden', 'true'));

        var i = 0;
        for (var y = minYear; y <= maxYear; y++) {
            var list = byYear[y] || [];
            var marked = list.length > 0;
            var featured = list.some(function (it) { return it.featured == 1; });

            $years.append(setVar($('<div>').addClass('acc-tl__cell'), '--i', i)
                .append($('<time>').addClass('acc-tl__yr' + (marked ? ' is-marked' : '')).attr('datetime', String(y)).text(y)));

            $rail.append(setVar($('<div>').addClass('acc-tl__cell'), '--i', i)
                .append($('<span>').addClass('acc-tl__tick' + (marked ? ' is-marked' : '') + (featured ? ' is-featured' : '')).attr('aria-hidden', 'true')));

            var $cell = setVar($('<div>').addClass('acc-tl__cell acc-tl__cell--cap'), '--i', i);
            list.forEach(function (item) { $cell.append(buildTimelineCaption(item)); });
            $caps.append($cell);
            i++;
        }
        return { $years: $years, $rail: $rail, $caps: $caps, count: i };
    }

    // Public-page controller for the horizontal layout — the desktop counterpart to mount(). o =
    // { items, $viewport, $track, $prev, $next, $filters, $status, onOpen(item, el) }.
    function mountTimeline(o) {
        var items = o.items || [];
        var current = 'all';
        var filtersShown = renderFilters(items, o.$filters, current);
        var vp = o.$viewport[0];

        function updateNav() {
            // A couple of px of slack: sub-pixel layout (fractional column widths from max-content
            // sizing) can leave scrollLeft a hair short of the true max after a programmatic scroll.
            var atStart = vp.scrollLeft <= 2;
            var atEnd = vp.scrollLeft >= vp.scrollWidth - vp.clientWidth - 2;
            o.$prev.prop('disabled', atStart).attr('aria-disabled', atStart ? 'true' : 'false');
            o.$next.prop('disabled', atEnd).attr('aria-disabled', atEnd ? 'true' : 'false');
        }

        function draw(announce) {
            var list = current === 'all' ? items : items.filter(function (i) { return catOf(i) === current; });
            var rows = buildTimelineRows(list);
            o.$track.empty().append(rows.$years, rows.$rail, rows.$caps);
            if (announce && o.$status) o.$status.text(statusText(list.length, current));
            // Opens on the most recent end of the rail — the most relevant accolades need no scrolling.
            vp.scrollLeft = vp.scrollWidth;
            updateNav();
        }

        o.$filters.off('click.acctl');
        if (filtersShown) {
            o.$filters.on('click.acctl', '.acc-filter', function () {
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
        o.$track.off('click.acctl').on('click.acctl', '.acc-tl__title', function () {
            var id = String($(this).attr('data-acc-id'));
            for (var i = 0; i < items.length; i++) {
                if (String(items[i].id) === id) { if (o.onOpen) o.onOpen(items[i], this); return; }
            }
        });

        function step(dir) {
            vp.scrollBy({ left: Math.max(240, vp.clientWidth * 0.6) * dir, behavior: 'smooth' });
        }
        o.$prev.off('click.acctl').on('click.acctl', function () { step(-1); });
        o.$next.off('click.acctl').on('click.acctl', function () { step(1); });
        o.$viewport.off('scroll.acctl').on('scroll.acctl', updateNav);
        // A vertical wheel gesture over the rail scrolls it horizontally — only while there is
        // horizontal overflow to move into, and only when the gesture isn't already mostly horizontal
        // (a trackpad's native diagonal pan), so the page's own scroll is never hijacked underneath it.
        o.$viewport.off('wheel.acctl').on('wheel.acctl', function (e) {
            if (vp.scrollWidth <= vp.clientWidth) return;
            var oe = e.originalEvent;
            if (Math.abs(oe.deltaY) <= Math.abs(oe.deltaX)) return;
            vp.scrollLeft += oe.deltaY;
            e.preventDefault();
        });
        o.$viewport.off('keydown.acctl').on('keydown.acctl', function (e) {
            if (e.key === 'ArrowRight') { step(1); e.preventDefault(); }
            else if (e.key === 'ArrowLeft') { step(-1); e.preventDefault(); }
        });

        draw(false);
        return { filtersShown: filtersShown };
    }

    global.AccoladesView = {
        CATEGORIES: CATEGORIES, ORDER: ORDER, FILTER_MIN_ITEMS: FILTER_MIN_ITEMS,
        catOf: catOf, safeHref: safeHref, safeMedia: safeMedia, formatDate: formatDate, hasDetails: hasDetails,
        buildEntry: buildEntry, renderLedger: renderLedger, renderFilters: renderFilters, shouldShowFilters: shouldShowFilters,
        renderDetail: renderDetail, statusText: statusText, mount: mount, mountTimeline: mountTimeline
    };
})(window);
