const express = require('express');
const db = require('../../database');
const { ipRateLimiter, trackRateLimiter } = require('../../middleware/rate-limiters');
const { MIN_ADVANCE_HOURS } = require('../../lib/booking-policy');
const { checkDateAvailability, getFullDayDatesForMonth } = require('../../lib/calendar-sync');
const { getMinBookingGapSetting } = require('../../database/repositories/settings.repository');
const { getActiveHoldDatesForMonth } = require('../../database/repositories/calendar.repository');
const router = express.Router();

// P2.4 — Date availability check (public, rate-limited)
// Phase 5 (HOUSEKEEPING-NOTES.md): checkDateAvailability moved to lib/calendar-sync.js, alongside
// hasCalendarConflict (its Google-Calendar-aware sibling) — see the require near the top of this
// file for the re-import.

router.get('/api/public/availability', ipRateLimiter, trackRateLimiter, (req, res) => {
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

// Public: venue autocomplete via Google Places API proxy
router.get('/api/public/places/autocomplete', ipRateLimiter, (req, res) => {
    const input = (req.query.input || '').trim();
    if (input.length < 2) return res.json({ predictions: [] });
    const apiKey = process.env.GOOGLE_MAPS_API_KEY || '';
    if (!apiKey) {
        console.warn('[Places] GOOGLE_MAPS_API_KEY is not set — venue autocomplete will always return zero results until it is configured.');
        return res.json({ predictions: [] });
    }
    const url = `https://maps.googleapis.com/maps/api/place/autocomplete/json?input=${encodeURIComponent(input)}&key=${apiKey}`;

    require('https').get(url, (r) => {
        let body = '';
        r.on('data', d => body += d);
        r.on('end', () => {
            try {
                const data = JSON.parse(body);
                if (data.status === 'OK') {
                    const predictions = data.predictions.map(p => ({
                        place_id: p.place_id,
                        main_text: p.structured_formatting ? p.structured_formatting.main_text : p.description,
                        secondary_text: p.structured_formatting ? p.structured_formatting.secondary_text : '',
                        formatted_address: p.description
                    }));
                    res.json({ predictions });
                } else {
                    if (data.status !== 'ZERO_RESULTS') console.warn('[Places] autocomplete returned', data.status, data.error_message || '');
                    res.json({ predictions: [] });
                }
            } catch(e) { res.json({ predictions: [] }); }
        });
    }).on('error', () => res.json({ predictions: [] }));
});

// Public: venue details via Google Places API proxy
router.get('/api/public/places/details', ipRateLimiter, (req, res) => {
    const place_id = req.query.place_id;
    if (!place_id) return res.status(400).json({ error: 'place_id required' });
    const apiKey = process.env.GOOGLE_MAPS_API_KEY || '';
    if (!apiKey) {
        console.warn('[Places] GOOGLE_MAPS_API_KEY is not set — venue details lookup cannot run.');
        return res.status(404).json({ error: 'Place not found' });
    }
    const url = `https://maps.googleapis.com/maps/api/place/details/json?place_id=${place_id}&fields=address_components,formatted_address,name,geometry&key=${apiKey}`;

    require('https').get(url, (r) => {
        let body = '';
        r.on('data', d => body += d);
        r.on('end', () => {
            try {
                const data = JSON.parse(body);
                if (data.status === 'OK' && data.result) {
                    res.json({ result: data.result });
                } else {
                    if (data.status !== 'ZERO_RESULTS') console.warn('[Places] details returned', data.status, data.error_message || '');
                    res.status(404).json({ error: 'Place not found' });
                }
            } catch(e) { res.status(500).json({ error: 'Server error' }); }
        });
    }).on('error', () => res.status(500).json({ error: 'Network error' }));
});

module.exports = router;
