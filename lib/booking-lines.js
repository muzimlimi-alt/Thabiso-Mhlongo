// The name a booking's service line carried when it was added or quoted.
//
// booking_services keeps only service_id, so a live JOIN to `services` shows the service's CURRENT name. A service can be edited at any
// time, and the 2026 rate card renamed three re-used legacy services (ids 1, 4 and 5), so a historical booking would read as a different
// offering from the one that was booked and quoted. booking_line_items.description holds the text as it was: the service name when the
// line was added, the quotation line's own description once quoted. The two tables are written together, in the same order, so the n-th
// booking_services row for a service pairs with the n-th booking_line_items row for that service.
//
// `serviceRows` must be in insertion order (ORDER BY id) and `lineItemRows` too. Each returned row gains `line_description`
// (null when no stored line exists - the caller then falls back to the live name).
function withStoredDescriptions(serviceRows, lineItemRows) {
    const queues = new Map();
    for (const li of (lineItemRows || [])) {
        if (li.service_id == null) continue;
        const key = String(li.service_id);
        if (!queues.has(key)) queues.set(key, []);
        queues.get(key).push(li.description);
    }
    return (serviceRows || []).map(r => {
        const queue = queues.get(String(r.service_id));
        return { ...r, line_description: queue && queue.length ? queue.shift() : null };
    });
}

module.exports = { withStoredDescriptions };
