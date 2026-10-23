# Google Calendar connection (admin-managed)

Written 2026-10-20. Covers **how the website is connected to a Google account from the admin**, not the sync itself (that is `lib/calendar-sync.js`,
unchanged). For the Microsoft 365 calendar see `docs-internal/calendar-m365.md`; the two are independent.

## 1. What was missing

The website has always kept a Google Calendar in step with bookings and public events (booking -> event, event -> event, and the account's other
appointments pulled in as date holds that block the booking form). But the only way to give it a Google account was to edit `.env` on the server
(`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN`) and run `scripts/get-google-refresh-token.js` by hand. Microsoft 365 had a card
in **System -> Email Setup**; Google had nothing, so an expired sign-in (`invalid_grant` in the log) could only be fixed by a developer.

## 2. What an administrator sees

* **Admin -> System -> Integrations -> Google Calendar** (administrators only): OAuth client ID, client secret, the exact **redirect address** to register at
  Google (with Copy), and the buttons **Save & connect Google** (becomes *Connect Google* / *Reconnect Google*), **Test connection**, **Disconnect**.
* **Admin -> Calendar**: a strip under the Microsoft one says whether Google is connected and to which account; administrators get a button that jumps to
  the card. Other roles see the status only.
* After Google's consent screen the browser lands back on the card (`/admin.html?google=<outcome>`), with a plain-language result.

## 3. Files

| File | Role |
|---|---|
| `lib/google-config.js` | Settings-backed configuration, validation, the connect round trip (`beginAuthorization` / `completeAuthorization`), `diagnose`, `disconnect`, error wording (`classify`) |
| `lib/google-calendar.js` | The ONE Google client (`oauth2Client`, `calendar`, `CALENDAR_ID`) - same exports as before, now re-pointed **in place** by `applyConfig` / `reloadFromSettings`; env seams for tests |
| `routes/admin/google-calendar.js` | `/api/admin/google-calendar` (status), `/credentials` (PUT), `/connect` (POST), `/callback` (GET, no session), `/test` (POST), DELETE; mounted from `routes/admin/calendar.js` |
| `js/admin/google-calendar.js` | The card and the strip |
| `admin.html`, `css/admin/calendar.css`, `js/admin/system-settings.js` | Markup (card, strip, About text); one-line hook that loads the card |
| `app.js`, `routes/admin/settings.js` | `google_cal_*` is skipped when copying settings into `process.env`, hidden from `GET /api/admin/settings`, refused by `PUT /api/admin/settings` |
| `test/fake-google.js`, `test/google-calendar.child.js`, `test/google-calendar.test.js`, `test/browser/google-calendar.js` | Tests (section 8) |

## 4. Where the values live

`settings` table, keys `google_cal_*`:

* `client_id` (plain), `client_secret` and `refresh_token` (**AES-256-GCM**, the same scheme and key as the SMTP password - `SETTINGS_ENCRYPTION_KEY`, falling
  back to `SESSION_SECRET`), `token_client` (the client ID the token was issued to), `account`, `connected_at`, `pending` (a connection in progress).
* None of them is returned by any API, logged, put in the audit trail or copied into `process.env`.

**Precedence.** The client ID and secret are a *pair*: saved ones win over `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`. The refresh token is used only with the
client that issued it: the saved token first, then `GOOGLE_REFRESH_TOKEN` - and the environment token only when the environment client is the same one. So
credentials of one Google client are never sent to another. The three `.env` values keep working exactly as before; with only an environment client, **Connect
Google** works without retyping it (the sign-in is saved and tied to that client).

* Changing the client ID clears the saved sign-in (it belongs to the old client) and needs the new client's secret. Changing only the secret keeps it.
* A saved value that cannot be decrypted (server key changed) is **reported and never used**: the card says to enter it / connect again.

## 5. The connect round trip

1. *Save & connect Google* -> `PUT /credentials` (if anything was typed) -> `POST /connect`. The server stores a **hash** of a one-time `state` (+ expiry 10 min,
   who started it, the redirect address) and returns Google's consent URL (`access_type=offline`, `prompt=consent`, scope `https://www.googleapis.com/auth/calendar`).
2. Google redirects the browser to `/api/admin/google-calendar/callback?code=..&state=..`.
3. **The callback needs no session, by design.** In production the session cookie is `SameSite=Strict`, which the browser does not send on a navigation that
   came from another site, so the callback arrives without it. The one-time `state` - issued only to a signed-in administrator - is what authorises it:
   constant-time compare, single use (spent on first match), ten minutes. A request with a wrong state changes nothing (so a stranger cannot cancel an
   administrator's connection in progress). The callback answers with a small page that moves on by itself instead of a redirect (a navigation started by our
   own page carries the cookie again; a redirect would still count as coming from Google). It repeats nothing Google sent: the outcome is one word from a fixed list.
   The request logger in `app.js` prints `req.url`, so the route strips the query after reading it (Google's code and the state never reach the log).
4. **Verify before save**: the code is exchanged, a refresh token must come back, and `calendarList.get('primary')` must succeed with role `owner` / `writer`.
   Otherwise nothing is stored and the outcome (`denied`, `no_refresh_token`, `permission`, `api`, `redirect`, `client`, ...) says why.
5. The token is stored encrypted and the shared Google client is re-pointed - **no restart**.

**Redirect address.** `BASE_URL + /api/admin/google-calendar/callback` on the live site (or the address in the browser's bar when none / on localhost). It must be
listed under *Authorized redirect URIs* on the OAuth client. The card shows it; Google's `redirect_uri_mismatch` is reported as such.

## 6. One-time Google Cloud setup (what the About tab tells the owner)

1. Project -> APIs & Services -> Library -> **Google Calendar API -> Enable**.
2. OAuth consent screen / Google Auth platform: External; add the calendar's account as a *Test user* while testing; then **publish the app ("In production")**.
   **While it says "Testing" Google cancels the sign-in every 7 days** - this is the usual cause of `invalid_grant` and of a silently stopped sync.
3. Credentials -> OAuth client ID -> Web application -> add the redirect address -> copy client ID + secret into the card.
4. *Save & connect Google*. Google shows "Google hasn't verified this app" (sensitive scope, own app): Advanced -> Go to (app) -> allow.
5. *Test connection*: three ticks (credentials / sign in / read and change the calendar).

The Google Cloud project that already holds the website's OAuth client is the one named in the Places-key notes (project `744286700946`); the Calendar API and the
consent screen's publishing status live there.

## 7. Troubleshooting

| Symptom | Meaning / fix |
|---|---|
| Test: *Google no longer accepts the saved sign-in* | Revoked, or expired by the 7-day "Testing" rule. **Reconnect Google**, then publish the consent screen. |
| *rejected the client ID or client secret* | Copy both again from Google Cloud (the secret is on the OAuth client's page); re-enter the secret. |
| *redirect address* / `redirect_uri_mismatch` | The address shown in the card is not listed on the OAuth client (exact match: scheme, host, port, path). Add it, wait a minute. |
| *Calendar API is switched off* | Enable it in Google Cloud (can take minutes). |
| *can only read its primary calendar* | Sign in with the account that owns the calendar. |
| `no_refresh_token` | Google thought the app was already authorised: remove it at myaccount.google.com/permissions and connect again. |
| *cannot be decrypted* | `SETTINGS_ENCRYPTION_KEY` / `SESSION_SECRET` changed: enter the secret again and reconnect. |
| Card says connected but nothing reaches Google | Run **Test connection** - it signs in afresh (a cached access token cannot hide a dead refresh token). |
| Disconnect, yet still connected | The server environment still has a sign-in for that client (`GOOGLE_REFRESH_TOKEN`); remove it from the host's environment. |

## 8. Tests

* `test/google-calendar.test.js` (in `npm test`): **A** - `test/google-calendar.child.js` runs the real libraries and routes against `test/fake-google.js`
  (token, revoke and Calendar endpoints, switchable failures) on a throwaway DB: 80 checks - saving, encryption at rest, the whole connect round trip and
  every refusal, in-place re-pointing of the shared client (a real `calendar.events.insert` goes out with the new token), Test connection, disconnect,
  precedence, a changed encryption key, and "no secret anywhere" (responses, audit trail, printed output, settings rows). **B** - the same routes on the
  running server: authentication and roles, what the generic settings API will not show or accept, the callback with no session, the request log.
* `test/browser/google-calendar.js` (in `npm run test:browser`): the real `admin.html`, each state simulated: wording, buttons, validation, a failed save
  keeping what was typed, Save & connect order, Test connection, Disconnect (+ confirmation), returning from Google, other roles, untrusted text staying text, phone layout.
* Mutation-checked: nine deliberate bugs (query left in the log, state not single-use, borrowed environment token, plaintext secret, read-only accounts
  accepted, open roles, a stranger cancelling a connection, stale sign-in kept after a client change, secret in the public view) each turn a check red.
* `test/support.js` removes `google_cal_*` from the throwaway DB copy (a source DB with the real calendar connected would otherwise let test bookings write
  real events onto the owner's real Google Calendar). Nothing in the tests reaches Google; a test server that is *not* given the fake still talks to real
  Google with the bogus `GOOGLE_REFRESH_TOKEN` the support module sets (pre-existing behaviour, always `invalid_grant`).

## 9. Privacy policy and terms links (Google Cloud Branding page)

Google's consent-screen Branding page (and app stores, payment providers) ask for a privacy-policy and a terms link. These are optional for an own-use app that is not submitted for
verification. If entered, use the standalone pages added 2026-10-23: **https://www.thabisomhlongo.com/privacy** and **https://www.thabisomhlongo.com/terms**
(`lib/legal-pages.js`, `routes/public/legal-pages.js`, tests in `test/legal-pages.test.js`). Their text is read from the homepage pop-ups in `index.html`, so editing the pop-up
changes both. Aliases (`/privacy-policy`, `/terms-of-use`, ...) redirect. The policy text does not mention Google Calendar / Microsoft 365 - wording the owner must approve.

## 10. Hazards

* A developer's `database.sqlite` that has the owner's Google connection saved will make a **local** `npm start` act on the owner's real calendar (same hazard
  as live PayFast settings in the dev DB). Disconnect locally, or use a DB without `google_cal_*`.
* Never `require()` a lib file just to inspect it - it opens the real DB. `node --check` instead.
* Test runs from several sessions collide on the default test port (3199): set `TEST_PORT` for a private one.
