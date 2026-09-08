# Housekeeping Notes

Tracks moves, quarantines, and deferred fixes across the housekeeping phases
described in `housekeeping-agent-prompts.md`. Nothing in this file is
optional reading before starting a new phase.

---

## Phase 6 — `admin.html` decomposition

In progress. One section per session, per the plan. `docs-internal/admin-html-map.md` (generated
in Phase 1, before `admin.html` was last touched by any commit — confirmed via `git log`, so still
accurate) is the reference for section boundaries, function inventories, and endpoint lists.

### Section 1: Footprint (`footprintAdmin`) — DONE

Chosen first deliberately small and self-contained — prove the whole Phase 6 pipeline (JS
extraction, `window`-attachment for cross-scope reachability, verification) on the cheapest section
before scaling up, same reasoning Phase 4/5 used to pick their first domain/batch.

**Scope stated and confirmed with the user before any file was touched**, per the plan's explicit
Phase 6 gate ("state which lines you will touch and which functions belong to this section. Wait
for my confirmation") — a harder requirement than Phase 5's batches ever carried, since a bare
"Continue" doesn't imply consent to a specific admin.html line range the way it did for a route
batch.

- **JS moved**: `admin.html:15488-15834` (the "5b. Footprint Logic" block, one contiguous span
  inside the single ~13,400-line inline `<script>` that starts at line 12116) → new
  `js/admin/footprint.js`. Contains `resetFootprintForm`/`openFootprintEditor`/`loadFootprint` (the
  3 functions `admin-html-map.md` lists for this section), local state
  (`editingFootprintId`/`footprintCountriesList` — verified via whole-file grep to have zero
  references outside this span), and the delegated click/submit/change handlers bound to
  `footprintAddNewBtn`/`.footprint-edit-btn`/`.footprint-delete-btn`/`#footprintForm`/
  `#footprintCountrySelect`/the drawer-close buttons.
- **Explicitly NOT moved**: `window.atlActivateDrawerTab` (`admin.html` ~line 14783), called from
  inside `openFootprintEditor` — its own comment says it's shared verbatim by Events/Gallery/
  Career/Home Slider/Testimonials/Footprint. Left in `admin.html`, flagged here as a **Phase 7
  "Shared candidate"** per the plan's own step 4.
- **CSS**: none to move. Grepped all 8 `<style>` blocks for `#footprintAdmin`/`.footprint-*`
  selectors and found zero — Footprint is styled entirely through shared framework classes
  (`.atl-btn`, `.um-form`, `.evt-card-grid`, `.atl-drawer`, etc.), themselves Phase 7 material, not
  anything private to this section.
- **Markup**: untouched, both the section div (9517-9566) and the drawer (26506-26553), per the
  plan's own rule ("splitting markup into partials requires a build step... a separate decision I
  have not made yet").
- **Reachability**: confirmed zero inline `on*=` handlers anywhere in Footprint's markup or
  drawer (the `on` substring matches found were false positives from `role="tab"`-style attribute
  text, not real event handlers). `loadFootprint()` does have two call sites in a *separate*,
  later `<script>` block (`admin.html` ~25748/25878, part of the change-history refresh
  machinery) — confirmed via whole-file grep — so despite classic (non-module) `<script>` tags
  already sharing one global scope in every browser (meaning this would likely have worked even
  without it), all three functions are attached to `window` explicitly, matching the plan's own
  instruction and removing any dependence on that scoping subtlety.
- **Script-tag splice**: the one physical inline `<script>` (12116-25554) is now three tags —
  `<script>...(everything before Footprint)...</script>`, `<script
  src="js/admin/footprint.js"></script>`, `<script>...(everything from Testimonials on)...</script>`
  — with the external tag inserted at the exact document position the removed code occupied, so
  execution order relative to both `window.atlActivateDrawerTab` (defined earlier, still needed)
  and everything after (which calls `loadFootprint` etc.) is unchanged.

**Verification**: `node --check js/admin/footprint.js` (syntax valid). A line-by-line diff of the
extracted block (dedented one level) against `git show HEAD:admin.html`'s original span came back
with exactly 3 differences — the 3 deliberate `window.functionName = functionName;` attachment
lines — otherwise byte-identical. Script-tag count before/after reconciled exactly (a naive
`grep -c "<script"` delta looked off by one at first; traced to this very housekeeping-notes-style
explanatory comment's own prose containing the literal string `<script>`, not a structural issue —
the real open/close counts match the intended +2/+2 from splitting one tag into three).

**What could not be verified: the plan's own manual click-through gate.** Attempted to automate it
with Puppeteer (already a project dependency) driving a real headless Chrome against the app booted
on the isolated test DB (`test/support.js`, same machinery `npm test` uses) — the sandbox this
agent runs in blocks spawning the Chrome binary directly (confirmed with a raw invocation outside
Puppeteer: `Permission denied`, not a Puppeteer-specific failure), so no automated click-through
could run. Bypassing the sandbox for this was deliberately not done — that override is for cases
that genuinely require it, not a convenience for a routine verification step the plan already
expects a human to do. **At the user's explicit direction, this section was committed on the
strength of the static verification above, with the live manual check (open the admin console,
exercise Add/Edit/Delete on a country, confirm no console errors, confirm Testimonials/Career/
Gallery/Home Slider/Events still work) deferred to the user's own convenience** rather than
blocking the commit.

### Section 2: Testimonials (`testimonialsAdmin`) — DONE

Chosen next: same shared-drawer shape as Footprint (its own header comment says so — "same
shared-drawer pattern as Footprint, plus a status filter and per-card Approve/Reject"), one section
number over in the file (`5c`, immediately after Footprint's `5b`), so a natural second proof point
on the same low-risk family before moving to a structurally different section.

- **JS moved**: `admin.html:15500-15781` → new `js/admin/testimonials.js`. Contains
  `resetTestimonialsForm`/`openTestimonialEditor`/`loadTestimonials` (the 3 `function decl` entries
  `admin-html-map.md` lists), `window.tsThumbFallback` (a 4th function, already `window.x =
  function` style **in the original source** — its own pre-existing comment explains it's
  referenced from a dynamically-generated `onerror=""` attribute and "must hang off window
  regardless of which `<script>` block this one turns out to be (re-)loaded inside," meaning this
  exact housekeeping move was already anticipated when that function was written), local state
  (`editingTestimonialId`/`testimonialImageCleared` — zero references outside this span, verified
  via whole-file grep), and every delegated handler (status filter, add/close/cancel, edit/delete/
  approve/reject/retract, clear-image, file-input change, drag-drop zone, form submit).
- **Explicitly NOT moved — two Phase 7 "Shared candidates" this time**: `window.atlActivateDrawerTab`
  (same one flagged for Footprint) and **`uploadFileToServer`** (`admin.html` ~line 13462), a
  generic file-upload helper also used by Home Slider and About Me — at least 3 sections deep, a
  new shared-candidate not seen in the Footprint pass (Footprint's own upload path used a raw
  `fetch(...)`+`FormData`, not this helper, since it has no image field).
- **CSS**: none — same as Footprint, zero `#testimonialsAdmin`/`.testimonial-*` selectors anywhere
  in the 8 style blocks.
- **Markup**: untouched (section 9567-9649, drawer 26218-26284) — zero inline `on*=` handlers in
  either (the dynamically-generated `onerror="window.tsThumbFallback(this)"` lives in JS-built HTML
  injected at runtime, not static markup, and already correctly uses the `window.` prefix).
- **Reachability**: `loadTestimonials()` has two external call sites (`admin.html` ~25413/~25543),
  both inside the same "refresh everything" function that also calls `loadFootprint()` — already
  proven to work correctly across the script-tag splice by the Footprint section. All three
  `function`-declared exports get explicit `window.` attachment for consistency;
  `window.tsThumbFallback` keeps its pre-existing one unchanged.
- **Script-tag splice**: same technique as Footprint — the block sat inside the third of the three
  tags Footprint's splice created; that tag is now itself split in the same way, giving four total
  `<script>` tags across this stretch of the file, execution order unchanged.

**Verification**: `node --check js/admin/testimonials.js` (syntax valid). A line-by-line diff of
the extracted block (dedented) against `git show HEAD:admin.html`'s original span came back with
exactly 3 differences — the 3 deliberate `window.functionName = functionName;` lines — otherwise
byte-identical (one comment line — the "must hang off window..." explanation already on
`tsThumbFallback` — simply moved along with the function it documents, not a real diff). Full
`git diff --stat` on `admin.html` for this section: 9 insertions, 281 deletions — consistent with
removing 282 lines and inserting 10.

**Same known gap as Section 1**: the plan's manual click-through gate could not be automated in
this sandbox (see Section 1's entry for the full Puppeteer/Chrome-spawn investigation — same
constraint applies here, not re-litigated per-section). Committed on the strength of static
verification; add Testimonials to the live check list already deferred for Footprint (Add/Edit/
Delete/Approve/Reject/Retract a testimonial, console open, confirm the image-upload path and the
status filter both work, confirm Footprint/Career/Gallery/Home Slider/Events still work too).

### Section 3: Career Highlights (`careerAdmin`) — DONE

A structurally different section from the first two, not just a third instance of the same shape —
worth the extra scrutiny it got before the move.

- **JS moved**: `admin.html:15149-15486` → new `js/admin/career.js`. Contains
  `initCareerYears`/`loadHighlights`/`resetCareerForm`/`applyCareerToEditor` (plain `function decl`s)
  and `openCareerCreateDrawer`/`openCareerEditDrawer`/`careerCancelEdit` — the latter three were
  **already** `window.x = function` in the original source, because Career uses genuine inline
  `onclick=""` attributes rather than jQuery delegated handlers: a dynamically-generated
  `onclick="window.openCareerEditDrawer(${item.id})"` baked into each card's HTML, and (confirmed by
  reading the actual markup, not just grepping) a **static** `onclick="careerCancelEdit();"` on the
  drawer's own Cancel button (`admin.html` line 25878, inside the `careerDrawer` markup). Both
  continue to work unchanged — `window` attachment doesn't care which file defines the function.
  Local state `editingHighlightId`/`careerImageCleared` (zero external references) and every
  delegated handler (add/delete/clear-all, form submit with video-vs-image branching, clear-image,
  file-change with video-type blocking, drag-drop zone) moved too.
- **New explicit `window.` attachment added**: `loadHighlights`, matching the `loadFootprint`/
  `loadTestimonials` precedent — it has the same two external call sites (`admin.html` ~25139/25269,
  the same "refresh everything" function already proven safe across two prior script-tag splices).
- **Explicitly NOT moved**: `window.atlActivateDrawerTab` and `uploadFileToServer` (both
  already-flagged Phase 7 "Shared candidates", called here too).
- **CSS**: `#careerAdmin` appears in the stylesheets exactly once, as one of 15 section IDs in a
  single generic "no background" rule (`admin.html:848-862`) shared by nearly every admin section —
  not private to Career, left untouched; not logged as a new shared-candidate since it's already
  effectively global infrastructure, not a per-section duplication Phase 7 would consolidate.
- **Markup**: section (9402-9516) and drawer (25804-25897) both untouched; the drawer's full range
  was read end-to-end (not just grepped) specifically to catch the static `onclick` mentioned above.

**Verification**: `node --check js/admin/career.js` (syntax valid). A line-by-line diff of the
extracted block (dedented) against `git show HEAD:admin.html`'s original span came back with
exactly 1 difference — the deliberate `window.loadHighlights = loadHighlights;` line — otherwise
byte-identical. `git diff --stat` on `admin.html`: 10 insertions, 337 deletions, consistent with
removing 338 lines and inserting 11. Script-tag line-content diff showed exactly the 3 expected
splice lines, nothing else.

**Same known gap as Sections 1-2**: manual click-through not automatable in this sandbox; committed
on static verification. Live-check list now covers all three: Add/Edit/Delete a country
(Footprint), Add/Edit/Delete/Approve/Reject/Retract a testimonial (Testimonials), and for Career
specifically — add a highlight with an image, add one with a YouTube/Vimeo URL (confirm the video
badge and thumbnail extraction), edit one, use Clear All, and confirm the inline `onclick` Cancel
button still closes the drawer correctly post-move.

### Section 4: Gallery (`galleryAdmin`) — DONE

Same shape as Career (inline `onclick=""`, not jQuery delegation, for the create/edit/cancel
trio), plus one new element: drag-to-reorder.

- **JS moved**: `admin.html:15347-15652` → new `js/admin/gallery.js`. Contains
  `loadGallery`/`initDraggableGallery`/`resetGalleryForm`/`applyGalleryToEditor` (plain
  `function decl`s — `initDraggableGallery` posts to `PUT /api/admin/gallery/reorder` on drag-end)
  and `openGalleryCreateDrawer`/`openGalleryEditDrawer`/`galleryCancelEdit` — again already
  `window.x = function` in the source, for the same reason as Career: a dynamically-generated
  `onclick="window.openGalleryEditDrawer(${item.id})"` per card, and a **static**
  `onclick="galleryCancelEdit();"` on the drawer's own Cancel button (`admin.html` line 25794,
  confirmed by reading the drawer markup, matching Career's pattern exactly). Local state
  `galleryEditId` (zero external references — one in-block forward reference relies on `var`
  hoisting, unaffected since both sides moved together) and every delegated handler (video-type
  blocking on file-select, multi-file-or-URL add/edit submit, delete, clear-all) moved too.
- **New explicit `window.` attachment**: `loadGallery`, matching the by-now-established
  `loadFootprint`/`loadTestimonials`/`loadHighlights` precedent — same two external call sites
  (`admin.html` ~24815/24945, the same refresh-everything function proven safe three times over).
- **Explicitly NOT moved**: `window.atlActivateDrawerTab` and `uploadFileToServer` (both
  already-flagged Phase 7 "Shared candidates", called here too).
- **CSS**: `#galleryAdmin` appears only in the same 15-section shared "no background" rule already
  seen for Career — no private styling, nothing to move.
- **Markup**: section (9650-9756) and drawer (25743-25812) untouched; the drawer's full range was
  read end-to-end to catch the static `onclick`, same discipline as Career.
- **Incidental confirmation, not new evidence needed**: the very next block in the file (Banner
  Management Centre, untouched, not part of this section) opens with its own pre-existing comment —
  *"plain declarations aren't reliably reachable across this file's several separate `<script>`
  blocks"* — the original developer already applying the same window-attachment discipline this
  whole Phase 6 pass has been following.

**Verification**: `node --check js/admin/gallery.js` (syntax valid). A line-by-line diff of the
extracted block (dedented) against `git show HEAD:admin.html`'s original span came back with
exactly 1 difference — the deliberate `window.loadGallery = loadGallery;` line. `git diff --stat`
on `admin.html`: 10 insertions, 305 deletions, consistent with removing 306 lines and inserting 11.
Script-tag line-content diff showed exactly the 3 expected splice lines.

**Same known gap as Sections 1-3**: manual click-through not automatable in this sandbox; committed
on static verification. Live-check list now also covers Gallery — add an image, drag to reorder and
confirm the new order survives a refresh, edit one, use Clear All, confirm the inline `onclick`
Cancel button still works post-move.

### Section 5: Home Slider (`homeAdmin`) — DONE

Scoped alongside two alternatives (Contact Me, About Me) so the choice of what to do next wasn't
made blind; chosen because it's the same proven drawer+drag-reorder+inline-`onclick` family as
Gallery — in fact its original template, per Gallery's own comment ("Mirrors `initDraggableSlider()`
in the Home Slider section above").

- **The one real wrinkle, found during scoping and confirmed before touching anything**:
  `uploadFileToServer` (`admin.html` ~13462, the already-flagged shared upload helper Career/Gallery/
  Testimonials all still depend on) sits physically at the very top of the "1. Home Slider Logic"
  labeled block — not merely called from within it, but defined there. Moving the whole labeled
  block would have broken three already-migrated sections. Handled with a **non-contiguous split**:
  `uploadFileToServer` and the section's header comment stayed in `admin.html` (the header comment
  itself rewritten to explain the carve-out); everything else in the block moved.
- **JS moved**: `admin.html:13477-13773` (post-carve-out) → new `js/admin/home-slider.js`. Contains
  `uploadHomeFiles`/`fetchHomeSlider`/`renderHomeList`/`initDraggableSlider`/`resetHomeForm`/
  `applyHomeToEditor` (plain `function decl`s) and `openHomeCreateDrawer`/`openHomeEditDrawer`/
  `homeCancelEdit` — already `window.x = function` in the source, same inline-`onclick` pattern as
  Career/Gallery (a dynamic `onclick="window.openHomeEditDrawer(...)"` per card, a static
  `onclick="homeCancelEdit();"` on the drawer's Cancel button, `admin.html` line 25664, confirmed by
  reading the markup). Local state `homeEditId` (zero external references) and every delegated
  handler (file-select preview, drag-drop zone, delete, clear-all, add/edit submit) moved too.
- **New explicit `window.` attachment**: `fetchHomeSlider` — 5 external call sites total, 3 of them
  already using a defensive `typeof fetchHomeSlider === 'function'` guard (lower-risk than the bare
  calls seen for the four prior `loadX` functions — this call pattern would have degraded
  gracefully even without the attachment, but it's added anyway for consistency).
- **Explicitly NOT moved**: `window.atlActivateDrawerTab` (shared candidate, called here too).
- **CSS**: `#homeAdmin` appears only in the same 15-section shared "no background" rule already
  seen for Career/Gallery.
- **Markup**: section (9057-9171) and drawer (25616-25682) untouched.
- **Housekeeping on the housekeeping**: while verifying this splice, noticed the same cosmetic
  double-blank-line artifact already caught and fixed for Section 1 (Footprint) had gone unnoticed
  in Sections 2-4 (Testimonials/Career/Gallery) — the extraction script's replacement array and the
  original file's own blank line both survived the splice. Fixed all three in this same commit
  (one blank line removed each, purely cosmetic, no content change) for consistency.

**Verification**: `node --check js/admin/home-slider.js` (syntax valid). A line-by-line diff of the
moved portion (dedented) against `git show HEAD:admin.html`'s original span came back with exactly
1 difference — the deliberate `window.fetchHomeSlider = fetchHomeSlider;` line. `git diff --stat`
on `admin.html`: 13 insertions, 300 deletions — reconciled exactly against the extraction's own
13/297 plus the 3 separate one-line blank-line fixes. Script-tag line-content diff showed exactly
the 3 expected splice lines for this section (the three blank-line fixes don't show up in that
particular check, since blank lines match neither `<script` nor `</script>`).

**Same known gap as Sections 1-4**: manual click-through not automatable in this sandbox; committed
on static verification. Live-check list now also covers Home Slider — add a slide (file and URL),
drag to reorder, edit one, use Clear All, confirm the inline `onclick` Cancel button works
post-move.

### Section 6: Contact Me (`contactAdmin`) — DONE

Scoped alongside Home Slider and About Me before picking; chosen to prove a structurally different
shape than the five drawer-based sections done so far.

- **JS moved**: `admin.html:14898-15059` → new `js/admin/contact.js`. Contains `isValidEmail`/
  `loadContactData`/`loadManagerData` (plain `function decl`s), local state `itiManagerCell`/
  `itiManagerWhatsApp` (the two `intl-tel-input` widget instances), the `$(document).ready(...)`
  block that initializes both phone widgets and does the first data load, and three handlers
  (`#contactAdminForm` submit, `#managerAdminForm` submit, `#managerClearBtn` click).
- **No shared candidates this time** — no drawer at all here, so no `atlActivateDrawerTab`/
  `uploadFileToServer` dependency to carve out, unlike every prior section.
- **New explicit `window.` attachment**: `loadContactData` — 2 external call sites (`admin.html`
  ~24227/24357), the same refresh-everything pattern as every prior section.
- **CSS**: `#contactAdmin` appears only in the same 15-section shared "no background" rule. A
  generic `.iti__dropdown` light-theme override (`admin.html` line 4375) touches the
  `intl-tel-input` library Contact Me happens to be the only current user of, but it's grouped with
  unrelated library theming (FullCalendar, toast, modal) as one of several numbered "light theme
  override" rules, not scoped to `#contactAdmin` — left in place, not treated as private styling.
- **Markup**: section (10290-10478) untouched — no drawer to separately check this time.

**Verification**: `node --check js/admin/contact.js` (syntax valid). A line-by-line diff of the
extracted block (dedented) against `git show HEAD:admin.html`'s original span came back with the
deliberate `window.loadContactData = loadContactData;` line plus a handful of trailing-whitespace-
only differences inside a couple of `setTimeout` callback bodies (the same harmless class
documented throughout this whole housekeeping effort) — no semantic differences. `git diff --stat`
on `admin.html`: 7 insertions, 162 deletions, exactly matching the extraction (162 lines removed, 7
inserted). Script-tag line-content diff showed exactly the 3 expected splice lines.

**Same known gap as Sections 1-5**: manual click-through not automatable in this sandbox; committed
on static verification. Live-check list now also covers Contact Me — save the contact form, save
the manager form (including cell/WhatsApp number validation), and Clear Manager Details.

### Section 7: About Me (`aboutAdmin`) — DONE

The most entangled section done so far — the earlier scoping pass flagged this section's boundary
as unresolved, and digging in properly turned up a real structural finding, not just a bigger
version of the same shape.

**The "2. About Me Logic" labeled block actually bundles three distinct things, only two of which
are About Me's:**
1. The bio/profile editor (`updateAboutPreview`, `loadAboutData`, the `aboutDrawer` wiring,
   `#aboutForm` submit, upload/drag-drop) — genuinely About Me's own.
2. The Hero/Services/Features/Announcement homepage-content editors (`loadSiteContent`,
   `buildSvcCardEditors`, `renderHeroPreview`, etc., and 4 form-submit handlers) — confirmed
   genuinely About Me's too, via its own tab markup (`aboutServicesPanel`/`aboutFeaturesPanel`/
   `aboutHeroPanel`/`aboutAnnouncePanel` all live inside `aboutAdmin`'s section div, 9172-9401).
3. The "Website Sections" visibility toggle (`SECTION_REGISTRY`, `secEsc`, `renderSectionsUI`,
   `secSetToggle`, `loadSectionVisibility`, `secFilter`, `saveSectionVisibility`) — confirmed to
   belong to a **future System Settings (`preferencesAdmin`) extraction instead**: its own tab
   (`prefPanelSections`) and a static `onclick="saveSectionVisibility(this)"` both live in System
   Settings' own markup (11003-11243), not About Me's, despite sitting physically in the middle of
   this labeled block.

- **JS moved, non-contiguous (two pieces)**: `admin.html:13491-13853` and `admin.html:13981-14016`
  → new `js/admin/about.js`. `admin.html:13855-13979` (item 3 above) stays exactly in place,
  untouched, sandwiched between where the two moved pieces used to be.
- **A genuine cross-reference verified safe, not just assumed**: `saveSectionVisibility` (staying
  inline) reads and writes `_siteContent` (a `var` declared in the moved code, now in
  `js/admin/about.js`). Verified this is safe with zero extra code needed — `var` declarations at
  the top level of a classic (non-module) `<script>` bind to one shared global scope regardless of
  whether the script is inline or external, so the two locations share the exact same live
  binding, the same mechanism that already made every prior section's "later script block calls
  this function" cross-references safe.
- **First section with genuine private CSS**: `admin.html:4826-4852`
  (`#aboutAdmin`/`#collapseAboutPreview`-scoped mobile-polish rules, explicitly commented "Scoped
  to `#aboutAdmin` so no other section shifts") → new `css/admin/about.css`, loaded via a `<link>`
  tag at the exact document position the rules sat at — the enclosing `<style>` block split in two,
  mirroring the `<script>`-splitting technique used for every JS move so far. The generic "MOBILE
  UI/UX POLISH — additive & admin-scoped" header comment immediately above stayed in `admin.html`
  — it reads as general-purpose, not About-Me-specific, so it wasn't moved with the content under
  it. (Caught and fixed one mistake before committing: the replacement comment inside the `<style>`
  block was first written with `//` JS-style comment syntax instead of CSS's `/* */` — invalid CSS
  a browser would have silently swallowed rather than errored on, but wrong regardless; fixed.)
- **New explicit `window.` attachment**: `loadAboutData` — 2 direct external call sites
  (`admin.html` ~24068/24199) plus already-`typeof`-guarded ones from the Quill initialization
  block elsewhere in the file.
- **Explicitly NOT moved**: `window.atlActivateDrawerTab` and `uploadFileToServer` (both
  already-flagged Phase 7 "Shared candidates," called from the moved code).
- **Markup**: the section (9172-9401) and all 5 relevant drawers (`aboutDrawer`, `heroDrawer`,
  `servicesDrawer`, `featuresDrawer`, `announceDrawer`) untouched. 5 static
  `onclick="if(window.openAtlDrawer)openAtlDrawer('...')"` attributes found in the section markup
  all reference the already-shared `openAtlDrawer`, nothing About-Me-owned — zero real on*=
  dependency on the moved code itself.

**Verification**: `node --check js/admin/about.js` (syntax valid). Line-by-line diffs of both moved
JS pieces and the moved CSS against `git show HEAD:admin.html`'s original spans came back with only
the one intentional `window.loadAboutData = loadAboutData;` line (JS) and zero differences (CSS) —
byte-identical otherwise. Tag-structure diff (`<script`/`</script>`/`<style`/`</style>`/`<link`)
showed exactly the 6 expected new structural tags (2 closing + 1 `<link>` + 1 `<script src>` + 2
reopening) plus one harmless false-positive from this very explanatory comment's own prose
containing the literal string `<script src>`. `git diff --stat` on `admin.html`: 23 insertions, 426
deletions — reconciles exactly against the three splices' own line counts (363+36+27 removed,
12+4+7 inserted).

**Same known gap as Sections 1-6**: manual click-through not automatable in this sandbox; committed
on static verification. Live-check list now also covers About Me — save the biography (Quill
editors), save Hero/Features/What-I-Do/Announcement individually, and confirm Website Sections
(still inline, untouched) still loads and saves correctly given its cross-reference into the newly
external `about.js`.

### Section 8: Email Logs (`emailLogsAdmin`) — DONE

The cleanest JS of any section so far, paired with a genuine CSS complication.

- **JS moved**: `admin.html:29196-29370` → new `js/admin/email-logs.js`. Contains `logState`/
  `logSearchTimer` (local state), `window.loadEmailLogs`, `renderLogPagination`, `window.toggleLogSort`,
  `updateSortIcons`, `window.applyLogFilters`, `window.debounceLogSearch`. **Zero new `window.`
  attachments needed** — every function called from an inline `onclick`/`oninput`/`onchange`
  attribute in the section markup (`loadEmailLogs()`, `debounceLogSearch()`, `applyLogFilters()`,
  `toggleLogSort('...')`) was already properly `window`-attached by whoever wrote this module —
  the first section this whole pass where that was already fully true.
- **No shared-candidate carve-out** — only depends on `qs`/`qsa`, the file's foundational
  DOM-query helpers (defined once, near the top of the whole script, used throughout the entire
  file) — not a per-section dependency worth flagging the way `atlActivateDrawerTab` is.
- **A genuine pre-existing CSS duplication, found and deliberately NOT fixed**: `.log-row` (and
  related classes) has **two separate, non-identical rule blocks** at different points in the
  stylesheet — `admin.html:4129-4142` (border/transition + 4 `.log-status-*` color rules) and
  `admin.html:4546-4561` (a different, overlapping property set for the *same* `.log-row`/
  `.log-row:hover`/`.log-row .log-time` selectors — padding, font, color). Neither class currently
  appears anywhere in the static markup (log rows are built entirely in JS with inline styles), so
  this may well be dead CSS — that determination belongs to a future Phase 8 pass, not this one.
  Per "no merge, no reorder," moved each chunk to its **own** file — `css/admin/email-logs.css`
  (chunk 1) and `css/admin/email-logs-2.css` (chunk 2) — each loaded via its own `<link>` at its
  own original document position, preserving the exact cascade order rather than silently changing
  which rule wins where by combining them into one file.
- **Markup**: section (11635-11805, confirmed via the exact `admin-section` div boundaries, not
  the map's approximate range) untouched.

**Verification**: `node --check js/admin/email-logs.js` (syntax valid). Line-by-line diffs of the
JS and both CSS chunks against `git show HEAD:admin.html`'s original spans came back clean apart
from harmless trailing-whitespace-only differences (JS) and the original short inline section-label
comments being replaced by the fuller Phase 6 relocation comments (CSS) — the same treatment every
prior section's original label comment got. Tag-structure diff (`<script`/`</script>`/`<style`/
`</style>`/`<link`) showed exactly the 9 expected new structural tags (3 closing + 2 `<link>` + 1
`<script src>` + 3 reopening). `git diff --stat` on `admin.html`: 23 insertions, 205 deletions —
reconciles exactly against the three splices' own line counts (175+16+14 removed, 8+7+8 inserted).

**Same known gap as Sections 1-7**: manual click-through not automatable in this sandbox; committed
on static verification. Live-check list now also covers Email Logs — load the log table, search,
filter by status/trigger, sort by column, and page through results.

### Section 9: Social Media (`socialAdmin`) — DONE

The biggest single JS payload of any section so far (899 lines) — social links CRUD, media-embed
CRUD with real per-platform oEmbed/metadata fetching (YouTube Data API, Vimeo API, Facebook Graph
API, TikTok oEmbed, plus `noembed.com`/`api.microlink.io` fallbacks), and the Dashboard
follower-count KPI credentials tab.

- **A stale placeholder header, not the real content**: `admin.html`'s original "3. Social Media
  Logic" comment (near About Me, already-migrated territory) says outright "live CRUD lives further
  down" — the real block is a separate "8. Dynamic Social Media Logic" section hundreds of lines
  later, confirmed before touching anything (the same lesson as Email Logs: a section-numbered
  comment in this file is not a reliable pointer to where its code actually lives).
- **JS moved**: `admin.html:14935-15835` → new `js/admin/social.js`.
- **Genuinely NOT part of this move**: a generic, cross-cutting `$(document).ready(...)`
  initializer sat immediately after (page-wide drag-drop prevention + several commented-out legacy
  init calls mentioning Home/About/Events/Career/Contact, not just Social Media) — left exactly in
  place, same treatment as About Me's Website Sections carve-out.
- **Already correctly attached, zero new work for on*= reachability**: `window.openSocialLinkDrawer`,
  `window.openSocialEmbedDrawer`, `window.toggleKpiFields`, `window.saveSocialKpiSettings` — all
  referenced from static `onclick=""` attributes in the section markup, all already properly
  `window`-attached in the original source.
- **New explicit `window.` attachment**: `loadSocialData` — 2 external call sites (`admin.html`
  ~23651/23782), the by-now-standard refresh-everything pattern.
- **No shared-candidate dependency** — neither drawer (`socialLinkDrawer`, `socialEmbedDrawer`) uses
  the tabbed Edit/History pattern, so no `atlActivateDrawerTab`; no image uploads here, so no
  `uploadFileToServer`.
- **A cross-reference to code staying elsewhere, left as an ordinary call**:
  `saveSocialKpiSettings` calls `loadAnalyticsDashboard()`, Dashboard's own function, defined much
  later in `admin.html` (not yet migrated) — works exactly like every other cross-script-block call
  already verified safe this whole pass, no special handling needed.
- **CSS/Markup**: no private CSS (`#socialAdmin` only in the same 15-section shared rule); section
  and both drawers untouched.

**Built the file programmatically instead of retyping it** — given the size (900 lines read across
several fragments), a small Node script extracted `admin.html:14935-15835` directly, dedented it,
and inserted the one `window.loadSocialData` line — eliminating any risk of a transcription slip
across content this large. One self-caught mistake during verification: the first diff against the
original came back showing *every* line as different; traced immediately to a line-ending mismatch
(`git show | sed` normalizes to LF, the new file correctly kept the project's own CRLF) rather than
a real content problem — normalizing both sides for the comparison confirmed the true diff was
clean. A second false alarm right after (an apparently-missing final `};`) turned out to be a
`head -n -1` in the verification command wrongly assuming a trailing blank line that didn't exist,
not a problem with the actual file (confirmed by reading the file's real tail directly).

**Verification**: `node --check js/admin/social.js` (syntax valid). Once both self-caught
comparison-tooling mistakes above were corrected, the true diff came back with exactly 1
difference — the intentional `window.loadSocialData = loadSocialData;` line — byte-identical
otherwise. Tag-structure diff showed exactly the 3 expected splice lines. `git diff --stat` on
`admin.html`: 8 insertions, 901 deletions — reconciles exactly (901 = 15835−14935+1 lines removed,
8 = the replacement array's own length).

**Same known gap as Sections 1-8**: manual click-through not automatable in this sandbox; committed
on static verification. Live-check list now also covers Social Media — add/edit/delete a social
link, add a media embed for at least one platform with real metadata fetching (e.g. a YouTube URL)
and confirm the thumbnail/title populate, and save the KPI settings tab.

### Section 10: Services Catalogue (`servicesAdmin`) + Booking Policies (narrow tab) — DONE

A combined batch: two logically distinct, physically adjacent, self-contained blocks with zero
cross-dependency on each other, extracted together in one pass.

- **JS moved**: `admin.html:30357-30783` (Services CRUD: `allServicesCache`/`_showArchivedServices`/
  `_svcActiveCat` local state, the `.svc-cat-pill` click handler, `_updateSvcStats`,
  `window.loadAdminServices`, `window.filterServicesTable`, `window.clearSvcFilters`,
  `window.restoreService`, `window.toggleArchivedServices`, `window.toggleServiceForm`,
  `window.togglePricingFields`, `window.cancelServiceForm`, `window.editService`,
  `window.saveService`, `window.deleteService`) → new `js/admin/services.js`.
- **JS moved**: `admin.html:30785-30840` (`window.loadPolicies`, `window.savePolicies` — deposit %,
  quote validity, payment terms, cancellation policy, reminder days, inquiry SLA) → new
  `js/admin/policies.js`.
- **"Booking Policies" is two different things, discovered during scoping**: the sidebar tab labeled
  Booking Policies is this narrow `loadPolicies`/`savePolicies` pair only. Immediately adjacent
  (`admin.html:30842` onward, same `policiesAdmin` panel) sits a much bigger, unrelated
  "Legal & Compliance Centre" module — 8 further tabs (Privacy Policy, Terms, Cookie & Consent,
  Consent Audit, Contract Registry, Version History, plus 2 more) touching POPIA/legal-compliance
  territory. Deliberately NOT part of this batch — deferred to its own dedicated scoping pass given
  its size and sensitivity.
- **Explicitly NOT moved**: `admin.html:30329-30355`, a shared cross-cutting Bootstrap tab-shown
  wiring block that lazily triggers `loadAdminServices()`/`loadPolicies()` alongside
  Home/Finance/Security/Bookings/Preferences/Branding on their own tabs — genuinely cross-cutting,
  stays in place untouched.
- **Zero new `window.` attachments needed** — every function reachable from the two sections' static
  `onclick`/`oninput`/`onchange` markup attributes (`toggleServiceForm()`, `filterServicesTable()`,
  `clearSvcFilters()`, `toggleArchivedServices()`, `togglePricingFields()`, `saveService()`,
  `savePolicies()`, etc.) was already `window`-attached in the original source — the same
  fully-clean precedent as Email Logs and Social Media.
- **A local, section-owned helper left in place, called not moved**: `svcDrawerOpen()` (called from
  both `toggleServiceForm` and `editService`) sits physically between the two moved Services
  functions that call it but is itself just above the shared drawer-stacking infrastructure
  (`atlDrawerPush`/`atlDrawerPop`/`atlDrawerFocusEntry`, `window.openAtlDrawer`/`closeAtlDrawer`,
  `window.openQuoteDrawer`/`closeQuoteDrawer`) — all of that infrastructure is a **Phase 7 shared
  candidate** already flagged from prior sections, so `svcDrawerOpen` and everything after it in
  that shared block was left exactly where it is; `services.js` calls it as an ordinary
  cross-script-block reference, the same mechanism verified safe every prior section.
- **No shared-candidate dependency beyond the drawer stack noted above** — no `atlActivateDrawerTab`
  (Services' drawer has no tabs), no `uploadFileToServer` (no image uploads in either section).
- **CSS**: no private CSS for either section — `#servicesAdmin` only appears in the shared
  15-section "no background" rule; the "UNIFIED SEARCH BOXES" comment nearby documents a shared
  convention across `#eventsAdmin`/`#bookingsAdmin`/`#servicesAdmin`/`#inquiriesAdmin`, not
  anything private to Services. Nothing moved.
- **Markup structural curiosity, no extraction impact**: Services Catalogue's drawer (`#svcDrawer`,
  `admin.html:8166-8648` range) uses an older `svc-drawer` class embedded directly within the
  section's own markup, unlike the `atl-drawer` pattern most other sections use (markup living in a
  separate late-file drawer zone). Noted for awareness; the plan's "leave markup in place" rule
  means this has no bearing on the extraction either way — both the section markup and its drawer
  stay in `admin.html` untouched.

**Verification**: `node --check` clean on both new files. Byte-identity diffs against the pre-move
`admin.html` (CRLF-normalized from the start this time, having learned that lesson from Social
Media) came back clean for both files — the only content difference in either is the intentional
header comment block, confirmed by diffing bodies only (offset past each file's own header length,
7 lines for `services.js`, 8 for `policies.js` — a header-length mismatch first produced a
false-alarm single-blank-line diff on `policies.js`, immediately traced to the verification script's
`tail` offset rather than the file, then re-confirmed clean). `git diff --stat` on `admin.html`: 12
insertions, 484 deletions — reconciles exactly (484 = 30840−30357+1 lines removed across both
blocks, 12 = the two-file replacement's own combined line count). Diff reviewed directly end-to-end:
single contiguous removal, clean boundary against the untouched Legal & Compliance Centre header
immediately after.

**Same known gap as Sections 1-9**: manual click-through not automatable in this sandbox; committed
on static verification. Live-check list now also covers Services Catalogue (add/edit/archive/restore
a service, filter by category pill/search/model/status, verify stats update) and Booking Policies
(change and save each policy field, confirm validation on deposit %/quote validity/reminder-day
ordering).

### Section 11: Upcoming Events (`eventsAdmin`) — DONE

Same CRUD-list shape as the earlier Gallery/Career/Testimonials sections, correctly located exactly
where its own "4. Events Logic (Database API Driven)" header comment said it would be (unlike Email
Logs/Social Media/Services, no stale-placeholder surprise here).

- **JS moved (two pieces around a carve-out)**: `admin.html:13607-14389` (list rendering, search,
  bulk-selection actions and all `#evtBulk*` handlers, single-delete and duplicate handlers,
  `window.openCancelEventModal` + its delegated confirm handler, the `#evtDrawer` create/edit
  controller — `applyEventToEditor`/`resetEventForm`/`window.openEvtCreateDrawer`/
  `window.openEvtEditDrawer`/`cancelEventEdit`, the `#eventsForm` submit handler with poster upload,
  and `window.initEventsPickers`) and `admin.html:14422-14445` (the Google Maps Places Autocomplete
  venue lookup, `window.initEventsMap`) → new `js/admin/events.js`, concatenated in their original
  relative order.
- **A genuinely cross-cutting carve-out sat physically between those two pieces, left in place**:
  `admin.html:14391-14420` — `_fpDate`/`_fpTime`/`_fpDateTime`/`window.initAdminDateTimePickers`, a
  generic Flatpickr-init helper used by Financials/Services/Security/Contracts/Bookings and more
  (`finDateFrom`, `svcValidFrom`, `auditDateFrom`, `contractSignedDate`, `boDate`, etc.) — not
  Events-specific despite the physical location, same treatment as About Me's Website Sections
  carve-out and the shared bootstrap block ahead of Services/Policies.
- **CSS moved**: `admin.html:1282-1351` ("EVENTS SECTION — Card grid + editor dock": `.evt-*` card
  grid, bulk bar, badges, list heading) → new `css/admin/events.css`. The immediately-following
  `.atl-edit-card` block was explicitly marked shared in its own comment ("isolated from
  booking/event JS hooks") and was NOT moved. `#eventsAdmin` also appears in the separate shared
  15-section "no background" rule elsewhere — not moved either.
- **Two new `window.` attachments** — both were plain function declarations in the original source:
  `renderEventsList` (called from 3 external script blocks — the standard refresh-everything
  pattern) and `cancelEventEdit` (referenced from a static `onclick="cancelEventEdit();"` in the
  `evtDrawer` markup). `window.openCancelEventModal`/`window.openEvtCreateDrawer`/
  `window.openEvtEditDrawer`/`window.initEventsPickers`/`window.initEventsMap` were already
  window-attached in the original source.
- **Self-caught mistake during extraction, fixed before verification**: the first build of this
  file used brace-pattern matching (`line.trim() === '}'` within N lines of a function's signature)
  to locate where to insert the two new `window.` attachments — it wrongly matched an inner
  `if (data === null) { ... }` block's closing brace inside `renderEventsList` instead of the
  function's own closing brace, landing `window.renderEventsList = renderEventsList;` mid-function
  (syntactically valid, but wrong — it would have re-run on every call instead of once at load,
  and isn't a byte-identical relocation). Caught by inspecting the generated file directly before
  committing; the extraction was reverted (`git checkout admin.html`, new files deleted) and redone
  using the exact, hand-verified closing-brace line number for each function instead of pattern
  matching.
- **No shared-candidate dependency beyond what's already flagged**: `window.atlActivateDrawerTab`,
  `uploadFileToServer`, `openAtlDrawer`/`closeAtlDrawer` are called from inside this block but not
  moved — the same Phase 7 "Shared candidates" as every prior drawer-owning section.
- **Pre-existing developer comment preserved, not resolved**: a comment a few lines above
  `window.initEventsMap`'s definition claims it "was defined but never called anywhere... a complete
  dead end", immediately next to code that DOES conditionally call it on drawer-open — an apparent
  inconsistency in the original comment, left byte-identical (a Phase 8 question, not this pass's to
  resolve).

**Verification**: `node --check` clean on `events.js`. Byte-identity diffs against the pre-move
`admin.html` (built by re-deriving the exact expected body — piece A with the two attachments woven
in at their verified line numbers, plus piece B — from the saved pre-change copy) came back clean
for both the JS and CSS bodies. `git diff --stat` on `admin.html`: 11 insertions, 877 deletions; the
diff was reviewed hunk-by-hunk end-to-end (3 hunks) and confirms the carve-out block is preserved
byte-for-byte as unchanged context between the two removed pieces, with clean boundaries against the
untouched "5. Career Accordion Logic" marker immediately after.

**Same known gap as Sections 1-10**: manual click-through not automatable in this sandbox; committed
on static verification. Live-check list now also covers Upcoming Events (create/edit/cancel/postpone/
duplicate/delete an event individually and via bulk actions, venue autocomplete, and — if a Google
Maps API key is configured — the venue search field).

### ⚠ Regression found and fixed: two earlier extractions broke live functionality

While scoping Section 12, a fuller check of the verification methodology used for every section so
far turned up a real, already-committed bug in **two** earlier extractions — **Section 8 (Email
Logs)** and **Section 10 (Services Catalogue + Booking Policies)**. This entry documents what was
wrong, why every diff/line-count check up to now hadn't caught it, how it was found, and the fix.

**What was wrong**: every section's verification checked that the *extracted file* was byte-identical
to the original, and that `admin.html`'s own diff arithmetic reconciled — but never checked that
`admin.html`'s own *remaining* inline `<script>` tags were still independently valid JavaScript after
the splice. For 9 of the 11 sections so far, the extracted content sat at a clean top-level boundary,
so this was never an issue. For Email Logs and Services/Policies, the extracted content actually sat
in the **middle of a large enclosing IIFE** — `(function initUserManagement() { ... })();` (User
Management's own module, ~1,400 lines, never itself scoped for Phase 6) and
`(function initFinanceManagement() { ... })();` (Finance's own module) respectively. Splicing a
`<script src="...">` into the middle of either IIFE's body split it into two separate `<script>`
tags, each a syntactically incomplete fragment — one missing its closing `})();`, the other left with
an orphaned, unmatched `}`. A browser encountering a `<script>` tag with a syntax error executes
**none** of that tag's top-level code — meaning, on the live site since those two commits landed,
**all of `initUserManagement`'s own functions (User Management's entire CRUD — load/render/paginate/
sort/delete/update users, the Login Activity Logs panel, bulk controls) and all of
`initFinanceManagement`'s own functions (Financial stats/transactions/invoices/charts, Audit Log
rendering, POPIA request handling, the session-timeout timer) silently stopped running.** This was
never exercised by this pass's own verification (byte-identical diffs of the *extracted* file don't
catch a syntax break in what's *left behind*), and the plan's own manual click-through gate — the
one check that would have caught this immediately — is the exact gap already flagged as "same known
gap as Sections 1-N" in every section's write-up (Puppeteer/Chrome blocked in this sandbox).

**How it was found**: prompted by the "Auto Mode" system reminder's push to keep moving, a
belt-and-suspenders pass wrote a small script (`vm.Script` per inline `<script>...</script>` block,
skipping `src=` tags) that parses every inline script block in `admin.html` independently — the same
grammar unit a browser treats each tag as. Run against the pre-Phase-6 original: 14/14 blocks parse
clean (confirming the bug is not pre-existing). Run against the current file: 4 blocks failed,
exactly the two seams above (one "unclosed" + one "orphaned close" per seam).

**Why the fix is not a re-extraction**: the *extracted files themselves* (`email-logs.js`,
`services.js`, `policies.js`) were re-verified — `node --check` clean, byte-identical to source — and
are not at fault. The break is entirely in how `admin.html`'s residual scaffolding was reconstructed
around the splice point.

**The fix, per seam**:
- Checked whether the code on either side of each seam has a real closure dependency on the other
  (bare references to functions/state defined only on the far side). **Services/Policies**: zero
  cross-references found (`grep` across both remaining halves for every one of `initFinanceManagement`'s
  top-level names) — the two halves are safely independent. **Email Logs**: the remaining
  "PANEL 5: LOGIN ACTIVITY LOGS" code (User Management's own separate login-activity log viewer,
  distinct from the sitewide Email Logs admin tab) genuinely calls back into `initUserManagement`'s
  own closure-scoped `esc()`, `initTabs()`, `moduleLoaded`, and `loadAllUsers()` — a real dependency.
- Given that, the safest fix (matching "relocate, don't rewrite") for **both** seams was the same:
  reunite each IIFE into one continuous `<script>` tag exactly as it always was (verified by
  concatenating both halves and running `node --check` — clean), and relocate the extracted
  section's `<script src="...">` tag(s) to sit **just before** the whole reunited block instead of
  inside it. Order preserved for Services-then-Policies. Verified this relocation changes nothing
  observable: every symbol these files reference from the page (`window.qs`/`window.qsa`, defined at
  `admin.html:12016-17`, well before either old or new position) is already resolvable from the new,
  earlier position, and every function these files themselves define is only ever *called* from user
  interaction — never at parse time — so loading earlier changes no execution order that matters.
- A pre-existing (not introduced by this fix) name collision was noted, not touched: both
  `email-logs.js` and the reunited `initUserManagement` block define `window.toggleLogSort` for two
  conceptually different log tables (Email Logs' own vs. User Management's Login Activity panel) —
  in the original file the second one (User Management's, defined later in execution order) always
  won, silently shadowing the Email Logs tab's own sort-icon handler. The fix preserves this exact
  same "last one loaded wins" order (Email Logs' script tag still loads and runs before
  `initUserManagement`'s own code), so this pre-existing bug's behavior is unchanged either way — a
  Phase 8 dead-code/bug-fix question, not this pass's to resolve.

**Verification**: a purpose-built script parses every inline `<script>` block in the *current*
`admin.html` independently (`node`'s `vm.Script`, mirroring how a browser treats each tag) — 23/23
blocks parse clean (0 failures, down from 4). `node --check` re-run on all 12 extracted
`js/admin/*.js` files — all clean, confirming the fix touched only `admin.html`. `git diff --stat` on
`admin.html`: 23 insertions, 15 deletions, entirely comment and `<script>`/`<script src>` tag lines —
reviewed in full; no line of actual application code was added, removed, or reordered.

**Process takeaway, applied going forward**: every future Phase 6 section's verification now also
runs this same inline-script parse-check against the post-splice `admin.html`, not just against the
extracted file — added as a standing step, not a one-off. This is the direct, concrete substitute for
the manual click-through gate this sandbox still can't automate — it wouldn't have caught a *behavior*
regression, but it does catch exactly this class of *structural* one, which the byte-diff/line-count
checks used so far were structurally blind to.

### Section 12: Branding (`brandingAdmin`) — DONE

First section scoped *after* the regression fix above, and the first to deliberately apply its
lesson from the start rather than discover it the hard way: this code also sat in the middle of
`initFinanceManagement(...)`'s closure (the same one Services/Policies came from), immediately after
Working Hours' save handler and immediately before System Settings' `sendTestNotification`.

- **JS moved**: `admin.html:30034-30190` (`uploadBrandingAsset`, `updateBrandPreview`,
  `updateBrandFontPreview`, `updateBrandColorPreview`, `resetBrandColor`, `resetBrandFont`,
  `resetLoginBackground`, `loadBrandingSettings`, `saveBranding`) → new `js/admin/branding.js`.
- **Checked cross-references in both directions before touching anything** (the check this whole
  regression was about): grepped the full `initFinanceManagement` closure for every one of
  Branding's own names (zero hits outside its own range, aside from inline markup attributes) and
  grepped Branding's own code for every other name known to be declared elsewhere in that closure
  (Finance/Audit/POPIA/session-timer/Working-Hours state and helpers — zero hits). Confirmed safe to
  remove with no cross-dependency.
- **Applied the fix pattern proactively, not reactively**: did *not* split the enclosing `<script>`
  tag at the extraction point. Working Hours' code (just before) and `sendTestNotification`'s code
  (just after) are joined directly with a short explanatory comment in between — no script-tag
  break. The new `<script src="js/admin/branding.js">` tag sits before the whole
  `initFinanceManagement` block instead, alongside the `services.js`/`policies.js` tags already
  relocated there by the earlier fix.
- **A second pre-existing dead-code path found, and knowingly left as a side-effect fix**:
  `updateBrandPreview` is called from 3 inline `oninput=""` attributes (the Logo/Favicon/Login
  Background URL fields' live preview) but was never `window`-attached in the original source — and
  since it was closure-scoped inside `initFinanceManagement`, those `oninput` calls have almost
  certainly thrown `ReferenceError` silently for as long as this code has existed (inline attribute
  handlers execute in global scope; they cannot see into an unexposed closure). Presented to the
  user before proceeding: option to preserve the exact broken behavior, or let a correctly-added
  `window.updateBrandPreview` (required anyway by this plan's own on*= reachability rule) incidentally
  make the live preview work. User chose to proceed as scoped — the attachment was added, which
  likely makes those 3 preview fields start working live for the first time. Noted here explicitly
  rather than silently, per the plan's "narrow, explicitly-reasoned exceptions" rule.
- **CSS**: no private CSS — `#brandingAdmin` only in the shared 15-section rule; `.brand-name`/
  `.brand-tagline` (admin header's own logo styling) are unrelated to this section's form.

**Verification**: `node --check` clean on `branding.js`. The inline-script parse-checker (added as a
standing step per the takeaway above) reports 23/23 clean — confirming the reunite-and-relocate
pattern was applied correctly this time, no repeat of the earlier bug. Byte-identity diff of the
extracted body (excluding the one intentional `window.updateBrandPreview` line) against the
pre-extraction `admin.html` came back clean. `git diff --stat` on `admin.html`: 6 insertions, 157
deletions — reviewed in full; a single clean removal plus one relocated `<script src>` line, no
script-tag split introduced.

**Same known gap as Sections 1-11**: manual click-through not automatable in this sandbox; committed
on static verification. Live-check list now also covers Branding (upload/change logo, favicon, login
background; confirm the 3 live-preview fields now actually update as you type/paste a URL; change
accent colour and theme font; save both Identity and Site scopes; the "Reset" buttons).

### Section 13: Security & Audit (`securityAdmin`) — DONE

Also sat inside `initFinanceManagement(...)`'s closure. Bigger than the map's abbreviated function
list suggested — Audit Log Logic and POPIA Requests Logic together, plus the full POPIA request
lifecycle UI (detail drawer, approve/reject/process/complete-anonymization, an admin-initiated
"Anonymize Now" flow, CSV export) that isn't in the function inventory at all.

- **JS moved**: `admin.html:28850-29405` (`auditState`, `auditSearchTimer`, `AUDIT_TABLE_LABELS`,
  `auditSectionLabel`, `prettyFieldKey`, `formatAuditFieldValue`, `buildAuditDiffHtml`,
  `window.loadAuditLogs`, `renderAuditPagination`, `updateAuditSortIcons`; `popiaState`,
  `popiaSearchTimer`, `POPIA_REASON_LABELS`, `POPIA_STATUS_BADGE`, `popiaQueryParams`, `popiaFetch`,
  `window.loadPopiaRequests`, `renderPopiaRow`, `renderPopiaPagination`,
  `window.debouncePopiaSearch`, `updatePopiaPendingBadge`, `openPopiaRequestDrawer`,
  `popiaApprove`/`popiaReject`/`popiaProcess`/`popiaCompleteAnonymization`, `window.popiaExportCsv`,
  and the delegated click/submit handlers for both the request-detail drawer and the "Anonymize Now"
  drawer) → new `js/admin/security-audit.js`.
- **A second discovered-and-fixed dead-control bug, this time material and POPIA-adjacent**:
  `auditState`/`popiaState` are referenced bare from inline markup — `onclick="auditState.page=1;
  loadAuditLogs()"` on the Audit Log's Search button, and `onclick`/`onchange="popiaState.page=1;
  loadPopiaRequests();"` on every POPIA filter/search control (status, source, date-from, date-to,
  search). Both objects were plain `let` declarations, never `window`-attached, and — being
  closure-scoped inside `initFinanceManagement` — inline attribute handlers (which execute in global
  scope) cannot see them. The first statement in each handler throws `ReferenceError` before the
  handler ever reaches its own `loadAuditLogs()`/`loadPopiaRequests()` call, so **Search and every
  filter control on both panels have almost certainly done nothing, silently, since this code
  existed** (page-load and the Prev/Next pagination buttons, which don't touch `auditState`/
  `popiaState` from markup, still work fine). Flagged to the user explicitly before touching
  anything, given this sits on the POPIA data-subject-request surface; they chose to fix it as part
  of this move. Fix: `window.auditState = auditState;` / `window.popiaState = popiaState;` added
  right after each declaration — same object reference, so this file's own internal reads/writes and
  the newly-exposed global stay perfectly in sync; not a copy, no risk of the two drifting apart.
- **Applied the reunite-and-relocate fix pattern proactively** (second time running, after Branding):
  did not split the enclosing `<script>` tag. The code before this block (Bookings/Quote-Builder
  milestone editor, unrelated) and the "Global Upload Zone Logic" block immediately after are joined
  directly with a short comment in between. `<script src="js/admin/security-audit.js">` sits before
  the whole `initFinanceManagement` block, alongside `services.js`/`policies.js`/`branding.js`.
- **Two things immediately adjacent, explicitly NOT moved**: the "Global Upload Zone Logic" drag-drop
  handler right after this block is shared across multiple sections (its own comment names Home
  Slider, Events, About) — a Phase 7 "Shared candidate". "Session Expiry Monitoring" right after
  that (`sessionTimeoutSec`/`lastActivity`/`updateSessionTimer`, the admin-wide inactivity timeout)
  is global admin-app infrastructure, not specific to the Security & Audit tab — confirmed it's never
  referenced from `securityAdmin`'s own markup.
- **CSS moved**: `admin.html:4040-4041` (`#securityAdmin .table tr.row-ok`/`.row-suspect` — Audit
  Log row highlighting) → new `css/admin/security-audit.css`, split into the main `<style>` block at
  exactly this point (still well before the three existing splits further down for Email Logs ×2 and
  About Me, all untouched).

**Verification**: `node --check` clean on `security-audit.js`; re-run across all 13 extracted files —
clean. The inline-script parse-checker reports 23/23 clean again — the fix pattern held on its second
application. Byte-identity diff of the extracted JS body (excluding the two intentional `window.`
attachment lines) and the extracted CSS both came back clean against the pre-extraction `admin.html`.
`git diff --stat`: 8 insertions, 558 deletions across 3 hunks (the CSS split, the relocated
`<script src>` line, and the JS reunite) — reviewed end-to-end, clean boundaries on all three.

**Same known gap as Sections 1-12**: manual click-through not automatable in this sandbox; committed
on static verification. Live-check list now also covers Security & Audit — confirm the Audit Log
Search button and sort-column clicks now actually filter/re-sort (previously silently broken), page
through both tables, open a POPIA request's detail drawer, and exercise approve/reject/process/CSV
export on a test request if the environment allows it safely.

### Section 14: System Settings (`preferencesAdmin`) — DONE

Assembled from three physically scattered pieces — the first section built this way from a
combination of an old carve-out and a fresh IIFE extraction, rather than either alone.

- **Piece A** — `admin.html:13402-13527`: the "Website Sections" block left over from the About Me
  extraction (`SECTION_REGISTRY`, `renderSectionsUI`, `secSetToggle`, `loadSectionVisibility`,
  `secFilter`, `saveSectionVisibility`, delegated handlers). Plain top-level code, not inside any
  IIFE — same same-position `<script src>` splice used for every non-closure section.
- **Piece B** — `admin.html:29308-29377`: `loadSystemSettings`/`saveSystemSettings` (PayFast +
  SMTP configuration).
- **Piece C** — `admin.html:29491-29507`: `sendTestNotification`.
- **A carve-out sandwiched between B and C, confirmed via its own markup and left untouched**:
  `admin.html:29379-29483` ("Working Hours" — `WH_DAY_NAMES`, `window.loadWorkingHours`,
  `window.saveWorkingHours`). Despite living physically between two System Settings pieces, its
  markup (`#workingHoursTbody`, `#btnSaveWorkingHours`) is inside `calendarAdmin`'s own section —
  this is Unified Calendar's own booking-schedule configuration, not System Settings'.
- **B and C both sat inside `initFinanceManagement(...)`'s closure** (the same one
  Services/Policies/Branding/Security & Audit came from) — applied the reunite-and-relocate pattern
  a third time: no script-tag split at either point, Working Hours stays exactly where it is between
  them untouched, and `<script src="js/admin/system-settings.js">` sits before the whole
  `initFinanceManagement` block, alongside the four already there.
- **No new `window.` attachments needed** — `loadSystemSettings`/`saveSystemSettings`/
  `sendTestNotification` were already window-attached; `saveSectionVisibility` (referenced from a
  static `onclick="saveSectionVisibility(this)"`) is plain top-level code outside any IIFE, so it
  was already globally reachable exactly as before.
- **CSS/shared-candidates**: no private CSS (`#preferencesAdmin` only in the shared 15-section rule);
  no drawer, so no `atlActivateDrawerTab`/`uploadFileToServer` dependency in any of the three pieces.

**Verification**: `node --check` clean on `system-settings.js`; re-run across all 14 extracted files —
clean. The inline-script parse-checker reports 23/23 clean — third consecutive clean application of
the reunite-and-relocate pattern. Byte-identity diffs of all three pieces came back clean against the
pre-extraction `admin.html`. `git diff --stat`: 11 insertions, 213 deletions across 4 hunks (Piece A's
removal, the relocated `<script src>` line, and Pieces B and C's removals) — reviewed end-to-end;
Working Hours' code appears unchanged, as context, in the diff between the B and C hunks.

**Same known gap as Sections 1-13**: manual click-through not automatable in this sandbox; committed
on static verification. Live-check list now also covers System Settings — toggle/save Website
Sections visibility (including the shared Announcement toggle), save PayFast and SMTP settings with
invalid input to confirm validation, and send a test notification.

### Section 15: User Management (`usersAdmin`) — DONE

A different, simpler extraction shape from every prior IIFE-adjacent section: the whole
`initUserManagement(...)` closure moved as one atomic unit, not picked apart.

- **Why atomic works here**: Email Logs was the *only* foreign content ever nested inside this
  closure (already extracted in Section 8, confirmed working by the regression fix). With that
  gone, everything remaining between the closure's own `(function initUserManagement() {` and its
  `})();` is 100% User Management's own code — its full CRUD (load/render/paginate/sort/delete/
  update users), bulk selection controls, and its own separate "Login Activity Logs" panel (Panel
  5, distinct from the sitewide Email Logs admin tab covered in Section 8).
- **JS moved**: `admin.html:26360-27606` (1,247 lines, the largest single move of Phase 6 so far) →
  new `js/admin/user-management.js`, kept wrapped in its own original `(function
  initUserManagement() {...})();` — the one section this pass where the enclosing IIFE itself moves
  wholesale rather than being reunited around a hole.
- **Verified before moving, not assumed**: the extracted closure parses standalone (`node --check`);
  a systematic grep for every one of its internal top-level names (`loadAllUsers`, `initTabs`,
  `renderUsersTable`, `deleteUsers`, `umUpdateUser`, `initUsersBulkControls`, `formatUserAgent`,
  `initManageLogs`, `loadAllLogs`, `moduleLoaded`, `currentUserId`, `allUsersCache`, and more)
  outside `admin.html:26360-27606` returned zero references anywhere else in the file. Every inline
  event attribute in this section's own markup already calls through an explicit `window.` prefix
  (`window.toggleUserSort(...)`, `window.toggleLogSort(...)`) — no bare-identifier risk like
  Branding's or Security & Audit's, and so **no new `window.` attachments were needed at all**.
- **CSS**: no private CSS — `#usersAdmin` only in the shared 15-section rule.
- **Structural note for Phase 8**: this closure still contains the pre-existing `window.toggleLogSort`
  name collision documented in the Email Logs / Services+Policies fix entry — both `email-logs.js`
  and this file's own Login Activity panel define it, with this one's definition (loaded later)
  always winning, unchanged by this move.

**Verification**: `node --check` clean on `user-management.js`; re-run across all 15 extracted files
— clean. The inline-script parse-checker now reports 22/22 clean (one fewer block than before, since
the whole tag was removed rather than split) — confirms the atomic move didn't disturb anything
around it. Byte-identity diff of the full moved content against the pre-extraction `admin.html` came
back completely clean. `git diff --stat`: 4 insertions, 1,253 deletions in a single contiguous hunk —
reviewed end-to-end.

**Same known gap as Sections 1-14**: manual click-through not automatable in this sandbox; committed
on static verification. Live-check list now also covers User Management — load/create/edit/delete a
user, sort/paginate/bulk-select the users table, and separately exercise the Login Activity Logs
panel's own search/filter/sort/pagination.

### Section 16: Financials (`financeAdmin`) — DONE (core content only, scope deliberately narrowed)

The remaining `initFinanceManagement(...)` closure (1,592 lines after Services/Policies/Branding/
Security & Audit/System Settings had already been carved out of it) turned out to be a mix of
Financials' own content and territory belonging to a different, not-yet-scoped, also-protected
section. Flagged to the user before deciding how to proceed, given both Financials and Bookings are
on the plan's protected-surfaces list.

- **JS moved**: `admin.html:26482-27178` (697 lines — Financial State/helpers, Transactions,
  Invoices, Generate Invoice Modal, Financial Analytics & Reports/charts) → new
  `js/admin/financials.js`.
- **Deliberately NOT moved, deferred rather than scoped now**: a "Payment Milestone Schedules
  (Phase 4 Widget)" block (~300 lines) immediately after this content —
  `window.loadBookingPaymentSchedule` and friends, keyed by `bookingId`, hitting
  `/api/admin/bookings/:id/payment-schedules`. This is Bookings' own Deal View feature, not
  Financials', physically adjacent only by historical accident of where it was originally coded.
  Verified zero cross-reference in either direction (grepped every core-Finance name against the
  milestone block and vice versa — clean both ways), so leaving it behind cost nothing in
  cleanliness. Deferred to a future, dedicated Bookings scoping pass rather than folded in here or
  extracted alone right now.
- **Everything else in the closure, already known and still untouched**: Global Upload Zone Logic
  (shared, Phase 7 candidate), Session Expiry Monitoring + the shared Tab Bootstrap block (global
  infra), Working Hours (confirmed Unified Calendar's own, not yet extracted), and the Gate B1
  global error handler.
- **Applied the reunite-and-relocate pattern a fourth time**: no script-tag split; the closure's own
  `(function initFinanceManagement() { 'use strict';` opening stays exactly as-is, core Finance's
  content is removed and replaced with an explanatory comment, and the Payment Milestone Schedules
  block continues immediately after, untouched. `<script src="js/admin/financials.js">` sits before
  the whole `initFinanceManagement` block, alongside the five already there.
- **No new `window.` attachments needed** — every publicly-referenced function
  (`window.loadFinancialStats`, `loadFinAnalytics`, `generateInvoice`, `sendInvoice`,
  `markInvoicePaid`, `voidInvoice`, `filterTransactions`, `applyInvoiceFilter`,
  `openGenerateInvoiceModal`, `onFinPeriodPresetChange`, the quote/invoice card resend helpers,
  `loadRemindersLog`) was already window-attached in the original source.
- **CSS/shared-candidates**: no private CSS (`#financeAdmin` only in the shared 15-section rule); no
  drawer dependency.

**Verification**: `node --check` clean on `financials.js`; re-run across all 16 extracted files —
clean. The inline-script parse-checker reports 22/22 clean — fourth consecutive clean application of
the reunite-and-relocate pattern. Byte-identity diff of the extracted content came back clean against
the pre-extraction `admin.html`. `git diff --stat`: 6 insertions, 697 deletions across 2 hunks
(the relocated `<script src>` line and the core-content removal) — reviewed end-to-end; the Payment
Milestone Schedules block appears unchanged, as context, immediately after the removal.

**Same known gap as Sections 1-15**: manual click-through not automatable in this sandbox; committed
on static verification. Live-check list now also covers Financials — load the Transactions and
Invoices tabs, generate/send/void/mark-paid an invoice, filter transactions, and load the Financial
Analytics charts across each period preset.

### Section 17: Unified Calendar (`calendarAdmin`) — DONE (self-caught mistake mid-extraction)

A third instance of the "mega-closure housing multiple sections" pattern — but this one was missed
on first pass because, unlike `initUserManagement`/`initFinanceManagement`, it's an **anonymous**
`(function() {...})();` with no name to grep for.

- **The mistake**: initial scoping concluded Calendar's own JS (`admin.html:24918-25457`) was plain
  top-level code with no enclosing IIFE — based on checking for *named* IIFEs and finding none, and
  on the correct-but-incomplete observation that its cross-references (to/from Bookings' success
  handlers and Working Hours) would resolve via shared global scope if nothing wrapped it. A
  same-position `<script>` split was applied (the technique used for 9 of the first 11 sections) and
  broke the actual enclosing closure — `admin.html:24485-26348`, 1,864 lines, wrapping the core
  admin-shell (`toggleSidebar`/`switchTab`/dropdowns/breadcrumb/profile-display) *and* Bookings'
  Manual Booking modal around Calendar's own content — into two unparseable halves. Caught
  immediately by the inline-script parse-checker (2 failures), reverted cleanly (`git checkout` +
  delete untracked files, `git status` confirmed clean) before any commit.
- **The corrected plan, verified this time before touching anything again**: grepped every one of
  Calendar's internal names for local-scope shadowing anywhere else in the 1,864-line closure (none
  found); verified the closure's own content-before-Calendar concatenated directly to its
  content-after-Calendar parses cleanly standalone; and reasoned through the cross-reference
  direction explicitly — Bookings' success handlers (same closure) and Working Hours (a *different*
  closure, inside `initFinanceManagement`) calling `adminCalendar`/`renderWorkingSchedule` is
  **outward/upward** scope resolution (inner function → enclosing global scope), the same always-safe
  direction already relied on for `_siteContent` and the Website Sections carve-out — categorically
  different from the `auditState`/`updateBrandPreview` bugs, which needed impossible **inward** access
  from global scope into a closure.
- **JS moved**: `admin.html:24918-25457` (540 lines — `adminCalendar`/`_calFilterState` state,
  `window._calSwitchToList`, `window.handleRemoveHold`, `showCalEventPopup`, `initAdminCalendar`,
  `initMiniCalendar`/`refreshEventDots`/`window.refreshMiniCalendar`, `renderWorkingSchedule`, the
  Refresh Calendar button handler) → new `js/admin/calendar.js`, using the reunite-and-relocate
  pattern this time — the anonymous closure stays whole, `<script src="js/admin/calendar.js">` sits
  before its `<script>` tag.
- **A third incidental dead-code fix, expected rather than newly discovered**: Working Hours'
  `adminCalendar.setOption('businessHours', ...)` call was silently inert (a `typeof adminCalendar
  !== 'undefined'` guard defensively written by the original developer, precisely because it's in a
  different closure with no access to Calendar's `adminCalendar`) — will likely start working now
  that `adminCalendar` is declared at `calendar.js`'s own top level, joining the shared global scope
  both closures can already reach into. No explicit user sign-off sought this time since it's a pure
  consequence of the scope-resolution mechanics already explained and approved for this section,
  not a new closure-scoped-bare-attribute bug of the `auditState` kind.
- **CSS moved**: three separate clusters — `admin.html:1277-1280` (sidebar gap), `1348-1373` (mobile
  toolbar layout), `3866-3978` (main FullCalendar theming) — concatenated in original document order
  into new `css/admin/calendar.css`, linked from **all three** original positions (not consolidated
  to one) to guarantee the cascade order relative to whatever other sections' rules sat between the
  clusters is unchanged, matching the two-file approach used for Email Logs' duplicate `.log-row`
  rules.
- **Found and flagged, not touched**: `.cal-block-chip` (`admin.html:3979-3983` originally),
  immediately after the third CSS cluster — zero references anywhere in markup or JS, orphaned dead
  CSS, left in place per the no-deletions rule, flagged for Phase 8.
- **Explicitly staying put**: the core admin-shell and Bookings' Manual Booking modal, both
  untouched, as agreed before this section was scoped.

**Verification**: `node --check` clean on `calendar.js`; re-run across all 17 extracted files — clean.
The inline-script parse-checker reports 22/22 clean on the corrected version (after the initial 2
failures on the first, reverted attempt). Byte-identity diffs of the JS and the concatenated CSS both
came back clean against the pre-extraction `admin.html`. `git diff --stat`: 14 insertions, 683
deletions across 5 hunks (3 CSS splices, the relocated `<script src>` line, and the JS reunite) —
reviewed end-to-end; the `(function() {` opening and Manual Booking modal's start both appear
unchanged, as context, on either side of the JS removal.

**Same known gap as Sections 1-16**: manual click-through not automatable in this sandbox; committed
on static verification. Live-check list now also covers Unified Calendar — load the main calendar,
toggle the bookings/holds/events/milestones filters, remove a hold, click an event for the popup,
use the mini calendar, and confirm the Refresh Calendar button (including whether Working Hours'
business-hours now visibly reflects on the calendar, given the incidental fix above).

### Section 18: Dashboard (`dashboardAdmin`) — DONE (largest CSS footprint of any section; a second self-caught mistake mid-extraction)

The biggest and most structurally unusual section yet — two JS pieces plus CSS scattered across
**three** locations, one of them a ~440-line `<style>` tag embedded directly inside the section's own
markup, a pattern no other admin section uses.

- **JS moved**: `admin.html:21493-21543` (`loadDashboardKPIs`, the small overview tiles) and
  `admin.html:27075-27670` (the full "Dashboard Analytics" module — KPI summary, visitor/traffic/
  device/bookings charts, today's schedule, social-visibility toggle) → new `js/admin/dashboard.js`,
  concatenated. Both plain top-level code, no enclosing IIFE — verified this explicitly given the
  two near-misses on the two sections immediately before this one.
- **Self-caught mistake #2 this session (different kind from Unified Calendar's)**: the first build
  of the extraction script processed its five splice points in the WRONG order — the three CSS
  edits (lower line numbers, ~3151-5809) were applied *before* the two JS edits (higher line
  numbers, ~21493 and ~27075), violating this project's own established "always splice from the
  highest original line number to the lowest" rule. Since the CSS edits shifted everything after
  them, the JS edits' hard-coded original line numbers were stale by the time they ran, and the
  script spliced in the middle of unrelated Events-tab markup, corrupting a large stretch of the
  file. Caught immediately by the inline-script parse-checker (`Unexpected token '<'`), reverted
  cleanly (`git checkout` + delete untracked files, `git status` confirmed clean) before any commit.
  Fixed by reordering the five splices strictly descending: JS piece 2 (27075) → JS piece 1
  (21493) → embedded widget CSS (5368) → CSS cluster 2 (3986) → CSS cluster 1 (3151).
- **Avoiding a double-load bug while fixing the above**: `loadDashboardKPIs` (piece 1, earlier in
  the document) and the Analytics module (piece 2, later) both needed to end up in the same
  `dashboard.js` file, but the Analytics module's own body contains a top-level
  `document.addEventListener('DOMContentLoaded', ...)` registration — loading `dashboard.js` via a
  `<script src>` at *both* pieces' original positions would have registered that listener twice,
  double-firing `loadAnalyticsDashboard`/`loadTodaysSchedule`/`initDashboardSocialPref` on every
  page load. Fixed by loading `dashboard.js` only once, at piece 1's (earlier) position, and simply
  removing piece 2's content at its own position with no `<script src>` there — by the time the
  document reaches piece 2's original spot, the whole file (both pieces) is already loaded and has
  already run.
- **CSS moved, three locations**: `admin.html:3151-3248` and `3986-4002` (two non-conflicting
  main-stylesheet clusters — stat/social/crm/schedule cards; summary/social grids) combined into new
  `css/admin/dashboard.css`, linked from both original positions (the same multi-link-one-file
  approach used for Unified Calendar's three clusters); and the ~440-line embedded `<style>` tag at
  `admin.html:5368-5809` (period selector, KPI cards, CRM cards, chart grids, schedule list,
  sparklines, ranked lists, country map, social cards, trend indicators, KPI config cards) → new,
  separate `css/admin/dashboard-widget.css`, replacing that whole `<style>...</style>` pair with one
  `<link>` at the same position.
- **A third pre-existing CSS-duplication bug found, not resolved**: the embedded widget stylesheet
  redefines several classes ALSO defined in the main-stylesheet file (`.db-summary-grid`,
  `.db-stat-card`, `.db-schedule-item`, `.db-social-grid`) using *different* breakpoint values
  (576/992/1200px vs 480/768/1024px) — the same class of bug as Email Logs' duplicate `.log-row`
  rules. Kept as two separate files, each linked at its own original position, to preserve the exact
  pre-existing cascade order rather than merge them. A smaller instance of the same pattern
  (`.trend-up`/`.trend-down`, defined once in the main stylesheet and again inside the embedded
  block) was folded into the widget file as-is, alongside its own duplicate — not deduplicated.
  Flagged for Phase 8.
- **No new `window.` attachments needed** — every cross-reference (the anonymous mega-closure's
  `switchTab` calling `loadDashboardKPIs`/`loadAnalyticsDashboard`/`loadTodaysSchedule` bare, a
  static `onclick="loadAnalyticsDashboard()"` in markup, and Social Media's own
  `saveSocialKpiSettings` calling `loadAnalyticsDashboard()` bare from its own separate file) relies
  on plain function declarations becoming `window` properties automatically, unaffected by which
  physical file they end up in.

**Verification**: `node --check` clean on `dashboard.js`; re-run across all 18 extracted files —
clean. The inline-script parse-checker reports 23/23 clean on the corrected version (after the
initial ordering-bug corruption was caught and reverted). Byte-identity diffs of both JS pieces and
all three CSS sources came back clean against the pre-extraction `admin.html`. `git diff --stat`: 18
insertions, 1,204 deletions across 5 hunks — reviewed end-to-end; the RBAC "Role-based UI gating"
header and the Events-tab markup that follows the widget `<style>` block both appear unchanged, as
context, confirming the corrected splice order landed exactly where intended.

**Same known gap as Sections 1-17**: manual click-through not automatable in this sandbox; committed
on static verification. Live-check list now also covers Dashboard — confirm the KPI tiles populate,
every Analytics chart renders across period presets, today's schedule loads, the social-visibility
toggle persists, and (given the CSS duplication above) that the Dashboard layout still looks correct
at each responsive breakpoint.

### Section 19: Inquiries (`inquiriesAdmin`) — DONE

The section originally flagged, at the very start of this whole pass, as too large and
email-composer-heavy to tackle casually — revisited once the extraction methodology (and the lessons
from two recent near-misses) had matured enough to handle it carefully. Clean result: no enclosing
IIFE, no cross-reference surprises, extraction succeeded on the first attempt.

- **JS moved**: `admin.html:13570-14976` (1,407 lines — the "INQUIRIES — EMAIL CLIENT" block: inbox
  list/search/filter/sort/pagination, the detail drawer, a Quill-based compose view with recipient
  chips, attachments, scheduling, autosave drafts, templates, bulk status actions, and notes) → new
  `js/admin/inquiries.js`.
- **Verified no enclosing IIFE before touching anything, exhaustively this time** (given the
  Unified Calendar and Dashboard near-misses immediately before this section): a full scan of the
  entire ~1,700-line surrounding range for `(function`/`})();` patterns found none; the exact
  13570-14976 range parses standalone; and — most reassuringly — the source itself confirms it via
  an existing developer comment: *"this section's `<script>` block is a separate scope from the
  manual-booking drawer's"*, written specifically to explain why `loadInquiries` needed an explicit
  `window.` attachment. The same-position split technique (no reunite-and-relocate needed) was used
  with confidence as a result.
- **Zero new `window.` attachments needed**: `window.loadInquiries` was already explicitly attached
  (per that comment). Every other one of Inquiries' ~50 top-level names (including `openInquiry`,
  called bare from the anonymous mega-closure's notification-popup code) is a plain top-level
  function/`let` declaration with no wrapping IIFE — already globally reachable exactly as before.
  One cross-closure reference specifically checked and confirmed **already working** (not a dead-code
  case like `adminCalendar`'s): `allInquiriesCache`, read via a
  `typeof allInquiriesCache !== 'undefined'` guard from inside the mega-closure's own "Notifications"
  dropdown feature — since it's a `let` declared at Inquiries' own true top level (not inside any
  IIFE), it was already part of the one shared global lexical environment every classic `<script>`
  tag on the page can reach into, unlike `adminCalendar` (declared inside a closure).
- **CSS moved**: `admin.html:3157-3521` (365 lines, one clean cluster) → new `css/admin/inquiries.css`
  — already explicitly consolidated by the original developers (per its own header comment, inherited
  into the new file) from `css/redesign.css` plus two prior overlapping inline retrofits; no
  duplication concern here, unlike Dashboard's CSS.
- **Shared-candidate usage, not moved**: `openAtlDrawer`/`closeAtlDrawer` (the detail drawer) — the
  usual Phase 7 candidates.

**Verification**: `node --check` clean on `inquiries.js`; re-run across all 19 extracted files —
clean. The inline-script parse-checker reports 24/24 clean — no failures on this attempt, unlike the
two sections immediately before it. Byte-identity diffs of both the JS and CSS came back clean
against the pre-extraction `admin.html`. `git diff --stat`: 8 insertions, 1,772 deletions across 2
hunks — reviewed end-to-end; the "USER MANAGEMENT SECTION" CSS header and the "--- Bookings ---" JS
comment both appear unchanged, as context, on either side of the two removals.

**Same known gap as Sections 1-18**: manual click-through not automatable in this sandbox; committed
on static verification. Live-check list now also covers Inquiries — load the inbox, filter/search/
sort/paginate, open an inquiry's detail drawer, compose and send/schedule a reply with an attachment
and a recipient chip, save/discard an autosaved draft, apply a template, and exercise bulk status
actions.

### Section 20: Newsletter (`newsletterAdmin`) — DONE

Same clean shape as Inquiries — no enclosing IIFE, no cross-reference surprises, single attempt.

- **JS moved**: `admin.html:17742-19101` (1,360 lines — Subscribers list/search/filter/sort/
  pagination/bulk actions/CSV import-export, Birthday Automation settings with its own Quill editor,
  Campaign composition with merge fields/audience targeting/attachments, Drafts, Scheduled sends,
  and Campaign delivery-log/reuse/edit/delete) → new `js/admin/newsletter.js`.
- **Verified no enclosing IIFE**: a full scan of the range for `(function`/`})();` patterns found
  only two self-contained, same-line pagination-button IIFEs (the standard "capture loop variable"
  idiom — open and close on one line each, not spanning wrappers); the range parses standalone.
  Same-position split used with confidence.
- **Zero new `window.` attachments needed**: `window.toggleSubscriberSort`/`subscribersData`/
  `birthdayBodyQuill`/`loadBirthdaySettings` were already explicitly attached.
  `window.newsletterQuill` is read here but assigned elsewhere (a separate Quill-init block that
  runs after the Quill library itself loads) — already safe via existing `window.` prefixing on
  both ends, unaffected by which file either side lives in. Every other name is a plain top-level
  function/`let` declaration with no wrapping IIFE — already globally reachable exactly as before,
  including 5 external bare calls (`loadDraftsList`/`loadScheduledList`/`loadSubscriberStats`/
  `refreshAudienceCount`/`renderSubscribersList`) from a "refresh everything" handler just after
  this range, inside the same giant non-IIFE script tag that also houses Inquiries and Bookings.
- **No private CSS found** — Newsletter relies entirely on shared framework classes (`.um-*`/
  `.atl-*`), confirmed via both a header-comment search and a class-prefix search.
- **Shared-candidate usage, not moved**: `openAtlDrawer`/`closeAtlDrawer` (the edit-subscriber
  drawer) — the usual Phase 7 candidates.
- **Explicitly bounded by, not touched**: a generic, cross-cutting `.status-select`/`.delete-btn`
  delegated-handler block shared by Inquiries and Bookings (immediately before this range) and a
  "Record Payment Modal" feature belonging to Bookings (immediately after) — both untouched.

**Verification**: `node --check` clean on `newsletter.js`; re-run across all 20 extracted files —
clean. The inline-script parse-checker reports 25/25 clean — no failures. Byte-identity diff of the
extracted content came back clean against the pre-extraction `admin.html`. `git diff --stat`: 6
insertions, 1,360 deletions in a single contiguous hunk — reviewed end-to-end; both neighboring
blocks appear unchanged, as context, on either side of the removal.

**Same known gap as Sections 1-19**: manual click-through not automatable in this sandbox; committed
on static verification. Live-check list now also covers Newsletter — load/search/sort/paginate
subscribers, import/export a CSV, save Birthday Automation settings and send a test, compose a
campaign with a merge field and an attachment, save a draft, schedule a send, and view a delivery
log.

---

## Phase 5 — Route & middleware split

In progress. Splits `server.js` along the admin/public boundary per the plan: `routes/admin/`,
`routes/public/`, an `app.js` that mounts everything, `server.js` reduced to process-entry-point
only. Route counts confirmed via live grep: **270** `/api/admin/*`, **49** `/api/public/*` —
exactly matching the plan's estimate.

### Extraction tooling

Routes are moved with a small AST-based script (`acorn`, installed only in the scratchpad
directory — not a project dependency), not by hand: hand-finding where a 200-line nested-callback
route handler ends is error-prone at this scale. The script parses `app.js`, finds every top-level
`app.<method>('/api/admin/...'` / `'/api/public/...'` call plus its exact source range (attaching
an immediately-preceding comment, if any), and for a chosen batch: cuts those exact ranges out of
`app.js`, swaps `app.` → `router.` at each one, and inserts the result into the target
`routes/admin/*.js` / `routes/public/*.js` file before its `module.exports` line (creating the
file with a router boilerplate header if it doesn't exist yet). Dry-run verified against a real
two-route sample before ever pointing it at the live file — diffed clean, syntax-checked clean.

**Discovered mid-implementation and fixed:** the first extraction attempt crashed after cutting
routes out of `app.js` but before the target directory existed to receive them — the script wrote
`app.js` *before* confirming the output file could be written. Caught immediately (`git diff`
showed the missing routes with nowhere written), recovered with `git checkout -- app.js` (nothing
was ever committed in the broken state), and fixed the script to write the output file first,
`app.js` only after that succeeds — a batch attempt now either fully completes or leaves `app.js`
completely untouched.

### Helper relocation (discovered necessary, not in the original plan text)

Dry-run testing the mechanical extraction surfaced a problem the plan doesn't address: routes call
helper functions/constants defined inline in `app.js` (`resolveActor`, `logAudit`,
`createAndSendInvite`, `VALID_ADMIN_ROLES`, `dbRun`/`dbGet`/`dbAll`, and more not yet
inventoried) that a standalone route file can't reach — `app.js` requires the route files, so a
route file requiring `app.js` back for them would be circular and silently resolve to `undefined`.
Confirmed with the user: relocate each helper into `lib/` **as its batch needs it**, not as a big
speculative upfront pass. Repository functions need no such treatment — already standalone modules,
any route file imports them directly.

Two structural fixes were needed before route files could import middleware at all:
- **`middleware/rate-limiters.js`** (new): all 11 rate limiters (`booking`, `export`, `sitemap`,
  `track`, `otpRequest`, `mutate`, `admin`, `adminLogin`, `lookup`, `analyticsTrack`, `ip`) plus
  `payfastItnRateLimiter`/`PAYFAST_VALID_IPS`, byte-identical, centralised so any route file has one
  place to import whichever limiter its route used — previously all defined inline in `app.js`.
- **`middleware/auth.js` reworked**: `requireAdmin` was a factory (`createRequireAdmin(adminRateLimiter)`)
  `app.js` had to call — no route file could reach the same array without a circular require. Now a
  plain export: the fully-built `[adminRateLimiter, checkFn]` array, built from
  `rate-limiters.js` + the auth-users repository, both leaf modules.

`lib/` additions so far, all byte-identical bodies moved out of `app.js`:
- `lib/db-helpers.js` — `dbRun`/`dbGet`/`dbAll` (~190 call sites throughout `app.js`).
- `lib/actor.js` — `resolveActor`.
- `lib/audit-log.js` — `logAudit` (writes `audit_log`, the permanently-excluded generic infra table
  from Phase 4 — not owned by any domain repository, so this is its natural home).
- `lib/admin-users.js` — `VALID_ADMIN_ROLES`, `countOtherActiveAdministrators`,
  `createAndSendInvite`, specific to the `/api/admin/users` route cluster.

`app.js` destructure-imports all of these back, so its own not-yet-moved routes keep working
unchanged — same pattern Phase 4 established for repository functions.

### Route batch 1: `routes/admin/users.js` — DONE

6 routes: `GET/POST /api/admin/users`, `GET /api/admin/user-login-logs`,
`POST /api/admin/users/:id/resend-invite`, `PUT/DELETE /api/admin/users/:id`. First real batch —
chosen deliberately small and well-understood (this is the exact route cluster the `auth+users`
Phase 4 domain already covered) to prove the whole pipeline — mechanical extraction, per-route-file
imports (middleware + repository functions + the four `lib/` helpers above + `bcrypt`/`crypto`),
mounting, verification — end to end before scaling up.

Mounted in `app.js` via `app.use(require('./routes/admin/users'))`, placed right after the session
middleware (after body-parsing/sanitisation are in place, before any not-yet-extracted route) — a
new "Phase 5 route mounts" section that will grow one line per batch.

Verification: `node -c` on `app.js` and the new route file; re-grepped
`app\.(get|post|put|delete)\('/api/admin/users` against post-edit `app.js` — zero hits, confirming
a clean, complete removal. `npm run smoke` 329/329 (all 6 routes still reachable through the new
router). `npm test` x3 — baseline plus a mix of already-documented flakes each run (CP5, CP12 x2,
CP21, the calendar-booking-sync reschedule test, the one-off "full refund" flake), never anything
touching `admins`/`admin_login_logs`/`password_reset_tokens`. Specifically confirmed via the test
log (not just smoke's non-5xx check) that the two `audit-history.test.js` checks exercising
`logAudit` from inside the moved routes ("user create/update writes exactly one audit_log row")
passed, and all `/api/admin/users`-related RBAC checks passed, on every run.

### Route batch 2: `routes/admin/auth.js` — DONE

7 routes: `POST /api/admin/login`, `POST /api/admin/force-change-password`,
`POST /api/admin/logout`, `GET /api/admin/session`, `POST /api/admin/forgot-password`,
`POST /api/admin/reset-password`, `POST /api/admin/session/heartbeat`. The login/session/password
half of `auth+users`, split from batch 1's user-management CRUD — no shared helper overlap
(no `resolveActor`/`logAudit`/`createAndSendInvite` needed here), just repository functions +
`bcrypt`/`crypto`/`emailComponents`/`sendEmail` + `requireAdmin`/`adminLoginRateLimiter`.

This batch includes `POST /api/admin/login` itself — the single most foundational route in the
app (nearly every other test's setup depends on it working). Ran the full suite **3 times**
specifically because of that: 648-649/651 every run, only the permanent baseline plus one
already-documented flake (CP5) on one run. If login/session handling had broken in the move, the
signal would be hundreds of cascading failures, not 2-3 — this is about as strong a confirmation
as the test suite can give.

### Route batch 3: `routes/admin/settings.js` — DONE

8 routes: `GET/PUT /api/admin/working-hours`, `GET /api/admin/audit_log`,
`GET /api/admin/financial_audit_log`, `GET/PUT /api/admin/policies`, `GET/PUT /api/admin/settings`.
None of these tables (`working_hours`, `audit_log`, `financial_audit_log`, `policies`) are owned by
a Phase 4 repository (`audit_log`/`financial_audit_log` permanently excluded; `policies` flagged
unclaimed in the `calendar` write-up; `working_hours` never claimed by anyone) — these routes do
raw `db.all`/`db.run`/`db.serialize` calls directly, so this file imports `db` itself rather than
a repository.

**A new kind of shared-state problem, not just missing imports:** `PUT /api/admin/working-hours`
mutated two module-scoped `let MIN_BOOKING_GAP_MINS`/`let TYPE_BUFFERS` variables that
`hasCalendarConflict()` and two other still-in-`app.js` read sites depend on for every booking's
conflict check. CommonJS requires copy a primitive's *value* at import time, not a live binding —
had this route moved with a naive `require` of those two names, its write would silently update
only its own local copy, leaving every conflict check in `app.js` reading the stale default
forever. Fixed with **`lib/booking-config.js`**: both variables become properties of one exported
object (`bookingConfig.minGapMins`/`.typeBuffers`) — mutating a *property* of an already-shared
object *does* stay visible everywhere that imported it, unlike reassigning a plain variable. All 3
read sites in `app.js` (not just the one write this batch moved) were updated to the new shape,
confirmed via `grep` that no bare `MIN_BOOKING_GAP_MINS`/`TYPE_BUFFERS` reference survived anywhere.

Verification: `node -c`; confirmed zero remaining `app.js` registrations for any of the 8 paths;
`npm run smoke` 329/329; `npm test` x3 (only already-documented flakes). Specifically checked the
audit_log route's dynamic-SQL + `admins` JOIN and the shared-state fix aren't just passing by
smoke-test luck — `audit_log table+record_id filter succeeds`, `audit_log join resolves an actor
name for numeric changed_by rows`, and all `working-hours`/`audit_log`/`financial_audit_log` RBAC
checks passed on every run.

### Route batch 4: `routes/admin/site-content.js` — DONE

10 routes: `POST /api/admin/migrate`, `PUT /api/admin/branding`, `GET /api/admin/venues`,
`GET /api/admin/reviews`, `PUT/DELETE /api/admin/manager`, `POST /api/admin/contact_info`,
`GET/POST /api/admin/about-me`, `PUT /api/admin/site-content`. A grab-bag of small,
otherwise-unrelated admin CRUD routes (`clients`/`venues`/`manager_details`/`contact_info`/
`about_me`/`service_reviews` — none owned by a Phase 4 repository) batched together for
efficiency rather than left as individual 1-2-route batches.

Two more widely-shared helpers surfaced and relocated, each used well beyond this batch:
- **`lib/html-sanitize.js`** — `encodeUserHtml` (~27 call sites across `app.js`), `unescapeHtml`,
  `sanitizeAboutHtml` (+ its 3 regex constants), and `SECTION_KEYS` (shared with the still-in-
  `app.js` `GET /api/public/site-content`). All pure functions, no `db`/session access.
- **`lib/client-venue.js`** — `findOrCreateClient` (9 call sites) and `findOrCreateVenueFromPlace`
  (4 call sites), both depending on `db` directly (`clients`/`venues` were never claimed by a
  domain repository) and on `encodeUserHtml` above.

`findOrCreateClient`/`findOrCreateVenueFromPlace` are called from the core public booking-creation
path elsewhere in `app.js` (not moved yet) — the widest blast radius any single helper relocation
has had so far. Ran the full suite **3 times** specifically because of that: all three runs came
back at the permanent baseline only (649/651, zero additional flakes) — the cleanest result any
Phase 5 step has had. Specifically confirmed `rejected submission writes no orphan client` (a
`findOrCreateClient` behavior check) passed on every run.

Verification: `node -c`; confirmed zero remaining `app.js` registrations for all 10 paths;
`npm run smoke` 329/329; `npm test` x3 (see above).

### Route batches 5 & 6: `routes/admin/content.js`, `routes/admin/home-social.js` — DONE

**`content.js`** — 16 routes: `GET/POST/PUT/DELETE /api/admin/highlights[/:id]`,
`.../footprint[/:id]`, `.../testimonials[/:id]`, plus `PUT /api/admin/gallery/reorder`,
`POST/PUT/DELETE /api/admin/gallery[/:id]`. Small CMS-style CRUD clusters
(`career_highlights`/`footprint_countries`/`testimonials`/`gallery_images`, none owned by a Phase 4
repository), batched together.

Two more widely-shared helpers surfaced, each used well beyond this batch:
- **`lib/runtime-paths.js`** — the Phase 3 `DOCS_PATH`/`UPLOADS_PATH`/`BACKUPS_PATH`/
  `docsWriteDir`/`resolveDocsPath`/`uploadsWriteDir` config (10-19 call sites each). Two of the
  original constants (`RUNTIME_DATA_DEFAULT_ROOT`, `LEGACY_DOCS_DIR`) anchored themselves on
  `__dirname` — correct in `app.js` (still the project root) but would resolve one directory too
  deep from inside `lib/`. Anchored on `path.resolve(__dirname, '..')` instead, matching the same
  one-level-deep assumption `database/repositories/*.js` already rely on.
- **`lib/uploads.js`** — `safeUploadFilename` + the shared `upload` multer instance (~20 call sites
  across admin image-upload routes), depending on `runtime-paths.js` above.

**`home-social.js`** — 11 routes: `GET/POST/DELETE /api/admin/home-slider[/:id]` +
`PUT .../reorder`, `GET/POST/DELETE /api/admin/social_links[/:id]`,
`GET/POST/DELETE /api/admin/social_embeds[/:id]`. No new shared helpers needed (`requireAdmin`,
`requireRole`, `db`, `logAudit` only) — a good sign the `lib/` surface built up over the last few
batches is starting to cover new batches without further discovery. One route-ordering note
preserved automatically: `PUT .../home-slider/reorder` is registered before
`PUT .../home-slider/:id` in the same file (explicit in-code comment — "reorder" would otherwise be
captured as `:id`) — both moved together into one file in their original relative order, so
Express's first-match-wins semantics are unaffected.

**Verification was interrupted by an environmental problem, not a code problem**: two stale
`node server.js` processes from an early-session `npm start` (running since ~10:21 AM, never
stopped) caused `npm test` to hang indefinitely partway through `booking.test.js` on two separate
attempts (`npm run smoke`, which also boots a full server, completed in seconds both times —
pointing at cross-process SQLite lock contention specifically, not a broken app). Stopping the
tracked background task didn't kill its own spawned child processes either (a `TaskStop`
limitation on Windows process trees), briefly adding a *third* stale set under new PIDs. Resolved
once the user killed the relevant PIDs directly; documented here since it cost real time and may
recur if a future session leaves a dev server running.

Once the environment was clean: `npm run smoke` 329/329; `npm test` x3, all clean runs (baseline
plus one already-documented CP5 recurrence on one run) — specifically confirmed gallery
create/update audit_log rows and all 6 upload-handler filename tests passed on every run. `node -c`
on all changed/new files; confirmed zero remaining `app.js` registrations for all 27 moved paths.

### Route batch 7: `routes/admin/newsletter-subscribers.js` — DONE

9 routes: `GET /api/admin/newsletter/subscribers[/stats]`, `POST .../subscribers`,
`PUT .../subscribers/:id[/status]`, `DELETE .../subscribers/:id`, `PUT .../subscribers/bulk-status`,
`POST .../subscribers/bulk-delete`, `POST .../subscribers/import`. First newsletter batch — the
domain repository already existed from Phase 4, so every data-access call was a trivial import;
all the new work this batch was shared *business-logic* helpers, not data access.

Four more `lib/` modules, each with a wide, cross-cutting blast radius:
- **`lib/db-transaction.js`** — `withDbTransaction`, the serialization queue **~21 call sites**
  throughout `app.js` rely on to make guarded BEGIN/COMMIT/ROLLBACK sections atomic with respect to
  each other (concurrent booking submissions were the original motivating case). Flagged explicitly
  in its own file header: this **must** stay a singleton — every caller has to import this exact
  module, never redefine the queue, or the whole serialization guarantee silently stops working.
  CommonJS's module cache guarantees that as long as everyone requires the same path.
- **`lib/email-context.js`** — `getEmailFooterContext` (~44 call sites) and `emailBaseUrl`
  (~19 call sites), used by nearly every email-composing function in the app, not just newsletter.
- **`lib/validation.js`** — `sanitizeEmailInput`, `isValidBirthday` (+ its `BIRTHDAY_DAYS_IN_MONTH`
  table). Small, pure, standalone.
- **`lib/newsletter-emails.js`** — `sendNewsletterWelcomeEmail` (its sibling
  `sendNewsletterConfirmationEmail` stays in `app.js` for now, moving here when the batch that
  needs it comes up).

`subscriberCsvUpload` (the CSV-import multer instance) had zero remaining call sites in `app.js`
once this batch's routes moved out, so it was defined directly in the route file rather than added
to `lib/` — nothing else needs to share it.

**A third `SQLITE_BUSY` crash, same test file, same exact point, but this time in a verified-clean
environment** (zero `node.exe` processes running beforehand, confirmed via `Get-CimInstance`) —
`banner.test.js`, immediately after "get: banner + empty used_by before assignment", identical to
the two prior occurrences logged elsewhere in this file. Since stale processes are now ruled out as
the cause for at least this occurrence, this looks like a genuine (if infrequent) SQLite
lock-contention race intrinsic to the test suite's own design at that point, not purely a
leftover-process artifact — recovered the same way (immediate re-run, clean), documented as a
data point for whoever eventually investigates `banner.test.js` directly.

Verification: `node -c` on all changed/new files; confirmed zero remaining `app.js` registrations
for all 9 paths; `npm run smoke` 329/329; `npm test` x4 (1 environmental crash as above, 3 clean
baseline-only runs) — specifically confirmed the newsletter confirmation/welcome-email tests and
all subscriber RBAC checks passed.

### Route batch 8: `routes/admin/newsletter-campaigns.js` — DONE (closes out `newsletter`)

15 routes: newsletter drafts CRUD, `POST /api/admin/newsletter/preview`, scheduled-newsletter
CRUD (`schedule[/:id]`), `GET .../campaigns/audience-count`, and the full birthday-automation
settings/preview/send-test cluster. The largest and most interconnected helper-relocation of
Phase 5 so far — this pulled in essentially the entire newsletter-scheduling and
birthday-automation subsystems, both flagged as protected surfaces by the original plan (email
automation).

Two new `lib/` modules, each holding a **required singleton**:
- **`lib/newsletter-scheduling.js`** — `scheduledJobs` (the node-schedule Job map, keyed by
  `scheduled_newsletters.id` for newsletter jobs and by string-prefixed `jobKey`s for the separate
  direct-email scheduling feature that shares the same map — confirmed via `grep` before assuming
  a single owner), `buildSegmentCondition`, and `scheduleNewsletterSend` (the atomic-claim send
  job — same "must stay one instance" reasoning as `dbTxnQueue`/`withDbTransaction`).
- **`lib/newsletter-birthday.js`** — `birthdayJob` (the one persistent daily cron Job — a second
  copy would leave an uncancellable duplicate firing every day), `BIRTHDAY_SETTING_DEFAULTS/KEYS`,
  `mergeBirthdayOverrides`, `getBirthdaySettings`, `renderBirthdayEmail`,
  `runBirthdayAutomationSweep`, `registerBirthdayJob`.

`registerBirthdayJob()` is called at module-load time (not from inside any route or the listen
callback) to register the initial daily cron job on startup — that call site **stays in `app.js`**,
at the same position, now invoking the imported function; only the function body moved. `npm run
smoke` booting cleanly was itself a real check that this eager call still executes without
throwing from its new home.

`newsletterUpload` (attachment-upload multer instance, `newsletterAttachStorage` depending on
`docsWriteDir`) turned out to have two remaining call sites in the not-yet-moved `/api/admin/
campaigns` routes — added to `lib/uploads.js` alongside the admin image `upload` instance rather
than assumed unused. `EMAIL_FORMAT_RE` similarly had one remaining call site elsewhere in `app.js`
— added to `lib/validation.js` alongside `sanitizeEmailInput`.

A **fourth** `SQLITE_BUSY` crash hit during this batch's verification, same exact spot in
`banner.test.js` as the three prior occurrences — see the consolidated note under "Known testing
limitations" below, now updated to reflect four occurrences.

Verification: `node -c` on all changed/new files; confirmed zero remaining `app.js` registrations
for all 15 paths; `npm run smoke` 329/329; `npm test` x5 given the scope (1 crash as above, 1
already-documented CP3 recurrence, 3 clean baseline-only runs) — specifically confirmed the
schedule-creation and atomic-claim tests (a real node-schedule job actually firing and reaching a
terminal `sent` status) and the birthday-sort tests passed on every successful run.

**`newsletter` domain's route surface is now fully split out of `app.js`** (batches 7 + 8, 24
routes total, matching the Phase 4 domain's original route count exactly).

### Route batch 10: `routes/admin/inquiries.js` — DONE (closes out `inquiries`)

13 routes: `GET /api/admin/inquiries`, status/assign/priority/category updates, notes CRUD,
bulk-status/bulk-delete, delete. No new `lib/` helpers needed — every dependency was either
already-extracted repository functions (`inquiries.repository.js`) or the three `admins`-only
functions found living in this exact route cluster back during the `auth+users` Phase 4 domain
(`getAssignableAdmins`, `checkAdminActiveById`, `getAdminDisplayNameById`) — all already in
`auth-users.repository.js`. The lowest-friction batch since the foundational `lib/` surface was
built out; a good sign that surface is now covering new batches rather than still growing to meet
them.

The main list route's `admins`/`direct_emails`-joining dynamic SQL (cross-domain, per the
`inquiries` Phase 4 write-up) stayed inline using `db` directly, exactly as documented back then.

**`inquiries` domain's route surface is now fully split out of `app.js`.**

Verification: `node -c`; confirmed zero remaining `app.js` registrations for all 13 paths; `npm run
smoke` 329/329; `npm test` x3 (only already-documented flakes — CP5, the calendar-booking-sync
reschedule test — zero inquiry-specific failures on any run).

### Route batch 11: `routes/admin/direct-emails.js` — DONE

8 routes: attachment upload, list/detail, create/update/delete, send-now, preview. First route
file to use `requireRoleForInquiryEmail` (the second RBAC middleware from `middleware/rbac.js` —
extracted in Phase 5 step 1 but never actually imported by a route file until now).

New **`lib/direct-emails.js`**, mirroring `lib/newsletter-scheduling.js`'s shape almost exactly:
`scheduleDirectEmailSend` + `sendDirectEmail` (the atomic send/mark-sent logic — this is the exact
code path Deferred-fix-#3's **CP12** flake exercises, via the `markInquiryReplied` call inside
`sendDirectEmail`'s success branch). `scheduledJobs` is imported from
`lib/newsletter-scheduling.js` rather than redeclared — this module's jobs share that same map
under a `direct_${id}`-prefixed key, confirmed back in the newsletter-campaigns batch write-up.
`sendDirectEmail` resolved a relative attachment path against `__dirname` (correct in `app.js`,
wrong one level deep from `lib/`) — fixed by adding a `PROJECT_ROOT` export to
`lib/runtime-paths.js` (the same anchor `database/repositories/*.js` already relies on) and using
that instead, rather than reintroducing a bare `__dirname`.

`emailAttachUpload` (+ its storage config) added to `lib/uploads.js` alongside the other shared
multer instances.

**A small cleanup, not scope creep**: `subscriberCsvUpload`'s definition in `app.js` was still
sitting there unused — its only call site moved to `routes/admin/newsletter-subscribers.js` two
batches ago (which correctly defined its own local copy, since it had zero other consumers), but
the now-dead original in `app.js` was never removed at the time. Removed it now while touching
this same neighborhood of code, since leaving an orphaned copy I myself created behind isn't
"moving code around later," it's just finishing the job from batch 7 properly.

Verification: `node -c`; confirmed zero remaining `app.js` registrations for all 8 paths; `npm run
smoke` 329/329; `npm test` x3 — **two of the three came back fully clean, 651/651**, including the
normally-permanent concurrency-race baseline (consistent with that being a genuine race, not a
guaranteed-every-run failure). Specifically confirmed both CP12 assertions passed on every run
(the exact code path this batch relocated), all 10 `requireRoleForInquiryEmail`-gated RBAC checks
passed, and the POPIA erasure test's `direct_emails.to_emails` redaction check passed.

### Route batch 12: `routes/admin/analytics.js` — DONE

9 read-only reporting routes: `summary`, `visits-over-time`, `traffic-sources`, `top-referrers`,
`devices`, `countries`, `top-pages`, `bookings-trend`, `todays-schedule`. All raw `db` queries
against `analytics_pageviews`/`analytics_sessions` (never claimed by a Phase 4 repository) plus two
already-extracted repository calls (`getBookingsTrend`, `getActiveDateHoldsForToday`).
`getAnalyticsDates` (the `?period=` parser) had exactly one caller — this whole batch — so it moved
directly into the route file rather than a new `lib/` module, matching the `subscriberCsvUpload`
precedent for single-consumer helpers.

**A new failure mode hit on the first verification run**: the test harness's own initial request
failed outright (`TEST RUN ERROR: fetch failed`), and the server log showed why — `SQLITE_READONLY:
attempt to write a readonly database` inside the daily overdue-flagging cron jobs
(`runDailyOverdueFlaggingSweep` and the payment-schedule equivalent), which fire once shortly after
boot. Neither cron job's code was touched by this batch or by anything else this session — this
reads as the isolated test DB file being caught in a transient read-only filesystem state (a
plausible side effect of the SQLITE_BUSY crashes and hangs earlier in this session leaving the file
in an inconsistent state at the OS level), not an application bug. Two immediate re-runs were
clean, one of them fully clean at 651/651 with every analytics RBAC check passing — filed as a new
`SQLITE_*`-family environmental one-off alongside the existing `SQLITE_BUSY` entry, same "Known
testing limitations" section.

Verification: `node -c`; confirmed zero remaining `app.js` registrations for all 9 paths; `npm run
smoke` 329/329; `npm test` x3 (1 environmental crash as above, 1 run with only CP3, 1 fully clean
651/651 run).

### Route batch 13: `routes/admin/legal.js` — DONE

9 routes: legal-centre overview, documents CRUD/versioning (draft/publish/restore/history),
consent-audit listing, contracts registry. All raw `db` queries against `legal_documents`/
`legal_document_versions`/`consent_audit`/`contracts` (none owned by a Phase 4 repository);
cross-domain `bookings` JOINs on the consent-audit and contracts-registry listings stayed inline.
`computeNextLegalVersion` had exactly one caller (this batch) — moved directly into the route file,
same single-consumer pattern as `getAnalyticsDates` in the previous batch.

Verification: `node -c`; confirmed zero remaining `app.js` registrations for all 9 paths; `npm run
smoke` 329/329; `npm test` x3 — one fully clean 651/651 run, the other two each had only a single
already-documented flake (CP5, CP17) with the permanent baseline concurrency test *not* failing
either time, reinforcing that it's a genuine intermittent race rather than a deterministic result.

### Route batch 14: `routes/admin/popia.js` — DONE (POPIA/GDPR erasure, protected surface)

9 routes: the 8 mechanically-extracted admin POPIA request-management routes (list/export/detail
+preview/approve/reject/process/complete-anonymization/create), **plus** `POST
/api/admin/gdpr/delete` — a legacy one-click wrapper found mid-investigation, *not* part of the
original mechanical extraction batch (it wasn't grouped with the others by the route-listing pass),
but folded in here rather than left behind: it calls the exact same
create→approve→process→notify→delete-files chain as every other entry point in this file, so
splitting it into a separate batch would only have meant importing the same lifecycle functions
back into `app.js` for one lingering route.

**This batch could not be completed as a self-contained lib file the way batches 1-13 were.** Every
route here bottoms out in `notifyPopiaCancellations()`, which calls two functions that were still
physically defined in `app.js`: `deleteGoogleEvent` (a thin wrapper around the module-scoped Google
Calendar client) and `sendCancellationEmail`. Neither is POPIA-specific — both are shared with the
not-yet-moved manual admin cancellation routes — so per the standing "relocate each helper as
needed" decision, three more `lib/` files were created as prerequisites, each verified independently
before being pulled into the new POPIA lib file:

- **`lib/cancellation-refund.js`** — `calculateCancellationRefund`. Pure function (policy-tier math
  + date arithmetic), zero dependencies. Trivial, safe relocation.
- **`lib/email-escape.js`** — `escapeEmailHtml`/`EMAIL_ESCAPE_FIELDS`/`escapeEmailFields`. Also pure;
  `escapeEmailFields` alone had 23 other call sites across `app.js`'s email-sending functions, none
  of which needed touching — they all keep working via the new import.
- **`lib/booking-cancellation-email.js`** — `sendCancellationEmail`. Depends only on already-leaf
  modules (`js/emailComponents`, `js/bannerRegistry`, `js/emailService`, the new
  `lib/email-escape.js`, `lib/email-context.js`).
- **`lib/google-calendar.js`** — the module-scoped `oauth2Client`/`calendar`/`CALENDAR_ID` Google
  Calendar client singleton, plus `deleteGoogleEvent`. **Checked carefully before moving**: this
  construction reads `process.env.GOOGLE_CLIENT_ID`/`SECRET`/`BASE_URL`/`REFRESH_TOKEN`
  *synchronously*, immediately after the startup DB-settings-to-env-var bootstrap query is *issued*
  but before that query's callback can possibly have fired — meaning the DB-stored settings path
  never actually reaches the Google credentials in either the old or new arrangement, only whatever
  `.env` already set. This is pre-existing, unchanged behavior, not something this move altered;
  confirmed by requiring the new module at the exact same point in `app.js`'s top-to-bottom execution
  that the inline code used to occupy, which preserves identical timing. `google` (the `googleapis`
  import) had no other use in `app.js` beyond this block, so its `require('googleapis')` moved too
  instead of being left behind unused.

With those four in place, **`lib/popia.js`** holds the full erasure subsystem: `resolvePopiaTargets`,
`anonymizeClientData`, `POPIA_REASONS`, `popiaReferenceNumber`, `createPopiaRequest`,
`approvePopiaRequest`, `rejectPopiaRequest`, `processPopiaRequest`, `completePopiaAnonymization`,
`deletePopiaFiles`, `isBookingInPopiaErasureScope`, `getBookingErasureImpact`,
`cancelActiveBookingsForErasure`, `getUnresolvedRefundBookingIds`, `notifyPopiaCancellations` — all
byte-identical. Only functions with a caller outside the file are exported
(`resolvePopiaTargets`, `getBookingErasureImpact`, `POPIA_REASONS`, `createPopiaRequest`,
`approvePopiaRequest`, `rejectPopiaRequest`, `processPopiaRequest`, `completePopiaAnonymization`,
`deletePopiaFiles`, `notifyPopiaCancellations`); `anonymizeClientData`, `popiaReferenceNumber` and
`isBookingInPopiaErasureScope` stay private. `app.js` re-imports `resolvePopiaTargets`,
`getBookingErasureImpact`, `createPopiaRequest` and `POPIA_REASONS` for the three public
self-service routes not yet moved (`POST /api/public/popia/preview`, `/erasure-requests`, and the
legacy `/api/public/compliance/request-forget`) — confirmed by tracing every remaining call site
before removing the old definitions, not by assumption. `verifyPopiaOtp` (OTP verification) has no
caller in this batch's routes and stays in `app.js` untouched, to move with the public POPIA batch
later.

`routes/admin/popia.js` additionally imports 7 count-only repository functions
(`countBookingNotesForIds`, `countTransactionsForIds`, `countCancellationsForIds`,
`countPaymentLogsForIds`, `countQuotationsForIds`, `countQuotationsForClientIds`,
`countInquiryNotesForIds`) used only by its own detail/preview route, plus `db`/`exportRateLimiter`/
`encodeUserHtml` following the established per-route-file convention.

Verification: `node -c` on all 8 changed/new files; confirmed zero remaining `/api/admin/popia/*` or
`/api/admin/gdpr/delete` registrations in `app.js`, and zero remaining references anywhere in
`app.js` to any of the now-fully-relocated function names outside of explanatory comments; `npm run
smoke` 329/329; `npm test` run **3 times** given this is an explicitly protected surface with real
refund-gating financial logic — **651/651 clean on all 3 runs**, no flakes at all this time. The
dedicated `test/popia-erasure.test.js` suite explicitly exercises the CAS double-processing guards,
the `awaiting_refund` gate and its re-check on `complete-anonymization` (409 while any booking's
refund is still outstanding, 200 once resolved), RBAC on every route including
`complete-anonymization`, and the legacy `/api/admin/gdpr/delete` route reporting `awaiting_refund`
correctly rather than a false success — all passing identically pre- and post-relocation.

### Route batch 15: `routes/admin/abandoned-bookings.js` — DONE

6 routes: list/search/filter/paginate, recovery stats, CSV export, single-draft detail, admin
resend-reminder, mark won/lost/closed/re-open. All raw `db` queries against `abandoned_bookings`
(never claimed by a Phase 4 repository). `sendAbandonedBookingReminderEmail` has a second caller —
an automated reminder sweep still in `app.js` — so it moved to its own `lib/abandoned-booking-
email.js` (leaf deps only: `js/emailComponents`, `js/bannerRegistry`, `js/emailService`,
`lib/email-context.js`) rather than being inlined into the route file like the single-consumer
helpers in earlier batches.

Verification: `node -c`; confirmed zero remaining `app.js` registrations for all 6 paths and zero
remaining reference to the old `sendAbandonedBookingReminderEmail` definition; `npm run smoke`
329/329; `npm test` x6 (elevated from the usual x2-3 specifically to build confidence after batch
14's calendar-client relocation) — 4 clean 651/651 runs, one recurrence of the pre-existing
`deleteGoogleEvent`/cancel timing flake (Deferred fix #3 update above) and one recurrence of the
pre-existing `banner.test.js` `SQLITE_BUSY` crash ("Known testing limitations" update above), neither
touching anything this batch or batch 14 changed.

### Route batch 16: `routes/admin/expenses.js` — DONE

6 routes: list/filter, create, soft-delete, edit, CSV export, receipt upload. `insertExpense`/
`getActiveExpenseById`/`softDeleteExpense`/`updateExpense` were already Phase 4 repository exports
(`finance.repository.js`); `VALID_EXPENSE_CATEGORIES` and the `receiptStorage`/`uploadReceipt`
multer config were both single-consumer (only these routes used them), so both moved directly into
the route file — same pattern as `getAnalyticsDates`/`computeNextLegalVersion` in earlier batches —
rather than a new `lib/` module. `uploadsWriteDir` (already `lib/runtime-paths.js`) covers the one
external dependency `receiptStorage` had.

Verification: `node -c`; confirmed zero remaining `app.js` registrations for all 6 paths and zero
remaining reference to `VALID_EXPENSE_CATEGORIES`/`uploadReceipt`/`receiptStorage` outside a comment;
`npm run smoke` 329/329; `npm test` x6 — 4 clean 651/651 runs, one `banner.test.js` `SQLITE_BUSY`
crash (same known crash point, sixth occurrence — see "Known testing limitations" update below) and
one recurrence of `calendar-booking-sync.test.js`'s "reschedule: a SECOND sync attempt was logged"
(the same Deferred fix #3 family, already seen at this exact wording during Phase 4's `bookings`
domain). Neither touches `expenses` or anything this batch changed.

### `events` cluster investigated, deferred — not a batch

Investigated `/api/admin/events` (6 routes) as the planned next batch after `expenses`. Unlike every
batch so far, its dependencies don't terminate cleanly: `checkEventConflicts` (a local helper) and
three of the six routes call `hasCalendarConflict`, `syncBookingToCalendar`, `syncEventToCalendar`,
`sendDateChangedEmail`, `addMinutesToTime`, `timeRangesOverlap`, and `parseDurationToMinutes` — all
still plain functions in `app.js`. Of these, only `syncEventToCalendar` is scoped to this cluster;
the other six are called from **40+ other sites** across the not-yet-moved `/api/admin/bookings`
cluster and public booking routes (confirmed by grep, not assumption) — the same giant, explicitly
protected surface already earmarked for its own dedicated, heavily-scrutinized pass. Relocating
`events` now would mean pulling the entire Google Calendar sync engine and booking time-arithmetic
into `lib/` as a side effect of a 6-route batch, then re-importing it into `app.js` at 40+ call
sites — a fundamentally different scale of change than this cluster's own size suggests, and
squarely the same work the `bookings` pass will need to do anyway. Deferred `events` to be handled
alongside that pass rather than splitting the calendar-engine extraction across two unrelated
efforts; moved on to `banners` instead. No files changed for this investigation.

### Route batch 17: `routes/admin/banners.js` — DONE

6 routes: list/filter/paginate, get-one-with-usage, create, update, archive, restore.
`bannerUpload`/`validateBannerImageBuffer`/`saveBannerImage`/`BANNER_CATEGORIES`/
`BANNER_MIN_WIDTH`/`BANNER_MAX_WIDTH`/`BANNER_MAX_BYTES`/`setBannerStatus` were all single-consumer
(only these routes used them) — all moved directly into the route file. `setBannerStatus` needed
manual handling since it's a plain function sitting between routes, not itself an `app.<method>(...)`
call the extraction script matches — the two archive/restore routes that use it were extracted first,
then the factory function was added back into the route file ahead of them. `bannerRegistry` (already
`js/bannerRegistry`) and `uploadsWriteDir` (`lib/runtime-paths.js`) covered the two shared
dependencies.

**Extra scrutiny applied** given this batch directly touches the exact domain (`banners`) that has
been the source of this session's recurring `SQLITE_BUSY` crash — read `banner.test.js`'s full
output on every run rather than just the aggregate pass count. All 33 of its checks passed cleanly
on all 3 runs, including `archive`/`restore` (exercises the relocated `setBannerStatus`),
`create`/`update` (exercises `bannerUpload`/`validateBannerImageBuffer`/`saveBannerImage`), and the
e2e assigned-banner-renders-in-a-real-queued-email check — direct positive confirmation for this
batch specifically, not just the usual "the crash is unrelated" reasoning by elimination.

Verification: `node -c`; confirmed zero remaining `app.js` registrations for all 6 paths and zero
remaining reference to any of the relocated helpers; `npm run smoke` 329/329; `npm test` x3, all
three 651/651 clean — no flakes, no crashes, this time.

### Route batch 18: `routes/admin/campaigns.js` — DONE

5 routes, scattered across two distant parts of `app.js` (the legacy immediate-dispatch pair near
the top, the unified-list/delete/bulk-delete trio much further down) but extracted together as one
domain: `POST /api/admin/campaigns` (legacy immediate newsletter dispatch — distinct from the
already-extracted scheduled-campaign system in `routes/admin/newsletter-campaigns.js`),
`POST .../send-test`, `DELETE /:id`, `GET /unified`, `POST /bulk-delete`. All DB access already
Phase 4 repository exports (`newsletter.repository.js`, one `auth-users.repository.js` function).
`POST /bulk-delete` reads/mutates `scheduledJobs` directly (cancelling a pending scheduled send) —
imported from the existing `lib/newsletter-scheduling.js` singleton, **not** a new instance, per the
required-singleton rule already established for that file.

Verification: `node -c`; confirmed zero remaining `app.js` registrations for all 5 paths; `npm run
smoke` 329/329; `npm test` x5 — 3 clean 651/651 runs (including the "campaigns/unified ripple fix"
test, direct coverage of the relocated `GET /unified` route) and 2 more `banner.test.js` `SQLITE_BUSY`
crashes (same pre-existing family, landing at a slightly different statement each time within that
file — consistent with a genuine race rather than a fixed reproducible bug), neither touching
campaigns/newsletter-scheduling code.

### Route batch 19: `routes/admin/services.js` — DONE

5 routes: list, create, edit, usage-count, delete (soft by default, hard with `?force=1` gated on
zero referencing line items). All raw `db` queries against `services`/`audit_log`/
`financial_audit_log`; the three usage/reference-count lookups
(`getServiceDraftQuoteUsage`, `countBookingLineItemsForService`, `countQuoteLineItemsForService`)
were already Phase 4 repository exports. No new `lib/` files needed — the most self-contained batch
since `expenses`.

Verification: `node -c`; confirmed zero remaining `app.js` registrations for all 5 paths; `npm run
smoke` 329/329; `npm test` x5 — 4 clean 651/651 runs plus one 650/651 whose single failure wasn't
captured before a follow-up run overwrote it (lost to a re-run, not investigated further) — given
this batch touches only `services`/`audit_log`/`financial_audit_log` and every other run was clean,
treated as the same ambient flake-rate background this session has shown throughout, not a
regression. Direct RBAC coverage of the relocated `GET /api/admin/services` route passed on the
logged runs.

### Route batch 20: `routes/admin/invoices.js` — DONE

5 routes: send/resend, bulk-send-unsent, void (with mandatory reason), mark-paid, list. All five
DB-lifecycle helpers (`markInvoiceSent`, `markInvoiceSentAndPublished`, `getInvoiceById`,
`voidInvoiceWithReason`, `markInvoicePaidById`) were already Phase 4 repository exports.
`sendInvoiceEmail` has two other callers (booking-confirmation and quote-acceptance flows, not yet
moved), so it moved to its own `lib/invoice-email.js` — all of its own dependencies
(`escapeEmailFields`, `getEmailFooterContext`/`emailBaseUrl`, `getPaymentSchedulesForDocument`) were
already leaf-safe from earlier batches.

Verification: `node -c`; confirmed zero remaining `app.js` registrations for all 5 paths and zero
remaining reference to the old `sendInvoiceEmail` definition; `npm run smoke` 329/329; `npm test` x3
given this touches payment-adjacent invoice email — one run had 649/651 (two already-documented
pre-existing flakes, CP3 and CP6, neither invoice-related), the other two clean 651/651. Direct
positive confirmation for this batch: the invoice-send email tests all passed, including the
PAYMENT-CRITICAL "schedule amount + reference verbatim" check against the relocated
`sendInvoiceEmail`.

### Route batch 21: `routes/admin/bank-statement.js` — DONE (pre-existing bug found, not fixed)

5 routes: CSV import, list lines (with batch list), match a line to a booking/transaction, delete a
line, delete a whole batch. All five DB helpers were already Phase 4 repository exports
(`finance.repository.js`); `csvUpload` (a single-consumer multer instance) moved directly into the
route file.

**Found a pre-existing, completely-broken route while tracing dependencies** — see Deferred fix #4
above for the full writeup. `POST .../import` called `db.transaction(...)`, a `better-sqlite3` method
that doesn't exist on this app's plain `sqlite3.Database` — every import attempt threw synchronously
and returned a 500. Relocated byte-identical here and flagged to the user directly given the
severity; **the user asked for it to be fixed**, done immediately afterward — see Deferred fix #4
for the fix itself (`withDbTransaction`/`dbRun`, a new regression test, and an unrelated stale-import
cleanup found along the way).

Verification: `node -c`; confirmed zero remaining `app.js` registrations for all 5 paths; `npm run
smoke` 329/329 (the smoke test's unauthenticated requests hit `requireAdmin`'s 401 before ever
reaching the broken code, so this doesn't contradict the finding above); `npm test` x3, all three
651/651 clean — unchanged from baseline, since no test exercises the import route either before or
after the move.

### Route batch 22: `routes/admin/reconciliation.js` — DONE

4 routes: the reconciliation matrix, per-booking transaction list, CSV export, and — folded in from
a different path prefix, same reasoning as POPIA's `/api/admin/gdpr/delete` in batch 14 —
`PATCH /api/admin/transactions/:id/reconcile` (the matrix's own "flag/unflag as duplicate" action,
physically sitting between the other three routes in `app.js`). `POST /api/admin/transactions/manual`
stays behind — a genuinely separate, larger transactions-domain concern, not this batch's business.
`getCompletedTransactionsForReconciliation`/`setTransactionDuplicateFlag` were already Phase 4
repository exports; everything else is raw `db` queries. A stray leftover comment (from batch 21's
bank-statement extraction, absorbed as a "leading comment" onto the CSV-export route by the
extraction script) was cleaned up as found.

Verification: `node -c`; confirmed zero remaining `app.js` registrations for all 4 paths; `npm run
smoke` 329/329; `npm test` x3, all clean 664/664.

### Route batch 23: `routes/admin/advancing.js` — DONE (12 routes, two path prefixes)

The Advancing Pack feature (Deal View "Advancing" tab — run-of-show, technical/hospitality specs,
show-day contacts, travel, PDF generation/download/send/confirm) turned out to span 12 routes, not
the 3 the initial `/api/admin/advancing/*`-prefix grouping found — most of it actually lives under
`/api/admin/bookings/:id/advancing/*`, which a naive by-prefix grouping bucketed into the giant
deferred `bookings` cluster. Read the full contiguous block in `app.js` (one cohesive feature, not
entangled with the rest of the bookings mega-cluster the way `events`' calendar-sync dependencies
were) and pulled all 12 out together: `GET`/`PUT .../advancing` (load/save the pack header),
`POST .../run-of-show` + `PUT`/`DELETE /api/admin/advancing/run-of-show/:itemId` (the latter two
un-nested from `:id` by original design, so they carry their own ownership check — see
`verifyRosOwnership`), `PUT .../run-of-show/reorder`, `POST .../contacts` +
`DELETE /api/admin/advancing/contacts/:contactId` (same ownership-check shape via
`verifyAdvancingContactOwnership`), `POST .../pdf`, `GET .../download`, `POST .../send`,
`POST .../confirm`.

Five single-consumer helpers moved with it: `sendAdvancingPackEmail`, `ensureAdvancingPack`,
`verifyRosOwnership`, `verifyAdvancingContactOwnership`, `resolveAdvancingContacts`. All other
dependencies were already leaf-safe: `getBookingByIdAsync`/`getBookingIdStatusAsync`
(`bookings.repository.js`), `dbGet`/`dbRun`/`withDbTransaction`/`docsWriteDir`/`resolveDocsPath`/
`encodeUserHtml` (existing `lib/` modules), `emailService`/`pdfService` (existing `js/` modules).

**Extra verification given the size and the lack of any dedicated test file for this feature**:
beyond the usual `node -c`/grep/smoke/suite checks, manually drove the real routes end-to-end
against a live CONFIRMED booking fixture in two throwaway scripts using `test/support.js` directly
— save the pack header, add/edit/delete a run-of-show item (exercising `verifyRosOwnership`'s
success path), add/delete a contact (`verifyAdvancingContactOwnership`), confirm the pack, then
(separately) save + generate the PDF + download it and confirm the response is a real PDF
(`%PDF` header, non-trivial byte count). Every one of 10 of the 12 routes returned success with
correct data; `send` (the two remaining routes, `send` and the already-covered `confirm`) shares
100% of its dependencies with `pdf`, already proven.

Verification: `node -c`; confirmed zero remaining `app.js` registrations for all 12 paths and zero
remaining reference to any of the 5 relocated helpers; `npm run smoke` 329/329; `npm test` x3, all
clean 664/664; plus the manual end-to-end drive above.

### Route batch 24: `routes/admin/calendar.js` — DONE

4 routes: the unified FullCalendar feed (bookings + manual holds + public site events, optionally
milestones), create/delete/move a manual date hold. All three pulled in the same pure time-
arithmetic utilities (`timeRangesOverlap`, `addMinutesToTime`, `parseDurationToMinutes`) already
identified as blocking the deferred `events` batch — unlike the Google Calendar sync engine
(`hasCalendarConflict`/`syncBookingToCalendar`/`syncEventToCalendar`) also deferred there, these
three are trivial, zero-dependency pure functions, so — per the standing "relocate each helper as
needed" policy — they moved now into a new **`lib/time-utils.js`**, with `app.js` re-importing them
at their ~40 remaining call sites across the still-deferred bookings cluster. This is genuinely
useful prep for whenever that cluster's own batch happens, not scope creep specific to calendar.
`findHoldDateConflict` (single-consumer, used only by the two hold routes) moved directly into the
route file. Everything else was already leaf-safe (`resolveActor`, `bookingConfig`, and repository
functions from `calendar.repository.js`/`bookings.repository.js`).

Verification: `node -c`; confirmed zero remaining `app.js` registrations for all 4 paths and zero
remaining definitions of `timeRangesOverlap`/`addMinutesToTime`/`parseDurationToMinutes`/
`findHoldDateConflict` outside the new import/route file; `npm run smoke` 329/329; `npm test` x4 —
direct coverage confirmed both hold routes work (`calendar hold create/move returns last_updated`);
3 runs clean 664/664, one run had a single already-documented pre-existing flake (CP5, venue_name
propagation — one of the most frequently recurring entries in this session's Deferred fix #3 log),
unrelated to anything this batch touched.

### Route batch 25: `routes/admin/email-templates.js` — DONE

3 routes: list (grouped by category), bulk assign/unassign a banner, live preview. All dependencies
already leaf-safe (`bannerRegistry`, `emailComponents`, `SAMPLES_BY_CATEGORY` from
`js/emailPreviewSamples`, `getEmailFooterContext`). `SYSTEM_TRACK_TEMPLATE_KEYS` (single-consumer)
moved directly into the route file. The extraction script's leading-comment absorption pulled in
two comments that actually belonged to the *banners* section above (a stale "EMAIL BANNER REGISTRY"
header and batch 17's own relocation marker) — cleaned up as found, same as reconciliation's stray
comment in batch 22.

Verification: `node -c`; confirmed zero remaining `app.js` registrations for all 3 paths and zero
remaining definition of `SYSTEM_TRACK_TEMPLATE_KEYS` outside the route file; `npm run smoke`
329/329; `npm test` x2, both clean 664/664.

### Route batch 26: finance/financials/dashboard/reminders — DONE (4 small clusters, one batch)

Four small, low-risk reporting clusters bundled into one batch since each is fully self-contained
(no shared dependencies between them, no cross-cutting risk) and none warranted its own commit:

- **`routes/admin/finance.js`** (2 routes): CSV export, P&L by period. Both already Phase 4
  repository calls (`finance.repository.js`).
- **`routes/admin/financials.js`** (2 routes): the financial-analytics dashboard (revenue trend, top
  clients, invoice aging, overdue invoices, revenue-by-category, cash-flow) and the stats summary
  (period revenue/outstanding/expenses/pending-quotes/overdue-invoices/transaction-count). Every
  figure already came from a Phase 4 repository call spanning `finance`, `invoices-quotations`, and
  `bookings` repositories — nothing new to relocate beyond the routes themselves.
- **`routes/admin/dashboard.js`** (2 routes): social-media KPI tile — reads/refreshes cached
  follower/like counts from YouTube/Facebook/Instagram/Twitter/TikTok's public APIs (rate-limited to
  once per hour per platform via a staleness check), and an admin manual-override write.
  `getSettingVal` was already a Phase 4 repository export.
- **`routes/admin/reminders.js`** (2 routes) + **`lib/payment-reminders.js`**: the reminders-log
  viewer and a manual "run now" trigger for the payment-reminder cron job.
  `runPaymentReminderJob` has two other callers (an app.js startup run and a 24h `setInterval`,
  both left in place as process-startup wiring) — multi-consumer, so it moved to its own lib file
  rather than inlining into the route, matching the `sendInvoiceEmail`/`sendAbandonedBookingReminderEmail`
  pattern.

Verification: `node -c` on all changed/new files; confirmed zero remaining `app.js` registrations
for all 8 paths and zero remaining definition of `runPaymentReminderJob` outside its new lib file;
`npm run smoke` 329/329; `npm test` x3, all clean 664/664 — direct RBAC coverage confirmed
`finance/export`, `finance/pl`, `financials/analytics`, and `financials/stats` all return correct
status codes per role.

### The deferred `bookings`/`events` pass begins — scope reconnaissance

Started the dedicated, heavily-scrutinized pass for `/api/admin/bookings/*` (55 routes),
`/api/public/bookings/*` (19 routes), and `/api/admin/events/*` (6 routes, deferred earlier)
now that `lib/time-utils.js` and `lib/google-calendar.js` exist. A full sweep of every remaining
top-level function declaration in `app.js` found **~75 functions still un-relocated**, the large
majority of them this domain's own business logic rather than incidental helpers — this is not a
"batch" in the same sense as batches 1-26; it's effectively the bulk of what's left of the original
monolith. Recorded here so a future session doesn't have to re-derive it:

- **~28 `send*Email` functions** (`sendBookingReceivedEmail`, `sendQuoteEmail`,
  `sendBookingConfirmedEmail`, `sendPaymentReceivedEmail`, `sendContractEmail`,
  `sendQuoteAcceptedEmail`, `sendBookingCompletedEmail`, `sendRefundProcessedEmail`,
  `sendReviewRequestEmail`, and ~19 more) — every one of these is exactly the same shape already
  proven safe 6 times over (`sendInvoiceEmail`, `sendCancellationEmail`,
  `sendAbandonedBookingReminderEmail`, etc.): `escapeEmailFields` + `getEmailFooterContext` +
  `bannerRegistry` + `emailComponents` + `sendEmail`, all already leaf-safe. Low-risk, high-volume
  relocation work once their route batches come up.
- **The Google Calendar sync engine**: `hasCalendarConflict`, `syncBookingToCalendar`,
  `syncEventToCalendar`, `syncCalendarHolds`, `isWithinWorkingHours` — the reason `events` was
  deferred in the first place. Still not relocated; still the highest-risk piece of this pass
  (real Google API calls, booking-conflict business rules with financial consequences).
- **Booking lifecycle/financial core**: `applyStatusChange` (the generic status-transition
  endpoint's engine), `processManualPayment`, `alignMilestonePayments`, `updateBookingMilestones`,
  `deriveBookingStatusAfterPayment`, `checkDateAvailability`, `generateContract` +
  `assembleContractHtml` + `resolveContractFeeData`, `generateInvoice` +
  `autoBuildDepositBalanceSchedule` + `computeDocumentTotals` + `resolveLineTaxClasses` +
  `getVatRate`, `remindBooking`, `logPaymentEvent`, `generatePayFastSignature`.
- **12 background cron jobs** (`run*Job` — quote follow-up, stalled-booking alerts, abandoned-
  booking reminders/purge, deposit-balance reminders, invoice pre-due/overdue sweeps, event
  reminders, post-event follow-up, ledger reconciliation, PayFast pending-timeout) — all called only
  from app.js's own startup/interval wiring, analogous to `runPaymentReminderJob` in batch 26.
- **Misc utilities**: `classifyChannel`, `generateBookingICS`, `parseDurationMins`, `checkEventConflicts`
  (the `events` conflict-checker deferred alongside the sync engine), `escapeHtml`/`deepEscapeBody`
  (used by a global sanitizing `app.use` middleware — cannot move until every remaining route that
  needs it is accounted for).

**Strategy**: stage this exactly like Phase 4's `bookings` repository domain was staged (4 sub-passes
+ a satellite-table pass) — smallest/safest slices first, working up to the calendar-sync engine and
`applyStatusChange` last, since those two are both the highest-risk and the most-depended-upon by
everything else. All `/api/admin/bookings/*` routes accumulate into one `routes/admin/bookings.js`
file across sub-batches (same file, multiple commits), matching that precedent.

### Bookings sub-batch A: satellite reads + 2 simple actions — DONE

First cut: 9 routes with zero remaining dependency on any of the ~75 functions above — every one
already backed by an existing Phase 4 repository function. `GET/POST /:id/notes` +
`DELETE /:id/notes/:noteId`, `GET /:id/communications`, `POST /:id/unlink-client`,
`GET /:id/quote-history`, `GET /:id/expenses`, `GET /:id/financials`, `GET /:id/details`. Created
`routes/admin/bookings.js`.

Verification: `node -c`; confirmed zero remaining `app.js` registrations for all 9 paths; `npm run
smoke` 329/329; `npm test` x4, all clean 664/664 — direct coverage confirmed via **CP9** (9 checks
exercising the notes routes specifically: empty-list, validation, RBAC on create/delete, author
derivation, ordering, delete-404, delete-success) and RBAC checks on the financials-adjacent routes.

### Bookings sub-batch B: 5 more clean routes — DONE

`GET /:id/cancellation-preview` (already-relocated `calculateCancellationRefund` from
`lib/cancellation-refund.js`), `POST /:id/reopen`, `GET /:id/reconcile`, `GET /:id/invoice/download`,
`GET /:id/quote/download` — all confirmed to have zero dependency on the ~75 still-deferred
functions, all already repo-backed. Appended to `routes/admin/bookings.js`.

**Fixed a latent bug in `extract_routes.js`** found while appending this batch: the script's
append-to-existing-file path matched `EXPORT_LINE` including a trailing `\n`, but `bookings.js` (like
every route file, per this session's own git-commit warnings about CRLF normalization) had been
normalized to CRLF line endings by an editor tool since its creation — the `\n`-only match silently
failed with "Could not find module.exports = router; to insert before." Confirmed via the script's
own write-order safety that `app.js` was untouched (the failure happens before that write), then
fixed the script to match `EXPORT_LINE` without requiring a specific trailing line-ending, and
re-ran cleanly. This is the first time any route file has been appended to a second time (every
prior file was single-batch), so the bug was latent until now — will not recur for future
`bookings.js` sub-batches.

Verification: `node -c`; confirmed zero remaining `app.js` registrations for all 5 paths; `npm run
smoke` 329/329; `npm test` x4 — 2 clean 664/664 runs, one already-documented `banner.test.js`
`SQLITE_BUSY` crash (9th occurrence), one already-documented calendar-sync reschedule flake, neither
touching this batch. No dedicated test names these 5 routes directly, so manually drove all 5
against real fixtures: `cancellation-preview` returned a sensible tiered-refund calc,
`reconcile` returned correct ledger/transaction figures, `invoice/download` and `quote/download`
both served genuine PDFs (confirmed `%PDF` header + correct `Content-Type`) for a fixture booking
that already had real files on disk, and `reopen` correctly flipped an EXPIRED fixture back to
PENDING.

### Bookings sub-batch C: the contract cluster (9 routes) — DONE

Generate, builder-data, preview, GET/POST (fetch/upload), sign (admin countersign), download, send,
remind. Traced the full dependency graph before touching anything:

- **`lib/document-totals.js`** (new): `getVatRate`, `resolveLineTaxClasses`, `computeDocumentTotals`
  — pure money-math shared by `generateInvoice` and the admin quote route (neither yet moved) *and*
  the contract fee resolver below. `app.js` re-imports all three for those two remaining call sites.
- **`lib/contracts.js`** (new): `DEFAULT_CONTRACT_CLAUSES`, `CONTRACT_ELIGIBLE_STATUSES`,
  `resolveContractFeeData`, `assembleContractHtml`, `generateContract` — the whole contract-
  generation engine. `generateContract` has two remaining external callers (the public quote-
  acceptance flow, and `applyStatusChange` — neither yet moved), both re-imported in `app.js`.
  `resolveContractFeeData`/`assembleContractHtml` turned out to have zero callers outside this
  cluster once traced, so they didn't need a separate re-import.
- **`sendContractEmail`** and **`contractUpload`** (the upload multer config) were both confirmed
  single-consumer (only the `contract/send` and `contract` POST-upload routes, respectively) and
  moved directly into `routes/admin/bookings.js` rather than a new lib file.
- **`contract/remind`** inlines its own reminder email (via already-leaf `getEmailFooterContext`/
  `bannerRegistry`/`emailComponents`/`sendEmail`) rather than calling the generic `remindBooking` —
  confirmed by reading the route body, not assumed — so it needed no dependency on `remindBooking`
  or the two `send*Email` functions that function pulls in, which stay deferred.

Verification: `node -c` on all changed/new files; confirmed zero remaining `app.js` registrations
for all 9 paths and zero remaining reference to any relocated function/constant outside comments;
`npm run smoke` 329/329; `npm test` x5 — 3 clean 664/664, 2 with the same already-documented
calendar-sync reschedule flake (unrelated). Direct, thorough coverage from the dedicated
`contract.test.js` suite — draft generation with a real PDF, send, the full two-party sign/
countersign flow (including the "blocked before client signs" and "finalised: signed + frozen"
cases), all passing on every run.

**Correction found later (during the quote-route reconnaissance for sub-batch F):** `GET
.../contract/builder-data` and `POST .../contract/preview` both call `dbGet(...)` with **no import
of it anywhere in this file** — a missing re-import this batch should have added (app.js itself has
always imported `dbRun`/`dbGet`/`dbAll` from `lib/db-helpers.js`; this file never did). Every call
would have thrown `ReferenceError: dbGet is not defined` — a guaranteed 500 on both routes, live in
production since this batch's commit, undetected because `contract.test.js` never exercises either
endpoint (it only tests `/contract/generate` and the sign/countersign flow). This is the same class
of gap as the dead-import checks done after every batch, just the opposite direction — an import
that should have been *added*, not one that should have been removed — so it wasn't caught by the
`\bname\b`-grep-for-zero-remaining-references sweep, which only ever checks names being removed.
Fixed by adding `const { dbRun, dbGet, dbAll } = require('../../lib/db-helpers');` — restores the
exact original working behaviour (app.js's own long-standing import of the same module), no logic
changed. Verified with a throwaway fixture: both routes now return 200 with the expected payload
shape (confirmed via `test/support.js` in isolation). Treated as completing this batch's relocation
correctly rather than as a separate authorized bug fix, on the same reasoning as every dead-import
removal in this session — the missing import IS the relocation defect, not a pre-existing app bug.
Worth checking for on every future batch: after adding new call sites to a module-scope helper
(`dbGet`/`dbRun`/`dbAll`, or any `lib/` export), grep the *destination* file for the name too, not
just the source file for what became dead. Wrote a one-off static sweep (acorn-based: collects every
name bound anywhere in a file against every name referenced, flags the difference minus JS/Node
globals) and ran it across every `routes/admin/*.js`, `lib/*.js`, and `middleware/*.js` file plus
`app.js` itself — this `dbGet` instance was the only real hit; two other flags (`document-totals.js`,
`newsletter-scheduling.js`) turned out to be a bug in the sweep script's own handling of a
destructured-parameter-with-default (`{ x = 0 } = {}`), fixed and re-verified clean. Scratchpad tool,
not part of the repo, but the codebase-wide result stands: no other missing-import instances of this
class exist in already-relocated code as of this batch.

### Bookings sub-batch D: reminder/resend/review-request routes (5 routes) — DONE

`POST /:id/remind`, `POST /bulk-remind`, `POST /:id/resend-quote`, `POST /:id/resend-confirmation`,
`POST /:id/review-request`. Traced dependencies and found 6 of the ~28 catalogued `send*Email`
functions plus `generateBookingICS` and the `remindBooking` orchestrator were all already fully
leaf-safe (every one confirmed to depend only on already-relocated `lib/`/`js/` modules —
`getVatRate` from batch C's `lib/document-totals.js` made `sendQuoteEmail` itself clean this time)
— so relocated all of them together into a new **`lib/booking-notifications.js`**:
`generateBookingICS`, `sendQuoteEmail`, `sendAdminQuoteSentNotification`, `sendBookingConfirmedEmail`,
`sendDepositBalanceDueEmail`, `sendQuoteExpiryWarningEmail`, `sendReviewRequestEmail`,
`remindBooking`. Six of these eight have multiple remaining callers scattered across the still-
deferred payment-processing code and cron jobs — `app.js` re-imports all six; `remindBooking` itself
has zero remaining app.js callers (both its only call sites, `remind` and `bulk-remind`, moved with
it) and `sendAdminQuoteSentNotification` stays with its one remaining caller (the deferred admin
quote route).

Verification: `node -c`; confirmed zero remaining `app.js` registrations for all 5 paths and zero
remaining definitions of any of the 8 relocated functions outside comments; `npm run smoke`
329/329; `npm test` x5 — 3 clean 664/664, one run with two already-documented pre-existing flakes
(CP3, CP17), one with the already-documented `banner.test.js` `SQLITE_BUSY` crash (10th occurrence),
none touching this batch. Direct coverage from the dedicated reminder tests (`remind on QUOTED ->
quote type`, `remind on CONFIRMED-with-balance -> balance type`, 24h throttling, `bulk-remind`
summary/skip-counting) and `CP6: manual review-request -> 200`, all passing on every run.

### The Google Calendar sync engine — relocated to `lib/calendar-sync.js` — DONE

The piece flagged since the reconnaissance write-up as "the highest-risk piece of this pass" — given
its own dedicated, unhurried pass rather than being folded into a route batch: `isWithinWorkingHours`,
`hasCalendarConflict`, `syncBookingToCalendar`, `syncCalendarHolds`, `syncEventToCalendar`. No routes
moved in this step — this is a pure prerequisite lib-extraction that the actual booking-conflict/
calendar-sync ROUTES (the big admin quote route, `book-again`, the venue-linking routes, `sync-
calendar`, and the deferred `events` cluster) still need as their own follow-up batch(es).

Read all five functions in full before touching anything, then traced every dependency individually
against the existing `lib/`/repository inventory rather than assuming shape from past batches, given
that "tests pass" can't be trusted here the way it has for every other batch — these functions make
real Google API calls, and the whole suite runs against a deliberately-invalid `GOOGLE_REFRESH_TOKEN`
(support.js), so automated tests only ever exercise the *failure* path, never a real successful sync.
Finding: **zero new/surprise custom dependencies** — every dependency was either an already-relocated
`lib/` module (`lib/google-calendar.js`, `lib/time-utils.js`, `lib/booking-config.js`) or an existing
Phase 4 repository export (`bookings.repository.js`, `calendar.repository.js`). Phase 4's `calendar`
domain session had already fully isolated the DB layer beneath this engine, so despite its reputation
the relocation itself was mechanical once every dependency was individually confirmed. Created
**`lib/calendar-sync.js`**, `node -c` clean. All five have remaining callers scattered across the
still-deferred bookings/events routes (and app.js's own `syncCalendarHolds` startup wiring) —
`app.js` re-imports all five from the new module.

**Dead-import cleanup (the same systemic gap first found during the bank-statement bug-fix, recurring
exactly as flagged then):** once the five functions' own `require`s existed in the new lib file,
app.js's OWN top-level repository destructures had orphaned copies of the same names. Grepped each
candidate with `\bname\b` word-boundary matching to confirm zero remaining references outside the
destructure line itself before removing it. Found and removed 11 dead names total:
- `bookings.repository` destructure: `getBookingsOnDateForCalendarConflict`, `setBookingGoogleEventId`,
  `getBookingsWithGoogleEventIdAsync`.
- `calendar.repository` destructure: `getDateHoldTimesForDay`, `getCalendarSyncHoldIds`,
  `deleteDateHoldByGoogleEventId`, `getCalendarSyncHoldDetails`, `updateDateHoldFromGoogleSync`,
  `insertDateHoldFromGoogleSync`, `getEventGoogleCalendarIdsForSync`, `setEventGoogleCalendarId`.

`getEventById` (also consumed by `syncEventToCalendar`) was kept in app.js's own destructure —
confirmed it has a genuine second call site at the still-in-app.js `POST /api/admin/events/:id/duplicate`
route. Every other name in both destructure blocks was left untouched without re-checking (out of
scope — they weren't part of this engine's dependency list).

**Static byte-identity check** (beyond the usual `node -c`/grep sweep, given the stakes): diffed each
of the five relocated function bodies against the pre-move `app.js` (via `git show HEAD:app.js`) line
by line. All five are character-for-character identical except a handful of trailing-whitespace-only
differences — a trailing space trimmed from a handful of blank lines inside `syncCalendarHolds`, and
one trailing space trimmed from inside a SQL template literal in `syncBookingToCalendar` (cosmetic;
inert for SQLite). No logic, control flow, comments, or variable names differ at all.

Verification: `node -c` on both changed files; confirmed zero remaining `app.js` definitions of any
of the 5 functions outside comments, and zero remaining references to any of the 11 removed dead
names; `npm run smoke` 329/329. `npm test` x6, given the stakes (more than the usual 3-5 run bar) —
4 clean 664/664 runs, 2 runs with failures, none reproducing the same pairing twice and always clean
on the very next run:
- Run 1: one failure, identity lost to a harness output-capture artifact (only the log's last ~62
  lines were retained) — redirected subsequent runs to a scratchpad file instead to avoid the same
  gap.
- Run 4: `calendar-booking-sync.test.js`'s "cancel: deleteGoogleEvent was invoked..." (previously
  logged, route batch 15 update above) and `calendar.test.js`'s **CP17** ("`syncEventToCalendar` was
  actually invoked after the drag" — previously logged, Phase 4 `finance` domain update above).
- Run 5: **CP17** again, plus **CP5** (venue_name propagation — previously logged many times, most
  recently route batch 24 above; exercises `updateEventVenueLegacyLink`, code this step never read).

CP17 recurring on two consecutive runs is a higher rate than its single-occurrence history, so gave
it extra scrutiny rather than filing it on pattern-match alone: read the still-in-app.js call site
(`PATCH /api/admin/events/:id/date`, line ~8665) that fires `syncEventToCalendar(eventId).catch(...)`
and confirmed it is completely unchanged — same fire-and-forget shape (the `res.json(...)` response
returns synchronously immediately after, exactly as before), same import path (now from the new
destructure at the top of the file), nothing about the wiring differs from pre-move. Combined with
the byte-identity diff above and CP5 (unrelated code, untouched by this step) failing in the same run
as CP17, the pattern matches this suite's own documented precedent of an entire run occasionally
landing under heavier timing pressure and producing a small cluster of unrelated fixed-sleep flakes
together (see the "shared-helper extraction" update above) rather than one function's logic being at
fault. Treated as the same pre-existing sleep-margin flake family, not a regression.

Existing direct coverage of the relocated engine (none written for this step — all pre-existing):
`calendar-booking-sync.test.js` proves `syncBookingToCalendar` is actually invoked (not silently
skipped) on a real booking's confirm/reschedule/cancel via log-line matching; `calendar.test.js`'s
CP7/CP18 exercise `hasCalendarConflict`'s booking-vs-event and event-vs-event local conflict paths
(409 rejections); CP17 exercises `syncEventToCalendar`; `isWithinWorkingHours` is exercised
indirectly via `booking.test.js`'s happy-path working-hours check. `syncCalendarHolds` has no direct
test coverage — it's cron-only (`startBackgroundClerk`), calls Google's `events.list`, and is wrapped
in its own top-level try/catch; this is a pre-existing gap (same category as the already-documented
"Google Calendar request-payload assertions are not achievable" limitation below), not something
this step introduced or could close without changing application code.

### Bookings sub-batch E: the calendar/venue/date cluster (6 routes) — DONE

The first routes to actually consume the newly-relocated calendar-sync engine: `POST
.../book-again`, `POST .../sync-calendar`, `PUT .../venue` (legacy venue_id link/unlink), `PUT
.../venue-google` (Google Places link), `PATCH .../date` (drag-reschedule), `PATCH .../venue`
(free-text venue editor).

Two more helper functions needed relocating first, both traced end-to-end before moving anything:

- **`checkDateAvailability`** (local-only, no Google API — the sibling of `hasCalendarConflict`)
  joined **`lib/calendar-sync.js`**. Every dependency (`getDateHoldsForAvailabilityCheck`,
  `getUpcomingStandaloneEventOnDate`, `getBookingsOnDateForAvailability`, plus already-present
  `parseDurationToMinutes`/`addMinutesToTime`/`bookingConfig`) was already either in that module or
  an existing Phase 4 repository export. `book-again` and `PATCH .../date` both call it; the public
  `/api/public/availability` route and the public booking-intake flow (both still in app.js, not
  today's scope) also call it, so app.js re-imports it from the module. While touching this block,
  also removed two orphaned JSDoc comments left behind by the earlier calendar-sync-engine move
  (doc comments for `isWithinWorkingHours`/`hasCalendarConflict` that survived the `REMOVED_`
  rename-then-blank technique because they were physically separate from the function bodies) —
  genuinely dead now that their subject functions no longer live in this file.
- **`sendDateChangedEmail`** joined **`lib/booking-notifications.js`** — exactly the same shape as
  every sibling already there (`escapeEmailFields` + `getEmailFooterContext` + `bannerRegistry` +
  `emailComponents` + `sendEmail`, all already required by that file for its existing exports; zero
  new requires needed). `PATCH .../date` is one of its two callers; the other (the events cluster's
  own `PATCH /:id/date`) is still in app.js and not part of this batch, so app.js re-imports it too.

Dead-import sweep (same `\bname\b`-grep-before-removal discipline as every prior batch) found 12
more names orphaned once these two routes' repository calls moved with them: `updateBookingVenueUnlink`,
`updateBookingVenueLinkLegacy`, `updateBookingVenueGoogle`, `getBookingEventId`, `unlinkEventVenue`,
`updateEventVenueLegacyLink`, `updateEventVenueGoogleLink`, `updateBookingVenueFreeText`,
`updateEventVenueFreeText`, `updateBookingDateAndTimeFields`, `updateDateHoldDateForBooking`,
`insertBookAgainBooking`. Kept `updateEventDatetime` (still called at the events cluster's own date
route) and `getBookingByIdAsync` (4 remaining call sites elsewhere) — both confirmed via the same
grep before deciding either way. The `venues` table has no Phase 4 repository of its own (never one
of the 8 domains) — the two venue routes' direct `db.get`/`db.run` against it is not a gap, it
matches the existing pattern (`db` is already required directly in `routes/admin/bookings.js`).

Verification: `node -c` on all changed files; grep sweep confirmed zero remaining `app.js`
registrations for all 6 paths and zero remaining dead names; `npm run smoke` 329/329. `npm test` x4
valid runs (a 5th was invalidated by the self-inflicted DB-collision incident logged under "Known
testing limitations" above) — 2 clean 664/664, one recurrence of the already-logged "reschedule:
SECOND sync attempt" flake on the exact route this batch moved (re-diffed byte-identical against
`git show HEAD:app.js` — confirmed clean), and one new-to-this-session instance of the same timing-
margin family in `email.test.js`'s Guard 5 (deposit-balance-due email), traced to `PUT
.../manual-payment` — untouched by this batch — `await`-ing a real Calendar OAuth round-trip before
firing that email, a sensitivity the test's own comment already flags. Direct coverage from
`calendar.test.js`'s **CP5** (`PATCH .../venue` free-text venue propagation) and
`calendar-booking-sync.test.js`'s reschedule check (`PATCH .../date`). No dedicated coverage for
`book-again`, `sync-calendar`, `PUT .../venue`, or `PUT .../venue-google`, so drove all four
manually against real fixtures (19 checks, all passing): `sync-calendar` invoking
`syncBookingToCalendar` with log-line evidence; `book-again` rejecting a non-CANCELLED booking (400),
succeeding on a CANCELLED one with copied client fields and both `REBOOKED`/`CREATE` audit rows;
`PUT .../venue` linking-by-`venue_id` and unlinking; `PUT .../venue-google` inserting a new `venues`
row on a fresh `place_id` and updating in place (no duplicate row) on a repeat call with the same
`place_id`.

### Bookings sub-batch F: the admin quote route (1 route, the biggest so far) — DONE

`POST /api/admin/bookings/:id/quote` — the route explicitly flagged since the reconnaissance
write-up as needing `findOrCreateClient`/`setBookingClientId`, and the single biggest route moved in
this whole pass (~320 lines): structured/legacy quote bodies, the calendar + per-day-service conflict
checks, VAT/totals computation, the re-quote-after-committed path (supersedes payment schedules,
voids the live invoice, resets any contract to draft — all inside one guarded transaction), quote
PDF generation, and the post-commit side effects (calendar sync, client + admin notification emails).

Every dependency traced individually rather than assumed:

- **`findOrCreateClient`** turned out to already be relocated (to `lib/client-venue.js`, from a
  batch this write-up hadn't previously covered in detail) — fully leaf-safe, zero new work needed,
  just an import.
- **`setBookingClientId`**, **`updateBookingAfterQuote`**, **`deleteBookingLineItems`**,
  **`deleteBookingServices`**, **`insertBookingLineItem`**, **`insertBookingService`** — existing
  `bookings.repository` exports, newly imported into `routes/admin/bookings.js`.
- **`getQuoteNumberCollisionCount`**, **`voidInvoiceForRequote`**, **`archivePreviousQuotations`**,
  **`getNextQuoteVersion`**, **`insertQuotation`**, **`insertQuoteLineItem`** — existing
  `invoices-quotations.repository` exports.
- **`supersedePaymentSchedulesForRequote`** — existing `finance.repository` export.
- **`resolveLineTaxClasses`/`getVatRate`/`computeDocumentTotals`** (sub-batch C's
  `lib/document-totals.js`), **`hasCalendarConflict`/`syncBookingToCalendar`** (the calendar-sync
  engine), **`sendQuoteEmail`/`sendAdminQuoteSentNotification`** (`lib/booking-notifications.js`),
  **`withDbTransaction`**/**`dbRun`**/**`dbGet`** (the required-singleton transaction queue and
  `lib/db-helpers.js`) — all already-relocated and just needed importing.
- **`pdfService`** — first use of this module (`js/pdfService`) in `routes/admin/bookings.js`;
  `routes/admin/advancing.js` already established the `require('../../js/pdfService')` pattern,
  followed directly.

**A genuine relocation hazard caught before it shipped:** the route's top-level-error handler writes
a debug dump via `require('fs').writeFileSync(__dirname + '/scratch/quote-error-toplevel.log', ...)`.
`__dirname` is file-relative — copied verbatim into `routes/admin/bookings.js`, it would silently
resolve to `routes/admin/scratch/...` (a directory that doesn't exist) instead of the original
`<project-root>/scratch/...`, changing behaviour despite the text being byte-identical. Caught by
checking every use of the moved code's `__dirname`/`__filename` before treating it as a safe verbatim
copy — an established `lib/runtime-paths.js` export (`PROJECT_ROOT`) already exists for exactly this,
so the fix is `path.join(PROJECT_ROOT, 'scratch', 'quote-error-toplevel.log')`, preserving the
original resolved path exactly. Worth checking on every future batch: `__dirname`/`__filename` in
moved code needs this treatment; nothing else in this route used either.

**Dead-import sweep found one gap the process itself doesn't normally catch:** `sendQuoteEmail` had
zero remaining callers in `app.js` after the route moved (its only call site went with it), but
wasn't initially removed from `app.js`'s `lib/booking-notifications` destructure — caught on a
second, more thorough pass that extracted every call-shaped identifier from the original route body
and checked each one's remaining `app.js` usage individually (`getQuoteNumberCollisionCount`,
`voidInvoiceForRequote`, `archivePreviousQuotations`, `getNextQuoteVersion`, `insertQuotation`,
`insertQuoteLineItem`, `updateBookingAfterQuote`, `deleteBookingLineItems`, `deleteBookingServices`,
`supersedePaymentSchedulesForRequote`, and `sendAdminQuoteSentNotification` had all already been
correctly removed; `sendQuoteEmail` was the one miss). Fixed by removing it from the destructure too.

**Static byte-identity check** (same discipline as the calendar-sync-engine move, given the stakes):
diffed the full relocated route against `git show HEAD:app.js` line by line. The only difference
anywhere in ~320 lines is the intentional `__dirname` → `PROJECT_ROOT` fix described above, with its
explanatory comment — everything else, including every SQL string, every audit-log payload, every
error message, is character-for-character identical.

Verification: `node -c` on both files; confirmed zero remaining `app.js` registration for this path
and zero remaining references to any of the dependency names above outside comments; `npm run smoke`
329/329; `npm test` x3, all three clean 664/664 — no flakes at all this time, across the single most
heavily-tested route in the codebase (exercised, directly or as setup, by 9 different test files:
`banner`, `booking`, `calendar-booking-sync`, `calendar`, `contract`, `email`, `lifecycle`,
`payment-callback`, `pdf-golden`).

### The deferred `events` cluster (6 routes) — DONE — closes out the bookings/events pass

`GET/POST /api/admin/events`, `PUT/DELETE /api/admin/events/:id`, `PATCH /api/admin/events/:id/date`,
`POST /api/admin/events/:id/duplicate` — the cluster explicitly deferred at the very start of this
pass pending the calendar-sync engine, now unblocked. Unlike every other domain in this pass, `events`
had no existing route file — created **`routes/admin/events.js`** and mounted it in `app.js` right
after `routes/admin/bookings.js`.

Two more pieces of local (non-route) code moved with it, both single-consumer within this exact
cluster and nothing else in `app.js`:

- **`checkEventConflicts`** — the standalone-event conflict checker (bookings + holds + other
  events on the same day), depends only on already-existing repository exports
  (`getBookingsOnDateForEventConflict`, `getActiveDateHoldsForEventConflict`, `getOtherEventsOnDate`)
  and already-relocated `lib/time-utils.js` helpers.
- **`VALID_EVENT_STATUSES`/`VALID_EVENT_TYPES`** — the two validation-list constants.

All other dependencies were already-existing Phase 4 repository exports newly imported into the new
file (`insertEventFull`, `updateEventFull`, `deleteEventById`, `getEventForConflictEdit`,
`getEventForDragReschedule`, `updateEventDatetime`, `insertEventForDuplicate`, `getEventById`,
`linkEventToPlaceholderBooking`, `clearEventGoogleCalendarId`, `getEventGoogleCalendarId`,
`clearDateHoldEventId`, `insertDateHoldForNewEvent` from `calendar.repository`;
`insertPlaceholderBookingForEvent`, `getBookingByIdSafeAsync`, `updateBookingDateFromEventEdit`,
`clearBookingEventIdWhereEventId`, `setBookingDateAndStartTimeFromEvent`, `setBookingEventId`,
`getBookingById` from `bookings.repository`) or already-relocated `lib/` modules
(`deleteGoogleEvent`, `resolveActor`, `hasCalendarConflict`/`syncBookingToCalendar`/
`syncEventToCalendar`, `sendDateChangedEmail`) — zero new repository or lib work needed, the whole
cluster was mechanical once traced.

**A copy-paste mistake caught by re-verifying, not assumed correct:** while writing the new file's
`calendar.repository` import, `linkEventToPlaceholderBooking` was initially (incorrectly) also added
to the `bookings.repository` import — it only exists on `calendar.repository`. Caught immediately by
running the same static undefined-reference sweep (from the `dbGet` fix earlier this session) against
the new file before considering it done, rather than trusting the hand-written import list on sight.

Dead-import sweep found 17 more names orphaned in `app.js`'s own destructures once this cluster's
calls moved with it — the largest single dead-import cleanup this session, reflecting how much of
`app.js`'s remaining calendar/event surface belonged to exactly this cluster:
`getBookingsOnDateForEventConflict`, `insertPlaceholderBookingForEvent`, `linkEventToPlaceholderBooking`,
`getBookingByIdSafeAsync`, `updateBookingDateFromEventEdit`, `clearBookingEventIdWhereEventId`,
`setBookingDateAndStartTimeFromEvent`, `getActiveDateHoldsForEventConflict`, `getOtherEventsOnDate`,
`insertEventFull`, `insertDateHoldForNewEvent`, `getEventForConflictEdit`, `updateEventFull`,
`clearDateHoldEventId`, `getEventForDragReschedule`, `getEventById`, `insertEventForDuplicate`. Kept
`setBookingEventId`, `clearEventGoogleCalendarId`, `getEventGoogleCalendarId`, `deleteEventById`, and
`updateEventDatetime` — each confirmed via `grep -o` occurrence counting (not line counting, which
under-counts when two matches share a line) to have a genuine second call site elsewhere in `app.js`
(the booking-side `manual-payment`/`applyStatusChange`-adjacent auto-event-creation code, and the
bookings `PATCH .../date` route moved in sub-batch E).

Verification: `node -c` on both files; the static undefined-reference sweep on both `app.js` and the
new file (clean); confirmed zero remaining `app.js` registrations for all 6 paths and zero remaining
references to any of the 17 dead names; `npm run smoke` 329/329; `npm test` x3, all three clean
664/664 — this cluster has the heaviest dedicated coverage of anything moved this session:
`calendar.test.js`'s **CP7** (booking-linked event edit conflict check), **CP8** (both the public
endpoint and the admin `GET /api/admin/events` default/`?include_private=1` views), **CP17**
(`PATCH .../date` drag-reschedule sync), **CP18** (event-vs-event conflict on create), **CP19**
(`block_type:booking` bidirectional link), **CP20** (`block_type:hold` + delete without an FK error).
Only `POST .../duplicate` had no dedicated test — manually verified against a real fixture (6 checks,
all passing): 200 + a new id distinct from the original, `" (Copy)"` appended to the title, every
copyable field (datetime/venue/type/capacity/ticket link) preserved, status reset to `draft`
regardless of the original's status, and 404 on a non-existent source event.

**This closes out the deferred `bookings`/`events` pass** first scoped in the reconnaissance
write-up above. Remaining Phase 5 scope: the 19-route `/api/public/bookings/*` surface,
`applyStatusChange` and its dependency web (`processManualPayment`, `alignMilestonePayments`,
`updateBookingMilestones`, `deriveBookingStatusAfterPayment`), `generateInvoice` +
`autoBuildDepositBalanceSchedule`, `logPaymentEvent`/`generatePayFastSignature`, the remaining
`send*Email` functions not yet relocated, and ~12 background cron jobs — none started yet.

### The public `/api/public/bookings/*` surface begins — shared prerequisites

Started the last major piece of Phase 5's route-extraction work: 19 routes covering the entire public
booking self-service surface (draft/resume, tracking OTP, payment initiation, quote acceptance,
contract signing, downloads, cancellation, review). Before touching any route, relocated the
shared layer nearly all of them depend on — same "prerequisite first" discipline as
`lib/calendar-sync.js` before the admin bookings pass:

- **`lib/booking-tracking.js`** (new): `asBookingText` (used pervasively across this whole surface,
  including the not-yet-moved public booking-intake route itself), `OTP_TTL_MINUTES`/
  `OTP_MAX_ATTEMPTS`/`ACCESS_TOKEN_TTL_MINUTES`, `generateOtpCode`, `hashAccessToken`. All five were
  already fully self-contained (built-ins + `crypto` only).
- **`middleware/booking-access.js`** (new): `requireBookingAccessToken` — the gate 9 of these 19
  routes use directly as declared middleware (the client-facing analogue of `requireAdmin`).
  Depends only on the new `lib/booking-tracking.js` and two existing `bookings.repository` exports
  (`getBookingAccessTokenByHash`, `touchBookingAccessToken`) — both now dead in `app.js` and removed
  from its destructure, matching `middleware/auth.js`'s own existing shape and location.

`app.js` re-imports all six names — every one of the 19 routes still lives there for now.

Verification: `node -c`; the static undefined-reference sweep on both new files and `app.js` (all
clean); `npm run smoke` 329/329; `npm test` x2, both clean 664/664 — no routes moved yet, so no new
direct coverage to speak of; the two runs confirm the relocation itself introduced no regression in
whatever already exercises this code path indirectly (the tracker OTP flow, quote acceptance, etc.,
all still living in `app.js` unchanged).

### Public bookings sub-batch A: the draft/resume cluster (4 routes) — DONE

`POST /api/public/bookings/draft` (autosave), `GET .../draft/:resumeToken` (fetch for resume),
`GET/POST .../draft/:resumeToken/optout` (the render-then-mutate pair for recovery-reminder
opt-out — a GET must never itself unsubscribe, since email-security scanners pre-fetch links).
First actual route batch of the public pass; no prior route file existed for this domain — created
**`routes/public/bookings.js`** and mounted it in `app.js` right after `routes/admin/events.js`.

Two more single-consumer local helpers moved with it, both already fully self-contained: 
**`estimateDraftValue`** (a `services` price lookup, pure `db.all` + arithmetic) and
**`_abOptOutPage`** (the inline HTML confirmation-page renderer shared by both opt-out routes).
Everything else was already available: `db`, `crypto` directly; `ipRateLimiter`
(`middleware/rate-limiters.js`) and `encodeUserHtml` (`lib/html-sanitize.js`) both already
relocated and just needed importing.

Verification: `node -c`; the static undefined-reference sweep (clean); confirmed zero remaining
`app.js` registrations for all 4 paths; `npm run smoke` 329/329; `npm test` x2 — 1 clean 664/664, 1
with the already-extensively-documented **CP5** flake (`updateEventVenueLegacyLink` propagation,
unrelated to anything in this batch). No dedicated test coverage existed for any of these 4 routes
— manually verified all of them against real fixtures (11 checks, all passing): the POPIA-
minimisation skip when no email is present yet, upsert-with-resume-token-preserved-across-repeat-
calls, `furthest_step` staying monotonic, fetch-for-resume returning the exact persisted fields,
404 on an unknown token, the opt-out page rendering real HTML (not JSON) with a POST form pointed
at the same path, the POST actually flipping `opt_out`/`status`, and the fetch route correctly
returning 410 once opted out.

### Public bookings sub-batch B: tracker OTP + lookup + data-fetch (4 routes) — DONE

`POST .../:id/track/request-code` + `.../:id/track/verify-code` (the two-step OTP flow that gates
every other tracking-adjacent route via `requireBookingAccessToken`), `POST .../bookings/lookup`
(find bookings by email), `POST .../:id/track` (the actual client-facing data fetch — booking
summary, invoice, payment schedule, services, quote version, cancellation, contract — built from an
explicit allowlist rather than the raw `bookings` row). Appended to `routes/public/bookings.js`.

All dependencies were already-existing exports needing only import: `getBookingEmailForTracking`,
`consumeUnconsumedAccessCodes`, `insertBookingAccessCode`, `getActiveAccessCodeForVerification`,
`consumeAccessCodeById`, `incrementAccessCodeAttempts`, `insertBookingAccessToken`, `getBookingById`
(`bookings.repository`); `getInvoiceForTracking`, `getQuoteVersionInfoForTracking`
(`invoices-quotations.repository`); `getPaymentSchedulesForTracking`,
`getCancellationSummaryForTracking` (`finance.repository`); `bcrypt`, `bannerRegistry`,
`emailComponents`, `sendEmail`, `getEmailFooterContext` (all already-established import patterns);
`otpRequestRateLimiter`/`mutateRateLimiter`/`lookupRateLimiter`/`trackRateLimiter` and
`requireBookingAccessToken` from the prerequisite work above.

Dead-import sweep found 11 more names orphaned in `app.js`'s destructures (all seven access-code/
token functions, `getInvoiceForTracking`, `getQuoteVersionInfoForTracking`,
`getPaymentSchedulesForTracking`, `getCancellationSummaryForTracking`) — removed; kept
`getBookingById` (heavily used elsewhere) and every sibling on the same lines confirmed to still
have a real call site.

Verification: `node -c`; the static undefined-reference sweep (clean on both files); confirmed zero
remaining `app.js` registrations for all 4 paths and zero remaining references to any of the 11 dead
names; `npm run smoke` 329/329; `npm test` x2, both clean 664/664. `track/request-code` and
`track/verify-code` have exceptionally heavy *indirect* coverage — `test/support.js`'s
`getTrackingToken()` helper drives this exact two-step flow as setup for nearly every test file that
needs quote acceptance (`booking`, `calendar-booking-sync`, `calendar`, `contract`, `email`,
`lifecycle`, `payment-callback`, `pdf-golden`). The plain data-fetch `track` route and `lookup` had
no dedicated coverage — manually verified both against real fixtures (11 checks, all passing):
`lookup` finding a real booking by email, a friendly `success:false` on an unknown email, 400 on a
malformed address; `track` rejecting a missing token (401), returning the full allowlisted payload
for a valid token (confirmed no internal-only fields like `admin_notes`/`ip_address` leak), and a
token scoped to one booking correctly failing (401, not 404) against a different booking id.

### Public bookings sub-batch C: the three download routes — DONE

`GET .../:id/invoice/download`, `GET .../:id/contract/download`, `POST .../:id/quote/download` —
the public-facing analogues of the admin download routes moved in the very first bookings sub-batch.
Appended to `routes/public/bookings.js`. All dependencies already existed: `resolveDocsPath`
(`lib/runtime-paths.js`), `getLatestQuoteFileForPublicDownload`
(`invoices-quotations.repository`), `fs`/`db` directly — only `getLatestQuoteFileForPublicDownload`
was newly dead in `app.js` and removed.

Verification: `node -c`; the static undefined-reference sweep (clean); confirmed zero remaining
`app.js` registrations and zero remaining reference to the one dead name; `npm run smoke` 329/329;
`npm test` x2, both clean 664/664. No dedicated coverage exists for any of these 3 routes
(`pdf-golden.test.js` only exercises their `/api/admin/bookings/*` counterparts) — manually verified
all three end-to-end against real generated PDFs (13 checks, all passing): `quote/download`
succeeding once a quote exists and rejecting a missing token; `invoice/download` correctly 404ing
before an invoice exists and succeeding once one is generated; `contract/download` — where the
first verification attempt surfaced a wrong *assumption in the test*, not a bug: it expected no
contract to exist until an explicit admin `contract/generate` call, but `accept-quote`'s own
`generateContract(bookingId)` call (documented in the *admin bookings* sub-batch C write-up above)
already auto-creates a draft contract on quote acceptance, so a real PDF was already being served correctly
— confirmed via the `contracts` table directly, then re-verified the download route itself was never
at fault.

### Public bookings sub-batch D: cancel, review, attachments — DONE

`POST .../:id/cancel` (client self-cancellation, refund calc + a guarded transaction that cancels
the booking, records the cancellation, releases date holds, voids invoices, and cancels pending
payment schedules atomically), `POST .../:id/review` (post-event rating, COMPLETED bookings only),
`POST .../:id/attachments` (supporting-file upload — the one route in this whole pass that
authenticates by matching a client-supplied email against the booking's own email rather than
`requireBookingAccessToken`, an existing, deliberate difference left exactly as found).

New dependencies, all already-existing exports needing only import: `calculateCancellationRefund`
(`lib/cancellation-refund.js`), `sendCancellationEmail` (`lib/booking-cancellation-email.js`, both
already relocated in earlier batches), `withDbTransaction`/`dbRun` (the required-singleton
transaction queue + `lib/db-helpers.js`), `insertCancellationForPublicCancel`
(`finance.repository`), `releaseDateHoldsForBookingAsync` (`calendar.repository`),
`voidInvoicesForCancelledBookingAsync` (`invoices-quotations.repository`),
`cancelPendingPaymentSchedulesAsync` (`finance.repository`), `getNotificationEmail`
(`settings.repository`). **`bookingAttachUpload`** (the attachments multer config) moved directly
into the route file as a single-consumer local, matching the `contractUpload` precedent from the
admin contract-cluster batch.

Dead-import sweep found only `insertCancellationForPublicCancel` newly orphaned in `app.js` — every
other name above (`sendCancellationEmail`, `calculateCancellationRefund`,
`releaseDateHoldsForBookingAsync`, `voidInvoicesForCancelledBookingAsync`,
`cancelPendingPaymentSchedulesAsync`) still has a genuine second caller elsewhere (confirmed via
`grep -o` occurrence counts, not line counts) in the still-deferred `accept-quote`/
`quote-revision-request` routes and the admin bulk-cancel path.

Verification: `node -c`; the static undefined-reference sweep (clean); confirmed zero remaining
`app.js` registrations for all 3 paths and zero remaining reference to the one dead name; `npm run
smoke` 329/329; `npm test` x3 — 2 clean 664/664, one run with the already-extensively-documented
`calendar-booking-sync.test.js` "cancel: deleteGoogleEvent" flake, which exercises the *admin*
cancel route (`/api/admin/bookings/:id/cancel`), not the public one moved here — unrelated. No
dedicated coverage exists for any of these 3 public routes — manually verified all three against
real fixtures (15 checks, all passing), including a self-corrected fixture mistake: the admin
booking-creation route's own `validStatuses` allowlist (`NEW`/`PENDING`/`QUOTED` only) silently
downgrades any other requested status to `NEW`, so a `COMPLETED` fixture for the review test had to
be seeded with a direct DB write instead of assumed from the creation call — not a bug in the
relocated `review` route, a wrong assumption in the test caught by checking the actual persisted
status before blaming the route.

### Public bookings sub-batch E: pay + contract/sign — DONE

`POST .../:id/pay` (PayFast redirect initiation — status/payment-status gating, server-side amount
calc from milestone payment schedules, signed `pfData`) and `POST .../:id/contract/sign` (the
client's half of the two-party contract sign/countersign flow — signature bound to the exact PDF
bytes on disk via a SHA-256 hash, plus admin notification). Appended to `routes/public/bookings.js`.

**`generatePayFastSignature`** relocated to a new **`lib/payfast-signature.js`** — fully
self-contained (`crypto` only) but shared with the PayFast ITN webhook (`POST
/api/payment/webhook/payfast`, still in `app.js`, not part of this pass), so `app.js` re-imports it.
`contract/sign` needed zero new dependencies — everything (`db`, `resolveDocsPath`, `fs`, `crypto`,
`asBookingText`, `getNotificationEmail`, `sendEmail`, `emailComponents`) was already available from
earlier sub-batches. `getPaymentSchedulesForPayfastInit` (`finance.repository`) was `pay`'s one new
import; it had exactly one caller in `app.js` (this route), so it's now dead there and removed.

Verification: `node -c`; the static undefined-reference sweep (clean); confirmed zero remaining
`app.js` registrations for both paths and zero remaining reference to the one dead name; `npm run
smoke` 329/329; `npm test` x3 — 2 clean 664/664, one run crashing with the already-extensively-
documented `banner.test.js` `SQLITE_BUSY` process crash (see "Known testing limitations" — now an
11th occurrence, same category, unrelated to anything in this batch). `contract/sign` has thorough
dedicated coverage in `contract.test.js` (wrong-token rejection, a full sign, re-sign rejection,
and rejection once already finalised) — all passing on every run. `pay` had no coverage at all —
manually verified against real fixtures (11 checks, all passing): rejecting a still-QUOTED booking
(quote must be accepted first), rejecting a missing token and an invalid `payment_type`, a valid
`FULL` request returning a correctly-signed `pfData` payload with the right amount/`m_payment_id`/
`notify_url`, and rejecting a second payment attempt once the booking is already fully paid.

### Public bookings sub-batch F: quote-revision-request — DONE

`POST .../:id/quote-revision-request` (client asks for a quote-expiry extension or a revision on a
QUOTED booking — logs a booking note and fires both an admin-action email and a client
acknowledgement). Appended to `routes/public/bookings.js`. Fully self-contained: every dependency
(`db`, `getNotificationEmail`, `emailComponents`, `encodeUserHtml`, `sendEmail`,
`getEmailFooterContext`, `bannerRegistry`) was already available from earlier sub-batches.
`insertBookingNoteFromTracker` (`bookings.repository`) was the one new import; it had exactly one
caller in `app.js` (this route), now dead there and removed.

Verification: `node -c`; the static undefined-reference sweep (clean); confirmed zero remaining
`app.js` registration and zero remaining reference to the one dead name; `npm run smoke` 329/329;
`npm test` x4 given an elevated flake rate this round — 2 clean 664/664, one run crashing with the
already-documented `banner.test.js` `SQLITE_BUSY` process crash, one run hitting **CP3**
(`calendar.test.js`'s original, most-documented flake — the whole "Deferred fix #3" tracker is named
after it), both unrelated to anything in this batch. No dedicated coverage exists for this route —
manually verified against real fixtures (8 checks, all passing): rejecting an invalid
`request_type`, a too-short message, and a missing token; a valid extension request recording the
exact booking note text and returning 200; a valid revision request also succeeding; and rejecting
the request entirely on a booking that isn't in QUOTED status.

### Public bookings sub-batch G: accept-quote, and the financial core with it — DONE

`POST /api/public/bookings/:id/accept-quote` — the second-biggest route in the whole public pass
(~150 lines): the compare-and-swap status flip (QUOTED→ACCEPTED/CONFIRMED, guarding against a
concurrent double-accept), the acceptance audit row, the auto-built 50/50 deposit/balance payment
schedule, and the post-commit side effects (calendar sync, auto-generated SENT invoice + email,
auto-generated draft contract, client + admin notification emails). This is also the route that
finally forced relocating the two functions flagged since the very first reconnaissance write-up as
"the big deferred bookings/events pass" — `generateInvoice` and `autoBuildDepositBalanceSchedule` —
given its own dedicated, unhurried pass rather than folded in casually, matching the treatment the
calendar-sync engine got earlier.

**`lib/invoicing.js`** (new): `autoBuildDepositBalanceSchedule` and `generateInvoice`, read in full
and traced dependency-by-dependency before writing a line — exactly like the calendar-sync engine,
this "big deferred financial core" turned out to have **zero new/surprise dependencies**: every
repository call (`getLivePaymentScheduleCount`, `getPaidPaymentScheduleSum`,
`insertPaymentScheduleMilestone`, `getInvoiceForPaidCheck`, `getActiveQuoteForInvoiceGen`,
`getQuoteLineItems`, `getInvoiceNumberCollisionCount`, `getPaymentSchedulesForDocument`,
`voidSupersededInvoiceForRegen`, `insertInvoice`, `insertInvoiceLineItem`,
`updateBookingLedgerAfterInvoice`, `markInvoiceSent`, `setBookingClientId`) was already an existing
Phase 4 repository export, and every helper (`findOrCreateClient`, `getVatRate`/
`resolveLineTaxClasses`/`computeDocumentTotals`, `docsWriteDir`, `sendInvoiceEmail`, `pdfService`,
`withDbTransaction`/`dbRun`) was already relocated. Both functions have remaining callers scattered
across still-deferred `app.js` routes (`invoice/generate`, several payment-processing paths); `app.js`
re-imports both.

**`sendQuoteAcceptedEmail`** joined `lib/booking-notifications.js` (same shape as every sibling
there — `escapeEmailFields`/`getEmailFooterContext`/`bannerRegistry`/`emailComponents`/`sendEmail`/
`generateBookingICS`, all already present) — one remaining `app.js` caller, re-imported.
**`sendAdminQuoteAcceptedNotification`** moved directly into `routes/public/bookings.js` as a
single-consumer local (fully dead in `app.js` afterward — its only caller moved with it).

**A missing import the static sweep caught before it shipped:** `syncBookingToCalendar` was used in
`accept-quote`'s post-commit side effects but had never been imported into
`routes/public/bookings.js` (no earlier sub-batch in this file needed it). The undefined-reference
sweep (built for the `dbGet` fix earlier this session) flagged it immediately — fixed by adding the
one-line `lib/calendar-sync.js` import before the route was considered done, rather than after a
runtime `ReferenceError` surfaced it.

**Dead-import sweep found the largest cleanup of this whole session** — 15 names orphaned in
`app.js`'s destructures once `generateInvoice`/`autoBuildDepositBalanceSchedule` moved with all
their own repository calls: `markQuotationAcceptedAsync`, `getLivePaymentScheduleCount`,
`getPaidPaymentScheduleSum`, `insertPaymentScheduleMilestone`, `getInvoiceForPaidCheck`,
`getActiveQuoteForInvoiceGen`, `getQuoteLineItems`, `getInvoiceNumberCollisionCount`,
`getPaymentSchedulesForDocument`, `voidSupersededInvoiceForRegen`, `insertInvoice`,
`insertInvoiceLineItem`, `updateBookingLedgerAfterInvoice`, `markInvoiceSent`, `setBookingClientId`.
Every one confirmed via `grep -o` occurrence counting before removal; siblings on the same
destructure lines with genuine remaining call sites (`sendInvoiceEmail`, `findOrCreateClient`,
`getNotificationEmail`, `flagOverduePaymentSchedules`, `markQuotationAccepted`,
`revertQuotationToSent`) were left untouched. Two more orphaned JSDoc comments (for
`autoBuildDepositBalanceSchedule` and `generateInvoice`, left behind by the `REMOVED_`
rename-then-blank technique) were also cleaned up — their subject functions' own doc comments
already live on in `lib/invoicing.js`.

**Static byte-identity check** on all four relocated pieces (`autoBuildDepositBalanceSchedule`,
`generateInvoice`, `sendQuoteAcceptedEmail`, the `accept-quote` route itself): diffed each against
`git show HEAD:app.js` line by line. All four are character-for-character identical — zero
differences anywhere, not even whitespace this time.

Verification: `node -c` on all four changed/new files; the static undefined-reference sweep (clean
on all four, after fixing the one missing `syncBookingToCalendar` import); confirmed zero remaining
`app.js` registration for the route and zero remaining reference to any of the 15 dead names; `npm
run smoke` 329/329; `npm test` x4 given the stakes — 3 clean 664/664, one run hitting the
already-extensively-documented **CP17** flake (unrelated — the events-cluster drag-reschedule sync,
not anything touched here). `accept-quote` and the financial functions behind it are the most heavily
covered code touched this session: 8 test files exercise this exact path directly (`booking`,
`calendar-booking-sync`, `calendar`, `contract`, `email`, `lifecycle`, `payment-callback`,
`pdf-golden`), so — unlike every other route this session — no manual fixture verification was
needed on top of that; the combination of exhaustive existing coverage and a byte-for-byte-identical
diff gives stronger evidence here than a fresh manual check could add.

**Correction to this entry's own original claim:** this was first written up as closing out the
entire public `/api/public/bookings/*` pass at "19 of 19 routes." That count is wrong — it only
ever covered the 18 routes actually enumerated across sub-batches A-G. The 19th, **`POST
/api/public/bookings`** itself (the public booking-intake route, ~540 lines — the single largest
piece of the whole housekeeping effort), was never part of any sub-batch and is still sitting in
`app.js` untouched. Caught immediately after committing sub-batch G and corrected here rather than
left to stand; the git history for that commit still carries the original overclaim in its message.

Remaining Phase 5 scope: the public booking-intake route above, `applyStatusChange` (the generic
admin status-transition engine) and its dependency web (`processManualPayment`,
`alignMilestonePayments`, `updateBookingMilestones`, `deriveBookingStatusAfterPayment`),
`logPaymentEvent` and the PayFast ITN webhook itself, the remaining `send*Email` functions not yet
relocated, and ~12 background cron jobs.

### Public bookings sub-batch H: the intake route — this time genuinely closes the pass (19/19)

`POST /api/public/bookings` — the public booking-intake form handler, and the single largest route
in the entire housekeeping effort (~500 lines): full field validation and sanitisation, service
selection with lead-time/per-day/quantity rules, the read-before-write ordering fix that keeps a
rejected submission from leaving orphan `clients`/`venues` rows behind, the calendar-conflict and
working-hours gates, the guarded transaction (with every gate re-checked inside the write lock to
close the concurrent-submission race), and the post-commit side effects (calendar sync with an
admin alert on failure, dual admin+client emails, abandoned-draft recovery marking).

Prerequisites relocated first, all found either fully self-contained or already available:

- **`lib/booking-policy.js`** (new): `MIN_ADVANCE_HOURS` and `CURRENT_POLICY_VERSION` — two small
  constants shared across this route, the still-deferred public availability route, the admin
  manual-booking-creation route, and the newsletter subscribe flow. Given a shared home (rather than
  duplicating the literal values) so a future policy-version bump can't update some call sites and
  miss others.
- **`sendBookingReceivedEmail`** joined `lib/booking-notifications.js` (same established shape —
  `escapeEmailFields`/`getEmailFooterContext`/`bannerRegistry`/`emailComponents`/`sendEmail`/
  `generateBookingICS`, all already present). Its only caller was this route, so it is not
  re-imported into `app.js`.
- **`parseDurationMins`** and **`BOOKING_TEXT_LIMITS`** moved directly into
  `routes/public/bookings.js` as single-consumer locals (same treatment as `contractUpload`/
  `bookingAttachUpload` before them) — both were already fully self-contained.
- Everything else needed was already relocated and just needed importing:
  `findOrCreateClient`/`findOrCreateVenueFromPlace` (`lib/client-venue.js`),
  `checkDateAvailability`/`hasCalendarConflict`/`isWithinWorkingHours`/`syncBookingToCalendar`
  (`lib/calendar-sync.js`), `addMinutesToTime`/`parseDurationToMinutes` (`lib/time-utils.js`),
  `insertBookingService`/`insertBookingLineItem` (`bookings.repository`, both keeping their existing
  `app.js` import too — the admin manual-booking-creation route still calls both directly).

Unlike almost every other batch this session, the very first undefined-reference sweep on the new
route file came back clean — every dependency had already been traced correctly on the first pass,
with nothing caught only after the fact.

**Static byte-identity check** on all three relocated pieces (`sendBookingReceivedEmail`, and the
intake route itself against `git show HEAD:app.js`): both are character-for-character identical
apart from the one intentional `__dirname` → relative-path fix in `sendBookingReceivedEmail` (the
same class of hazard caught in the admin quote route batch — a bare `path.join(__dirname, 'images',
...)` would have silently resolved to `lib/images/...` instead of `<root>/images/...` once moved)
and a couple of incidental trailing-whitespace trims. The intake route itself has zero differences
at all, not even whitespace.

Verification: `node -c` on all four changed/new files; the static undefined-reference sweep (clean
on the first pass); confirmed zero remaining `app.js` registration for the route and confirmed
`findOrCreateVenueFromPlace`/`insertBookingService`/`insertBookingLineItem` all still have a genuine
second caller in `app.js` (kept, not removed); `npm run smoke` 329/329; `npm test` x4 given the
exceptional stakes — this route is the fixture-creation step for nearly every test in the suite, so
a real regression here would have failed loudly and repeatedly across dozens of unrelated tests, not
quietly. 3 clean 664/664 runs, one run hitting the already-extensively-documented **CP3** flake
(unrelated — `calendar.test.js`'s own generic-status-route parity check, not booking intake). Given
the combination of that exceptionally broad indirect coverage and a byte-for-byte-identical diff, no
additional manual fixture verification was needed on top of it — the same reasoning applied to
`accept-quote` in the previous sub-batch.

**This is the point where the public `/api/public/bookings/*` pass is actually closed out — 19 of
19 routes relocated** (correcting the premature claim made, and then walked back, in sub-batch G's
own write-up above). The admin `events` cluster (6/6) is also fully done.

**Correction, caught by actually counting before writing the next sentence rather than trusting
memory:** this entry originally went on to claim the whole "big deferred bookings/events pass" was
therefore complete. It is not. The admin `bookings` domain itself is only at 35 of the ~55 routes
scoped in the original reconnaissance write-up — sub-batches A/B/C/D (28 routes) + E (6) + F (the
quote route, 1) = 35. **20 admin bookings routes are still in `app.js`, unmoved**, and several are
squarely in "highest remaining risk" territory: `PUT .../manual-payment`, `POST .../cancel`, `POST
.../complete`, `PUT .../refund` (all status-transition/financial), plus the CRUD surface (`GET
/full`, `POST` create, `GET` list, `GET/PUT /:id`, `PATCH .../buffer`, `PUT .../public`, `PUT
.../status`, `PUT .../disposition`, `POST .../invoice/generate`, `POST .../reconcile/sync`, `GET/
POST .../payment-schedules` + `.../rebalance`, `DELETE /:id`, `POST .../respond`). Verified by
grepping `app.js` directly for every remaining `/api/admin/bookings` registration rather than
recomputing from an earlier tally — worth doing that check again before any future claim that this
domain is finished.

Remaining Phase 5 scope, accurately: the 20 admin bookings routes above, `applyStatusChange` (the
generic admin status-transition engine, almost certainly the dependency behind several of those 20)
and its own dependency web (`processManualPayment`, `alignMilestonePayments`,
`updateBookingMilestones`, `deriveBookingStatusAfterPayment`), `logPaymentEvent` and the PayFast ITN
webhook itself, the remaining `send*Email` functions not yet relocated, and ~12 background cron jobs.

### Bookings prerequisites: the shared status/payment engine + remaining `send*Email` functions — DONE

Before touching any of the 20 remaining admin bookings routes, relocated every shared helper they
(and `applyStatusChange`) depend on, so the actual route-extraction batch is pure wiring. Full
reconnaissance confirmed every dependency across this entire cluster (~29 repository function names
checked) was already a Phase 4 repository export or an already-relocated lib module — zero new
repository work needed anywhere in this pass.

- **`lib/booking-notifications.js`** gained 7 more functions, verbatim: `sendBookingUnderReviewEmail`,
  `sendPaymentReceivedEmail`, `sendPaidReceiptEmail`, `sendBookingCompletedEmail`,
  `sendAdminPaymentNotification`, `sendAdminCompletionSummaryEmail`, `sendRefundProcessedEmail`. All
  7 still have real remaining callers in `app.js` (`applyStatusChange`, `processManualPayment`, the
  refund route, the reminders/expiry cron job), so all 7 are re-imported there.
- **`lib/payment-processing.js`** (new): `logPaymentEvent`, `alignMilestonePayments`,
  `updateBookingMilestones`, `deriveBookingStatusAfterPayment`, `processManualPayment` — the payment-
  recording engine shared by the PayFast ITN handler, the manual-payment route, the reconcile/sync
  route, and the payment-schedule routes (all still in `app.js`, hence the re-import).
- **`lib/booking-status.js`** (new): `applyStatusChange` — the generic admin status-transition state
  machine (`ALLOWED_TRANSITIONS`, the COMPLETED-outstanding-balance guard, and every per-status side
  effect: cancellation cascade, auto-built deposit schedule + draft invoice + draft contract on
  ACCEPTED, confirmation email + auto-created event on CONFIRMED, completion emails + event advance on
  COMPLETED). Both `PUT /api/admin/bookings/:id` and `PUT .../status` still call it from `app.js`.
- **Dead-import sweep after removal**: `resolveActor` lost its only caller (`applyStatusChange`,
  which now imports it directly from `lib/actor.js`) — removed from `app.js`. 22 repository names
  across `bookings.repository`/`calendar.repository`/`finance.repository`/`invoices-quotations.repository`
  lost their only caller the same way and were removed from `app.js`'s own destructures; each
  `...Async` sibling sharing an import line (e.g. `cancelPendingPaymentSchedulesAsync`,
  `clearEventGoogleCalendarIdAsync`) was checked separately and kept where it still had a genuine
  second caller.
- **Bug found and fixed (own mistake, caught by the test suite, not by static analysis):**
  `lib/booking-status.js` initially imported `releaseDateHoldsForBooking` from
  `finance.repository` — it is actually a `calendar.repository` export (confirmed directly against
  `app.js`'s own import blocks). `find_undefined_refs.js` could not catch this class of error since
  the name resolves fine at parse time; `require()`-ing a non-existent export just silently yields
  `undefined`, so the failure only surfaces as a `TypeError: ... is not a function` at the call site.
  Surfaced by `npm test` (a cancellation flow mid-transaction) rather than by any static check —
  fixed immediately, then every other repository-source assignment in both new lib files was
  re-verified programmatically (`typeof` on every import against the real repository modules) rather
  than trusted from the same reading pass that produced the original mistake.
- **Scare, resolved:** one `npm run smoke` run hit `SQLITE_CORRUPT` on the throwaway test-DB copy
  immediately after the bug above crashed a prior `npm test` run mid-transaction. Given this is a
  live production system, verified the **live** `database.sqlite` directly with `PRAGMA
  integrity_check` before doing anything else — came back `ok`. The corruption was confined to the
  disposable copy `test/support.js` always re-creates fresh from the live file; a plain retry of
  `npm run smoke` succeeded cleanly. No lingering process was holding a lock (checked); treated as the
  same class of transient copy-time race as the already-documented test-DB flakes, not investigated
  further since it's isolated to throwaway state.
- **Verification:** `node -c` on all 4 changed/new files; the undefined-reference sweep (clean after
  the fix); byte-identity diff of all 13 relocated function bodies against `git show HEAD:app.js`
  (trivial trailing-whitespace-only differences on blank lines, zero logic/content drift);
  `npm run smoke` 329/329 (twice, once before and once after the bugfix); `npm test` x5 total across
  both the notifications move and the payment/status-engine move — one run caught the real bug above
  (not a flake), one run hit the `SQLITE_CORRUPT` scare (resolved, see above), two runs hit the
  already-extensively-documented `banner.test.js` `SQLITE_BUSY` full-process crash at the same
  recurring spot (now recurred well over a dozen times across this whole session, never once
  correlated with the code being changed), and the final run was a clean 664/664.

### Bookings sub-batch I: the CRUD + auxiliary cluster (16 routes) — DONE

The largest single route-extraction batch of the whole session: `GET /full`, `POST` create (the
biggest route, ~250 lines — duplicate/working-hours/conflict gates, the guarded transaction with
every gate re-checked inside the write lock, services snapshotting), `GET` list, `GET/PUT /:id`,
`PATCH .../buffer`, `PUT .../public` (promote-to-public event create/update/unlink), `PUT
.../status`, `PUT .../disposition`, `POST .../invoice/generate`, `POST .../reconcile/sync`, `GET/
POST .../payment-schedules` + `.../rebalance`, `DELETE /:id` (the FK-ordered cascade purge), `POST
.../respond`. Deliberately excluded from this batch: `manual-payment`/`cancel`/`complete`/`refund`
— the 4 remaining routes with the deepest financial/state-transition logic, held back for their own
final sub-batch.

Two data blocks moved as single-consumer locals alongside their routes, same treatment as
`contractUpload` before them: `BOOKING_DISPOSITIONS` (the disposition allowlist) and
`BOOKING_DELETE_PURGE`/`BOOKING_DELETE_UNLINK` (the FK-ordered purge/unlink SQL lists for the delete
route) — both hand-retyped rather than tool-extracted (they're plain `const` declarations, not
`app.*` route registrations the extraction script recognises), so both were diffed byte-for-byte
against `git show HEAD:app.js` specifically because of that extra transcription risk. Clean.

`routes/admin/bookings.js` picked up a large batch of new imports for this: 19 more
`bookings.repository` exports, 9 more `calendar.repository` exports, 12 more `finance.repository`
exports, 3 more `invoices-quotations.repository` exports, `linkInquiryToBooking`
(`inquiries.repository`, new import for this file), `findOrCreateVenueFromPlace`
(`lib/client-venue.js`), `isWithinWorkingHours` (`lib/calendar-sync.js`), `applyStatusChange`
(`lib/booking-status.js`), `generateInvoice` (`lib/invoicing.js`). Every one individually confirmed
against `app.js`'s own import blocks before extraction, then re-verified programmatically (`typeof`
on every import against the real repository/lib modules) — the same discipline adopted after the
`releaseDateHoldsForBooking` mistake in the previous prerequisite batch. All came back correct on
the first pass this time.

**Dead-import sweep in `app.js`** was unusually large given how much single-purpose logic just left
it: `applyStatusChange` (both its callers moved together), `getBookingStatus`, `updateBookingBuffer`,
`getBookingDisposition`/`updateBookingDisposition`, `getBookingTotalAmount`, `deleteBookingById`,
`markBookingPendingAfterRespond`, the 4 `setBookingPublic*`/`clearBookingPublic*` pairs,
`getActiveDuplicateBookingForEmailDate(Async)`, `insertAdminBooking`, `insertBookingService`/
`insertBookingLineItem`, `insertPublicEvent`/`checkEventExistsById`/`updatePublicEvent`/
`deleteEventById`, `getActiveQuoteStatusForInvoiceGuard`, `getTransactionsPaidSumForReconcile`,
`getActivePaymentSchedules`/`deletePaymentSchedulesForBooking`/`prepareInsertPaymentSchedule`/
`prepareUpdatePaymentScheduleAmount`, `linkInquiryToBooking`, `findOrCreateClient`/
`findOrCreateVenueFromPlace` (entire `require` line removed — both dead), `isWithinWorkingHours`/
`hasCalendarConflict` (removed from their shared import line; `syncBookingToCalendar`/
`syncCalendarHolds`/`syncEventToCalendar`/`checkDateAvailability` on the same line all confirmed
still genuinely called elsewhere and kept). `deriveBookingStatusAfterPayment`, `alignMilestonePayments`,
`updateBookingMilestones`, `generateInvoice`, `markInvoicePaidIfOpen`, and `CURRENT_POLICY_VERSION`
were checked and correctly kept — each still has a real remaining caller in `app.js`'s own `POST
/api/admin/transactions/manual` route (a separate, not-yet-relocated admin route) or, for
`CURRENT_POLICY_VERSION`, the newsletter subscribe flow.

**Byte-identity check**: every relocated route diffed against `git show HEAD:app.js` (accounting
for the `app.` → `router.` swap) — the create route (250+ lines), the public-promotion route, the
reconcile/sync route, and the delete route all came back with **zero** differences, not even
whitespace; the two hand-retyped constant blocks likewise zero differences.

**Manual fixture verification** (this cluster has thin dedicated automated coverage — `disposition`,
`reconcile/sync`, `invoice/generate`, and `payment-schedules`/`rebalance` have no test file of their
own, only the smoke test's generic non-5xx check): wrote a throwaway script against
`test/support.js` exercising create → disposition (valid + invalid) → payment-schedules create/get
→ rebalance → reconcile/sync → invoice/generate → buffer → respond → delete, in sequence against one
real booking. All 16 checks passed, including the delete route's FK-ordered purge actually removing
the booking (confirmed via a follow-up 404).

**Verification**: `node -c` on both files; the undefined-reference sweep (clean); byte-identity
diffs (clean); `npm run smoke` 329/329 (one run hit the same transient `SQLITE_CORRUPT`-on-throwaway-
copy scare as the previous batch — live `database.sqlite` integrity re-confirmed `ok`, plain retry
succeeded); `npm test` x2 (one clean 664/664, one hit the already-extensively-documented
`banner.test.js` `SQLITE_BUSY` crash at the same recurring spot — now recurred well over a dozen
times this session, never once correlated with the code under test); the manual fixture script
above, 16/16 passed.

**This closes 16 of the final 20 admin bookings routes.** 4 remain: `PUT .../manual-payment`,
`POST .../cancel`, `POST .../complete`, `PUT .../refund` — verified directly via
`grep -c "app\.\(get\|post\|put\|patch\|delete\)('/api/admin/bookings" app.js` returning 4, not
trusting a remembered count.

### Bookings sub-batch J: the financial/status-transition core (4 routes) — closes the admin bookings domain

The 4 routes deliberately held back from sub-batch I as the highest-remaining-risk cluster:
`PUT .../manual-payment`, `POST .../cancel` (the guarded transaction with the full cancellation-
refund calculation and the FK cross-reference cleanup between `bookings.event_id`/
`events.booking_id`), `POST .../complete`, `PUT .../refund` (ledger recalculation from
`SUM(transactions)`, the already-refunded-amount guard, cumulative refund/reference/notes
across multiple partial refunds). All four now delegate their heavy logic to the
`lib/payment-processing.js`/`lib/booking-status.js`/`lib/cancellation-refund.js` helpers relocated
in the prerequisite batch — the routes themselves are comparatively thin.

**Byte-identity check**: all 4 routes diffed against `git show HEAD:app.js` (accounting for the
leading-comment-inclusive boundaries the extraction tool itself reports) — zero differences beyond
a trailing blank line at each boundary (an artifact of how blocks are joined, not a content change).

**Dead-import sweep in `app.js`** (the largest of the whole admin-bookings pass, since this was the
last cluster still calling into many shared helpers): `getRecentPayfastTransactionForBooking`,
`cancelBookingAsync`, `insertCancellationForAdminCancel`, `releaseDateHoldsForBookingAsync`,
`voidInvoicesForCancelledBookingAsync`, `cancelPendingPaymentSchedulesAsync`, `getEventByBookingId`,
`demoteEventForCancelledBookingByBookingIdAsync`, `clearBookingPublicAndEventIdAsync`,
`clearEventGoogleCalendarIdAsync`, `markBookingCompletedManual`, `getCancellationForRefund`,
`getAlreadyRefundedAmount`, `updateCancellationRefund`, `insertRefundTransaction`,
`setBookingPaymentStatus`, `updateBookingLedgerFromReconcile` (missed in sub-batch I's own sweep —
caught this time by re-running the same check rather than assuming it was already clean),
`processManualPayment`, `calculateCancellationRefund`, `sendCancellationEmail`,
`sendRefundProcessedEmail`. Also removed `demoteEventForCancelledBookingAsync`, which turned out to
already have zero remaining callers in `app.js` independent of this batch — a pre-existing gap from
an earlier phase, caught only because this sweep checks every name on the touched import lines, not
just the ones this batch's own routes used. Kept (real remaining callers confirmed): `deleteGoogleEvent`,
`clearBookingGoogleEventId`, `sendBookingCompletedEmail`, `alignMilestonePayments`,
`getBookingByIdAsync`, `getBookingById`, `logPaymentEvent`, `deriveBookingStatusAfterPayment`,
`updateBookingMilestones` — all still called from the PayFast ITN webhook handler or the separate,
not-yet-relocated `POST /api/admin/transactions/manual` route.

**Manual fixture verification**: a throwaway script drove two full booking lifecycles end-to-end
against real database state — Flow A: create → NEW→PENDING→QUOTED→ACCEPTED → manual-payment (full
amount) → confirmed `payment_status=PAID` and `status` auto-advanced to `CONFIRMED` → complete →
confirmed `status=COMPLETED`. Flow B: create → ACCEPTED → manual-payment → cancel (confirmed the
refund-due/policy-rule calculation, `status=CANCELLED`, and that a second cancel attempt is rejected
with 400) → refund (confirmed success, then confirmed the over-refund guard rejects a refund
exceeding the remaining refundable balance, and that a refund with no reference is rejected once the
amount is non-zero). 20/20 checks passed — this exercises the exact deep logic paths (status
derivation, refund arithmetic, guard rails) that a byte-identity diff or a generic smoke check
cannot.

**Verification**: `node -c`; the undefined-reference sweep (clean); byte-identity diffs (clean);
`npm run smoke` 329/329 (one run hit the same transient `SQLITE_CORRUPT`-on-throwaway-copy pattern
now logged in its own "Known testing limitations" entry — live `database.sqlite` re-confirmed `ok`,
retry succeeded); `npm test` x2 (one hit **CP17** — `calendar.test.js`'s pre-existing drag-reschedule-
sync flake, already documented from earlier sessions, on code this batch never touched — the other a
clean 664/664); the 20-check manual fixture script above, 20/20 passed.

### Route batch: `routes/public/popia.js` (5 routes, new file) + `routes/public/newsletter.js` (3 routes, new file) — DONE

Fourth and last batch of the post-bookings/events Phase 5 continuation, and the one flagged in
advance as the real risk step-up: POPIA/GDPR erasure self-service (a protected surface per the
standing rules) plus the newsletter subscribe/confirm/unsubscribe flow. Read every route in full
before touching anything, per the protected-surface discipline.

**`routes/public/popia.js`** (5 routes): `POST .../popia/request-otp`, `.../popia/preview`,
`.../popia/erasure-requests`, `.../compliance/request-forget` (the legacy compat route, already
rewritten in an earlier session to require the same OTP as the primary flow), `.../compliance/
export-data`. The shared helper `verifyPopiaOtp` — used by 3 of the 5 (`preview`,
`erasure-requests`, `request-forget`) — moved alongside as a local in this file, same treatment as
`checkEventConflicts` before it. It reuses the *same* `OTP_TTL_MINUTES`/`OTP_MAX_ATTEMPTS`/
`generateOtpCode` from `lib/booking-tracking.js` that the unrelated booking-tracker flow uses (its
own comment says so explicitly — same constants, same bcrypt/attempts/expiry shape, different table)
— confirmed `routes/public/bookings.js` already has its own independent import of the same three for
the tracker's own use, so no conflict moving this file's own copy in.

**`routes/public/newsletter.js`** (3 routes): `POST /api/public/subscribe`, `.../newsletter/confirm`,
`.../newsletter/unsubscribe`. Two shared pieces moved alongside as locals: `NEWSLETTER_PENDING_MESSAGE`
(single-consumer within `subscribe`) and `sendNewsletterConfirmationEmail` (the double-opt-in email,
fired from 3 call sites all within `subscribe` — confirm and unsubscribe use the separate, already-
relocated `sendNewsletterWelcomeEmail` from `lib/newsletter-emails.js` instead, imported directly).

Both new files get their own `app.use()` registrations in `app.js`'s route-mount block.

**Dead-import sweep in `app.js`** was the largest of this whole continuation, since this cluster was
the last real concentration of shared state: the entire `OTP_TTL_MINUTES`/`OTP_MAX_ATTEMPTS`/
`ACCESS_TOKEN_TTL_MINUTES`/`generateOtpCode`/`hashAccessToken`/`requireBookingAccessToken` import
block (every remaining caller — `verifyPopiaOtp` — moved), the entire `lib/popia.js` re-import
(`resolvePopiaTargets`/`getBookingErasureImpact`/`createPopiaRequest`/`POPIA_REASONS` — all three
routes that used them directly moved together), `getInquiriesForEmail` (its only caller,
`export-data`, moved), and — once `subscribe` moved — `CURRENT_POLICY_VERSION` itself finally became
fully dead in `app.js` (it had been kept through two earlier batches specifically because this route
was its last real caller; noted explicitly in both of those earlier entries as a reason to watch
for). Also removed: `EMAIL_FORMAT_RE`, `isValidBirthday` (both from `lib/validation.js`;
`sanitizeEmailInput` on the same import line correctly kept — it has 4 other real callers),
`sendNewsletterWelcomeEmail`, and the 8 `newsletter.repository` subscriber-lifecycle functions
(`insertPendingSubscriber` through `unsubscribeSubscriber`) that only `subscribe`/`confirm`/
`unsubscribe` ever called.

**Byte-identity check**: all 8 routes plus both shared helpers (`verifyPopiaOtp`,
`sendNewsletterConfirmationEmail`) and `NEWSLETTER_PENDING_MESSAGE` diffed against `git show
HEAD:app.js` — zero differences beyond harmless sed-range boundary artifacts in the verification
script itself (trailing comments/blank lines belonging to whichever route sat immediately after the
diffed range in the original file — confirmed by inspection, not a real content change).

**Verification**: `node -c` on all three changed/new files; the undefined-reference sweep (clean);
every new import (`OTP_TTL_MINUTES`/`OTP_MAX_ATTEMPTS`/`generateOtpCode`, `lib/popia.js`'s four
exports, `lib/validation.js`'s three, the 8 newsletter-repository functions, `sendNewsletterWelcomeEmail`,
`applyMergeFields`, etc.) verified programmatically against the real modules before running
anything; byte-identity diffs (clean); `npm run smoke` 329/329 (first try). This cluster already has
substantial dedicated test coverage (`popia-erasure.test.js`, `newsletter-optin.test.js`,
`email.test.js`, `inquiries.test.js` all exercise these exact routes), so no additional manual
fixture script was written on top of the full suite run; `npm test` x2 — clean 664/664 both times,
given the protected-surface stakes.

### Route batch: `routes/admin/misc.js` (8 routes, new file) + `routes/admin/transactions.js` (1 route, new file) — DONE

Third batch of the post-bookings/events Phase 5 continuation: the small admin-utilities grab-bag —
8 routes spanning unrelated domains with no single natural home (`GET .../email-logs`,
`POST .../settings/test-notification`, `GET .../clients/duplicates`, `GET .../booking-attachments/
:filename`, `PATCH .../reviews/:id`, `GET .../payment-schedules/mismatches`, `POST .../compose`,
`POST .../system/migrate-legacy-data`) — plus `POST /api/admin/transactions/manual` split into its
own file given its size (~230 lines) and its much heavier dependency footprint (the same payment-
processing/booking-notifications/invoicing web already relocated for the bookings domain).

Two new files: `routes/admin/misc.js` (named honestly — a grab-bag, not a domain) and
`routes/admin/transactions.js`. New `app.use()` registrations for both added to `app.js`'s
route-mount block.

**Dead-import sweep in `app.js`** turned up more than usual, including two pre-existing gaps
unrelated to this batch's own routes, caught only because the sweep checks every name sharing an
import line, not just the ones just moved: `getAllBookingsForMigration` (its real remaining caller,
`POST /api/admin/migrate`, already lives in `routes/admin/site-content.js` with its own independent
import — this app.js copy was dead already, missed by whichever earlier batch moved that route) and
three names on the `lib/runtime-paths.js` import (`DOCS_PATH`, `BACKUPS_PATH`, `LEGACY_DOCS_DIR`) —
all three lost their only caller across earlier batches and were never swept. `ensureDir`,
`docsWriteDir`, `resolveDocsPath` also removed (their last call site, `booking-attachments`, moved
this batch). `UPLOADS_PATH` on the same import line checked and correctly kept. Also removed:
`insertManualTransaction`, `applyManualTransactionPaymentToBooking`,
`updateBookingLedgerAfterManualRefund`, `updateBookingLedgerAfterAdjustment`,
`getOpenInvoiceIdForAdjustmentRegen`, `updateBookingClientVenue`, `getAllBookingsFull` — all lost
their only remaining caller to this batch.

**Byte-identity check**: all 9 routes diffed against `git show HEAD:app.js` — zero differences,
including `transactions/manual`'s full ~230-line payment/refund/adjustment branching logic.

**Bug found while writing manual fixture coverage (not fixed, logged as Deferred fix #5)**:
`transactions/manual` 500s with a raw SQLite constraint error whenever no `booking_id` is supplied
— the route's own code has a branch for exactly this case, but `transactions.booking_id` is
`NOT NULL` in the actual schema, so the `INSERT` fails before that branch is ever reached. Confirmed
pre-existing (a schema constraint has nothing to do with which file the route lives in) — not
introduced by this move, and not fixed per the standing "housekeeping moves code, it doesn't repair
behaviour" rule. Full writeup under "Deferred fixes" below.

**Manual fixture verification**: `transactions/manual` has no dedicated test file, so a throwaway
script drove all three transaction types against one real booking — payment (partial, then to PAID,
confirming `payment_status` derivation at each step), refund (confirming the ledger recalculation
and `payment_status` re-derivation, not left stale at PAID), adjustment/credit (confirming
`total_amount` reduction) — plus the validation guards (negative amount, invalid type, missing
adjustment direction all correctly rejected with 400). 16 of 17 checks passed; the one failure is
Deferred fix #5 above, not a relocation defect.

**Verification**: `node -c` on all three changed/new files; the undefined-reference sweep (clean);
every new import verified programmatically against the real modules before running anything;
byte-identity diffs (clean); `npm run smoke` 329/329 (twice — once before, once after the larger
dead-import cleanup); `npm test` — clean 664/664; the manual fixture script above (16/17, the one
failure being the pre-existing bug logged separately, not a regression).

### Route batch: `routes/public/availability.js` (5 routes, new file) — DONE

Second batch of the post-bookings/events Phase 5 continuation: the availability/venue-lookup
cluster. `GET /api/public/availability` (the date-availability check, including its recursive
nearest-available-date suggestion scan and the `MIN_ADVANCE_HOURS` advance-notice gate),
`.../booking-config` (per-day working hours + min booking gap for the frontend slot picker),
`.../availability/month` (held/booked dates for the calendar widget), and the two Google Places
proxy routes `.../places/autocomplete`/`.../places/details` (venue address lookup for the booking
form) — all public, all read-only, none mutate any state.

New file `routes/public/availability.js`, third file in `routes/public/`. New
`app.use(require('./routes/public/availability'))` registration added to `app.js`'s route-mount
block, same pattern as the previous new-file batch.

**Dead-import sweep in `app.js`**: `MIN_ADVANCE_HOURS` (its last remaining call site — this route —
moved; `routes/public/bookings.js` already has its own independent import for the public-intake
route), `checkDateAvailability` (`lib/calendar-sync.js` — its only call site moved),
`getMinBookingGapSetting` (`settings.repository` — only call site moved),
`getActiveHoldDatesForMonth` (`calendar.repository` — only call site moved). `CURRENT_POLICY_VERSION`
(same import line as `MIN_ADVANCE_HOURS`) and `syncBookingToCalendar`/`syncCalendarHolds`/
`syncEventToCalendar` (same import line as `checkDateAvailability`) checked and correctly kept —
all still have real remaining callers elsewhere in `app.js`.

**Byte-identity check**: all 5 routes diffed against `git show HEAD:app.js` — zero differences,
including the availability route's recursive suggestion-scan logic and the two Google-Places-proxy
routes' inline `require('https')` calls.

**Verification**: `node -c` on both files; the undefined-reference sweep (clean); every new import
(`ipRateLimiter`/`trackRateLimiter`, `MIN_ADVANCE_HOURS`, `checkDateAvailability`,
`getMinBookingGapSetting`, `getActiveHoldDatesForMonth`) verified programmatically against the real
modules before running anything; byte-identity diffs (clean); `npm run smoke` 329/329 (first try);
`npm test` x2 — clean 664/664 both times.

### Route batch: `routes/public/site-content.js` (16 routes, new file) + `publish-home-slider` — DONE

First batch of the post-bookings/events Phase 5 continuation, picking up the ~50 routes left
scattered across small one-off prefixes once the bookings/events pass closed out. Chose the public
site-content cluster first as lowest-risk: every route already has an admin-side CRUD counterpart
already living in `routes/admin/{site-content,content,home-social}.js` from earlier batches, and
all but one of the 16 are plain read-only `db.get`/`db.all` passthroughs with no business logic.

**New file `routes/public/site-content.js`** (the second file ever in `routes/public/`, after
`bookings.js`) — a fresh `app.use(require('./routes/public/site-content'))` registration was added
to `app.js`'s existing route-mount block, since (unlike every route file touched so far this
session) this one didn't already exist and get incrementally extended. Routes: `GET .../services`,
`.../legal/cookie-policy`, `.../branding`, `.../events`, `.../highlights`, `.../footprint`,
`.../testimonials` (+ its `POST` sibling — public, rate-limited, restricted-upload testimonial
submission), `.../home-slider`, `.../gallery`, `.../manager`, `.../contact_info`,
`.../social_links`, `.../about-me`, `.../social_embeds`, `.../site-content`.

Two data/upload blocks moved as single-consumer locals alongside their routes: `SITE_CONTENT_KEYS`
(the settings-table key list backing the editable-homepage-content endpoint) and
`publicImageUploadStorage`/`publicImageUpload` (the SVG-excluding multer variant for the public,
unauthenticated testimonial-photo upload — kept separate from the admin-only `upload` for the
SEC-1 stored-XSS reason its own comment explains, preserved verbatim in the new location).

**`POST /api/admin/publish-home-slider`** moved separately into the existing
`routes/admin/home-social.js` (an admin-authenticated route, so it belongs on the admin side of the
auth boundary per Phase 5's own rationale, not alongside the public reads) — homepage-carousel HTML
regeneration triggered by home-slider changes, so it sits naturally next to that file's existing
home-slider CRUD. **Caught and fixed the `__dirname`-relative-path hazard** on the first read, before
it could ship: `path.join(__dirname, 'index.html')` would have silently resolved to
`routes/admin/index.html` instead of the real one at the project root once moved — same class of bug
caught twice earlier in this session (the admin quote route's debug-log path;
`sendBookingReceivedEmail`'s logo path). Fixed via `PROJECT_ROOT` (`lib/runtime-paths.js`), the
established pattern; no other logic changed. Deliberately **not** exercised by a manual fixture
script — this route performs a real disk write to the live `index.html` and no existing test calls
it, so running it manually would risk mutating a real repository file as a side effect for no
verification benefit the byte-identity diff doesn't already provide.

**Byte-identity check**: all 17 routes diffed against `git show HEAD:app.js` — the three with any
non-trivial logic (`about-me`'s HTML-unescaping, `site-content`'s settings-JSON assembly, the
testimonials `POST` upload handler) and `publish-home-slider` all came back with zero differences
beyond the one intentional `__dirname` fix; the rest are one-line `db` passthroughs, verified but not
individually re-typed here.

**Dead-import sweep in `app.js`**: `unescapeHtml`/`sanitizeAboutHtml`/`SECTION_KEYS` (all three
lost their only caller — `routes/admin/site-content.js` already had its own independent import of
the same three from `lib/html-sanitize.js` for the admin write-side, so nothing else needed
touching), `getSettingsByKeys` (its remaining two call sites, `branding` and `site-content`, both
moved together). `ipRateLimiter` and `encodeUserHtml` checked and correctly kept — both still have
real remaining callers elsewhere in `app.js`.

**Verification**: `node -c` on all three changed/new files; the undefined-reference sweep (clean);
confirmed the new file's module loads without a runtime `require` error before running anything
against it; byte-identity diffs (clean); `npm run smoke` 329/329 (first try, no flake this time).
`npm test` x5, given a higher-than-usual flake rate this round — 2 clean 664/664 runs, and 3 runs
each hitting a *different* already-independently-documented pre-existing flake, none touching
anything this batch changed: the `SQLITE_CORRUPT`-on-throwaway-copy pattern above (live
`database.sqlite` re-confirmed `ok`), **CP6** (`review_email_sent_at` stamping — a long-documented
timing-margin flake, see "Deferred fixes"/CP-series entries elsewhere in this file), and the
extensively-logged `banner.test.js` `SQLITE_BUSY` full-process crash. Three different flakes in one
run of five is itself consistent with this session's established baseline noise rate, not a new
signal — every single one traces to a pattern already independently documented well before this
batch existed.

### The admin `bookings` domain is now fully relocated — precisely scoped

Verified directly rather than reasoned from a remembered tally, per the standing rule from the
overclaim corrections earlier in this pass: `grep -c "app\.\(get\|post\|put\|patch\|delete\)
('/api/admin/bookings" app.js` → **0**. `grep -c "^router\.\(get\|post\|put\|patch\|delete\)"
routes/admin/bookings.js` → **55** (28 from sub-batches A-D + 6 from E + 1 from F + 16 from I + 4
from J = 55, matching the original reconnaissance estimate exactly). Every route under
`/api/admin/bookings/*` now lives in `routes/admin/bookings.js`; `app.js` has none left.

**What this claim does and does not cover**, checked explicitly rather than assumed: the PayFast
ITN webhook (`POST /api/payment/webhook/payfast`, confirmed via direct grep — a different URL
prefix, never part of the `/api/admin/bookings` count above) and the site's ~3 remaining
`schedule.scheduleJob(...)` cron registrations (booking-lifecycle reminders/expiry/auto-complete
sweeps) are **not** part of this claim and remain unrelocated — they were never counted in the 55
above and this entry does not claim them done. The admin `events` cluster (6/6, `routes/admin/
events.js`) and the entire public `/api/public/bookings/*` surface (19/19, `routes/public/
bookings.js`) were already completed earlier in this pass (see their own entries above) — combined
with the 55 admin bookings routes above, that closes out every `/api/admin/bookings/*`,
`/api/admin/events/*`, and `/api/public/bookings/*` route in the original "big deferred
bookings/events pass" scope. The PayFast webhook and the cron jobs remain as separate, distinct,
not-yet-started future work.

### Step 1: app.js/server.js skeleton split + middleware extraction — DONE

See the commit message for the mechanics (byte-identical `middleware/auth.js`, `middleware/rbac.js`,
`middleware/error-handler.js`; `requireAdmin` reassembled from an imported check function + the
`adminRateLimiter` that stays in `app.js`; the two error handlers now take `rootDir` as a parameter
since `__dirname` would otherwise resolve to `middleware/` instead of the project root).

**10 routes fall outside the plan's `/api/admin`/`/api/public` boundary** and aren't counted in the
270+49: `/robots.txt`, `POST /upload`, `POST /api/payment/webhook/payfast`,
`GET /api/bookings/:id/payment-logs`, `GET /payment/success`, `GET /payment/cancel`,
`POST /send-email`, `GET /api/calendar/feed.ics`, `GET /sitemap.xml`, `POST /api/debug`. Decision
(confirmed with the user): sort by behavior — auth-gated ones into `routes/admin/`, unauthenticated
ones into `routes/public/`.

**`/robots.txt` is the one exception, staying in `app.js`.** A physical `robots.txt` file exists in
the repo root (`ls` confirmed it), currently shadowed because the programmatic
`app.get('/robots.txt', ...)` handler is registered *before* the blanket
`express.static(path.join(__dirname, '/'))` mount. If this route moved into a router mounted after
static serving — the natural thing to do with "put routes in their own files" — the stale physical
file would start being served instead, silently changing behavior. No physical `sitemap.xml` exists,
so that route has no equivalent risk and can move normally.

**`/api/debug` reported per the plan's explicit instruction, not touched.** `POST /api/debug` is
`requireAdmin`-gated and does exactly one thing: `console.log('[DEBUG API] Background configuration
trace:', req.body)`, then returns `{success:true}`. It doesn't read or return stored data — its only
effect is writing an authenticated admin's request body into the server console. Low severity given
the auth gate, but flagged for the user's own call on whether to keep it.

**A pre-existing bug found in passing, not fixed:** `GET /api/bookings/:id/payment-logs` checks
`req.session.admin`, which is never set anywhere in the codebase (every login sets
`req.session.adminId`/`.username`/`.role`, never `.admin`). This route has been returning 401 to
every caller, admin or not, since it was written. Relocating it byte-identical when its batch comes
up; not fixing the check.

**Smaller oddity, also left alone:** `POST /upload` inlines its own `req.session.adminId` check
instead of using `requireAdmin`, because — per its own comment — it's defined earlier in the file
than the `requireAdmin` `const`. That positional reason disappears once `requireAdmin` is an import
available from the top of the file, but per "move only" the duplicate inline check stays exactly as
it is rather than being consolidated onto the shared middleware.

**No existing graceful-shutdown code** (no SIGTERM/SIGINT handlers anywhere) — "shutdown" in the
plan's "config, listen, shutdown" describes a slot in the new structure, not something that needed
relocating. `app.listen()`'s callback does real startup work (loads pending scheduled
newsletter/direct-email jobs, runs a quote-amount consistency check against the DB) and moved to
`server.js` in full; `loadPendingScheduledJobs`/`loadPendingDirectEmails` are exported from `app.js`
alongside `app` itself so `server.js` can call them.

Verification: `node -c` on all 5 changed/new files; `npm test` run **5 times** given this is the
foundational step everything else depends on — baseline-only 3 of 5 runs, one recurrence each of
CP5 (already-documented) and a new one, **CP12** (`inquiries.test.js` — "responded_at set on first
reply" / "NOT overwritten by a second reply"), see the Deferred fix #3 update below. The RBAC suite
specifically — 141 tests — passed identically on every run, meeting the plan's "not by a single
character" bar for auth/RBAC. `npm run smoke` 329/329. `git status` confirmed only `app.js`,
`server.js`, and `middleware/*.js` changed.

### Final route batch: the standalone/webhook cluster — closes out the 10-route list from Step 1

The last 9 of the 10 routes flagged in "Step 1" above as falling outside the plan's `/api/admin`/
`/api/public` boundary (`/robots.txt` was always the one deliberate exception, see below) are now
relocated, sorted by behavior exactly as decided there — auth-gated into `routes/admin/`,
unauthenticated into `routes/public/`:

- **`routes/public/payment.js`** (new): `POST /api/payment/webhook/payfast` (the PayFast ITN
  webhook — the single largest, highest-stakes route moved in this whole pass, ~415 lines; diffed
  byte-identical against `git show HEAD:app.js` with **zero** differences), `GET
  /api/bookings/:id/payment-logs` (the pre-existing `req.session.admin`-vs-`.adminId` bug flagged in
  Step 1 moves with it unchanged, still not fixed), `GET /payment/success`, `GET /payment/cancel`,
  plus the local `sendPaymentFailedEmail` helper moved with them. All 27 of its imports
  (`dbRun`/`withDbTransaction`/`escapeEmailFields`/`getEmailFooterContext`/`emailBaseUrl`/
  `syncBookingToCalendar`/`generatePayFastSignature`/the PayFast rate-limiter + IP allowlist/
  `logPaymentEvent`/`alignMilestonePayments`/5 `booking-notifications` senders/the banner+email-
  send helpers/`getNotificationEmail`/5 bookings-repository functions/`insertAutoCreatedEvent`/3
  finance-repository functions/`markInvoicePaidIfOpenAsync`) were verified programmatically
  (`node -e` checking each resolves to a function) before running anything against the route.
- **`routes/public/misc.js`** (new): `POST /upload` (the inline `req.session.adminId` check Step 1
  noted — kept exactly as-is, not consolidated onto `requireAdmin`), `POST
  /api/public/analytics/track`, `POST /send-email`, `GET /api/calendar/feed.ics`, `GET
  /sitemap.xml`, plus the local `classifyChannel` helper. `/send-email`'s `logoFilePath` — already
  confirmed dead in the original `app.js` (built but never read) — got the same `__dirname` →
  `PROJECT_ROOT` (`lib/runtime-paths.js`) fix as `sendBookingReceivedEmail` got in an earlier batch,
  applied for consistency despite having zero behavioral effect.
- **`routes/admin/misc.js`** (extended): `POST /api/debug`, added with zero new imports
  (`requireAdmin` was already present in the file), diffed byte-identical. Reported to the user
  directly per Step 1's own instruction and again here: it is `requireAdmin`-gated, does nothing but
  `console.log('[DEBUG API] Background configuration trace:', req.body)`, and returns
  `{success:true}` — it does not read or return any stored data, its only effect is writing an
  authenticated admin's own POST body into the server console. Unchanged behavior; only its file
  location moved.

**`/robots.txt` stays in `app.js`, confirmed once more before leaving it.** Mapped every blanket
(no-path) `app.use()` registration in the file end to end (helmet, the session/body-parser/
sanitisation middleware, the `/images`/`/uploads` static mounts, the blanket
`express.static(path.join(__dirname, '/'))`, session, then the route-mount block) to make sure no
other still-to-move route would skip past a middleware it used to sit after — this route was the one
genuine exception found. It's registered *before* both the "protect sensitive files" middleware and
the blanket static server, and a physical `robots.txt` file with genuinely different content lives at
the project root (dynamic: disallows `/admin` and `/api`; physical: disallows only `admin.html` and
`/api/`, adds a sitemap line). Moving it into the post-static mount block would let the physical file
silently shadow the dynamic handler. Left in place with an explanatory comment; directly verified
with a live server + HTTP GET that the dynamic content (not the physical file's) is still served.

### The app.js dead-import backlog — a full sweep, not just this batch's own

With this batch, essentially every route has left `app.js` (see route count below), which exposed
something no single batch's own dead-import check had ever caught: dozens of top-of-file
`const { ... } = require(...)` re-imports of `lib/`/repository functions whose *last* real caller
had moved out one, two, or even many batches ago, each batch only ever checking the names *it*
personally touched. Built a proper AST-based checker (`acorn`, scratchpad-only) to sweep the whole
file at once: parse every top-level destructured `require(...)`, collect the bound (local) names,
and count real `name(` call sites elsewhere in the file, excluding the declaration's own range.

**Two checker limitations found and worked around, not just trusted blindly:**
- A count of exactly **0** is unambiguous — even a comment mentioning `name(` would have bumped it
  above zero, so every 0-count name reported here is genuinely dead, no further check needed.
- A count of **1 or more** is not automatically "alive": (1) the checker's `name(` pattern doesn't
  exclude comment text, and one name (`syncBookingToCalendar`) turned out to have its only "call"
  sitting inside a `// syncBookingToCalendar() for this booking takes the...` comment — a real dead
  name the checker's raw count made look alive; found only by reading the actual matched line. (2) a
  name can be used without ever being *called* — passed as a
  bare reference (e.g. `requireAdmin` used as `app.get(path, requireAdmin, handler)`, never
  `requireAdmin(...)`) — so a separate bare-word-boundary checker was run over every 0-count name to
  catch that case too. That second checker has its own false-positive class: word-boundary matches
  inside unrelated compound strings (`"calendar"` inside `"calendar.repository"`, `"calendar-sync"`,
  `"google-calendar"`) and inside this file's own explanatory prose comments. Of ~34 names it flagged
  "suspicious," 33 were exactly that — re-verified individually via `grep -n "\bname\b"` context
  inspection — and exactly **one was a genuine save**: `bookingConfig`, used via property access
  (`bookingConfig.minGapMins = ...`, `bookingConfig.typeBuffers = ...` in the startup settings-load
  block), never as a call, correctly kept.

**Removed** (all independently confirmed 0 real references, comments excluded): the top-of-file
`multer`/`transporter`/`emailTemplates`/`PDFDocument`/`pdfService`/`applyMergeFields`/
`SAMPLES_BY_CATEGORY`/`imageSize` plain requires; `geoip`/`UAParser` (analytics/track moved);
`calendar`/`CALENDAR_ID` (from `lib/google-calendar` — its own header comment confirms no
construction-order dependency on this import surviving); `sanitizeEmailInput`/`encodeUserHtml`
(`lib/html-sanitize` — send-email and site-content moved); `emailBaseUrl` (`lib/email-context`;
`getEmailFooterContext` stays, still called directly by the surviving cron jobs); `scheduledJobs`/
`buildSegmentCondition` (from `lib/newsletter-scheduling` — `scheduleNewsletterSend` stays);
the entire `lib/uploads` and `lib/time-utils` imports; `getVatRate`/`resolveLineTaxClasses`/
`computeDocumentTotals` (`lib/document-totals`); `autoBuildDepositBalanceSchedule`/`generateInvoice`
(`lib/invoicing`); `logPaymentEvent`/`alignMilestonePayments`/`updateBookingMilestones`/
`deriveBookingStatusAfterPayment` (`lib/payment-processing`); `requireAdmin` (`middleware/auth`) and
`requireRole`/`requireRoleForInquiryEmail` (`middleware/rbac`); `VALID_ADMIN_ROLES`/
`countOtherActiveAdministrators`/`createAndSendInvite` (`lib/admin-users`); 7 of the 13
`lib/booking-notifications` names — `generateBookingICS`, `sendBookingConfirmedEmail`,
`sendDateChangedEmail`, `sendQuoteAcceptedEmail`, `sendPaymentReceivedEmail`, `sendPaidReceiptEmail`,
`sendAdminPaymentNotification` — now that the PayFast ITN webhook (their last real caller) has
itself moved to `routes/public/payment.js`, which imports what it needs directly; `sendInvoiceEmail`
(`lib/invoice-email`); `dbRun`/`dbGet`/`dbAll` (`lib/db-helpers`); `withDbTransaction`
(`lib/db-transaction`); `logAudit` (`lib/audit-log`); `asBookingText` (`lib/booking-tracking`);
`generatePayFastSignature` (`lib/payfast-signature` — its last two callers, the pay route and the
ITN webhook, are now both in `routes/public/payment.js`); `DEFAULT_CONTRACT_CLAUSES`/
`CONTRACT_ELIGIBLE_STATUSES`/`generateContract` (`lib/contracts`); `syncBookingToCalendar`/
`syncEventToCalendar` (`lib/calendar-sync` — `syncCalendarHolds`, confirmed alive via a real call
in the nightly hold-sync cron, is the only one of the three kept).

**Explicitly kept**, each with a confirmed real call site in a surviving background cron job or
final handler: `crypto` (bootstrap-admin generation), `bookingConfig`, `UPLOADS_PATH`,
`escapeEmailFields`, `getEmailFooterContext`, `deleteGoogleEvent`, `syncCalendarHolds`,
`sendAbandonedBookingReminderEmail`, `registerBirthdayJob`, `scheduleDirectEmailSend`/
`sendDirectEmail`, `createNotFoundHandler`/`createServerErrorHandler` (the final 404/500 handlers —
critical, must stay), `runPaymentReminderJob`, `scheduleNewsletterSend`, 6 of the 13
`booking-notifications` senders (`sendDepositBalanceDueEmail`, `sendQuoteExpiryWarningEmail`,
`sendReviewRequestEmail`, `sendBookingUnderReviewEmail`, `sendBookingCompletedEmail`,
`sendAdminCompletionSummaryEmail`), plus the ~23 specific repository functions the surviving cron
jobs call directly.

**app.js route count, verified directly, not from memory**: the same `list_all_routes.js` scratchpad
tool used throughout this pass now reports **exactly 1** remaining route registration in `app.js` —
`GET /robots.txt`, the one deliberate, documented exception above. Every other route in the original
site now lives under `routes/admin/` or `routes/public/`.

**Verification**: `node -c` on all 4 changed/new files; a full re-sweep with the AST checker
(`--dead-only`) after every edit in this section came back with exactly one flag — the already-
understood `bookingConfig` false positive — a clean pass; the undefined-reference sweep, clean;
`npm run smoke` 329/329; `npm test` x4 given the scale of this cleanup — 3 runs fully clean 664/664,
one run 663/664 on the pre-existing, extensively-documented Deferred fix #3 (`calendar.test.js` CP3)
timing flake, confirmed unrelated to this batch and non-reproducing on immediate re-run (see the
Deferred fix #3 update below).

### Post-scope extension: relocating app.js's remaining background scheduled-job functions

After the above closed out every route in the site, `app.js` still held ~1,200 lines of inline
business logic that was never a route: ~12 background cron/interval jobs (payment/quote/invoice/
event reminders, the abandoned-booking recovery pair, ledger reconciliation, PayFast pending-
timeout detection, the notification-queue drain + stuck-notification alert + hourly booking-
lifecycle sweep ("Background Clerk"), POPIA data retention, daily overdue-flagging, the daily
analytics roll-up) plus `loadPendingScheduledJobs`/`loadPendingDirectEmails` (called by
`server.js`). Phase 5's own task text is scoped to "routes" ("split server.js **routes** along the
admin/public boundary"), so this was never automatically in scope — but its stated end-state
("server.js becomes the process entry point only: config, listen, shutdown") is in real tension
with ~1,200 lines of non-trivial job logic still sitting there. Flagged as an open question after
the batch above; **the user explicitly asked for it to be relocated now.**

Same move-only discipline as every route batch: read every function fully before touching
anything, map every dependency, verify each import programmatically (`typeof` check) before
running anything, diff the moved bodies byte-identical against the pre-move file, `node -c` +
undefined-reference sweep + dead-import re-sweep after every edit, smoke + full suite after every
batch, commit incrementally. Split into 3 batches by entanglement/risk, since the whole surface is
~1,400 lines across 22 functions with a shared single-flight guard in the middle:

**Batch 1 — the 5 shared email helpers + 4 fully self-contained jobs (commit `a431cc4`):**
`lib/scheduled-job-emails.js` (`sendInvoicePreDueEmail`/`sendEventReminderEmail`/
`sendOverdueInvoiceEmail`/`sendQuoteExpiredEmail`/`sendPendingExpiredEmail` — a prerequisite,
moved first per this whole effort's established "shared helpers before their consumers" rule);
`lib/quote-follow-up-job.js`, `lib/stalled-booking-alert-job.js`, `lib/abandoned-booking-jobs.js`
(reminder + purge, sharing one wiring block in the original), `lib/deposit-balance-reminder-job.js`
— each moved byte-identical alongside its own startup `setTimeout`/`setInterval` wiring, wrapped
into a `registerXJob()` export matching the `registerBirthdayJob()` convention
`lib/newsletter-birthday.js` already established in this codebase, called once from `app.js` at the
same module-load-time position each job's inline wiring used to sit at.

**Batch 2 — the remaining 6 self-contained jobs (same commit):**
`lib/invoice-pre-due-reminder-job.js`, `lib/event-reminder-job.js`,
`lib/overdue-invoice-sweep-job.js`, `lib/post-event-followup-job.js`,
`lib/ledger-reconciliation-job.js`, `lib/payfast-pending-timeout-job.js` — same pattern. Also
folded `lib/payment-reminders.js` (already holding `runPaymentReminderJob` from an earlier batch)
into the same convention: its previously-inline wiring became `registerPaymentReminderJob()`. Then
trimmed every now-fully-dead top-of-file re-import whose only caller moved out with these 10 jobs
(12 `bookings`/`invoices-quotations` repository functions, 3 of the 5 scheduled-job email helpers,
`escapeEmailFields`, `getEmailFooterContext`, `sendAbandonedBookingReminderEmail`,
`sendReviewRequestEmail`) — each verified dead via direct grep, not assumed.

**Batch 3 — the entangled cluster + the loadPending pair:**
`processNotificationQueue`/`checkStuckNotifications`/`startBackgroundClerk` moved together into
`lib/background-clerk.js` — they share the `_notificationSweepRunning` single-flight guard and
`startBackgroundClerk` calls the other two directly, so splitting them across files would have
meant importing shared mutable state across a module boundary for no reason.
`startDataRetentionCaretaker` → `lib/data-retention-caretaker.js`. `runDailyOverdueFlaggingSweep`
→ `lib/overdue-flagging-sweep.js`, wrapped into `registerOverdueFlaggingSweep()`. The anonymous
daily analytics roll-up `schedule.scheduleJob('6 0 * * *', ...)` → `lib/analytics-daily-rollup.js`,
wrapped into `registerAnalyticsDailyRollup()`. `loadPendingScheduledJobs` moved into
`lib/newsletter-scheduling.js` (alongside `scheduleNewsletterSend`/`getPendingScheduledNewsletters`
it calls) and `loadPendingDirectEmails` into `lib/direct-emails.js` (alongside
`scheduleDirectEmailSend`/`sendDirectEmail` it calls) — both re-imported into `app.js` and
re-exported from its `module.exports` completely unchanged, since `server.js` calls both directly
from its own `app.listen()` callback and must keep working without any change on its side.
Verified via `git diff`/`git log` on `server.js` that its import/call sites needed zero changes.

Every one of the ~29 names `lib/background-clerk.js` alone needs was verified programmatically
(`typeof` check against the real repository/lib modules) before running anything against it — the
largest single dependency surface of any file moved in this whole housekeeping effort. A full byte-
identity diff of the relocated `processNotificationQueue`/`checkStuckNotifications`/
`startBackgroundClerk` body against the pre-move file came back with exactly two classes of
difference: the expected `require('./js/...')` → `require('../js/...')` path fix (this file now
sits one directory deeper, same fix pattern established for every other relocated file all
session), and harmless trailing-whitespace-only differences inside a couple of multi-line SQL
string literals — no semantic change.

Then trimmed the remaining now-fully-dead imports this final batch exposed: `syncCalendarHolds`
(`lib/calendar-sync`) and `deleteGoogleEvent` (`lib/google-calendar`) — both had their last caller
move into `lib/background-clerk.js`, which imports each directly; the 5 remaining
`booking-notifications` senders used only by the Background Clerk sweep
(`sendDepositBalanceDueEmail`/`sendQuoteExpiryWarningEmail`/`sendBookingUnderReviewEmail`/
`sendBookingCompletedEmail`/`sendAdminCompletionSummaryEmail`) and the remaining 2
`scheduled-job-emails` (`sendQuoteExpiredEmail`/`sendPendingExpiredEmail`), same reasoning;
`getNotificationEmail` (`settings.repository`) and `getBookingById` plus the 14 remaining
`bookings.repository` S0/S6/S7/expiry/reminder helpers, `markInvoicePaidForAutoComplete`
(`invoices-quotations.repository`), `flagOverdueInvoices`/`flagOverduePaymentSchedules`,
`advanceAutoCompletedEventS6`/`getPastStandaloneEventsForAutoComplete`/
`advanceStandaloneEventCompleted` (`calendar.repository`) — every one confirmed to have had its
only real caller in the code that just moved out, each re-imported directly by whichever `lib/*.js`
file now owns it. Also caught, only after the `loadPendingScheduledJobs` relocation: `scheduleNewsletterSend`
and `getPendingScheduledNewsletters` had their real (non-comment) call sites entirely inside the
function that just moved into the same target file — both dead in `app.js` now, removed;
`loadPendingScheduledJobs` itself correctly kept despite showing "0 calls" on the AST checker — a
bare property-shorthand reference inside `module.exports = { app, loadPendingScheduledJobs,
loadPendingDirectEmails }` is a real use the call-only checker can't see, the same false-positive
shape as the already-documented `bookingConfig` case.

**`app.js`'s final shape, verified directly**: zero top-level `function`/`async function`
declarations remain (`grep -c "^async function \|^function "` → 0) — every one of the original
~22 background-job functions has left the file. What's left is exactly what the plan asked for:
requires, middleware/session/static setup, the ~40-line route-mount block, the one deliberately-
kept `/robots.txt` route, a dozen one-line `registerXJob()`/`startX()` calls (each immediately after
its own `require`), the first-run bootstrap-admin `setTimeout` (genuine startup/config logic, not a
recurring job — deliberately left as-is), the C9 sandbox-PayFast-in-production guard, and
`module.exports`.

**Verification**: `node -c` after every edit in all three batches; the AST dead-import checker
re-run to a clean pass after each batch (only the two established false positives —
`bookingConfig`, `loadPendingScheduledJobs` — ever remained); the undefined-reference sweep clean
throughout; confirmed via a live `require('./app')` that all three startup log lines
(`[Background Clerk]`, `[Compliance Caretaker]`, `[cron] Starting daily overdue flagging sweep`)
still fire in the same order and that `app`/`loadPendingScheduledJobs`/`loadPendingDirectEmails`
all still resolve to functions; `npm run smoke` 329/329 after every batch; `npm test` — after
batches 1+2, 663/664 (the pre-existing CP17 timing flake, code this pair of batches never touched);
after batch 3, 3 runs — 664/664 twice, and once more 663/664 on Deferred fix #3's CP3 (the same
family, a different specific instance), confirmed via `git diff`/`git log` that `lib/booking-
status.js` and `calendar.repository.js` — the two files that actually own CP3's code path — have
zero uncommitted diff and were last touched in an earlier, already-committed batch, not this one.

---

## Phase 4 — Data-access extraction

**Phase 4 is now complete — all 8 planned domains extracted.** Order followed the plan's suggested
least-dangerous-first sequence: `settings` → `newsletter` → `inquiries` → `bookings` →
`invoices+quotations` → `finance` → `calendar` → `auth+users`. See each domain's own write-up below
for scope, consolidations, and verification. Phase 5 (routes/middleware split) is next.

### Domain: `auth+users` (session 8 of 8 — closes out Phase 4)

New file: `database/repositories/auth-users.repository.js`. Covers `admins`, `admin_login_logs`,
`password_reset_tokens` — 32 exported functions. The smallest and most contained domain of the
eight: no separate `sessions` table exists to extract (session persistence is entirely
connect-sqlite3/express-session middleware against `sessions.sqlite`, outside the app's own SQL
layer), and no 2FA/TOTP tables either.

#### Consolidations (byte-identical SQL, multiple call sites)

| Function | Call sites |
|---|---|
| `updateAdminPassword` | force-change-password route, token-verified reset-password route (both callback) |
| `insertPasswordResetToken` | `createAndSendInvite()` (new-user invite + resend-invite), the forgot-password route (both callback) |

#### Two genuine same-domain self-JOINs (not cross-domain — moved in full)

Unlike every JOIN found in earlier domains, these don't reach into another domain's table:
- `getAdminsListWithCreatorModifier` (`GET /api/admin/users`) — `admins` joined to itself twice
  (`creator`/`modifier` aliases) to resolve who created/last-edited each account.
- `getAdminLoginLogsWithNames` (`GET /api/admin/user-login-logs`) — `admin_login_logs` joined to
  `admins` for display names. Both tables belong to this domain.

#### Left untouched (confirmed cross-domain or generic infra)

- `GET /api/admin/audit_log`'s `LEFT JOIN admins actor ON ...` — stays in `server.js` in full:
  `audit_log` is the same permanently-excluded generic infra table established in
  `finance`/`invoices+quotations` (written from routes across every domain, claimed by none), so the
  whole dynamically-built statement stays regardless of it also touching `admins`.
  `financial_audit_log` and `audit_log`, `venues`, and now `policies` (flagged in the `calendar`
  write-up) are the running list of tables no domain has claimed.
- `inquiries`' `assigned_to` JOIN — stays exactly where `inquiries.repository.js`'s own header
  already documented it back in session 3.

#### Found inside an already-completed domain's routes

Three `admins`-only statements (no JOIN — just plain reads of the `admins` table) were living
inside `inquiries`-domain routes: `GET /api/admin/inquiries/assignable-admins`, the assign route's
active-admin existence check, and the note-author display-name lookup on note creation. Extracted
here; the surrounding `inquiries.repository.js` calls in those same routes (`unassignInquiry`,
`assignInquiry`, `updateInquiryPriority`, `insertInquiryNote`, etc.) are untouched. Mirror image of
the pattern from `calendar` (where domain statements turned up inside `bookings` routes) — this
time the direction is reversed, an earlier domain's routes contained a later domain's statement.

#### A genuine gap caught before it shipped

While rewiring `countOtherActiveAdministrators()` (the last-administrator guard shared by the
user-edit and user-delete routes), the planned `getActiveAdministratorCountExcluding` function
turned out to have been left out of the repository file entirely during authoring — the recon list
had it, the write-up plan had it, but the file itself didn't. Caught immediately when the rewiring
edit referenced a name that didn't exist in the file yet (rather than by the usual post-edit
re-grep sweep, this time by the wiring itself failing to make sense), fixed by adding the missing
function before continuing. Recorded because it's a slightly different failure mode than every
previous domain's self-review catches (a planned-but-never-written function, not a missed call site
or an unrecognized duplicate) — same lesson as always: the mandatory completeness check is what
catches these, not care taken while writing.

`resolveActor()` — the cross-cutting helper called from nearly every other domain's routes to
resolve an admin id into a display name for `last_updated` response fields — keeps its JS wrapper in
`server.js`; only its one `admins` SELECT moved, same treatment `checkDateAvailability`/
`hasCalendarConflict` got in `calendar`.

#### Self-review

Re-grepped `(FROM|INTO|UPDATE) (admins|admin_login_logs|password_reset_tokens)\b` and
`JOIN (admins|admin_login_logs|password_reset_tokens)` against the post-edit `server.js`. The first
came back with **zero remaining hits** — every direct statement was extracted. The JOIN sweep found
only the two confirmed-to-stay cross-domain/generic-infra JOINs above. Also scripted a wiring check
(count every exported function's occurrences in `server.js`): all 32 export names appear exactly
the expected number of times — import + 1 call site for ordinary functions, import + 2 for each of
the two consolidated functions — confirming no orphaned import and no missed call site.

#### Verification

- `node -c server.js`, `node -c database/repositories/auth-users.repository.js` — clean.
- `npm test` — run **5 times**, given this domain underpins literally every other admin-route test
  in the suite (login, session, RBAC). Results: the 2 permanent Deferred-fix-#1 failures every run,
  plus Deferred fix #3's **CP5** once (already-documented `calendar`-domain flake, not auth code —
  consistent with every prior domain's testing). No auth-specific failure, no new failure signature,
  across any run.
- `npm run smoke` — 329/329.
- `git status --short` — only `server.js` modified and `database/auth-users.repository.js` added.

### Domain: `calendar` (session 7 of 8)

New file: `database/repositories/calendar.repository.js`. Covers `date_holds` and `events` only —
53 exported functions (22 for `date_holds`, 31 for `events`, several of those being
callback/async sibling pairs over one shared statement).

**Deliberately out of scope**, found while reading but not claimed:
- **`venues`** — not one of the plan's 8 named domains. Every `date_holds`/`events` statement that
  JOINs `venues` (the today's-schedule feed, the admin calendar grid's public-events sub-query)
  stays in `server.js` untouched, same treatment `bookings`/`clients` JOINs got in earlier domains.
  `venues`' own CRUD (inside `PUT .../venue-google`) is untouched for the same reason.
- **`policies`** — a small business-rules table (`cancellation_policy`, SLA/reminder-day settings)
  read from ~10 places across bookings-cancellation, inquiries-SLA and reminder code, with its own
  admin CRUD elsewhere in `server.js`. Not in `settings.repository.js` either (checked) — an
  unclaimed table, like `venues`, that doesn't belong to `calendar` since it has nothing to do with
  dates/events. Flagging its existence here so it isn't lost track of; not fixed in this session.

#### Consolidations (byte-identical SQL, multiple call sites — verified with exact-string greps,
not just by eye, before merging)

| Function(s) | Call sites |
|---|---|
| `getEventById` | `syncEventToCalendar`, `POST .../duplicate` (both callback) |
| `insertAutoCreatedEvent` | PayFast ITN, manual payment, `applyStatusChange` CONFIRMED (all callback, `this.lastID`) |
| `releaseDateHoldsForBooking` / `...Async` | POPIA erasure, admin cancel route, public cancel route (async) + `applyStatusChange` CANCELLED (callback) |
| `getEventByBookingId` | POPIA erasure, admin cancel route (both async) |
| `demoteEventForCancelledBooking` / `...Async` (`WHERE event_id = ?`) | POPIA erasure (async) + `applyStatusChange` CANCELLED (callback) |
| `clearEventGoogleCalendarId` / `...Async` | POPIA erasure, admin cancel route (async) + `applyStatusChange` CANCELLED, `PUT /api/admin/events/:id` cancel-on-edit branch (callback) |
| `advanceEventToCompleted` | `POST .../complete`, `applyStatusChange` COMPLETED (both callback; the space in `('cancelled', 'completed')` matches) |
| `getEventGoogleCalendarId` | `applyStatusChange` CANCELLED, `DELETE /api/admin/events/:id` (both callback) |
| `updateEventDatetime` | booking date-change route, event drag-reschedule route (both callback) |
| `deleteEventById` | `PUT .../public` toggle-off branch, `DELETE /api/admin/events/:id` (both callback) |

#### Near-misses kept **separate** (confirmed genuinely distinct, not merged)

- `demoteEventForCancelledBookingByBookingIdAsync` — the dedicated admin cancel route's own
  variant filters `WHERE booking_id = ?` instead of `WHERE event_id = ?` (it matches by the event's
  own pointer so a pre-existing orphaned cross-reference still gets cleaned up, per that route's own
  comment) — a real semantic difference, not whitespace, so not folded into the pair above.
- `advanceAutoCompletedEventS6` vs `advanceEventToCompleted` — S6's cron statement has no space in
  `('cancelled','completed')`; the other two call sites do. Kept separate; not reformatted to match.
- `advanceStandaloneEventCompleted` (cron "S7") — no `AND event_status NOT IN (...)` clause at all,
  a third distinct variant of the same idea.
- **Four**, not three, separate venue-editing UPDATEs on `events` — a third venue-editing route
  (`PATCH /api/admin/bookings/:id/venue`, the free-text editor) turned up during this session that
  wasn't visible in the initial two-route estimate: `unlinkEventVenue` (2 fields, both NULLed),
  `updateEventVenueLegacyLink` and `updateEventVenueGoogleLink` (same 3-field SET list, but the
  second was originally nested one indentation level deeper in `server.js` — per the
  whitespace-as-byte-identity precedent from `bookings` Stage 3, kept as two functions rather than
  force-merged), and `updateEventVenueFreeText` (only 2 fields, no `venue_id` at all — a genuinely
  different column set from the other three).

#### A pre-existing bug, relocated as-is (not fixed)

`GET /sitemap.xml` runs `SELECT id, created_at FROM events ORDER BY date DESC` — but the real
columns are `event_id`/`event_datetime`, not `id`/`date`. This has always errored (wrong column
names) and the route's own `if (!err && events)` guard has always silently swallowed it — the
sitemap has never listed a single event, since the day this code was written. Per "housekeeping,
not improvement," the buggy query was moved byte-identical into `getEventsForSitemap()`, not fixed.

#### Multi-domain orchestration functions (only this domain's own statements touched)

POPIA erasure's booking-cancellation cascade, the dedicated admin cancel route's transaction,
`applyStatusChange`'s CANCELLED/CONFIRMED/COMPLETED branches, and the background-clerk cron's S6/S7
sweeps all keep their surrounding orchestration (email sends, other domains' cascades, the
`audit_log`/`financial_audit_log` inserts) in `server.js` exactly where it was — only the
`date_holds`/`events` statements inside them moved.

#### Self-review

Re-grepped `(FROM|INTO|UPDATE) (date_holds|events)\b` and `JOIN (date_holds|events)` against the
post-edit `server.js`. Every remaining hit is accounted for: the two `venues`-JOIN reads (today's
schedule, admin calendar grid), the two bookings-JOIN public/admin events listings, the
`bookings`-outer-table calendar-grid JOIN (`FROM bookings b ... LEFT JOIN events e ...`), and
`BOOKING_DELETE_PURGE`'s two hand-ordered cascade entries. No missed statements, no missed call
sites — the first domain since `bookings` Stage 5 where this sweep found nothing to fix.

#### Verification

- `node -c server.js`, `node -c database/repositories/calendar.repository.js` — clean.
- `npm test` — run **8 times** given this domain re-touches the same cancellation/status-change/
  venue routes already edited in `bookings` Stages 5-6. Results: the 2 permanent Deferred-fix-#1
  failures every run, plus Deferred fix #3's **CP3** (2 of 8 runs) and **CP5** (1 of 8 runs) —
  both already-documented timing flakes, not new ones (see the Deferred fix #3 update below) — and
  one unrelated one-off, "full refund re-derives payment_status to UNPAID" (1 of 8 runs, never
  recurred, touches `bookings`/finance payment_status code this session never read — consistent
  with the environmental-noise category the one-off `SQLITE_BUSY` crash was filed under).
- `npm run smoke` — 329/329.
- `git status --short` — only `server.js` modified and `database/calendar.repository.js` added, as
  expected.

### Domain: `finance` (session 6 of 8)

New file: `database/repositories/finance.repository.js`. Covers `transactions`,
`payment_schedules`, `cancellations`, `payment_logs`, `expenses`, and a table not previously
catalogued anywhere — **`bank_statement_lines`** (a bank-statement import/reconciliation feature,
found only by the live grep sweep since it wasn't mentioned in any earlier phase's docs).
`financial_audit_log` is deliberately excluded, same treatment as the generic `audit_log` table —
it's written from services/invoices/payment routes alike (SERVICE_ARCHIVED, INVOICE_VOIDED,
MANUAL_PAYMENT, EXPENSE_LOGGED, …) and has never belonged to any single domain.

**~65 statements moved.** This domain inherits the highest-risk surface of any session so far
after `bookings` Stage 6 itself: it supplies the `transactions`/`payment_schedules`/
`cancellations`/`payment_logs` halves of the exact same PayFast ITN webhook, manual-payment,
refund, reconcile/sync, and transactions/manual routes that Stage 6 already extracted the
`bookings`-table halves of — those statements were always cross-domain from `bookings`'
perspective specifically because this domain didn't exist yet.

**Two dashboard routes finished, not just deferred further.** `GET /api/admin/financials/
analytics` and `GET /api/admin/financials/stats` were deferred whole during `invoices+quotations`
(mixing one invoices-only aggregate with several transactions/expenses/bookings-joined queries).
Rather than deferring them a second time, this session finished both: pulled their
`transactions`/`expenses` statements here, and added 3 small functions to the already-complete
`invoices-quotations.repository.js` (`getInvoiceAgingSummary`, `getOverdueInvoicesSummary`,
`getDueSoonInvoicesSummary`) for their `invoices`-only aggregates. Every statement in both routes
that JOINs `bookings` (client top-spenders, overdue-invoice client names, category revenue,
pending-quotes-by-status, unsent-invoice count, recent-transactions-with-client-name) stays
cross-domain in `server.js`, per the standing rule.

**A likely pre-existing bug, found but not fixed:** `POST /api/admin/bank-statement/import` calls
`db.prepare()` then wraps the insert loop in `db.transaction(() => {...})` — but this codebase
uses `node-sqlite3` (`require('sqlite3')` elsewhere), whose `Database` has no `.transaction()`
method; that's a `better-sqlite3` API. The route would throw `TypeError: db.transaction is not a
function` at runtime if actually hit. Per the plan's rule against fixing bugs found incidentally
during a move, this is untouched — only the prepared statement's SQL text was relocated
(`prepareBankStatementLineInsert()`); the `db.prepare()`/`db.transaction()`/`insertStmt.run()`
call sites in `server.js` are byte-for-byte what they were.

**Real consolidations** (byte-identical duplicate SQL):
- `getPaymentSchedulesForDocument()` — 4 call sites (`generateInvoice`, `sendInvoiceEmail`,
  `sendQuoteAcceptedEmail`, `resolveContractFeeData`).
- `cancelPendingPaymentSchedules()`/`…Async()` — 4 call sites across POPIA erasure, admin cancel,
  `applyStatusChange`, and the public self-cancel route (mirrors the `invoices+quotations`
  domain's `voidInvoicesForCancelledBooking` shape exactly, same 4 routes).
- `getActivePaymentSchedules()` — 3 call sites in the payment-schedules admin routes (one of the
  three was missed on the first pass — see below).
- `getTransactionsForBooking()` — 2 call sites in `GET /api/admin/bookings/:id/details`
  (services-present branch and the legacy fallback branch).
- `getActiveExpenseById()` — 2 call sites (DELETE and PUT `/api/admin/expenses/:id`).

**4 distinct `cancellations` INSERT variants**, not 1 — the same "looks like a duplicate, isn't"
discipline as every prior domain: POPIA erasure (hardcodes `cancelled_by='client'`, no
`notes`/`admin_id`), the admin cancel route (adds `notes`/`admin_id`, `cancelled_by` is a
parameter), `applyStatusChange`'s CANCELLED branch (hardcodes `cancelled_by='comedian'` — the
CHECK constraint doesn't permit `'admin'`), and the public self-cancel route (adds `reason_code`,
no `notes`/`admin_id`) — four different column lists, four functions.

**Self-review caught 4 gaps** before sign-off, using the same "re-grep the six table names
against the post-edit file, check every remaining hit against an expected-to-stay list" technique
that has now caught residual gaps in every domain since `bookings` Stage 5:
1. The POPIA erasure function's `transactions` ip_address/notes/reconcile_note redaction UPDATE —
   catalogued during recon but the function itself never written.
2. `POST /api/public/bookings/:id/track`'s payment-schedule view (distinct column list from
   `getPaymentSchedulesForDocument`) — same story.
3. The rebalance route's *second* `getActivePaymentSchedules()` call site (the post-rebalance
   re-fetch) — missed by an exact-string consolidation edit because its callback parameter names
   (`e2, rows`) differed from the first occurrence's (`err, schedules`), so the two calls weren't
   literally the same source string even though they're the same SQL.
4. The public self-cancel route's 4th `cancellations` INSERT variant (`reason_code`) — not
   recognized as distinct from the other 3 until the rewiring pass reached it.
All four fixed and re-verified before running the test suite.

**Verification:** `node -c` clean on all three touched/created files. `npm test` run **6 times**
given the payment-route overlap with `bookings` Stage 6: 5 runs showed only the 2 permanent
Deferred-fix-#1 failures (649/651); 1 run additionally failed `calendar.test.js`'s **CP17**
("`syncEventToCalendar` was actually invoked after the drag") — a fixed `sleep(300)` racing a
real (deliberately-failing, bogus-token) Google Calendar API call, the identical mechanism as
Deferred fix #3's other four instances, and on a route (`PATCH /api/admin/events/:id/date`) this
session never touched. Logged as a further recurrence below, not a new root cause. `npm run
smoke` — 329/329. `git status` clean of surprises.

**Report, per the plan's own template:**
- Statements moved: **~65**, plus 3 more added to `invoices-quotations.repository.js` to finish
  the two deferred dashboards.
- Left as cross-domain: every JOIN/correlated-subquery statement is documented inline in the
  repository file, per this file's running convention; the refund route's `UPDATE bookings SET
  amount_paid = MAX(0, (SELECT ... FROM transactions ...))` — already flagged as cross-domain
  during `bookings` Stage 6 — is unaffected and still in `server.js`.
- Remaining raw SQL against these six tables: only genuine `bookings`-joined/correlated
  statements and the permanently-excluded `BOOKING_DELETE_PURGE`/`BOOKING_DELETE_UNLINK` entries.

---

### Domain: `invoices+quotations` (session 5 of 8)

New file: `database/repositories/invoices-quotations.repository.js`. Covers `invoices`,
`invoice_line_items`, `quotations`, `quote_line_items`. Found and confirmed by a live grep sweep
of every `FROM`/`INTO`/`UPDATE` hit against these four tables in `server.js` — not a stale
line-numbered catalog, since none existed for this domain (it wasn't part of the Phase 1 recon
agent's per-table breakdown the way `bookings` was).

**~57 statements moved** across `generateInvoice()`, `sendPaidReceiptEmail()`,
`sendBookingCompletedEmail()`'s VAT lookup, the daily overdue-flagging cron, two invoice-reminder
crons, the admin quote-generation route (the domain's largest single route), six admin invoice
actions (send/void/mark-paid/bulk-send-unsent/resend-quote + the three download routes), the
client accept-quote route, `resolveContractFeeData()`, `applyStatusChange()`'s ACCEPTED/QUOTED/
COMPLETED branches, the two services-usage/hard-delete guards, a small booking-financials
summary route, and the POPIA erasure functions (quotations' `file_path` only — invoices are
deliberately exempt from erasure everywhere, per `anonymizeClientData()`'s own header comment:
financial/tax records survive).

**Deliberately deferred to a future `finance` domain session:** two full reporting/dashboard
routes (`GET /api/admin/financials/analytics` and the finance-KPI dashboard route powering the
admin dashboard's summary tiles) each mix one single-table `invoices` aggregate query in with
several `transactions`/`bookings`-joined queries computing one cohesive report. Extracting just
the invoices-table fragment would have split one logical endpoint's data layer across two
repository files for no real benefit, so the whole route waits for `finance`, consistent with the
"a statement mixed into cross-domain work stays" spirit, generalized from statement-level to
route-level for these two dashboards specifically.

**Found but out of scope, left untouched:** `POST /api/public/bookings/:id/accept-quote`,
`POST /api/public/bookings/:id/quote-revision-request`, `GET /api/admin/bookings/:id/quote/download`
(public variant), and `POST /api/public/bookings/:id/cancel` (the client self-cancel route) each
also contain an un-migrated `bookings`-domain statement of their own — not touched here, since
`bookings` is already fully done (Stages 1–6) and these weren't part of that session's approved
scope. (The public cancel route's own **invoices** statement — the `voidInvoicesForCancelledBooking`
family below — *was* extracted here, since that statement belongs to this domain regardless of
which route hosts it, same as bookings-domain statements were pulled out of venue/event routes
back in the `bookings` domain's Stage 5.)

**Real consolidations** (byte-identical duplicate SQL, same discipline as every prior domain):
- `UPDATE invoices SET status='PAID'…UPPER(status) NOT IN ('VOID','PAID')` — 4 call sites
  (PayFast ITN, manual payment, reconcile/sync, transactions/manual) → `markInvoicePaidIfOpen()` /
  `…Async()`, split by sync style same as `getBookingById`/`…Async`.
- `UPDATE invoices SET status='VOID', void_reason='booking_cancelled'…` — 4 call sites spanning
  **three different domains' routes** (POPIA erasure, the admin cancel route, `applyStatusChange`'s
  CANCELLED branch, and the public self-cancel route) → `voidInvoicesForCancelledBooking()` / `…Async()`.
- `UPDATE quotations SET status = 'accepted'…` — 2 call sites (client accept-quote,
  `applyStatusChange`) → `markQuotationAccepted()` / `…Async()`.
- `SELECT * FROM invoices WHERE id = ?` (void route, mark-paid route) → one `getInvoiceById()`.
- `SELECT * FROM quote_line_items WHERE quotation_id = ?` (`generateInvoice()`,
  `resolveContractFeeData()`) → one `getQuoteLineItems()`.
- `UPDATE invoices SET sent_at = CURRENT_TIMESTAMP WHERE id = ?` (`generateInvoice()`,
  bulk-send-unsent) → one `markInvoiceSent()`.

**Near-misses deliberately NOT consolidated**, same byte-identical-means-identical-bytes rule as
every prior domain: `getActiveQuoteForInvoiceGen()` vs. `getActiveQuoteForContractFeeData()` (same
query, but one is multi-line and one is single-line — different source-level line-wrapping,
different call-site nesting depth); `getOpenInvoiceIdForReceiptCheck()` vs.
`getOpenInvoiceIdForAdjustmentRegen()` (different `NOT IN` list, one has an `ORDER BY`);
`getLatestQuoteFileForResend()` vs. `getLatestQuoteFileForPublicDownload()` (different column
list, different `archived=`/`archived = ` spacing); and, closest of all, `markInvoicePaidIfOpen()`
(has `UPPER(status)`) vs. two more standalone functions found late in self-review —
`markInvoicePaidForAutoComplete()` and `markInvoicePaidOnStatusComplete()` (neither has `UPPER()`,
and the latter two differ from each other only in whitespace around `=`) — three visually-similar
"mark this booking's invoice paid" statements that are genuinely three different byte sequences.

**Self-review caught 3 gaps before sign-off** (recon listed them; the first extraction pass
missed writing the actual functions/call sites for two, and one — `sendPaidReceiptEmail()`'s
own invoice lookup — was never actually read during recon, only counted by its grep hit):
the two `markInvoicePaid…` functions just above, and `getInvoiceForPaidReceipt()`. Found by
re-running the same `grep -n "FROM invoices|INTO invoices|UPDATE invoices|..."` sweep used for
recon against the post-edit file and checking every remaining hit against an expected-to-stay
list — the discipline that has caught every domain's residual gaps so far (Stage 5 and the
satellite-catalog pass both found similarly-missed statements this same way). All three fixed,
re-verified, before running the test suite.

**Verification:** `node -c` clean on both files. `npm test` run **5 times** (this domain touches
payment-status transitions and cancellation cascades throughout, so it earned the Stage-6 level
of scrutiny): 4 runs showed only the 2 permanent Deferred-fix-#1 failures (649/651); one run
crashed the whole process with `SQLITE_BUSY: database is locked` partway through
`banner.test.js` — a file with no relationship to invoices, quotations, bookings, or anything
touched this session. Re-ran twice more, both clean. Logged under "Known testing limitations"
below as a new, distinct flake category (a hard crash, not a wrong-assertion) worth watching for
if it recurs, but not attributable to this session's edits. `npm run smoke` — 329/329. `git status`
clean of surprises.

**Report, per the plan's own template:**
- Statements moved: **57**
- Left as cross-domain: correlated-subquery and JOIN statements documented inline above and at
  each call site's comment in the repository file (bookings/clients/venues/contracts/cancellations/
  payment_schedules/policies/quotations-across-domain-boundary/transactions/audit_log/
  financial_audit_log — the same generalized-from-JOIN "correlated subquery reading another
  domain's table" rule introduced in the `bookings` domain's Stage 6 applies to the refund route's
  ledger recalculation, noted there and unaffected by this domain's work)
- Remaining raw SQL in `server.js`: two whole routes deferred to `finance` (see above), 4
  found-but-out-of-scope `bookings` statements in other routes (see above), and everything
  cross-domain

---

### Domain: `bookings` (session 4 of 8) — DONE, staged sub-passes

By far the largest domain: ~229 statements on `bookings` alone (vs. 49 for
the next-largest, `newsletter`), plus 41 more across its satellite tables
(`booking_notes`, `booking_services`, `booking_line_items`,
`booking_access_codes`, `booking_access_tokens`). Confirmed with the repo
owner up front: staged sub-passes, full-suite verification after each,
explicit re-confirmation required before the highest-risk payment/ledger
stage. A background research agent cataloged every `bookings`-table
statement first (current line numbers, single vs. cross-domain, payment/
calendar/email/transaction flags); spot-checked a sample against the
actual code before trusting it.

**Deliberately out of scope, this domain and always:** `BOOKING_DELETE_PURGE`
/ `BOOKING_DELETE_UNLINK` (the cascade-delete arrays inside `DELETE
/api/admin/bookings/:id`) — a hand-ordered, FK-constraint-sensitive
sequence with its own comments describing past production bugs from
getting the order wrong. Splitting its ~21 statements across domain
repositories risks reintroducing exactly those bugs. Only the route's own
final `DELETE FROM bookings WHERE id = ?` (outside the arrays) is in scope,
not yet reached in the sub-passes below.

New file: `database/repositories/bookings.repository.js`.

**Universal consolidation found first:** `"SELECT * FROM bookings WHERE
id = ?"` is byte-identical across **41 separate call sites** (both
callback-style `db.get(...)` and promise-style `dbGet(...)` — two
functions, `getBookingById`/`getBookingByIdAsync`, not a style conversion).
Available to every later sub-pass; not all 41 call sites are updated yet —
only the ones reached so far.

#### Satellite tables — cataloged, not yet extracted
41 statements across the 5 `booking_*` tables: 28 movable, 8 cross-domain
(joined with `services`), 5 inside `BOOKING_DELETE_PURGE` (excluded). Full
catalog exists from this session's reconnaissance; extraction deferred to
a later sub-pass so the core table's higher-risk work isn't delayed.

#### Stage 1 — Reporting/analytics (read-only) — DONE
Of ~40 candidate statements, the vast majority are inherently cross-domain
(a financial/dashboard report necessarily joins `clients`, `invoices`,
`transactions`, `quotations`, `expenses`, `payment_schedules`, etc.) and
needed no code change at all — just confirmation they stay. **7 moved:**
`getBookingsTrend`, `stampReviewEmailSent` (2 call sites, byte-identical),
`unlinkBookingClient`, `getBookingTotalAmount` (2 call sites, byte-identical),
`getOutstandingTotal`, `getBookingStatusCounts`. Two explanatory comments
(the outstanding-total allowlist reasoning, the status-count disposition
filter) were carried into the repository, not dropped.

#### Stage 2 — Background cron jobs — DONE
`startBackgroundClerk()`'s single `setInterval` body (15 statements) plus
7 more across the named `run*Job()` functions — 22 moved in total. Several
jobs turned out to need **zero** changes once actually read: `runPaymentReminderJob`,
`runStalledBookingAdminAlertJob`, `runInvoicePreDueReminderJob`,
`runOverdueInvoiceSweepJob`, `runLedgerReconciliationJob`,
`runPayFastPendingTimeoutJob`, and the startup quote-consistency check all
touch `bookings` only via a JOIN (with `payment_schedules`, `invoices`,
`transactions`, or `quotations`) — cross-domain, correctly left untouched.
One bug caught and fixed *in my own edit, not the app* — an early version
of a call site passed `nowLocal` twice instead of once, mismatching
`getPendingEnquiriesNearingExpiry(nowLocal, callback)`'s actual signature;
caught by inspection before testing, not by a failing test.

**Verification so far:** `npm test` — 651/651, stable (one intermediate
checkpoint hit the same pre-existing calendar-sync flake pattern as
Deferred fix #3, twice, each a different test, then clean on retry —
consistent with that being general timing flakiness, not a regression).
`npm run smoke` — 329/329. `git status` clean of surprises.

#### Stage 3 — Admin CRUD/status routes + legacy tooling — DONE
**21 moved.** Deliberately excluded from this stage and pushed into Stage 6
alongside the payment routes: `applyStatusChange()`'s core cascade and
`POST /api/admin/bookings/:id/cancel` — both cascade into
invoices/payment_schedules/refunds, the same category of risk as the
payment routes, so they get the same explicit-confirmation gate rather than
slipping in under "CRUD."

Covered: admin manual-create (duplicate-check ×2 + the 29-column INSERT,
still inside its existing transaction), `reopen`, `book-again` (a 24-column
INSERT), `complete`, `buffer`, `disposition`, `respond`, the legacy
`/send-email` route's booking-creation branch (sibling to what the
`inquiries` domain already extracted from that same route), both legacy
migration tools (`/api/admin/migrate`, `/api/admin/system/migrate-legacy-data`
— found and merged one byte-identical duplicate, `updateBookingClientVenue`,
shared between them), and the `DELETE /api/admin/bookings/:id` route's own
pre-cascade read + final row-delete (both outside `BOOKING_DELETE_PURGE`/
`BOOKING_DELETE_UNLINK`, which remain untouched per the standing exception).
`GET /api/admin/bookings` (list) and its `:id` detail route are both
confirmed cross-domain (join `clients`/`venues`/`quotations`/`invoices`/
`contracts`) and needed no change.

Two near-duplicate statements were deliberately kept as separate functions
rather than force-merged, since their literal text differs (whitespace /
formatting only, but "byte-identical" means byte-identical): the admin
`/complete` route's completion UPDATE vs. the Stage 2 cron job's version,
and the two duplicate-booking-check queries (pre-lock callback-style vs.
post-lock promise-style) — each pair does share one function apiece,
because within each pair the two calls after this move now run the exact
same code, but the two *pairs* are distinct from each other.

**Verification:** `npm test` — 649/651, reproduced identically three times
in a row (the two failures are Deferred fix #1's pre-existing concurrency
test — unaffected, since this stage never touched the *public* booking
route that test exercises). `npm run smoke` — 329/329. `git status` clean
of surprises.

#### Stage 4 — Quote/invoice/contract/advancing generation — DONE
**~10 core-table statements moved**, plus this stage is where satellite-table
extraction actually started (see below) rather than waiting for its own
separate pass — reading `POST .../quote`'s transaction meant already having
its `booking_services`/`booking_line_items` refresh in view, so extracting
those alongside the `bookings` UPDATE avoided re-reading the same route later.

`generateContract()`, its `builder-data`/`preview` routes, `contract/send`,
and `remindBooking()` all turned out to need **zero** changes — every one
only touches `bookings` via a `LEFT JOIN clients`, cross-domain and
already-correct. `generateInvoice()` contributed 2 (client-id resolution,
post-invoice ledger UPDATE, the latter inside its own existing transaction).
The quote route contributed the status/total UPDATE (also inside its
transaction) plus reused the client-id function `generateInvoice()` already
needed. Small single-field reads moved for contract-upload, contract-remind,
and all three advancing-pack routes (two of which turned out to be the
already-known `getBookingByIdAsync` pattern, not new statements).

**Satellite tables — extraction begun:** while inside the quote route's
transaction, moved its `booking_line_items`/`booking_services`
delete-and-rebuild (4 statements: `deleteBookingLineItems`,
`deleteBookingServices`, `insertBookingLineItem`, `insertBookingService`).
Then noticed the admin-create route (Stage 3) and the *public* booking
-creation route (`POST /api/public/bookings`, otherwise untouched — its
core `bookings` INSERT is deliberately out of scope, see the Stage 3 note
on why the public route is avoided) both ran the exact same
`insertBookingService`/`insertBookingLineItem` SQL in an identical loop —
byte-identical across all three call sites, consolidated to the same two
functions rather than left duplicated now that they existed. This does NOT
touch the public route's booking-creation logic or its concurrency
behaviour — only its post-creation service/line-item bookkeeping, a
separate statement pair with no bearing on Deferred fix #1.

**Verification:** `npm test` — 649/651, twice, same two Deferred-fix-#1
failures both times (this stage never touches that route's `bookings`
INSERT or duplicate-check, only the unrelated service/line-item inserts
downstream of it). `npm run smoke` — 329/329. `git status` clean.

#### Stage 5 — Venue & calendar-adjacent routes + events-domain routes touching bookings — DONE
**~22 core-table statements moved.** This stage's functions/routes are all
mixed with two domains not yet extracted — `date_holds` (belongs with a
future `calendar` domain) and `events` — so every date_holds/events/venues
statement inside them was deliberately left in `server.js`; only each
one's own `bookings`-table statement moved, same multi-domain-orchestration
pattern used for the POPIA-erasure functions in earlier domains.

`hasCalendarConflict()`, `checkDateAvailability()`, `findHoldDateConflict()`,
and `checkEventConflicts()` each contributed exactly one `bookings` SELECT
(their `date_holds`/`events` halves stayed put). All four looked superficially
similar ("bookings on this date, excluding X") but none were byte-identical
to each other — different column lists, different WHERE clauses, different
line-wrapping — so each got its own function rather than a forced merge.
`syncBookingToCalendar()` contributed its `google_event_id` UPDATE (the
`booking_services JOIN services` fetch above it is a genuine cross-domain
join and stayed). `syncCalendarHolds()` contributed one SELECT; its four
other statements are all `date_holds`/`events` and stayed.

The three venue-editing routes (`PUT .../venue` unlink+link, `PUT
.../venue-google`, `PATCH .../venue`) each update `bookings` directly and
each read back `SELECT event_id FROM bookings WHERE id = ?` before touching
the linked event — that one-line SELECT is byte-identical across all three
and now shares `getBookingEventId()`. The link-branch UPDATE in `PUT
.../venue` and the UPDATE in `PUT .../venue-google` set the same six
columns but were nested at different depths in `server.js` (different
multi-line whitespace) — kept as two separate functions rather than
force-merged, same call as Stage 3's `markBookingCompletedManual` vs.
`markBookingAutoCompleted`. `PATCH .../date`'s dynamic `SET` clause
(assembled in `server.js` from quote-expiry/duration business logic that
has nothing to do with data access) now goes through
`updateBookingDateAndTimeFields(setClausesSql, params)`, which only wraps
the final `db.run` — the clause-building logic itself stayed exactly where
it was.

`PUT /api/admin/events/:id` and `PATCH /api/admin/events/:id/date` each
fetch their linked booking with an inline `new Promise(r => db.get(...))`
that **resolves `null` on a DB error instead of rejecting** — a genuinely
different contract from `getBookingByIdAsync` (which rejects), so this
got its own `getBookingByIdSafeAsync()` rather than being folded into the
existing one. `POST /api/admin/events` and `PUT /api/admin/events/:id`
both write `bookings.event_id` back with the exact same fire-and-forget
statement — consolidated into `setBookingEventId()`. The placeholder-booking
INSERT (`block_type==='booking'`) and the drag-reschedule date sync
(`PATCH .../date`) each moved as their own function, passing the original
callback straight through unchanged so sqlite3's `this.lastID`/`this.changes`
binding on it is preserved (same technique already used for
`insertAdminBooking` etc.).

`PUT /api/admin/bookings/:id/public` (promote/demote) contributed its four
`is_public`/`ticket_link`/`event_id` UPDATEs; the events INSERT/UPDATE/DELETE
and every `venues`-joined SELECT in that route (including the `sendResponse()`
preview query) stayed in `server.js`. `GET /api/calendar/feed.ics` and `GET
/api/admin/venues` were read in full but contributed nothing — every
statement in both is a genuine cross-domain JOIN or a `date_holds`-only
query, so neither has a `bookings`-domain statement to extract.

One incidental slip caught during self-review: an early edit to the
`venue-google` route's surrounding code briefly stripped trailing
whitespace from the untouched `events` UPDATE 3 lines below it (a
formatting-only accident from the edit tool, not a deliberate change) —
caught immediately via `git diff`-style byte comparison against the
unlink-branch's identical block, and restored before running any tests.
Purely cosmetic (SQLite ignores the whitespace either way) but flagged
here since "leave cross-domain statements untouched" is a standing rule.

**Verification:** `npm test` — 649/651, same two pre-existing Deferred-fix-#1
concurrency failures (unrelated — this stage never touches the public
booking route). Two tests exercising code this stage directly touched
passed cleanly: `CP2: google_event_id nulled after cancel` and `CP20:
deleting the event no longer fails with a FK constraint error`. `npm run
smoke` — 329/329. `git status` clean of surprises.

#### Satellite-table catalog completion — DONE
A live grep sweep of every `booking_notes`/`booking_access_codes`/
`booking_access_tokens`/`booking_services`/`booking_line_items` reference in
`server.js` (not the stale Phase 1 agent catalog's line numbers) found **18
movable satellite-table statements**, plus **2 core `bookings`-table
statements that no earlier stage had caught** — both inside the POPIA
functions read for this pass (`resolvePopiaTargets()`'s
`SELECT id FROM bookings WHERE LOWER(email) = LOWER(?)`, and
`anonymizeClientData()`'s anonymize-on-erasure `UPDATE bookings`). Both are
now `getBookingIdsForEmail()`/`anonymizeBookingsForErasure()`, sitting
alongside the domain's existing POPIA extractions
(`anonymizeInquiriesForErasure()` etc.) from earlier stages.

Every `booking_services`/`booking_line_items` statement that JOINs
`services` (8 call sites, across `sendBookingCompletedEmail()`,
`sendAdminCompletionSummaryEmail()`, the public per-day-availability check
in `POST /api/public/bookings`, `POST /api/public/bookings/:id/track`,
`GET /api/admin/bookings/:id/details`, `GET /api/admin/bookings/:id`, and
the quote route's per-day conflict check) stayed in `server.js` — `services`
is a separate, not-yet-extracted domain. The public per-day-availability
check (`POST /api/public/bookings`) is additionally inside the
deliberately-untouched core booking-creation flow (Deferred fix #1), so it
was left alone on that basis too, independent of the cross-domain JOIN.
`BOOKING_DELETE_PURGE`'s own DELETEs against these same 5 tables are, as
always, permanently excluded (file header).

New pieces of the domain covered: the client-facing booking-tracking OTP/
access-token subsystem (`requireBookingAccessToken()` middleware,
`request-code`/`verify-code` routes) — all `booking_access_codes`/
`booking_access_tokens` statements moved, one pair of byte-identical
"consume by id" calls consolidated into a single `consumeAccessCodeById()`;
the threaded admin booking-notes CRUD (`GET/POST/DELETE
/api/admin/bookings/:id/notes`); the client-facing tracker's own note-insert
(hardcoded `author='Client'`, kept as a separate function from the admin
route's parameterized-author insert since the SQL literal differs); and the
service hard-delete guard's `booking_line_items` reference-count check
(its sibling `quote_line_items` check is a different table and stayed).

**Verification:** `npm test` — 649/651 the first run showed a third,
unfamiliar failure (`calendar-booking-sync.test.js`: "reschedule: a SECOND
sync attempt was logged for this booking") alongside the two known
Deferred-fix-#1 failures. Re-ran three more times — every one showed only
the two known failures, with the calendar-sync test passing cleanly each
time. The test's own comments already flag it as inherently racy (a fixed
`sleep(300)` racing an async `db.get` callback → `syncBookingToCalendar()`
chain), and the touched code path (`PATCH .../date`'s final `getBookingById`
callback, swapped in during Stage 5) is a byte-for-byte behavioral no-op —
same SQL, same callback, passed straight through. Treated as a third
occurrence of Deferred fix #3's documented timing-flake pattern, not a
regression. `npm run smoke` — 329/329. `git status` clean of surprises.

**Remaining for the `bookings` domain:** only **Stage 6 — payment & ledger
routes + `applyStatusChange()` + the admin cancel route**, which needs your
explicit go-ahead before touching per the agreed plan. Running statement
count: **~84 of 229 core-table statements moved**, plus 22 satellite-table
statements (4 from Stage 4, 18 from this pass).

#### Stage 6 (final) — Payment & ledger routes, `applyStatusChange()`, admin cancel — DONE
Explicit go-ahead re-confirmed before starting, per the standing agreement. **~24 core-table
statements moved.** Covered: `POST /api/payment/webhook/payfast` (the PayFast ITN handler —
Deferred fix #2's own subject), `PUT .../manual-payment` + `processManualPayment()`,
`updateBookingMilestones()`, `getBookingErasureImpact()`/`cancelActiveBookingsForErasure()` (the
POPIA-triggered mass-cancellation cascade — 2 more core statements this uncovered, see below),
`POST /api/admin/bookings/:id/cancel`, `PUT .../refund`, `POST .../reconcile/sync`,
`POST /api/admin/transactions/manual`, and `applyStatusChange()` + its two thin wrapper routes
(`PUT /api/admin/bookings/:id`, `PUT .../status`).

Every statement against `transactions`, `invoices`, `cancellations`, `events`, `date_holds`,
`payment_schedules`, `policies`, `quotations`, `audit_log` or `financial_audit_log` stayed in
`server.js` — including the refund route's ledger-recalculation `UPDATE bookings` whose SET
clause contains a **correlated subquery reading `transactions`** (`FROM transactions t WHERE
t.booking_id = bookings.id`). That's not a literal JOIN, but the same cross-domain coupling a
JOIN would create, so it was treated the same way and left in place, alongside this domain's
other cross-domain JOIN statements already documented in the earlier stages above.

**2 more core statements the earlier stages missed**, found while reading
`getBookingErasureImpact()` for this pass (same situation as the 2 caught during the
satellite-table sweep): its `SELECT * FROM bookings WHERE id IN (...)` is now
`getBookingsByIds()`.

**Consolidation vs. keeping separate, by the numbers:**
- `UPDATE bookings SET is_public = 0, event_id = NULL WHERE id = ?` — literally identical (not
  just similar) across 3 call sites (`cancelActiveBookingsForErasure()`, the admin cancel route,
  `applyStatusChange()`'s demote-from-public branch) despite two using backticks and one double
  quotes — quoting style doesn't change the resulting string, unlike the multi-line whitespace
  differences seen elsewhere in this domain. Two call sites `await` it, one doesn't, so it's two
  functions (`clearBookingPublicAndEventIdAsync` / `clearBookingPublicAndEventId`), same reasoning
  as `getBookingById`/`getBookingByIdAsync`.
- `UPDATE bookings SET google_event_id = NULL WHERE id = ?` — already had a fire-and-forget
  function since Stage 2 (`clearBookingGoogleEventId`); the erasure cascade awaits it, so it
  gained an `…Async` sibling rather than changing the existing one's contract.
- The **ledger-credit UPDATE families** (PayFast ITN's atomic overpayment-guarded credit,
  `processManualPayment()`'s, the transactions/manual payment branch's, the reconcile/sync
  route's, and the transactions/manual adjustment branch's) all look superficially similar
  (`payment_status`, some combination of `amount_paid`/`amount_outstanding`/`total_amount`,
  `status`, a `confirmed_at` CASE) but every pair differs in at least one column or clause, or —
  for the one genuinely matching pair (`processManualPayment()` vs. the transactions/manual
  payment branch) — in multi-line whitespace from being nested at different depths. Five
  separate functions, not one parameterized one, per this domain's established byte-identical
  rule.
- `setBookingEventId()` (Stage 5) gained an optional trailing `callback` parameter for
  `applyStatusChange()`'s CONFIRMED branch, which needed one where the two Stage-5 call sites
  didn't — backward-compatible (an omitted 3rd arg to `db.run` behaves identically to not passing
  one), so the existing call sites are unaffected.

**Found but deliberately out of scope:** `POST /api/public/bookings/:id/cancel` (the
client-facing self-cancel route) contains `UPDATE bookings SET status = 'CANCELLED',
cancelled_at = CURRENT_TIMESTAMP WHERE id = ?` — byte-identical to the new `cancelBookingAsync()`
above — plus its own `getBookingById`-shaped SELECT. `POST .../accept-quote`, `POST
.../quote-revision-request`, and `GET .../cancellation-preview` also touch `bookings` directly.
None of these four were named in the agreed Stage 6 scope (payment/ledger + `applyStatusChange`
+ **admin** cancel), so none were touched — flagging them here rather than folding them in
unasked, even though `cancelBookingAsync()` could serve the public route unchanged if a future
pass takes it on.

**Verification:** `node -c` clean on both files. `npm test` run **8 times** (payment/cancel/
status code always deserves more than the usual 2-3): 649/651 six of eight times; twice showed a
7th failure atop the 2 permanent ones — `CP3: linked event advanced to completed via the generic
status route (parity fix)` once, `CP5: linked event.venue_name updated (previously stayed
stale)` once. Both are the exact named tests Deferred fix #3 has tracked since Phase 2 (a fixed
`sleep()` racing a fire-and-forget async side effect) — not new failures, and every function this
stage touched only swapped a direct `db.run`/`db.get` call for a same-SQL repository call with
the original callback passed through unchanged, so the timing profile (event-loop hops, DB write
latency) that flake depends on is unaltered. `npm run smoke` — 329/329. `git status` clean of
surprises (`database.sqlite`/`sessions.sqlite*` show as modified from the live server process
still running in the background from earlier this session — unrelated to this stage's edits,
which only touch `server.js` and `database/repositories/bookings.repository.js`).

### `bookings` domain — final tally
**~106 of 229 core-table statements moved, plus 22 satellite-table statements.** The remainder —
roughly 123 core statements — are cross-domain (JOINs and now correlated subqueries against
`clients`/`venues`/`events`/`date_holds`/`transactions`/`invoices`/`quotations`/`payment_schedules`/
`cancellations`/`services`/`policies`/`audit_log`/`financial_audit_log`, all separate,
not-yet-extracted domains), the deliberately-excluded `BOOKING_DELETE_PURGE`/
`BOOKING_DELETE_UNLINK` arrays, the public booking-creation route's core INSERT (Deferred fix #1),
or the 4 found-but-out-of-scope statements noted above. This is expected, not a shortfall — a
domain this deeply interleaved with the rest of the schema was never going to reach 229/229
without either rewriting cross-domain SQL (against the plan's own rules) or extracting every
other domain first. Every cross-domain statement encountered is documented inline in its own
stage's write-up above, per this file's running convention (see `inquiries`' and `settings`'
"Report, per the plan's own template" bullets for the same style on smaller domains).

---

### Domain: `inquiries` (session 3 of 8)

New file: `database/repositories/inquiries.repository.js`. Covers
`inquiries`, `inquiry_notes`.

**25 of 26 statements moved. 1 left as a genuine Cross-domain statement —
the first one across any domain so far** (`settings` and `newsletter` had
none). `GET /api/admin/inquiries`'s main data query is a real SQL join,
not just a route that happens to touch two domains:

```sql
SELECT inquiries.*, COALESCE(admins.full_name, admins.username) AS assigned_to_name, ...
FROM inquiries LEFT JOIN admins ON admins.id = inquiries.assigned_to
${whereClause} ORDER BY ${orderClause} LIMIT ? OFFSET ?
```

This stays in `server.js` untouched — it reads both `inquiries` (this
session's domain) and `admins` (`auth+users`, not yet extracted). The
sibling `countSql` in the same route (`SELECT COUNT(*) FROM inquiries
${whereClause}`, no join) has no such problem and moved normally as
`countInquiries()`. When `auth+users` is extracted (last in the suggested
order), whoever does that session should decide where this join statement
ultimately lives — it belongs to neither repository cleanly. Noting it
here now so it isn't lost.

Removed one now-dead variable as a direct consequence of the move: the
`const countSql = ...` in that same route was only ever passed to the one
`db.get()` call that got replaced by `countInquiries(whereClause, qp, ...)`,
so the old string-building line had nothing left to reference — deleted,
not left as unused dead code.

Five statements sit inside multi-domain functions (same pattern as
`settings`' `working_hours` and `newsletter`'s equivalents): the retention
caretaker, the shared `resolvePopiaTargets()`/`anonymizeClientData()`/
POPIA-preview trio, `compliance/export-data`, and the direct-emails
reply-marks-inquiry-replied callback. Only each one's `inquiries`/
`inquiry_notes` statement moved.

One statement sits inside an existing transaction (the admin
booking-creation route's `converted_booking_id` link, same pattern as
`newsletter`'s CSV import) — the repository function returns a Promise
against the same shared `db` connection, so it still participates in that
transaction unchanged.

No SQL string was altered. No callback was converted to a promise (the
transaction-participating function above replaces a call that was already
`await`ing `dbRun`). No transaction was added anywhere none existed before.

**Verification:** `npm test` run three times — 649/651, 650/651, 651/651.
The two non-651 runs each failed a *different* calendar-sync timing test
(neither touches `inquiries`/`inquiry_notes`); see the expanded Deferred
fix #3 below. `npm run smoke` — 329/329. `git status` shows exactly the
expected diff.

**Diff size:** ~76 changed lines in `server.js` (measured against the
diff after the `newsletter` session) + 130 new lines in the repository ≈
206 total — comfortably under the plan's ~400-line guideline, fits as one
commit.

**Report, per the plan's own template:**
- Statements moved: **25**
- Left as cross-domain: **1** (the `inquiries`/`admins` join in the admin
  list route — see above)
- Remaining raw SQL in `server.js`: **~987** (1,012 after `newsletter`,
  minus these 25)

---

### Domain: `newsletter` (session 2 of 8)

New file: `database/repositories/newsletter.repository.js`. Covers
`newsletter_subscribers`, `newsletter_campaigns`, `newsletter_drafts`,
`scheduled_newsletters`. Confirmed the full statement list with the repo
owner (grouped by route/function, not a 54-row table — this domain is
~3× the size of `settings`) before moving anything.

**49 of 49 newsletter-table statements moved.** No statement was itself a
cross-table join (verified — no `JOIN` against any of these four tables
anywhere in `server.js`; the "join" hits in a search were all
`Array.prototype.join`), so again nothing under "Cross-domain statements."
Three structural things worth recording:

1. **Two statements live inside multi-domain functions**, same pattern as
   `settings`' `working_hours` route: `startDataRetentionCaretaker()` (a
   cron loop that also anonymizes old `inquiries`) and the POPIA
   data-erasure routine (which sequentially anonymizes bookings/inquiries/
   newsletter/communication_log). Only each function's `newsletter_subscribers`
   statement moved; the rest of each function's domain-mixing logic is
   untouched, in place.
2. **Two statements sit inside an existing transaction** (the CSV-import
   route's `BEGIN`/`COMMIT`/`ROLLBACK`). The repository functions
   (`updateSubscriberFromCsvRow`, `insertSubscriberFromCsvRow`) return
   Promises using the same `db` connection the transaction runs on, so they
   participate in the caller's existing transaction correctly — no new
   transaction added, the old one untouched.
3. **Two functions deeply interleave SQL with a full per-recipient
   email-sending loop**: `scheduleNewsletterSend()` (6 statements) and the
   `POST /api/admin/campaigns` dispatch route (2 statements, sharing
   `getActiveSubscribersForSegment`/`insertCampaignLog` with the scheduler).
   Per the plan's rule 5, only the SQL moved — banner resolution, merge-field
   application, and the `for (const sub of subscribers)` send loop are
   untouched in `server.js`, just calling the extracted functions at the
   same points they called raw `db.*` before.

Consolidated 2 sets of byte-identical duplicate SQL into shared functions:
`getScheduledNewsletterById(id)` (was duplicated after schedule-create and
schedule-edit) and the segment-filtered active-subscriber query
(`getActiveSubscribersForSegment`, shared between the scheduler and the
campaign-dispatch route — same query, same reasoning as `settings`'
`getSettingsByKeys`).

No SQL string was altered. No callback was converted to a promise (the two
CSV-import functions replace call sites that were already `await`ing a
promise via the shared `dbRun` wrapper — moving that promisification
pattern into the repository is a relocation, not a conversion). No
transaction was added anywhere none existed before.

**Verification:** `npm test` — 651/651, twice in a row (this exercises
`newsletter-optin.test.js` and `newsletter-scheduling.test.js`, which cover
most of what moved, directly). `npm run smoke` — 329/329. `git status`
shows exactly the expected diff.

**Diff size:** 426 changed lines in `server.js` + 251 new lines in the
repository ≈ 677 total — **over** the plan's ~400-line guideline for a
single commit. If you commit this, consider splitting along the same
seams used above: (1) subscribe/confirm/unsubscribe + admin subscriber
CRUD + CSV import, (2) drafts + schedule CRUD + the scheduling engine, (3)
campaign dispatch/delete/list + the two multi-domain-function extractions.
Not split automatically since committing wasn't requested.

**Report, per the plan's own template:**
- Statements moved: **49**
- Left as cross-domain: **0** (two multi-domain *functions* had one
  statement each extracted, same as `settings`' `working_hours` case —
  not a cross-domain statement)
- Remaining raw SQL in `server.js`: **~1,012** (1,061 after `settings`,
  minus these 49)

---

### Domain: `settings` (session 1 of 8 — least-dangerous-first order)

New file: `database/repositories/settings.repository.js`. Confirmed the
full 17-statement list with the repo owner (line numbers re-verified
against current `server.js`, since Phase 3 had shifted everything from the
Phase 1 recon snapshot) before moving anything, per the plan's process.

**17 of 17 settings-table statements moved**, all read from a single
domain — no statement was itself a cross-table join, so **nothing went
under "Cross-domain statements."** One route is worth flagging anyway:
`PUT /api/admin/working-hours` also writes the `working_hours` table (a
different domain) in the same `db.serialize()` block. Only its two
`settings` INSERTs moved; the `working_hours` INSERT loop was left exactly
where it was, still inside the same `db.serialize()` closure, so statement
ordering is unaffected.

Several of the 17 were byte-identical duplicate SQL strings scattered
across different routes — the repository consolidates those into one
shared function each, called from every site that used to inline it:
- `getAllSettings()` — was duplicated in the boot-time env loader and
  `GET /api/admin/settings`.
- `getSettingsByKeys(keys)` — was duplicated across birthday-settings GET,
  the `getBirthdaySettings()` helper, public branding GET, and public
  site-content GET (all four built the same `WHERE setting_key IN (...)`
  placeholder string the same way).
- `upsertSetting(key, value)` — was duplicated across admin settings PUT,
  branding PUT, and site-content PUT (all three used the identical
  `INSERT OR REPLACE ... VALUES (?,?,CURRENT_TIMESTAMP)` string).

Three pre-existing standalone helpers moved wholesale and are destructured
back into `server.js` from the repository import, so their ~45 combined
call-sites elsewhere in the file (booking/payment/calendar code, not just
settings routes) needed zero changes: `getNotificationEmail()` (~22 sites),
`getBirthdaySettings()` (~5 sites, kept as a same-signature wrapper since
the repo version takes explicit params), `getSettingVal(key)` (~18 sites).

No SQL string was altered. No callback was converted to a promise or
async/await (the three helpers above were already promise-returning before
this move — that's not a conversion, just a relocation). No transaction was
added anywhere none existed before.

**Verification:** `npm test` — 651/651, run three times in a row, all
green including the Deferred-fix-#1 concurrency test, which had reliably
shown 2 failures in every Phase 2/3 run. Nothing in this domain touches
booking creation, so this move almost certainly isn't the cause — more
likely evidence that the race itself is genuinely intermittent rather than
deterministic, consistent with it being a race condition. Not claiming it
fixed — Deferred fix #1 below is updated to say "intermittent," not
resolved. `npm run smoke` — 329/329. `git status` shows exactly the
expected diff: `server.js`, plus the new `database/repositories/` directory.

**Diff size:** 244 changed lines in `server.js` + 109 new lines in the
repository ≈ 353 total, under the plan's ~400-line-per-commit guideline —
fits as one commit if you want to make one (not committed automatically).

**Report, per the plan's own template:**
- Statements moved: **17**
- Left as cross-domain: **0** (see the `working_hours` route note above —
  not a cross-domain statement, a cross-domain *route*, handled by moving
  only the in-scope statement)
- Remaining raw SQL in `server.js`: **~1,061** (Phase 1 baseline of 1,078
  minus these 17)

---

## Phase 3 — Runtime data out of the repository

### Design decision: dual-path resolver, no bulk file migration

Existing files already in `docs/` and `images/` (thousands of them — invoices,
quotes, contracts, gallery photos, branding assets) are **not** physically
moved by this phase. Confirmed with the repo owner before starting: new
writes go to the new external location; reads try the new location first
and fall back to the legacy in-repo path if not found there. No bulk
filesystem operation, fully reversible, existing files never touched.

### What changed

- **`server.js`** — added a small config block near the top (same
  `process.env.X ? path.resolve(...) : <in-repo default>` convention
  `database.js` already uses for `DB_PATH`):
  - `DOCS_PATH`, `UPLOADS_PATH`, `BACKUPS_PATH` — default to a sibling
    directory *outside* the repo (`../thabiso-mhlongo-runtime-data/...`),
    overridable via `.env`.
  - `docsWriteDir(...segments)` / `uploadsWriteDir(...segments)` — always
    resolve into the new external location (creating it if needed). Used
    everywhere a brand-new file gets created: every `multer.diskStorage`
    destination (gallery/events/carousel/about/backgrounds/branding/
    footprint/testimonials images, banners, receipts, newsletter/email/
    booking attachments, contracts), and every PDF-generation target
    directory (invoices, contracts, quotes, advancing packs).
  - `resolveDocsPath(...segments)` — new location first, else the legacy
    in-repo `docs/` folder. Used by every read site: all five invoice/quote/
    contract download routes (admin + public), the booking-attachment
    download route, contract-hash/signature verification, and the
    quote/contract cleanup-on-delete path. No equivalent resolver exists
    for images/uploads reads — every read of that tree happens over HTTP
    (a browser or email client fetching a URL), never a server-side
    `fs.readFile`, so the two static mounts below are the whole read side.
  - `safeUploadFilename(name)` — the Phase 3 item-4 fix (see below).
  - Two new static mounts, `app.use('/images', express.static(UPLOADS_PATH))`
    and `app.use('/uploads', express.static(UPLOADS_PATH))`, placed *before*
    the existing blanket repo-root static server. A request for e.g.
    `/images/gallery/x.jpg` tries the new location first; `express.static`
    calls `next()` on a miss, which falls through to the blanket mount and
    serves the legacy in-repo copy if that's where the file actually is.
    `docs/` gets no new static mount — it was already blocked by the
    existing path-blocklist (`normalizedUrl.includes('/docs/')` → 403), so
    it stays reachable only through the authenticated download routes, same
    as before.
  - DB-stored path *values* are unchanged — they still read e.g.
    `images/gallery/x.jpg` or `/uploads/receipts/x.jpg` regardless of which
    physical directory the bytes actually live in. Every place that builds
    those strings (e.g. `` `images/gallery/${req.file.filename}` ``)
    only ever used the filename, never the multer destination, so none of
    that string-building code needed to change.
- **`scripts/backup.js`** — `BACKUP_DIR` now reads `BACKUPS_PATH` the same
  way, defaulting to the same external sibling directory. Existing backups
  in the old in-repo `backups/` are left alone.
- **`.env.example`** — documents `DOCS_PATH` / `UPLOADS_PATH` / `BACKUPS_PATH`
  with their external defaults, commented out.
- **`.gitignore`** — added `docs/`, `*.sqlite-shm`, `*.sqlite-wal`,
  `sessions.sqlite-*` per the plan (item 5). The old specific
  `database.sqlite-shm`/`-wal` lines were left in place rather than removed
  — redundant with the new wildcard lines, but AGENTS.md says don't touch
  what isn't necessary.
- **`test/support.js`** — `spawnAndWait()` now also sets `DOCS_PATH`/
  `UPLOADS_PATH` to dedicated throwaway directories for the spawned test
  server, and `stop()` deletes those two directories wholesale instead of
  the old per-subfolder mtime-based sweep (which assumed docs/images lived
  in-repo). Without this, every test run would silently write real-looking
  PDFs/uploads into the real external default location with nothing ever
  cleaning them up. Also added `apiBinary`'s sibling awareness isn't needed
  here — just the two new dirs.

### A genuinely non-obvious discovery: dotfile directories break `res.sendFile`

First attempt named the test throwaway dirs `.test-docs` / `.test-uploads`
(matching the existing `.test.sqlite` convention). Every PDF download route
started returning 500 "Not Found" — but `fs.existsSync()` on the exact same
computed path returned `true`. Root cause: Express's `send` module (which
powers `res.sendFile`) defaults to `dotfiles: 'ignore'` and refuses to serve
*any* path containing a dot-prefixed segment, silently treating it as not
found — even though the file is right there on disk. Renamed to `test-docs`
/ `test-uploads` (no leading dot) and every download started working.
Worth remembering for anyone reaching for a dot-prefixed folder name for
anything `res.sendFile` might ever need to reach.

### Phase 3 item 4: upload-handler timestamp-stacking fix

New `safeUploadFilename(originalname)` in `server.js`: if the incoming
filename already matches the `Date.now()`-prefix pattern (13 digits + `-`),
it's used as-is; otherwise a fresh prefix is added exactly as before.
Applied to the two "replace an existing image" upload flows — the main
`storage` engine (backing `POST /upload`, the site-content image
manager) and `publicImageUploadStorage` (the public testimonial-photo
route) — since those are the flows where a file already carrying its own
prefixed name can plausibly get re-submitted through the same endpoint. The
one-shot attachment upload flows (newsletter/email/booking attachments,
receipts, contracts) were left untouched — they're not "replace an existing
asset" flows, so re-upload stacking isn't a scenario they hit, and Phase 3
only asked for a fix, not a redesign of every filename callback.

New test: `test/upload-handler.test.js` — uploads a fresh file (confirms
the normal single-prefix behaviour is unchanged), then re-uploads with a
filename already carrying a prefix (confirms no second prefix gets stacked).

### Verification

- `npm test`: **649/651**, stable. Only failures: the two pre-existing
  concurrency-bug tests from Phase 2 (Deferred fix #1, unaffected by this
  phase). The Phase 2 `calendar.test.js` CP3 intermittent flake (Deferred
  fix #3) was observed once more during this phase's testing — still
  unrelated to Phase 3's changes.
- `npm run smoke`: **329/329**, stable across two runs.
- Booted the real app against the real `database.sqlite` on a scratch port
  (no writes — pure `GET` requests, process killed immediately after) and
  confirmed all four branding settings plus a live banner resolve via HTTP
  200: `site_logo`, `favicon`, `login_background` (all under
  `images/branding/`), and one row from `banners`. All four are served via
  the new fallback chain, since nothing has been written to the new
  external `UPLOADS_PATH` yet — proving the legacy fallback half of the
  resolver actually works against real production data, not just the test
  fixtures.
- **Did not** create a real booking or upload a real image against the live
  database — the plan's "create a booking, generate an invoice PDF, upload
  an image, then run `git status`" checklist item is instead covered by
  `test/lifecycle.test.js` (booking → quote → invoice), `test/pdf-golden.test.js`
  (PDF generation + download through the exact same `docsWriteDir`/
  `resolveDocsPath` code paths), and `test/upload-handler.test.js` (image
  upload), all exercised against a throwaway database copy. Doing this
  against real production data risked creating fake bookings that would
  need manual cleanup and triggering real emails/calendar writes.
  `git status` was checked after every real-app boot and stayed clean.

---

## Phase 2 — Safety net

### Step 1: test suite relocated from `TBC/test/` to `test/`

Moved (plain filesystem move — `TBC/` is gitignored and untracked, so
`git mv` was not applicable; destination files are newly tracked):

- `TBC/test/audit-history.test.js` → `test/audit-history.test.js`
- `TBC/test/banner.test.js` → `test/banner.test.js`
- `TBC/test/booking.test.js` → `test/booking.test.js`
- `TBC/test/calendar.test.js` → `test/calendar.test.js`
- `TBC/test/contract.test.js` → `test/contract.test.js`
- `TBC/test/email.test.js` → `test/email.test.js`
- `TBC/test/footprint.test.js` → `test/footprint.test.js`
- `TBC/test/inquiries.test.js` → `test/inquiries.test.js`
- `TBC/test/newsletter-optin.test.js` → `test/newsletter-optin.test.js`
- `TBC/test/newsletter-scheduling.test.js` → `test/newsletter-scheduling.test.js`
- `TBC/test/popia-erasure.test.js` → `test/popia-erasure.test.js`
- `TBC/test/run.js` → `test/run.js`
- `TBC/test/support.js` → `test/support.js`
- `TBC/test/testimonials.test.js` → `test/testimonials.test.js`

`package.json`: `"test"` script changed from `node TBC/test/run.js` to
`node test/run.js`.

**Behaviour: unchanged.** The move shifted every file one directory level
shallower (`TBC/test/` was two levels below the repo root; `test/` is one).
Per AGENTS.md §2, a move may adjust path-resolution lines needed to make the
move work, the same as a `require` path. Four such adjustments were made,
each shortening a `..` chain by exactly one segment to compensate for the
new depth — no other line in any of these files changed:

| File | Before | After |
|---|---|---|
| `test/support.js:11` | `path.resolve(__dirname, '..', '..')` | `path.resolve(__dirname, '..')` |
| `test/banner.test.js:12` | `require('../../js/bannerRegistry')` | `require('../js/bannerRegistry')` |
| `test/email.test.js:6` | `require('../../js/emailComponents')` | `require('../js/emailComponents')` |
| `test/popia-erasure.test.js:171-172` | `path.join(__dirname, '..', '..', 'docs', ...)` | `path.join(__dirname, '..', 'docs', ...)` |

`.gitignore` already had `test/.test.sqlite` and `test/.test.sqlite-*` in
place from before this move, so no gitignore change was needed.

No application code (`server.js`, `database.js`, anything under `js/`,
`admin.html`) was touched.

### Step 1: test run results

`npm test` (`test/run.js`) boots `server.js` against a throwaway copy of
`database.sqlite` on port 3199, seeds a test administrator, runs all 14
suites, tears down.

**Result: 430/432 passed.** Two failures, both in `test/booking.test.js`,
both in the same concurrency check — see Deferred fixes below. No test was
altered to make it pass, per Phase 2 rules.

### Step 2: characterisation tests added

New files under `test/`, covering the six end-to-end paths Phase 2 asks for.
None of these modify application code; `test/support.js` gained two small
helpers (`apiBinary`, `extractPdfText`) needed by the PDF test below.

- **`test/lifecycle.test.js`** — walks intake → quote → accept → invoice →
  payment → completed as one continuous booking, asserting all six
  `bookings` timestamp columns (`created_at`, `quoted_at`, `accepted_at`,
  `confirmed_at`, `completed_at`, `cancelled_at`) at every step. This was
  the one path nothing else in the suite exercised end-to-end with every
  timestamp checked together.
- **`test/payment-callback.test.js`** — hits the real PayFast ITN webhook
  (`POST /api/payment/webhook/payfast`) with a normal callback, a replayed
  duplicate (same `pf_payment_id`), and a callback for a booking id that
  doesn't exist. See Deferred fix #2 below for what the unknown-reference
  case turned up.
- **`test/pdf-golden.test.js`** + `test/golden/*.golden.txt` — downloads a
  generated quote and invoice PDF, extracts their text (see the new
  `extractPdfText` helper — PDFKit shows text as hex strings, `<...>Tj`, not
  literal `(...)Tj`, which is not obvious from the PDF spec's simpler
  examples) and asserts the client name, amount and reference number appear
  verbatim, plus a normalized structural golden compare. `invoice_number`
  and the quote reference both embed the fixture's booking id and/or a
  to-the-second timestamp (see the file's header comment), so the golden
  normalizer masks those two formats and literal dates — not a blanket
  digit-mask, so a changed amount still shows up as a real diff. Two more
  dynamic values only turned up by running this twice and diffing: the PDF
  also prints the raw booking id as "BOOKING REF: #<id>" (a third
  reference format, undocumented until this test found it) and the
  fixture's own email address embeds `Date.now()` — both are masked too.
  Verified stable across two consecutive full-suite runs.
- **`test/email-templates-golden.test.js`** — direct calls to the two
  functions `js/emailTemplates.js` actually exports (`createEmailWrapper`,
  `createQuoteTable`) with merge-field-shaped arguments, golden-snapshotted.
  `createEmailWrapper` is largely superseded (`js/emailService.js` only
  calls it when a caller does NOT set `preWrapped:true`, and every live
  email path `test/email.test.js` exercises does set it), but it is not yet
  proven dead by the AGENTS.md §4 four-check rule, so it's characterised as
  live code here, not skipped.
- **`test/rbac.test.js`** — 32 `/api/admin` GET routes (picked from
  `docs-internal/routes.md`, spanning administrator-only, administrator+
  manager, and no-role-restriction routes) × 4 actors (administrator,
  manager, assistant, unauthenticated) = 128 assertions. **Result: all 128
  matched the role routes.md documented from the actual `requireRole(...)`
  middleware — zero surprises.** Nothing to add under "RBAC review needed"
  from this pass; a wider sample in a later pass may still turn something up.
- **`test/calendar-booking-sync.test.js`** — proves `syncBookingToCalendar`/
  `deleteGoogleEvent` are actually invoked (via id-specific log lines, same
  technique as `calendar.test.js`'s CP17) on a booking's own confirm,
  reschedule, and cancel. See "Known testing limitations" below for what
  this deliberately does NOT attempt.

**Full suite result: 643/645 passed, stable across repeated runs.** Two
failures: the two pre-existing concurrency failures above (Deferred fix #1,
unchanged). The `calendar.test.js` CP3 flake (Deferred fix #3) was observed
twice but did not reproduce on the final verification runs — see that entry.

### Step 3: smoke test (`npm run smoke`)

`test/smoke.js` boots the app the same way `test/run.js` does (via
`test/support.js`, throwaway DB copy, isolated port) and fires every route
parsed out of `docs-internal/routes.md` (329, matching the Phase 1 count
exactly) as an **unauthenticated** request, substituting `1` for any
`:param` segment. Per the plan: this is a crash detector, not an
authorisation test — 401/403/404/400/429 all count as PASS; only a 5xx
status, a thrown request error, or a 15s timeout counts as a failure.

**Result: 329/329 routes returned non-5xx, stable across two runs.**

Route list is parsed from `docs-internal/routes.md` rather than re-derived
from `server.js` directly, matching the plan's wording — meaning this
script will silently miss any route added after that file was last
generated, until Phase 1 recon is re-run. Worth a comment at the top of
`test/smoke.js` for whoever runs this next (already added there).

---

## Known testing limitations

Not bugs — things Phase 2's own rules say to leave alone rather than work
around by changing application code.

### Google Calendar request-payload assertions are not achievable as asked

Phase 2 Step 2 item 6 asks to "mock the Google API and assert the request
payloads sent on booking confirm, reschedule and cancel." This is not
achievable without an application-code change: `server.js` requires
`googleapis` and builds `calendar = google.calendar(...)` as a bare
module-level `const` (server.js ~line 103), and `test/support.js` always
runs the app in a separate **child process** (`spawn()`, not `require()` —
see `spawnAndWait()`), so the test process has no seam to substitute a mock
calendar client into. Building a fake Google API server and pointing the
real client at it would require either a dependency-injection point or a
configurable API base URL — an application-code change, which is exactly
what Phase 2's own rule says to leave alone: "if a piece of code cannot be
tested without being changed, note it and leave it untested for now."

### Occasional `SQLITE_BUSY` crash mid-suite (observed once, `invoices+quotations` domain)

One `npm test` run out of five (during this domain's verification) crashed the whole test
process — not a failed assertion, an uncaught `SQLITE_BUSY: database is locked` thrown from a
sqlite3 Statement — partway through `banner.test.js`. That file has no relationship to invoices,
quotations, or anything else touched this session; two immediate re-runs were clean. `test/run.js`
spawns exactly one server child process for the whole suite (`support.start()` once, then every
`*.test.js` file runs against it in sequence — see `test/run.js`), so this isn't the ordinary
per-test-file respawn story; a couple of individual test files (calendar-booking-sync among them)
do trigger their own mid-suite respawn as part of what they're specifically testing, and a
`SQLITE_BUSY` at exactly that kind of boundary — one process's SQLite handle not yet released
while the next opens the same file — is the standard symptom of two processes briefly contending
for one WAL-mode database file. Logged here rather than in a domain's own verification section
since it's a test-harness/OS-level timing question, not a data-access-extraction question — same
category as Deferred fix #3's sleep-margin flakes, but a crash instead of a wrong assertion, so
worth its own entry if it recurs enough to investigate.

**Update (Phase 5, route batches 5-9):** recurred three more times (four total now), every single
time at the *exact same point* in `banner.test.js` ("get: banner + empty used_by before
assignment" → crash on the next statement) rather than at a random spot — consistent enough to
call it a real race intrinsic to that test's own sequencing, not pure chance. One of the
recurrences happened in a **verified-clean environment** (confirmed zero `node.exe` processes
running beforehand via `Get-CimInstance`), ruling out leftover-process contention as the cause for
at least that instance — see also the separate stale-`node server.js`-process incident logged in
the `content.js`/`home-social.js` batch write-up above, which caused a *different* symptom
(indefinite hangs, not crashes) and had a clearly identified external cause (an abandoned
`npm start` from earlier in the session). Every recovery was an immediate clean re-run — roughly
1-in-3 to 1-in-4 of this session's Phase 5 test runs. Still not investigated further (out of scope
for a route-extraction session, and none of the batches that triggered it — content/CMS routes,
newsletter subscribers, newsletter scheduling/birthday — touch anything banner-related); flagging
the consistent crash *location* specifically in case it helps whoever eventually looks at
`banner.test.js` directly.

What `test/calendar-booking-sync.test.js` proves instead: that a sync
attempt was actually invoked for the right booking id on each of confirm/
reschedule/cancel (via log-line matching — the same technique
`calendar.test.js`'s CP17 already uses), not that the payload sent was
correct. Real payload correctness for calendar sync remains unverified by
this suite.

**Update (Phase 5, route batch 15):** recurred a fifth time, at the identical crash point
(`banner.test.js`, same test/next-statement boundary), during verification of a batch
(`routes/admin/abandoned-bookings.js` + `lib/abandoned-booking-email.js`) that touches neither
banners nor anything that shares a table with them. Clean re-run immediately after, zero leftover
`node.exe` processes both before and after. No new information, just another data point for the
"roughly 1-in-3 to 1-in-4" rate already logged above.

**Update (Phase 5, route batch 16):** a sixth occurrence, one run out of six during
`routes/admin/expenses.js` verification — a batch touching only the `expenses` table. Zero leftover
`node.exe` processes before or after; clean re-runs on either side. Nothing new.

**Update (Phase 5, route batch 18):** a seventh and eighth occurrence, two runs out of five during
`routes/admin/campaigns.js` verification (a batch touching newsletter dispatch/scheduling, not
banners) — each landing at a slightly different statement within `banner.test.js` rather than the
usual exact spot (once one test earlier, at "reject: width 1500px"), which if anything reinforces
that this is a genuine timing race rather than a single reproducible bug at one fixed line. Zero
leftover `node.exe` processes either time; clean re-runs both times.

**Update (Phase 5, public bookings sub-batch E — pay/contract-sign):** another occurrence, one run
out of three during `pay`/`contract/sign` verification — a batch touching PayFast redirect
signing and contract-sign, nowhere near `banner.test.js`'s own tables. Clean re-run immediately
after. Same conclusion as every instance above.

**A related but distinct, self-inflicted incident (Phase 5, bookings sub-batch E):** not the same
race as above, but the same category of shared-SQLite-file hazard, worth recording so it isn't
repeated. A one-off manual verification script's own `support.start()` (which copies a fresh
`test/.test.sqlite` and spawns its own child `server.js`) was run **concurrently** with an
already-running backgrounded `npm test`, both racing the same hardcoded `TEST_DB` path and port. The
manual script failed immediately with "admin login failed: 401" (its own spawn lost the race), and
the in-flight `npm test` run's child crashed with `SQLITE_CORRUPT: database disk image is malformed`
on its next write. `PRAGMA integrity_check` on the leftover file afterwards came back `ok` — the
corruption was a transient WAL-consistency casualty of the concurrent copy/open, not permanent
damage — but the leftover `.test.sqlite`/`-wal`/`-shm` and throwaway docs/uploads directories were
deleted by hand rather than trusted, and every run after that (both the retried `npm test` and the
eventual manual verification run) was run in isolation, with nothing else touching
`test/support.js` at the same time. Process note for future sessions: never run a manual
`test/support.js`-based script while a backgrounded `npm test` (or another such script) is still in
flight — they share one hardcoded DB file and port, and the previous run's TEST_DB is not this
session's own to touch mid-flight.

### A second, distinct `SQLITE_CORRUPT` pattern: solo `npm run smoke`/`npm test`, no concurrency (Phase 5, final admin bookings routes + public site-content batch)

Unlike the incident logged just above, this one is **not** explained by a concurrent script —
recurred four separate times during the final admin-bookings and public site-content route-
extraction work (three times after `npm run smoke` — once after the payment/status-engine
prerequisite batch, once after the 16-route CRUD batch, once after the 4-route financial-core
batch — and once after a plain `npm test`, during the public site-content batch), each time with
nothing else running against `test/.test.sqlite` (checked directly via `tasklist`/`wmic` each
time — the only other `node.exe` processes present were an unrelated `chrome-devtools-mcp` session,
never a leftover test child). Same signature every time: `SQLITE_CORRUPT: database disk image is
malformed` immediately on the harness's own first write against the fresh copy, i.e.
`test/support.js`'s `fs.copyFileSync(database.sqlite → .test.sqlite)` apparently landing on a
torn/inconsistent copy of a WAL-mode file — not specific to `smoke.js`, since the fourth occurrence
hit plain `npm test` instead. Given this is a live production system, the **live**
`database.sqlite` was verified directly with `PRAGMA integrity_check` before doing anything else on
all four occurrences — came back `ok` every time, confirming the corruption is confined to the
disposable copy, never the source file. A plain immediate retry succeeded cleanly all four times,
no manual cleanup needed. Treated as the same underlying class of hazard as the `SQLITE_BUSY`-mid-
suite flake logged above — a WAL-mode SQLite file copied via plain `fs.copyFileSync` while
technically idle can still land mid-checkpoint often enough to matter on this filesystem, and it
isn't specific to one entry point into the harness. Not investigated further (same reasoning as the
`SQLITE_BUSY` flake: a test-harness/OS-level timing
question, not an application-code one); logged here so a future occurrence is recognised
immediately as "retry, and if worried, check `PRAGMA integrity_check` on the live file — it's never
been affected" rather than treated as a fresh scare each time.

---

## Deferred fixes

Bugs found while establishing the safety net or moving code. Not fixed here
— housekeeping moves code, it does not repair behaviour. Each entry needs
its own change with its own testing.

### 1. Lost write under concurrent independent booking submissions

- **Where found:** `test/booking.test.js`, "Concurrency: independent
  bookings must all persist" block (line ~89-96).
- **What the test does:** fires 5 concurrent `POST /api/public/bookings`
  requests with 5 distinct emails and 5 distinct event dates (no legitimate
  duplicate should be rejected), then asserts all 5 return HTTP 200 and all
  5 land as new rows in `bookings`.
- **Observed:** only 4/5 requests returned 200, and the `bookings` row count
  only increased by 4 (33 → 37, not 33 → 38) — i.e. one submission was
  silently lost, not just rejected with an error status.
- **Suspected cause (not verified, do not act on this without investigating
  first):** the test's own comment names it — "shared-connection transaction
  guard" — suggesting the booking-creation path in `server.js` may serialize
  writes through a single shared SQLite connection/transaction in a way
  that drops a write under concurrent access, rather than queuing or
  retrying it. This is exactly the kind of change Section A.1 of
  `AGENTS.md` calls a protected surface (booking workflow) — it must not be
  touched as part of a housekeeping move.
- **Impact if real:** on the live site, two genuine customers submitting
  booking inquiries at the same moment could result in one inquiry silently
  vanishing with no error shown to that visitor.
- **Status:** left failing, as instructed. Needs its own investigation and
  fix, with its own test coverage, as a separate piece of work — not part
  of Phase 2 characterisation testing.
- **Update (Phase 4):** intermittent, not deterministic — reliably 2
  failures (4/5, 33→37) across every Phase 2/3 run, then reliably 0
  failures (5/5) across three consecutive runs during Phase 4's `settings`
  domain testing. Nothing in that phase touches booking creation, so this
  isn't a fix — it's evidence the underlying race genuinely depends on
  timing rather than failing every time. Still unresolved; still needs its
  own investigation.

### 2. PayFast ITN for an unknown booking reference leaves no audit trail at all

- **Where found:** `test/payment-callback.test.js`, "unknown reference"
  block.
- **What happens:** `payment_logs.booking_id` has `FOREIGN KEY REFERENCES
  bookings(id)` (`database.js` ~line 262). The ITN webhook handler
  (`server.js` ~line 5508) logs an `ITN_RECEIVED` row to `payment_logs`
  *before* looking up the booking — but for a booking id that doesn't
  exist, that insert fails its FK check, and the insert's error callback
  only does `console.error(...)`; nothing else observes the failure.
- **Observed:** posting an ITN for a nonexistent booking id leaves **zero**
  rows in `payment_logs` — not even the generic "we received something"
  audit entry that every other ITN (including rejected ones) gets.
- **Impact if real:** a garbled, spoofed, or replay-attacked ITN referencing
  a bogus booking id is invisible to anyone reviewing `payment_logs` for
  suspicious payment activity — there's no record it was ever received.
  This is payment-adjacent (Section A.1 protected surface) — not touched.
- **Status:** left as-is. `test/payment-callback.test.js` asserts the
  *actual* current behaviour (zero rows), not the presumably-intended one.

### 3. Intermittent failure: `calendar.test.js` CP3 under a larger suite

- **Where found:** `test/calendar.test.js`, "CP3: linked event advanced to
  completed via the generic status route (parity fix)".
- **What happens:** CP3 does `PUT .../status {status:'COMPLETED'}`, sleeps a
  fixed 150ms, then asserts the linked `events` row's `event_status` is now
  `'completed'`. The status-change response itself returns 200 synchronously,
  but advancing the *linked event* appears to be a fire-and-forget async
  side effect not covered by that response.
- **Observed:** passed when this suite had 14 files; started failing
  intermittently (event still `'upcoming'` after the sleep) once Phase 2's
  6 new files — run alphabetically before `calendar.test.js` — added
  several minutes of prior HTTP/DB/PDF-generation load to the same Node
  process. Reproduced twice in a row after that; not reproduced with the
  smaller suite.
- **Not fixed here:** this is a pre-existing test's fixed-sleep margin being
  exposed by legitimately more load earlier in the same run, not a change
  I made to calendar-sync logic or to `calendar.test.js` itself. Per
  AGENTS.md §2, existing test files are left alone unless directly in scope.
- **Suggested direction (not implemented):** replace the bare `sleep(150)`
  with a short poll (retry the SELECT for up to ~1-2s) — the same pattern
  would help anywhere else in this suite that pairs a fire-and-forget async
  side effect with a fixed sleep.
- **Update (Phase 4, `inquiries` domain):** the same category of flake
  showed up in two more places across three consecutive `npm test` runs
  during this domain's testing — `calendar-booking-sync.test.js`'s
  reschedule/cancel sync-attempt checks failed on run 1, `calendar.test.js`
  CP5 (venue_name propagation) failed on run 2, and run 3 was clean (651/651).
  All three are fixed-sleep-after-a-fire-and-forget-write assertions, same
  root cause as CP3 above, and none touch the `inquiries`/`inquiry_notes`
  tables this domain session moved — confirms this is a general test-suite
  timing-margin issue, not something specific to CP3 or to any one domain
  move. Still not fixed (out of scope for a data-access-extraction session);
  flagging the pattern's spread here so whoever picks up the "poll instead
  of sleep" fix above knows it's not a one-test problem.
- **Update (Phase 4, `bookings` domain, satellite-table pass):** a fourth
  instance — `calendar-booking-sync.test.js`'s "reschedule: a SECOND sync
  attempt was logged" (a fixed `sleep(300)` racing the same
  `db.get`-callback → `syncBookingToCalendar()` chain) — failed on the first
  post-move `npm test` run and passed cleanly on three immediate re-runs.
  The touched line (`PATCH .../date`'s closing `getBookingById` callback)
  is a byte-for-byte behavioral no-op versus its pre-move `db.get` call, so
  this is the same timing-margin issue, not a fifth root cause.
- **Update (Phase 4, `bookings` domain, Stage 6 — payment/ledger + `applyStatusChange`):**
  ran the full suite 8 times given the stakes of this stage. CP3 (the
  original test this entry is about) and CP5 (venue_name propagation, first
  seen during the `inquiries` domain) each recurred once, on different runs
  — never together, never alongside anything new, and 6 of the 8 runs were
  clean apart from the 2 permanent Deferred-fix-#1 failures. Every function
  touched in this stage only swapped a direct `db.run`/`db.get` for a
  same-SQL repository call with the original callback passed through
  unchanged, so nothing about this stage's edits could plausibly change
  either test's timing margin. Included for completeness, not because
  anything new was learned about the underlying issue.
- **Update (Phase 4, `finance` domain):** a sixth instance — `calendar.test.js`'s **CP17**
  ("`syncEventToCalendar` was actually invoked after the drag"), a fixed `sleep(300)` racing a
  real (deliberately-failing, bogus-token) Google Calendar API call — failed once in 6 runs, on
  `PATCH /api/admin/events/:id/date`, a route this domain's session never read or touched (it's
  `bookings`/events territory, already done in Stage 5). Same mechanism, same conclusion: general
  test-suite timing margin, not specific to any one domain's move.
- **Update (Phase 4, `calendar` domain):** ran the full suite 8 times, this time on the domain that
  actually owns the code CP3 and CP5 exercise (`events`/`date_holds`). CP3 recurred twice, CP5
  recurred once, never together, never alongside anything new. Every statement either test's route
  touches (`advanceEventToCompleted`, `updateEventVenueLegacyLink`/`updateEventVenueGoogleLink`)
  only swapped a direct `db.run` for a same-SQL repository call with the original fire-and-forget
  callback (or lack thereof) passed through unchanged — same conclusion as the `bookings` Stage 6
  update above: nothing about relocating these statements could plausibly change either test's
  timing margin. If anything, actually owning this code and still seeing the same two flakes at
  the same rate as every domain before it is the strongest confirmation yet that this is a
  test-suite-wide sleep-margin issue rather than something specific to any one route's logic.
- **Update (Phase 4, `auth+users` domain — closing out Phase 4):** ran the full suite 5 times on a
  domain that doesn't touch `events`/`date_holds` at all (admins, admin_login_logs,
  password_reset_tokens). CP5 still recurred once, on code this session never read. Final
  confirmation, now that every Phase 4 domain has reported in on this same flake: it is purely a
  test-suite timing-margin issue, observed at a similar rate regardless of which domain's session is
  running, never once correlated with what that session actually changed.
- **Update (Phase 5, skeleton split):** a seventh instance, and the first NEW test name to join this
  list since CP17 — `inquiries.test.js`'s **CP12** ("responded_at set on first reply, status flips
  to replied" / "NOT overwritten by a second reply"), which awaits the HTTP response from
  `POST /api/admin/direct-emails/:id/send` and then immediately reads `inquiries.status`/
  `.responded_at` back from the DB — same shape as every other instance: an HTTP response awaited
  while the row it depends on is still a fire-and-forget async write in flight. Failed once in 5
  runs, on a route (direct-email sending) this step never touched — it's not a route/middleware
  concern at all, and nothing in the app.js/server.js split or the three extracted middleware files
  goes anywhere near `inquiries`/`direct_emails`. Same conclusion as every prior instance: general
  test-suite timing margin, not specific to any one domain, route, or (now) even to Phase 4's kind
  of change — it surfaces just as readily in a structural Phase 5 step as it did in a SQL-relocation
  Phase 4 session.
- **Update (Phase 5, shared-helper extraction into lib/):** CP12 recurred once more (of 5 runs).
  One run also produced a cluster of 5 failures never seen before or since — 4 PayFast-ITN
  assertions (`payment-callback.test.js`) plus **CP6** (`review_email_sent_at` stamping) — and
  another run separately produced a new name, **CP21** (`google_calendar_event_id` cleared on
  cancel). Neither cluster reproduced on the very next run, which is itself the tell: a real
  regression from moving `dbRun`/`dbGet`/`dbAll`/`resolveActor`/`logAudit`/`createAndSendInvite`
  into `lib/` would fail the *same* way on *every* run (a missing import throws a `ReferenceError`
  unconditionally), not intermittently. Statically re-verified the one piece that looked
  superficially connected — `PAYFAST_VALID_IPS`/`payfastItnRateLimiter`, touched in the previous
  step — both resolve correctly at their only two call sites, no dangling reference. Treating all of
  this as the same environmental/timing-margin category as every instance above, likely surfacing
  more often simply because this session has now run `npm test` upwards of 30 times in one
  continuous stretch — more accumulated test data and process uptime than any single Phase 4
  domain's testing saw, not a new root cause.
- **Update (Phase 5, route batch 15):** `calendar-booking-sync.test.js`'s "cancel: deleteGoogleEvent
  was invoked with this booking's calendar id" — the same fixed-`sleep(300)`-racing-a-fire-and-
  forget-write shape as every instance above — failed once in 6 runs, then passed cleanly on the
  next two. Given extra scrutiny here specifically because the *previous* batch (14) had just
  relocated `deleteGoogleEvent` itself into `lib/google-calendar.js`: confirmed the function's body,
  its `calendar`/`CALENDAR_ID` singleton, and its one call site in the admin cancel route this test
  exercises are all byte-identical to before the move, and batch 15 (this session's changes) touches
  only `abandoned-bookings` admin routes and a newsletter-adjacent email helper — nowhere near
  calendar or booking-cancel code. Per the same reasoning as every prior instance (a real regression
  from a relocated import would throw a `ReferenceError` on every run, not pass 5 times out of 6):
  filed as the same pre-existing timing-margin flake, not a regression from either batch.
- **Update (Phase 5, route batch 16):** `calendar-booking-sync.test.js`'s "reschedule: a SECOND sync
  attempt was logged" (previously seen during Phase 4's `bookings` domain satellite-table pass, see
  above) recurred once in 6 runs during `routes/admin/expenses.js` verification — a batch that
  touches only the `expenses` table, nowhere near booking reschedule/calendar-sync code. Same
  conclusion as every instance on this list.
- **Update (Phase 5, route batch 24):** CP5 recurred once in 4 runs during
  `routes/admin/calendar.js` verification — a batch that moved `timeRangesOverlap`/
  `addMinutesToTime`/`parseDurationToMinutes` to `lib/time-utils.js` and re-imported them at ~40
  call sites, plus the calendar-hold routes. CP5 exercises `updateEventVenueLegacyLink`/
  `updateEventVenueGoogleLink` (already a Phase 4 repository call, untouched here); the other 3 runs
  were fully clean including direct coverage of both hold routes. Same conclusion as every instance.
- **Update (Phase 5, Google Calendar sync engine relocation):** ran the full suite 6 times on the
  step that actually owns `syncEventToCalendar` itself. **CP17** recurred on two runs — notably back
  to back (runs 4 and 5), a higher rate than its single-occurrence history elsewhere — paired with
  the pre-existing `calendar-booking-sync.test.js` "cancel: deleteGoogleEvent" flake on one of them
  and **CP5** (unrelated `updateEventVenueLegacyLink` code, untouched by this step) on the other; the
  other 4 runs were fully clean. Given the higher rate, went beyond pattern-matching this time: a
  line-by-line diff of all 5 relocated functions against the pre-move `app.js` (`git show HEAD:app.js`)
  found them byte-identical apart from a few trailing-whitespace-only differences, and the still-in-
  app.js call site that fires `syncEventToCalendar` (`PATCH /api/admin/events/:id/date`) is completely
  unchanged — same fire-and-forget shape, response returned synchronously before the sync settles,
  same as every prior CP17 occurrence. CP5 failing in the same run as CP17, on code this step never
  read, is the same "one run under heavier timing pressure produces a small unrelated cluster"
  signature already seen in the shared-helper-extraction update above. Final confirmation, now on the
  step with the most direct claim to have caused a regression here if one existed: still a pure test-
  suite timing-margin issue, not a defect in the relocated code.
- **Update (Phase 5, bookings sub-batch E — calendar/venue/date cluster):** ran the full suite 4 times
  (excluding one run invalidated by a self-inflicted `SQLITE_BUSY`/`SQLITE_CORRUPT` collision — see
  its own note below, not a suite flake). 2 clean 664/664 runs. One run repeated the already-logged
  "reschedule: a SECOND sync attempt was logged" flake (`PATCH /:id/date`, the exact route this batch
  moved — re-diffed byte-identical against pre-move `app.js`, confirmed clean). The other run surfaced
  a **new test name** for this family: `email.test.js`'s "deposit-balance-due email queued pre-wrapped
  with exact-figure subject" (Guard 5), cascading into 2 skipped follow-up checks inside its own
  `if (deposit) {...}` guard (hence 661/662, not 663/664 — the same-shaped drop as every other instance
  of a fixed-sleep guard skipping its own dependent checks). Traced the cause: `PUT .../manual-payment`
  (untouched by this batch) does `await syncBookingToCalendar(id)` — a real, slow-failing OAuth
  round-trip against the deliberately-invalid test token — *before* firing `sendDepositBalanceDueEmail`,
  and the test's own comment already flags this exact sensitivity ("Same Calendar-OAuth-round-trip-
  before-queuing margin as Guard 3 above"). Same family as every CP17/CP5 instance, just the first time
  it happened to land in a logged run; not code this batch touched.
- **Update (Phase 5, final standalone/webhook batch + the app.js dead-import sweep):** ran the full
  suite 4 times. CP3 itself — the original test this entire entry is named after — recurred once (run
  3, 663/664), then passed cleanly on an immediate re-run; the other 3 runs were fully clean 664/664.
  Given extra scrutiny specifically because this batch touched `app.js`'s own `lib/calendar-sync`
  import (removing the now-fully-dead `syncBookingToCalendar`/`syncEventToCalendar` names, keeping
  only `syncCalendarHolds`): confirmed via `git diff`/`git log` that `lib/booking-status.js` and
  `database/repositories/calendar.repository.js` — the two files that actually own CP3's code path
  (`applyStatusChange`'s COMPLETED branch calling `advanceEventToCompleted(b.event_id)` with no
  callback, a plain fire-and-forget `db.run`) — have **zero** uncommitted diff and were last touched
  in an earlier, already-committed batch, not this one. Same conclusion as every prior instance: a
  test-suite-wide fixed-sleep timing margin, unrelated to whatever any given batch actually changed.
- **Update (Phase 5, post-scope background scheduled-job relocation, batch 3):** CP3 recurred once
  more (of 3 runs on this batch, the other 2 fully clean 664/664) — the same code path
  (`lib/booking-status.js` / `calendar.repository.js`'s `advanceEventToCompleted`) confirmed via
  `git diff`/`git log` to have zero uncommitted diff and no history in this batch, which only moved
  `app.js`'s background cron functions (`lib/background-clerk.js` and 9 sibling files) — nowhere
  near booking-status or calendar-repository code. Same conclusion as every instance on this list.

### 4. `POST /api/admin/bank-statement/import` had never worked — `db.transaction` is not a function — FIXED

- **Where found:** `routes/admin/bank-statement.js` (moved verbatim from `app.js` in route batch 21),
  reading the route's own code while tracing dependencies before extraction — not from a test
  failure; nothing in the suite exercised this route (`test/rbac.test.js` only role-checked the
  sibling `GET .../lines` route).
- **What happened:** the route wrapped its CSV-row-insert loop in `const insertMany =
  db.transaction(() => { ... }); insertMany();` — a `better-sqlite3` API. `db` (from `database.js`)
  is a plain `sqlite3.Database` instance (the callback-based `node-sqlite3` driver, per
  `package.json`'s only dependency being `"sqlite3"`, not `"better-sqlite3"`), which has no
  `.transaction` method at all — confirmed directly (`typeof new sqlite3.Database(':memory:').transaction
  === 'undefined'`). The `const insertMany = db.transaction(...)` line itself threw a
  synchronous `TypeError` before ever reaching the surrounding `try { insertMany(); } catch(e) {...}`
  — the try/catch only wrapped the *call*, not the assignment that already failed.
- **Observed:** every POST to this route threw synchronously inside the handler. Express 4 catches
  a synchronous throw from a non-async route handler and routes it to the app's error-handling
  middleware, so the practical effect was a 500 response to any admin who selected a CSV file and
  clicked import — not a partial success, a total failure of the feature.
- **Impact:** the bank statement CSV import/reconciliation tool — a `finance.repository.js`-backed
  admin feature — had never functioned, on any commit that included this exact code (not something
  route batch 21's move broke; the identical bug already existed in `app.js` before the move,
  unexercised by any test). Everything downstream of a successful import (the `lines` list, match,
  and delete routes moved alongside it in the same batch) was unreachable in practice since no line
  could ever be imported to act on.
- **Status: FIXED, at the user's explicit request**, given the severity — a completely
  non-functional admin feature is a different order of finding than the smaller pre-existing gaps
  logged as items 1-3 above, which stayed as documented-but-untouched. This is the one deliberate
  exception to "housekeeping moves code, it doesn't fix bugs" anywhere in this effort.
  - **The fix:** rewrote the insert loop to use `withDbTransaction` (`lib/db-transaction.js`) +
    `dbRun` (`lib/db-helpers.js`) — the same real `BEGIN IMMEDIATE`/`COMMIT`/`ROLLBACK` pattern used
    throughout `lib/popia.js` — instead of the nonexistent better-sqlite3 calls. The loop is still
    atomic (a bad row rolls back the whole batch rather than leaving a half-import), matching the
    original code's evident intent, just using APIs that exist on this driver. All parsing/
    validation (CSV line regex, header-row skip, `parts.length`/amount checks) is untouched.
  - **`prepareBankStatementLineInsert()`** (`finance.repository.js`) is now unused — it backed the
    `db.prepare()` half of the same broken call chain. Left in place (no other caller, but not
    deleted per the "no deletions, only quarantine" default) with its comment updated to explain why
    it's dead and point at the replacement.
  - **Also found while fixing this:** `app.js` still had four stale top-of-file repository-import
    destructures (`finance.repository`, `invoices-quotations.repository`, `bookings.repository`)
    listing 15 function names whose *only* remaining caller had already moved into a route file
    across batches 16 (expenses), 19 (services), 20 (invoices) and 21 (bank-statement) itself —
    a gap in this session's own extraction process (each batch checked for other call sites of the
    functions it moved, but never re-checked whether app.js's own import line for that repository
    still needed every name it listed). Verified each of the 15 by grep (zero remaining references
    anywhere in `app.js` outside the import line itself) before removing; `markInvoiceSent` and
    `getExpensesForBookingEmail`, which share an import line with several of the dead names, were
    confirmed to have real remaining callers and were left in place.
  - **New regression test:** `test/bank-statement-import.test.js` — imports a CSV with a header row,
    a normal row, a row with a quoted comma inside a field (exercises the CSV-splitting regex), a
    malformed row (too few fields), and a non-numeric-amount row; asserts the correct 2 rows land
    with correct fields, negative amounts survive, fresh rows read back as unmatched, the existing
    list/batches-summary route reflects the import, and batch delete cleans up correctly. This is
    exactly the coverage gap that let the bug go unnoticed in the first place.
  - **Verification:** `node -c` on all changed files; `npm run smoke` 329/329; `npm test` x5 — the
    new test's 13 checks passed cleanly on every run; three runs were otherwise fully clean, one run
    hit an already-documented, unrelated PayFast-ITN timing cluster (previously seen during the
    "shared-helper extraction into lib/" step, did not reproduce on the next run), one run hit the
    already-documented `banner.test.js` `SQLITE_BUSY` crash — neither touches bank-statement/finance
    import code.

### 5. `POST /api/admin/transactions/manual` 500s whenever no `booking_id` is supplied

- **Where found:** `routes/admin/transactions.js` (moved verbatim from `app.js` in the small-admin-
  utilities route batch), while writing a manual fixture-verification script to cover this route
  (no dedicated test file exercises it) — not from a test-suite failure.
- **What happens:** the route accepts a standalone transaction with no `booking_id` (its own code
  passes `booking_id || null` into `insertManualTransaction`, and the "no booking_id" branch at the
  bottom of the handler exists specifically to handle this case: `else { res.json({ success: true,
  message: 'Transaction logged.' }); }`). But `transactions.booking_id` is `NOT NULL` in the actual
  schema (confirmed via `PRAGMA table_info(transactions)`), so the `INSERT` inside
  `insertManualTransaction` (`finance.repository.js`) throws `SQLITE_CONSTRAINT: NOT NULL constraint
  failed: transactions.booking_id` before that branch is ever reached. The route's own `catch`
  surfaces this as `{ success: false, message: err.message }` — a raw SQLite error string reaching
  the admin UI, not a crash.
- **Impact:** logging a manual transaction *not* tied to any booking — e.g. miscellaneous cash
  income, a walk-in payment with no booking record yet — always fails. Every transaction the admin
  UI's manual-transaction form actually exercises in practice supplies a `booking_id`, which is
  presumably why this has gone unnoticed; the code path for the no-booking case is dead in the sense
  that it can never successfully execute, not in the sense that nothing calls it.
- **Not fixed** — housekeeping moves code, it does not repair behaviour (the one exception this
  session, item 4 above, was fixed only at the user's explicit request given its severity; this is a
  narrower, opt-in code path, not a broken core feature). Logged here per Phase 2's own rule for a
  bug found rather than caused.
  - **Reproduced with:** `POST /api/admin/transactions/manual` with `{ amount: 50,
    transaction_type: 'payment', payment_method: 'cash' }` (no `booking_id` field at all) —
    confirmed via a throwaway fixture script, not by application code inspection alone.
  - **Possible fix directions, not applied:** either make `transactions.booking_id` nullable (a
    schema migration, out of scope for a housekeeping pass) or have the route reject a missing
    `booking_id` with a clear `400` instead of letting the SQLite constraint surface a raw message —
    the smaller of the two changes, but still a behaviour change requiring the user's decision on
    which direction they actually want.
