// Event ticketing - the door API for DOOR LINKS (lib/ticketing-door.js): a volunteer with a per-show link (x-door-pass header, sent by
// js/checkin.js) can look up, find and check in tickets for THAT show only. No portal account; never buyer e-mails / phones or money; a
// ticket for another show gets "wrong show" and nothing about it but the show's name. Every check-in records the link's name.
// Mounted from routes/public/ticketing.js.
const express = require('express');
const { doorRateLimiter } = require('../../middleware/rate-limiters');
const ticketing = require('../../lib/ticketing');
const door = require('../../lib/ticketing-door');
const router = express.Router();

async function requireDoorPass(req, res, next) {
    try {
        res.set('Cache-Control', 'no-store');
        const pass = await door.resolvePass(String(req.get('x-door-pass') || ''));
        if (!pass) return res.status(401).json({ success: false, code: 'DOOR_PASS_INVALID', message: 'This door link has expired or was switched off. Ask the organiser for a new one.' });
        req.doorPass = pass;
        next();
    } catch (e) { next(e); }
}

// A ticket of another show: say which show it is for, nothing more.
const otherShow = (t) => ({ status: 'wrong_event', event_id: t.event_id, event_title: door.doorView(t).event_title, when: door.doorView(t).when });

router.get('/api/door/event', doorRateLimiter, requireDoorPass, async (req, res) => {
    try {
        const ev = await ticketing.getEvent(req.doorPass.event_id);
        res.json({ success: true, event: ev ? ticketing.publicEvent(ev) : null, counts: await ticketing.doorCounts(req.doorPass.event_id),
            pass: { label: req.doorPass.label, expires_at: req.doorPass.expires_at } });
    } catch (e) { res.status(500).json({ success: false, message: 'Something went wrong. Please try again.' }); }
});

router.get('/api/door/tickets/:token', doorRateLimiter, requireDoorPass, async (req, res) => {
    try {
        const t = await ticketing.ticketByToken(String(req.params.token || ''));
        if (!t) return res.status(404).json({ success: false, result: 'invalid', message: 'Invalid ticket.' });
        if (t.event_id !== req.doorPass.event_id) return res.json({ success: true, ticket: otherShow(t) });
        res.json({ success: true, ticket: door.doorView(t), counts: await ticketing.doorCounts(t.event_id) });
    } catch (e) { res.status(500).json({ success: false, message: 'Something went wrong. Please try again.' }); }
});

router.post('/api/door/tickets/:token/check-in', doorRateLimiter, requireDoorPass, async (req, res) => {
    try {
        const token = String(req.params.token || '');
        const t = await ticketing.ticketByToken(token);
        if (!t) return res.status(404).json({ success: false, result: 'invalid', message: 'Invalid ticket.' });
        if (t.event_id !== req.doorPass.event_id) return res.status(409).json({ success: false, result: 'wrong_event', ticket: otherShow(t), message: 'Wrong show' });
        const r = await ticketing.checkIn(token, null, req.doorPass.label);
        if (r.result === 'invalid') return res.status(404).json({ success: false, result: 'invalid', message: 'Invalid ticket.' });
        const view = door.doorView(r.ticket);
        const message = r.result === 'admitted' ? 'Admitted' : r.result === 'already' ? `Already scanned at ${view.checked_in_label}` : 'This ticket is no longer valid';
        res.json({ success: r.result === 'admitted', result: r.result, message, ticket: view, counts: await ticketing.doorCounts(r.ticket.event_id) });
    } catch (e) { res.status(500).json({ success: false, message: 'Something went wrong. Please try again.' }); }
});

router.get('/api/door/search', doorRateLimiter, requireDoorPass, async (req, res) => {
    try {
        const found = req.query.q ? await ticketing.searchTickets(req.doorPass.event_id, req.query.q, { byEmail: false }) : [];
        res.json({ success: true, results: found.map(door.doorView), counts: await ticketing.doorCounts(req.doorPass.event_id) });
    } catch (e) { res.status(500).json({ success: false, message: 'Something went wrong. Please try again.' }); }
});

module.exports = router;
