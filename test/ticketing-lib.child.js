// Run by ticketing-lib.test.js in its OWN process (never required by the test runner): drives lib/ticketing.js directly against a
// THROWAWAY database (DB_PATH points at a fresh file the parent deletes) - tiers, reservations, the last-ticket race, holds that run out,
// checkout and the admin guards. Prints one RESULT: line of named outcomes for the parent to check.
const { dbRun, dbGet } = require('../lib/db-helpers');
const t = require('../lib/ticketing');
const core = require('../lib/ticketing-core');

const out = {};
const refusal = async (p) => { try { await p; return null; } catch (e) { return e.refusal ? { status: e.status, message: e.message, sold_out: e.sold_out, errors: e.errors } : { crash: e.message }; } };
const tier = (id) => dbGet('SELECT * FROM ticket_types WHERE id = ?', [id]);

(async () => {
    await new Promise(r => setTimeout(r, 4000));            // let the fresh DB finish creating its tables
    const ev = await dbRun("INSERT INTO events (event_title, event_datetime, event_status) VALUES ('Lib Test Show', '2099-03-01T20:00', 'upcoming')");
    const booked = await dbRun("INSERT INTO events (event_title, event_datetime, event_status, booking_id) VALUES ('Client Gig', '2099-03-02T20:00', 'upcoming', NULL)");
    const tierIn = (patch) => core.validateTier({ name: 'General', price: '150', capacity: '5', max_per_order: '4', is_active: true, ...patch }).clean;

    // tiers
    const g = await t.createTier(ev.lastID, tierIn(), null);
    const vip = await t.createTier(ev.lastID, tierIn({ name: 'VIP', price: '500', capacity: '1', max_per_order: '1' }), null);
    out.created = { g: g && g.price_cents, vip: vip && vip.capacity };
    out.vipId = vip.id;
    out.dupName = await refusal(t.createTier(ev.lastID, tierIn(), null));
    // a client booking's event (throwaway DB has no bookings, so the link is forced with FKs briefly off)
    await dbRun('PRAGMA foreign_keys = OFF');
    await dbRun('UPDATE events SET booking_id = 999999 WHERE event_id = ?', [booked.lastID]);
    await dbRun('PRAGMA foreign_keys = ON');
    out.bookingTierRefused = await refusal(t.createTier(booked.lastID, tierIn(), null));

    // a normal reservation
    const r1 = await t.reserve(ev.lastID, [{ ticket_type_id: g.id, quantity: 2 }]);
    out.r1 = { status: r1.order.status, total: r1.order.total_cents, ref: core.isTokenShape(r1.order.public_reference), mpid: r1.order.m_payment_id === 'TKT_' + r1.order.id,
        holdMin: Math.round((Date.parse(r1.order.reserved_until) - Date.now()) / 60000), reserved: (await tier(g.id)).reserved };

    // THE RACE: 20 buyers for the 1 VIP ticket at the same moment
    const race = await Promise.all(Array.from({ length: 20 }, () => t.reserve(ev.lastID, [{ ticket_type_id: vip.id, quantity: 1 }]).then(() => 'ok', e => (e.refusal ? e.status : 'crash:' + e.message))));
    const vipRow = await tier(vip.id);
    out.race = { ok: race.filter(x => x === 'ok').length, sold409: race.filter(x => x === 409).length, other: race.filter(x => x !== 'ok' && x !== 409), reserved: vipRow.reserved, sold: vipRow.sold };

    // a mixed order where one tier is gone: NOTHING is held (the General part rolls back too)
    const beforeMixed = (await tier(g.id)).reserved;
    out.mixed = await refusal(t.reserve(ev.lastID, [{ ticket_type_id: g.id, quantity: 1 }, { ticket_type_id: vip.id, quantity: 1 }]));
    out.mixedRolledBack = (await tier(g.id)).reserved === beforeMixed;

    // more than is left
    out.tooMany = await refusal(t.reserve(ev.lastID, [{ ticket_type_id: g.id, quantity: 4 }]));   // 5 - 2 held = 3 left
    out.overLimit = await refusal(t.reserve(ev.lastID, [{ ticket_type_id: g.id, quantity: 5 }]));

    // checkout on a live hold, then on an expired one
    const buyer = core.validateBuyer({ buyer_name: 'Test Buyer', buyer_email: 'buyer@example.invalid', buyer_phone: '0821234567', holder_names: ['A', ''], popia_consent: true, terms_accepted: true }, 2).clean;
    const co = await t.startCheckout(r1.order.public_reference, buyer, 'v2.2');
    out.checkout = { name: co.buyer_name, consent: !!co.consent_at, policy: co.consent_policy_version, started: !!co.checkout_started_at, holders: co.holder_names };
    const r2 = await t.reserve(ev.lastID, [{ ticket_type_id: g.id, quantity: 1 }]);
    await dbRun('UPDATE ticket_orders SET reserved_until = ? WHERE id = ?', [new Date(Date.now() - 1000).toISOString(), r2.order.id]);
    out.expiredCheckout = await refusal(t.startCheckout(r2.order.public_reference, buyer, 'v2.2'));
    out.afterExpiredCheckout = { status: (await t.getOrderById(r2.order.id)).status, reserved: (await tier(g.id)).reserved };

    // a lapsed hold is released by the next reservation (lazy expiry) - and by the sweep
    await dbRun('UPDATE ticket_orders SET reserved_until = ? WHERE id = ?', [new Date(Date.now() - 1000).toISOString(), r1.order.id]);
    const r3 = await t.reserve(ev.lastID, [{ ticket_type_id: g.id, quantity: 3 }]);
    out.lazy = { r1: (await t.getOrderById(r1.order.id)).status, r1Expired: !!(await t.getOrderById(r1.order.id)).expired_at, reserved: (await tier(g.id)).reserved, r3: r3.order.status };
    await dbRun('UPDATE ticket_orders SET reserved_until = ? WHERE id = ?', [new Date(Date.now() - 1000).toISOString(), r3.order.id]);
    out.sweep = await t.expireStaleOrders();
    out.afterSweep = { reserved: (await tier(g.id)).reserved, r3: (await t.getOrderById(r3.order.id)).status };
    out.sweepAgain = await t.expireStaleOrders();     // nothing left to release, and stock never goes negative

    // the buyer releases a hold themselves
    const r4 = await t.reserve(ev.lastID, [{ ticket_type_id: g.id, quantity: 1 }]);
    out.release = await t.releaseByBuyer(r4.order.public_reference);
    out.releaseTwice = await t.releaseByBuyer(r4.order.public_reference);
    out.afterRelease = (await tier(g.id)).reserved;

    // admin guards
    const r5 = await t.reserve(ev.lastID, [{ ticket_type_id: g.id, quantity: 2 }]);
    out.capacityBelowHeld = await refusal(t.updateTier(g.id, tierIn({ capacity: '1' })));
    const upd = await t.updateTier(g.id, tierIn({ capacity: '6', price: '175' }));
    out.updated = { cap: upd.after.capacity, price: upd.after.price_cents, oldLinePrice: (await dbGet('SELECT unit_price_cents FROM ticket_order_items WHERE order_id = ?', [r5.order.id])).unit_price_cents };
    out.deleteUsedTier = await refusal(t.deleteTier(g.id));
    const unused = await t.createTier(ev.lastID, tierIn({ name: 'Unused' }), null);
    out.deleteUnused = !!(await t.deleteTier(unused.id));
    out.closeSales = await t.setSalesState(ev.lastID, 'close', null);
    out.closedReserve = await refusal(t.reserve(ev.lastID, [{ ticket_type_id: g.id, quantity: 1 }]));
    out.deletionCheck = await t.eventDeletionCheck(ev.lastID);
    out.eventDeleteBlockedByDb = await dbRun('DELETE FROM events WHERE event_id = ?', [ev.lastID]).then(() => 'deleted', e => e.message);

    // the database's own invariant held through all of the above
    const broken = await dbGet('SELECT COUNT(*) AS n FROM ticket_types WHERE sold + reserved > capacity OR reserved < 0 OR sold < 0');
    const heldVsPending = await dbGet(`SELECT (SELECT COALESCE(SUM(reserved),0) FROM ticket_types) AS held,
        (SELECT COALESCE(SUM(i.quantity),0) FROM ticket_order_items i JOIN ticket_orders o ON o.id = i.order_id WHERE o.status = 'pending') AS pending`);
    out.invariant = { broken: broken.n, held: heldVsPending.held, pending: heldVsPending.pending };
    console.log('RESULT:' + JSON.stringify(out));
    process.exit(0);
})().catch(e => { console.error('CHILD ERROR', e); process.exit(1); });
