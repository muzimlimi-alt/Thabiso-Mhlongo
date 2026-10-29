# Bandwidth optimisation: delivery report (Oct 2026)

Written 2026-10-29. Everything below is live on GitHub `main` / Render unless marked otherwise.

## 1. Why this was done
Render workspace is on the **Hobby** plan with **5 GB/month included outbound bandwidth**. On 2026-10-23 usage was 3.57 GB with 8 days left (about 0.155 GB/day, heading to about 4.9 GB, i.e. right at the limit).

## 2. Main bandwidth drivers found (measured, 2026-10-23)
| Driver | Evidence |
|---|---|
| Oversized photos (originals up to 12.6 MB) | repo `images/` 117 MB; R2 bucket 151 MB of images |
| Render streams every R2 image to Cloudflare on a cache miss | `serveFromObjectStorage` in `app.js` |
| Homepage HTML re-downloaded on every view (`no-store`) | ~48 KB Brotli x ~20k HTML requests/30 days (estimate) |
| All carousel/event/testimonial images loaded at page open | live first visit: 3.46 MB of images before scrolling |
| Bot traffic | 2.3k visits vs 64k requests (30 days); RU/DE/NL/SG heavy; 17.8% 4xx |

Not a driver: text compression. Render's proxy already serves Brotli to Cloudflare (204 KB homepage goes out at ~48 KB).

## 3. What was changed
| Change | Where | Status |
|---|---|---|
| Image optimiser (sharp): same name/format, longest edge <= 2000 px, mozjpeg q80, lossless PNG, EXIF stripped | `lib/image-optimize.js` | live |
| Admin `/upload` shrinks photos (not branding/accolades) | `routes/public/misc.js` | live |
| One-off clean-up script, dry-run by default | `scripts/optimize-images.js` | run once |
| Repo images 117 MB -> 25 MB | `images/` | live |
| R2 images 151.4 MB -> 16.75 MB (57 files); originals copied to `originals/<key>` | R2 bucket | done 2026-10-23, **do not re-run** (generation loss) |
| Homepage `Cache-Control: no-cache` (ETag -> 304) instead of `no-store` | `app.js` | live |
| Carousel loads only current + next slide; events/testimonial images `loading="lazy"` | `index.html`, `js/myscript.js` (`?v=1.9.11`) | live |
| Tests | `test/image-optimize.test.js`, `test/homepage-revalidation.test.js` | passing |

Cloudflare changes made by the owner in the dashboard (not in the repo):
- Purge Everything (2026-10-23).
- Cache Rule "Homepage 5 min": URI Path equals `/`, Edge TTL 5 min (ignore origin cache-control), Browser TTL respect origin. After a deploy, purge or wait 5 minutes.
- WAF custom rule "Challenge bot countries": Managed Challenge for RU, DE, NL, SG, excluding `/api/payment/webhook/`. Bot Fight Mode deliberately NOT used (cannot be exempted for PayFast ITN).

## 4. Results
**Directly measured**
- Render bandwidth used: 3.57 GB (Oct 23) -> 3.68 (Oct 25) -> **3.75 GB (Oct 29)**. That is about 0.03 GB/day since the changes, against about 0.155 GB/day before (about 80% lower).
- Live homepage, cold cache, desktop, full scroll: about **5.5 MB -> 3.4 MB** (Oct 23 vs Oct 29). Images loaded at page open **3.46 MB -> 1.04 MB**. Largest single image now ~0.67 MB (a 1024 px testimonial PNG).
- Isolated-server A/B of lazy loading: 11 image requests moved from page load to scroll; carousel 5 -> 2 at load; the active slide was loaded in 7/7 samples.
- Bot rule: 268 requests challenged in the first 2 days, 0% solved (all automated).

**Estimates / not verified**
- Month-end Render usage about 3.8 GB (extrapolation; final figure on 2026-11-01).
- The split of the saving between images, homepage caching and the bot rule is NOT known; they were deployed within days of each other.
- Lighthouse / LCP before-after was not run.

## 5. Render bill (checked 2026-10-29)
Unbilled to date $5.59, projected October **$6.33**: instance 0.5c-512mb $4.22 (448.75 h at $0.0094/h) + 10 GB disk $1.37; **Outgoing Bandwidth 3.75 GB shows no charge**. Invoices Jul-Sep were $0.00. No $15 line item has been seen anywhere. At 3.75 of 5 GB the evidence does **not** show a bandwidth charge this month; what the "$15" referred to was never identified.

## 6. Regression testing
| Area | Result |
|---|---|
| Automated suite, full run 2026-10-29 | 3408/3415 pass; 7 failures, none in code changed here (below) |
| Live public site, desktop 1440 px and phone 390 px | PASS: 0 broken images, 0 HTTP >= 400, hero/gallery/social embeds render |
| Admin (isolated server): login via the real form + all 24 sidebar sections | PASS: no JS errors; idle polling = 1 request/min (heartbeat) |
| PayFast sandbox payment, email send, M365, Places | NOT TESTED in this work (untouched; bot rule excludes the webhook path) |

The 7 failing checks are outside this work:
- 2 admin nav registry label checks ("Mailbox" vs "Inquiries", "Banners" vs "Email Banners"): from the admin navigation reorganisation commits.
- 3 inbox-sync "mock mode" checks: the test DB is copied from the owner's dev DB, where inbox sync is switched on.
- 1 tracked `test/.test(1).sqlite` OneDrive copy in git.
- 1 apple-touch-icon check: commit e36f59f9 deleted `images/icon/mic-apple-touch-icon.png` but `index.html` line 57 still links to it (live still returned 200 on 2026-10-29, probably from Cloudflare's cache).

## 7. Not done (and why)
- **Phase 4** (minify, fonts, duplicate libraries): Brotli already on; remaining gain small. Moving the 62 KB inline script out of `index.html` would save ~15 KB per uncached homepage view.
- **Phase 6** (API/polling): only the admin idle check was done (negligible). No other audit.
- **Phase 7** (bots): the country rule only. Render logs for the 4xx probes were not reviewed.
- **Phase 8** (PDFs/downloads): not audited.
- WebP/AVIF and `srcset`: skipped; gain after recompression is modest.

## 8. Risks and next steps
1. Re-read Render usage on 2026-11-01 and update this report with the final October figure.
2. Fix the apple-touch-icon link (or restore the file).
3. Keep the originals backups (`../image-originals-backup`, R2 `originals/`) for at least two weeks, then delete.
4. After each deploy, purge the Cloudflare cache if the homepage must update immediately.
5. If usage creeps up again: review Render logs for 4xx probing, then move the inline script out of `index.html`.
