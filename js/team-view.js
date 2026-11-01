/*
 * Management Team presentation — the ONE renderer for how a team member looks.
 *
 * Used by the public site (renderTeam() in js/myscript.js, index.html) AND by the admin portal's
 * live preview (js/admin/team.js, admin.html), so a member can never look different in the two
 * places. The data it is given is lib/team.js's public projection; the styles are the .team-*
 * rules in css/public/redesign.css. Requires jQuery.
 *
 * The photo grid is decorative (aria-hidden); the list beside it is the accessible source of truth
 * (name + role always visible; biography and links revealed on hover / tap / Enter — not hover-only).
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
        if (m.image_path) {
            $card.append($('<img>').attr({ src: m.image_path, alt: '', loading: 'lazy' }).on('error', function () {
                $card.addClass('team-photo-card--monogram').empty().text(initial);
            }));
        } else {
            $card.addClass('team-photo-card--monogram').text(initial);
        }
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
        $head.append($('<span>').addClass('team-row__dot').attr('aria-hidden', 'true'));
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
            $list.append(buildRow(m, opts));
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
        var activeId = null;
        $photos.add($list).on('mouseenter', '.team-photo-card, .team-row', function () {
            activeId = $(this).data('id');
            setActive(activeId);
        });
        $layout.on('mouseleave', function () {
            activeId = null;
            setActive(null);
        });
        $photos.add($list).on('click', '.team-photo-card, .team-row__inner', function () {
            var id = $(this).closest('[data-id]').data('id');
            activeId = (activeId !== null && String(activeId) === String(id)) ? null : id;
            setActive(activeId);
        });
        $list.on('keydown', '.team-row__inner', function (e) {
            if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {
                e.preventDefault();
                $(this).trigger('click');
            }
        });
    }

    global.TeamView = { LINKS: LINKS, safeHref: safeHref, initialOf: initialOf, linksOf: linksOf, buildPhotoCard: buildPhotoCard, buildRow: buildRow, render: render, bindInteractions: bindInteractions };
})(window);
