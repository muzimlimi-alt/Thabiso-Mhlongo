/*
 * Management Team presentation — the ONE renderer for how a team member looks.
 *
 * Used by the public site (renderTeam() in js/myscript.js, index.html) AND by the admin portal's
 * live preview (js/admin/team.js, admin.html), so a member can never look different in the two
 * places. The data it is given is lib/team.js's public projection; the styles are the .team-*
 * rules in css/public/redesign.css. Requires jQuery.
 *
 * One card per member, built like the Events cards: the photo whole (never cropped or stretched) on
 * a blurred copy of itself, a role badge, the name, the biography and the member's links. Everything
 * is visible without hovering, so mouse, touch, keyboard and screen readers all get the same.
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

    // The photo area: the photo on its blurred copy, or the member's initial when there is no photo (or it fails to load).
    function buildPhoto(m) {
        var $photo = $('<div>').addClass('team-card__photo');
        var monogram = function () { $photo.addClass('team-card__photo--monogram').empty().append($('<span>').attr('aria-hidden', 'true').text(initialOf(m))); };
        if (m.image_path) {
            $photo.append($('<img>').addClass('team-card__photo-img').attr({ src: m.image_path, alt: m.name ? 'Photo of ' + m.name : '', loading: 'lazy', decoding: 'async' }).on('error', monogram));
            $photo.append($('<img>').addClass('team-card__photo-bg').attr({ src: m.image_path, alt: '', 'aria-hidden': 'true', loading: 'lazy', decoding: 'async' }).on('error', function () { $(this).remove(); }));
        } else {
            monogram();
        }
        return $photo;
    }

    // textContent only — never HTML.
    function buildCard(m) {
        var $card = $('<article>').addClass('team-card').attr({ 'data-id': m.id, role: 'listitem' });
        if (m.featured == 1) $card.addClass('team-card--featured');
        $card.append(buildPhoto(m));

        var $info = $('<div>').addClass('team-card__info');
        if (m.role) $info.append($('<span>').addClass('team-card__role').text(m.role));
        var $name = $('<h3>').addClass('team-card__name').text(m.name || '');
        if (m.featured == 1) {
            $name.append(' ', $('<i>').addClass('fa-solid fa-star team-card__star').attr('aria-hidden', 'true'), $('<span>').addClass('sr-only').text('(featured)'));
        }
        $info.append($name);
        if (m.biography) $info.append($('<p>').addClass('team-card__bio').text(m.biography));

        var links = linksOf(m);
        if (links.length) {
            var $social = $('<div>').addClass('team-card__links');
            links.forEach(function (l) {
                $social.append(
                    $('<a>').addClass('social-icon-wrapper').attr({
                        href: l.url, target: '_blank', rel: 'noopener noreferrer',
                        title: l.label, 'aria-label': (m.name ? m.name + ' on ' : '') + l.label + ' (opens in a new tab)'
                    }).append($('<i>').addClass(l.icon).attr('aria-hidden', 'true'))
                );
            });
            $info.append($social);
        }
        $card.append($info);
        return $card;
    }

    // Empty $photos/$list and fill $list with one card per member, in the order given. $photos (the old
    // photo-collage column) is left empty and hidden; it stays in the signature so both callers are unchanged.
    function render(members, $photos, $list, opts) {
        $photos.empty().attr('hidden', 'hidden');
        $list.empty().addClass('team-grid').toggleClass('team-grid--few', members.length < 3);
        members.forEach(function (m) { $list.append(buildCard(m, opts)); });
    }

    // Nothing to wire up any more: every card shows everything without hover or tap. Kept so callers stay unchanged.
    function bindInteractions() {}

    global.TeamView = { LINKS: LINKS, safeHref: safeHref, initialOf: initialOf, linksOf: linksOf, buildCard: buildCard, render: render, bindInteractions: bindInteractions };
})(window);
