/* tracker.js — Thabiso Mhlongo public page analytics
 * Self-contained. No external dependencies.
 * Sends events to POST /api/public/analytics/track
 */
(function () {
    'use strict';

    var TRACK_URL  = '/api/public/analytics/track';
    var HEARTBEAT  = 20;   // seconds between heartbeat pings
    var SESSION_TTL = 30 * 60 * 1000; // 30-minute inactivity window

    // ── 1. visitor_id — persistent 1-year first-party cookie ─────────────
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

    var visitorId = getCookie('_tm_vid');
    if (!visitorId) {
        visitorId = uuid();
        setCookie('_tm_vid', visitorId, 365);
    }

    // ── 2. session_id — per-tab, expires after 30-min inactivity ─────────
    function getOrCreateSession() {
        var stored    = sessionStorage.getItem('_tm_sid');
        var lastSeen  = parseInt(sessionStorage.getItem('_tm_last') || '0', 10);
        var now       = Date.now();
        if (!stored || (now - lastSeen) > SESSION_TTL) {
            stored = uuid();
            sessionStorage.setItem('_tm_sid', stored);
        }
        sessionStorage.setItem('_tm_last', String(now));
        return stored;
    }
    var sessionId = getOrCreateSession();

    // ── 3. UTM & referrer extraction ──────────────────────────────────────
    function getUtm() {
        var params = new URLSearchParams(window.location.search);
        return {
            utm_source:   params.get('utm_source')   || '',
            utm_medium:   params.get('utm_medium')   || '',
            utm_campaign: params.get('utm_campaign') || ''
        };
    }

    // ── 4. Page dwell time ────────────────────────────────────────────────
    var pageLoadTime = Date.now();

    // ── 5. Beacon helper ──────────────────────────────────────────────────
    function send(payload) {
        var body = JSON.stringify(Object.assign({
            visitor_id: visitorId,
            session_id: sessionId,
            page:       window.location.pathname || '/'
        }, payload));

        if (navigator.sendBeacon) {
            navigator.sendBeacon(TRACK_URL, new Blob([body], { type: 'application/json' }));
        } else {
            // Fallback: synchronous XHR (acceptable; only for very old browsers)
            var xhr = new XMLHttpRequest();
            xhr.open('POST', TRACK_URL, false);
            xhr.setRequestHeader('Content-Type', 'application/json');
            try { xhr.send(body); } catch (e) {}
        }
    }

    // ── 6. Fire pageview on load ──────────────────────────────────────────
    var utmData = getUtm();
    send(Object.assign({ event: 'pageview', referrer: document.referrer || '' }, utmData));

    // ── 7. Heartbeat every 20 s to record ongoing dwell time ─────────────
    var heartbeatTimer = setInterval(function () {
        sessionStorage.setItem('_tm_last', String(Date.now()));
        send({ event: 'heartbeat', dwell: Math.round((Date.now() - pageLoadTime) / 1000) });
    }, HEARTBEAT * 1000);

    // ── 8. Exit beacon via beforeunload ───────────────────────────────────
    window.addEventListener('beforeunload', function () {
        clearInterval(heartbeatTimer);
        send({ event: 'page_exit', dwell: Math.round((Date.now() - pageLoadTime) / 1000) });
    });

    // ── 9. Scroll depth (25 / 50 / 75 / 100%) — once per threshold ───────
    var scrollSent = {};
    window.addEventListener('scroll', function () {
        var pct = Math.round(
            ((window.scrollY + window.innerHeight) / document.body.scrollHeight) * 100
        );
        [25, 50, 75, 100].forEach(function (threshold) {
            if (pct >= threshold && !scrollSent[threshold]) {
                scrollSent[threshold] = true;
                send({ event: 'scroll_depth', depth: threshold });
            }
        });
    }, { passive: true });

    // ── 10. Click tracking on booking CTA ────────────────────────────────
    document.addEventListener('click', function (e) {
        var el = e.target.closest('[data-track]');
        if (!el) return;
        send({ event: 'click', label: el.getAttribute('data-track') });
    });
})();
