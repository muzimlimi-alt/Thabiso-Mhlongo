# Admin Operations Guide - Thabiso Mhlongo Management

Welcome to your command center. This guide explains how to manage the day-to-day operations of your digital brand.

## 🏁 1. The Dashboard
Access via `yourdomain.com/admin.html`. 

### Security & Logs
- **Security Tab**: Monitor system integrity and session health.
- **Audit Trail**: View a history of all changes made to the system. This is your accountability record.

## 📅 2. Event Management
- **Upcoming Events**: Add tour dates under the "Events" tab. They will appear instantly on the home page.
- **Past Events**: Moving an event to "Past" or "Archived" status hides it from the "Upcoming" section but keeps it in your records.

## 💼 3. Booking Engine
The heart of your business operations.
- **Inquiries**: Review incoming booking requests.
- **Statuses**: Update bookings from `pending` to `quoted`, `confirmed`, or `completed`.
- **Invoicing**: Generate professional PDF Invoices and Quotes directly from the booking detail view.

## 💰 4. Financial Intelligence
- **Ledger**: Track all payments received.
- **Data Export**: Click "Download CSV" in the Finance tab to export your financial year data for your accountant.

## 📸 5. Gallery Management
- **Uploads**: Add new high-resolution photos or videos.
- **Optimization**: Images are automatically lazy-loaded for your visitors to ensure the site stays fast.

## 🏅 6. Accolades & Recognition
Under **Site Content → Accolades**. External recognition only — wins, nominations and honours. Your own career moments belong in **Career** (the Milestones section).
- **Add**: New accolades start **Inactive** (a draft). Check the live preview in the drawer, then switch **Active** on to publish.
- **Website**: The "Accolades & Recognition" section stays hidden until at least one accolade is Active. Newest year comes first; drag cards (in website order) or use **More → Move up/down** to arrange accolades within a year.
- **Featured**: Marks an accolade for a large framed panel on the website.
- **Media & links**: An achievement image, the organisation's logo, a certificate (PDF or image), plus an official page and a source link — shown when a visitor clicks "View".
- **Remove**: Set it **Inactive** to take it off the website but keep it. Deleting is permanent and administrator-only.

## 💳 7. Client Payment Plans
Clients design their own payment plan when they accept a quote, and can later rearrange the payments they haven't made yet from their booking page. Changes apply **immediately** — there is nothing to approve.
- **The rules** (checked on the booking page and again by the server):
  - At most **4 payments** in total. Payments already made count towards the 4.
  - The **first payment** must be at least the **Deposit Percentage** of the total, and due within **7 days** of accepting the quote. The 7 days count from the original acceptance, so a client can't keep pushing the deposit back by editing the plan.
  - Every payment must be due between **today** and **2 days before the event**, one payment per day.
  - No payment may be below the **Minimum Instalment Amount**, unless it is the only payment left.
  - **Paid payments are locked.** The client can only move or split what is still owed.
- **Where the settings live**: **Policies → Booking Policies**: **Deposit Percentage** and **Minimum Instalment Amount (R)** (default R500). Changes apply to the next plan a client saves; existing plans are left as they are.
- **What you'll see**: an email titled **"Payment Plan Changed – Booking #…"** (showing the previous and new plan), a **[Payment Plan Changed]** note on the booking, and an entry in its Change History. When a client designs the plan while accepting, the usual "Invoice Issued" email lists the plan and marks it as client-designed. In the booking's **Payment Milestones** card, a **Client-designed plan** badge shows when the client last changed it, and paid payments are marked **Paid · locked for the client**. The client also gets a "Your Payment Plan Has Been Updated" email with the new schedule.
- **Invoices & contracts**: the invoice PDF is updated automatically (same invoice number, nothing re-sent); if that isn't possible, the email tells you. A **draft** contract is regenerated. A contract that has already been **sent or signed is never changed**, and the email warns you that it still shows the old schedule. Regenerate and re-send it yourself if the new schedule should be part of the agreement.
- **You stay in control**: you can still change any plan with **Edit Schedule / Setup Milestones**. You'll be asked to confirm before replacing a client-designed plan. Your own plans don't have to follow the client rules.
- **When the client can't change the plan online**: if a payment needs to be reconciled (for example, a part-payment), a payment was started in the last hour, or all 4 payments are used up, the booking page explains why and, where needed, asks the client to contact you.
- **Check your wording**: the **Payment Terms** text on quotes and contracts may still say something like "50% deposit on acceptance, balance 48 hours before the event". Reword it if it no longer matches how clients can pay.

## 🔒 8. Security Maintenance
- **Session Expiry**: For security, the admin portal will automatically log you out after 2 hours of inactivity.
- **Backups**: Ensure someone runs `npm run backup` weekly, or set up a server 'cron' job to do it automatically.

---
*For technical support, contact the Dev-Beast support team.*
