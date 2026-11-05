// The page preloader, ONE copy for every page that shows it (index.html and admin.html): load it with a plain <script src> as the FIRST
// thing in <body>, so it is in place before the page's own content paints. It builds its own style + markup, then removes both.
// Rules:
//   - page load: invisible for the first 350 ms (a fast load - most return visits - finishes before it ever shows); removed as soon as the
//     page has loaded (window "load") AND nothing is holding it, and in any case at its cap (3.5 s by default);
//   - a CSS fail-safe hides it 0.5 s after the cap even if a later script error stops the timer;
//   - never blocks the page: pointer-events:none throughout; decorative, so aria-hidden;
//   - no pulsing for visitors who reduce motion.
// window.tmPreloader.until(promise, maxMs) keeps it up while some work finishes - e.g. the admin's dashboard cards after signing in, when the
// page itself has long finished loading (it then shows again at once, stays at least 0.6 s so it never flickers, and leaves when the work
// settles or at maxMs, whichever comes first). Holds can overlap; it leaves when the last one settles.
// The look is the "Cupcake" loader (codepen.io/prayushS/pen/EjyaVy) in the site's colours: the word THABISO whose final "O" is a gold disc
// with a black circle breathing inside it (0.5 s) around a pulsing gold core (1 s). Pure CSS, no image, so nothing extra to download.
(function () {
    if (window.tmPreloader) return;
    var CSS =
        '.tm-preloader{position:fixed;inset:0;z-index:2147483000;pointer-events:none;transition:opacity .45s ease;animation:tmPreFailsafe .45s ease 4s forwards}' +
        '.tm-preloader.is-done{opacity:0}' +
        '.tm-preloader__veil{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;background:#0a0a0a;opacity:0;animation:tmPreIn .3s ease .35s forwards}' +
        '.tm-preloader--now .tm-preloader__veil{animation-duration:.2s;animation-delay:0s}' +
        ".tm-preloader__word{display:flex;align-items:center;font-family:'Cormorant Garamond',Georgia,'Times New Roman',serif;font-weight:500;font-size:clamp(40px,9vw,84px);line-height:1;letter-spacing:.06em;color:#fff;user-select:none}" +
        '.tm-preloader__o{position:relative;flex:none;width:1em;height:1em;margin-left:.04em;border-radius:50%;background:#D4AF37}' +
        '.tm-preloader__inner,.tm-preloader__core{position:absolute;inset:0;margin:auto;width:90%;height:90%;border-radius:50%}' +
        '.tm-preloader__inner{background:#0a0a0a;transform:scale(.5556);animation:tmPreBreathe .5s ease-in-out infinite alternate}' +
        '.tm-preloader__core{background:#D4AF37;transform:scale(.2778);animation:tmPreBreathe 1s ease-in-out infinite alternate}' +
        '@keyframes tmPreIn{to{opacity:1}}' +
        '@keyframes tmPreBreathe{to{transform:scale(1)}}' +
        '@keyframes tmPreFailsafe{to{opacity:0;visibility:hidden}}' +
        '@media (prefers-reduced-motion:reduce){.tm-preloader__inner,.tm-preloader__core{animation:none}.tm-preloader,.tm-preloader__veil{transition:none}}';
    var MARKUP = '<div class="tm-preloader__veil"><div class="tm-preloader__word"><span>THABIS</span>' +
        '<span class="tm-preloader__o"><span class="tm-preloader__inner"><span class="tm-preloader__core"></span></span></span></div></div>';
    var MIN_SHOWN_MS = 600;

    var el = null, style = null, capTimer = null, removeTimer = null, holds = 0, loaded = false, shownAt = 0;

    function build(now) {
        clearTimeout(removeTimer);
        if (!style || !style.parentNode) {
            style = document.createElement('style');
            style.id = 'tmPreloaderStyle';
            style.textContent = CSS;
            (document.head || document.documentElement).appendChild(style);
        }
        if (el && el.parentNode && !el.classList.contains('is-done')) return;   // already up
        if (el && el.parentNode) el.parentNode.removeChild(el);
        el = document.createElement('div');
        el.id = 'tmPreloader';
        el.className = 'tm-preloader' + (now ? ' tm-preloader--now' : '');
        el.setAttribute('aria-hidden', 'true');
        el.innerHTML = MARKUP;
        var host = document.body || document.documentElement;
        host.insertBefore(el, host.firstChild);
        shownAt = Date.now();
    }
    // the hard limit: the script hides it at ms; the CSS fail-safe 0.5 s later (counted from when it was built)
    function setCap(ms) {
        clearTimeout(capTimer);
        capTimer = setTimeout(hide, ms);
        if (el) el.style.animationDelay = Math.round(Date.now() - shownAt + ms + 500) / 1000 + 's';
    }
    function hide() {
        if (!el || el.classList.contains('is-done')) return;
        clearTimeout(capTimer);
        holds = 0;
        el.classList.add('is-done');
        var gone = el;
        removeTimer = setTimeout(function () {
            if (gone.parentNode) gone.parentNode.removeChild(gone);
            if (el === gone && style && style.parentNode) style.parentNode.removeChild(style);
        }, 600);
    }
    function maybeHide() {
        if (!loaded || holds > 0) return;
        var wait = (el && el.classList.contains('tm-preloader--now')) ? MIN_SHOWN_MS - (Date.now() - shownAt) : 0;
        if (wait > 0) setTimeout(function () { if (holds === 0) hide(); }, wait); else hide();
    }

    window.tmPreloader = {
        // Keep it up until `work` (a promise) settles, at most maxMs (default 10 s). Shows it again at once if it had already gone.
        until: function (work, maxMs) {
            var max = Math.max(1000, maxMs || 10000);
            var wasUp = el && el.parentNode && !el.classList.contains('is-done');
            build(!wasUp);
            holds++;
            setCap(max);
            Promise.resolve(work).then(release, release);
            var released = false;
            function release() { if (released) return; released = true; holds = Math.max(0, holds - 1); maybeHide(); }
            return work;
        },
        hide: hide
    };

    // the page load itself
    build(false);
    setCap(3500);
    function onLoaded() { loaded = true; maybeHide(); }
    if (document.readyState === 'complete') onLoaded();
    else window.addEventListener('load', onLoaded);
    window.addEventListener('pageshow', function (e) { if (e.persisted) { loaded = true; hide(); } });   // back / forward cache
})();
