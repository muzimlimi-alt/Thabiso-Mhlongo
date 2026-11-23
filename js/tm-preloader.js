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
//
// TWO DESIGNS, chosen by the admin (Site Appearance > Preloader; stored as the `preloader_style` setting):
//   'wordmark' (the default, and the only one there used to be) - the "Cupcake" loader (codepen.io/prayushS/pen/EjyaVy) in the site's
//      colours: the word THABISO whose final "O" is a gold disc with a black circle breathing inside it (0.5 s) around a pulsing gold core
//      (1 s). Pure CSS, no image, so nothing extra to download.
//   'portrait' - a fashion-house title card (the reference is versace.com's loading state): the graphite portrait centred on an empty field,
//      nothing drawn around it, breathing slowly with a gold light sweeping down it (a gradient moving behind a mask cut from the same
//      picture), the name letterspaced underneath and an indeterminate hairline below that. The picture is
//      images/preloader/portrait-mark.webp (52 KB; a PNG sits beside it for any browser without WebP). It carries a second axis,
//      `preloader_field`: 'onyx' (the default, the site's near-black) or 'bone' (an off-white atelier card). Nothing waits for the picture -
//      the name and the hairline paint at once and it fades in when it has decoded, so a slow image can never hold the page up.
//
// How the choice gets here, in order, first one that answers wins:
//   1. window.__tmPreloaderStyle / window.__tmPreloaderField - what the server wrote into the page before sending it. On the homepage
//      lib/homepage-render.js fills the token in #tmPreloaderBoot (index.html), so a first-time visitor gets the right one on the FIRST
//      paint, with no flash of the other design.
//   2. localStorage 'tm_preloader' - the last answer this browser saw, written by js/myscript.js (homepage) and js/admin/preloader-settings.js
//      (admin) after they read /api/public/site-content. This is what carries the choice into admin.html, which the server does not fill.
//   3. the defaults below.
// Whatever is missing or unrecognised falls back to the default, so the loader always has something to show.
(function () {
    if (window.tmPreloader) return;

    var DEFAULT_STYLE = 'wordmark', DEFAULT_FIELD = 'onyx';
    var MARK_WEBP = 'images/preloader/portrait-mark.webp?v=1';
    var MARK_PNG = 'images/preloader/portrait-mark.png?v=1';

    // ---- which design -------------------------------------------------------------------------------------------------------------
    function cached() {
        try { return JSON.parse(localStorage.getItem('tm_preloader') || '{}') || {}; } catch (e) { return {}; }
    }
    function pick(injected, stored, allowed, fallback) {
        if (allowed.indexOf(injected) !== -1) return injected;
        if (allowed.indexOf(stored) !== -1) return stored;
        return fallback;
    }
    var saved = cached();
    var STYLE = pick(window.__tmPreloaderStyle, saved.style, ['wordmark', 'portrait'], DEFAULT_STYLE);
    var FIELD = pick(window.__tmPreloaderField, saved.field, ['onyx', 'bone'], DEFAULT_FIELD);

    // Admin pages load css/core/tokens.css, so the --atl-* Appearance set (Finish / Accent) exists and the loader wears it; the homepage
    // does not, and keeps the fixed site colours below. js/appearance.js and the pre-paint script in admin.html put the set on <html>
    // before first paint, so this is already correct the first time it is read.
    var themed = false;
    try { themed = !!getComputedStyle(document.documentElement).getPropertyValue('--atl-paper').trim(); } catch (e) {}

    // ---- the shared shell (both designs) ------------------------------------------------------------------------------------------
    var CSS_BASE =
        '.tm-preloader{position:fixed;inset:0;z-index:2147483000;pointer-events:none;transition:opacity .45s ease;animation:tmPreFailsafe .45s ease 4s forwards}' +
        '.tm-preloader.is-done{opacity:0}' +
        '.tm-preloader__veil{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;opacity:0;animation:tmPreIn .3s ease .35s forwards}' +
        '.tm-preloader--now .tm-preloader__veil{animation-duration:.2s;animation-delay:0s}' +
        '@keyframes tmPreIn{to{opacity:1}}' +
        '@keyframes tmPreFailsafe{to{opacity:0;visibility:hidden}}';

    // ---- design 1: the wordmark (unchanged) ---------------------------------------------------------------------------------------
    var CSS_WORDMARK =
        '.tm-preloader__veil{background:radial-gradient(ellipse at 30% 50%,rgba(212,175,55,.036),transparent 60%),radial-gradient(ellipse at 70% 50%,rgba(201,169,110,.018),transparent 50%),linear-gradient(135deg,#050505 0%,#111111 50%,#050505 100%)}' +
        ".tm-preloader__word{display:flex;align-items:center;font-family:'Cormorant Garamond',Georgia,'Times New Roman',serif;font-weight:500;font-size:clamp(40px,9vw,84px);line-height:1;letter-spacing:.06em;color:#fff;user-select:none}" +
        '.tm-preloader__o{position:relative;flex:none;width:1em;height:1em;margin-left:.04em;border-radius:50%;background:#D4AF37}' +
        '.tm-preloader__inner,.tm-preloader__core{position:absolute;inset:0;margin:auto;width:90%;height:90%;border-radius:50%}' +
        '.tm-preloader__inner{background:#0a0a0a;transform:scale(.5556);animation:tmPreBreathe .5s ease-in-out infinite alternate}' +
        '.tm-preloader__core{background:#D4AF37;transform:scale(.2778);animation:tmPreBreathe 1s ease-in-out infinite alternate}' +
        // ADMIN ONLY: where the --atl-* tokens exist the loader wears the admin's set Appearance.
        '.tm-preloader--themed .tm-preloader__veil{background:radial-gradient(ellipse at 30% 50%,color-mix(in srgb,var(--atl-amber) 4%,transparent),transparent 60%),radial-gradient(ellipse at 70% 50%,color-mix(in srgb,var(--atl-amber) 2%,transparent),transparent 50%),linear-gradient(135deg,var(--atl-paper) 0%,color-mix(in srgb,var(--atl-paper) 93%,var(--atl-ink)) 50%,var(--atl-paper) 100%)}' +
        '.tm-preloader--themed .tm-preloader__word{color:var(--atl-ink)}' +
        '.tm-preloader--themed .tm-preloader__o,.tm-preloader--themed .tm-preloader__core{background:var(--atl-amber)}' +
        '.tm-preloader--themed .tm-preloader__inner{background:var(--atl-paper)}' +
        '@keyframes tmPreBreathe{to{transform:scale(1)}}' +
        '@media (prefers-reduced-motion:reduce){.tm-preloader__inner,.tm-preloader__core{animation:none}.tm-preloader,.tm-preloader__veil{transition:none}}';

    var MARKUP_WORDMARK = '<div class="tm-preloader__veil"><div class="tm-preloader__word"><span>THABIS</span>' +
        '<span class="tm-preloader__o"><span class="tm-preloader__inner"><span class="tm-preloader__core"></span></span></span></div></div>';

    // ---- design 2: the portrait title card ----------------------------------------------------------------------------------------
    // Colours come from a handful of custom properties so the two fields (and the admin's themed variant) are three short overrides rather
    // than three copies of the rules: --tmp-bg (the field), --tmp-ink (the name), --tmp-gold (the sweep), --tmp-line (the hairline).
    var CSS_PORTRAIT =
        '.tm-preloader--portrait{--tmp-bg:#070707;--tmp-bg2:#121212;--tmp-ink:#f2efe9;--tmp-gold:#D4AF37;--tmp-line:rgba(242,239,233,.16)}' +
        '.tm-preloader--portrait.tm-preloader--bone{--tmp-bg:#f7f6f4;--tmp-bg2:#ece9e4;--tmp-ink:#141414;--tmp-gold:#a8842c;--tmp-line:rgba(20,20,20,.18)}' +
        // the admin's Appearance set wins over both fields where it exists
        '.tm-preloader--portrait.tm-preloader--themed{--tmp-bg:var(--atl-paper);--tmp-bg2:color-mix(in srgb,var(--atl-paper) 92%,var(--atl-ink));--tmp-ink:var(--atl-ink);--tmp-gold:var(--atl-amber);--tmp-line:color-mix(in srgb,var(--atl-ink) 18%,transparent)}' +
        '.tm-preloader--portrait .tm-preloader__veil{background:radial-gradient(ellipse at 50% 42%,color-mix(in srgb,var(--tmp-gold) 7%,transparent),transparent 62%),linear-gradient(160deg,var(--tmp-bg) 0%,var(--tmp-bg2) 52%,var(--tmp-bg) 100%)}' +
        // the stack: plate (the picture + its sweep) > name > hairline. The picture floats on the field with nothing drawn round it.
        '.tm-preloader__card{display:flex;flex-direction:column;align-items:center;gap:clamp(16px,3.2vh,26px);padding:0 24px}' +
        '.tm-preloader__plate{position:relative;display:block;width:clamp(104px,20vh,172px);aspect-ratio:340/632;opacity:0;animation:tmPreUp .8s ease .15s forwards}' +
        '.tm-preloader__mark{display:block;width:100%;height:100%;object-fit:contain;opacity:0;transition:opacity .7s ease;' +
            'filter:drop-shadow(0 10px 28px color-mix(in srgb,var(--tmp-gold) 16%,transparent));' +
            'animation:tmPreBreath 3.4s ease-in-out infinite;transform-origin:50% 56%}' +
        '.tm-preloader__mark.is-in{opacity:.93}' +
        // the moving gradient: a gold light travelling down a copy of the picture used as a mask, so only the drawing lights up
        '.tm-preloader__sheen{position:absolute;inset:0;pointer-events:none;opacity:0;transition:opacity .7s ease .15s;mix-blend-mode:screen;' +
            '-webkit-mask-image:var(--tmp-mark);mask-image:var(--tmp-mark);-webkit-mask-size:contain;mask-size:contain;' +
            '-webkit-mask-repeat:no-repeat;mask-repeat:no-repeat;-webkit-mask-position:center;mask-position:center;' +
            'background:linear-gradient(to bottom,transparent 0%,transparent 34%,color-mix(in srgb,var(--tmp-gold) 70%,transparent) 50%,transparent 66%,transparent 100%);' +
            'background-size:100% 280%;animation:tmPreSweep 3.4s linear infinite}' +
        // The sweep lightens on a dark field and darkens on a light one, or it would be invisible. On the public site that follows the
        // Field; on the admin the Appearance set wins over the Field, so there it follows the Finish instead ("ember" is a dark one).
        '.tm-preloader--bone:not(.tm-preloader--themed) .tm-preloader__sheen{mix-blend-mode:multiply}' +
        ':root[data-theme="light"] .tm-preloader--themed .tm-preloader__sheen{mix-blend-mode:multiply}' +
        '.tm-preloader__mark.is-in + .tm-preloader__sheen{opacity:.85}' +
        ".tm-preloader__name{font-family:'Cormorant Garamond',Georgia,'Times New Roman',serif;font-weight:500;font-size:clamp(15px,2.5vw,22px);" +
            'line-height:1.5;letter-spacing:.42em;text-indent:.42em;text-transform:uppercase;text-align:center;color:var(--tmp-ink);' +
            'user-select:none;opacity:0;animation:tmPreUp .8s ease .3s forwards}' +
        '.tm-preloader__rule{position:relative;width:clamp(96px,16vw,150px);height:1px;background:var(--tmp-line);overflow:hidden;opacity:0;animation:tmPreUp .8s ease .45s forwards}' +
        '.tm-preloader__rule::after{content:"";position:absolute;top:0;left:0;width:42%;height:100%;background:linear-gradient(90deg,transparent,var(--tmp-gold),transparent);animation:tmPreTrack 1.6s ease-in-out infinite}' +
        '@keyframes tmPreUp{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}' +
        '@keyframes tmPreBreath{0%,100%{transform:scale(1)}50%{transform:scale(1.045)}}' +
        '@keyframes tmPreSweep{from{background-position:0 -180%}to{background-position:0 180%}}' +
        '@keyframes tmPreTrack{0%{left:-42%}100%{left:100%}}' +
        // Still, but never blank: the picture, the name and the hairline all stay; only the movement goes.
        '@media (prefers-reduced-motion:reduce){' +
            '.tm-preloader__mark,.tm-preloader__sheen,.tm-preloader__rule::after{animation:none}' +
            '.tm-preloader__plate,.tm-preloader__name,.tm-preloader__rule{animation:none;opacity:1;transform:none}' +
            '.tm-preloader__sheen{display:none}' +
            '.tm-preloader,.tm-preloader__veil{transition:none}}';

    function markupPortrait() {
        // onerror: the one browser without WebP falls back to the PNG beside it; a second failure leaves the name and the hairline, which
        // is still a complete title card, so the loader degrades instead of showing a broken-image icon.
        return '<div class="tm-preloader__veil"><div class="tm-preloader__card">' +
            '<span class="tm-preloader__plate">' +
            '<img class="tm-preloader__mark" src="' + MARK_WEBP + '" alt="" decoding="async" ' +
            'onerror="if(!this.dataset.fb){this.dataset.fb=1;this.src=\'' + MARK_PNG + '\';}else{this.style.display=\'none\';}">' +
            '<span class="tm-preloader__sheen"></span></span>' +
            '<div class="tm-preloader__name">Thabiso<br>Mhlongo</div>' +
            '<div class="tm-preloader__rule"></div>' +
            '</div></div>';
    }

    var CSS = CSS_BASE + (STYLE === 'portrait' ? CSS_PORTRAIT : CSS_WORDMARK);
    var MARKUP = STYLE === 'portrait' ? markupPortrait() : MARKUP_WORDMARK;
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
        el.className = 'tm-preloader tm-preloader--' + STYLE + (now ? ' tm-preloader--now' : '') + (themed ? ' tm-preloader--themed' : '') +
            (STYLE === 'portrait' ? ' tm-preloader--' + FIELD : '');
        el.setAttribute('aria-hidden', 'true');
        el.innerHTML = MARKUP;
        if (STYLE === 'portrait') {
            // The sweep is masked with the same file the <img> shows, so the browser reuses the one download.
            el.style.setProperty('--tmp-mark', 'url("' + MARK_WEBP + '")');
            var img = el.querySelector('.tm-preloader__mark');
            if (img) {
                var reveal = function () { img.classList.add('is-in'); };
                if (img.complete && img.naturalWidth) reveal(); else img.addEventListener('load', reveal, { once: true });
            }
        }
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
        hide: hide,
        // What this page is actually showing - the admin's Preloader tab reads it, and preview() below uses it to put things back.
        style: STYLE,
        field: FIELD,
        // Show a design for `ms` without saving anything, so the admin can look before committing. Restores the page's own design after.
        preview: function (styleName, fieldName, ms) {
            var wasStyle = STYLE, wasField = FIELD;
            if (['wordmark', 'portrait'].indexOf(styleName) !== -1) STYLE = styleName;
            if (['onyx', 'bone'].indexOf(fieldName) !== -1) FIELD = fieldName;
            CSS = CSS_BASE + (STYLE === 'portrait' ? CSS_PORTRAIT : CSS_WORDMARK);
            MARKUP = STYLE === 'portrait' ? markupPortrait() : MARKUP_WORDMARK;
            if (style && style.parentNode) style.parentNode.removeChild(style);   // force a rebuild with the new rules
            style = null;
            hide();
            if (el && el.parentNode) el.parentNode.removeChild(el);
            el = null;
            var done;
            var held = new Promise(function (r) { done = r; });
            this.until(held, Math.max(1200, ms || 2600));
            setTimeout(function () {
                done();
                // back to what the page is set to, so a later tmPreloader.until() is not stuck on the previewed design
                setTimeout(function () {
                    STYLE = wasStyle; FIELD = wasField;
                    CSS = CSS_BASE + (STYLE === 'portrait' ? CSS_PORTRAIT : CSS_WORDMARK);
                    MARKUP = STYLE === 'portrait' ? markupPortrait() : MARKUP_WORDMARK;
                    if (style && style.parentNode) style.parentNode.removeChild(style);
                    style = null;
                }, 700);
            }, Math.max(1200, ms || 2600));
            return held;
        }
    };

    // the page load itself
    build(false);
    setCap(3500);
    function onLoaded() { loaded = true; maybeHide(); }
    if (document.readyState === 'complete') onLoaded();
    else window.addEventListener('load', onLoaded);
    window.addEventListener('pageshow', function (e) { if (e.persisted) { loaded = true; hide(); } });   // back / forward cache
})();
