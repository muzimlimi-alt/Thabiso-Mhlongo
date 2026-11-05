// Event ticketing - lib/ticketing.js against a THROWAWAY database in a child process (test/ticketing-lib.child.js): the oversell guard
// (20 buyers racing for 1 ticket), rollback of a part-sold-out order, holds that run out (lazy + sweep), checkout on a live / lapsed hold,
// and the admin guards (capacity never below what is sold or held, used tiers can't be deleted, an event with tiers can't be deleted).
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

module.exports = async function ({ check }) {
    const tmpDb = path.join(os.tmpdir(), `ticketing-lib-${process.pid}-${Date.now()}.sqlite`);
    const child = spawnSync(process.execPath, [path.join(__dirname, 'ticketing-lib.child.js')], {
        env: { ...process.env, DB_PATH: tmpDb, NODE_ENV: 'test', R2_ENDPOINT: '', R2_BUCKET: '', R2_ACCESS_KEY_ID: '', R2_SECRET_ACCESS_KEY: '', GOOGLE_REFRESH_TOKEN: 'test-mode-invalid-refresh-token', SMTP_MOCK: 'true' },
        encoding: 'utf8', timeout: 90000
    });
    for (const suffix of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmpDb + suffix); } catch (e) {} }
    const line = (child.stdout || '').split('\n').find(l => l.startsWith('RESULT:'));
    check('ticketing lib: the isolated child ran to the end', !!line, ((child.stdout || '') + (child.stderr || '')).slice(-1500));
    if (!line) return;
    const o = JSON.parse(line.slice(7));
    const j = (x) => JSON.stringify(x);

    check('tiers: created with the price in cents; a second tier of the same name in the same event is refused (409)',
        o.created.g === 15000 && o.created.vip === 1 && o.dupName && o.dupName.status === 409, j({ created: o.created, dup: o.dupName }));
    check('tiers: a client booking\'s event cannot sell tickets (409) - only Thabiso\'s own standalone shows', o.bookingTierRefused && o.bookingTierRefused.status === 409, j(o.bookingTierRefused));
    check('reserve: a pending order with an unguessable reference, PayFast id TKT_<id>, a 10-minute hold, total from the tier price, stock held',
        o.r1.status === 'pending' && o.r1.total === 30000 && o.r1.ref && o.r1.mpid && o.r1.holdMin === 10 && o.r1.reserved === 2, j(o.r1));
    check('RACE: 20 buyers for the last VIP ticket at the same moment -> exactly 1 reservation, 19 "sold out" (409), no crash, never oversold',
        o.race.ok === 1 && o.race.sold409 === 19 && o.race.other.length === 0 && o.race.reserved === 1 && o.race.sold === 0, j(o.race));
    check('reserve: when one tier of a mixed order is gone the WHOLE order is refused and nothing of the other tier stays held',
        o.mixed && o.mixed.status === 409 && j(o.mixed.sold_out) === j([o.vipId]) && o.mixedRolledBack,j({ mixed: o.mixed, rolledBack: o.mixedRolledBack }));
    check('reserve: asking for more than is left -> 409 sold out; more than the per-order limit -> 400',
        o.tooMany && o.tooMany.status === 409 && o.overLimit && o.overLimit.status === 400, j({ tooMany: o.tooMany, overLimit: o.overLimit }));
    check('checkout: buyer details, POPIA consent time + policy version and the per-ticket names are stored on the live hold',
        o.checkout.name === 'Test Buyer' && o.checkout.consent && o.checkout.policy === 'v2.2' && o.checkout.started && o.checkout.holders === '["A",null]', j(o.checkout));
    check('checkout: a hold that ran out is refused (409), the order becomes expired and its ticket goes back on sale',
        o.expiredCheckout && o.expiredCheckout.status === 409 && o.afterExpiredCheckout.status === 'expired' && o.afterExpiredCheckout.reserved === 2, j({ refused: o.expiredCheckout, after: o.afterExpiredCheckout }));
    check('expiry (lazy): the next reservation releases a lapsed hold first, so its tickets can be bought again',
        o.lazy.r1 === 'expired' && o.lazy.r1Expired && o.lazy.r3 === 'pending' && o.lazy.reserved === 3, j(o.lazy));
    check('expiry (sweep): the scheduled sweep releases lapsed holds; running it again changes nothing (stock never negative)',
        o.sweep === 1 && o.afterSweep.reserved === 0 && o.afterSweep.r3 === 'expired' && o.sweepAgain === 0, j({ sweep: o.sweep, after: o.afterSweep, again: o.sweepAgain }));
    check('release: the buyer can give a hold back at once; doing it twice is harmless', o.release.released === true && o.releaseTwice.released === false && o.afterRelease === 0, j({ r: o.release, r2: o.releaseTwice, after: o.afterRelease }));
    check('admin: capacity can\'t drop below what is sold or held (409); a price change leaves existing orders at the price they were sold at',
        o.capacityBelowHeld && o.capacityBelowHeld.status === 409 && o.updated.cap === 6 && o.updated.price === 17500 && o.updated.oldLinePrice === 15000, j({ below: o.capacityBelowHeld, upd: o.updated }));
    check('admin: a tier with orders can\'t be deleted (409); a never-used one can', o.deleteUsedTier && o.deleteUsedTier.status === 409 && o.deleteUnused === true, j({ used: o.deleteUsedTier, unused: o.deleteUnused }));
    check('admin: Close sales stops new reservations', o.closeSales.overview && o.closeSales.overview.state === 'closed' && o.closedReserve && o.closedReserve.status === 400, j({ close: o.closeSales, reserve: o.closedReserve }));
    check('relationships: the event now has orders, and the database itself refuses to delete it (RESTRICT)',
        o.deletionCheck.orders >= 1 && /FOREIGN KEY/.test(o.eventDeleteBlockedByDb), j({ check: o.deletionCheck, del: o.eventDeleteBlockedByDb }));
    check('invariant after everything: no tier over capacity or negative, and held stock equals exactly what pending orders hold',
        o.invariant.broken === 0 && o.invariant.held === o.invariant.pending, j(o.invariant));
};
