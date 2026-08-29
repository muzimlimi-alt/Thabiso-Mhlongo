# Image Asset Reference Audit — Phase 1 (Read-Only Reconnaissance)

Generated: 2026-08-27
Scope: all 79 files under `images/`.

Method summary:
- **Source** = literal filename (or filename-without-extension) found via grep across all `.js`/`.html` files (root files + everything under `js/`) and `css/*.css`.
- **DB** = value found in a live row of `database.sqlite` (queried with the `sqlite3` CLI). Tables checked: `settings`, `gallery_images`, `banners`, `home_slider`, `testimonials`, `footprint_countries`, `services` (no image column), plus `about_me`, `events`, `career_highlights` (discovered while tracing DB-dump hits — not in the original required list but clearly hold image paths and were checked for completeness). A full `.dump` was also grepped for every filename that had no hit in the required tables, to rule out storage in an unexpected table (e.g. JSON blobs in `bookings`).
- **Template** = literal filename found in `js/emailComponents.js`, `js/emailTemplates.js`, `js/mergeFields.js`, `js/bannerRegistry.js`, `js/pdfService.js`. (`js/emailAssets.js` is also an email-asset file and is noted separately in Notes since it holds two of the site's hardcoded email attachments; it is technically already covered by the general "Source" js/ sweep.)
- **CSS** = `url(...)` or class-based background-image reference found in `css/*.css` or inline `<style>` blocks in `admin.html`.

Label rules applied exactly as specified:
- `REFERENCED` — a static code reference exists (Source, Template, or CSS = Yes), regardless of DB status.
- `DB-ONLY` — no static code reference, but a live DB row points at the file.
- `NO-REFERENCE-FOUND` — none of the four checks found anything. This is **not** a claim the file is unused — only that no reference was found by these four checks.

Several filenames collide across folders (e.g. `image-slider-1.jpg` exists at the repo root, under `gallery/`, and twice under `branding/` with hash prefixes; `WhatsApp Image … .jpeg` exists in both `carousel/` and `gallery/`). Every basename hit was manually opened and checked against the **full path string** in the matching line so that a hit on one copy is never misattributed to a different copy of the same name. Several apparent leads turned out to be false positives from this exact trap and are called out in Notes.

## Full inventory (79 files)

| Filename | Path | Label | Source? | DB? | Template? | CSS? | Notes |
|---|---|---|---|---|---|---|---|
| 1784119131960-image-slider-6.jpg | images/1784119131960-image-slider-6.jpg | DB-ONLY | No | Yes | No | No | `career_highlights` row id=2 (2014 highlight), `image_path` column. |
| 1784575625778-image6.JPG | images/1784575625778-image6.JPG | NO-REFERENCE-FOUND | No | No | No | No | No hit anywhere (case-insensitive re-check also negative). |
| 1784575666128-1784119144424-image-slider-7.jpg | images/1784575666128-1784119144424-image-slider-7.jpg | DB-ONLY | No | Yes | No | No | `career_highlights` row id=3 (2015 highlight), `image_path` column. |
| 1784903267686-1784575666128-1784119144424-image-slider-7.jpg | images/1784903267686-1784575666128-1784119144424-image-slider-7.jpg | NO-REFERENCE-FOUND | No | No | No | No | Byte-identical duplicate of the file above (same content, re-uploaded under a newer timestamped name) but this specific filename is not referenced anywhere. |
| 1782308364892-480681105_1563104084637146_1105632398058673475_n.jpg | images/about/1782308364892-480681105_1563104084637146_1105632398058673475_n.jpg | DB-ONLY | No | Yes | No | No | `about_me.image_path` (single-row table). NOTE: `index.html:348` references `images/480681105_1563104084637146_1105632398058673475_n.jpg` — same basename tail but **no hash prefix and no `about/` folder** — that string does not resolve to this (or any) real file under `images/`, so it does not count as a Source hit for this file. |
| thabiso_login_background_1920x1080.png | images/background/thabiso_login_background_1920x1080.png | REFERENCED | Yes | No | No | No | `reset-password.html:159`, `admin.html:4965`, `js/myscript.js:3394` (`DEFAULT_LOGIN_BG`). |
| banner.png | images/banner/banner.png | DB-ONLY | No | Yes | No | No | `settings.email_banner` = `\images\banner\banner.png`. Not the same file as `banner_4_centerstage1.png` (different hash, different row below). |
| banner_4_centerstage1.png | images/banner/banner_4_centerstage1.png | REFERENCED | Yes | No | Yes | No | `js/emailAssets.js:13,30` (`ASSETS.banner`, CID-embedded email attachment). Also mentioned in a code comment in `scripts/seed-banner-templates.js:134` (out of required scope, corroborating only). |
| 1784235338270-e2c3c632.jpg | images/banners/1784235338270-e2c3c632.jpg | DB-ONLY | No | Yes | No | No | `banners` id=3, category "Booking Requests", `image_url`. |
| 1784235354481-551eb502.jpg | images/banners/1784235354481-551eb502.jpg | DB-ONLY | No | Yes | No | No | `banners` id=4, "Quotes & Proposals". |
| 1784043284878-ce0fd7b8.jpg | images/banners/1784043284878-ce0fd7b8.jpg | DB-ONLY | No | Yes | No | No | `banners` id=5, "Contracts & Signatures". |
| 1784043357709-0e3fc18e.jpg | images/banners/1784043357709-0e3fc18e.jpg | DB-ONLY | No | Yes | No | No | `banners` id=6, "Payments & Invoices". |
| 1784043436803-7bc2ea17.jpg | images/banners/1784043436803-7bc2ea17.jpg | DB-ONLY | No | Yes | No | No | `banners` id=7, "Booking Confirmations". |
| 1784043524621-a9bbd6dd.jpg | images/banners/1784043524621-a9bbd6dd.jpg | DB-ONLY | No | Yes | No | No | `banners` id=8, "Event Reminders". |
| 1784043620823-881a60b5.jpg | images/banners/1784043620823-881a60b5.jpg | DB-ONLY | No | Yes | No | No | `banners` id=9, "Thank You & Reviews". |
| 1784043780238-0b317b70.jpg | images/banners/1784043780238-0b317b70.jpg | DB-ONLY | No | Yes | No | No | `banners` id=10, "Booking Recovery". |
| 1784043849861-bf8bb559.jpg | images/banners/1784043849861-bf8bb559.jpg | DB-ONLY | No | Yes | No | No | `banners` id=11, "Contact & Support". |
| 1784043971086-2d56873c.jpg | images/banners/1784043971086-2d56873c.jpg | DB-ONLY | No | Yes | No | No | `banners` id=12, "Newsletters & Marketing". |
| 1784044083319-d6cb4f5d.jpg | images/banners/1784044083319-d6cb4f5d.jpg | DB-ONLY | No | Yes | No | No | `banners` id=13, "User Accounts & Security". |
| 1784061539840-bc59828c.jpg | images/banners/1784061539840-bc59828c.jpg | DB-ONLY | No | Yes | No | No | `banners` id=14, "Birthday Celebration". |
| 1784466198897-cc4a3ca9.png | images/banners/1784466198897-cc4a3ca9.png | NO-REFERENCE-FOUND | No | No | No | No | Not a row in `banners`; not in any other table (full `.dump` grep negative); byte-identical to the other 7 rows in this block (duplicate group, see below). |
| 1784475409375-7e5f3fc3.png | images/banners/1784475409375-7e5f3fc3.png | NO-REFERENCE-FOUND | No | No | No | No | Same as above. |
| 1784491390425-ccbd7596.png | images/banners/1784491390425-ccbd7596.png | NO-REFERENCE-FOUND | No | No | No | No | Same as above. |
| 1784528141936-1c040aae.png | images/banners/1784528141936-1c040aae.png | NO-REFERENCE-FOUND | No | No | No | No | Same as above. |
| 1784567621501-490687d5.png | images/banners/1784567621501-490687d5.png | NO-REFERENCE-FOUND | No | No | No | No | Same as above. |
| 1784569531152-992f4e0a.png | images/banners/1784569531152-992f4e0a.png | NO-REFERENCE-FOUND | No | No | No | No | Same as above. |
| 1784621611324-e16958e7.png | images/banners/1784621611324-e16958e7.png | NO-REFERENCE-FOUND | No | No | No | No | Same as above. |
| 1784622172695-2b00a956.png | images/banners/1784622172695-2b00a956.png | NO-REFERENCE-FOUND | No | No | No | No | Same as above (8th of 8). |
| 1782116078275-image-slider-1.jpg | images/branding/1782116078275-image-slider-1.jpg | NO-REFERENCE-FOUND | No | No | No | No | Byte-identical to root `image-slider-1.jpg` / `gallery/image-slider-1.jpg`, but this specific hashed copy is not referenced anywhere. |
| 1784904002334-image-slider-1.jpg | images/branding/1784904002334-image-slider-1.jpg | NO-REFERENCE-FOUND | No | No | No | No | Same duplicate group as above; not referenced. |
| 1785228150867-logo4.png | images/branding/1785228150867-logo4.png | DB-ONLY | No | Yes | No | No | `settings.site_logo`. Distinct from root `images/logo4.png` (different hash, different content). |
| 1785228187010-logo5.png | images/branding/1785228187010-logo5.png | DB-ONLY | No | Yes | No | No | `settings.favicon`. Byte-identical to `images/icon/logo5.png` but this exact path is DB-only. |
| 1785410951796-thabiso_login_background_1920x1080.png | images/branding/1785410951796-thabiso_login_background_1920x1080.png | DB-ONLY | No | Yes | No | No | `settings.login_background`. Byte-identical to `images/background/thabiso_login_background_1920x1080.png`, but the source references (reset-password.html, admin.html, myscript.js) all point at the `background/` copy, not this one — confirmed by reading full path strings, not just basenames. |
| WhatsApp Image 2026-04-19 at 23.28.32.jpeg | images/carousel/WhatsApp Image 2026-04-19 at 23.28.32.jpeg | DB-ONLY | No | Yes | No | No | `home_slider` id=7, `url` column. |
| WhatsApp Image 2026-04-19 at 23.28.33.jpeg | images/carousel/WhatsApp Image 2026-04-19 at 23.28.33.jpeg | DB-ONLY | No | Yes | No | No | `home_slider` id=8. |
| WhatsApp Image 2026-04-19 at 23.28.34 (1).jpeg | images/carousel/WhatsApp Image 2026-04-19 at 23.28.34 (1).jpeg | DB-ONLY | No | Yes | No | No | `home_slider` id=9. |
| 1.jpg | images/events/1.jpg | REFERENCED | Yes | Yes | No | No | Source: `admin.html:15009` (`submitAPIEvent('images/events/1.jpg')`), `js/myscript.js:469,565` (fallback poster). DB: `events` rows 12, 26, 31 literally store this as `poster_image_path` (used as the default/fallback poster). |
| 1778787987051-1001252636.jpg | images/events/1778787987051-1001252636.jpg | DB-ONLY | No | Yes | No | No | `events` row 11 ("Graduation Party"), `poster_image_path`. |
| 1780164242158-image-slider-8.jpg | images/events/1780164242158-image-slider-8.jpg | DB-ONLY | No | Yes | No | No | `events` row 1 ("Comedy Festival of Festivals"). |
| 1784567888890-1001324529.png | images/events/1784567888890-1001324529.png | NO-REFERENCE-FOUND | No | No | No | No | Not any `events.poster_image_path` value; full `.dump` grep negative; no source/CSS hit. |
| 489822718_1604895087124712_4700936238744391984_n.jpg | images/events/489822718_1604895087124712_4700936238744391984_n.jpg | DB-ONLY | No | Yes | No | No | `events` row 5 ("I've Got Friends Too Comedy Show"). |
| 496081216_18503252767009800_5399237411642452873_n.jpg | images/events/496081216_18503252767009800_5399237411642452873_n.jpg | DB-ONLY | No | Yes | No | No | `events` row 4 ("Mother's Day Edition"). |
| 501288231_18507365521009800_1293922417313324283_n.jpg | images/events/501288231_18507365521009800_1293922417313324283_n.jpg | DB-ONLY | No | Yes | No | No | `events` row 3 ("Jazz & Comedy with Thabiso Mhlongo"). |
| 909a465d7e9c4b33b893d7de567e34a5.jpg | images/events/909a465d7e9c4b33b893d7de567e34a5.jpg | NO-REFERENCE-FOUND | No | No | No | No | Not an `events.poster_image_path` value. A `bookings` row (id 100000) has an unrelated JSON `attachments` blob with `"original_name":"909a465d7e9c4b33b893d7de567e34a5.jpg"` — but its actual stored file is `docs/booking_attachments/booking-100000-1781354281064-909a465d7e9c4b33b893d7de567e34a5.jpg` (verified to exist at that separate path), i.e. a different upload that coincidentally shares this basename. Not a genuine reference to this `images/events/` file. |
| Screenshot 2026-03-06 230701.jpg | images/events/Screenshot 2026-03-06 230701.jpg | DB-ONLY | No | Yes | No | No | `events` row 2 ("Thabiso Mhlongo LIVE"). |
| d2af6e2a-f17e-43c0-87d1-8529fa0d4b86.jpg | images/events/d2af6e2a-f17e-43c0-87d1-8529fa0d4b86.jpg | DB-ONLY | No | Yes | No | No | `events` row 6 ("Bioscope Sundays"). |
| flag-cape-verde.png | images/footprint/flag-cape-verde.png | REFERENCED | Yes | No | No | No | `database.js:391` (footprint_countries seed array). Not present in the *current* `footprint_countries` rows (Cape Verde isn't in the live table at all) — this is a seed-script-only reference. |
| flag-eswatini.png | images/footprint/flag-eswatini.png | REFERENCED | Yes | Yes | No | No | `database.js:389` (seed) **and** live `footprint_countries` row id=10 (`flag_image_path`) — the only flag still stored locally; the others in the live table now use `flagcdn.com` URLs. |
| flag-japan.png | images/footprint/flag-japan.png | REFERENCED | Yes | No | No | No | `database.js:393` (seed only; not in current live table). |
| flag-lesotho.png | images/footprint/flag-lesotho.png | REFERENCED | Yes | No | No | No | `database.js:390` (seed only; not in current live table). |
| flag-south-africa.png | images/footprint/flag-south-africa.png | REFERENCED | Yes | No | No | No | `database.js:388` (seed only). Live `footprint_countries` row for South Africa (id=16) now uses `https://flagcdn.com/w320/za.png` instead. |
| flag-spain.png | images/footprint/flag-spain.png | REFERENCED | Yes | No | No | No | `database.js:392` (seed only; not in current live table). |
| WhatsApp Image 2026-04-19 at 23.28.32 (3).jpeg | images/gallery/WhatsApp Image 2026-04-19 at 23.28.32 (3).jpeg | DB-ONLY | No | Yes | No | No | `gallery_images` row 19 ("Thabiso Having Fun"). |
| WhatsApp Image 2026-04-19 at 23.28.32.jpeg | images/gallery/WhatsApp Image 2026-04-19 at 23.28.32.jpeg | DB-ONLY | No | Yes | No | No | `gallery_images` row 15 ("Thabiso The Thug"). |
| WhatsApp Image 2026-04-19 at 23.28.33.jpeg | images/gallery/WhatsApp Image 2026-04-19 at 23.28.33.jpeg | DB-ONLY | No | Yes | No | No | `gallery_images` row 16. |
| WhatsApp Image 2026-04-19 at 23.28.34 (1).jpeg | images/gallery/WhatsApp Image 2026-04-19 at 23.28.34 (1).jpeg | DB-ONLY | No | Yes | No | No | `gallery_images` row 17. |
| WhatsApp Image 2026-04-19 at 23.28.34 (2).jpeg | images/gallery/WhatsApp Image 2026-04-19 at 23.28.34 (2).jpeg | DB-ONLY | No | Yes | No | No | `gallery_images` row 20 ("Thabiso Having Fun"). |
| WhatsApp Image 2026-04-19 at 23.28.34.jpeg | images/gallery/WhatsApp Image 2026-04-19 at 23.28.34.jpeg | DB-ONLY | No | Yes | No | No | `gallery_images` row 18. |
| WhatsApp Image 2026-04-19 at 23.28.35 (3).jpeg | images/gallery/WhatsApp Image 2026-04-19 at 23.28.35 (3).jpeg | DB-ONLY | No | Yes | No | No | `gallery_images` row 21 ("Thabiso Having Fun"). |
| WhatsApp Image 2026-04-19 at 23.28.35.jpeg | images/gallery/WhatsApp Image 2026-04-19 at 23.28.35.jpeg | DB-ONLY | No | Yes | No | No | `gallery_images` row 22 ("Thabiso Having Fun"). |
| image-slider-1.jpg | images/gallery/image-slider-1.jpg | DB-ONLY | No | Yes | No | No | `gallery_images` row 23 ("Thabiso Mhlongo BW"). NOTE: `database.js:691` contains the string `images/image-slider-1.jpg` for the *`home_slider`* seed, but that literal path (no `gallery/` segment) does not resolve to this file — it resolves to (and matches) the root copy instead. Treated as No for Source here to avoid a false positive. |
| image-slider-11.JPG | images/gallery/image-slider-11.JPG | DB-ONLY | No | Yes | No | No | `gallery_images` row 5. |
| image-slider-12.JPG | images/gallery/image-slider-12.JPG | DB-ONLY | No | Yes | No | No | `gallery_images` row 6. |
| image-slider-13.JPG | images/gallery/image-slider-13.JPG | DB-ONLY | No | Yes | No | No | `gallery_images` row 7. |
| image-slider-3.jpg | images/gallery/image-slider-3.jpg | DB-ONLY | No | Yes | No | No | `gallery_images` row 24. Same `database.js:693` false-lead caveat as `image-slider-1.jpg` above (seed references root `images/image-slider-3.jpg`, which doesn't exist as a real file; only `gallery/image-slider-3.jpg` does). |
| image-slider-4.jpg | images/gallery/image-slider-4.jpg | DB-ONLY | No | Yes | No | No | `gallery_images` row 25. Same caveat (`database.js:694`). |
| image-slider-5.jpg | images/gallery/image-slider-5.jpg | DB-ONLY | No | Yes | No | No | `gallery_images` row 26. Same caveat (`database.js:695`). |
| image-slider-9.JPG | images/gallery/image-slider-9.JPG | DB-ONLY | No | Yes | No | No | `gallery_images` row 3. |
| logo5.png | images/icon/logo5.png | REFERENCED | Yes | No | No | No | Favicon links: `confirm-subscription.html:7`, `unsubscribe.html:7`, `admin.html:14,4958`, `index.html:27`. Byte-identical to `images/branding/1785228187010-logo5.png` (the DB-only favicon setting value) but this specific hardcoded path is the one actually wired into every page's `<link rel="icon">`. |
| image-slider-1.jpg | images/image-slider-1.jpg | REFERENCED | Yes | Yes | No | No | Source: `index.html:210` (hero carousel `<img>`), `admin.html:9207,26381` (preview/placeholder), `server.js:17813` (fallback default), `database.js:691` (`home_slider` seed). |
| images.lnk | images/images.lnk | NO-REFERENCE-FOUND | No | No | No | No | Not an image — a stray Windows `.lnk` shortcut file. No reference found anywhere. |
| logo4.png | images/logo4.png | REFERENCED | Yes | No | Yes | No | Source: `confirm-subscription.html:188`, `unsubscribe.html:188`, `reset-password.html:9`, `admin.html:5181`, `server.js:2785,8712`. Template: `js/emailAssets.js:14,38` (email logo attachment). |
| services-01.jpg | images/services/services-01.jpg | REFERENCED | No | No | No | Yes | `css/redesign.css:963` (`.tm-service__bg--1`). |
| services-02.jpg | images/services/services-02.jpg | REFERENCED | No | No | No | Yes | `css/redesign.css:964` (`.tm-service__bg--2`). |
| services-03.jpg | images/services/services-03.jpg | REFERENCED | No | No | No | Yes | `css/redesign.css:965` (`.tm-service__bg--3`). |
| services-04.jpg | images/services/services-04.jpg | REFERENCED | No | No | No | Yes | `css/redesign.css:966` (`.tm-service__bg--4`). |
| 1784133148752-1779394799687-ChatGPT_Image_Apr_15__2025__05_54_42_PM.png | images/testimonials/1784133148752-1779394799687-ChatGPT_Image_Apr_15__2025__05_54_42_PM.png | DB-ONLY | No | Yes | No | No | `testimonials` row 4 (Muzi Mlimi). |
| 1784134667818-ChatGPT_Image_Apr_15__2025__05_51_23_PM.png | images/testimonials/1784134667818-ChatGPT_Image_Apr_15__2025__05_51_23_PM.png | DB-ONLY | No | Yes | No | No | `testimonials` row 2 (Sipho Maseko). |
| 1784134909009-ChatGPT_Image_Apr_15__2025__06_04_42_PM.png | images/testimonials/1784134909009-ChatGPT_Image_Apr_15__2025__06_04_42_PM.png | DB-ONLY | No | Yes | No | No | `testimonials` row 1 (Naledi Khumalo). |

## Duplicate groups (byte-identical content, via sha256sum)

Verified twice (`sort | uniq -c` on the hash column). **9 duplicate groups found**, not 8 — see summary note below.

1. **hash `071bac1a…`** (2 files)
   - `images/carousel/WhatsApp Image 2026-04-19 at 23.28.34 (1).jpeg` — DB-ONLY (home_slider)
   - `images/gallery/WhatsApp Image 2026-04-19 at 23.28.34 (1).jpeg` — DB-ONLY (gallery_images)

2. **hash `3a65b710…`** (2 files)
   - `images/branding/1785228150867-logo4.png` — DB-ONLY (settings.site_logo)
   - `images/logo4.png` — REFERENCED (source, template)

3. **hash `42568b5d…`** (4 files)
   - `images/branding/1782116078275-image-slider-1.jpg` — NO-REFERENCE-FOUND
   - `images/branding/1784904002334-image-slider-1.jpg` — NO-REFERENCE-FOUND
   - `images/gallery/image-slider-1.jpg` — DB-ONLY (gallery_images)
   - `images/image-slider-1.jpg` — REFERENCED (source)

4. **hash `4f372a7c…`** (2 files)
   - `images/branding/1785228187010-logo5.png` — DB-ONLY (settings.favicon)
   - `images/icon/logo5.png` — REFERENCED (source)

5. **hash `501e04a1…`** (2 files)
   - `images/carousel/WhatsApp Image 2026-04-19 at 23.28.32.jpeg` — DB-ONLY (home_slider)
   - `images/gallery/WhatsApp Image 2026-04-19 at 23.28.32.jpeg` — DB-ONLY (gallery_images)

6. **hash `586191a8…`** (2 files)
   - `images/carousel/WhatsApp Image 2026-04-19 at 23.28.33.jpeg` — DB-ONLY (home_slider)
   - `images/gallery/WhatsApp Image 2026-04-19 at 23.28.33.jpeg` — DB-ONLY (gallery_images)

7. **hash `da3ce418…`** (2 files)
   - `images/background/thabiso_login_background_1920x1080.png` — REFERENCED (source)
   - `images/branding/1785410951796-thabiso_login_background_1920x1080.png` — DB-ONLY (settings.login_background)

8. **hash `f215504c…`** (8 files) — the largest group, and entirely orphaned
   - `images/banners/1784466198897-cc4a3ca9.png` — NO-REFERENCE-FOUND
   - `images/banners/1784475409375-7e5f3fc3.png` — NO-REFERENCE-FOUND
   - `images/banners/1784491390425-ccbd7596.png` — NO-REFERENCE-FOUND
   - `images/banners/1784528141936-1c040aae.png` — NO-REFERENCE-FOUND
   - `images/banners/1784567621501-490687d5.png` — NO-REFERENCE-FOUND
   - `images/banners/1784569531152-992f4e0a.png` — NO-REFERENCE-FOUND
   - `images/banners/1784621611324-e16958e7.png` — NO-REFERENCE-FOUND
   - `images/banners/1784622172695-2b00a956.png` — NO-REFERENCE-FOUND

9. **hash `f9bce079…`** (2 files)
   - `images/1784575666128-1784119144424-image-slider-7.jpg` — DB-ONLY (career_highlights)
   - `images/1784903267686-1784575666128-1784119144424-image-slider-7.jpg` — NO-REFERENCE-FOUND

**Discrepancy note:** this audit independently computed sha256 for all 79 files and found **9** duplicate groups (verified twice), not the 8 the task brief expected. Group 3 (the 4-way `image-slider-1.jpg` tie across `branding/` ×2, `gallery/`, and root) is the most likely place a manual/earlier count could have under- or over-grouped, but all 9 groups above are confirmed by hash equality — a human should re-verify which one the baseline is missing (or double-counting) before relying on either number.
