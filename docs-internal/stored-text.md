# Stored text: how user text is held, and who has to decode it

Audit and fix of 2026-10-11. Code-level explanation lives in `lib/html-sanitize.js` (server) and `js/shared/stored-text.js`
(browser); this is the map and the decisions.

## The convention (unchanged)

`app.js` `deepEscapeBody` entity-encodes every string in a request body **once** before any route runs, so the database holds
`Tom &amp; Jerry&#x27;s`. That form is correct for exactly one consumer: HTML injected as markup (`.html()`, `innerHTML`,
`${}` into a template), where the browser decodes it once. Every other consumer must work from the decoded text.

## What was wrong

| Symptom | Cause | Fix |
|---|---|---|
| Career highlight showed `&amp;quot;Celeste &amp;amp; Da Big Dudes&amp;quot;` | admin editors loaded the encoded text into form boxes; every save encoded it again (stacked layers) | `.val()` decodes (`js/shared/stored-text.js`); writes are idempotent (`normalizeEncodedText`) |
| Client emails: `Hi O&#x27;Brien &amp; Sons` | email helpers escaped the already-encoded value (`escapeEmailHtml`, `emailComponents.esc`, abandoned-booking `esc`) | decode first, then escape |
| Email subjects: `Re: Tom &amp; Jerry&#x27;s` | subject header is plain text, stored form was sent | `decodeStoredText(subject)` at the SMTP boundary only (the notifications queue / email log keep the HTML-safe form) |
| Admin replies (direct email, booking respond) went out as literal `<p>…</p>`; legal drafts would publish as literal tags | Quill HTML went through `deepEscapeBody` | `RAW_HTML_BODY_FIELDS` in `app.js` exempts exactly those keys; the routes sanitise with `sanitizeAboutHtml`; boot repair restores rows saved encoded |
| Quote/invoice PDFs printed `MC &amp; Host &quot;Premium&quot;` | PDFKit prints plain text | `decodeStoredDeep` at the top of `generateDocument` |
| Google Calendar events had entities in title/location/description | plain-text API | `decodeStoredText` in `lib/calendar-sync.js` |
| Testimonial and manager text, deal-view title, Users list, dashboard schedule showed entities (the public tracking drawer uses the same `.text()` path - covered by the same fix, not separately tested) | `.text()` / `esc()` / `textContent` on the stored form | jQuery `.text()` decodes; the admin `escHtml`/`esc` helpers decode first; two native assignments fixed by hand |
| Multipart creates (testimonials, gallery, footprint, highlights) stored RAW text, JSON edits stored encoded | multer parses the body after `deepEscapeBody` ran | `normalizeBodyFields([...])` after multer |

## Rules going forward

* A **form box** or **text node** gets stored text via `.val()` / `.text()` (decoded for you) or `decodeStoredText()` for native `.value` / `.textContent`.
* An **escape helper** must `decodeStoredText` first, or it double-encodes.
* A **plain-text sink** (email subject, PDF, calendar, CSV, SMS) must decode.
* A **new multipart route** must call `normalizeBodyFields` for its text fields.
* A **new rich-text (Quill) field sent as JSON** must be added to `RAW_HTML_BODY_FIELDS` and sanitised in its route.
* Passwords keep the old single encode in `deepEscapeBody` (their stored hashes were made from it) - do not "fix" that.

## Deliberately not changed

* Newsletter content, birthday settings, about-me and site-content: already raw/sanitised on their own paths.
* Accolades and the Management Team store **decoded** text and render it as text (see `lib/accolades.js`, `lib/team.js`). The jQuery decode would collapse a literal `&amp;` typed into those, which is an accepted edge case.
* A literal `&amp;` / `&lt;` typed on purpose into any other field is now saved as `&` / `<`. Acceptable for names, titles and notes.
* `.html()` is not patched - it is the consumer the encoded form is for.

## Not covered (known)

Native `el.value = x` / `el.textContent = x` assignments added in future code, any other plain-text sink (CSV exports, SMS) added
in future, and audit-log snapshots (they record whatever was stored at the time, stacked layers included).

Tests: `test/stored-text.test.js` (+ `test/stored-text.child.js`), `test/career-highlights.test.js`, `test/browser/stored-text.js`,
`test/browser/career-highlights.js`.
