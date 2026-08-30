const express = require('express');
const db = require('../../database');
const { requireAdmin } = require('../../middleware/auth');
const { resolveActor } = require('../../lib/actor');
const { addMinutesToTime, parseDurationToMinutes } = require('../../lib/time-utils');
const { bookingConfig } = require('../../lib/booking-config');
const {
    getActiveDateHoldsForCalendarGrid, insertDateHold, deleteDateHoldById, getDateHoldTimesById,
    updateDateHoldDate, getDateHoldsForDateConflict
} = require('../../database/repositories/calendar.repository');
const { getBookingsOnDateForHoldConflict } = require('../../database/repositories/bookings.repository');
const router = express.Router();

// Shared by POST /calendar/hold (create) and PATCH /calendar/hold/:id/date (move) — a hold
// landing on a date already blocked by another hold or booking must be rejected the same way
// whether it's a brand-new hold or an existing one being dragged to a new date. excludeHoldId
// lets a move check ignore the hold's own row (relevant if it's a no-op move back to its own date).
function findHoldDateConflict(date, startTime, endTime, excludeHoldId, callback) {
    // Compare by minutes, not lexically (consistent with the booking-submit overlap / timeRangesOverlap):
    // a non-zero-padded time like "9:00" would break a string compare ("9:00" < "10:00" is false).
    const toMin = (t) => { const [h, m] = String(t).split(':').map(Number); return (h || 0) * 60 + (m || 0); };
    const overlap = (s1, e1, s2, e2) => (toMin(s1) < toMin(e2)) && (toMin(s2) < toMin(e1));

    const holdExclude = excludeHoldId ? ' AND id != ?' : '';
    const holdParams = excludeHoldId ? [date, excludeHoldId] : [date];
    getDateHoldsForDateConflict(holdExclude, holdParams, (err, holds) => {
        if (err) return callback(err);

        getBookingsOnDateForHoldConflict(date, (err2, bookings) => {
            if (err2) return callback(err2);

            let conflictReason = null;

            if (!startTime) {
                // New/moved hold is all day
                if ((holds && holds.length > 0) || (bookings && bookings.length > 0)) {
                    conflictReason = 'A block or booking already exists on this date.';
                }
            } else {
                // Timed hold — default end to 1 hour after start if not provided
                let effectiveEndTime = endTime;
                if (!effectiveEndTime) {
                    const ep = startTime.split(':');
                    let eh = parseInt(ep[0]) + 1;
                    if (eh >= 24) eh = 23;
                    effectiveEndTime = `${String(eh).padStart(2, '0')}:${ep[1]}`;
                }

                if (holds) {
                    for (const h of holds) {
                        if (!h.start_time) { conflictReason = 'An all-day block exists on this date.'; break; }
                        if (overlap(startTime, effectiveEndTime, h.start_time, h.end_time || h.start_time)) { conflictReason = 'Overlaps with an existing block.'; break; }
                    }
                }

                if (!conflictReason && bookings) {
                    for (const b of bookings) {
                        // A booking with no recorded start time occupies the whole day, same as
                        // everywhere else conflict detection treats an untimed booking.
                        if (!b.event_start_time) { conflictReason = 'An all-day booking exists on this date.'; break; }
                        let bEnd = b.performance_end_time;
                        if (!bEnd) {
                            const mins = parseDurationToMinutes(b.performance_duration);
                            bEnd = addMinutesToTime(b.event_start_time, mins);
                        }
                        const holdGap = (b.buffer_minutes != null) ? b.buffer_minutes
                            : (b.event_type && bookingConfig.typeBuffers[b.event_type] !== undefined) ? bookingConfig.typeBuffers[b.event_type]
                            : bookingConfig.minGapMins;
                        const bufferedBEnd = addMinutesToTime(bEnd, holdGap);
                        if (overlap(startTime, effectiveEndTime, b.event_start_time, bufferedBEnd)) { conflictReason = 'Overlaps with an existing booking.'; break; }
                    }
                }
            }

            callback(null, conflictReason);
        });
    });
}

// --- Unified Calendar APIs (Phase 9) ---

/**
 * GET /api/admin/calendar/events
 * Aggregates Bookings, Holds, and Sites Events for FullCalendar
 */
router.get('/api/admin/calendar/events', requireAdmin, (req, res) => {
    const events = [];
    
    db.serialize(() => {
        // 1. Get Bookings — include timing columns so FullCalendar can render timed bars
        db.all(`SELECT b.id, COALESCE(c.full_name, b.name) AS name, b.event_name, b.date,
                       b.event_start_time, b.performance_end_time, b.performance_duration,
                       b.status, b.total_amount, b.payment_status,
                       b.amount_paid, b.amount_outstanding, b.quote_expiry_date,
                       b.cell, COALESCE(v.name, b.event_location) AS venue_name, b.city,
                       e.event_title AS linked_event_title, b.event_id
                FROM bookings b
                LEFT JOIN clients c ON b.client_id = c.id
                LEFT JOIN events e ON b.event_id = e.event_id
                LEFT JOIN venues v ON b.venue_id = v.id
                WHERE b.status != 'CANCELLED'`, [], (err, bookings) => {
            if (err) return res.status(500).json({ success: false, error: err.message });
            
            bookings.forEach(b => {
                let color = '#666'; // PENDING / other — neutral
                if (b.status === 'CONFIRMED' || b.status === 'COMPLETED') color = '#D4AF37'; // Gold
                else if (b.status === 'ACCEPTED') color = '#4ade80'; // Sage green
                else if (b.status === 'QUOTED')   color = '#fb923c'; // Orange
                else if (b.status === 'NEW')      color = '#60a5fa'; // Blue

                const displayName = b.linked_event_title || b.event_name || b.event_type || 'Booking';
                const prefix = b.linked_event_title ? '★ ' : '';
                let title = prefix + displayName + ' (' + b.name + ')';

                const hasAttachments = (() => { try { return JSON.parse(b.attachment_files || '[]').length > 0; } catch(e) { return false; } })();
                const ev = {
                    id: 'b-' + b.id,
                    title: title,
                    color: color,
                    extendedProps: {
                        type: 'booking', dbId: b.id, status: b.status, payment: b.payment_status, event_id: b.event_id,
                        isCalSynced: !!b.google_event_id,
                        isAccepted:  !!b.accepted_at,
                        isPopiaDone: !!b.popia_consent,
                        hasAttachments: hasAttachments,
                        venueName: b.venue_name || null,
                        city: b.city || null,
                        clientPhone: b.cell || null,
                        amountOutstanding: b.amount_outstanding != null ? b.amount_outstanding : (b.total_amount != null ? b.total_amount - (b.amount_paid || 0) : null),
                        quoteExpiryDate: b.quote_expiry_date || null
                    }
                };

                if (b.event_start_time) {
                    ev.start = b.date + 'T' + b.event_start_time;
                    const endTime = b.performance_end_time ||
                        addMinutesToTime(b.event_start_time, parseDurationToMinutes(b.performance_duration));
                    ev.end = b.date + 'T' + endTime;
                    ev.allDay = false;
                } else {
                    ev.start = b.date;
                    ev.allDay = true;
                }

                events.push(ev);
            });

            // 2. Get Manual Holds
            getActiveDateHoldsForCalendarGrid((err, holds) => {
                if (err) holds = [];
                const holdColorMap = { unavailable: '#EF5350', personal: '#42A5F5', travel: '#66BB6A', maintenance: '#FFA726' };
                holds.forEach(h => {
                    const color = holdColorMap[h.block_type] || '#777';
                    const ev = {
                        id: 'h-' + h.id,
                        title: h.notes || 'Blocked',
                        color,
                        extendedProps: { type: 'hold', dbId: h.id, blockType: h.block_type }
                    };
                    if (h.start_time) {
                        ev.start = h.hold_date + 'T' + h.start_time;
                        ev.end   = h.hold_date + 'T' + (h.end_time || addMinutesToTime(h.start_time, 60));
                        ev.allDay = false;
                    } else {
                        ev.start  = h.hold_date;
                        ev.allDay = true;
                    }
                    events.push(ev);
                });

                // 3. Get Public Site Events
                db.all(`SELECT e.event_id, e.event_title, e.event_datetime, e.event_start_time, e.event_end_time, e.booking_id, v.name AS venue_name
                        FROM events e
                        LEFT JOIN venues v ON e.venue_id = v.id
                        WHERE e.event_status != 'draft'`, [], (err, siteEvents) => {
                    if (err) { /* skip site events on error, still return */ siteEvents = []; }
                    (siteEvents || []).forEach(se => {
                        if (!se.booking_id) { // Only show standalone events, bookings are already pushed
                            events.push({
                                id: 'e-' + se.event_id,
                                title: '[EVENT] ' + se.event_title + (se.venue_name ? ` (${se.venue_name})` : ''),
                                start: se.event_start_time ? (se.event_datetime || '').split('T')[0] + 'T' + se.event_start_time : (se.event_datetime || '').split('T')[0],
                                end:   se.event_end_time   ? (se.event_datetime || '').split('T')[0] + 'T' + se.event_end_time   : undefined,
                                color: '#17a2b8', // Teal
                                allDay: !se.event_start_time,
                                extendedProps: { type: 'public_event', dbId: se.event_id, venue: se.venue_name }
                            });
                        }
                    });

                    // Optionally append milestone events (quote expiries + payment due dates)
                    function sendEvents() {
                        if (req.query.include !== 'milestones') return res.json(events);
                        db.all(`SELECT b.id, COALESCE(c.full_name, b.name) AS name, b.quote_expiry_date
                                FROM bookings b LEFT JOIN clients c ON b.client_id = c.id
                                WHERE b.status = 'QUOTED' AND b.quote_expiry_date IS NOT NULL`, [], (e2, quoteds) => {
                            if (!e2 && quoteds) quoteds.forEach(q => events.push({
                                id: 'qex-' + q.id, title: 'Quote expires: ' + (q.name || 'Booking #' + q.id),
                                start: q.quote_expiry_date, allDay: true, color: '#fb923c',
                                extendedProps: { type: 'milestone', milestoneType: 'quote_expiry', dbId: q.id }
                            }));
                            db.all(`SELECT ps.id, ps.booking_id, ps.description, ps.due_date, ps.expected_amount,
                                           COALESCE(c.full_name, b.name) AS client_name
                                    FROM payment_schedules ps JOIN bookings b ON ps.booking_id = b.id
                                    LEFT JOIN clients c ON b.client_id = c.id
                                    WHERE ps.status = 'pending' AND ps.due_date IS NOT NULL`, [], (e3, scheds) => {
                                if (!e3 && scheds) scheds.forEach(s => {
                                    const overdue = new Date(s.due_date + 'T00:00:00') < new Date();
                                    events.push({
                                        id: 'ps-' + s.id,
                                        title: s.description + ': ' + (s.client_name || 'Booking #' + s.booking_id),
                                        start: s.due_date, allDay: true, color: overdue ? '#f87171' : '#fb923c',
                                        extendedProps: { type: 'milestone', milestoneType: 'payment_due', dbId: s.booking_id, isOverdue: overdue, amount: s.expected_amount }
                                    });
                                });
                                res.json(events);
                            });
                        });
                    }
                    sendEvents();
                });
            });
        });
    });
});

router.post('/api/admin/calendar/hold', requireAdmin, (req, res) => {
    const { date, reason, category, start_time, end_time, block_type } = req.body;
    const notes = reason || category || 'Admin hold';
    if (!date) return res.status(400).json({ success: false, message: 'Date required.' });

    findHoldDateConflict(date, start_time, end_time, null, (err, conflictReason) => {
        if (err) return res.status(500).json({ success: false, error: err.message });
        if (conflictReason) {
            return res.status(409).json({ success: false, message: conflictReason });
        }

        const expires = new Date(date); expires.setDate(expires.getDate() + 1);
        const expiresStr = expires.toISOString().slice(0, 19).replace('T', ' ');
        insertDateHold(
            date, notes, expiresStr, start_time || null, end_time || null, block_type || null, req.session.adminId,
            async function(insertErr) {
                if (insertErr) return res.status(500).json({ success: false, error: insertErr.message });
                const actor = await resolveActor(req.session.adminId);
                res.json({ success: true, hold: { id: this.lastID }, last_updated: { name: actor.name, role: actor.role, at: new Date().toISOString() } });
            }
        );
    });
});

/**
 * DELETE /api/admin/calendar/hold/:id
 */
router.delete('/api/admin/calendar/hold/:id', requireAdmin, (req, res) => {
    deleteDateHoldById(req.params.id, (err) => {
        if (err) return res.status(500).json({ success: false, error: err.message });
        res.json({ success: true });
    });
});

router.patch('/api/admin/calendar/hold/:id/date', requireAdmin, (req, res) => {
    const { date } = req.body;
    const holdId = req.params.id;
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        return res.status(400).json({ success: false, message: 'Valid date (YYYY-MM-DD) required.' });
    }

    // Moving a hold was never conflict-checked against the destination date — unlike creating a
    // new hold, which always was. A drag-drop could silently land a hold on a day that already
    // has another block or booking.
    getDateHoldTimesById(holdId, (getErr, hold) => {
        if (getErr) return res.status(500).json({ success: false, error: getErr.message });
        if (!hold) return res.status(404).json({ success: false, message: 'Hold not found.' });

        findHoldDateConflict(date, hold.start_time, hold.end_time, holdId, (err, conflictReason) => {
            if (err) return res.status(500).json({ success: false, error: err.message });
            if (conflictReason) {
                return res.status(409).json({ success: false, message: conflictReason });
            }

            updateDateHoldDate(date, req.session.adminId, req.session.role || null, holdId,
                async (updErr) => {
                    if (updErr) return res.status(500).json({ success: false, error: updErr.message });
                    const actor = await resolveActor(req.session.adminId);
                    res.json({ success: true, newDate: date, last_updated: { name: actor.name, role: actor.role, at: new Date().toISOString() } });
                });
        });
    });
});

module.exports = router;
