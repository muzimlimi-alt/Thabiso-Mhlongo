// Phase 5 (HOUSEKEEPING-NOTES.md): relocated from app.js verbatim. Pure calculation, no I/O —
// shared by the admin cancellation-preview/cancel routes (not yet moved) and lib/popia.js's
// getBookingErasureImpact(), so both keep using the exact same tiered refund/retention math.
const calculateCancellationRefund = (booking, policyStr) => {
    const totalPaid = parseFloat(booking.amount_paid || 0);
    const totalFee = parseFloat(booking.total_amount || booking.amount_paid || 0);

    if (!booking.date) return { rule: "No event date set", retention: totalPaid, refund: 0, totalPaid, daysUntilEvent: null };

    const eventDate = new Date(booking.date);
    const now = new Date();
    const daysUntilEvent = Math.ceil((eventDate - now) / (1000 * 60 * 60 * 24));

    // Parse policy tiers from DB value, or use built-in defaults
    let tiers = null;
    if (policyStr) {
        try {
            const parsed = JSON.parse(policyStr);
            if (Array.isArray(parsed.tiers) && parsed.tiers.length > 0) tiers = parsed.tiers;
        } catch (_) {}
    }
    if (!tiers) {
        tiers = [
            { days_min: 30, retention_pct: 0.10, label: "30+ days (10% admin fee retained)" },
            { days_min: 14, retention_pct: 0.50, label: "14-29 days (50% fee retained)" },
            { days_min:  0, retention_pct: 1.00, label: "< 14 days (100% fee retained, non-refundable)" }
        ];
    }
    // Tiers must be sorted descending by days_min
    const sorted = [...tiers].sort((a, b) => b.days_min - a.days_min);
    const tier = sorted.find(t => daysUntilEvent >= t.days_min) || sorted[sorted.length - 1];

    const retention = totalFee * (parseFloat(tier.retention_pct) || 0);
    const rule = tier.label || `${tier.days_min}+ days (${(tier.retention_pct * 100).toFixed(0)}% retained)`;

    const actualRetention = Math.min(retention, totalPaid);
    const refundDue = Math.max(0, totalPaid - actualRetention);

    return { rule, retention: actualRetention, refund: refundDue, totalPaid, daysUntilEvent };
};

module.exports = { calculateCancellationRefund };
