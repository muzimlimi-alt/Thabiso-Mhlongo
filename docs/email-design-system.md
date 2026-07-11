# Email Design System (Prompt 2)

Reusable, email-client-safe components for the Thabiso Mhlongo "Editorial-Luxe / Obsidian & Gold"
brand. Implemented as pure HTML-string functions in **`js/emailComponents.js`** (no DB, no fs, no
dependencies). Preview them with:

```bash
node js/generate-email-previews.js
# → email-previews/components.html, sample-premium.html, sample-system.html  (open in a browser)
```

> **Status:** toolkit only. This does **not** yet touch the live send pipeline — `js/emailService.js`
> still wraps emails with the legacy `js/emailTemplates.js:createEmailWrapper`. Prompts 3–4 migrate the
> individual templates onto these components (see **Integration** below).

## Brand tokens — `TOKENS`

Single source of truth; never hardcode hex/fonts in a template.

| Token | Value | Use |
|---|---|---|
| `obsidian` | `#0A0A0A` | page/body background (never pure `#000`) |
| `sectionBg` | `#111111` | header / footer / banner-fallback surface |
| `card` | `#1A1A1A` | info cards, alert strips |
| `cardBorder` | `#2A2A2A` | card hairline |
| `gold` | `#D4AF37` | brand gold |
| `goldHover` | `#E8C14B` | interactive gold (hover, progressive) |
| `amber` | `#E8A83E` | `alert` severity (never red-on-black) |
| `ink` / `text` / `muted` / `mutedDim` | `#FAFAFA` / `#E6E6E6` / `#B0B0B0` / `#707070` | strong / body / secondary / legal text |
| `serif` / `body` / `mono` | Cormorant→Georgia / Outfit→Arial / JetBrains→Consolas stacks | display / body / metadata |
| `maxWidth` | `600` | container width (px) |

## Components

Each returns an HTML string. `esc()` escapes text values; pass pre-built HTML via `rawValue` /
`bodyHtml` where markup is intended.

| Function | Parameters | Purpose |
|---|---|---|
| `baseLayout({ preheaderText, contentHtml, footerHtml, title })` | — | 600px **table** shell; obsidian body; `color-scheme` + `supported-color-schemes` meta; hidden preheader; `bgcolor` + inline `background-color` redundancy. |
| `header({ bannerSrc, headline, subtitle })` | — | Text wordmark (always renders) + `banner_slot`. |
| `bannerSlot({ bannerSrc, alt, headline, subtitle })` | — | Banner image by `src` **or** graceful Cormorant-stack text-headline block on `#111` when `src` is null/blocked. |
| `ctaButton({ label, url })` | — | **Bulletproof** table + **VML** button (Outlook), gold bg / obsidian text, ≥48px height, hover `goldHover`. |
| `infoCard({ title, rows })` | `rows: [{ label, value, rawValue?, highlight?, mono? }]` | `#1A1A1A` card, `#2A2A2A` border; values in **mono** by default (`mono:false` for prose); `highlight:true` → gold, larger. |
| `divider()` | — | Centered gold hairline. |
| `spacer(px = 24)` | — | Table-safe vertical space. |
| `alertStrip({ severity, text })` | `severity: 'info' \| 'action' \| 'alert'` | Left-border strip on card; muted / gold / amber label. |
| `footer({ unsubscribeUrl, socialLinks })` | `socialLinks: [{ platform_name, platform_url }]` | Contact, tagline, social, website, copyright; **unsubscribe only when `unsubscribeUrl` is passed**. |
| `systemHeader({ category, timestamp, severity })` | — | Compact mono "TM · SYSTEM NOTIFICATION" + category + timestamp; no photographic banner. |

### Composers

- **`renderPremiumEmail({ preheaderText, bannerSrc, headline, greeting, bodyHtml, cards, cta, unsubscribeUrl, socialLinks, title })`**
  → `baseLayout` + `header`(+banner) + greeting + body + `infoCard`s + one `ctaButton` + `footer`.
- **`renderSystemEmail({ preheaderText, category, severity, leadFact, bodyHtml, cards, timestamp, title })`**
  → `baseLayout` + `systemHeader` + `alertStrip`(leadFact) + body + `infoCard`s + minimal footer.

### Usage example

```js
const C = require('./js/emailComponents');

const html = C.renderPremiumEmail({
  preheaderText: 'Your booking #100045 is confirmed.',
  headline: 'Your Booking Is Confirmed',        // banner falls back to this text headline
  greeting: 'Hi Naledi,',
  bodyHtml: 'Thank you for booking Thabiso Mhlongo. Your event is locked in.',
  cards: [{ title: 'Booking Summary', rows: [
    { label: 'Reference', value: '#100045' },
    { label: 'Balance Due', value: 'R 4,500.00', highlight: true }
  ]}],
  cta: { label: 'View Your Booking', url: 'https://thabisomhlongo.com/track?ref=100045' },
  socialLinks
});
```

## HARD-RULE compliance checklist

- [x] Table-based layout + inline CSS; the `<style>` block is hover/responsive **progressive
      enhancement only** (no critical layout depends on it).
- [x] CTAs are bulletproof HTML/VML buttons — never baked into images.
- [x] Personalisation (name, ref, amounts) lives in HTML text — never in banner art.
- [x] Dark-mode safety: `color-scheme` + `supported-color-schemes` meta; `bgcolor` attribute **and**
      inline `background-color` on structural tables; obsidian `#0A0A0A` (no pure `#000`/`#FFF`).
- [x] Fallback font stacks only (Cormorant→Georgia, Outfit→Arial, JetBrains→Consolas).
- [x] Every image has `alt` + explicit `width`/`height`.
- [x] Banner degrades to a styled text headline when the image is missing/blocked.
- [x] Each rendered sample is < 90KB (Gmail clip threshold ~102KB).
- [ ] Plain-text alternative — generated at send time (`htmlToPlainText`), verified in Prompt 8.

## Integration path (Prompts 3–5)

- **P3/P4** rebuild each `send*Email` body to call these components and pass the composed HTML through
  the existing `sendEmail({ htmlContent })` queue. The pipeline switch happens in `sendEmailDirectly`
  (`js/emailService.js:208`): replace the `createEmailWrapper(...)` call with `renderPremiumEmail` /
  `renderSystemEmail` (chosen by the audit's PREMIUM/SYSTEM track), and reconcile the
  `EMAIL_OVERHAUL_ENABLED` flag so branding is actually on.
- **P5** replaces `bannerSlot`'s `bannerSrc` argument with a lookup by `banner_id` from the new banner
  registry; the graceful text-headline fallback already covers null/archived/missing banners.
- `js/emailTemplates.js` (`createEmailWrapper`, `createQuoteTable`) stays until every template is
  migrated, then is retired.
