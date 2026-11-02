/* tracker.js — Thabiso Mhlongo public page analytics
 * Self-contained. No external dependencies. Sends events to POST /api/public/analytics/track (routes/public/misc.js).
 *
 * Runs ONLY with the visitor's consent: the cookie pop-up's Analytics choice (localStorage 'cookiePreferences', index.html). Without it
 * nothing is sent and no visitor cookie is set; a later "yes" starts it (the pop-up fires 'tm:consent'), a later "no" stops it and forgets
 * this browser (the visitor cookie and session are deleted). Cloudflare, in front of the site, still counts all traffic anonymously.
 *
 * What it records (the admin Dashboard's Traffic & Visitors tab):
 *   pageview / heartbeat / page_exit - a visit and its length (the site is ONE page, so this is close to one per visit)
 *   section_view - a section of the page actually looked at (on screen for a second), once per section per page load
 *   interaction - something done: an event opened, Get Tickets, the booking form opened / step reached / sent, a message sent,
 *                 a newsletter sign-up, tickets held / sent to PayFast, a show shared, a photo or video opened
 * Section views and interactions are events of the visit, never extra page views.
 */
(function () {
    'use strict';

    var TRACK_URL   = '/api/public/analytics/track';
    var HEARTBEAT   = 30;                       // seconds between heartbeat pings (only while the tab is visible)
    var SESSION_TTL = 30 * 60 * 1000;           // 30-minute inactivity window
    var CONSENT_KEY = 'cookiePreferences';
    var CONSENT_TTL = 365 * 24 * 60 * 60 * 1000;

    var active = false, visitorId = null, sessionId = null, pageLoadTime = Date.now();
    var heartbeatTimer = null, sectionObserver = null, sectionTimers = {}, sectionsSeen = {};

    // ── consent (the same rule as the cookie pop-up's getPreferences) ──────────
    function hasConsent() {
        try {
            var data = JSON.parse(localStorage.getItem(CONSENT_KEY) || 'null');
            return !!(data && data.timestamp && Date.now() - data.timestamp <= CONSENT_TTL && data.analytics);
        } catch (e) { return false; }
    }

    // ── visitor cookie / session ────────────────────────────────────────────────
    function getCookie(name) {
        var match = document.cookie.match(new RegExp('(^| )' + name + '=([^;]+)'));
        return match ? match[2] : null;
    }
    function setCookie(name, value, days) {
        var exp = new Date(Date.now() + days * 864e5).toUTCString();
        document.cookie = name + '=' + value + '; expires=' + exp + '; path=/; SameSite=Lax';
    }
    function uuid() {
        if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
        return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
            var r = Math.random() * 16 | 0;
            return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
        });
    }
    function getOrCreateSession() {
        var stored = null, lastSeen = 0, now = Date.now();
        try { stored = sessionStorage.getItem('_tm_sid'); lastSeen = parseInt(sessionStorage.getItem('_tm_last') || '0', 10); } catch (e) {}
        if (!stored || (now - lastSeen) > SESSION_TTL) stored = uuid();
        try { sessionStorage.setItem('_tm_sid', stored); sessionStorage.setItem('_tm_last', String(now)); } catch (e) {}
        return stored;
    }
    function touchSession() { try { sessionStorage.setItem('_tm_last', String(Date.now())); } catch (e) {} }

    // ── beacon ──────────────────────────────────────────────────────────────────
    function send(payload) {
        if (!active) return;
        var body = JSON.stringify(Object.assign({ visitor_id: visitorId, session_id: sessionId, page: window.location.pathname || '/' }, payload));
        if (navigator.sendBeacon) {
            navigator.sendBeacon(TRACK_URL, new Blob([body], { type: 'application/json' }));
        } else {
            try { fetch(TRACK_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body, keepalive: true }); } catch (e) {}
        }
    }
    function interaction(name, detail) {
        if (!active || !/^[a-z0-9_]{1,40}$/.test(name)) return;
        touchSession();
        send({ event: 'interaction', name: name, detail: detail == null ? '' : String(detail).slice(0, 80) });
    }
    // The site calls this at the moments that matter (js/myscript.js, js/tickets-drawer.js); a no-op without consent.
    window.tmTrack = interaction;

    function utm() {
        var params = new URLSearchParams(window.location.search);
        return { utm_source: params.get('utm_source') || '', utm_medium: params.get('utm_medium') || '', utm_campaign: params.get('utm_campaign') || '' };
    }

    // ── sections looked at ──────────────────────────────────────────────────────
    // On screen for a second: half the section is visible, or it fills half the screen (a tall section never shows half of itself).
    function watchSections() {
        if (!('IntersectionObserver' in window)) return;
        sectionObserver = new IntersectionObserver(function (entries) {
            entries.forEach(function (en) {
                var id = en.target.getAttribute('data-tm-section');
                if (sectionsSeen[id]) return;
                var seen = en.isIntersecting && en.intersectionRect.height >= Math.min(en.boundingClientRect.height * 0.5, window.innerHeight * 0.5);
                if (seen && !sectionTimers[id]) {
                    sectionTimers[id] = setTimeout(function () {
                        sectionTimers[id] = null;
                        if (sectionsSeen[id] || !active) return;
                        sectionsSeen[id] = true;
                        touchSession();
                        send({ event: 'section_view', name: id });
                    }, 1000);
                } else if (!seen && sectionTimers[id]) {
                    clearTimeout(sectionTimers[id]); sectionTimers[id] = null;
                }
            });
        }, { threshold: [0, 0.25, 0.5, 0.75, 1] });
        SECTIONS.forEach(function (pair) {
            var el = document.querySelector(pair[1]);
            if (el) { el.setAttribute('data-tm-section', pair[0]); sectionObserver.observe(el); }
        });
    }
    // The page's own sections, top to bottom (not the <section>s inside the booking / tracking drawers). The names match
    // routes/admin/analytics.js SECTION_LABELS and routes/public/misc.js's accepted names.
    var SECTIONS = [['hero', '#hero'], ['features', '.tm-features'], ['services', '.tm-services'], ['about', '#about'], ['career', '#career'],
        ['accolades', '#accolades'], ['footprint', '#footprint'], ['team', '#team'], ['gallery', '#gallery'], ['social', '#social'],
        ['events', '#events'], ['newsletter', '#newsletter'], ['testimonials', '#testimonials'], ['contact', '#contact']];

    // ── things done (clicks the page already has) ───────────────────────────────
    function onClick(e) {
        if (!active || !e.target.closest) return;
        var t = e.target, el;
        if ((el = t.closest('[data-open-drawer="bookingDrawer"]'))) return interaction('booking_opened', el.getAttribute('data-bk-source') || 'other');
        if ((el = t.closest('.tk-open[data-ticket-event]'))) return interaction('get_tickets', el.getAttribute('data-ticket-event'));
        if (t.closest('.ev-card__share, #modalEventShareBtn, .tk-share')) return interaction('event_shared');
        if ((el = t.closest('.live-event-card'))) {
            var m = /%22event_id%22%3A(\d+)/.exec(el.getAttribute('data-payload') || '');
            return interaction('event_opened', m ? m[1] : '');
        }
        if (t.closest('.insta-item')) return interaction('gallery_photo');
        if (t.closest('#dynamicEmbedsRow .sm-card:not(.sm-card--playing)')) return interaction('video_played');
        if ((el = t.closest('[data-open-drawer]'))) return interaction('drawer_opened', el.getAttribute('data-open-drawer'));
        if ((el = t.closest('[data-track]'))) return interaction('cta', el.getAttribute('data-track'));
    }

    // ── heartbeat: visit length, only while the tab is visible ──────────────────
    function beat() {
        if (document.visibilityState !== 'visible') return;
        touchSession();
        send({ event: 'heartbeat', dwell: Math.round((Date.now() - pageLoadTime) / 1000) });
    }
    function onExit() { send({ event: 'page_exit', dwell: Math.round((Date.now() - pageLoadTime) / 1000) }); }

    // ── start / stop ────────────────────────────────────────────────────────────
    function start() {
        if (active) return;
        active = true;
        visitorId = getCookie('_tm_vid');
        if (!visitorId) { visitorId = uuid(); setCookie('_tm_vid', visitorId, 365); }
        sessionId = getOrCreateSession();
        send(Object.assign({ event: 'pageview', referrer: document.referrer || '' }, utm()));
        heartbeatTimer = setInterval(beat, HEARTBEAT * 1000);
        watchSections();
    }
    function stop() {
        if (!active) return;
        onExit();
        active = false;
        if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
        if (sectionObserver) { sectionObserver.disconnect(); sectionObserver = null; }
        Object.keys(sectionTimers).forEach(function (k) { if (sectionTimers[k]) clearTimeout(sectionTimers[k]); });
        sectionTimers = {};
        // forget this browser: the visitor cookie and the session
        document.cookie = '_tm_vid=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/; SameSite=Lax';
        try { sessionStorage.removeItem('_tm_sid'); sessionStorage.removeItem('_tm_last'); } catch (e) {}
        visitorId = sessionId = null;
    }

    document.addEventListener('click', onClick, true);
    window.addEventListener('pagehide', function () { if (active) onExit(); });
    window.addEventListener('tm:consent', function (e) {
        if (e.detail && e.detail.analytics) start(); else stop();
    });
    if (hasConsent()) start();
})();
