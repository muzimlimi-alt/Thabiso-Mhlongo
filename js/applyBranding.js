/*
 * Shared public branding applier.
 * Include on any public page: <script src="js/applyBranding.js"></script>
 *
 * Pulls /api/public/branding and applies, where applicable:
 *   - favicon            (every page)
 *   - accent colour      (--brand-gold)
 *   - theme font         (--theme-font; only visibly changes pages whose CSS uses var(--theme-font))
 *   - site logo          (any img.site-logo / .header-logo / #siteLogo; hides .tm-navbar__logo-text)
 *
 * No-ops gracefully when a target element isn't present, so it's safe on every page.
 */
(function () {
    // A favicon is shown at 16-48px. One uploaded straight from a logo can be a 1536px, 1.8 MB PNG: every visitor
    // downloads it for a tab icon, and Google's favicon crawler doesn't want it. Anything over this size is ignored in
    // favour of the small static icons in the page <head>; the admin's favicon upload now shrinks new files itself.
    var MAX_FAVICON_BYTES = 200 * 1024;

    var ICON_TYPES = { png: 'image/png', ico: 'image/x-icon', svg: 'image/svg+xml', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' };

    // Branding stores upload paths relative ("images/branding/x.png"). Resolved against a nested URL that would 404, so
    // anchor them at the site root; full URLs and root-relative paths pass through.
    function toSiteUrl(href) {
        return /^(https?:)?\/\//i.test(href) || href.charAt(0) === '/' || /^data:/i.test(href) ? href : '/' + href;
    }

    function applyFavicon(href) {
        if (!href) return;
        href = toSiteUrl(href);
        var use = function () {
            // The page <head> declares several icons (48/96/192px PNGs + /favicon.ico "any"). Browsers pick the best match
            // from ALL of them, so replacing only the first one - as this used to - left the built-in mic showing. Remove
            // every icon link and add one for the branded file. apple-touch-icon (iOS home screen) is a separate rel and stays.
            document.querySelectorAll("link[rel~='icon']").forEach(function (l) { l.parentNode.removeChild(l); });
            var link = document.createElement('link');
            link.rel = 'icon';
            var ext = (href.split('?')[0].split('.').pop() || '').toLowerCase();
            if (ICON_TYPES[ext]) link.type = ICON_TYPES[ext];
            link.href = href;
            document.head.appendChild(link);
        };
        fetch(href, { method: 'HEAD' }).then(function (r) {
            if (!r.ok) {
                console.info('[branding] favicon not applied: ' + href + ' returned ' + r.status + ' - keeping the default icons.');
                return;
            }
            var bytes = parseInt(r.headers.get('content-length'), 10);
            if (bytes > MAX_FAVICON_BYTES) {
                console.info('[branding] favicon not applied: ' + bytes + ' bytes is too big for a favicon - re-upload it in Admin > Branding.');
                return;
            }
            use();
        }).catch(use);     // can't tell the size (offline, cross-origin) - apply it anyway
    }

    function applySiteLogo(src) {
        if (!src) return;
        var imgs = document.querySelectorAll('img.site-logo, img.header-logo, img#siteLogo');
        if (!imgs.length) return;
        imgs.forEach(function (img) {
            img.src = src;
            img.style.display = '';
        });
        // Hide the text wordmark that the logo image replaces.
        document.querySelectorAll('.tm-navbar__logo-text').forEach(function (el) {
            el.style.display = 'none';
        });
    }

    fetch('/api/public/branding')
        .then(function (r) { return r.json(); })
        .then(function (data) {
            if (!data || !data.success) return;
            var b = data.branding || {};

            applyFavicon(b.favicon);

            if (b.primary_color) {
                document.documentElement.style.setProperty('--brand-gold', b.primary_color);
            }

            // Theme font (headings + body). style.css consumes --theme-font; redesign.css consumes
            // --f-body / --f-display, so drive those too. Only override when a custom font is set,
            // otherwise leave each page's design default intact. (Admin uses its own applier, so it's untouched.)
            if (b.theme_font) {
                document.documentElement.style.setProperty('--theme-font', b.theme_font);
                document.documentElement.style.setProperty('--f-body', b.theme_font);
                document.documentElement.style.setProperty('--f-display', b.theme_font);
            } else {
                document.documentElement.style.setProperty('--theme-font', '"Open Sans", sans-serif');
            }

            applySiteLogo(b.site_logo);
        })
        .catch(function () { /* offline / not configured — leave page defaults */ });
})();
