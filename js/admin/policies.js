/* Phase 6 (HOUSEKEEPING-NOTES.md): relocated from admin.html verbatim — the narrow "Booking
   Policies" tab only (loadPolicies/savePolicies: deposit %, quote validity, payment terms,
   cancellation policy, reminder days, inquiry SLA). This is distinct from the much larger
   "Legal & Compliance Centre" module (Privacy Policy/Terms/Cookie & Consent/Consent Audit/
   Contract Registry/Version History tabs) that immediately follows in admin.html — that
   module was NOT touched and remains in admin.html. Both functions were already
   window-attached in the original source. */

// ─── Policies ───
window.loadPolicies = async function() {
    try {
        const r = await apiCall('/api/admin/policies');
        if (r && r.policies) {
            const p = r.policies;
            if (p.deposit_percentage !== undefined) $('#polDeposit').val(p.deposit_percentage);
            if (p.quote_validity_days !== undefined) $('#polQuoteValidity').val(p.quote_validity_days);
            if (p.payment_terms) $('#polPaymentTerms').val(p.payment_terms);
            if (p.cancellation_policy) $('#polCancellation').val(p.cancellation_policy);
            if (p.reminder_days_1 !== undefined) $('#polReminderDays1').val(p.reminder_days_1);
            if (p.reminder_days_2 !== undefined) $('#polReminderDays2').val(p.reminder_days_2);
            if (p.inquiry_response_sla_hours !== undefined) $('#polInquirySlaHours').val(p.inquiry_response_sla_hours);
        }
    } catch(e) {
        console.error('Failed to load policies:', e);
        window.notificationService.showError('Could not load booking policies — please refresh.');
    }
};

window.savePolicies = async function() {
    // Validate before sending — these values feed the Quote Builder / invoice PDFs directly.
    const deposit       = parseFloat($('#polDeposit').val());
    const quoteValidity = parseInt($('#polQuoteValidity').val(), 10);
    const rem1          = parseInt($('#polReminderDays1').val(), 10);
    const rem2          = parseInt($('#polReminderDays2').val(), 10);
    if ($('#polDeposit').val() === '' || isNaN(deposit) || deposit < 0 || deposit > 100) {
        window.notificationService.showError('Deposit percentage must be a number between 0 and 100.');
        return;
    }
    if ($('#polQuoteValidity').val() === '' || isNaN(quoteValidity) || quoteValidity < 1) {
        window.notificationService.showError('Quote validity must be at least 1 day.');
        return;
    }
    if (!$('#polPaymentTerms').val().trim()) {
        window.notificationService.showError('Payment Terms are required.');
        return;
    }
    if (!isNaN(rem1) && !isNaN(rem2) && rem1 <= rem2) {
        window.notificationService.showError('First reminder must be more days before the due date than the final reminder (e.g. 7 days vs 2 days).');
        return;
    }
    const policies = {
        deposit_percentage: $('#polDeposit').val(),
        quote_validity_days: $('#polQuoteValidity').val(),
        payment_terms: $('#polPaymentTerms').val(),
        cancellation_policy: $('#polCancellation').val(),
        reminder_days_1: $('#polReminderDays1').val() || '7',
        reminder_days_2: $('#polReminderDays2').val() || '2',
        inquiry_response_sla_hours: $('#polInquirySlaHours').val() || '24'
    };
    try {
        await apiCall('/api/admin/policies', 'PUT', { policies });
        window.notificationService.showSuccess('Booking policies saved successfully.');
    } catch(e) { window.notificationService.showError('Failed to save policies: ' + e.message); }
};
