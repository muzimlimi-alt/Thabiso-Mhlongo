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
    function applyFavicon(href) {
        if (!href) return;
        var link = document.querySelector("link[rel~='icon']");
        if (!link) {
            link = document.createElement('link');
            link.rel = 'icon';
            document.head.appendChild(link);
        }
        link.href = href;
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
