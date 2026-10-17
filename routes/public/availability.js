const express = require('express');
const db = require('../../database');
const { ipRateLimiter } = require('../../middleware/rate-limiters');
const { MIN_ADVANCE_HOURS } = require('../../lib/booking-policy');
const { checkDateAvailability, getFullDayDatesForMonth } = require('../../lib/calendar-sync');
const { getMinBookingGapSetting } = require('../../database/repositories/settings.repository');
const { getActiveHoldDatesForMonth } = require('../../database/repositories/calendar.repository');
const places = require('../../lib/places');
const { sendPlacesError } = places;
const router = express.Router();

// P2.4 — Date availability check (public, rate-limited)
// Phase 5 (HOUSEKEEPING-NOTES.md): checkDateAvailability moved to lib/calendar-sync.js, alongside
// hasCalendarConflict (its Google-Calendar-aware sibling) — see the require near the top of this
// file for the re-import.

// Only the shared per-IP budget (100/hour) guards this. It used to ALSO sit behind trackRateLimiter (10 per 15 min, "too many
// tracking lookups" - copied from the tracking routes), so a visitor comparing more than ten dates in a quarter hour got 429s
// and the booking drawer could only say "couldn't confirm this date". The answer is public anyway (the month view lists the
// same held / booked dates), so a per-date lookup is not the sensitive kind of request that limiter is for.
router.get('/api/public/availability', ipRateLimiter, (req, res) => {
    const { date } = req.query;
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        return res.status(400).json({ available: false, message: 'Date parameter (YYYY-MM-DD) required.' });
    }

    // Minimum advance notice check
    const now = new Date();
    const chosen = new Date(date + 'T00:00:00');
    const diffHours = (chosen - now) / (1000 * 60 * 60);
    if (diffHours < MIN_ADVANCE_HOURS) {
        return res.json({
            available: false,
            reason: 'too_soon',
            message: `Bookings require at least ${MIN_ADVANCE_HOURS} hours advance notice. Please choose a later date.`
        });
    }

    checkDateAvailability(date, (err, result) => {
        if (err) return res.status(500).json({ available: false, message: 'Server error.' });

        if (result.available) {
            return res.json({ available: true, message: 'This date is available!', busy_ranges: result.busy_ranges || [] });
        }

        // Suggest nearest available date (scan forward up to 60 days)
        const reasonMsg = result.reason === 'held'
            ? 'This date is blocked by a schedule hold.'
            : 'This date is already booked.';

        let scanDate = new Date(chosen);
        let checked = 0;
        const maxDays = 60;

        function scanNext() {
            if (checked >= maxDays) {
                return res.json({ available: false, reason: result.reason, message: reasonMsg });
            }
            scanDate.setDate(scanDate.getDate() + 1);
            checked++;
            const scanStr = scanDate.toISOString().split('T')[0];
            const scanDiffH = (scanDate - now) / (1000 * 60 * 60);
            if (scanDiffH < MIN_ADVANCE_HOURS) { scanNext(); return; }
            checkDateAvailability(scanStr, (e2, r2) => {
                if (r2.available) {
                    const opts = { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' };
                    const label = scanDate.toLocaleDateString('en-ZA', opts);
                    return res.json({
                        available: false,
                        reason: result.reason,
                        message: reasonMsg,
                        suggestion: scanStr,
                        suggestion_label: label
                    });
                }
                scanNext();
            });
        }
        scanNext();
    });
});

// Booking configuration — per-day working hours + gap for the frontend slot picker
router.get('/api/public/booking-config', ipRateLimiter, (req, res) => {
    // ?dow=all returns every weekday in one response. The public availability calendar needs all
    // seven to grey out non-working days, and used to make seven separate requests on every page
    // load — each counted against the per-IP request budget (see ipRateLimiter).
    if (req.query.dow === 'all') {
        return db.all("SELECT day_of_week, start_time, end_time, is_working_day FROM working_hours", [], (err, rows) => {
            getMinBookingGapSetting((err2, gapRow) => {
                const byDow = {};
                (!err && rows ? rows : []).forEach(r => { byDow[r.day_of_week] = r; });
                const days = [0, 1, 2, 3, 4, 5, 6].map(d => {
                    const wh = byDow[d];
                    return {
                        day_of_week:         d,
                        working_hours_start: wh ? wh.start_time : '09:00',
                        working_hours_end:   wh ? wh.end_time   : '22:00',
                        is_working_day:      wh ? !!wh.is_working_day : true
                    };
                });
                res.json({
                    days,
                    min_booking_gap_minutes: (!err2 && gapRow) ? parseInt(gapRow.setting_value) || 30 : 30,
                    // The same rule GET /api/public/availability enforces ("too_soon"). Exposed so the
                    // calendar can grey out dates inside the notice window instead of showing them as
                    // bookable and only rejecting them after the click.
                    min_advance_hours: MIN_ADVANCE_HOURS
                });
            });
        });
    }
    const dayOfWeek = req.query.dow !== undefined ? parseInt(req.query.dow) : new Date().getDay();
    db.get("SELECT start_time, end_time, is_working_day FROM working_hours WHERE day_of_week = ?", [dayOfWeek], (err, wh) => {
        getMinBookingGapSetting((err2, gapRow) => {
            res.json({
                working_hours_start:     (!err && wh) ? wh.start_time : '09:00',
                working_hours_end:       (!err && wh) ? wh.end_time   : '22:00',
                is_working_day:          (!err && wh) ? !!wh.is_working_day : true,
                min_booking_gap_minutes: (!err2 && gapRow) ? parseInt(gapRow.setting_value) || 30 : 30,
                min_advance_hours:       MIN_ADVANCE_HOURS
            });
        });
    });
});

// Month availability — returns held and booked dates for calendar widget
router.get('/api/public/availability/month', ipRateLimiter, (req, res) => {
    const year = parseInt(req.query.year);
    const month = parseInt(req.query.month); // 1-12
    if (!year || !month || month < 1 || month > 12 || year < 2020 || year > 2099) {
        return res.status(400).json({ held: [], booked: [], error: 'Invalid year/month.' });
    }
    const monthStr = String(month).padStart(2, '0');
    const prefix = `${year}-${monthStr}`;

    getActiveHoldDatesForMonth(
        prefix + '%',
        (err, holds) => {
            const heldDates = (holds || []).map(r => r.hold_date);
            db.all(
                "SELECT DISTINCT date FROM bookings WHERE date LIKE ? AND status IN ('CONFIRMED','ACCEPTED')",
                [prefix + '%'],
                (err2, bks) => {
                    // Only return dates with confirmed/accepted bookings, no client info
                    const bookedDates = (bks || []).map(r => r.date).filter(d => !heldDates.includes(d));
                    // `full`: dates the per-date check (checkDateAvailability) rejects outright because an
                    // untimed booking/event occupies the whole day. They stay "reserved" (orange) in the
                    // calendar but are not selectable — otherwise the date looks bookable and is only refused
                    // after the click. A failure here degrades to "no extra info", never to an error.
                    getFullDayDatesForMonth(prefix + '%')
                        .then(full => res.json({ held: heldDates, booked: bookedDates, full: full.filter(d => !heldDates.includes(d)) }))
                        .catch(() => res.json({ held: heldDates, booked: bookedDates, full: [] }));
                }
            );
        }
    );
});

// Public: venue search for the booking drawer (js/myscript.js). Both routes are thin wrappers over the shared
// Places service, lib/places.js (2026-10 Places audit), which the admin portal's searches use too. Response
// shapes are unchanged for the drawer: { predictions: [...] } and { result: <legacy place shape> } - plus a
// standardised `location`. What changed: a Google failure (key missing, API not enabled, billing, restriction,
// quota) used to be answered as 200 { predictions: [] }, so visitors saw "No matching venues found" and the
// real reason only reached the server log. It now answers with an error status + code, and the drawer shows
// "Venue search isn't available right now - you can enter the address manually" (its existing error path).
router.get('/api/public/places/autocomplete', ipRateLimiter, async (req, res) => {
    try {
        const predictions = await places.autocomplete(req.query.input, { sessionToken: req.query.sessionToken });
        res.json({ predictions });
    } catch (e) {
        sendPlacesError(res, e, { predictions: [] });
    }
});

router.get('/api/public/places/details', ipRateLimiter, async (req, res) => {
    if (!req.query.place_id) return res.status(400).json({ error: 'place_id required' });
    try {
        const d = await places.details(req.query.place_id, { sessionToken: req.query.sessionToken });
        res.json({ result: d.result, location: d.location });
    } catch (e) {
        sendPlacesError(res, e);
    }
});

module.exports = router;
