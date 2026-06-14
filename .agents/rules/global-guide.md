---
trigger: manual
---

# Project Constitution – Thabiso Mhlongo Official Site (Antigravity IDE)

## 1. FOLDER & FILE ORGANISATION

- Principles: separation of concerns, modularity, high cohesion/low coupling, scalability, consistency.
- Structure:
  src/features/<name>/ (components, hooks, services, types, utils, index.ts)
  src/components/ui/ (shared UI)
  src/hooks/, src/utils/, src/services/, src/styles/, src/assets/, src/types/, src/config/
- Naming: Components PascalCase, hooks useCamelCase, utils/services camelCase/kebab-case, test files \*.test.ts(x), folders kebab-case or component PascalCase.
- Imports: barrel index.ts, path alias @/ for src/, order: 3rd party → absolute → relative. Domain never imports React/Express.
- Assets: source vs build-processed; user uploads in cloud/public, not src.
- Config: no hard-coding; central src/config/app.config.ts reads env vars, validates, exports typed constants. .env.example provided, no secrets committed.
- **Temporary and test files:** All test-related files (unit, integration, e2e) and any temporary or scratch files must be placed inside the `/TBC` folder at the project root. Do not leave them scattered or co-located with production code.

## 2. CLEAN CODE PRINCIPLES

- Naming: descriptive, no generics; booleans is/has/should. Functions do one thing, <30 lines.
- Comments: why, not what. Code self-documents.
- Prefer pure functions; isolate side effects.
- SOLID: Single Responsibility, Open/Closed, Dependency Inversion (inject services, depend on abstractions).
- Error handling: validate early (Zod/Yup), custom error classes, fail loudly, structured logging (no sensitive data), centralised formatting.
- Hygiene: Boy Scout rule, delete dead code, refactor only under tests.
- Docs: README, ADRs for big decisions, self-documenting code.

## 3. TESTING MANDATE

- No feature without tests; tests describe behaviour, not implementation.
- Co-locate tests inside `/TBC`; mock only at boundaries.
- Must cover: happy path, null/empty, network failures (4xx/5xx), unauthorized, edge boundaries.
- Never .skip/.only or comment out failing tests; run full suite before finalising.

## 4. SECURITY BY DEFAULT

- Validate all input at boundaries (Zod/Yup). Parameterized queries only, no string concatenation.
- No innerHTML, dangerouslySetInnerHTML, eval().
- Secrets via env vars only, never hard-coded or logged. Use .env.example placeholders.
- New deps require approval: check maintenance, CVEs, license. No custom auth/crypto.
- Gates: Semgrep, pre-commit secret scanning, CI linting.

## 5. AI AGENT OPERATING RULES (Antigravity)

- Junior teammate role; human reviews all code; you must explain the “why”.
- Read this document fully before task. Ask for clarification if ambiguous; request reference files.
- Break tasks into narrow steps; mimic existing feature patterns.
- **Downstream Impact Analysis (Mandatory):** Before finalising any code change, you must analyse and explicitly report:
  - What files, components, or modules are directly affected by the change.
  - What other parts of the codebase depend on the changed code (importers, consumers, child components).
  - Whether existing tests might break or need updating.
  - Any potential side effects in shared utilities, hooks, services, or global state.
  - If the impact is unclear or widespread, flag it for human review before proceeding.
- Self-review checklist before submission:
  1. Hard-coding? → config.
  2. Architecture? correct folder/layer.
  3. Tests? cover happy + failure + edge; placed in /TBC.
  4. Security? validation, no risky sinks, no new deps.
  5. Naming? clear, consistent.
  6. Brand? colors, fonts, voice, mobile-first (Sec 7).
  7. Notifications? routed via notificationService.js, user-friendly (Sec 8).
  8. Accessibility? WCAG 2.2 AA compliant (Sec 9).
  9. Downstream impact? analysed, reported, no surprises.
- Automated enforcement: ESLint, Prettier, TypeScript strict. Fix violations, never disable rules.
- Prohibited: new libs without approval, skip/disable tests, hard-code secrets, tutorial-style code (e.g., localhost:3000), console.log/debugger in final output.

## 6. NON-NEGOTIABLES QUICK REFERENCE

| Hard-coding | Config via env vars in src/config/app.config.ts |
| Secrets | Only process.env.NAME, never plain text |
| Architecture | Features in src/features/, shared in src/components/ui/, domain no React |
| Naming | PascalCase components, useCamelCase hooks, is/has/should booleans |
| Testing | Mandatory, happy+error+edge cases; place in /TBC |
| Temporary files | All test/temp files go to /TBC |
| Security | Input validation, parameterized queries, no dangerous sinks |
| Dependencies | Approval + CVE check |
| AI behaviour | Self-check before every task; analyse downstream impact |
| Accessibility | WCAG 2.2 AA standards enforced |

## 7. BRAND & THEME (Editorial-Luxe)

Colors:

- Primary bg: #0a0a0a, sections: #111111, cards: #1a1a1a
- Brand gold: #D4AF37 (primary), hover: #E8C14B
- Text: #ffffff (primary), #b0b0b0 (secondary)
- No other colors allowed.
  Fonts:
- Headings: 'Cormorant Garamond', serif
- Body: 'Outfit', sans-serif
- Mono: 'JetBrains Mono', monospace
  Artist: Thabiso Mhlongo
  Tagline: "Officially funny since 2014"
  Voice: Third-person for bios/accolades (e.g., "South Africa's freshest comedy voice"), first-person for CTAs ("Book Me", "My Story"). Sophisticated, premium, editorial tone. No slang.
  Images: Remove backgrounds, recolor non-theme colors to palette. Banners: high-contrast, gold typography, obsidian backgrounds, ample negative space. Provide design specs when asked (layout, colors, fonts, treatment).
  **Mobile-First Responsive Design:** All UI must be built mobile-first, using responsive breakpoints that adapt progressively to tablet and desktop. Ensure touch-friendly targets, legible font sizes, and fluid layouts. Test across all target device widths.

## 8. NOTIFICATION & EMAIL SYSTEM

- Centralized notificationService.js: all user-facing messages (errors, warnings, info) route through it.
- Captures: browser errors, API HTTP responses (4xx/5xx), network failures, validation errors.
- UI: toast notifications (transient), inline validation near fields, banners (critical issues).
- Messages must be non-technical, actionable, never expose stack traces/internal details.
- Log full technical details for debugging separately.
- Resilience: loading states, retry mechanisms (exponential backoff), fallback UI; no blank screens.
- All notifications follow the brand theme (colors, fonts).
- HTML Emails: crafted with the same Editorial-Luxe style; embedded images (cid), responsive, accessible.
- PDF attachments supported for subscriber emails.
- Copy adheres to brand voice; no hard-coded email content (use config or templates).

## 9. ACCESSIBILITY (WCAG 2.2 AA)

All digital content must meet Web Content Accessibility Guidelines (WCAG) 2.2 Level AA. Key requirements:

- **Perceivable:** Provide text alternatives for non-text content (alt text for images, captions for videos). Ensure sufficient colour contrast (4.5:1 for normal text, 3:1 for large text). Do not convey information with colour alone.
- **Operable:** All functionality must be keyboard accessible (Tab, Enter, Escape). Provide visible focus indicators. Do not create keyboard traps. Allow users to disable or adjust time limits. Avoid content that triggers seizures (no more than three flashes per second).
- **Understandable:** Use clear, consistent navigation and labelling. Input fields must have programmatically associated labels. Errors must be described in text and, when applicable, suggestions for correction provided. Language of the page must be set (e.g., `lang="en"`).
- **Robust:** Use valid, semantic HTML. Ensure ARIA roles, states, and properties are used correctly. Interactive elements must communicate their name, role, and value to assistive technologies.
- **Testing:** Run automated checks (axe-core, Lighthouse) and manual keyboard/screen reader testing. All new UI must pass before merge.
- **Mobile & touch:** Touch targets at least 44x44px, pinch-zoom not disabled, gestures can be cancelled.
