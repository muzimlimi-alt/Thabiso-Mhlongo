# Atelier — Document Logo (PDF) Cleanup

## 0. Context

`js/pdfService.js` no longer embeds any image-based logo in generated invoice/quote
PDFs — `_drawHeader()` now renders the "Thabiso Mhlongo" wordmark as native PDF text
via `_drawWordmark()` (Cormorant Garamond, falls back to Times-Roman/Times-Italic if
the font files are absent). That change already shipped and is not part of this prompt.

What's left behind is a **fully orphaned feature**: a "Document Logo (PDF)" upload
field in the Branding admin section, plus its `doc_logo` / `DOC_LOGO` plumbing through
the database, server settings loader, and two API routes. None of it errors — it just
silently does nothing. This prompt removes it so the admin UI doesn't promise a result
it can't deliver.

---

## 1. FULL-STACK IMPACT ANALYSIS (MANDATORY)

| Layer | Affected? | What changes |
|---|---|---|
| **Database** | No schema change | `settings` table may already contain a `doc_logo` row. Left in place — see Edge Cases for optional manual cleanup. No migration. |
| **Backend — `server.js`** | Yes, 4 edits, same file | Remove `doc_logo`/`DOC_LOGO` from **three separate `envMap` literals** and **one `keys` array** (confirmed duplication — see §3). No route signatures change, no new routes, no removed routes. |
| **Backend — `js/pdfService.js`** | No change | Already migrated to text rendering in a prior change. Do not touch. |
| **Frontend — `admin.html` (markup)** | Yes, 1 section | Remove the "Document Logo (PDF)" upload field from the Branding → Email & PDF card; widen the remaining "Email Header Banner" field to fill the row; update card heading/description copy. |
| **Frontend — `admin.html` (JS)** | Yes, 2 functions | Remove the `doc_logo` line from `loadBrandingSettings()` and `saveBranding()`. `uploadBrandingAsset()` and `updateBrandPreview()` are shared by `site_logo`/`favicon`/`email_banner` — **do not modify**. |
| **Other consumers of `logo4.png`** | No change | Admin header `<img>`, email `cid` attachments (nodemailer), reset-password.html — all separate from this feature, untouched. |
| **Documentation** | No change | `ADMIN_GUIDE.md`, `README.md`, `task.md` never mentioned this feature — confirmed via grep, nothing to update. |

---

## 2. CONFIRMED SELECTORS & LINE REFERENCES (audited against source — do not re-derive)

**`server.js`** — four occurrences of `doc_logo`/`DOC_LOGO`, in three *separate* `envMap` literals plus one `keys` array (this duplication is pre-existing legacy from when these fields lived in the general System Settings panel before being moved to a dedicated Branding panel — out of scope to consolidate, just remove `doc_logo` from all of them):
- Line ~57 — startup settings loader (`db.all("SELECT setting_key, setting_value FROM settings"...)`)
- Line ~5612 — inside `app.put('/api/admin/settings', ...)`
- Line ~5636 — inside `app.put('/api/admin/branding', ...)`
- Line ~5656 — inside `app.get('/api/public/branding', ...)`

**`admin.html`**:
- Markup: `<!-- Card 3: Email & PDF Branding (moved from System Settings) -->` card, containing `#brandDocLogoFile` / `#brandDocLogoUrl` / `#brandDocLogoPreview` (the right-hand `col-md-6` in the row that also holds `#brandEmailBannerFile` etc.)
- JS: `window.loadBrandingSettings` (reads `b.doc_logo`)
- JS: `window.saveBranding` (writes `doc_logo` into the settings payload)

---

## 3. NON-NEGOTIABLE CONSTRAINTS

- Do **not** touch `js/pdfService.js` — already migrated, out of scope.
- Do **not** touch `site_logo`, `favicon`, `theme_font`, `primary_color`, or `email_banner` handling anywhere — only `doc_logo` is being removed.
- Do **not** modify `uploadBrandingAsset()` or `updateBrandPreview()` — generic, shared by the fields above.
- Do **not** touch the `/upload` route, `multer` storage config, or the `images/branding/` folder — shared infrastructure for other branding assets, not specific to this feature.
- Do **not** write a DB migration or auto-delete the `doc_logo` settings row — see Edge Cases.
- All four `server.js` edits must land together — fixing only one `envMap` leaves the others silently re-introducing `process.env.DOC_LOGO` on next save/restart.
- Preserve existing IDs/classes on everything that isn't being removed (`#brandEmailBannerFile`, `#brandEmailBannerUrl`, `#brandEmailBannerPreview`, etc.) — no renaming.

---

## 4. TASKS

### Task 1 — `server.js`: startup settings loader (~line 57)

```diff
- email_banner: 'EMAIL_BANNER', doc_logo: 'DOC_LOGO'
+ email_banner: 'EMAIL_BANNER'
```

### Task 2 — `server.js`: `/api/admin/settings` PUT envMap (~line 5612)

Same single-line change as Task 1, different occurrence (inside the `app.put('/api/admin/settings', ...)` handler's `envMap` object — disambiguate by the surrounding `smtp_pass: 'SMTP_PASS', smtp_from: 'SMTP_FROM',` line directly above it).

```diff
- email_banner: 'EMAIL_BANNER', doc_logo: 'DOC_LOGO'
+ email_banner: 'EMAIL_BANNER'
```

### Task 3 — `server.js`: `/api/admin/branding` PUT envMap (~line 5636)

```diff
- const envMap = { email_banner: 'EMAIL_BANNER', doc_logo: 'DOC_LOGO' };
+ const envMap = { email_banner: 'EMAIL_BANNER' };
```

### Task 4 — `server.js`: `/api/public/branding` GET keys array (~line 5656)

```diff
- const keys = ['site_logo', 'favicon', 'primary_color', 'theme_font', 'email_banner', 'doc_logo'];
+ const keys = ['site_logo', 'favicon', 'primary_color', 'theme_font', 'email_banner'];
```

### Task 5 — `admin.html`: remove the Document Logo (PDF) field, rebalance the row

Before:
```html
<div class="row">
    <div class="col-md-6" style="margin-bottom:16px;">
        <label class="um-label">Email Header Banner</label>
        ... (brandEmailBannerFile / Url / Preview) ...
    </div>
    <div class="col-md-6" style="margin-bottom:16px;">
        <label class="um-label">Document Logo (PDF)</label>
        ... (brandDocLogoFile / Url / Preview) ...
    </div>
</div>
```

After:
```html
<div class="row">
    <div class="col-md-12" style="margin-bottom:16px;">
        <label class="um-label">Email Header Banner</label>
        ... (brandEmailBannerFile / Url / Preview, unchanged) ...
    </div>
</div>
```

Delete the entire second `col-md-6` block (the `#brandDocLogoFile` / `#brandDocLogoUrl` /
`#brandDocLogoPreview` field). Change the first block's class from `col-md-6` to
`col-md-12` so it fills the row instead of leaving the right half empty.

### Task 6 — `admin.html`: update the card heading/description above it

```diff
- <!-- Card 3: Email & PDF Branding (moved from System Settings) -->
+ <!-- Card 3: Email Branding (moved from System Settings) -->
  <div class="atl-card" style="margin-bottom:20px;">
      <div class="um-icon-header" style="margin-bottom:16px;">
          <div class="um-icon-header__icon"><i class="fa-solid fa-envelope-open-text"></i></div>
          <div>
-             <h4 class="um-section-label">Email &amp; PDF Branding</h4>
-             <p class="um-section-desc">These images appear in outgoing emails and PDF quotes/invoices.</p>
+             <h4 class="um-section-label">Email Branding</h4>
+             <p class="um-section-desc">This image appears in outgoing emails.</p>
          </div>
      </div>
```

### Task 7 — `admin.html`: `loadBrandingSettings()` — drop the doc_logo line

```diff
  if (b.email_banner)  { $('#brandEmailBannerUrl').val(b.email_banner); updateBrandPreview('brandEmailBannerUrl','brandEmailBannerPreview'); }
- if (b.doc_logo)      { $('#brandDocLogoUrl').val(b.doc_logo);         updateBrandPreview('brandDocLogoUrl','brandDocLogoPreview'); }
```

### Task 8 — `admin.html`: `saveBranding()` — drop the doc_logo line

```diff
  const settings = {
      site_logo:     $('#brandLogoUrl').val().trim(),
      favicon:       $('#brandFaviconUrl').val().trim(),
      primary_color: $('#brandColorHex').val().trim() || $('#brandPrimaryColor').val(),
      theme_font:    $('#brandThemeFont').val(),
-     email_banner:  $('#brandEmailBannerUrl').val().trim(),
-     doc_logo:      $('#brandDocLogoUrl').val().trim()
+     email_banner:  $('#brandEmailBannerUrl').val().trim()
  };
```

(Note the trailing comma moves with `email_banner` since it's now the last key.)

---

## 5. EDGE CASES

- **A `doc_logo` row already exists in `settings` from prior use.** Leaving it is
  harmless — nothing reads it after this change. If you want it fully purged, run
  manually (not part of this prompt, no auto-migration): `DELETE FROM settings WHERE setting_key = 'doc_logo';`
- **Partial deploy (only `admin.html` or only `server.js` updated).** If only the
  frontend changes ship, `saveBranding()` simply stops sending `doc_logo` — the
  backend `envMap` entries become unreachable dead code but nothing breaks. If only
  `server.js` changes ship, the (now-orphaned) UI field still uploads/saves fine via
  the generic `/api/admin/branding` route, it just won't map to an env var. Neither
  partial state errors, but ship both together for a clean result.
- **Only one of the three `server.js` envMaps gets fixed.** The other two will still
  set `process.env.DOC_LOGO` on next settings save or server restart. Since nothing
  reads that env var anymore this is inert, not a functional bug — but it's exactly
  the kind of half-removed plumbing this prompt exists to avoid. Fix all three.

---

## 6. ACCEPTANCE CRITERIA

- [ ] No occurrences of `doc_logo` or `DOC_LOGO` remain in `server.js`
- [ ] No occurrences of `brandDocLogo` remain in `admin.html`
- [ ] `#brandEmailBannerFile` / `#brandEmailBannerUrl` / `#brandEmailBannerPreview` still present, unchanged, now full-width in their row
- [ ] `site_logo`, `favicon`, `primary_color`, `theme_font` fields/handlers completely unaffected
- [ ] `uploadBrandingAsset()` and `updateBrandPreview()` unmodified
- [ ] `js/pdfService.js` unmodified
- [ ] Card heading reads "Email Branding"; description reads "This image appears in outgoing emails."
- [ ] `/api/admin/branding` PUT and `/api/public/branding` GET both still work for the remaining fields

---

## 7. TEST PLAN

| Case | Steps | Expected |
|---|---|---|
| **Normal** | Open Branding tab | "Document Logo (PDF)" field is gone; "Email Header Banner" fills the row |
| **Normal** | Upload an Email Header Banner, Save Branding | Saves successfully, preview shows, persists on reload |
| **Normal** | Reload admin, revisit Branding | Previously-saved `site_logo`/`favicon`/`email_banner`/`theme_font`/`primary_color` all still populate correctly |
| **Edge** | DB already has a `doc_logo` row from before this change | Admin panel loads normally, no error, field simply isn't rendered |
| **Edge** | Generate an invoice/quote PDF after this change | Header wordmark renders exactly as before (this change doesn't touch `pdfService.js`) |
| **Regression** | `GET /api/public/branding` | Returns `site_logo`, `favicon`, `primary_color`, `theme_font`, `email_banner` — no `doc_logo` key |
| **Regression** | `PUT /api/admin/branding` with a body that still includes `doc_logo` (e.g. stale client cache) | Saves to DB as a generic key (no crash), but no `envMap` entry maps it to an env var — confirms cleanup is complete |
| **Failure** | Save Branding with all fields empty | No errors; `Object.keys(settings).forEach(...delete...)` still strips empty values as before |
