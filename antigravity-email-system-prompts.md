# Thabiso Mhlongo — Email System Redesign
## Antigravity IDE Prompt Pack (Phase 1)

Run these prompts in order, one per agent session (or one per task in the Agent Manager). Each prompt asks the agent to produce a plan/artifact before writing code — review and approve the plan before letting it implement. Commit after each prompt so you can roll back cleanly.

---

## Prompt 0 — Project Rules (add to `.antigravity/rules.md` or paste as context at the start of every session)

```
PROJECT CONTEXT — Thabiso Mhlongo Booking Platform

Brand system (source of truth = index.html "Editorial-Luxe" theme):
- Obsidian background #0A0A0A, section bg #111111, cards #1A1A1A
- Brand Gold #D4AF37, Interactive Gold #E8C14B
- Primary text #FFFFFF, secondary text #B0B0B0
- Display font: Cormorant Garamond | Body: Outfit | Metadata: JetBrains Mono
- Tagline: "Officially funny since 2014"
- Voice: third person for brand statements, first person for CTAs ("Book Me")

HARD RULES FOR ALL EMAIL WORK:
1. Web fonts are NOT reliable in email. Always use fallback stacks:
   - Cormorant Garamond, Georgia, 'Times New Roman', serif
   - Outfit, 'Helvetica Neue', Helvetica, Arial, sans-serif
   - 'JetBrains Mono', Consolas, 'Courier New', monospace
   Real brand fonts may only be assumed inside rasterised banner images.
2. CTAs must NEVER be baked into images. All buttons are bulletproof
   HTML buttons (table-based, with VML fallback for Outlook desktop).
3. Personalisation (client name, booking ref, event name) lives in HTML
   text only — never inside banner images.
4. All layout uses tables with inline CSS. No flexbox, no grid, no
   external stylesheets, no <style> dependence for critical layout.
5. Dark-mode safety: set bgcolor attributes on tables AND background-color
   in inline CSS; include <meta name="color-scheme" content="dark">;
   avoid pure #000000 and pure #FFFFFF (use #0A0A0A / #FAFAFA) to reduce
   auto-inversion damage in Gmail/Outlook dark modes.
6. Every image gets descriptive alt text and explicit width/height.
7. Banner images: 600–700px display width, exported at 2x for retina,
   JPG ~80 quality for photography, target < 80KB each, hard max 100KB.
8. Target clients: Gmail (web + apps), Outlook (desktop + web), Apple
   Mail, Yahoo, Samsung Mail. Gmail clips HTML > 102KB — keep each
   email's HTML under 90KB.
9. Preserve all existing trigger events, recipients, subject-line
   variables, and personalisation tokens exactly. This is a redesign,
   not a rewrite of business logic.
10. Never send real emails during development. Use the existing test
    dispatch mechanism (Admin: Test Notification) or dry-run rendering.
```

---

## Prompt 1 — Codebase Audit & Verified Inventory

```
TASK: Audit the email system in this codebase and produce a verified
inventory. Do NOT modify any code in this task.

1. Locate every outgoing email in the codebase: template files, inline
   HTML strings, email-sending functions, trigger events, and any
   email configuration tables/objects.

2. Produce an artifact `docs/email-audit.md` containing a table with
   one row per email:
   - Internal ID / config key
   - Trigger event
   - Recipient type (Client / Admin / Visitor / Subscriber / User)
   - Subject line template (with variables)
   - Template location (file + line or DB)
   - Current banner/image usage (if any)
   - Personalisation tokens used
   - Notes on current styling

3. I have an external document claiming there are exactly 53 emails in
   these groups: 23 client booking-lifecycle, 13 admin booking
   notifications, 4 contact-form, 3 newsletter, 10 admin/system.
   Confirm or correct this count. Flag any emails in the code that the
   list misses, and any listed emails that don't exist in code.

4. Add a "Redesign Risk" column: LOW (simple transactional), MEDIUM
   (dynamic content blocks), HIGH (complex logic, attachments,
   payment-gateway callbacks like PayFast ITN).

5. Categorise every email by RECIPIENT into two tracks:
   - PREMIUM track: anything a client, visitor, or subscriber receives
   - SYSTEM track: internal admin/ops alerts
   Note: some admin-triggered emails (e.g. contract signature reminders,
   custom booking responses, payment schedule reminders) go to clients —
   they belong in PREMIUM.

6. End with a summary of branding inconsistencies, duplicate markup,
   and technical debt you found.
```

---

## Prompt 2 — Email Design System (Shared Components)

```
TASK: Using docs/email-audit.md, design and build a reusable email
component system. Produce an implementation plan artifact first and
wait for my approval before writing code.

Build these components as reusable partials/functions in whatever
templating approach the codebase already uses (do not introduce a new
templating engine without asking):

1. base_layout — 600px table wrapper, obsidian #0A0A0A body, dark-mode
   meta tags, preheader text slot, bgcolor redundancy per project rules.

2. header — Thabiso Mhlongo logotype (text-based fallback if image
   blocked), optional banner slot referenced by banner_id.

3. banner_slot — renders a banner image by ID from the banner registry
   (Prompt 5 builds the registry; for now, accept a simple map of
   id → {src, alt, headline}). Must degrade gracefully: if no banner
   assigned or image fails, render a styled text headline block in
   Cormorant Garamond stack on #111111 instead.

4. cta_button — bulletproof button: table-based, Brand Gold #D4AF37
   background, #0A0A0A text, VML wrapper for Outlook, 44px min touch
   target. Accepts label + URL. Hover gold #E8C14B where supported
   (progressive enhancement only).

5. info_card — #1A1A1A card with 1px #2A2A2A border for booking
   details, invoice summaries, event info. Label/value rows; values in
   JetBrains Mono stack for refs, amounts, dates.

6. divider, spacer — gold hairline divider and vertical spacing helpers.

7. alert_strip — for warnings/failures: thin gold or amber left-border
   strip on #1A1A1A, no red-on-black (poor contrast).

8. footer — contact info, website link, social links, legal links,
   copyright, conditional unsubscribe slot (only newsletter/marketing
   emails get unsubscribe). Secondary text #B0B0B0.

9. system_header (SYSTEM track only) — compact text-only header, no
   photographic banner: "TM · System Notification" in mono stack,
   category tag, timestamp. Optimised for fast scanning, minimal weight.

Also produce docs/email-design-system.md documenting every component,
its parameters, and a usage example.
```

---

## Prompt 3 — Rebuild the PREMIUM Track Templates

```
TASK: Rebuild every PREMIUM-track email template (client/visitor/
subscriber-facing, per docs/email-audit.md) using the component system
from Prompt 2. Plan first; implement after my approval; work in
batches of 5–6 templates per commit.

Requirements:
- Preserve every trigger event, recipient, subject variable, and
  personalisation token exactly as audited.
- Structure per email: preheader → header (+banner slot) → greeting
  (personalised, Outfit stack) → body copy → info_card where there are
  booking/payment details → one primary cta_button (max two buttons
  total) → footer.
- Copy tone: premium, warm, editorial. Third person for brand
  statements, first person for CTA labels. Include the tagline
  "Officially funny since 2014" in the footer, not the body.
- Rewrite copy where it's inconsistent, but keep meaning and all
  dynamic variables intact. Show me before/after copy for the 5 most
  changed emails in an artifact before finalising.
- Payment-critical emails (invoice, payment failed, refund, deposit,
  overdue) are HIGH risk: change styling and copy only, never amounts,
  references, links, or PayFast-related logic.
- After each batch, render every rebuilt template with sample data to
  static HTML files in a /email-previews folder so I can open them in
  a browser, and generate a browser preview walkthrough.
```

---

## Prompt 4 — Rebuild the SYSTEM Track Templates

```
TASK: Rebuild all SYSTEM-track (internal admin/ops) emails using
base_layout + system_header + info_card + alert_strip. Plan first.

Requirements:
- No photographic banners. Speed of comprehension is the goal.
- Lead with the key fact: booking ref, amount, count, or failure
  reason in the first visual block.
- Severity tags: INFO / ACTION REQUIRED / ALERT rendered as small
  mono-stack labels (gold for action, amber for alert).
- Digest-style emails (overdue payment summary, stalled bookings,
  ledger reconciliation, pending expiry) get a compact table layout
  inside info_card with one row per item.
- Keep subject lines' existing prefixes and variables.
- Render previews to /email-previews as in Prompt 3.
```

---

## Prompt 5 — Banner Registry: Data Model & API

```
TASK: Implement the Master Banner System backend. Plan first with the
proposed schema and endpoints; wait for approval.

Data model (adapt names to the codebase's existing conventions):
- banners: id, name, category, image_url, alt_text, headline,
  subtitle, status (active/archived), created_by, created_at,
  updated_at
- email template config gains: banner_id (nullable FK)
- Categories (fixed list of 11):
  1 Booking Requests, 2 Quotes & Proposals, 3 Contracts & Signatures,
  4 Payments & Invoices, 5 Booking Confirmations, 6 Event Reminders,
  7 Thank You & Reviews, 8 Booking Recovery, 9 Contact & Support,
  10 Newsletters & Marketing, 11 User Accounts & Security.
  (SYSTEM-track emails use no banner — banner_id stays null.)

Behaviour:
- Emails resolve their banner at render time via banner_id; updating a
  banner's image/alt/headline updates every email that references it.
- Graceful fallback per the banner_slot component when banner_id is
  null, banner archived, or image missing.
- Endpoints/handlers: list banners (with usage counts), create, update,
  archive/restore, assign banner to one or many templates, "used by"
  lookup per banner.
- Image upload validation: JPG/PNG only, ≤100KB, width 1200–1400px
  (2x retina), reject otherwise with a clear error message.
- Migration: script that adds the schema, backfills banner_id = null
  for all templates, and (if current templates embed banner images)
  records the old image per template in a migration notes artifact so
  nothing is lost.

Do NOT build version history or restore-previous-versions yet — status
active/archived is enough for MVP. Note version history as a future
enhancement in the plan.
```

---

## Prompt 6 — Redesign brandPanelEmail (Admin Management Centre)

```
TASK: Redesign the Email Branding tab (id="brandPanelEmail") in
admin.html into a Banner Management Centre wired to the Prompt 5 API.
Match the existing admin panel's structure, styling approach, and JS
patterns — audit how other admin tabs are built first, and follow the
same conventions. Plan first.

MVP features (this task):
- Banner Library: responsive card grid; each card shows banner preview,
  name, category chip, status, usage count, last modified.
- Search by name + filter by category + filter by status.
- Create/Edit banner: name, category, headline, subtitle, alt text
  (required), image upload with client-side dimension/size validation
  and live preview at 600px display width.
- Assignment panel: for a selected banner, checklist of all email
  templates grouped by category; assign/unassign in bulk; show a
  complete "Used by" list.
- Global replace: swapping a banner's image updates everywhere —
  show a confirmation dialog listing affected templates first.
- Archive/restore toggle with usage warning ("This banner is used by
  N templates — they will fall back to the text headline block").
- Email preview: pick any template, render it with sample data and its
  assigned banner in an iframe, with a mobile (375px) / desktop (600px)
  toggle.

Explicitly OUT of scope for now: version history, pagination beyond
simple lazy loading, created-by user attribution UI, usage analytics
charts.

Also add an "About" sub-tab: how the master banner system works, the
11 categories, image specs (dimensions, ≤100KB, 2x retina, alt text
required), assignment behaviour, and dark-mode/email-client caveats.
Keep it under 600 words.
```

---

## Prompt 7 — Banner Artwork Briefs (for Claude Design / image production)

```
TASK: Do not generate images. Produce docs/banner-briefs.md containing
11 production-ready creative briefs — one per banner category — that I
will hand to a designer or an image-generation tool.

Each brief must specify:
- Category name and the exact list of email templates it serves (pull
  from docs/email-audit.md)
- Headline text to be rasterised into the image (5–8 words,
  Cormorant Garamond, white or gold) — headlines are generic per
  category, never personalised
- Subtitle (optional, Outfit, #B0B0B0)
- Imagery direction: stage lighting, microphones, theatre, audience,
  spotlights — specific mood per category (e.g. celebratory warm gold
  wash for Confirmations; calm, low-key single spotlight for Contracts;
  clean minimal for User Accounts & Security — no photography, gold
  geometric motif instead)
- Composition: logo placement (consistent corner), text-safe zone,
  40% left-aligned text area / 60% imagery
- Technical: 1300×380px export (displays at 650×190), JPG quality 80,
  ≤80KB target, obsidian #0A0A0A base, gold #D4AF37 accents only —
  no other accent colours
- Alt text (descriptive, ≤120 chars)
- Explicit note: NO buttons, NO CTAs, NO personalisation tokens in
  the artwork

Also produce a coverage matrix mapping all PREMIUM-track emails to
their category so I can verify nothing is unassigned.
```

---

## Prompt 8 — QA, Compatibility & Deliverability Pass

```
TASK: Final quality pass across the entire rebuilt email system.
Produce docs/email-qa-report.md.

1. Static checks on every template's rendered HTML:
   - Total HTML size < 90KB (Gmail clip threshold is ~102KB)
   - All images have alt text + explicit width/height
   - All links absolute URLs; no javascript: or broken tokens
   - Inline CSS only for critical styling; tables for layout
   - bgcolor attribute AND background-color present on structural
     tables; color-scheme meta present
   - Text contrast ≥ 4.5:1 (check gold #D4AF37 on #0A0A0A ≈ 9.9:1 —
     passes; verify #B0B0B0 secondary text on all surfaces)
   - Unsubscribe present on newsletter/marketing emails and List-
     Unsubscribe header set where the sending code supports it
   - Personalisation tokens render with sample data and have safe
     fallbacks when data is missing
2. Dark-mode simulation notes: identify any template at risk of Gmail/
   Outlook auto-inversion and apply mitigations.
3. Plain-text alternative: verify or generate a text/plain part for
   every email (deliverability + accessibility).
4. Regression check: diff the list of trigger events, recipients, and
   subject variables against docs/email-audit.md — must be identical.
5. Produce a manual test checklist I can run using the Admin Test
   Notification dispatch: 6 representative emails (one premium
   transactional, one payment-critical, one recovery, one newsletter,
   one system digest, one security/password reset) to send to a Gmail,
   an Outlook.com, and an Apple Mail address.
```

---

## Suggested execution order & checkpoints

| Step | Prompt | Checkpoint before continuing |
|---|---|---|
| 1 | Audit (P1) | Verified email count matches reality; recipient tracks correct |
| 2 | Components (P2) | Open component demo previews in browser; check dark-mode meta |
| 3 | Premium templates (P3) | Review before/after copy artifact; spot-check 5 previews |
| 4 | System templates (P4) | Digest tables readable at a glance |
| 5 | Banner backend (P5) | Migration runs clean; fallback renders when banner_id null |
| 6 | Admin UI (P6) | Assign → preview → global replace round-trip works |
| 7 | Banner briefs (P7) | Coverage matrix has zero unassigned premium emails |
| 8 | QA (P8) | All static checks pass; run the 18-send manual test |

Then produce artwork from the Prompt 7 briefs, upload via the new admin UI, assign, and re-test.
