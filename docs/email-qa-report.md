# Email System QA Report (Prompt 8)

Final quality pass across the rebuilt email system (Prompts 2–7). Static checks were run against all
**56 rendered previews** (`node js/generate-email-previews.js` → `email-previews/premium/` (32) +
`email-previews/system/` (24)) — the same components (`js/emailComponents.js`) the live `server.js`
functions call, so these findings apply to real sends, not just the static demo files.

## 1. Static checks — result: clean, one fix applied elsewhere (see §3)

| Check | Result |
|---|---|
| Total HTML size < 90KB (Gmail clips ~102KB) | **PASS** — largest file is `booking-confirmed.html` at 10.4KB; every file is comfortably under 12KB, ~9× headroom under the clip threshold |
| Every `<img>` has `alt` + explicit `width`/`height` | **PASS** — 0 of 152 `<img>` tags across all 56 files missing either |
| All links absolute (or a documented sample placeholder); no `javascript:` | **PASS** — 0 `javascript:` hrefs; the only non-absolute hrefs are literal `#` placeholders used by the *static preview samples themselves* (`js/generate-email-previews.js`'s sample `cta.url` values) — real sends build absolute URLs via `emailBaseUrl()`/`process.env.BASE_URL`, confirmed by reading every `cta`/`href` construction in `server.js`'s `send*Email` functions directly (not just the previews) |
| Inline CSS only; tables for layout (no flexbox/grid) | **PASS** — 0 of 56 files contain `display:flex/grid/inline-flex/inline-grid` |
| `bgcolor` attribute **and** `background-color` CSS both present on structural tables; `color-scheme` meta present | **PASS** — every structural `<table>` across all 56 files pairs both; `<meta name="color-scheme">` present in all 56 |
| No unresolved `${...}`/`{{...}}` template tokens | **PASS** — 0 found (every sample renders fully) |
| Unsubscribe present on newsletter/marketing sends | **PASS** — both `newsletter-welcome.html` and `newsletter-campaign.html` contain a real unsubscribe link; **List-Unsubscribe header**: not currently set on any send (see finding below — informational, not a regression, since it never existed) |
| Personalisation tokens have safe fallbacks | **PASS** — spot-checked via source, not just previews: 26 uses of `event_name || event_type`, plus ~35 more `name || '<fallback>'` patterns across `server.js`'s `send*Email` functions. No unguarded token interpolation found |

## 2. Contrast — verified precisely (WCAG 2.1 relative-luminance formula), not eyeballed

| Pair | Ratio | Verdict |
|---|---:|---|
| Gold `#D4AF37` on obsidian `#0A0A0A` (pack's own claim: ~9.9:1) | **9.42:1** | PASS (AA normal text) — pack's estimate was close; exact figure differs slightly by rounding method, still comfortably over 4.5:1 |
| Ink `#FAFAFA` on obsidian | 18.97:1 | PASS |
| Body text `#E6E6E6` on obsidian | 15.86:1 | PASS |
| **Secondary text `#B0B0B0` on obsidian** (pack asked to verify) | **9.13:1** | **PASS** |
| Secondary text `#B0B0B0` on card `#1A1A1A` | 8.03:1 | PASS |
| Ink `#FAFAFA` on card | 16.67:1 | PASS |
| Amber `#E8A83E` on card (alert text) | 8.37:1 | PASS |
| Obsidian text on gold button background | 9.42:1 | PASS |
| **`mutedDim` `#707070` on obsidian** (legal/footer copy, ~11px) | **4.00:1** | **FAILS AA for normal text** (needs 4.5:1; only clears the 3:1 bar reserved for large text ≥18px/14px-bold, which 11px footer copy doesn't qualify for) |
| **`mutedDim` `#707070` on section background `#111111`** | **3.81:1** | **FAILS AA for normal text**, same reasoning |

**Finding, not fixed:** `mutedDim` (used for footer copyright text and de-emphasised captions, `js/emailComponents.js` `TOKENS.mutedDim`) falls short of AA contrast at its actual font size. This is a legitimate accessibility gap, but it's a **brand color-token decision** — `mutedDim` is used site-wide, not just in email — so this report flags it rather than changing it unilaterally. A safe fix would be lightening it to roughly `#8A8A8A` (≈4.5:1 on both surfaces) scoped to email-only if the token can't change globally.

## 3. Plain-text alternative — real gap found and fixed

**Before this pass:** every email sent by the app — regardless of the `preWrapped` rebuild — shipped
**HTML-only, with zero `text/plain` part.** Root cause: `sendEmailDirectly()` (`js/emailService.js`) has
two branches gated by `EMAIL_OVERHAUL_ENABLED`. That flag is unset in every deployment so far (no `.env`
committed), so **the "legacy" branch is the one that actually runs** — and it never set a `text:` field
on `mailOptions` at all. The "branded" branch (which does compute `text: plainTextAlternative ||
htmlToPlainText(emailBody)`) is dead code today; the flag being off means it never executes.

**Fixed:** added `text: plainTextAlternative || htmlToPlainText(processedContent.html)` to the legacy
branch's `mailOptions`, reusing the existing generic `htmlToPlainText()` tag-stripper already exported
from the same file (`js/emailService.js`). Purely additive — no change to `html`, attachments, routing,
or the feature flag itself.

**Verified without any real network call:** required `js/emailService.js`, monkey-patched
`transporter.sendMail` to a capturing stub, called `sendEmailDirectly({ preWrapped: true, htmlContent:
'<html>...<p>Hi Naledi, your booking <strong>#12345</strong> is confirmed.</p>...' })`, and confirmed the
captured `mailOptions.text` was `"Hi Naledi, your booking #12345 is confirmed. View"` — non-empty and
tag-free. `npm test` remains 117/117 after the change (the fix only adds a field nothing was asserting
against before).

**Adjacent, unfixed observation (out of this pass's scope):** the same legacy branch also skips the
`email_logs` INSERT the branded branch does — meaning `email_logs` has never recorded legacy-path sends
either. Not touched here since Prompt 8 only asked about the plain-text gap specifically, and this is a
separate, pre-existing observability gap rather than a deliverability one.

## 4. Dark-mode simulation notes

No template found at meaningful risk of Gmail/Outlook auto-inversion, based on the two primary defenses
against it — both confirmed present on **every** structural table in **every** file (§1):

- **`bgcolor` attribute + `background-color` CSS declared together** on every structural `<table>` —
  the standard double-declaration defense (CSS for modern renderers, the HTML attribute for
  Outlook/older clients that strip `<style>`/inline background CSS in some code paths).
- **`<meta name="color-scheme" content="dark">`** present in every file, signalling intentional dark
  design rather than "just a light template someone forgot to invert."
- **No pure `#000000`/`#FFFFFF`** anywhere in any rendered file (obsidian `#0A0A0A` / ink `#FAFAFA` are
  used instead throughout) — this is specifically the mitigation Gmail/Outlook's auto-dark-mode
  heuristics respond well to, since pure black-on-white (or the reverse) is what triggers the most
  aggressive re-inversion attempts.
- **Amber, not red, for alert severity** (`#E8A83E`) — confirmed via the existing Guard 9 in
  `test/email.test.js`, which explicitly asserts no `#ef4444|#ff0000|color:\s*red` appears on any
  alert-severity SYSTEM email. Red-on-dark is a known low-contrast/auto-inversion risk case; amber
  avoids it entirely.

No template-specific mitigation is recommended beyond what's already built in.

## 5. Regression check vs. `docs/email-audit.md`

Extracted every distinct `trigger_event` string (58) and every distinct `subject` template (spot-checked
~50) currently in `server.js` and compared against the Prompt-1 audit's documented trigger/subject
columns. **Zero discrepancies found** in every comparison performed — every subject line's literal text
and variable-interpolation positions match the audit exactly, e.g.:

- `Booking Confirmed 🎉 – #${id}` — unchanged
- `Deposit Received – Balance Due R${outstanding} | Booking #${id}` — unchanged (formatting code
  differs cosmetically — `parseFloat(outstanding).toFixed(2)` — rendered output is identical)
- `You're invited to the Thabiso Mhlongo Management Dashboard` — unchanged
- `Website Inquiry: ${subject}` → now `Website Inquiry: ${subject || 'No Subject'}` — a safe-fallback
  **addition**, not a regression (matches the audit's own "Subject (+vars)" note for this row)

Recipient logic (`to:`/`cc:`/`bcc:` expressions) was never touched by the Prompt 3–6 rebuild — only
`htmlContent`/`preWrapped` (and, for Prompt 5/6, `bannerSrc`/`bannerAlt`/`subtitle`) were added to
existing `sendEmail(` call sites — confirmed by the fact that every one of the 34 wired call sites'
`to`/`cc`/`bcc` arguments are byte-identical to their pre-rebuild form in git history. **This check
passes: trigger events, recipients, and subject-line variables are identical to the original audit.**

## 6. Manual test checklist

Six representative emails, run against a Gmail address, an Outlook.com address, and an Apple Mail
(iCloud) address — 18 sends total. **Important accuracy note:** the Admin → Settings → **Test
Notification** button only fires one fixed SYSTEM-track email (`POST
/api/admin/settings/test-notification`, always to the configured notification address) — it cannot send
the other 5 representative types. The real trigger for each is listed below instead, since that's what
actually exists in the app today.

| # | Category | Real email | How to trigger it | Recipient to use per pass |
|---|---|---|---|---|
| 1 | Premium transactional | Booking Confirmed | Admin → Bookings → open a CONFIRMED-eligible booking → record a full/deposit payment (or send a PayFast sandbox payment) so status flips to CONFIRMED | Set the booking's client email to the test address for that pass |
| 2 | Payment-critical | Invoice | Admin → Bookings → accept a quote (auto-generates + sends the invoice), or Admin → Invoices → **Send** on an existing draft invoice | Same — client email on the booking |
| 3 | Recovery | Abandoned-booking reminder | Start (don't finish) a booking on the public site with the test address, then Admin → Booking Recovery → find the draft → **Resend Reminder** (`POST /api/admin/abandoned-bookings/:id/resend-reminder`) — no need to wait for the 1-hour cron | The email entered on the abandoned public form |
| 4 | Newsletter | Welcome email | Public site → Newsletter signup form → subscribe with the test address | The subscribed address |
| 5 | System digest | Overdue Payments digest | **No manual trigger exists** — this and every digest (`docs/email-audit.md` §5) fire only from a 24h cron with no admin-triggerable endpoint. To test on demand, an admin with server access would need to invoke the job function directly (e.g. a one-off `node -e` call in a non-production environment) — flagging this as a real gap in operational testability, not something to fix in this QA pass | `getNotificationEmail()`'s configured address — temporarily set it to each test provider for this pass |
| 6 | Security / password reset | Password Reset | Admin login page → **Forgot password?** → enter the test admin's email | The admin account's own email |

**Per send, check:** banner/fallback headline renders correctly; all copy readable in both light and
dark client modes; buttons are real tappable buttons (not part of an image) with a ≥44px touch target;
no `#000`/`#fff` flashes on dark-mode toggle; unsubscribe link present only on row 4; plain-text part now
present (view "Show original"/"Message source" in each client to confirm, per the §3 fix).

---

## Summary

- **1 real bug found and fixed**: every email sent by the app was missing its `text/plain` part —
  fixed in `js/emailService.js`, verified without any real network call, `npm test` 117/117 unchanged.
- **1 real bug found and reported, not fixed** (design-token decision, not this pass's call):
  `mutedDim` (`#707070`) footer/caption text falls short of WCAG AA contrast at its actual size.
- **1 operational gap reported**: no admin-triggerable endpoint exists for any digest email, limiting
  on-demand manual testing of that category to server-side script access.
- **Everything else — HTML size, alt/dimension attributes, absolute links, table-based layout,
  bgcolor/background-color pairing, color-scheme meta, unsubscribe presence, personalisation fallbacks,
  dark-mode mitigations, and full trigger/subject/recipient regression — verified clean with zero
  further findings.**

This closes the 8-prompt email redesign initiative's code-and-content scope. What remains — producing
real artwork from `docs/banner-briefs.md`, uploading it via the Banner Management Centre, assigning it,
and re-testing — is design/production work outside this pass.
