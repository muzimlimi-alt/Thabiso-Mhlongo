# Event ticketing

Selling tickets for Thabiso's own shows, as an **extension of the existing Events module**: tiers hang off `events`, buyers pay through the
**existing PayFast integration**, tickets go out through the **existing mail queue and PDF service**, and the door runs on a phone page
behind the **existing admin login**. Branch `feature/event-ticketing` (built 2026-10-30).

Owner decisions this design follows: extend Events (no second event system); reuse existing code (no standalone or duplicate systems);
explicit table relationships; additive migration only; no paid infrastructure; ticket revenue reported separately (Finance / P&L
untouched); admin inside Events (no new sidebar item); the PayFast safety net covers ticket orders; the door scanner uses the camera
with the browser's own QR reader plus the free jsQR library; the public drawer is two short steps, with optional per-ticket names, and
shows the tickets after payment.

---

## 1. How it works, end to end

1. **Admin** opens an event (Events → Upcoming → Edit) → **Tickets** tab → adds ticket types (name, price, places, max per order,
   optional sales window) → **Open sales**. Only *standalone* events (not a client booking's event) can sell tickets.
2. **Public site**: the event's card shows **Get Tickets · from R…** (or Sold Out / Sales Closed / On sale <date>). An event with no
   ticket types keeps its old external `ticket_sales_link` exactly as before.
3. **Drawer step 1**: choose quantities → **Continue** reserves them for **10 minutes** (`POST /api/public/ticket-orders`).
4. **Drawer step 2**: name, e-mail, phone, optional names per ticket, POPIA consent, countdown → **Pay** → the server builds and signs
   the PayFast form (`POST …/checkout`) → the browser posts it to PayFast (`window.tmPostToPayfast`, shared with the booking tracker).
5. **PayFast** posts its notification (ITN) to the **same** `/api/payment/webhook/payfast` the bookings use. `m_payment_id` `TKT_<id>`
   is handed to `lib/ticketing-payments.js`; everything else is the untouched booking path.
6. The verified notification marks the order **paid**, moves the held places to sold, creates one **ticket** per admission (random
   144-bit token each) and queues **one e-mail** with every QR code inline and a PDF of the tickets attached.
7. The buyer's browser returns to `/?tickets=<reference>&payment=success`: the drawer re-opens and **asks the server** (polling, plus
   the safety net at 0 / 35 / 90 s) until it says paid, then shows the tickets with QR codes and a PDF download. The return itself
   proves nothing.
8. **Door**: staff open `/checkin` on a phone (signed in to the admin portal), pick the show, scan. Each QR encodes
   `https://<site>/t/<token>`. **Check In** is a POST that runs one atomic update — green **Admitted**, red **Already scanned at 19:42**,
   **Wrong show**, or **Invalid / no longer valid**.
9. **Office**: Events → **Ticket Sales**: revenue, sold, checked in, per-tier table, orders (search / filter), order drawer with
   **Resend tickets** and **Mark as refunded**, **Attendees CSV**.

## 2. Files

New (ticketing's own code, in the repo's existing lib / routes / js/admin layout):

| File | What |
|---|---|
| `lib/ticketing-schema.js` | migration 112: tables, indexes, constraints, email-banner slot |
| `lib/ticketing-core.js` | pure rules, no DB: cents, tokens, validation, sale windows (SAST), CSV cell guard, log masking |
| `lib/ticketing.js` | DB: tiers, reserve, holds/expiry, checkout, refunds, check-in, figures, order lists |
| `lib/ticketing-payments.js` | PayFast checkout, the ITN branch, `confirmTicketPayment()` (shared with the safety net) |
| `lib/ticketing-delivery.js` | QR codes, ticket PDF, the e-mails, admin alerts |
| `lib/payfast-itn-checks.js` | the timestamp / source-IP / validate-POST steps, moved verbatim out of the booking ITN handler |
| `routes/public/ticketing.js` | public API, `/t/<token>`, `/checkin` |
| `lib/ticketing-issue.js` | migration 116: complimentary tickets (guest list) and void-and-reissue of one ticket |
| `lib/ticketing-door.js`, `routes/public/ticketing-door.js` | door links (migration 115): per-show volunteer links, and the door API they use |
| `routes/admin/ticketing.js` | admin API (tiers, sales switch, orders, refunds, CSV, figures, door) |
| `js/tickets-drawer.js`, `css/public/tickets.css` | the Get Tickets drawer + card buttons |
| `js/admin/ticketing.js`, `css/admin/ticketing.css` | event drawer Tickets tab + Ticket Sales tab + order drawer |
| `checkin.html`, `js/checkin.js`, `css/public/checkin.css` | door scanner + the staff view on `/t/<token>` |
| `js/event-share.js` | Share a show: Share buttons (card poster, details pop-up, drawer), system share sheet or WhatsApp / Facebook / X / Copy link menu; opens `/?event=<id>` from a shared link |
| `js/vendor/jsQR-1.4.0.js` (+ LICENSE) | QR decoder for phones without a built-in one (Apache-2.0, served from the site) |

Integration points in existing code (small, each commented in place): `database.js` (one call), `app.js` (two router mounts, the hold
sweep, request-log masking), `routes/public/payment.js` (one dispatch line + the shared checks), `routes/public/bookings.js` (uses the
shared `buildPayfastCheckout`), `lib/payfast-signature.js` (`buildPayfastCheckout`, `payfastItemName`), `lib/payfast-reconcile.js`
(ticket orders in the same pass), `routes/admin/payfast-reconcile.js` (`ticket_order_id`), `js/admin/payfast-reconcile.js` (label),
`routes/admin/events.js` (delete guard, cancel/postpone closes sales), `routes/public/site-content.js` (`ticketing` summary on
`/api/public/events`), `middleware/rate-limiters.js` (two limiters), `js/pdfService.js` (`generateTicketsPdf`), `js/myscript.js`
(card / pop-up buttons, JSON-LD), `index.html` (drawer markup, includes, `tmPostToPayfast`), `css/public/drawer.css`
(`.atl-drawer--sheet`), `admin.html` (tabs, drawer, includes), `js/admin/events.js` (two hooks), `scripts/cleanup-test-data.js`
(ticketed events are never deleted). New dependency: `qrcode` 1.5.4 (MIT).

## 3. Data model (migration 112)

```
events(event_id) ─1:N─ ticket_types ─1:N─ ticket_order_items ─N:1─ ticket_orders ─N:1─ events
                        ticket_types ─1:N─ tickets ─N:1─ ticket_orders
admins(id) ─ ticket_types.created_by / tickets.checked_in_by / ticket_orders.refunded_by   (ON DELETE SET NULL)
ticket_orders ─1:N─ ticket_webhook_events (order_id ON DELETE SET NULL)
payfast_reconcile_findings.ticket_order_id → ticket_orders (new nullable column, SET NULL)
```

* **Money records never cascade.** `ticket_types.event_id`, `ticket_orders.event_id`, `tickets.*`, `ticket_order_items.ticket_type_id`
  are `RESTRICT`: an event / tier / order with history cannot be deleted (cancel or close it). Only an order's own line items follow it.
* **The database refuses to oversell**: `CHECK (sold + reserved <= capacity)` on `ticket_types`, on top of the conditional UPDATE.
* **Prices**: integer cents, `CHECK (price_cents >= 500)` (PayFast's R5 minimum); each order line keeps the price it was sold at.
* **Uniques**: `ticket_types(event_id, name)`, `ticket_orders.public_reference`, `ticket_orders.m_payment_id`,
  `ticket_orders.gateway_payment_id`, `tickets.token`, and a partial unique `ticket_webhook_events(gateway_payment_id, payment_status)
  WHERE verified = 1` — a forged/unverified post is logged but can never take the genuine notification's slot.
* **Order status**: `pending | paid | failed | expired | refunded`, plus `refund_required` (paid after the tickets sold out).
* **Why not the PayFast ledger tables?** `transactions`, `payfast_payment_intents` and `payment_logs` all require a booking
  (`booking_id NOT NULL` FK). Rebuilding them would touch live booking money; ticket orders carry their own payment facts instead,
  and ticket revenue is reported in Events → Ticket Sales (owner's choice), not in Finance.
* Timestamps are ISO-8601 UTC text written by the app; events keep their existing SAST wall-time format.
* Ticketing text (tier names, buyer details) is stored as validated **plain** text (like EFT banking details); event text stays
  entity-encoded as before and is decoded for PDF / e-mail / CSV / JSON.

## 4. Safeguards (and the test that proves each)

| Rule | How | Test |
|---|---|---|
| Never oversell | `withDbTransaction` + `BEGIN IMMEDIATE`, conditional `UPDATE … WHERE sold + reserved + q <= capacity`, DB CHECK | 20-way race (lib) + 10-way race (HTTP): exactly 1 wins |
| Prices only from the DB | reservation reads tier rows; checkout recomputes from order lines | client-sent `unit_price_cents` ignored |
| Paid only by PayFast | ITN (signature in **every** mode, IP + timestamp + validate POST in production, merchant id, payment id) or the safety net (PayFast's own history) | forged ITN refused; return URL never pays |
| Exact amount | `amount_gross` in cents must equal `total_cents` | wrong-amount ITN refused + admin alert |
| Processed once | verified-row partial UNIQUE + UNIQUE gateway id + status guard; rollback (throw) after stock moves | ITN replay, late ITN after safety-net recovery |
| Holds end | lazy release on every read + 60 s sweep (`registerTicketHoldExpiryJob`) | expired reservation, lazy + sweep |
| Late payment | re-reserve all-or-nothing (SAVEPOINT) else `paid + refund_required`, no tickets, buyer + admin told | both cases, never oversold |
| Door | `UPDATE tickets SET checked_in_at … WHERE token = ? AND checked_in_at IS NULL AND voided_at IS NULL AND order paid`; POST only | double scan, two phones at once, GET never checks in |
| Refund | order refunded, tickets voided, places back on sale (one transaction) | refunded ticket fails at the door |
| Tokens | `crypto.randomBytes(18)` base64url (144 bits), never derived from ids | 2000 unique, shape |
| Rate limits | reserve/checkout 40 per 10 min (raised from 10 on 2026-11-01: one purchase uses 2, and buyers share addresses on mobile networks / Wi-Fi); lookups 120 per 10 min (per address) | production child test |
| Secrets out of logs | request logger masks `/t/<token>`, order references, `?tickets=`, `?pass=`, ticketing admin `?q=` | log scanned after the flow / door-link tests |
| Door links | only a SHA-256 hash of the 144-bit secret is stored; scoped to ONE show (another show's ticket = "wrong show", nothing else); no buyer e-mail / phone / money; search by name / order / code only; expires 12 h after the show starts; switch-off works at once; each check-in records the link's name (`tickets.checked_in_via`) | `ticketing-door` (26) + browser |
| POPIA | only name / e-mail / phone (+ optional names); consent time + policy version stored; full PayFast payload ONLY in `ticket_webhook_events`; `/t/<token>` shows strangers nothing personal | flow + browser tests |
| Shared-connection writes | every ticketing write goes through the transaction queue (a bare write can be swept into another request's transaction and rolled back with it) | — (design rule, see `lib/ticketing.js` header) |
| Roles | tiers / sales / orders / refunds / CSV: administrator + manager; check-in + door counts: every role; revenue hidden from assistants | RBAC checks |

## 5. Running the door (show night)

* Each phone at the door: open the admin portal and **sign in** (any role — assistants can check in), then open
  `https://www.thabisomhlongo.com/checkin` (the Ticket Sales tab has a **Door check-in** button that opens it for the right show).
* Pick the show (it pre-selects the next one), **Start scanning**, allow the camera. Scan → check the name → **Check In**.
  The counter (X of Y checked in) updates from every phone every 30 s.
* No QR / cracked screen: type the buyer's name, e-mail, order number or the printed code into **Find**.
* **A volunteer without a portal account:** Events → Ticket Sales → pick the show → **Door links** → name the link (e.g. "Front door"
  or the volunteer's name) → **Create door link**. Send the link (WhatsApp is fine) or let them scan the QR shown. It is shown ONCE.
  On their phone it opens the same scanner, fixed to that show, with no buyer e-mails / phones and no money. It works until 12 hours
  after the show starts; **Switch off** stops it at once (check-ins already made stay). The list shows how many each link checked in;
  a re-scan says "Already scanned at 20:14 by Front door (door link)". Undo check-in (administrator / manager) clears it like any other.
* Scanning with the phone's ordinary camera app also works: it opens the ticket link, which shows the Check In button to signed-in
  staff (and only "Valid ticket for …" to anyone else).
* Camera needs HTTPS (the live site has it). On iPhones the bundled jsQR does the decoding; on Android Chrome the built-in reader.

## 5b. The office's extra tools (2026-11-01)

* **Search** (orders list and door search): name, e-mail, order number, a **phone number** in any SA form (082 123 4567 / +27 82 ...),
  a **ticket number** as printed on the PDF ("1042-2" = order 1042's 2nd valid ticket) and the **ticket code** (with or without the
  PDF's spaces). A door link never searches by e-mail or phone.
* **Guest list (complimentary tickets)** - Ticket Sales -> Guest list: ticket type, how many (1-20), guest name, optional e-mail / phone,
  who they are / why. A paid R0 order marked `complimentary` (+ `issued_by`, `comp_note`); seats are taken with the same atomic
  capacity check as a sale (never oversold), never revenue (the figures show "N complimentary"), no PayFast. E-mailed as "Complimentary"
  when an address is given; otherwise "Tickets PDF" in the order drawer. "Cancel these tickets" (the refund path, no e-mail) frees the seats.
* **Void & reissue** one ticket (order drawer, per ticket): reason required, optional new name; the old code is void at once (who / why
  kept), a new code is issued to the same order and type (`replaces_ticket_id`), seats unchanged, the buyer is e-mailed the tickets again.
  Refused for a ticket already used at the door (undo the check-in first). Audit: `TICKETS_COMPLIMENTARY_ISSUED`,
  `TICKETS_COMPLIMENTARY_CANCELLED`, `TICKET_REISSUED`. Tests: `ticketing-office` (22) + browser `checkin.js`.

## 5a. Sharing a show

Every upcoming show has a Share button (round, on the card's poster; "Share with friends" in the details pop-up and the Get Tickets
drawer). Phones use the system share sheet; other browsers get a menu (WhatsApp, Facebook, X, Copy link). What is shared is the short
link `/e/<event_id>` (`routes/public/site-content.js`): a tiny page whose Open Graph tags give chat apps the poster, title, date, venue
and "Tickets on sale now", then a meta refresh to `/?event=<id>`, where `js/event-share.js` opens that show's Get Tickets drawer (or its
details pop-up when tickets are not sold here). Same visibility rule as the events list: draft, cancelled and private-booking events are
not shareable (302 to `/#events`). The share page is `noindex` and cached 5 minutes. Tests: `event-share` (7) + browser `event-share.js` (13).
WhatsApp / Facebook cache a link's preview: after changing a poster, Facebook's Sharing Debugger can refresh it.

## 6. Configuration and jobs

**Bot check (Cloudflare Turnstile, free) - OFF until both keys are set.** `lib/turnstile.js`; env `TURNSTILE_SITE_KEY` + `TURNSTILE_SECRET_KEY`
(Cloudflare dashboard -> Turnstile -> Add site -> domain www.thabisomhlongo.com, widget mode "Managed"). With both set, pressing Continue
in the Get Tickets drawer runs the check (most people pass invisibly; some tick a box) and the reservation is refused (403) without a
valid one-use token. If Cloudflare cannot be reached the reservation is let through (logged) so an outage there never stops sales. CSP
allows `https://challenges.cloudflare.com` (script + frame). Test servers keep it off even if `.env` has keys (`test/support.js`;
a test that wants it sets `TEST_TURNSTILE_*`). Tests: `turnstile` (7, fake Cloudflare) + browser `turnstile.js` (Cloudflare's
published test keys, needs internet). The same middleware can guard the contact form later.


No new secrets or settings: PayFast credentials, sandbox/live switch, `PAYFAST_BASE_URL` / `PAYFAST_NOTIFY_BASE_URL`, mail and
`BASE_URL` (QR links) are the existing ones. `PAYFAST_RECONCILE=off` switches the safety net off for tickets too.
Jobs: the hold sweep (every 60 s after 30 s; a single cheap read unless a hold lapsed) and the existing 5-minute safety net. Neither
runs under `NODE_ENV=test`. The tickets e-mail has a banner slot `ticket_confirmation` in Email Banners.

## 7. Tests

Node (`npm test`): `ticketing-core` (32), `ticketing-lib` (child, throwaway DB, 16), `ticketing-admin` (15), `ticketing-flow` (~70),
`ticketing-reconcile` (10, fake PayFast history API), `ticketing-limits` (3), `payfast-checkout-form` (11, booking form byte-identical).
Browser (`npm run test:browser`): `ticketing.js` (25: drawer, phone sheet, focus, PayFast hand-off, return, states),
`checkin.js` (18: `/t/` public + staff, scanner, decoder, admin Ticket Sales + Tickets tab). Date offsets 1900-1969 are reserved.
Results on the branch (2026-10-30): full node suite 3551/3556 (the 5 failures are the pre-work baseline's: admin-nav x2,
inbox-sync x3); ticketing browser 25/25 + 18/18; 13 of 13 single-safeguard mutations caught. Real PayFast **sandbox** run
(isolated copy, fresh DB, ngrok, the owner's own sandbox merchant, safety net off so only a real notification could pay): all 13
end-to-end steps passed twice, plus a cancelled payment on PayFast's page.

**Accessibility + load (2026-11-01).** `test/browser/ticketing-a11y.js` runs axe-core 4.10.2 (fetched from cdnjs, nothing installed)
over every ticketing screen - drawer (choose / details / errors / paid), card + Share menu, `/t/`, door-link scanner, admin Ticket
Sales / order drawer / Tickets tab - and fails on critical / serious WCAG 2.1 AA findings. It found and we fixed: the Privacy Policy link
in the consent line was told apart by colour only (now underlined); white on the green "Admitted" banner was 2.8:1 (now dark text);
no page heading on `/checkin`; two empty admin table headers. `test/ticketing-load.test.js`: 100 simultaneous reservations for 50
tickets -> exactly 50 holds + 50 "sold out" in ~0.6 s (homepage events list unaffected); 120 mixed-quantity buyers for 100 -> never
oversold; 10 simultaneous payments each notified twice -> exactly 10 tickets.

## 8. Outstanding / owner decisions

* **DONE 2026-11-01 - owner confirmed `TRUST_PROXY_HOPS=2` on Render** (Cloudflare in front of Render). With 1, the app sees Cloudflare's address instead
  of the visitor's: every visitor shares the per-address rate limits (an on-sale would hit the 40-per-10-minutes limit for everyone at
  once), and PayFast's notifications are not recognised as PayFast's (source-IP check; and the notification limiter below).
* **PayFast notification limiter (shared with bookings, NOT changed - owner's call):** `payfastItnRateLimiter` takes 20 notifications
  a minute from any address PayFast is not known to use and answers the rest "200" without acting on them, so PayFast never retries them
  (found by the load test). PayFast's own addresses are exempt, so this only bites if the address is misread (see above); the buyer's
  return page and the 5-minute safety net then recover the payment from PayFast's history. Suggested: answer 429 / 503 instead of 200 so
  PayFast retries.


* **Ticket terms - APPROVED by the owner on 2026-11-01** (version `ticket-terms-2026-11-01`): `lib/ticketing-core.js` `TICKET_TERMS` -
  the single source shown in the drawer (3 key lines + "Read all ticket terms") and accepted with one checkbox together with the Privacy
  Policy; each order stores the version it accepted (`terms_version`, migration 114). Any wording change = a new version. The owner's
  legal adviser should still confirm it against the Consumer Protection Act before the first public sale.
* **Privacy Policy - APPROVED and applied on 2026-11-01:** a "Ticket purchases" item in section 2 and a ticketing purpose in section 3
  of `#privacyModal` in `index.html` (the single source; `/privacy` is built from it) and of the admin copy `#privacyModalAdmin`
  in `admin.html`; "Last Updated: 1 November 2026". `CURRENT_POLICY_VERSION` (lib/booking-policy.js) was NOT bumped: it is the
  booking / newsletter consent version and other flows stamp it - bump it only if the owner wants earlier consents re-asked.
* **Undo check-in** and the **orders CSV** (PayFast payment ids, for reconciliation) were added on 2026-11-01, and **door links**
  (volunteers without a portal account, migration 115) the same day.
* **VAT**: ticket prices are shown as final prices. If/when the business is VAT-registered, decide whether ticket receipts need to be
  tax invoices.
* **Refunds** are made in the PayFast dashboard; the site only records them (Mark as refunded).
* **Retention**: decide how long to keep `ticket_webhook_events.raw_payload` (it holds the buyer's name and e-mail) and add ticket
  buyers to the POPIA erasure flow (anonymise buyer fields, keep amounts).
* Pre-existing issues noticed, not changed: `/api/public/events` returns every events column (ip, user agent, admin ids, …) and
  `ORDER BY ASC LIMIT 100` will drop future events past 100 rows; draft/cancelled standalone events still block booking dates; the
  existing CSV exports neither decode text nor guard against spreadsheet formulas; `GET /api/admin/settings` returns the PayFast key
  to every admin role; most app writes outside ticketing are bare single statements on the shared connection (see §4); the mail
  queue (`lib/background-clerk.js`) logs `Successfully sent email #N to <recipient address>` for every e-mail the site sends
  (bookings too) - found by the real-sandbox run, left unchanged because it is shared mail code.
* **Go-live**: say "push"; check the Privacy Policy text; open sales on one show; buy one ticket for yourself on the live site and
  watch: order paid, e-mail with QR + PDF, `/t/` link, check-in on a phone.
