// Business Activity & Alert Management System - the EVENT REGISTRY (docs-internal/notifications.md).
//
// The single source of truth for every event the application can announce: its category, default priority, whether it needs the owner
// to DO something (kind 'action') or merely be aware (kind 'attention'), how repeats are grouped, who may see it and what the e-mail
// says. Modules never build notifications themselves - they call lib/notify.js emit('finance.eft_proof_submitted', {...}) and this
// file decides the rest. The database only stores OVERRIDES (notification_rules / notification_prefs), and the engine refuses an
// override that would mute a `mandatory` event.
//
// Kinds:   'action'    - waiting for the owner's intervention / approval / decision (Action required view; stays open until resolved)
//          'attention' - upcoming expiries, deadlines, degraded integrations, things worth knowing (Attention view)
//          'activity'  - recorded in the Activity feed only; never a notification row (successful routine events)
// Dedupe:  the key for "the same incident". While one is open, a repeat bumps occurrence_count instead of adding a row or an e-mail.
//          `reopen: true` brings a RESOLVED incident back (a problem that recurs after being fixed is the same problem); otherwise a
//          resolved incident is left alone and a new one starts.
// Wording: stored text is plain (never entity-encoded) and escaped where it is rendered - see the stored-text convention.

const ALL = ['administrator', 'manager', 'assistant'];
const OPS = ['administrator', 'manager'];
const ADMIN = ['administrator'];

// category -> label and the roles that may see it. An event may narrow this further with its own `audience`.
const CATEGORIES = {
    finance:    { label: 'Finance & Payments',      audience: OPS },
    bookings:   { label: 'Bookings & Enquiries',    audience: ALL },
    events:     { label: 'Events & Ticketing',      audience: OPS },
    calendar:   { label: 'Calendar & Scheduling',   audience: OPS },
    customer:   { label: 'Customer & Business Changes', audience: OPS },
    compliance: { label: 'Compliance & Expiry',     audience: OPS },
    system:     { label: 'Website & System',        audience: ADMIN },
    subscribers:{ label: 'Subscribers',             audience: ALL },
    email:      { label: 'Email & Communication',   audience: OPS },
    security:   { label: 'Users & Security',        audience: ADMIN }
};

const PRIORITIES = ['critical', 'high', 'medium', 'info'];
const PRIORITY_RANK = { critical: 0, high: 1, medium: 2, info: 3 };

const rand = (n) => 'R' + Number(n || 0).toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const s = (v, fallback = '') => (v === undefined || v === null || v === '' ? fallback : String(v));
const bookingLink = (p) => ({ section: 'bookingsAdmin', record: { type: 'booking', id: p.bookingId } });
const bookingEntity = (p) => ({ type: 'booking', id: p.bookingId });
const FIN_EFT = { section: 'financeAdmin', tab: 'finEft' };

// ── e-mail renderers ───────────────────────────────────────────────────────────────────────────────────────────────────────────────
// Each returns the fields lib/notify.js hands to emailComponents.renderSystemEmail. Wording is preserved from the legacy alert it replaces.
const EVENTS = {
    // ── Finance ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
    'finance.eft_proof_submitted': {
        category: 'finance', priority: 'high', kind: 'action', mandatory: true,
        dedupe: (p) => `eft:${p.submissionId}`,
        title: (p) => `EFT awaiting verification - booking #${p.bookingId}`,
        body: (p) => `${s(p.clientName, 'A client')} uploaded a proof of payment reporting ${rand(p.amount)}. It has NOT been credited - check it against the bank statement, then approve or reject it.`,
        entity: (p) => ({ type: 'eft_submission', id: p.submissionId }),
        link: (p) => ({ ...FIN_EFT, record: { type: 'eft_submission', id: p.submissionId } }),
        actions: [{ label: 'Review proof of payment', primary: true }],
        email: (p) => ({
            subject: `EFT proof awaiting review – Booking #${p.bookingId}`, titleOverride: 'EFT Proof Awaiting Review', trigger: 'Admin: EFT Proof Submitted',
            category: 'Payments & Invoices', severity: 'info', replyTo: p.clientEmail || null,
            lead: `A client uploaded a proof of payment for booking <strong style="color:#FAFAFA;">#${p.bookingId}</strong>. It is <strong style="color:#E8A83E;">awaiting review</strong> - nothing has been credited.`,
            cards: [{ rows: [
                { label: 'Client', value: s(p.clientName) },
                { label: 'Event', value: `${s(p.eventName)} on ${s(p.eventDate)}`, mono: false },
                { label: 'Amount reported', value: rand(p.amount), highlight: true },
                ...(p.reference ? [{ label: 'Client reference', value: s(p.reference) }] : [])
            ] }],
            bodyHtml: '<p style="margin:0; color:#E6E6E6;">Check the amount against the bank statement, then approve or reject it under <strong>Finance &rarr; EFT Payments</strong> in the admin panel.</p>'
        })
    },
    'finance.eft_approved': {
        category: 'finance', priority: 'info', kind: 'activity',
        title: (p) => `EFT approved - booking #${p.bookingId}, ${rand(p.amount)}`,
        entity: bookingEntity
    },
    'finance.eft_rejected': {
        category: 'finance', priority: 'medium', kind: 'activity',
        title: (p) => `EFT proof ${p.outcome === 'replacement_requested' ? 'sent back for a replacement' : 'rejected'} - booking #${p.bookingId}`,
        entity: bookingEntity
    },
    'finance.payment_received': {
        category: 'finance', priority: 'info', kind: 'activity',
        title: (p) => `Payment received - booking #${p.bookingId}, ${rand(p.amount)} (${s(p.method, 'online')})`,
        entity: bookingEntity
    },
    'finance.payment_failed': {
        category: 'finance', priority: 'high', kind: 'action', mandatory: true, legacyEmail: 'routes/public/payment.js status handler',
        dedupe: (p) => `payfail:${p.bookingId}`, reopen: true,
        title: (p) => `PayFast payment ${s(p.status, 'failed').toLowerCase()} - booking #${p.bookingId}`,
        body: (p) => `PayFast reported the payment as ${s(p.status, 'failed')}${p.amount ? ` (${rand(p.amount)})` : ''}. The client has been told; nothing was credited. Look at the transaction and follow up if they do not retry.`,
        entity: bookingEntity, link: bookingLink,
        actions: [{ label: 'Investigate booking', primary: true }],
        email: false
    },
    'finance.payment_pending_timeout': {
        category: 'finance', priority: 'high', kind: 'action', mandatory: true,
        dedupe: (p) => `paypending:${p.bookingId}`,
        title: (p) => `Payment still pending - booking #${p.bookingId}`,
        body: (p) => `The client was sent to PayFast over an hour ago and no payment notification has arrived${p.amount ? ` (${rand(p.amount)})` : ''}. Check PayFast before assuming it failed.`,
        entity: bookingEntity, link: bookingLink,
        actions: [{ label: 'Investigate booking', primary: true }],
        email: (p) => ({
            subject: `[PayFast] Payment still pending - booking #${p.bookingId}`, titleOverride: 'PayFast Pending Timeout', trigger: 'Admin: PayFast Pending Timeout',
            category: 'Payments & Invoices', severity: 'warning',
            lead: `The client was sent to PayFast over an hour ago for booking <strong style="color:#FAFAFA;">#${p.bookingId}</strong> and no payment notification has arrived.`,
            cards: [{ rows: [{ label: 'Client', value: s(p.clientName) }, { label: 'Amount', value: rand(p.amount), highlight: true }] }]
        })
    },
    'finance.itn_rejected': {
        category: 'finance', priority: 'high', kind: 'attention', mandatory: true,
        dedupe: (p) => `itn:${p.reason}`, reopen: true, escalate: [{ at: 10, priority: 'critical' }],
        title: (p) => `PayFast notification refused: ${s(p.reason).replace(/_/g, ' ')}`,
        body: (p) => `A PayFast payment notification was rejected (${s(p.reason).replace(/_/g, ' ')})${p.bookingId ? `, booking #${p.bookingId}` : ''}. If this keeps happening a genuine payment may not be recorded - check the PayFast settings and the payment log.`,
        entity: (p) => (p.bookingId ? bookingEntity(p) : null),
        link: () => ({ section: 'financeAdmin', tab: 'finReconciliation' }),
        actions: [{ label: 'Open reconciliation', primary: true }],
        email: true
    },
    'finance.payment_unmatched': {
        category: 'finance', priority: 'critical', kind: 'action', mandatory: true,
        dedupe: (p) => `unmatched:${s(p.gatewayPaymentId, p.bookingId)}`,
        title: (p) => `Payment received that matches no booking${p.bookingId ? ` (#${p.bookingId})` : ''}`,
        body: (p) => `PayFast says a payment${p.amount ? ` of ${rand(p.amount)}` : ''} was made, but it cannot be matched to a booking or invoice. The money may need to be allocated or refunded by hand.`,
        entity: (p) => ({ type: 'payment', id: s(p.gatewayPaymentId, p.bookingId) }),
        link: () => ({ section: 'financeAdmin', tab: 'finReconciliation' }),
        actions: [{ label: 'Open reconciliation', primary: true }],
        email: true
    },
    'finance.payment_amount_mismatch': {
        category: 'finance', priority: 'critical', kind: 'action', mandatory: true,
        dedupe: (p) => `mismatch:${s(p.gatewayPaymentId, p.bookingId)}`,
        title: (p) => `Payment amount does not match - booking #${p.bookingId}`,
        body: (p) => `PayFast reported ${rand(p.received)} but ${rand(p.expected)} was expected. It was NOT recorded automatically. Check the PayFast payment before taking any action.`,
        entity: bookingEntity, link: bookingLink,
        actions: [{ label: 'Investigate booking', primary: true }],
        email: true
    },
    'finance.payment_credit_failed': {
        category: 'finance', priority: 'critical', kind: 'action', mandatory: true, legacyEmail: 'routes/public/payment.js',
        dedupe: (p) => `creditfail:${p.bookingId}:${s(p.gatewayPaymentId)}`,
        title: (p) => `A verified payment could not be recorded - booking #${p.bookingId}`,
        body: (p) => `${s(p.detail, 'The payment was verified by PayFast but the system could not record it.')} The client has paid; the booking has not been updated.`,
        entity: bookingEntity, link: bookingLink,
        actions: [{ label: 'Investigate booking', primary: true }],
        email: false
    },
    'finance.payfast_recovered': {
        category: 'finance', priority: 'high', kind: 'attention', mandatory: true,
        dedupe: (p) => `pfrecovered:${p.key}`,
        title: (p) => `PayFast payment recovered - ${s(p.subject, 'booking')}`,
        body: (p) => `A payment PayFast received but whose notification never arrived was found by the safety net and recorded automatically (${rand(p.amount)}).`,
        entity: (p) => ({ type: 'payfast_payment', id: s(p.key) }),
        link: () => ({ section: 'financeAdmin', tab: 'finReconciliation' }),
        email: (p) => p.email || null
    },
    'finance.payfast_finding': {
        category: 'finance', priority: 'high', kind: 'action', mandatory: true,
        dedupe: (p) => `pffinding:${p.key}`,
        title: (p) => `PayFast payment needs your attention (${s(p.kindLabel, 'finding')})`,
        body: (p) => s(p.detail, 'The PayFast safety net found a payment it could not settle on its own.'),
        entity: (p) => ({ type: 'payfast_finding', id: s(p.key) }),
        link: () => ({ section: 'financeAdmin', tab: 'finReconciliation' }),
        actions: [{ label: 'Open reconciliation', primary: true }],
        email: (p) => p.email || null
    },
    'finance.payfast_safety_net_failure': {
        category: 'finance', priority: 'critical', kind: 'action', mandatory: true,
        dedupe: () => 'pfsafetynet', reopen: true,
        title: () => 'The PayFast safety net cannot reach PayFast',
        body: (p) => s(p.detail, 'The automatic check for payments PayFast received but never told us about is failing. Payments made in the meantime would not be picked up.'),
        entity: () => ({ type: 'integration', id: 'payfast' }),
        link: () => ({ section: 'financeAdmin', tab: 'finReconciliation' }),
        actions: [{ label: 'Open reconciliation', primary: true }],
        email: (p) => p.email || null
    },
    'finance.ledger_drift': {
        category: 'finance', priority: 'high', kind: 'action', mandatory: true,
        dedupe: () => 'ledgerdrift', reopen: true, refreshOnRepeat: true, countRepeats: false, refreshOnRepeat: true, countRepeats: false,
        title: (p) => `Ledger check: ${s(p.count, 'some')} booking(s) where recorded and actual payments differ`,
        body: (p) => s(p.detail, 'The nightly ledger check found bookings whose recorded amount paid does not match their transactions.'),
        entity: () => ({ type: 'ledger', id: 'drift' }),
        link: () => ({ section: 'financeAdmin', tab: 'finReconciliation' }),
        actions: [{ label: 'Open reconciliation', primary: true }],
        email: (p) => p.email || null
    },
    'finance.refund_recorded': {
        category: 'finance', priority: 'medium', kind: 'activity',
        title: (p) => `Refund recorded - booking #${p.bookingId}, ${rand(p.amount)}`,
        entity: bookingEntity
    },
    'finance.bank_details_changed': {
        category: 'finance', priority: 'high', kind: 'attention', mandatory: true, audience: ADMIN,
        dedupe: (p) => `bankchange:${p.version}`,
        title: () => 'Banking details were changed',
        body: (p) => `${s(p.actorLabel, 'An administrator')} changed the bank details clients pay into${p.fields ? ` (${s(p.fields)})` : ''}. If this was not you, act now.`,
        entity: () => ({ type: 'bank_details', id: 'eft' }),
        link: () => ({ section: 'paymentSetupAdmin', tab: 'payPanelBank' }),
        email: true
    },
    'finance.settings_changed': {
        category: 'finance', priority: 'high', kind: 'attention', mandatory: true, audience: ADMIN,
        dedupe: (p) => `finsettings:${s(p.area)}:${s(p.ref)}`,
        title: (p) => `Financial settings changed: ${s(p.area, 'settings')}`,
        body: (p) => `${s(p.actorLabel, 'An administrator')} changed ${s(p.area, 'financial settings')}${p.fields ? ` (${s(p.fields)})` : ''}. Credentials and amounts are not shown here.`,
        entity: (p) => ({ type: 'settings', id: s(p.area) }),
        link: () => ({ section: 'paymentSetupAdmin' }),
        email: true
    },

    // ── Events & ticketing ─────────────────────────────────────────────────────────────────────────────────────────────────────────
    'events.ticket_payment_mismatch': {
        category: 'events', priority: 'critical', kind: 'action', mandatory: true,
        dedupe: (p) => `tktmismatch:${p.orderId}`,
        title: (p) => `Ticket payment amount does not match - order #${p.orderId}`,
        body: (p) => s(p.detail, 'PayFast reported a different amount from the one expected for this ticket order. No tickets were issued.'),
        entity: (p) => ({ type: 'ticket_order', id: p.orderId }),
        link: (p) => ({ section: 'eventsAdmin', tab: 'evtPanelTickets', record: { type: 'ticket_order', id: p.orderId } }),
        actions: [{ label: 'View order', primary: true }],
        email: (p) => p.email || null
    },
    'events.ticket_paid_twice': {
        category: 'events', priority: 'high', kind: 'action', mandatory: true,
        dedupe: (p) => `tktdouble:${p.orderId}`,
        title: (p) => `Ticket order paid twice - order #${p.orderId}`,
        body: (p) => s(p.detail, 'A second payment arrived for a ticket order that was already paid. The extra payment needs refunding.'),
        entity: (p) => ({ type: 'ticket_order', id: p.orderId }),
        link: (p) => ({ section: 'eventsAdmin', tab: 'evtPanelTickets', record: { type: 'ticket_order', id: p.orderId } }),
        actions: [{ label: 'View order', primary: true }],
        email: (p) => p.email || null
    },
    'events.ticket_refund_required': {
        category: 'events', priority: 'high', kind: 'action', mandatory: true,
        dedupe: (p) => `tktrefund:${p.orderId}`,
        title: (p) => `Ticket refund required - order #${p.orderId}`,
        body: (p) => s(p.detail, 'A payment arrived for tickets that are no longer available (sold out or the hold expired). The buyer must be refunded.'),
        entity: (p) => ({ type: 'ticket_order', id: p.orderId }),
        link: (p) => ({ section: 'eventsAdmin', tab: 'evtPanelTickets', record: { type: 'ticket_order', id: p.orderId } }),
        actions: [{ label: 'View order', primary: true }],
        email: (p) => p.email || null
    },

    // ── Phase 2: overdue invoices (operations monitor; the daily overdue digest e-mail stays, so in-app only) ────────────────────────
    'finance.invoice_overdue': {
        category: 'finance', priority: 'high', kind: 'action', mandatory: true, refreshOnRepeat: true, countRepeats: false,
        dedupe: (p) => `invoverdue:${p.invoiceId}`,
        title: (p) => `Invoice ${s(p.invoiceNumber, '#' + p.invoiceId)} is overdue - ${s(p.clientName, 'booking #' + p.bookingId)}`,
        body: (p) => `${rand(p.amount)} was due on ${s(p.dueDate)} (${p.daysOverdue} day(s) ago). Follow up with the client or record the payment.`,
        entity: (p) => ({ type: 'invoice', id: p.invoiceId }),
        link: (p) => ({ section: 'bookingsAdmin', record: { type: 'booking', id: p.bookingId } }),
        actions: [{ label: 'View invoice', primary: true }],
        email: false, legacyEmail: 'lib/background-clerk.js overdue payment digest'
    },

    // ── Phase 2: bookings & enquiries ──────────────────────────────────────────────────────────────────────────────────────────────
    'bookings.request_received': {
        category: 'bookings', priority: 'medium', kind: 'action',
        dedupe: (p) => `bkreq:${p.bookingId}`,
        title: (p) => `New booking request #${p.bookingId} - ${s(p.clientName, 'a client')}`,
        body: (p) => `${s(p.eventName, 'An event')} on ${s(p.eventDate, 'a date to confirm')}${p.location ? ` at ${s(p.location)}` : ''}. Review it and send a quote.`,
        entity: bookingEntity, link: bookingLink,
        actions: [{ label: 'Review booking', primary: true }],
        email: false, legacyEmail: 'lib/booking-notifications.js sendBookingReceivedEmail (admin copy)'
    },
    'bookings.enquiry_received': {
        category: 'bookings', priority: 'medium', kind: 'action',
        dedupe: (p) => `inq:${p.inquiryId}`,
        title: (p) => `New enquiry from ${s(p.senderName, 'a visitor')}${p.subject ? `: ${s(p.subject)}` : ''}`,
        body: (p) => `${p.source === 'email' ? 'Arrived in the booking mailbox' : 'Sent through the website contact form'}${p.category ? ` (${s(p.category)})` : ''}. Reply from Inquiries.`,
        entity: (p) => ({ type: 'inquiry', id: p.inquiryId }),
        link: (p) => ({ section: 'inquiriesAdmin', record: { type: 'inquiry', id: p.inquiryId } }),
        actions: [{ label: 'Open enquiry', primary: true }],
        email: false, legacyEmail: 'lib/contact-intake.js admin notification'
    },
    'bookings.status_changed': {
        category: 'bookings', priority: 'info', kind: 'activity',
        title: (p) => `Booking #${p.bookingId}: ${s(p.from, '?')} → ${s(p.to)}${p.actorLabel ? ` (${s(p.actorLabel)})` : ''}`,
        entity: bookingEntity
    },
    'bookings.cancelled': {
        category: 'bookings', priority: 'high', kind: 'attention',
        dedupe: (p) => `bkcancel:${p.bookingId}`,
        title: (p) => `Booking #${p.bookingId} cancelled by ${p.by === 'client' ? 'the client' : s(p.actorLabel, 'an admin')}`,
        body: (p) => `${s(p.clientName)}${p.eventDate ? ` - ${s(p.eventDate)}` : ''}. ${p.reason ? `Reason: ${s(p.reason)}. ` : ''}${p.refundDue > 0 ? `A refund of ${rand(p.refundDue)} is due under the cancellation policy.` : 'No refund is due.'}`,
        entity: bookingEntity, link: bookingLink,
        actions: [{ label: 'View booking', primary: true }],
        email: false, legacyEmail: 'routes/public/bookings.js client cancellation e-mail'
    },
    'bookings.rescheduled': {
        category: 'bookings', priority: 'medium', kind: 'attention',
        dedupe: (p) => `bkresched:${p.bookingId}:${p.newDate}`,
        title: (p) => `Booking #${p.bookingId} moved to ${s(p.newDate)}`,
        body: (p) => `Was ${s(p.oldDate, 'not set')}${p.oldTime ? ` ${s(p.oldTime)}` : ''}, now ${s(p.newDate)}${p.newTime ? ` ${s(p.newTime)}` : ''}${p.source ? ` (${s(p.source)})` : ''}. The calendar and the client have been updated.`,
        entity: bookingEntity, link: bookingLink
    },
    'bookings.quote_accepted': {
        category: 'bookings', priority: 'medium', kind: 'attention',
        dedupe: (p) => `bkaccept:${p.bookingId}`,
        title: (p) => `Quote accepted - booking #${p.bookingId}, ${s(p.clientName)}`,
        body: (p) => `${p.invoiceGenerated ? 'The invoice was generated and e-mailed to the client.' : 'The invoice could NOT be generated automatically - create it from the booking.'} A draft contract is ready for review.`,
        entity: bookingEntity, link: bookingLink,
        email: false, legacyEmail: 'routes/public/bookings.js sendAdminQuoteAcceptedNotification'
    },
    'bookings.quote_expired': {
        category: 'bookings', priority: 'medium', kind: 'attention',
        dedupe: (p) => `bkqexp:${p.bookingId}`,
        title: (p) => `Quote expired - booking #${p.bookingId}, ${s(p.clientName)}`,
        body: () => 'The client did not accept the quote before it expired. Follow up or close the booking.',
        entity: bookingEntity, link: bookingLink
    },
    'bookings.request_expired': {
        category: 'bookings', priority: 'medium', kind: 'activity',
        title: (p) => `Booking request #${p.bookingId} expired after 48 hours without a quote`,
        entity: bookingEntity
    },
    'bookings.revision_requested': {
        category: 'bookings', priority: 'medium', kind: 'action',
        dedupe: (p) => `bkrev:${p.bookingId}`, reopen: true,
        title: (p) => `${p.requestType === 'extension' ? 'Quote extension' : 'Quote revision'} requested - booking #${p.bookingId}`,
        body: (p) => `${s(p.clientName)} asked: "${s(p.message)}". The quote's expiry was held open while you respond.`,
        entity: bookingEntity, link: bookingLink,
        actions: [{ label: 'Review booking', primary: true }],
        email: false, legacyEmail: 'routes/public/bookings.js quote revision e-mail'
    },
    'bookings.change_requested': {
        category: 'bookings', priority: 'medium', kind: 'action',
        dedupe: (p) => `bkchange:${p.bookingId}:${p.field}`, reopen: true,
        title: (p) => `Correction requested - ${s(p.fieldLabel, 'booking details')}, booking #${p.bookingId}`,
        body: (p) => `${s(p.clientName)} says it should be: "${s(p.details)}"${p.currently ? ` (currently: ${s(p.currently)})` : ''}.`,
        entity: bookingEntity, link: bookingLink,
        actions: [{ label: 'Review booking', primary: true }],
        email: false, legacyEmail: 'routes/public/bookings.js correction request e-mail'
    },
    'bookings.contract_signed': {
        category: 'bookings', priority: 'medium', kind: 'action',
        dedupe: (p) => `bksigned:${p.bookingId}`,
        title: (p) => `Contract signed by the client - booking #${p.bookingId}`,
        body: (p) => `${s(p.signatory, 'The client')} signed. Your countersignature is due.`,
        entity: bookingEntity, link: bookingLink,
        actions: [{ label: 'Countersign', primary: true }],
        email: false, legacyEmail: 'routes/public/bookings.js contract signed e-mail'
    },
    'bookings.payment_plan_changed': {
        category: 'bookings', priority: 'medium', kind: 'activity',
        title: (p) => `Payment plan changed by the client - booking #${p.bookingId}`,
        entity: bookingEntity
    },
    'bookings.invoice_issued': {
        category: 'bookings', priority: 'info', kind: 'activity',
        title: (p) => `Invoice ${s(p.invoiceNumber, '')} ${p.status === 'SENT' ? 'issued and e-mailed' : 'drafted'} - booking #${p.bookingId}, ${rand(p.amount)}`,
        entity: bookingEntity
    },
    'bookings.milestone_due': {
        category: 'bookings', priority: 'medium', kind: 'attention', refreshOnRepeat: true, countRepeats: false,
        dedupe: (p) => `milestone:${p.scheduleId}`,
        title: (p) => `${s(p.description, 'Payment')} of ${rand(p.amount)} due ${p.daysLeft === 0 ? 'today' : `in ${p.daysLeft} day(s)`} - booking #${p.bookingId}`,
        body: (p) => `${s(p.clientName)} - due ${s(p.dueDate)}. The client gets the automatic reminder; this is so you know it is coming.`,
        entity: (p) => ({ type: 'payment_schedule', id: p.scheduleId }),
        link: bookingLink
    },

    // ── Phase 2: customer details ──────────────────────────────────────────────────────────────────────────────────────────────────
    'customer.contact_changed': {
        category: 'customer', priority: 'medium', kind: 'attention',
        dedupe: (p) => `contact:${p.bookingId}`, reopen: true,
        title: (p) => `${p.by === 'client' ? 'Client' : s(p.actorLabel, 'An admin')} changed contact details - booking #${p.bookingId}`,
        body: (p) => `Changed: ${s(p.fields)}. The previous and new values are kept in the details (administrators).`,
        entity: bookingEntity, link: bookingLink
    },

    // ── Phase 2: events & ticketing ────────────────────────────────────────────────────────────────────────────────────────────────
    'events.created': {
        category: 'events', priority: 'info', kind: 'activity',
        title: (p) => `Event created: ${s(p.title)} (${s(p.status, 'draft')})`,
        entity: (p) => ({ type: 'event', id: p.eventId })
    },
    'events.updated': {
        category: 'events', priority: 'info', kind: 'activity',
        title: (p) => `Event ${p.published ? 'published' : 'edited'}: ${s(p.title)}`,
        entity: (p) => ({ type: 'event', id: p.eventId })
    },
    'events.cancelled': {
        category: 'events', priority: 'high', kind: 'attention',
        dedupe: (p) => `evcancel:${p.eventId}:${p.status}`,
        title: (p) => `Event ${p.status === 'postponed' ? 'postponed' : 'cancelled'}: ${s(p.title)}`,
        body: (p) => `${p.reason ? `Reason: ${s(p.reason)}. ` : ''}Ticket sales were closed.${p.paidOrders ? ` ${p.paidOrders} paid ticket order(s) need a decision (refund or move) - nothing was refunded automatically.` : ''}`,
        entity: (p) => ({ type: 'event', id: p.eventId }),
        link: () => ({ section: 'eventsAdmin', tab: 'evtPanelTickets' }),
        actions: [{ label: 'View ticket orders', primary: true }]
    },
    'events.ticket_orders': {
        category: 'events', priority: 'medium', kind: 'attention',
        dedupe: (p) => `tktorders:${p.eventId}:${p.day}`,
        title: (p) => `New ticket orders today - ${s(p.eventTitle, 'event #' + p.eventId)}`,
        body: (p) => `Latest: order #${p.orderId}, ${s(p.buyerName, 'a buyer')}, ${rand(p.amount)}. Each new paid order today adds to the count.`,
        entity: (p) => ({ type: 'event', id: p.eventId }),
        link: () => ({ section: 'eventsAdmin', tab: 'evtPanelTickets' })
    },
    'events.low_stock': {
        category: 'events', priority: 'high', kind: 'attention', refreshOnRepeat: true, countRepeats: false,
        dedupe: (p) => `lowstock:${p.tierId}`,
        title: (p) => `Only ${p.remaining} ${s(p.tierName)} ticket(s) left - ${s(p.eventTitle)}`,
        body: (p) => `${p.sold} sold of ${p.capacity}. Your low-stock alert is set at ${p.threshold}. Add capacity or another tier if demand continues.`,
        entity: (p) => ({ type: 'ticket_type', id: p.tierId }),
        link: () => ({ section: 'eventsAdmin', tab: 'evtPanelTickets' })
    },
    'events.sold_out': {
        category: 'events', priority: 'medium', kind: 'attention',
        dedupe: (p) => `soldout:${p.eventId}`,
        title: (p) => `Sold out: ${s(p.eventTitle)}`,
        body: (p) => `Every active ticket tier is sold out (${p.sold} tickets).`,
        entity: (p) => ({ type: 'event', id: p.eventId }),
        link: () => ({ section: 'eventsAdmin', tab: 'evtPanelTickets' })
    },
    'events.sales_closing': {
        category: 'events', priority: 'medium', kind: 'attention', refreshOnRepeat: true, countRepeats: false,
        dedupe: (p) => `salesclose:${p.tierId}`,
        title: (p) => `${s(p.tierName)} ticket sales close ${p.hoursLeft <= 24 ? 'within 24 hours' : 'within 48 hours'} - ${s(p.eventTitle)}`,
        body: (p) => `Sales end ${s(p.salesEnd)}; ${p.remaining} ticket(s) still available.`,
        entity: (p) => ({ type: 'ticket_type', id: p.tierId }),
        link: () => ({ section: 'eventsAdmin', tab: 'evtPanelTickets' })
    },
    'events.upcoming': {
        category: 'events', priority: 'medium', kind: 'attention', refreshOnRepeat: true, countRepeats: false,
        dedupe: (p) => `evsoon:${p.eventId}`,
        title: (p) => `${s(p.title)} is ${p.daysLeft === 0 ? 'today' : p.daysLeft === 1 ? 'tomorrow' : `in ${p.daysLeft} days`}`,
        body: (p) => `${s(p.date)}${p.venue ? ` at ${s(p.venue)}` : ''}.${p.ticketsSold ? ` ${p.ticketsSold} ticket(s) sold.` : ''}`,
        entity: (p) => ({ type: 'event', id: p.eventId }),
        link: () => ({ section: 'eventsAdmin' })
    },
    'events.checkin': {
        category: 'events', priority: 'info', kind: 'activity',
        title: (p) => `Ticket checked in - ${s(p.eventTitle, 'event #' + p.eventId)} (${s(p.via, 'admin scanner')})`,
        entity: (p) => ({ type: 'ticket', id: p.ticketId })
    },
    'events.checkin_duplicate': {
        category: 'events', priority: 'medium', kind: 'attention',
        dedupe: (p) => `dupscan:${p.eventId}`, escalate: [{ at: 10, priority: 'high' }],
        title: (p) => `Already-used tickets scanned again - ${s(p.eventTitle, 'event #' + p.eventId)}`,
        body: (p) => `A ticket was presented after it had already been checked in (latest at ${s(p.via, 'the door')}). Repeats are counted here - many in a row can mean a shared or copied QR code.`,
        entity: (p) => ({ type: 'event', id: p.eventId }),
        link: () => ({ section: 'eventsAdmin', tab: 'evtPanelTickets' })
    },
    'events.checkin_void': {
        category: 'events', priority: 'medium', kind: 'attention',
        dedupe: (p) => `voidscan:${p.eventId}`, escalate: [{ at: 5, priority: 'high' }],
        title: (p) => `Cancelled / refunded tickets presented at the door - ${s(p.eventTitle, 'event #' + p.eventId)}`,
        body: (p) => `A ticket that is no longer valid (refunded, reissued or voided) was scanned (latest at ${s(p.via, 'the door')}). It was refused.`,
        entity: (p) => ({ type: 'event', id: p.eventId }),
        link: () => ({ section: 'eventsAdmin', tab: 'evtPanelTickets' })
    },

    // ── Phase 2: calendar ──────────────────────────────────────────────────────────────────────────────────────────────────────────
    'calendar.sync_failed': {
        category: 'calendar', priority: 'high', kind: 'attention',
        dedupe: (p) => `calfail:${p.provider}:${p.kind}`, reopen: true, escalate: [{ at: 10, priority: 'critical' }],
        title: (p) => `${p.provider === 'google' ? 'Google Calendar' : 'Microsoft 365 calendar'} sync failing (${s(p.kind)})`,
        body: (p) => `${p.failures} attempt(s) in a row failed: ${s(p.error, 'unknown error')}. Last successful sync: ${s(p.lastOk, 'never')}. Bookings may be missing from, or out of date in, the calendar.`,
        entity: (p) => ({ type: 'integration', id: `calendar-${p.provider}` }),
        link: (p) => ({ section: p.provider === 'google' ? 'integrationsAdmin' : 'calendarAdmin' }),
        actions: [{ label: 'Review synchronisation', primary: true }]
    },
    'calendar.item_failed': {
        category: 'calendar', priority: 'medium', kind: 'attention',
        dedupe: (p) => `calitem:${p.provider}`, reopen: true,
        title: (p) => `Some entries are not reaching the ${p.provider === 'google' ? 'Google' : 'Microsoft 365'} calendar`,
        body: (p) => `Latest: ${s(p.sourceType)} #${s(p.sourceId)} failed ${p.attempts} time(s): ${s(p.error)}. It is retried automatically.`,
        entity: (p) => ({ type: 'integration', id: `calendar-${p.provider}` }),
        link: () => ({ section: 'calendarAdmin' })
    },
    'calendar.conflict': {
        category: 'calendar', priority: 'medium', kind: 'action',
        dedupe: (p) => `calconflict:${p.linkId}`, reopen: true,
        title: (p) => `Calendar conflict: ${s(p.sourceType)} #${s(p.sourceId)} was changed in Microsoft 365`,
        body: () => 'Someone edited this entry in Outlook, so the website and the calendar disagree. Nothing was changed automatically - choose which version to keep.',
        entity: (p) => ({ type: 'calendar_link', id: p.linkId }),
        link: () => ({ section: 'calendarAdmin' }),
        actions: [{ label: 'Review synchronisation', primary: true }]
    },
    'calendar.external_deleted': {
        category: 'calendar', priority: 'high', kind: 'attention',
        dedupe: (p) => `caldeleted:${p.linkId}`,
        title: (p) => `${s(p.sourceType)} #${s(p.sourceId)} was deleted from the Microsoft 365 calendar`,
        body: () => 'It still exists on the website but is now missing from the shared calendar. Check whether it was deleted on purpose.',
        entity: (p) => ({ type: 'calendar_link', id: p.linkId }),
        link: () => ({ section: 'calendarAdmin' })
    },

    // ── Phase 2: e-mail & inbox ────────────────────────────────────────────────────────────────────────────────────────────────────
    'email.inbox_sync_failed': {
        category: 'email', priority: 'high', kind: 'attention',
        dedupe: () => 'inboxsync', reopen: true, escalate: [{ at: 10, priority: 'critical' }],
        title: () => 'Customer replies are not being collected from the mailbox',
        body: (p) => `${p.failures} attempt(s) in a row failed: ${s(p.error, 'unknown error')}. Last success: ${s(p.lastOk, 'never')}. Customer replies may be waiting unseen in Outlook.`,
        entity: () => ({ type: 'integration', id: 'inbox-sync' }),
        link: () => ({ section: 'inquiriesAdmin' })
    },
    'email.reply_bounced': {
        category: 'email', priority: 'medium', kind: 'attention',
        dedupe: (p) => `bounce:${p.inquiryId}`,
        title: (p) => `A reply could not be delivered - enquiry #${p.inquiryId}`,
        body: (p) => `The customer's mail server returned it: ${s(p.reason)}. Check the address or contact them another way.`,
        entity: (p) => ({ type: 'inquiry', id: p.inquiryId }),
        link: (p) => ({ section: 'inquiriesAdmin', record: { type: 'inquiry', id: p.inquiryId } }),
        actions: [{ label: 'Open enquiry', primary: true }],
        email: false
    },

    // ── Phase 3: subscribers (grouped per day - a busy day is one item with a count, not fifty) ─────────────────────────────────────
    'subscribers.signed_up': {
        category: 'subscribers', priority: 'info', kind: 'activity',
        title: (p) => `Newsletter sign-up waiting for confirmation: ${s(p.firstName, 'a visitor')} (${s(p.maskedEmail)})`,
        entity: (p) => ({ type: 'subscriber', id: p.subscriberId })
    },
    'subscribers.confirmed': {
        category: 'subscribers', priority: 'medium', kind: 'attention',
        dedupe: (p) => `subsnew:${p.day}`,
        title: () => 'New newsletter subscribers today',
        body: (p) => `Latest: ${s(p.firstName, 'a subscriber')} (${s(p.maskedEmail)}) confirmed their subscription. Each confirmation today adds to the count.`,
        entity: (p) => ({ type: 'subscriber_day', id: p.day }),
        link: () => ({ section: 'newsletterAdmin' }),
        actions: [{ label: 'View subscribers', primary: true }]
    },
    'subscribers.unsubscribed': {
        category: 'subscribers', priority: 'info', kind: 'attention',
        dedupe: (p) => `subsgone:${p.day}`,
        title: () => 'Newsletter unsubscribes today',
        body: (p) => `Latest: ${s(p.maskedEmail)}. Each unsubscribe today adds to the count.`,
        entity: (p) => ({ type: 'subscriber_day', id: p.day }),
        link: () => ({ section: 'newsletterAdmin' })
    },
    'subscribers.confirmation_failed': {
        category: 'subscribers', priority: 'medium', kind: 'attention',
        dedupe: () => 'subsconfirmfail', reopen: true,
        title: () => 'Newsletter confirmation e-mails are not going out',
        body: (p) => `The confirmation e-mail to ${s(p.maskedEmail)} could not be queued: ${s(p.error, 'unknown error')}. New sign-ups cannot complete until e-mail works.`,
        entity: () => ({ type: 'integration', id: 'newsletter-confirm' }),
        link: () => ({ section: 'emailLogsAdmin' }),
        email: false
    },

    // ── Phase 3: users & security (administrators only; all mandatory) ─────────────────────────────────────────────────────────────
    'security.user_created': {
        category: 'security', priority: 'high', kind: 'attention', mandatory: true,
        dedupe: (p) => `usernew:${p.userId}`,
        title: (p) => `New ${s(p.role, 'staff')} account created: ${s(p.name, 'user #' + p.userId)}`,
        body: (p) => `${s(p.actorLabel, 'An administrator')} created it and an invitation was sent. If you did not expect this, check Users now.`,
        entity: (p) => ({ type: 'admin_user', id: p.userId }),
        link: () => ({ section: 'usersAdmin' }),
        actions: [{ label: 'Open users', primary: true }]
    },
    'security.user_changed': {
        category: 'security', priority: 'high', kind: 'attention', mandatory: true,
        dedupe: (p) => `userchg:${p.userId}:${p.change}`, reopen: true,
        title: (p) => (p.change === 'disabled' ? `Account suspended: ${s(p.name)}` : p.change === 'enabled' ? `Account re-activated: ${s(p.name)}`
            : p.change === 'deleted' ? `Account deleted: ${s(p.name)}` : `Role changed: ${s(p.name)} is now ${s(p.newRole)}`),
        body: (p) => `${s(p.actorLabel, 'An administrator')} made this change${p.oldRole && p.newRole && p.oldRole !== p.newRole ? ` (was ${s(p.oldRole)})` : ''}.`,
        entity: (p) => ({ type: 'admin_user', id: p.userId }),
        link: () => ({ section: 'usersAdmin' }),
        actions: [{ label: 'Open users', primary: true }]
    },
    'security.login_failed': {
        category: 'security', priority: 'info', kind: 'activity',
        title: (p) => `Failed sign-in for ${s(p.account, 'an unknown account')}${p.reason ? ` (${s(p.reason)})` : ''}`,
        entity: (p) => ({ type: 'login', id: s(p.account, 'unknown') })
    },
    'security.login_failed_repeated': {
        category: 'security', priority: 'high', kind: 'attention', mandatory: true,
        dedupe: (p) => `loginfail:${s(p.account, 'unknown')}`, reopen: true, escalate: [{ at: 4, priority: 'critical' }],
        title: (p) => `Repeated failed sign-ins for ${s(p.account, 'an unknown account')}`,
        body: (p) => `${p.recent} failed attempts in the last 15 minutes${p.ip ? ` (latest from ${s(p.ip)})` : ''}. If this was not you or your staff, someone may be guessing the password.`,
        entity: (p) => ({ type: 'login', id: s(p.account, 'unknown') }),
        link: () => ({ section: 'usersAdmin' }),
        actions: [{ label: 'Open users', primary: true }]
    },
    'security.login_locked': {
        category: 'security', priority: 'high', kind: 'attention', mandatory: true,
        dedupe: (p) => `loginlock:${s(p.ip)}`, reopen: true,
        title: () => 'Sign-in temporarily blocked after too many failed attempts',
        body: (p) => `The address ${s(p.ip, 'unknown')} was blocked for 10 minutes after 5 failed sign-ins${p.account ? ` (last tried: ${s(p.account)})` : ''}.`,
        entity: (p) => ({ type: 'login_ip', id: s(p.ip) }),
        link: () => ({ section: 'securityAdmin', tab: 'secPanelAudit' })
    },
    'security.integration_changed': {
        category: 'security', priority: 'high', kind: 'attention', mandatory: true,
        dedupe: (p) => `integ:${p.integration}:${p.change}`, reopen: true,
        title: (p) => `${s(p.label, p.integration)} ${s(p.change)}`,
        body: (p) => `${s(p.actorLabel, 'An administrator')} ${s(p.change)} the ${s(p.label, p.integration)} connection${p.detail ? ` (${s(p.detail)})` : ''}. Credentials are never shown here.`,
        entity: (p) => ({ type: 'integration', id: p.integration }),
        link: (p) => ({ section: p.integration === 'smtp' || p.integration === 'inbox-sync' ? 'inquiriesAdmin' : p.integration === 'm365-calendar' ? 'calendarAdmin' : 'integrationsAdmin' })
    },

    // ── Phase 3: business information ──────────────────────────────────────────────────────────────────────────────────────────────
    'customer.business_changed': {
        category: 'customer', priority: 'medium', kind: 'attention', audience: ADMIN,
        dedupe: (p) => `biz:${p.version}`,
        title: () => 'Business profile updated',
        body: (p) => `${s(p.actorLabel, 'An administrator')} changed: ${s(p.fields)}. Previous and new values are in the details.`,
        entity: () => ({ type: 'business_profile', id: '1' }),
        link: () => ({ section: 'businessAdmin' })
    },
    // trading / registered name, tax or VAT registration: what every future quotation and invoice says and charges
    'customer.registration_changed': {
        category: 'customer', priority: 'high', kind: 'attention', audience: ADMIN, mandatory: true,
        dedupe: (p) => `bizreg:${p.version}`,
        title: (p) => `Registered business details changed: ${s(p.registrationLabels)}`,
        body: (p) => `${s(p.actorLabel, 'An administrator')} changed: ${s(p.fields)}. Future quotations and invoices use the new details; documents already issued are unchanged. Previous and new values are in the details.`,
        entity: () => ({ type: 'business_profile', id: '1' }),
        link: () => ({ section: 'businessAdmin' })
    },

    // ── Compliance ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────
    // One incident per (item, expiry date). Each reminder stage REFRESHES it (title / priority / days left) rather than adding a row.
    'compliance.expiring': {
        category: 'compliance', priority: 'high', kind: 'attention', mandatory: true, refreshOnRepeat: true, countRepeats: false, emailOnlyWhenAsked: true,
        dedupe: (p) => `expiry:${p.itemKey}:${p.expiryDate}`,
        title: (p) => (p.daysLeft < 0 ? `${p.name} EXPIRED ${Math.abs(p.daysLeft)} day(s) ago`
            : p.daysLeft === 0 ? `${p.name} expires TODAY`
            : `${p.name} expires in ${p.daysLeft} day(s)`),
        body: (p) => `${p.name}${p.reference ? ` (${p.reference})` : ''} ${p.daysLeft < 0 ? 'expired' : 'expires'} on ${p.expiryDate}. ${p.daysLeft < 0 ? 'Renew it and record the new date to clear this alert.' : 'Renew it in good time and record the new date.'}`,
        entity: (p) => ({ type: 'compliance', id: p.itemKey }),
        link: (p) => p.link || { section: 'businessAdmin' },
        actions: [{ label: 'View document', primary: true }],
        email: (p) => ({
            subject: `[Compliance] ${p.name} ${p.daysLeft < 0 ? 'has expired' : p.daysLeft === 0 ? 'expires today' : `expires in ${p.daysLeft} day(s)`}`,
            titleOverride: 'Compliance Expiry', trigger: 'Admin: Compliance Expiry', category: 'Compliance',
            severity: p.daysLeft <= 7 ? 'alert' : 'warning',
            lead: `<strong style="color:#FAFAFA;">${p.name}</strong> ${p.daysLeft < 0 ? 'expired' : 'expires'} on <strong style="color:#E8A83E;">${p.expiryDate}</strong>.`,
            cards: [{ rows: [{ label: 'Item', value: s(p.name) }, ...(p.reference ? [{ label: 'Reference', value: s(p.reference) }] : []), { label: 'Expiry date', value: s(p.expiryDate), highlight: true }, { label: 'Days left', value: String(p.daysLeft) }] }]
        })
    },

    // ── System health ──────────────────────────────────────────────────────────────────────────────────────────────────────────────
    'system.job_failed': {
        category: 'system', priority: 'high', kind: 'attention', mandatory: true,
        dedupe: (p) => `jobfail:${p.job}`, reopen: true, escalate: [{ at: 5, priority: 'critical' }],
        title: (p) => `Background task failing: ${p.label || p.job}`,
        body: (p) => `The scheduled task "${p.label || p.job}" failed${p.failures > 1 ? ` ${p.failures} times in a row` : ''}. Last error: ${s(p.error, 'unknown')}. Ref ${s(p.job)}.`,
        entity: (p) => ({ type: 'job', id: p.job }),
        link: () => ({ section: 'securityAdmin', tab: 'secPanelIntegrity' }),
        actions: [{ label: 'Open system health', primary: true }],
        email: true
    },
    'system.job_missed': {
        category: 'system', priority: 'high', kind: 'action', mandatory: true,
        dedupe: (p) => `jobmissed:${p.job}`, reopen: true,
        title: (p) => `Background task has stopped running: ${p.label || p.job}`,
        body: (p) => `"${p.label || p.job}" should run about every ${s(p.expectedMinutes)} minute(s) but last ran ${s(p.lastRunAgo, 'a long time ago')}. The site may need a restart.`,
        entity: (p) => ({ type: 'job', id: p.job }),
        link: () => ({ section: 'securityAdmin', tab: 'secPanelIntegrity' }),
        actions: [{ label: 'Open system health', primary: true }],
        email: true
    },
    'system.server_error': {
        category: 'system', priority: 'high', kind: 'attention', mandatory: true,
        dedupe: (p) => `srverr:${p.fingerprint}`, reopen: true, escalate: [{ at: 10, priority: 'critical' }],
        title: (p) => `Server error on ${s(p.route, 'the website')}`,
        body: (p) => `${s(p.method)} ${s(p.route)} returned an error (${s(p.errorClass, 'Error')}): ${s(p.message, 'no message')}. Reference ${s(p.fingerprint)}. Recommended: open the Delivery/Security logs, then check the matching record.`,
        entity: (p) => ({ type: 'error', id: s(p.fingerprint) }),
        link: () => ({ section: 'securityAdmin', tab: 'secPanelIntegrity' }),
        actions: [{ label: 'Open error details', primary: true }],
        email: true
    },
    'system.client_error': {
        category: 'system', priority: 'medium', kind: 'attention',
        dedupe: (p) => `clierr:${p.fingerprint}`, reopen: true, escalate: [{ at: 25, priority: 'high' }],
        title: (p) => `Browser error on ${s(p.page, 'the admin portal')}`,
        body: (p) => `${s(p.message, 'A script error occurred')}${p.source ? ` (${s(p.source)})` : ''}. Reference ${s(p.fingerprint)}.`,
        entity: (p) => ({ type: 'error', id: s(p.fingerprint) }),
        link: () => ({ section: 'securityAdmin', tab: 'secPanelIntegrity' }),
        email: false
    },
    'system.crash': {
        category: 'system', priority: 'critical', kind: 'action', mandatory: true,
        dedupe: (p) => `crash:${p.fingerprint}`, reopen: true,
        title: () => 'The website server crashed and restarted',
        body: (p) => `An unhandled ${s(p.errorClass, 'error')} stopped the server: ${s(p.message, 'no message')}. Ref ${s(p.fingerprint)}.`,
        entity: (p) => ({ type: 'error', id: s(p.fingerprint) }),
        link: () => ({ section: 'securityAdmin', tab: 'secPanelIntegrity' }),
        actions: [{ label: 'Open error details', primary: true }],
        email: true
    },
    'system.email_queue_stuck': {
        category: 'system', priority: 'critical', kind: 'action', mandatory: true, legacyEmail: 'lib/background-clerk.js checkStuckNotifications (direct send: the queue is what is stuck)',
        dedupe: () => 'emailqueue', reopen: true,
        title: (p) => `${s(p.count, 'Some')} email(s) stuck in the queue`,
        body: () => 'Emails have been waiting more than 10 minutes to send. Check the email connection under Inquiries → Setup.',
        entity: () => ({ type: 'integration', id: 'email' }),
        link: () => ({ section: 'emailLogsAdmin' }),
        actions: [{ label: 'View delivery log', primary: true }],
        email: false
    },
    'email.send_failed': {
        category: 'email', priority: 'high', kind: 'attention', mandatory: true,
        dedupe: (p) => `mailfail:${s(p.trigger, 'email')}`, reopen: true, escalate: [{ at: 5, priority: 'critical' }],
        title: (p) => `Email could not be sent: ${s(p.trigger, 'email')}`,
        body: (p) => `An email (${s(p.trigger, 'email')}) failed permanently after retries${p.error ? `: ${s(p.error)}` : ''}. The recipient did not get it.`,
        entity: (p) => ({ type: 'email', id: s(p.trigger, 'email') }),
        link: () => ({ section: 'emailLogsAdmin' }),
        actions: [{ label: 'View email error', primary: true }],
        email: false   // the mail system is the thing that is broken - never depend on it to say so
    }
};

function get(eventKey) { return EVENTS[eventKey] || null; }
function categoryOf(eventKey) { const e = EVENTS[eventKey]; return e ? e.category : null; }
function audienceOf(eventKey) { const e = EVENTS[eventKey]; return e ? (e.audience || (CATEGORIES[e.category] || {}).audience || ADMIN) : ADMIN; }
function categoriesFor(role) { return Object.keys(CATEGORIES).filter((c) => CATEGORIES[c].audience.indexOf(role) >= 0); }
function eventsFor(role) { return Object.keys(EVENTS).filter((k) => audienceOf(k).indexOf(role) >= 0); }

module.exports = { EVENTS, CATEGORIES, PRIORITIES, PRIORITY_RANK, ALL, OPS, ADMIN, get, categoryOf, audienceOf, categoriesFor, eventsFor };
