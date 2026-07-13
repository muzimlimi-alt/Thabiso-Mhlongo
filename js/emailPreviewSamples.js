/**
 * Thabiso Mhlongo — Banner Preview Sample Data (Prompt 6, Batch 3)
 * =============================================================
 * One generic sample body per banner category, used only by the admin Banner Management Centre's
 * live preview (GET /api/admin/email-templates/:key/preview). Deliberately NOT the real per-template
 * production copy — js/generate-email-previews.js already owns that (filename-keyed, immediately
 * rendered to static files for the Prompt 3/4 checkpoint) and refactoring it to expose reusable
 * per-key prop objects is out of scope for this MVP. This is just enough sample content to show an
 * admin how their assigned banner (or the text-headline fallback, if unassigned/archived) looks in
 * context at the top of a real PREMIUM email shell.
 */
'use strict';

const SAMPLES_BY_CATEGORY = {
    'Booking Requests': {
        headline: 'Your Booking Request',
        greeting: 'Hi Naledi,',
        bodyHtml: 'This is a preview of how the <strong style="color:#D4AF37;">Booking Requests</strong> category\'s banner appears at the top of an email — for example, a booking receipt or an under-review notice.',
        cta: { label: 'Track Your Booking', url: '#' }
    },
    'Quotes & Proposals': {
        headline: 'Your Quotation',
        greeting: 'Hi Naledi,',
        bodyHtml: 'This is a preview of how the <strong style="color:#D4AF37;">Quotes &amp; Proposals</strong> category\'s banner appears — for example, a new quote or a quote-accepted receipt.',
        cards: [{ title: 'Sample Quote', rows: [{ label: 'Total Quote', value: 'R 4,500.00', highlight: true }] }],
        cta: { label: 'Review & Accept Quote', url: '#' }
    },
    'Contracts & Signatures': {
        headline: 'Your Booking Contract',
        greeting: 'Hi Naledi,',
        bodyHtml: 'This is a preview of how the <strong style="color:#D4AF37;">Contracts &amp; Signatures</strong> category\'s banner appears — for example, a contract-ready or signature-reminder email.',
        cta: { label: 'Review & Sign Contract', url: '#' }
    },
    'Payments & Invoices': {
        headline: 'Your Invoice',
        greeting: 'Hi Naledi,',
        bodyHtml: 'This is a preview of how the <strong style="color:#D4AF37;">Payments &amp; Invoices</strong> category\'s banner appears — for example, an invoice, payment reminder, or receipt.',
        cards: [{ title: 'Sample Invoice', rows: [{ label: 'Amount Due', value: 'R 2,250.00', highlight: true }] }],
        cta: { label: 'Pay Now', url: '#' }
    },
    'Booking Confirmations': {
        headline: 'Your Booking Is Confirmed',
        greeting: 'Hi Naledi,',
        bodyHtml: 'This is a preview of how the <strong style="color:#D4AF37;">Booking Confirmations</strong> category\'s banner appears — for example, a final confirmation or a cancellation/date-change notice.',
        cards: [{ title: 'Sample Booking', rows: [{ label: 'Event', value: 'Corporate Year-End', mono: false }, { label: 'Date', value: 'Sat, 14 Aug 2026' }] }],
        cta: { label: 'View Your Booking', url: '#' }
    },
    'Event Reminders': {
        headline: 'Your Event Is Coming Up',
        greeting: 'Hi Naledi,',
        bodyHtml: 'This is a preview of how the <strong style="color:#D4AF37;">Event Reminders</strong> category\'s banner appears. No live template uses this category yet — it is reserved for future reminders.',
        cta: { label: 'View Your Booking', url: '#' }
    },
    'Thank You & Reviews': {
        headline: 'Thank You!',
        greeting: 'Hi Naledi,',
        bodyHtml: 'This is a preview of how the <strong style="color:#D4AF37;">Thank You &amp; Reviews</strong> category\'s banner appears — for example, a completion thank-you or a review request.',
        cta: { label: 'Send Your Review', url: '#' }
    },
    'Booking Recovery': {
        headline: 'Finish Your Booking Request',
        greeting: 'Hi there,',
        bodyHtml: 'This is a preview of how the <strong style="color:#D4AF37;">Booking Recovery</strong> category\'s banner appears — the reminder sent to visitors who started but didn\'t finish a booking request.',
        cta: { label: 'Resume My Booking', url: '#' }
    },
    'Contact & Support': {
        headline: "We've Received Your Message",
        greeting: 'Hi Naledi,',
        bodyHtml: 'This is a preview of how the <strong style="color:#D4AF37;">Contact &amp; Support</strong> category\'s banner appears — for example, a contact-form receipt or a management reply.'
    },
    'Newsletters & Marketing': {
        headline: "You're On The List!",
        bodyHtml: 'This is a preview of how the <strong style="color:#D4AF37;">Newsletters &amp; Marketing</strong> category\'s banner appears at the top of a newsletter welcome or campaign email.'
    },
    'User Accounts & Security': {
        headline: 'Account Notice',
        greeting: 'Hi Admin,',
        bodyHtml: 'This is a preview of how the <strong style="color:#D4AF37;">User Accounts &amp; Security</strong> category\'s banner would appear. In practice, this category\'s templates (dashboard invite, password reset) are SYSTEM-track emails, which use a compact text header and never a photographic banner.'
    }
};

module.exports = { SAMPLES_BY_CATEGORY };
