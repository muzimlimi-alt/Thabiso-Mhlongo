# Outgoing email (SMTP) — architecture, configuration, operations

Written October 2026 when the site moved from a personal Gmail sender to the Microsoft 365 mailbox
`bookings@thabisomhlongo.com`. Read this before touching anything that sends mail.

## How mail leaves the system

```
any workflow ──► sendEmail()  ──► INSERT notifications (status 'pending')           js/emailService.js
 (bookings, quotes, invoices,                    │
  payments, resets, invites,                     ▼  every 20 s
  reminders, newsletters,       processNotificationQueue()                          lib/background-clerk.js
  birthday, alerts, replies)                     │
                                                 ▼
                                    sendEmailDirectly() ──► deliver()               js/emailService.js
                                                 │            1. email_logs row 'pending'
                                                 │            2. getTransport()  ◄── lib/smtp-config.js
                                                 │            3. nodemailer sendMail (STARTTLS required)
                                                 ▼            4. email_logs row 'success' | 'failed'
                                   notifications.status 'sent' | retry | 'failed'
```

* **One transport.** `js/emailService.js` is the only file that calls `nodemailer.createTransport`
  (`test/smtp.test.js` fails if a second one appears). Every email — including the scheduled jobs, the
  newsletter/birthday sweeps and the admin "Send Test" — reaches SMTP through it.
* **Queued ≠ sent.** `sendEmail()` only queues. Callers get `{success:true}` meaning "queued"; the
  real outcome is in `notifications` and `email_logs`. Only the admin **Send Test** and **Test Connection**
  talk to SMTP synchronously (so their answers are real).
* The transport is built lazily from the resolved config and rebuilt automatically when it changes, so
  saved settings apply to the next email with no restart.

## Where the configuration lives (no second store)

`lib/smtp-config.js` only *reads/validates* what already existed:

| Field | Admin screen / `settings` key | Environment default |
|---|---|---|
| Host | `smtp_host` | `SMTP_HOST` |
| Port | `smtp_port` | `SMTP_PORT` (587) |
| Encryption | `smtp_secure` (`starttls`/`ssl`) | `SMTP_SECURE` |
| Username | `smtp_user` | `SMTP_USER` |
| **Password** | `smtp_pass` — **AES-256-GCM encrypted** | `SMTP_PASS` |
| Sign-in method | `smtp_auth` (`password` / `oauth`) | `SMTP_AUTH` |
| Tenant ID (OAuth) | `smtp_oauth_tenant` | `SMTP_OAUTH_TENANT_ID` |
| Application (client) ID (OAuth) | `smtp_oauth_client` | `SMTP_OAUTH_CLIENT_ID` |
| **Client secret** (OAuth) - **AES-256-GCM encrypted** | `smtp_oauth_secret` | `SMTP_OAUTH_CLIENT_SECRET` |
| From address | `smtp_from` | `SMTP_FROM` (a bare address; `"Name" <addr>` is also understood) |
| Sender name | `smtp_from_name` | `SMTP_FROM_NAME` (default "Thabiso Mhlongo") |

Precedence per field: *(unsaved form value, Test Connection only)* → settings table → environment → default.
A workflow may still pass its own display name (the new-booking alert uses the client's name); the
**address** is always the configured one.

**Legacy Gmail pair.** `EMAIL_USER` / `EMAIL_PASS` still work, but only as a complete unit and only while *no*
SMTP host/user/password exists anywhere. The moment any `SMTP_*` value or admin setting exists they are
ignored entirely, so a Gmail password can never be sent to Microsoft.

### The password
* Stored encrypted (`enc:v1:…`) with a key derived from `SETTINGS_ENCRYPTION_KEY`, falling back to
  `SESSION_SECRET`. **Changing/losing that secret makes the stored password unreadable** — the admin screen
  and Test Connection say so; re-enter it. Prefer setting `SMTP_PASS` as a deployment secret if you want it
  independent of the app.
* Never returned by any API (GET settings reports only "a password is saved / comes from the environment"),
  never copied into `process.env`, never logged (errors are classified and redacted), never in the audit log.
* Older builds stored it in plaintext; it is encrypted in place at boot (`migrateLegacyPassword`).
* `deepEscapeBody` (app.js) HTML-encodes request fields whose name contains "pass" once; the settings route
  reverses exactly that single pass, so passwords with `& < > " '` survive.

### Who can do what
* Read or change SMTP settings, Test Connection, Send Test: **administrator** only (server-enforced). Other
  roles can still load/save non-SMTP settings, but get no `smtp` section and the card is hidden.
* Saving validates everything first (host, port, STARTTLS/SSL vs port, addresses, no CR/LF) and, if the
  connection details changed, **runs a connection test before writing anything** — working settings are never
  replaced by ones that fail. Saves are audited (`audit_log`, no secrets).
* In production the host may not be loopback/private/link-local and the port must be 25/465/587/2525
  (Test Connection otherwise lets an admin probe the internal network from the server).

## Security properties (all covered by tests)
* STARTTLS is **required** (`requireTLS`): a server that does not offer it is refused and the password is
  never sent. TLS ≥ 1.2.
* The mail server's certificate **is verified**, even though `app.js` sets `NODE_TLS_REJECT_UNAUTHORIZED=0`
  process-wide (the explicit per-connection option overrides it). If a TLS-intercepting antivirus/proxy
  breaks this (it showed up as "Avast Web/Mail Shield" on the dev PC), set
  `SMTP_TLS_REJECT_UNAUTHORIZED=false` for that machine only. The legacy Gmail fallback keeps its old
  unverified behaviour until it is migrated.

## Failure handling
* `email_logs` gets one row per **attempt**, in both rendering branches (`EMAIL_OVERHAUL_ENABLED` on or off —
  before this work the default branch wrote no log). `success` means **the mail server accepted the message**;
  its own reply is kept in `smtp_response`. SMTP cannot confirm inbox delivery — use the Exchange message
  trace or a bounce for that. Failures store a classified, redacted reason.
* Per-email transient failures keep the existing rule: retry each sweep, `failed` after 3 attempts.
* **Systemic failures** (wrong password, SMTP AUTH disabled, refused sender, TLS) fail every email the same
  way, so the queue **pauses** (5 min, or until settings are saved / a connection test passes), leaves rows
  `pending` without burning retries, and gives up on a row after 24 h. This stops customer emails being
  permanently failed in a minute and avoids hammering Microsoft's sign-in (lock-out risk).
* An email failure never touches booking/payment/invoice/contract rows (the queue is the only coupling).

### Error → meaning (what admins will see)
| Server says | Meaning / action |
|---|---|
| `535 5.7.139` | Authenticated SMTP disabled for mailbox *or* tenant, or security defaults/MFA/Conditional Access block basic auth, or wrong password |
| `550 5.7.30` | Tenant has turned basic SMTP auth off — re-enable it or move to OAuth |
| `530 5.7.57` | Authenticated SMTP disabled for this mailbox |
| `550 5.7.60 SendAsDenied` | From address ≠ the signed-in mailbox and no "Send As" permission |
| connect/timeout | host/port wrong or outbound 587 blocked |

## Microsoft 365 sign-in: OAuth (recommended) or mailbox password

Two ways to sign in to smtp.office365.com:587, chosen by the **Sign-in method** on the Email (SMTP) card (`smtp_auth`):

| | Mailbox password | **Microsoft 365 OAuth** |
|---|---|---|
| What is sent | the mailbox password (SASL PLAIN/LOGIN) | a short-lived token the app obtains for itself (SASL XOAUTH2) |
| Security defaults / MFA / legacy-auth blocks | **block it** (Entra error 50126/53003/...; SMTP says `535 5.7.3`) | not affected - no user sign-in happens |
| Basic-auth shutdown (default-off for existing tenants end of Dec 2026) | stops working | unaffected |
| What is stored | the password (AES-256-GCM encrypted) | tenant ID, application ID, client secret (AES-256-GCM encrypted) |

### How OAuth works here (`lib/smtp-oauth.js`)
1. `POST https://login.microsoftonline.com/<tenant>/oauth2/v2.0/token` with `grant_type=client_credentials`, `client_id`, `client_secret`, `scope=https://outlook.office365.com/.default`.
2. nodemailer sends `AUTH XOAUTH2 base64("user=<mailbox>\x01auth=Bearer <token>\x01\x01")` over STARTTLS.
3. The token (about an hour) is cached in memory and renewed two minutes early; **Test Connection** always fetches a fresh one.
4. The token request verifies Microsoft's certificate even though `app.js` disables TLS verification process-wide (same `SMTP_TLS_REJECT_UNAUTHORIZED` escape hatch as SMTP). The secret and tokens are never logged; error text is redacted.

### One-time setup (a Global Administrator does this; nothing here needs code changes)
1. **Entra admin center -> App registrations -> New registration** ("Thabiso website mail", this directory only). Copy the **Application (client) ID** and the **Directory (tenant) ID**.
2. **API permissions -> Add a permission -> APIs my organization uses -> Office 365 Exchange Online -> Application permissions -> `SMTP.SendAsApp`**, then **Grant admin consent**.
3. **Certificates & secrets -> New client secret.** Copy the **Value** at once (not the Secret ID - it is shown only once). Note the expiry (24 months maximum) and put a reminder in a calendar: **when it expires every email stops** (the card then says "client secret has expired").
4. **Entra -> Enterprise applications** -> the app -> copy its **Object ID**. It is *not* the Object ID on the App registration page - Microsoft documents that mixing them up causes an authentication failure.
5. In PowerShell (Exchange Online module):
   ```
   Install-Module ExchangeOnlineManagement
   Connect-ExchangeOnline -Organization <tenant ID>
   New-ServicePrincipal -AppId <application (client) ID> -ObjectId <ENTERPRISE-app Object ID>
   Add-MailboxPermission -Identity "bookings@thabisomhlongo.com" -User <ENTERPRISE-app Object ID> -AccessRights FullAccess
   ```
   (Source: Microsoft Learn, "Authenticate an IMAP, POP or SMTP connection using OAuth". If the From address ever differs from the mailbox, also grant `Add-RecipientPermission` SendAs.)
6. Keep **Authenticated SMTP** enabled for the mailbox (Exchange admin center -> mailbox -> Manage email apps) and **"Turn off SMTP AUTH protocol for your organization" unticked** (Mail flow -> Settings).
7. Wait 15-30 minutes, then on the admin card choose **Microsoft 365 OAuth**, enter SMTP User = the mailbox, the tenant ID, application ID and secret **Value**, press **Test Connection**, then **Save** (Save runs the same test first and refuses to store settings that fail).

### Reading failures
| Card says | Meaning |
|---|---|
| `AADSTS7000215` | wrong client secret - use the **Value**, not the Secret ID (the card warns if you paste a GUID) |
| `AADSTS7000222` | the client secret has expired - create a new one |
| `AADSTS700016` | no app with that Application (client) ID in the tenant - check the IDs |
| `AADSTS90002` | wrong Directory (tenant) ID |
| "issued a token but refused the SMTP sign-in (535 5.7.3)" | the app is not fully set up in Exchange: `New-ServicePrincipal` with the **Enterprise** Object ID, `Add-MailboxPermission ... FullAccess`, admin consent for SMTP.SendAsApp, Authenticated SMTP on - then wait 15-30 minutes |
| "5.7.139 / 5.7.57" | Authenticated SMTP is disabled for the mailbox or the organisation |
| "could not reach the Microsoft sign-in service" | the server has no route to login.microsoftonline.com (transient; the queue retries) |

Where Microsoft logs it: Entra -> Monitoring & health -> Sign-in logs -> **Service principal sign-ins** tab (OAuth) or the user sign-in tabs with Client app = *Authenticated SMTP* (password). For passwords the log's **Sign-in error code** names the cause (e.g. `50126` = wrong password).

### Password sign-in checklist (only if you use the password method)
1. The mailbox is a licensed user that can sign in with that exact password; Authenticated SMTP is on for the mailbox and the organisation.
2. **Security defaults must be off, or Conditional Access must allow it** - security defaults block legacy sign-in methods including password SMTP and cannot exclude one account. In a one-admin tenant that is a poor trade; prefer OAuth.
3. **Deadline:** Microsoft's January 2026 update keeps basic-auth SMTP AUTH working until the end of December 2026, after which it is off by default for existing tenants (admins can re-enable); final removal is to be announced in 2H 2027.
4. Deliverability (needed for inboxes, not for submission): SPF includes `spf.protection.outlook.com`, DKIM enabled, a DMARC record. Prove inbox delivery with Exchange admin center -> Mail flow -> Message trace.
5. Do not use the tenant's only Global Administrator mailbox as an app credential if you can avoid it.

## Tests
* `test/smtp.test.js` — the real transport/queue against a fake STARTTLS+AUTH+XOAUTH2 server and a fake Microsoft token
  endpoint (`test/fake-smtp.js`, `test/smtp-transport.child.js`), the admin API (roles, masking, atomic validation, Send Test, Test
  Connection), and source scans (one transport, no stray `EMAIL_USER`/Gmail).
* `test/browser/smtp-settings.js` — the real admin UI (`npm run test:browser`).
* Never run against a real mail server. A live check needs the real password and is manual: Test Connection,
  then Send Test, then look in the inbox and the message trace.

## Known gaps (deliberately left alone)
* `GET /api/admin/settings` still returns the PayFast merchant key/passphrase to any admin role (the UI masks the
  passphrase only cosmetically). Same treatment as SMTP would fix it.
* `app.js` sets `NODE_TLS_REJECT_UNAUTHORIZED=0` for the whole process (affects every other outbound HTTPS call).
* Invite / password-reset routes report "sent" when the email was **queued**.
* **Queued emails lose their attachments (open bug, found Oct 2026, NOT fixed).** Since `sendEmail` started queueing (commit d3f3dbc9,
  2026-06-21) only *string* paths survive into `notifications.attachment_paths`; every `{ filename, content: Buffer }` attachment is silently
  dropped - the quote/invoice/contract PDFs, the advancing pack, `.ics` invites, direct-email and campaign attachments - and path
  attachments lose their display name. Reproduce: queue a Buffer attachment and read `attachment_paths` (NULL). A proper fix has to
  persist the bytes durably (the DB, de-duplicated by hash so newsletters do not copy a PDF per recipient) and keep
  `{ filename, contentType }`; it needs a storage decision (R2 vs disk vs DB), so it was left for the owner to decide.
