// Phase 5 (HOUSEKEEPING-NOTES.md): two small shared constants central to the public booking-intake
// rules, moved out of the app.js monolith byte-identical.
//
// MIN_ADVANCE_HOURS: shared by the public booking-intake route (routes/public/bookings.js) and
// GET /api/public/availability (still in app.js) — the intake route re-checks the same rule the
// calendar's own "too soon" warning already enforces, so the two must never drift apart.
//
// CURRENT_POLICY_VERSION: the current POPIA consent-policy version stamped into consent_audit /
// audit_log rows and newsletter subscriber records. Shared across the public booking-intake route,
// the admin manual booking-creation route, and the newsletter subscribe flow (all still in app.js
// except the first) — kept as one definition so a policy-version bump can't update some call sites
// and miss others.
const MIN_ADVANCE_HOURS = 48;
const CURRENT_POLICY_VERSION = 'v2.2';

module.exports = { MIN_ADVANCE_HOURS, CURRENT_POLICY_VERSION };
