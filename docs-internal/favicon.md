# Site favicon

**One icon, one file: `images/icon/favicon.ico`** - the owner's file (16x16, 558 bytes). It used to be `favicon.ico` in the project root (a
16/32/48 px gold-microphone icon, with 48/96/192 px PNGs declared beside it). The owner replaced it on 2026-10-15 and confirmed on 2026-10-18 that the
new file is the one to use. The old gold-mic files stay on disk (`images/icon/mic-*.png`; the old root icon is in git history and survives as the
untracked local copy `favicon.old.ico`), but nothing links to them any more except the iOS `apple-touch-icon`.

## How it is wired

- `app.js` answers `GET /favicon.ico` (with or without a query string) with that file: `Content-Type: image/x-icon`, `Cache-Control: public, max-age=86400`.
  It is a route, like `/robots.txt`, registered before `express.static`, because the project root no longer holds a `favicon.ico`. It is deliberately not
  the static server's one-year `immutable` cache: the URL is fixed, so a future icon change has to be able to reach visitors.
- Every page head has ONE icon link, `<link rel="icon" href="/favicon.ico?v=3">`: `index.html`, `admin.html`, `confirm-subscription.html`,
  `unsubscribe.html`, `reset-password.html`. (`reset-password.html` used to point at `images/logo4.png`.) The `apple-touch-icon` - the iOS home-screen
  icon, a 180 px gold microphone - is a separate link and is unchanged.
- `js/applyBranding.js` swaps that link for the admin's Branding favicon (Admin > Branding) when one is set, present and under 200 KB. Leave the
  Branding favicon empty to use `images/icon/favicon.ico`. A missing or oversized Branding file keeps the default icon, and no longer covers the page
  with the full-page "Page Not Found" overlay: its probe request used to be turned into that overlay by the global fetch wrapper in
  `js/notificationService.js` (any non-API 404 is); it now passes `bypassInterceptor`.

## Changing the icon

1. Replace `images/icon/favicon.ico`.
2. Bump `?v=` in the five page heads (browsers keep icons far longer than any header says).
3. After the deploy, purge `/favicon.ico` in Cloudflare (Caching > Configuration > Custom Purge). Cloudflare sits in front of Render and the previous
   response was cacheable for a year, so a crawler that asks for the bare `/favicon.ico` can keep getting the old icon until it is purged. The page links
   carry `?v=`, which is a new cache key, so browsers pick the new icon up on their own. Google refreshes favicons slowly (days to weeks).

## Known trade-off

Google's guidance asks for a favicon whose side is a multiple of 48 px; this file is 16 px, so Google may show it soft or keep its default icon. The
tests therefore check that the icon is valid, served and consistent on every page - not its pixel size. A 48 px (or larger) version, added as extra
images inside the same `.ico` or as a PNG link, would close the gap.

## Tests

- `test/seo-crawl-files.test.js`: the file is a valid icon; one identical link on every page; served byte-for-byte at `/favicon.ico` and
  `/favicon.ico?v=N`; HEAD; cache headers (cacheable, not immutable); allowed by `robots.txt`.
- `test/browser/favicon.js`: the Branding override, the oversized and missing-file safeguards (no overlay), and the upload shrink.
