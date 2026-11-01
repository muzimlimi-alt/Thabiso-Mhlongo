/* Share a show with friends (Events section). A Share button on every upcoming event card, in the event details pop-up and in the
   Get Tickets drawer. It shares the show's short link /e/<event_id> (routes/public/site-content.js): WhatsApp / Facebook / X show the
   poster, title and date from that page, and a friend who taps it lands on /?event=<id>, where this file opens that show's Get Tickets
   drawer (js/tickets-drawer.js) - or its details pop-up when tickets are not sold here.
   Phones (and browsers that have one) get the system share sheet; elsewhere a small menu: WhatsApp, Facebook, Copy link.
   Cards and the pop-up are js/myscript.js's; this file only adds to them, so it needs no hook there. */
(function () {
    'use strict';

    function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'); }
    function decode(s) { var ta = document.createElement('textarea'); ta.innerHTML = String(s || ''); return ta.value; }
    function payloadOf(card) { try { return JSON.parse(decodeURIComponent(card.getAttribute('data-payload') || '')); } catch (e) { return null; } }
    function isUpcoming(item) { return !!item && !!item.event_id && (!item.event_datetime || new Date(item.event_datetime).getTime() >= Date.now() - 6 * 3600 * 1000); }
    function whenOf(item) {
        var d = item.event_datetime ? new Date(item.event_datetime) : null;
        return d && !isNaN(d) ? d.toLocaleString('en-ZA', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
    }
    function shareInfo(item) {
        var title = decode(item.event_title || item.title || 'Live show');
        var bits = [whenOf(item) || item.starts_label || '', decode(item.venue_name || '')].filter(Boolean);
        return { url: location.origin + '/e/' + Number(item.event_id), title: title, text: title + (bits.length ? ' - ' + bits.join(', ') : '') };
    }

    // ---------------------------------------------------------------- sharing

    var menu = null, menuFor = null;
    function share(item, trigger) {
        var s = shareInfo(item);
        if (navigator.share) {
            navigator.share({ title: s.title, text: s.text, url: s.url }).catch(function (err) {
                if (!err || err.name !== 'AbortError') openMenu(s, trigger);      // not allowed here (some desktops): the menu instead
            });
            return;
        }
        openMenu(s, trigger);
    }

    function openMenu(s, trigger) {
        closeMenu();
        menuFor = trigger || null;
        var msg = s.text + ' ' + s.url;
        menu = document.createElement('div');
        menu.className = 'tm-share-menu';
        menu.setAttribute('role', 'dialog');
        menu.setAttribute('aria-label', 'Share ' + s.title);
        menu.innerHTML = '<p class="tm-share-menu__title">Share this show</p>' +
            '<a class="tm-share-menu__item" href="https://wa.me/?text=' + encodeURIComponent(msg) + '" target="_blank" rel="noopener"><i class="fa-brands fa-whatsapp" aria-hidden="true"></i> WhatsApp</a>' +
            '<a class="tm-share-menu__item" href="https://www.facebook.com/sharer/sharer.php?u=' + encodeURIComponent(s.url) + '" target="_blank" rel="noopener"><i class="fa-brands fa-facebook" aria-hidden="true"></i> Facebook</a>' +
            '<a class="tm-share-menu__item" href="https://twitter.com/intent/tweet?text=' + encodeURIComponent(s.text) + '&url=' + encodeURIComponent(s.url) + '" target="_blank" rel="noopener"><i class="fa-brands fa-x-twitter" aria-hidden="true"></i> X</a>' +
            '<button type="button" class="tm-share-menu__item" data-share-copy="' + esc(s.url) + '"><i class="fa-regular fa-copy" aria-hidden="true"></i> Copy link</button>' +
            '<p class="tm-share-menu__note" aria-live="polite"></p>';
        // inside the pop-up / drawer that opened it, when there is one: their focus traps keep focus in, and it stacks above them
        var host = (trigger && trigger.closest && trigger.closest('.modal, .atl-drawer')) || document.body;
        host.appendChild(menu);
        place(trigger, host);
        menu.querySelector('.tm-share-menu__item').focus();
    }
    function place(trigger, host) {
        var r = trigger && trigger.getBoundingClientRect ? trigger.getBoundingClientRect() : null;
        var w = menu.offsetWidth, h = menu.offsetHeight, vw = document.documentElement.clientWidth, vh = window.innerHeight;
        var left = r ? Math.min(Math.max(8, r.right - w), vw - w - 8) : (vw - w) / 2;
        var top = r ? (r.bottom + 6 + h <= vh ? r.bottom + 6 : Math.max(8, r.top - h - 6)) : (vh - h) / 2;
        // a sliding drawer is transformed, so 'fixed' inside it is measured from the drawer, not the window
        var off = host !== document.body && getComputedStyle(host).transform !== 'none' ? host.getBoundingClientRect() : { left: 0, top: 0 };
        menu.style.left = Math.round(left - off.left) + 'px';
        menu.style.top = Math.round(top - off.top) + 'px';
    }
    function closeMenu(returnFocus) {
        if (!menu) return;
        menu.remove();
        menu = null;
        if (returnFocus && menuFor && menuFor.focus) menuFor.focus();
        menuFor = null;
    }
    function copy(url) {
        var note = menu && menu.querySelector('.tm-share-menu__note');
        var done = function () { if (note) note.textContent = 'Link copied - paste it anywhere.'; };
        if (navigator.clipboard && navigator.clipboard.writeText) { navigator.clipboard.writeText(url).then(done, function () { if (note) note.textContent = url; }); return; }
        if (note) note.textContent = url;                                  // no clipboard access: show the link to copy by hand
    }

    document.addEventListener('click', function (e) {
        var c = e.target.closest && e.target.closest('[data-share-copy]');
        if (c) { copy(c.getAttribute('data-share-copy')); return; }
        if (menu && !menu.contains(e.target) && !(menuFor && menuFor.contains(e.target))) closeMenu(false);
        if (menu && e.target.closest && e.target.closest('.tm-share-menu a')) setTimeout(function () { closeMenu(false); }, 0);
    });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && menu) { e.stopPropagation(); closeMenu(true); } }, true);
    window.addEventListener('resize', function () { closeMenu(false); });

    // ---------------------------------------------------------------- the buttons

    var ICON = '<i class="fa-solid fa-share-nodes" aria-hidden="true"></i>';

    // Event cards: a round Share button on the poster of every upcoming show (the card itself opens the details pop-up).
    function decorate(grid) {
        if (!grid) return;
        Array.prototype.forEach.call(grid.querySelectorAll('.live-event-card'), function (card) {
            if (card.querySelector('.ev-card__share')) return;
            var item = payloadOf(card);
            var poster = card.querySelector('.ev-card__poster');
            if (!poster || !isUpcoming(item) || grid.id === 'pastEventsGrid') return;
            poster.insertAdjacentHTML('beforeend', '<button type="button" class="ev-card__share" aria-label="Share ' + esc(decode(item.event_title)) + '">' + ICON + '</button>');
        });
    }
    ['upcomingEventsGrid'].forEach(function (id) {
        var grid = document.getElementById(id);
        if (!grid) return;
        decorate(grid);
        new MutationObserver(function () { decorate(grid); }).observe(grid, { childList: true });
    });
    document.addEventListener('click', function (e) {
        var b = e.target.closest && e.target.closest('.ev-card__share');
        if (!b) return;
        e.preventDefault();
        e.stopPropagation();                                            // not the card's own click (the details pop-up)
        share(payloadOf(b.closest('.live-event-card')), b);
    }, true);

    // The details pop-up: remember which card opened it; its Share button shares that show.
    var modalItem = null;
    document.addEventListener('click', function (e) {
        var card = e.target.closest && e.target.closest('.live-event-card');
        if (card) modalItem = payloadOf(card);
    }, true);
    if (window.jQuery) {
        window.jQuery('#eventDetailsModal').on('show.bs.modal', function () {
            var btn = document.getElementById('modalEventShareBtn');
            if (btn) btn.hidden = !isUpcoming(modalItem);
        });
    }
    document.addEventListener('click', function (e) {
        var b = e.target.closest && e.target.closest('#modalEventShareBtn');
        if (b && modalItem) { e.preventDefault(); share(modalItem, b); }
    });

    // The Get Tickets drawer (js/tickets-drawer.js puts a [data-share-event] button under the show's name).
    document.addEventListener('click', function (e) {
        var b = e.target.closest && e.target.closest('[data-share-event]');
        if (!b) return;
        e.preventDefault();
        share({ event_id: b.getAttribute('data-share-event'), title: b.getAttribute('data-share-title'), starts_label: b.getAttribute('data-share-when'), venue_name: b.getAttribute('data-share-venue') }, b);
    });

    // ---------------------------------------------------------------- arriving from a shared link: /?event=<id>

    var params = new URLSearchParams(location.search);
    var wanted = /^\d{1,9}$/.test(params.get('event') || '') && !params.get('tickets') ? Number(params.get('event')) : null;
    if (!wanted) return;
    params.delete('event');
    try { history.replaceState(null, '', location.pathname + (params.toString() ? '?' + params : '') + location.hash); } catch (e) {}
    var tries = 0;
    (function look() {
        var cards = document.querySelectorAll('#upcomingEventsGrid .live-event-card, #pastEventsGrid .live-event-card');
        var card = null;
        Array.prototype.some.call(cards, function (c) { var it = payloadOf(c); if (it && Number(it.event_id) === wanted) { card = c; return true; } return false; });
        if (!card) { if (++tries < 50) setTimeout(look, 200); return; }   // the events list loads after the page (10 s at most)
        card.scrollIntoView({ block: 'center' });
        var it = payloadOf(card);                                        // on sale here: straight to Get Tickets
        if (it && it.ticketing && it.ticketing.state === 'on_sale' && window.tmOpenTickets && card.closest('#upcomingEventsGrid')) window.tmOpenTickets(it.event_id);
        else card.click();                                               // otherwise the show's details pop-up
    })();
})();
