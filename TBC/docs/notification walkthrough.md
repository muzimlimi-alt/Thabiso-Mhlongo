# Notification System Migration Walkthrough — v2.0

All user-facing messaging has been refactored into a centralised, browser-independent notification system. Native browser dialogs (`alert`, `confirm`, `prompt`) are fully eliminated from active code.

---

## Architecture

| File | Role |
|------|------|
| `js/notificationService.js` | Singleton service — toasts, modals, HTTP error overlays, API fetch helper |
| `css/notifications.css` | All visual styles — Editorial-Luxe theme, animations, responsive, reduced-motion |

### `window.notificationService` API

| Method | Output | Use case |
|--------|--------|----------|
| `showSuccess(msg, opts?)` | ✅ Toast | CRUD success, form submission |
| `showError(msg, opts?)` | ❌ Toast | API failures, validation errors |
| `showWarning(msg, opts?)` | ⚠️ Toast | Non-blocking cautions |
| `showInfo(msg, opts?)` | ℹ️ Toast | Neutral updates |
| `showConfirm(opts)` → `Promise<bool>` | Modal | Destructive confirmation dialogs |
| `showPrompt(opts)` → `Promise<string>` | Modal | User text input |
| `showAlert(opts)` → `Promise` | Modal | Replaces native `alert()` |
| `showHttpError(code, opts?)` | Full-screen overlay | HTTP 400/401/403/404/500 |
| `apiFetch(url, opts?)` | — | Fetch wrapper with auto error display |

Both `showError(message)` and `showError(title, message)` calling conventions are supported.

---

## What Was Refactored

### `js/myscript.js`
- Contact form validation → `showError(msg)`
- Contact form success → `showSuccess(msg)`
- Newsletter subscription success/already-subscribed/error → respective toast methods
- Booking form submission error → `showError(msg)`
- Removed stale `$('#formAlert').fadeOut()` reference

### `admin.html`
- All delete/CRUD confirmations → `showConfirm({ isDestructive: true, ... })` with `await`
- Inquiry reply success/error → `showSuccess` / `showError`
- Compose outbound email success/error → `showSuccess` / `showError`
- Booking respond email success/error → `showSuccess` / `showError`
- Newsletter dispatch success/error → `showSuccess` / `showError`
- Record payment success/validation/error → `showSuccess` / `showError`
- GDPR/POPIA data erasure result → `showSuccess` / `showError`
- Policies saved → `showSuccess`
- System settings saved → `showSuccess`
- All orphaned Bootstrap alert HTML elements (`#inqReplyAlertNew`, `#inqComposeAlert`, `#respondAlert`, `#policySaveMsg`, `#settingsSaveMsg`, `#newsletterStatus`, `#gdprDeleteResult`, `#rpMsg`) removed from the DOM

### `booking.html`
- Payment processing failure / gateway error → `showError`
- Session expired → `showWarning`
- Quote acceptance success → `showSuccess`
- Quote acceptance failure / network error → `showError`

### `index.html` (tracking portal inline script)
- Payment failure / gateway error → `showError`
- Session expired → `showWarning`
- Quote acceptance success → `showSuccess`
- Quote acceptance failure / network error → `showError`

### `error.html`
- Rewritten to accept `?code=` URL parameter
- Renders branded, accessible error pages for 400, 401, 403, 404, 500
- Falls back gracefully to a generic error if no code provided
- Navigation: Go Back, Return Home, and context-specific actions (e.g. Sign In for 401)

---

## Key Implementation Details

### WCAG / Accessibility
- Toast container uses `role="status"` (polite) and `role="alert"` (assertive for errors)
- Screen-reader live region (`#tm-live-region`) announces all toast titles+messages
- Modal uses `role="dialog" aria-modal="true"` with `aria-labelledby` / `aria-describedby`
- Full keyboard focus trap inside modals (Tab / Shift+Tab cycles within dialog)
- Focus returns to the triggering element when modal closes
- All interactive elements have `:focus-visible` outlines (gold ring, 2px offset)
- `aria-hidden="true"` on all decorative icons

### Toast Behaviour
- Max 5 simultaneous toasts — extras queue and appear as existing ones dismiss
- Auto-dismiss progress bar (shrinks over the configured duration)
- Progress bar pauses on hover
- Each toast dismissible by close button, Escape key, or Delete key
- Mobile: stacks bottom-center; Desktop: bottom-right corner

### Modal Behaviour
- Backdrop click closes non-destructive modals
- Escape key closes non-destructive modals
- Enter key confirms (except in prompt modals)
- `isDestructive: true` disables backdrop and Escape dismissal
- `window.alert()` is overridden to call `showAlert()` as a safety net

### HTTP Error Overlay
- Full-screen overlay via `showHttpError(code)` for in-app errors
- Standalone `error.html` page for server-side redirects (reads `?code=` param)
- Both provide Go Back + Return Home navigation

### `prefers-reduced-motion`
- All animations disabled; opacity transitions shortened to 0.15s

---

## Verification

A project-wide search for `alert(`, `confirm(`, and `prompt(` across all HTML and JS files (excluding node_modules, TBD/ backups, and library files) confirms **zero residual native dialog tokens** in active application code.

The only occurrences of these strings are inside **comments** within `notificationService.js` itself, describing what they override.
