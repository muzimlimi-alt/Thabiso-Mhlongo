# Banner Artwork Briefs (Prompt 7)

> No images were generated for this task. These are 11 production-ready creative briefs — one per
> Master Banner System category — to hand to a designer or an image-generation tool. Once art exists,
> upload it via **Branding → Banners → New Banner** and assign it to templates from the **Assign**
> drawer (or the checklist there); nothing here is wired to code.

## Shared technical spec (every brief)

- **Export size:** 1300 × 380px (≈3.42:1 aspect ratio). Displays in the email at a fixed 600px width
  with `height:auto`, so the rendered height follows whatever aspect ratio the file actually is —
  **the server only validates width** (1200–1400px hard range, ≤100KB), it does not check height or
  aspect ratio. Producing art at a very different ratio will still upload successfully but will look
  stretched or cropped oddly at the fixed 600px display width, so treat 1300×380 as a hard target even
  though it isn't machine-enforced.
- **Format:** JPG, quality ~80. Target ≤80KB; hard ceiling 100KB (PNG is also accepted by the upload
  validator, but JPG compresses photography far better under that ceiling).
- **Base / accent:** obsidian `#0A0A0A` base, Brand Gold `#D4AF37` accents only — no other accent
  colours, no pure `#FFFFFF` (use `#FAFAFA` if a near-white is needed for contrast, per the project's
  dark-mode HARD RULES).
- **Composition:** logo/wordmark corner reserved top-left (matches the shell's own "Thabiso Mhlongo"
  text wordmark directly above the banner — don't duplicate it in the art); ~40% left-aligned text-safe
  zone for the headline/subtitle, ~60% imagery on the right. Keep the left 40% low-detail/low-contrast
  so white/gold headline text stays readable if it's ever re-rendered as a text overlay.
- **Headline text:** if rasterised into the image, 5–8 words, Cormorant Garamond, white or gold, never
  personalised (no names, booking refs, or amounts — those stay in the email's HTML text, per the
  banner registry's own `headline`/`subtitle` fields, which are a *separate*, code-rendered fallback
  used only when no image is assigned).
- **Hard rules for every brief below:** no buttons, no CTAs, and no personalisation tokens anywhere in
  the artwork. Buttons are always real HTML below the banner; the banner is purely atmospheric.

---

## 1. Booking Requests

**Serves:** `booking_received_client`, `booking_under_review`, `pending_expired`

- **Headline:** "Your Request Is With Us"
- **Subtitle (optional, Outfit, `#B0B0B0`):** "We'll be in touch shortly"
- **Imagery direction:** Anticipatory, not yet celebratory — an empty stage or greenroom moments before
  a show, warm practical lighting (not full spotlight), a single mic stand silhouette. Mood: quiet
  confidence, "something is about to happen."
- **Alt text:** "Dimly lit stage with a single microphone stand, warm amber practical lighting."

## 2. Quotes & Proposals

**Serves:** `quote`, `quote_accepted`, `quote_expired`, `quote_expiry_warning`, `quote_still_open`,
`custom_response`

- **Headline:** "A Tailored Proposal, Just for You"
- **Subtitle:** "Every detail, considered"
- **Imagery direction:** Close, intimate detail shot — a spotlight beam cutting through haze onto an
  empty stage floor, or a close crop of stage rigging/lighting gear. Mood: precision and craft, not
  performance itself (the quote precedes the show).
- **Alt text:** "A single spotlight beam cutting through stage haze onto an empty floor."

## 3. Contracts & Signatures

**Serves:** `contract_sent`, `contract_sign_reminder`

- **Headline:** "Let's Make It Official"
- **Subtitle:** "Review, sign, and lock in your date"
- **Imagery direction:** Calm, low-key, single spotlight — deliberately the most restrained/formal
  image in the set (this is a paperwork moment, not a performance moment). A single warm spotlight on
  an empty podium or lectern silhouette against obsidian. Mood: trust, formality, calm.
- **Alt text:** "A single warm spotlight illuminating an empty podium against a dark background."

## 4. Payments & Invoices

**Serves:** `invoice`, `invoice_pre_due`, `invoice_overdue`, `payment_received`, `deposit_balance_due`,
`payment_failed`, `refund_processed`, `schedule_payment_reminder`, `balance_payment_reminder`

- **Headline:** "Keeping Your Booking on Track"
- **Subtitle:** "Secure, straightforward payments"
- **Imagery direction:** Clean, orderly, minimal — geometric gold line-work (ticket-stub or
  boarding-pass-style perforated edge motif) on obsidian, no photography. Deliberately the most
  neutral/utilitarian image in the set since this single category spans good news (payment received)
  and less-good news (overdue, failed) — the art must read fine in either context.
- **Alt text:** "Thin gold geometric line pattern resembling a ticket stub, on a dark background."

## 5. Booking Confirmations

**Serves:** `booking_confirmed`, `booking_cancelled`, `booking_date_changed`

- **Headline:** "Your Booking Is Locked In"
- **Subtitle:** "We can't wait to perform for you"
- **Imagery direction:** Celebratory, warm gold wash — a full stage bathed in gold light, confetti-like
  bokeh, an engaged (silhouetted, non-identifiable) crowd. The most visually "peak" image in the set.
  Note: this same banner also serves cancellation and date-change notices, where the copy itself carries
  the tonal shift — keep the art warm/neutral rather than exuberant so it doesn't clash on those sends.
- **Alt text:** "A gold-lit stage with warm bokeh lights and a silhouetted audience."

## 6. Event Reminders

**Serves:** *(no live template uses this category yet — reserved for a future pre-event reminder; see
`docs/banner-migration-notes.md`)*

- **Headline:** "Your Event Is Almost Here"
- **Subtitle:** "Final details, one last check"
- **Imagery direction:** Anticipatory and time-pressured without being urgent — a stage clock/countdown
  motif rendered in thin gold line-work, or a stage being set/lit moments before doors open. Mood:
  final preparations underway.
- **Alt text:** "Thin gold clock-face line art overlaid on a dimly lit stage being prepared."

## 7. Thank You & Reviews

**Serves:** `booking_completed`, `review_request`

- **Headline:** "Thank You for Having Us"
- **Subtitle:** "We'd love to hear how it went"
- **Imagery direction:** Warm, reflective, wind-down mood — a stage after the show, house lights coming
  up, gold light fading to a softer warmth. Mood: gratitude, a good night wrapping up.
- **Alt text:** "House lights coming up on an empty stage, warm fading gold tones."

## 8. Booking Recovery

**Serves:** `abandoned_booking_recovery`

- **Headline:** "Pick Up Right Where You Left Off"
- **Subtitle:** "Your details are saved"
- **Imagery direction:** Inviting, low-pressure, open — an open stage door or curtain slightly parted
  with warm light spilling through. Mood: an open, welcoming invitation back in, not a nag.
- **Alt text:** "A stage curtain slightly parted, warm gold light spilling through the gap."

## 9. Contact & Support

**Serves:** `contact_auto_reply`, `inquiry_reply`, `direct_compose`, `booking_management_response`

- **Headline:** "We've Got Your Message"
- **Subtitle:** "Our team will be in touch"
- **Imagery direction:** Approachable and human-scale — a single warm desk-lamp-style light source in
  an otherwise dark backstage/office setting. Mood: someone is genuinely reading this, not an
  automated system. Deliberately the least "stage" image in the set, since this category covers
  correspondence, not the performance itself.
- **Alt text:** "A single warm desk lamp glowing in an otherwise dark room."

## 10. Newsletters & Marketing

**Serves:** `newsletter_welcome`, `newsletter_campaign`

- **Headline:** "Officially Funny Since 2014"
- **Subtitle:** "Tour dates, videos, and more"
- **Imagery direction:** The most "brand personality" image allowed — energetic, a wide shot of a full
  house mid-laugh (silhouetted/non-identifiable crowd), gold rim-lighting on the crowd's silhouette.
  This is the one banner that can lean playful/branded rather than purely atmospheric, since it's the
  only category that isn't tied to a specific booking's status.
- **Alt text:** "A silhouetted audience mid-laugh, gold rim lighting, wide stage-front view."

## 11. User Accounts & Security

**Serves:** *(no PREMIUM template — `dashboard_invite` and `password_reset` exist as rows for
completeness in the registry, but both are SYSTEM-track emails, which use a compact text-only header
and have no banner slot at all; a banner assigned to this category is never actually rendered by any
live email today.)*

- **Headline:** *(not applicable — no live template renders this category's art)*
- **Subtitle:** *(not applicable)*
- **Imagery direction:** Per the pack's own guidance for this category: **no photography** — a clean,
  minimal gold geometric motif on obsidian (a single thin gold line or lock-adjacent abstract shape),
  restrained and technical in feel, consistent with security/account-management contexts if this
  category is ever wired to a PREMIUM template in the future.
- **Alt text:** "A minimal gold geometric line motif on a dark background."

---

## Coverage matrix

Every PREMIUM-track `template_key` from `docs/banner-migration-notes.md` (32 total; `contract_sign_reminder`
and `newsletter_campaign` each cover 2 call sites sharing one template), mapped to its category. Nothing
is unassigned — every row below has a brief above.

| Category | template_key(s) |
|---|---|
| Booking Requests | `booking_received_client`, `booking_under_review`, `pending_expired` |
| Quotes & Proposals | `quote`, `quote_accepted`, `quote_expired`, `quote_expiry_warning`, `quote_still_open`, `custom_response` |
| Contracts & Signatures | `contract_sent`, `contract_sign_reminder` |
| Payments & Invoices | `invoice`, `invoice_pre_due`, `invoice_overdue`, `payment_received`, `deposit_balance_due`, `payment_failed`, `refund_processed`, `schedule_payment_reminder`, `balance_payment_reminder` |
| Booking Confirmations | `booking_confirmed`, `booking_cancelled`, `booking_date_changed` |
| Event Reminders | *(none live — reserved)* |
| Thank You & Reviews | `booking_completed`, `review_request` |
| Booking Recovery | `abandoned_booking_recovery` |
| Contact & Support | `contact_auto_reply`, `inquiry_reply`, `direct_compose`, `booking_management_response` |
| Newsletters & Marketing | `newsletter_welcome`, `newsletter_campaign` |
| User Accounts & Security | *(SYSTEM-track only — `dashboard_invite`, `password_reset` — never renders a banner)* |

**32 template_keys, all 11 categories accounted for.** Two categories (Event Reminders, User Accounts &
Security) currently have no *live* PREMIUM template but keep a brief for completeness and future use,
matching how they're already kept selectable in the category dropdown throughout the Banner Management
Centre.
