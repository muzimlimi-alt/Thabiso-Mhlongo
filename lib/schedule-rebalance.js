// How a booking's payment schedule is rescaled to a new total: the PENDING milestones are scaled in proportion to what they were and take
// whatever the PAID milestones leave over; paid milestones never change, and the last pending row absorbs the rounding drift so the
// schedule adds up exactly. Used after a manual adjustment moves the total (routes/admin/transactions.js).
//
// This is the algorithm of POST /api/admin/bookings/:id/payment-schedules/rebalance (routes/admin/bookings.js), kept as a pure function so it
// can be tested; test/adjustments.test.js runs the real route and this function on the same data and requires identical milestones - change
// one and the other must follow.
//
// schedules: [{ id, expected_amount, status }] in due-date order (live rows only). total: the new booking total.
// Returns { ok, reason, updates: [{ id, amount }], paidSum, remaining } - `ok: false` carries a reason and no updates.
function planScheduleRebalance(schedules, total) {
    const rows = Array.isArray(schedules) ? schedules : [];
    const target = Math.round((parseFloat(total) || 0) * 100) / 100;
    if (!rows.length) return { ok: false, reason: 'no-schedule', updates: [], paidSum: 0, remaining: target };

    const isPaid = (s) => String(s.status).toLowerCase() === 'paid';
    const paid = rows.filter(isPaid);
    const pending = rows.filter(s => !isPaid(s));
    const paidSum = paid.reduce((s, x) => s + (parseFloat(x.expected_amount) || 0), 0);
    const remaining = Math.round((target - paidSum) * 100) / 100;

    if (remaining < -0.01) return { ok: false, reason: 'paid-exceeds-total', updates: [], paidSum, remaining };
    if (pending.length === 0) {
        return Math.abs(remaining) <= 0.01
            ? { ok: true, reason: 'already-matches', updates: [], paidSum, remaining }
            : { ok: false, reason: 'all-paid', updates: [], paidSum, remaining };
    }

    const pendSum = pending.reduce((s, x) => s + (parseFloat(x.expected_amount) || 0), 0);
    const rounded = pending.map(s => {
        const prop = pendSum > 0 ? (parseFloat(s.expected_amount) || 0) / pendSum : 1 / pending.length;
        return Math.round(remaining * prop * 100) / 100;
    });
    const drift = Math.round((remaining - rounded.reduce((a, b) => a + b, 0)) * 100) / 100;
    rounded[rounded.length - 1] = Math.max(0, Math.round((rounded[rounded.length - 1] + drift) * 100) / 100);
    return { ok: true, reason: 'rebalanced', updates: pending.map((s, i) => ({ id: s.id, amount: rounded[i] })), paidSum, remaining };
}

module.exports = { planScheduleRebalance };
