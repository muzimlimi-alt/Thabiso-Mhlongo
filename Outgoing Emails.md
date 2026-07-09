Here is the complete list of all **53 outgoing email configurations** defined in the codebase, grouped by their function:

### 1. Booking Lifecycle (Client-Facing Communications)

Automated transactional emails sent directly to clients during the booking lifecycle:

1. **Booking Request Receipt**
   - **Trigger Event:** `Booking: Client Receipt`
   - **Recipient:** Client
   - **Default Subject:** Booking Request Confirmation: Thabiso Mhlongo
2. **Booking Under Review**
   - **Trigger Event:** `Booking: Under Review`
   - **Recipient:** Client
   - **Default Subject:** Your Booking Is Under Review — Ref #id
3. **Quotation Dispatched**
   - **Trigger Event:** `Booking: Quote Generated`
   - **Recipient:** Client
   - **Default Subject:** Quotation for Booking #id
4. **Invoice Dispatched**
   - **Trigger Event:** `Booking: Invoice Generated`
   - **Recipient:** Client
   - **Default Subject:** Invoice for Booking #id
5. **Invoice Pre-Due Reminder**
   - **Trigger Event:** `Booking: Invoice Pre-Due Reminder`
   - **Recipient:** Client
   - **Default Subject:** Invoice Due in [days] Day(s)
6. **Invoice Overdue Reminder**
   - **Trigger Event:** `Booking: Invoice Overdue Reminder`
   - **Recipient:** Client
   - **Default Subject:** Invoice Overdue — Booking #id
7. **Quote Accepted Confirmation**
   - **Trigger Event:** `Booking: Quote Accepted Receipt`
   - **Recipient:** Client
   - **Default Subject:** Invoice Issued / Quote Accepted – Booking #id
8. **Booking Cancellation Confirmation**
   - **Trigger Event:** `Booking: Cancellation`
   - **Recipient:** Client
   - **Default Subject:** Booking Cancelled – Reference #id
9. **Payment Received Receipt**
   - **Trigger Event:** `Booking: Payment Received`
   - **Recipient:** Client
   - **Default Subject:** Payment Received / Status Update
10. **Final Booking Confirmation**
    - **Trigger Event:** `Booking: Final Confirmation`
    - **Recipient:** Client
    - **Default Subject:** Booking Confirmed 🎉 – #id
11. **Event Completed / Thank You**
    - **Trigger Event:** `Booking: Completed`
    - **Recipient:** Client
    - **Default Subject:** Thank You – Event Completed! Booking #id
12. **Quote Expired Notice**
    - **Trigger Event:** `Booking: Quote Expired`
    - **Recipient:** Client
    - **Default Subject:** Your Quote Has Expired – Booking #id
13. **Payment Failed Alert**
    - **Trigger Event:** `Booking: Payment Failed`
    - **Recipient:** Client
    - **Default Subject:** Payment Unsuccessful – Booking #id
14. **Deposit Received & Balance Reminder**
    - **Trigger Event:** `Booking: Deposit Received, Balance Due`
    - **Recipient:** Client
    - **Default Subject:** Deposit Received – Balance Due R[Amount] | Booking #id
15. **Booking Inquiry Expired**
    - **Trigger Event:** `Booking: Enquiry Expired`
    - **Recipient:** Client
    - **Default Subject:** Booking Enquiry Expired – Reference #id
16. **Quote Expiry Warning**
    - **Trigger Event:** `Booking: Quote Expiry Warning`
    - **Recipient:** Client
    - **Default Subject:** Your Quote Expires Tomorrow – Booking #id
17. **Post-Event Review Request**
    - **Trigger Event:** `Booking: Review Request`
    - **Recipient:** Client
    - **Default Subject:** How was your event? – Booking #id
18. **Refund Processed Confirmation**
    - **Trigger Event:** `Booking: Refund Processed`
    - **Recipient:** Client
    - **Default Subject:** Refund Processed – Booking #id
19. **Event Date Updated Notice**
    - **Trigger Event:** `Booking: Date Changed`
    - **Recipient:** Client
    - **Default Subject:** Event Date Updated – Booking #id
20. **Abandoned Booking Recovery Reminder**
    - **Trigger Event:** `Booking: Recovery Reminder`
    - **Recipient:** Abandoned Lead
    - **Default Subject:** Complete your booking request — Thabiso Mhlongo
21. **Quote Revision Request Received**
    - **Trigger Event:** `Booking: Quote Revision Acknowledgement`
    - **Recipient:** Client
    - **Default Subject:** We've Received Your Request – Booking #id
22. **Quote Follow-Up Reminder**
    - **Trigger Event:** `Booking: Quote Follow-Up Reminder`
    - **Recipient:** Client
    - **Default Subject:** Reminder: Your Quote Is Still Open — Ref #id
23. **Balance Due Event Reminder**
    - **Trigger Event:** `Booking: Deposit Balance Approaching Event Reminder`
    - **Recipient:** Client
    - **Default Subject:** Balance Payment Reminder — Event Approaching (Booking #id)

---

### 2. Booking Lifecycle (Internal Admin Notifications)

Internal alerts to keep the administrator/management updated on operational tasks:

24. **New Booking Request Submitted**
    - **Trigger Event:** `Booking: Admin Notification`
    - **Recipient:** Admin
    - **Default Subject:** NEW BOOKING REQUEST: [Event Type] on [Event Date]
25. **Quote Dispatched Confirmation**
    - **Trigger Event:** `Booking: Quote Sent (Admin Notification)`
    - **Recipient:** Admin
    - **Default Subject:** Quote Sent — Booking #id
26. **Payment Received Alert**
    - **Trigger Event:** `Admin: Payment Notification`
    - **Recipient:** Admin
    - **Default Subject:** Payment Received – Booking #id
27. **Booking Completed Summary**
    - **Trigger Event:** `Admin: Booking Completed Summary`
    - **Recipient:** Admin
    - **Default Subject:** Booking #id Completed — [Event Name]
28. **Client Accepted Quote Alert**
    - **Trigger Event:** `Admin: Quote Accepted Notification`
    - **Recipient:** Admin
    - **Default Subject:** Invoice Issued – Booking #id Awaiting Payment
29. **PayFast ITN Total Missing Rejection**
    - **Trigger Event:** `Admin: ITN No Total`
    - **Recipient:** Admin
    - **Default Subject:** PayFast ITN Rejected – Missing Total – Booking #id
30. **Client Overpayment Detected**
    - **Trigger Event:** `Admin: Overpayment Alert`
    - **Recipient:** Admin
    - **Default Subject:** Overpayment Detected – Booking #id
31. **Client Balance Payment Failed**
    - **Trigger Event:** `Admin: Balance Payment Failed`
    - **Recipient:** Admin
    - **Default Subject:** ⚠️ Balance Payment Failed – Booking #id
32. **Client Requested Quote Revision**
    - **Trigger Event:** `Booking: Quote Revision Request`
    - **Recipient:** Admin
    - **Default Subject:** [ACTION REQUIRED] Quote Revision Request – Booking #id
33. **Contract Signature Reminder Triggered**
    - **Trigger Event:** `Admin: Contract Remind`
    - **Recipient:** Client (Admin-triggered)
    - **Default Subject:** Action Required: Please sign your contract — [Event Name]
34. **Booking Cancellation Notification**
    - **Trigger Event:** `Admin: Client Cancellation`
    - **Recipient:** Admin
    - **Default Subject:** Client Cancelled – Booking #id
35. **New Client Review Received**
    - **Trigger Event:** `Admin: New Review Submitted`
    - **Recipient:** Admin
    - **Default Subject:** New Review Submitted – Booking #id ([Rating]★)
36. **Admin Custom Booking Response**
    - **Trigger Event:** `Admin: Booking Respond`
    - **Recipient:** Client
    - **Default Subject:** Custom Response Subject

---

### 3. Contact Form & Inquiries

For handling public communication from the website contact form:

37. **Contact Inquiry Received (Admin Alert)**
    - **Trigger Event:** `Contact Form: Admin Notification`
    - **Recipient:** Admin
    - **Default Subject:** Website Inquiry: [Subject]
38. **Contact Form Submission Receipt**
    - **Trigger Event:** `Contact Form: Visitor Receipt`
    - **Recipient:** Visitor
    - **Default Subject:** Thank you for your message, [Name]!
39. **Admin Inquiry Reply Compose**
    - **Trigger Event:** `Admin: Inquiry Reply`
    - **Recipient:** Visitor
    - **Default Subject:** Re: [Inquiry Subject]
40. **Admin Direct Email Compose**
    - **Trigger Event:** `Admin: Direct Compose`
    - **Recipient:** Custom Email
    - **Default Subject:** Message from Thabiso Mhlongo Management / Custom

---

### 4. Newsletters & Marketing Campaigns

For bulk campaigns and newsletter lists:

41. **Newsletter Welcome Acknowledgment**
    - **Trigger Event:** `Newsletter: Welcome Receipt`
    - **Recipient:** Subscriber
    - **Default Subject:** Welcome to Thabiso Mhlongo's Newsletter!
42. **Scheduled Newsletter Dispatch**
    - **Trigger Event:** `Newsletter: Scheduled Campaign`
    - **Recipient:** Subscribers
    - **Default Subject:** [Campaign Subject]
43. **Manual Campaign Dispatch**
    - **Trigger Event:** `Newsletter: Campaign Dispatch`
    - **Recipient:** Subscribers
    - **Default Subject:** [Campaign Subject]

---

### 5. Administrative Dashboards & System Alerts

Automated background checks, logs, access details, and synchronization warnings:

44. **Pending Enquiry Expiry Approaching Warning**
    - **Trigger Event:** `Admin: Pending Expiry Warning`
    - **Recipient:** Admin
    - **Default Subject:** Enquiries expiring soon – pending request(s) need a quote
45. **Overdue Payment Summary Report**
    - **Trigger Event:** `Admin: Overdue Payment Digest`
    - **Recipient:** Admin
    - **Default Subject:** Overdue Payments – booking(s) and outstanding balances
46. **Dashboard Staff Invite**
    - **Trigger Event:** `Admin: User Invitation`
    - **Recipient:** Invited User
    - **Default Subject:** Invitation to Management Dashboard
47. **Dashboard Password Reset Request**
    - **Trigger Event:** `Admin: Password Reset Request`
    - **Recipient:** User
    - **Default Subject:** Password Reset Request - Thabiso Mhlongo Dashboard
48. **Google Calendar Sync Failure Alert**
    - **Trigger Event:** `System: Calendar Sync Failure`
    - **Recipient:** Admin
    - **Default Subject:** ⚠️ Google Calendar Sync Failed – New Booking #bookingId
49. **Admin Panel Test Dispatch**
    - **Trigger Event:** `Admin: Test Notification`
    - **Recipient:** Tester
    - **Default Subject:** Test Notification — Thabiso Mhlongo Admin
50. **Payment Schedule Reminder**
    - **Trigger Event:** `Payment Reminder`
    - **Recipient:** Client
    - **Default Subject:** Payment Reminder — [Description] due [Date]
51. **Stalled Bookings Alert**
    - **Trigger Event:** `Admin: Stalled Booking Alert`
    - **Recipient:** Admin
    - **Default Subject:** Action Required: [Count] ACCEPTED booking(s) missing invoice
52. **Ledger Discrepancy Reconciliation Alert**
    - **Trigger Event:** `Admin: Ledger Reconciliation`
    - **Recipient:** Admin
    - **Default Subject:** [Ledger Alert] booking(s) with payment discrepancy
53. **PayFast Transaction Stuck Warning**
    - **Trigger Event:** `Admin: PayFast Pending Timeout`
    - **Recipient:** Admin
    - **Default Subject:** [PayFast Alert] transaction(s) stuck in PENDING for >1 hour

---

### Summary of Work

- Compiled the full detailed listing of all 53 programmatic email senders/configurations.
- Structured each entry with its logical trigger, target recipient type, and subject format for quick reference.
