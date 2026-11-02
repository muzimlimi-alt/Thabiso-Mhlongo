/*
 * Management Team presentation — the ONE renderer for how a team member looks.
 *
 * Used by the public site (renderTeam() in js/myscript.js, index.html) AND by the admin portal's
 * live preview (js/admin/team.js, admin.html), so a member can never look different in the two
 * places. The data it is given is lib/team.js's public projection; the styles are the .team-*
 * rules in css/public/redesign.css. Requires jQuery.
 *
 * The photo grid is decorative (aria-hidden); the list beside it is the accessible source of truth
 * (name + role always visible; biography and links shown for the member in the spotlight — one is
 * always lit, the spotlight moves on by itself until the visitor hovers, clicks, taps or tabs in).
 */
(function (global) {
    'use strict';

    // Display order of the link icons. Keys match lib/team.js LINK_FIELDS.
    var LINKS = [
        { key: 'website',   label: 'Website',     icon: 'fa-solid fa-globe' },
        { key: 'twitter',   label: 'X / Twitter', icon: 'fa-brands fa-x-twitter' },
        { key: 'linkedin',  label: 'LinkedIn',    icon: 'fa-brands fa-linkedin' },
        { key: 'instagram', label: 'Instagram',   icon: 'fa-brands fa-instagram' },
        { key: 'behance',   label: 'Behance',     icon: 'fa-brands fa-behance' }
    ];

    // Defence in depth: the server only publishes http(s) links, and the view refuses anything else too.
    function safeHref(url) {
        return (typeof url === 'string' && /^https?:\/\/\S+$/i.test(url.trim())) ? url.trim() : '';
    }

    function initialOf(m) {
        return (m.name || '?').trim().charAt(0).toUpperCase() || '?';
    }

    function linksOf(m) {
        return LINKS.map(function (l) { return { url: safeHref(m[l.key]), label: l.label, icon: l.icon }; })
            .filter(function (l) { return l.url; });
    }

    function buildPhotoCard(m, opts) {
        var initial = initialOf(m);
        var $card = $('<div>').addClass('team-photo-card').attr('data-id', m.id);
        if (m.featured == 1) $card.addClass('team-photo-card--featured');
        if (opts && opts.active) $card.addClass('is-active');
        // a name / role tag that slides up on the highlighted photo (the grid is aria-hidden; the list stays the accessible source)
        var tag = function () {
            var $tag = $('<span>').addClass('team-photo-card__tag');
            $tag.append($('<span>').addClass('team-photo-card__tag-name').text(m.name || ''));
            if (m.role) $tag.append($('<span>').addClass('team-photo-card__tag-role').text(m.role));
            return $tag;
        };
        if (m.image_path) {
            $card.append($('<img>').attr({ src: m.image_path, alt: '', loading: 'lazy', decoding: 'async' }).on('error', function () {
                $card.addClass('team-photo-card--monogram').empty().append($('<span>').addClass('team-photo-card__initial').text(initial), tag());
            }));
        } else {
            $card.addClass('team-photo-card--monogram').append($('<span>').addClass('team-photo-card__initial').text(initial));
        }
        $card.append(tag());
        return $card;
    }

    function buildRow(m, opts) {
        var $row = $('<div>').addClass('team-row').attr({ 'data-id': m.id, role: 'listitem' });
        if (m.featured == 1) $row.addClass('team-row--featured');
        if (opts && opts.active) $row.addClass('is-active');

        var $inner = $('<div>').addClass('team-row__inner').attr({
            role: 'button', tabindex: '0', 'aria-pressed': (opts && opts.active) ? 'true' : 'false',
            'aria-label': (m.name || 'Team member') + (m.role ? (', ' + m.role) : '')
        });
        var $head = $('<div>').addClass('team-row__head');
        // the member's number (01, 02 ...) in place of the plain dot
        var num = (opts && opts.index != null) ? opts.index + 1 : null;
        $head.append($('<span>').addClass('team-row__dot').attr('aria-hidden', 'true').text(num ? (num < 10 ? '0' : '') + num : ''));
        $head.append($('<span>').addClass('team-row__name').text(m.name || ''));
        if (m.featured == 1) {
            $head.append($('<i>').addClass('fa-solid fa-star team-row__star').attr('aria-hidden', 'true'));
            $head.append($('<span>').addClass('sr-only').text('Featured'));
        }

        var links = linksOf(m);
        if (links.length) {
            var $social = $('<div>').addClass('team-row__social');
            links.forEach(function (l) {
                $social.append(
                    $('<a>').addClass('social-icon-wrapper').attr({
                        href: l.url, target: '_blank', rel: 'noopener noreferrer',
                        title: l.label, 'aria-label': l.label + ' (opens in a new tab)'
                    }).on('click', function (e) { e.stopPropagation(); })
                    .append($('<i>').addClass(l.icon).attr('aria-hidden', 'true'))
                );
            });
            $head.append($social);
        }

        $inner.append($head);
        if (m.role) $inner.append($('<p>').addClass('team-row__role').text(m.role));
        $row.append($inner);
        // Sibling of the button (not inside it) so assistive tech reads it: a role=button's
        // children are presentational. textContent only — never HTML.
        if (m.biography) $row.append($('<p>').addClass('team-row__bio').text(m.biography));
        return $row;
    }

    // Empty $photos/$list and fill them with `members`, in the order given. `opts.active` renders
    // every member in its expanded state (used by the admin preview).
    function render(members, $photos, $list, opts) {
        $photos.empty();
        $list.empty();
        // Never more columns than members: an empty trailing .team-photo-col has no content to size
        // it, but .team-photos' flex `gap` still counts it as a child, leaving a sliver of dead space
        // after the real photos — and centering the whole cluster (redesign.css .team-layout) only
        // looks right if the cluster is exactly as wide as what's actually in it.
        var numCols = Math.max(1, Math.min(3, members.length));
        var cols = [];
        for (var i = 0; i < numCols; i++) cols.push($('<div>').addClass('team-photo-col'));
        cols.forEach(function (c) { $photos.append(c); });
        members.forEach(function (m, i) {
            cols[i % numCols].append(buildPhotoCard(m, opts));
            $list.append(buildRow(m, $.extend({}, opts, { index: i })));
        });
    }

    // Hover (pointer) highlights; click / Enter / Space toggles it (works for touch + keyboard).
    function bindInteractions($layout, $photos, $list) {
        function setActive(id) {
            $layout.find('.team-photo-card, .team-row').each(function () {
                var $el = $(this);
                var isActive = id !== null && String($el.data('id')) === String(id);
                $el.toggleClass('is-active', isActive);
                $el.toggleClass('is-dimmed', id !== null && !isActive);
            });
            $layout.find('.team-row__inner').each(function () {
                var rowId = $(this).closest('.team-row').data('id');
                $(this).attr('aria-pressed', (id !== null && String(rowId) === String(id)) ? 'true' : 'false');
            });
        }
        // Spotlight: one member is always lit (bio + links showing). While nobody is interacting and the section is on screen, it
        // moves to the next member every CYCLE_MS, with a gold progress line under the lit name (.is-cycling, redesign.css).
        // Hover pauses it (mouse leaving resumes); a click, tap or keyboard use hands control to the visitor for good. Visitors who
        // ask for reduced motion get no automatic changes at all.
        var CYCLE_MS = 5000;
        var ids = $list.find('.team-row').map(function () { return String($(this).data('id')); }).get();
        var reduceMotion = !!(global.matchMedia && global.matchMedia('(prefers-reduced-motion: reduce)').matches);
        var activeId = ids.length ? ids[0] : null;
        var timer = null, hovering = false, userTookOver = false, onScreen = false;

        function stopCycle() {
            if (timer) { clearTimeout(timer); timer = null; }
            $layout.removeClass('is-cycling');
        }
        function startCycle() {
            stopCycle();
            if (reduceMotion || userTookOver || hovering || !onScreen || ids.length < 2) return;
            void $layout[0].offsetWidth;                                   // restart the progress line's animation
            $layout.addClass('is-cycling');
            timer = setTimeout(function () {
                var i = ids.indexOf(String(activeId));
                activeId = ids[(i + 1) % ids.length];
                setActive(activeId);
                startCycle();
            }, CYCLE_MS);
        }
        function takeOver() { userTookOver = true; stopCycle(); }

        setActive(activeId);
        $layout.css('--team-cycle', CYCLE_MS + 'ms');

        $photos.add($list).on('mouseenter', '.team-photo-card, .team-row', function () {
            hovering = true;
            stopCycle();
            activeId = String($(this).data('id'));
            setActive(activeId);
        });
        $layout.on('mouseleave', function () {
            hovering = false;
            startCycle();                                                  // the last member hovered stays lit; the cycle carries on from there
        });
        $photos.add($list).on('click', '.team-photo-card, .team-row__inner', function () {
            takeOver();
            activeId = String($(this).closest('[data-id]').data('id'));
            setActive(activeId);
        });
        $layout.on('focusin touchstart', takeOver);
        $list.on('keydown', '.team-row__inner', function (e) {
            if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {
                e.preventDefault();
                $(this).trigger('click');
            }
        });

        // only cycle while at least 40% of the section is on screen
        if ('IntersectionObserver' in global) {
            new IntersectionObserver(function (entries) {
                var was = onScreen;
                onScreen = entries[0].isIntersecting;
                if (onScreen && !was) startCycle();                        // only on a change: a repeat "still on screen" must not reset the timer
                else if (!onScreen && was) stopCycle();
            }, { threshold: 0.4 }).observe($layout[0]);
        }
    }

    global.TeamView = { LINKS: LINKS, safeHref: safeHref, initialOf: initialOf, linksOf: linksOf, buildPhotoCard: buildPhotoCard, buildRow: buildRow, render: render, bindInteractions: bindInteractions };
})(window);
