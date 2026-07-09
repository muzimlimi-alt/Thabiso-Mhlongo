# Website Email Configurations Directory

The website codebase contains **53 unique email configurations** (places where emails are programmatically constructed and sent/queued). These configurations are grouped below by their functional domain.

---

## 1. Booking Lifecycle (Client-Facing Comms)
These configurations send direct transactional emails to clients during various stages of their bookings.

| # | Trigger Event Name | Target Recipient | Code Line | Subject Template / Subject Line |
| :--- | :--- | :--- | :---: | :--- |
| 1 | `Booking: Client Receipt` | Client (`email`) | 2569 | Booking Request Confirmation: Thabiso Mhlongo |
| 2 | `Booking: Under Review` | Client (`email`) | 2600 | Your Booking Is Under Review — Ref #id |
| 3 | `Booking: Quote Generated` | Client (`email`) | 2714 | Quotation for Booking #id |
| 4 | `Booking: Invoice Generated` | Client (`email`) | 2805 | Invoice for Booking #id |
| 5 | `Booking: Invoice Pre-Due Reminder` | Client (`email`) | 2849 | Invoice Due in {daysUntilDue} Day(s) |
| 6 | `Booking: Invoice Overdue Reminder` | Client (`email`) | 2892 | Invoice Overdue — Booking #id |
| 7 | `Booking: Quote Accepted Receipt` | Client (`email`) | 2959 | Invoice Issued / Quote Accepted – Booking #id |
| 8 | `Booking: Cancellation` | Client (`email`) | 3000 | Booking Cancelled – Reference #id |
| 9 | `Booking: Payment Received` | Client (`email`) | 3035 | Payment Status Updates – Booking #id |
| 10 | `Booking: Final Confirmation` | Client (`email`) | 3118 | Booking Confirmed 🎉 – #id |
| 11 | `Booking: Completed` | Client (`email`) | 3204 | Thank You – Event Completed! Booking #id |
| 12 | `Booking: Quote Expired` | Client (`email`) | 3221 | Your Quote Has Expired – Booking #id |
| 13 | `Booking: Payment Failed` | Client (`email`) | 3241 | Payment Unsuccessful – Booking #id |
| 14 | `Booking: Deposit Received, Balance Due` | Client (`email`) | 3260 | Deposit Received – Balance Due | Booking #id |
| 15 | `Booking: Enquiry Expired` | Client (`email`) | 3277 | Booking Enquiry Expired – Reference #id |
| 16 | `Booking: Quote Expiry Warning` | Client (`email`) | 3384 | Your Quote Expires Tomorrow – Booking #id |
| 17 | `Booking: Review Request` | Client (`email`) | 3395 | How was your event? – Booking #id |
| 18 | `Booking: Refund Processed` | Client (`email`) | 3411 | Refund Processed – Booking #id |
| 19 | `Booking: Date Changed` | Client (`email`) | 3428 | Event Date Updated – Booking #id |
| 20 | `Booking: Recovery Reminder` | Client (`draft.email`) | 3978 | Complete your booking request — Thabiso Mhlongo |
| 21 | `Booking: Quote Revision Acknowledgement` | Client (`row.email`) | 5368 | We've Received Your Request – Booking #row.id |
| 22 | `Booking: Quote Follow-Up Reminder` | Client (`b.email`) | 13638 | Reminder: Your Quote Is Still Open — Ref #b.id |
| 23 | `Booking: Deposit Balance Approaching Event Reminder` | Client (`b.email`) | 13836 | Balance Payment Reminder — Event Approaching |

---

## 2. Booking Lifecycle (Internal Admin Alerts)
These configurations notify the administrator (or booking manager) about changes in booking statuses, contract operations, client queries, or client reviews.

| # | Trigger Event Name | Target Recipient | Code Line | Subject Template / Subject Line |
| :--- | :--- | :--- | :---: | :--- |
| 24 | `Booking: Admin Notification` | Admin (`notifEmail`) | 2560 | NEW BOOKING REQUEST: {type} on {date} |
| 25 | `Booking: Quote Sent (Admin Notification)` | Admin (`notifEmail`) | 2740 | Quote Sent — Booking #id (name) |
| 26 | `Admin: Payment Notification` | Admin (`notifEmail`) | 3293 | Payment Received – Booking #id |
| 27 | `Admin: Booking Completed Summary` | Admin (`notifEmail`) | 3360 | Booking #id Completed — {event_name} |
| 28 | `Admin: Quote Accepted Notification` | Admin (`notifEmail`) | 3373 | Invoice Issued – Booking #id Awaiting Payment |
| 29 | `Admin: ITN No Total` | Admin (`notifEmail`) | 4580 | PayFast ITN Rejected – Missing Total – Booking #id |
| 30 | `Admin: Overpayment Alert` | Admin (`notifEmail`) | 4630 | Overpayment Detected – Booking #id |
| 31 | `Admin: Balance Payment Failed` | Admin (`notifEmail`) | 4704 | ⚠️ Balance Payment Failed – Booking #id |
| 32 | `Booking: Quote Revision Request` | Admin (`notifEmail`) | 5360 | [ACTION REQUIRED] Revision Request – Booking #id |
| 33 | `Admin: Contract Remind` | Client (`b.email`) | 6230 | Action Required: Please sign your contract — {event} |
| 34 | `Admin: Client Cancellation` | Admin (`notifEmail`) | 10438 | Client Cancelled – Booking #id |
| 35 | `Admin: New Review Submitted` | Admin (`notifEmail`) | 10475 | New Review Submitted – Booking #id (ratingNum★) |
| 36 | `Admin: Booking Respond` | Client (`email`) | 12244 | Response to Booking Request (Custom) |

---

## 3. Contact Form & Inquiries
Configurations used to process public inquiries from the website's Contact Us form.

| # | Trigger Event Name | Target Recipient | Code Line | Subject Template / Subject Line |
| :--- | :--- | :--- | :---: | :--- |
| 37 | `Contact Form: Admin Notification` | Admin (`receiver`) | 6350 | Website Inquiry: {subject} |
| 38 | `Contact Form: Visitor Receipt` | Visitor (`email`) | 6369 | Thank you for your message, {name}! |
| 39 | `Admin: Inquiry Reply` | Visitor (`sender_email`) | 12700 | Re: {inquiry.subject} |
| 40 | `Admin: Direct Compose` | Custom (`to`) | 12739 | Message from Thabiso Mhlongo Management |

---

## 4. Newsletter & Marketing Campaigns
Configurations linked to newsletter sign-ups and bulk/scheduled email dispatches.

| # | Trigger Event Name | Target Recipient | Code Line | Subject Template / Subject Line |
| :--- | :--- | :--- | :---: | :--- |
| 41 | `Newsletter: Welcome Receipt` | Subscriber (`email`) | 6433 | Welcome to Thabiso Mhlongo's Newsletter! |
| 42 | `Newsletter: Scheduled Campaign` | Subscriber (`sub.email`) | 6866 | {schedItem.subject} |
| 43 | `Newsletter: Campaign Dispatch` | Subscriber (`recipientEmail`) | 7042 | {campaign.subject} |

---

## 5. Administrative Dashboards, Auditing & System Alerts
These configurations generate system logs, user access details, synchronization alerts, or ledger reconciliation warnings.

| # | Trigger Event Name | Target Recipient | Code Line | Subject Template / Subject Line |
| :--- | :--- | :--- | :---: | :--- |
| 44 | `Admin: Pending Expiry Warning` | Admin (`notifEmail`) | 1447 | Enquiries expiring soon – pending request(s) |
| 45 | `Admin: Overdue Payment Digest` | Admin (`notifEmail`) | 1468 | Overdue Payments – booking(s) and amounts |
| 46 | `Admin: User Invitation` | Invited User (`user.email`) | 2224 | Invitation to Dashboard |
| 47 | `Admin: Password Reset Request` | Admin User (`email`) | 2295 | Password Reset Request - Dashboard |
| 48 | `System: Calendar Sync Failure` | Admin (`notifEmail`) | 3882 | ⚠️ Google Calendar Sync Failed – New Booking #bookingId |
| 49 | `Admin: Test Notification` | Tester (`to`) | 8161 | Test Notification — Thabiso Mhlongo Admin |
| 50 | `Payment Reminder` | Client (`client_email`) | 13567 | Payment Reminder — {sched.description} |
| 51 | `Admin: Stalled Booking Alert` | Admin (`adminEmail`) | 13712 | Action Required: stalled ACCEPTED booking(s) missing invoice |
| 52 | `Admin: Ledger Reconciliation` | Admin (`adminEmail`) | 14023 | [Ledger Alert] booking(s) with payment discrepancy |
| 53 | `Admin: PayFast Pending Timeout` | Admin (`adminEmail`) | 14084 | [PayFast Alert] transaction(s) stuck in PENDING |

---

### Source Code Location
All these configurations are located inside the main application backend file:
* **[server.js](file:///c:/Users/muzim/OneDrive/Muzi's%20Office/Dev-Beast/Thabiso%20Mhlongo%20Official%20Website/Thabiso%20Mhlongo%20Offcial%20Website/server.js)**
