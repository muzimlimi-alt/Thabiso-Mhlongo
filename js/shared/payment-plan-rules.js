/*
 * Client payment-plan rules: the ONE definition of what a client-designed payment plan may look like.
 *
 * Loaded by the server (lib/payment-plan.js: accept-quote + POST /payment-plan) AND by the public
 * tracking page (index.html's plan builder, as window.PaymentPlanRules). Both sides run the very same
 * code, so the browser can validate live as the client types (the public mutate rate limit is only 5
 * actions per 15 minutes, so there is no server "preview" round trip) and the server re-validates the
 * submitted plan with identical results. The server builds the context (buildContext) from fresh
 * database state and sends it to the browser verbatim inside /track's payment_plan.context.
 *
 * Rules (owner decisions, docs-internal/client-payment-plans.md):
 *   - at most MAX_PAYMENTS payments per booking in total; already-paid ("locked") milestones count;
 *   - deposit floor: the first payment brings what is paid up to deposit_percentage of the total
 *     (judged cumulatively with locked money; no longer applies once locked money reaches the floor);
 *   - while nothing is paid yet, the first payment is due within FIRST_DUE_WITHIN_DAYS of the
 *     ORIGINAL acceptance date (so repeated edits can't push the deposit back), or today if that
 *     date has passed;
 *   - every due date lies between today and LAST_DUE_DAYS_BEFORE_EVENT days before the event;
 *   - no payment below the minimum, unless it is the only remaining payment.
 *
 * Deliberately dependency-free (no moment, no jQuery, no DOM) and written in ES5 so it runs unchanged
 * in Node and in any browser the public site supports:
 *   - Money is handled in INTEGER CENTS everywhere: float rands drift (0.1 + 0.2), and the plan's
 *     invariant (live milestones sum exactly to the booking total) must hold to the cent.
 *   - Dates are plain 'YYYY-MM-DD' calendar dates, never Date objects or timestamps. Arithmetic goes
 *     through Date.UTC, which has no DST or local-timezone shifts, so adding N days is exact on every
 *     machine. "Today" is never computed here: the server passes the Africa/Johannesburg date in.
 *   - 'YYYY-MM-DD' strings compare correctly with < and >, which the rules below rely on.
 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.PaymentPlanRules = factory();
})(this, function () {
    'use strict';

    var MAX_PAYMENTS = 4;
    var FIRST_DUE_WITHIN_DAYS = 7;
    var LAST_DUE_DAYS_BEFORE_EVENT = 2;
    var DEFAULT_MIN_PAYMENT = 500;
    var DEFAULT_DEPOSIT_PERCENTAGE = 50;
    // With no event date there is no "before the event" limit; matches the admin auto plan's
    // (lib/invoicing.js autoBuildDepositBalanceSchedule) today + 30 balance date.
    var NO_EVENT_WINDOW_DAYS = 30;

    var DAY_MS = 86400000;
    var MAX_SAFE_CENTS = 9007199254740991; // Number.MAX_SAFE_INTEGER (ES5 has no constant for it)
    var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    var YMD_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
    // The strict wire format for an amount sent to the server: plain rands, at most 2 decimals.
    // The liberal, human-typed formats ("R 1 500,50") are parseMoneyInput's job, in the browser.
    var STRICT_AMOUNT_RE = /^(\d+)(?:\.(\d{1,2}))?$/;
    var DASH = '\u2013'; // en dash, as in the existing "Outstanding Balance – …" labels

    // ───────────────────────── dates ('YYYY-MM-DD', UTC arithmetic) ─────────────────────────

    function pad2(n) { return (n < 10 ? '0' : '') + n; }

    // Milliseconds of the UTC midnight of a real calendar date, or null. Rejects impossible dates
    // ('2026-02-30', '2026-13-01') by round-tripping through Date.UTC, which would otherwise
    // silently roll them over into the next month.
    function ymdToMs(ymd) {
        if (typeof ymd !== 'string') return null;
        var m = YMD_RE.exec(ymd);
        if (!m) return null;
        var y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
        if (y < 1000 || mo < 1 || mo > 12 || d < 1 || d > 31) return null;
        var ms = Date.UTC(y, mo - 1, d);
        var dt = new Date(ms);
        if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
        return ms;
    }

    function msToYmd(ms) {
        var dt = new Date(ms);
        return dt.getUTCFullYear() + '-' + pad2(dt.getUTCMonth() + 1) + '-' + pad2(dt.getUTCDate());
    }

    function isValidDate(ymd) {
        return ymdToMs(ymd) !== null;
    }

    // Loose normaliser for dates coming from the database / server ('2026-11-02' or
    // '2026-11-02 00:00:00'): the calendar-date prefix, or null when it isn't a real date.
    function toYmd(value) {
        if (typeof value !== 'string') return null;
        var s = value.trim().slice(0, 10);
        return isValidDate(s) ? s : null;
    }

    // ymd + n calendar days ('YYYY-MM-DD'), or null for an invalid date / non-finite n.
    function addDays(ymd, n) {
        var ms = ymdToMs(ymd);
        var k = Number(n);
        if (ms === null || !isFinite(k)) return null;
        return msToYmd(ms + Math.round(k) * DAY_MS);
    }

    // Whole calendar days from b to a, i.e. a − b (like moment's a.diff(b, 'days')):
    // diffDays('2026-10-23', '2026-10-16') === 7. null when either date is invalid.
    function diffDays(a, b) {
        var ma = ymdToMs(a), mb = ymdToMs(b);
        if (ma === null || mb === null) return null;
        return Math.round((ma - mb) / DAY_MS);
    }

    function maxYmd(a, b) { return a >= b ? a : b; }

    function clampYmd(x, lo, hi) {
        if (x < lo) return lo;
        if (x > hi) return hi;
        return x;
    }

    // "2 Nov 2026" — unambiguous for South African readers (unlike 02/11 vs 11/02).
    function formatDate(ymd) {
        var ms = ymdToMs(ymd);
        if (ms === null) return ymd === null || ymd === undefined ? '' : String(ymd);
        var dt = new Date(ms);
        return dt.getUTCDate() + ' ' + MONTHS[dt.getUTCMonth()] + ' ' + dt.getUTCFullYear();
    }

    // ───────────────────────── money (integer cents) ─────────────────────────

    // A stored rand value (bookings.total_amount, payment_schedules.expected_amount, …) rounded to
    // whole cents. total_amount can be stored unrounded (a re-quote writes the raw final total), so
    // this rounds rather than rejects. Anything that isn't a finite number counts as 0.
    function roundToCents(amount) {
        if (amount === null || amount === undefined || amount === '' || typeof amount === 'boolean') return 0;
        var n = typeof amount === 'string' ? Number(amount.trim()) : Number(amount);
        if (!isFinite(n)) return 0;
        return n < 0 ? -Math.round(-n * 100) : Math.round(n * 100);
    }

    // Classifies a client-supplied amount (number, or numeric string in rands) as whole cents or a
    // reason it is unusable, so validatePlan can say WHY ("more than 2 decimal places") rather than
    // just "invalid".
    function classifyAmount(raw) {
        if (raw === null || raw === undefined) return { cents: null, error: 'missing' };
        if (typeof raw === 'number') {
            if (!isFinite(raw)) return { cents: null, error: 'format' };
            if (raw < 0) return { cents: null, error: 'negative' };
            var scaled = raw * 100;
            var c = Math.round(scaled);
            // A number computed as cents / 100 (e.g. 1234.56 → 123456.00000000001) is within float
            // noise of a whole cent; 12.345 is not and has genuinely more than 2 decimals.
            if (Math.abs(scaled - c) > 1e-6) return { cents: null, error: 'decimals' };
            if (c > MAX_SAFE_CENTS) return { cents: null, error: 'format' };
            return { cents: c, error: null };
        }
        if (typeof raw !== 'string') return { cents: null, error: 'format' };
        var s = raw.trim();
        if (s === '') return { cents: null, error: 'missing' };
        if (/^-\s*\d+(\.\d+)?$/.test(s)) return { cents: null, error: 'negative' };
        if (/^\d+\.\d{3,}$/.test(s)) return { cents: null, error: 'decimals' };
        var m = STRICT_AMOUNT_RE.exec(s);
        if (!m) return { cents: null, error: 'format' };
        var whole = m[1].replace(/^0+(?=\d)/, '');
        // 13 digits of rands keeps the cents value a safe integer (string maths, no float drift).
        if (whole.length > 13) return { cents: null, error: 'format' };
        var frac = (m[2] || '') + '00';
        return { cents: Number(whole) * 100 + Number(frac.slice(0, 2)), error: null };
    }

    // Strict client amount → integer cents, or null (negative, NaN, > 2 decimals, not numeric).
    function toCents(amount) {
        var r = classifyAmount(amount);
        return r.error ? null : r.cents;
    }

    // 123450 → "R 1,234.50"
    function formatRand(cents) {
        var c = Math.round(Number(cents));
        if (!isFinite(c)) c = 0;
        var neg = c < 0;
        if (neg) c = -c;
        var rands = Math.floor(c / 100);
        var rem = c - rands * 100;
        var grouped = String(rands).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
        return (neg ? '-' : '') + 'R ' + grouped + '.' + pad2(rem);
    }

    function countChar(s, ch) {
        return s.split(ch).length - 1;
    }

    // Liberal parser for what a person types into an amount box: "R 1 500,50", "1,500.50", "R1500",
    // "1.500,50" and "1500.5" all give 1500.5. Returns rands (a number with at most 2 decimals) or
    // null. Ambiguous or malformed input ("1.500", "1,5000", "15,00,000", "-5", "1e3") is null rather
    // than guessed: a wrong guess here would silently schedule the wrong amount of money.
    function parseMoneyInput(input) {
        if (typeof input === 'number') {
            var nc = toCents(input);
            return nc === null ? null : nc / 100;
        }
        if (typeof input !== 'string') return null;
        // Every kind of space (incl. the non-breaking and thin spaces of the SA number format) and
        // a leading currency marker are noise.
        var s = input.replace(/[\s\u00a0\u2007\u2009\u202f]/g, '').replace(/^(?:ZAR|R)/i, '');
        if (s === '' || !/^[\d.,]+$/.test(s) || !/\d/.test(s)) return null;

        var lastDot = s.lastIndexOf('.');
        var lastComma = s.lastIndexOf(',');
        var decimalSep = null;
        var groupSep = null;
        if (lastDot >= 0 && lastComma >= 0) {
            // Both present: whichever comes last is the decimal mark ("1,500.50" / "1.500,50").
            decimalSep = lastDot > lastComma ? '.' : ',';
            groupSep = decimalSep === '.' ? ',' : '.';
        } else if (lastComma >= 0) {
            // A single comma followed by 1–2 digits is a decimal comma ("1500,5"); otherwise commas
            // group thousands ("1,500", "1,500,000").
            var after = s.length - lastComma - 1;
            if (countChar(s, ',') === 1 && (after === 1 || after === 2)) decimalSep = ',';
            else groupSep = ',';
        } else if (lastDot >= 0) {
            if (countChar(s, '.') === 1) decimalSep = '.';
            else groupSep = '.';
        }

        var intPart = s;
        var fracPart = '';
        if (decimalSep) {
            var idx = s.lastIndexOf(decimalSep);
            intPart = s.slice(0, idx);
            fracPart = s.slice(idx + 1);
            if (intPart.indexOf(decimalSep) !== -1) return null;
            if (!/^\d{1,2}$/.test(fracPart)) return null;
        }
        if (groupSep) {
            if (intPart.indexOf(groupSep) !== -1) {
                var grouping = groupSep === '.' ? /^\d{1,3}(?:\.\d{3})+$/ : /^\d{1,3}(?:,\d{3})+$/;
                if (!grouping.test(intPart)) return null;
                intPart = intPart.split(groupSep).join('');
            }
        }
        if (intPart === '' && fracPart !== '') intPart = '0'; // ".50"
        if (!/^\d+$/.test(intPart)) return null;
        var cents = toCents(intPart + (fracPart ? '.' + fracPart : ''));
        return cents === null ? null : cents / 100;
    }

    // Optimistic-concurrency token for the live plan: changes when any live milestone is added or
    // superseded (plan changes never update rows in place, they insert new ids), when money arrives,
    // or when the total changes (a re-quote).
    function planVersion(liveRows, paidCents, totalCents) {
        var ids = [];
        (Array.isArray(liveRows) ? liveRows : []).forEach(function (r) {
            if (!r || r.id === null || r.id === undefined) return;
            if (isDeadStatus(r.status)) return;
            ids.push(r.id);
        });
        ids.sort(compareIds);
        var paid = Math.round(Number(paidCents)) || 0;
        var total = Math.round(Number(totalCents)) || 0;
        return ids.join(',') + '|' + paid + '|' + total;
    }

    // ───────────────────────── context ─────────────────────────

    function normStatus(status) {
        return status === null || status === undefined || status === '' ? 'pending' : String(status).toLowerCase();
    }

    function isDeadStatus(status) {
        var s = normStatus(status);
        return s === 'superseded' || s === 'cancelled';
    }

    function compareIds(a, b) {
        var na = Number(a), nb = Number(b);
        if (isFinite(na) && isFinite(nb)) return na - nb;
        var sa = String(a), sb = String(b);
        return sa < sb ? -1 : (sa > sb ? 1 : 0);
    }

    function numberOrDefault(value, fallback) {
        if (value === null || value === undefined || value === '' || typeof value === 'boolean') return fallback;
        var n = Number(value);
        return isFinite(n) ? n : fallback;
    }

    // Live rows in the SAME order alignMilestonePayments walks them (due_date ASC, id ASC), so the
    // locked set computed here is exactly the set the payment waterfall would mark paid.
    function normaliseLiveRows(liveRows) {
        var rows = [];
        (Array.isArray(liveRows) ? liveRows : []).forEach(function (r) {
            if (!r || isDeadStatus(r.status)) return;
            var due = toYmd(r.due_date);
            rows.push({
                id: r.id,
                due_date: due || (typeof r.due_date === 'string' ? r.due_date : ''),
                amount_cents: roundToCents(r.expected_amount),
                status: normStatus(r.status),
                sequence: r.sequence === null || r.sequence === undefined || r.sequence === '' ? null : Number(r.sequence),
                source: r.source === undefined ? null : r.source
            });
        });
        rows.sort(function (a, b) {
            if (a.due_date !== b.due_date) return a.due_date < b.due_date ? -1 : 1;
            return compareIds(a.id, b.id);
        });
        return rows;
    }

    /**
     * The facts every rule needs, in cents and 'YYYY-MM-DD'. Pure: the server calls it with fresh DB
     * state and ships the result to the browser verbatim (it is plain JSON).
     *
     * input: { mode: 'accept'|'change', today, totalAmount, amountPaid, liveRows, eventDate,
     *          acceptedDate, depositPercentage, minPaymentAmount } — see the spec for each field.
     * Besides the documented fields the context also carries:
     *   locked_rows    — the locked (paid) rows, same shape as unpaid_rows, for read-only display;
     *   sequence_base  — max(locked_count, max locked sequence): new rows take sequence base + i + 1,
     *                    so /pay's sequence order stays equal to due-date order after a re-plan.
     */
    function buildContext(input) {
        input = input || {};
        var today = toYmd(input.today);
        if (!today) throw new TypeError('PaymentPlanRules.buildContext: input.today must be a YYYY-MM-DD date');
        var mode = input.mode === 'change' ? 'change' : 'accept';

        var pct = Math.min(100, Math.max(0, numberOrDefault(input.depositPercentage, DEFAULT_DEPOSIT_PERCENTAGE)));
        var minPayment = Math.max(0, numberOrDefault(input.minPaymentAmount, DEFAULT_MIN_PAYMENT));
        var minPaymentCents = roundToCents(minPayment);
        var totalCents = Math.max(0, roundToCents(input.totalAmount));
        var paidCents = Math.max(0, roundToCents(input.amountPaid));

        // Locked rows come from MONEY, not from status flags: a row can be covered by amount_paid but
        // not yet flagged 'paid' (the post-payment window before alignMilestonePayments runs), and a
        // stale 'paid' flag can sit on a row the money no longer covers (a refund). Walk the rows the
        // way the waterfall does and stop at the first one the money can't fully cover.
        var rows = normaliseLiveRows(input.liveRows);
        var budget = paidCents;
        var lockedCents = 0;
        var locked = [];
        var unpaid = [];
        var stopped = false;
        rows.forEach(function (r) {
            if (!stopped && r.amount_cents <= budget) {
                budget -= r.amount_cents;
                lockedCents += r.amount_cents;
                locked.push(r);
            } else {
                stopped = true;
                unpaid.push(r);
            }
        });
        var creditCents = paidCents - lockedCents;
        var lockedIds = locked.map(function (r) { return r.id; });

        var latestLockedDue = null;
        locked.forEach(function (r) {
            if (isValidDate(r.due_date) && (latestLockedDue === null || r.due_date > latestLockedDue)) latestLockedDue = r.due_date;
        });
        // New rows may not fall before a locked row's due date: alignment orders by due_date, so an
        // earlier unpaid row would steal the locked row's money and "un-pay" it.
        var earliestDue = latestLockedDue ? maxYmd(today, latestLockedDue) : today;

        var eventDate = toYmd(input.eventDate);
        var latestDue = eventDate
            ? maxYmd(addDays(eventDate, -LAST_DUE_DAYS_BEFORE_EVENT), earliestDue)
            : maxYmd(addDays(today, NO_EVENT_WINDOW_DAYS), earliestDue);

        var requireFirstBy = lockedCents === 0;
        // Anchored to the ORIGINAL acceptance date so re-planning can't keep pushing the deposit
        // back; once that window has passed the first payment must be due today. A booking with no
        // recorded acceptance date (legacy data) is treated as accepted today.
        var acceptedDate = toYmd(input.acceptedDate) || today;
        var firstDueBy = requireFirstBy
            ? clampYmd(maxYmd(today, addDays(acceptedDate, FIRST_DUE_WITHIN_DAYS)), earliestDue, latestDue)
            : null;

        var depositFloorCents = Math.round(totalCents * pct / 100);
        var consistent = creditCents === 0 && rows.every(function (r) {
            return r.status !== 'paid' || lockedIds.indexOf(r.id) !== -1;
        });

        var sequenceBase = locked.length;
        locked.forEach(function (r) {
            if (r.sequence !== null && isFinite(r.sequence) && r.sequence > sequenceBase) sequenceBase = r.sequence;
        });

        function publicRow(r) {
            return { id: r.id, due_date: r.due_date, amount_cents: r.amount_cents, status: r.status, sequence: r.sequence, source: r.source };
        }

        return {
            mode: mode,
            today: today,
            max_payments: MAX_PAYMENTS,
            deposit_percentage: pct,
            min_payment_cents: minPaymentCents,
            total_cents: totalCents,
            paid_cents: paidCents,
            locked_cents: lockedCents,
            credit_cents: creditCents,
            remaining_cents: Math.max(0, totalCents - lockedCents),
            locked_ids: lockedIds,
            locked_count: locked.length,
            locked_rows: locked.map(publicRow),
            unpaid_rows: unpaid.map(publicRow),
            slots: Math.max(0, MAX_PAYMENTS - locked.length),
            sequence_base: sequenceBase,
            deposit_floor_cents: depositFloorCents,
            require_deposit: lockedCents < depositFloorCents,
            deposit_needed_cents: Math.max(0, depositFloorCents - lockedCents),
            require_first_by: requireFirstBy,
            earliest_due: earliestDue,
            latest_due: latestDue,
            first_due_by: firstDueBy,
            event_date: eventDate,
            consistent: consistent,
            event_passed: !!eventDate && eventDate < today
        };
    }

    // ───────────────────────── validation ─────────────────────────

    function plural(n, word) {
        return n + ' ' + word + (n === 1 ? '' : 's');
    }

    function countMessage(ctx) {
        var max = ctx.max_payments || MAX_PAYMENTS;
        var locked = ctx.locked_count || 0;
        if (locked === 0) return 'A payment plan can have at most ' + max + ' payments in total.';
        if (ctx.slots > 0) {
            return 'A payment plan can have at most ' + max + ' payments in total, including the ' + plural(locked, 'payment') +
                ' already made, so you can schedule up to ' + ctx.slots + ' more.';
        }
        return 'A payment plan can have at most ' + max + ' payments in total, and ' + plural(locked, 'payment') +
            ' have already been made, so no more can be scheduled.';
    }

    function amountMessage(n, error) {
        if (error === 'missing') return 'Payment ' + n + ': enter an amount.';
        if (error === 'negative') return 'Payment ' + n + ': the amount can\'t be negative.';
        if (error === 'decimals') return 'Payment ' + n + ': amounts can\'t have more than 2 decimal places (cents).';
        if (error === 'zero') return 'Payment ' + n + ': the amount must be more than R 0.00.';
        return 'Payment ' + n + ': enter the amount in rands, for example 1500 or 1500.50.';
    }

    function earliestMessage(ctx, n) {
        if (ctx.earliest_due > ctx.today) {
            return 'Payment ' + n + ' must be due on or after your last paid payment\'s due date (' + formatDate(ctx.earliest_due) + ').';
        }
        return 'Payment ' + n + ' must be due on or after today (' + formatDate(ctx.today) + ').';
    }

    function latestMessage(ctx, n) {
        if (ctx.event_date) {
            if (ctx.latest_due === addDays(ctx.event_date, -LAST_DUE_DAYS_BEFORE_EVENT)) {
                return 'Payment ' + n + ' must be due at least ' + LAST_DUE_DAYS_BEFORE_EVENT + ' days before your event (by ' + formatDate(ctx.latest_due) + ').';
            }
            // The event is so close that the normal limit lies before the earliest allowed date.
            return 'Payment ' + n + ' must be due by ' + formatDate(ctx.latest_due) + ' (your event is on ' + formatDate(ctx.event_date) + ').';
        }
        return 'Payment ' + n + ' must be due by ' + formatDate(ctx.latest_due) + '.';
    }

    function depositMessage(ctx) {
        if (!ctx.locked_cents) {
            return 'Your first payment must be at least ' + formatRand(ctx.deposit_needed_cents) + ' (the ' + ctx.deposit_percentage + '% deposit).';
        }
        return 'Your next payment must be at least ' + formatRand(ctx.deposit_needed_cents) + ' so that, together with what you have already paid, the ' +
            ctx.deposit_percentage + '% deposit (' + formatRand(ctx.deposit_floor_cents) + ') is covered.';
    }

    function minimumMessage(ctx, n, cents) {
        return 'Payment ' + n + ' is ' + formatRand(cents) + ', but when you split the amount each payment must be at least ' + formatRand(ctx.min_payment_cents) + '.';
    }

    function firstByMessage(ctx) {
        if (ctx.mode === 'change' && ctx.first_due_by === ctx.today) {
            return 'Your first payment must be due today (' + formatDate(ctx.today) + '), because the deposit was due within ' +
                FIRST_DUE_WITHIN_DAYS + ' days of accepting the quote.';
        }
        return 'Your first payment must be due by ' + formatDate(ctx.first_due_by) + ', within ' + FIRST_DUE_WITHIN_DAYS + ' days of accepting the quote.';
    }

    /**
     * Checks a proposed plan for the unpaid part of the booking against ctx (from buildContext).
     * rows: [{ amount, due_date }] — amount in rands, as a number or numeric string.
     * Returns { ok, errors: [{ index, field, message }], rows: [{ amount_cents, due_date }] }:
     *   - every rule is checked and every problem reported (not just the first);
     *   - errors[].index is the position in the INPUT array (null for plan-wide problems), and
     *     "Payment N" in messages is that position + 1 counted AFTER the already-paid payments
     *     (locked_count + position + 1): the number on the card the person is looking at, and the
     *     same numbering as the labels ("Payment 2 of 3" when payment 1 is paid). Without the offset
     *     a change after a paid deposit would call the first unpaid card "Payment 1", the paid one;
     *   - the output rows are sorted by due date (ties and unreadable dates keep input order, the
     *     unreadable ones last); "the first payment" always means the earliest-dated one. A field that
     *     could not be read comes back as null.
     */
    function validatePlan(ctx, rows) {
        var errors = [];
        function add(index, field, message) {
            errors.push({ index: index, field: field, message: message });
        }
        if (!ctx || typeof ctx !== 'object') {
            add(null, 'plan', 'Your payment plan could not be checked. Please reload the page and try again.');
            return { ok: false, errors: errors, rows: [] };
        }
        if (!Array.isArray(rows) || rows.length === 0) {
            add(null, 'plan', 'Add at least one payment.');
            return { ok: false, errors: errors, rows: [] };
        }
        // Payment numbers in messages continue after the paid payments (see above).
        var numberOffset = ctx.locked_count > 0 ? ctx.locked_count : 0;
        function num(index) { return numberOffset + index + 1; }

        // 1. How many payments.
        if (rows.length > ctx.slots) add(null, 'plan', countMessage(ctx));

        // 2. Each amount and date is readable.
        var parsed = rows.map(function (raw, i) {
            var r = raw && typeof raw === 'object' ? raw : {};
            var n = num(i);
            var a = classifyAmount(r.amount);
            var amountOk = false;
            if (a.error) add(i, 'amount', amountMessage(n, a.error));
            else if (a.cents <= 0) add(i, 'amount', amountMessage(n, 'zero'));
            else amountOk = true;

            var due = typeof r.due_date === 'string' ? r.due_date.trim() : r.due_date;
            var dueOk = isValidDate(due);
            if (due === undefined || due === null || due === '') add(i, 'due_date', 'Payment ' + n + ': choose a due date.');
            else if (!dueOk) add(i, 'due_date', 'Payment ' + n + ': choose a valid due date.');

            return { index: i, amount_cents: a.error ? null : a.cents, amountOk: amountOk, due_date: dueOk ? due : null };
        });

        // Stable sort by date (explicit tie-break: Array#sort was not guaranteed stable before ES2019).
        var sorted = parsed.slice().sort(function (a, b) {
            if (a.due_date && b.due_date) {
                if (a.due_date !== b.due_date) return a.due_date < b.due_date ? -1 : 1;
            } else if (a.due_date) {
                return -1;
            } else if (b.due_date) {
                return 1;
            }
            return a.index - b.index;
        });
        var allDatesOk = parsed.every(function (p) { return !!p.due_date; });
        var allAmountsOk = parsed.every(function (p) { return p.amountOk; });
        // Which payment is "first" is only certain once every date can be read (or there is just one).
        var first = (allDatesOk || parsed.length === 1) ? sorted[0] : null;
        var firstByApplies = !!(first && first.due_date && ctx.require_first_by && ctx.first_due_by);

        // 3. One payment per day: strictly ascending dates (keeps /pay's sequence order equal to the
        // waterfall's due-date order).
        for (var k = 1; k < sorted.length; k++) {
            if (sorted[k].due_date && sorted[k].due_date === sorted[k - 1].due_date) {
                add(sorted[k].index, 'due_date', 'Payments ' + num(sorted[k - 1].index) + ' and ' + num(sorted[k].index) +
                    ' are both due on ' + formatDate(sorted[k].due_date) + '. Give each payment its own date.');
            }
        }

        // 4. Every date inside the window.
        parsed.forEach(function (p) {
            if (!p.due_date) return;
            if (p.due_date < ctx.earliest_due) {
                add(p.index, 'due_date', earliestMessage(ctx, num(p.index)));
            } else if (p.due_date > ctx.latest_due) {
                // The first payment's tighter "within 7 days of accepting" limit (rule 8, always on or
                // before latest_due) is reported instead: it is the date that actually has to change.
                if (firstByApplies && p === first) return;
                add(p.index, 'due_date', latestMessage(ctx, num(p.index)));
            }
        });

        // 5. The payments cover exactly what is still owed.
        if (allAmountsOk) {
            var sum = 0;
            parsed.forEach(function (p) { sum += p.amount_cents; });
            if (sum !== ctx.remaining_cents) {
                add(null, 'amount', 'Your payments add up to ' + formatRand(sum) + ', but ' + formatRand(ctx.remaining_cents) + ' needs to be scheduled.');
            }
        }

        // 6 + 7. Minimum per payment (a lone remaining payment is exempt) and the deposit floor on the
        // first payment. At most one amount error per payment: for the first payment, whichever
        // bound is higher is the one reported, since meeting it satisfies the other too. (When the
        // deposit still needed is below the minimum, a first payment short of the deposit is also
        // short of the minimum, so the minimum message covers it.)
        var minApplies = parsed.length > 1 && ctx.min_payment_cents > 0;
        var depositShort = !!(ctx.require_deposit && first && first.amountOk && first.amount_cents < ctx.deposit_needed_cents);
        var depositBinds = depositShort && (!minApplies || ctx.deposit_needed_cents >= ctx.min_payment_cents);
        if (minApplies) {
            parsed.forEach(function (p) {
                if (!p.amountOk || p.amount_cents >= ctx.min_payment_cents) return;
                if (p === first && depositBinds) return;
                add(p.index, 'amount', minimumMessage(ctx, num(p.index), p.amount_cents));
            });
        }
        if (depositBinds) add(first.index, 'amount', depositMessage(ctx));

        // 8. While nothing has been paid, the first payment falls within 7 days of acceptance
        // (first_due_by is never before earliest_due, so this never doubles up a rule-4 error).
        if (firstByApplies && first.due_date > ctx.first_due_by) {
            add(first.index, 'due_date', firstByMessage(ctx));
        }

        return {
            ok: errors.length === 0,
            errors: errors,
            rows: sorted.map(function (p) { return { amount_cents: p.amount_cents, due_date: p.due_date }; })
        };
    }

    // ───────────────────────── presets ─────────────────────────

    // total split into k whole-cent parts; the last absorbs the rounding remainder.
    function splitEqually(total, k) {
        var base = Math.floor(total / k);
        var parts = [];
        for (var i = 0; i < k - 1; i++) parts.push(base);
        parts.push(total - base * (k - 1));
        return parts;
    }

    /**
     * The ready-made n-payment plan (n = 1..4) for ctx, or null when n is not allowed or the result
     * would break a rule (e.g. the R500 minimum, or two payments landing on the same day for a
     * short-notice event). Rows: [{ amount_cents, amount (rands), due_date }], in due-date order.
     *   amounts: n = 1 → everything; otherwise the deposit still needed first and the rest split
     *            equally (or, once the deposit is covered, an equal split);
     *   dates:   while nothing is paid, from first_due_by spread evenly to latest_due; otherwise
     *            spread evenly after earliest_due, the last on latest_due.
     * With nothing paid, n = 2 is the classic deposit/balance plan: the deposit floor due today + 7
     * and the balance due 2 days before the event (same as the admin auto plan for normal events).
     */
    function buildPreset(ctx, n) {
        if (!ctx || typeof ctx !== 'object') return null;
        var count = Number(n);
        if (!(count >= 1 && count <= MAX_PAYMENTS) || Math.floor(count) !== count || count > ctx.slots) return null;
        var remaining = ctx.remaining_cents;
        if (!(remaining > 0)) return null;

        var amounts;
        if (count === 1) {
            amounts = [remaining];
        } else if (ctx.require_deposit) {
            // The first payment is the deposit still needed, but never below the minimum payment —
            // otherwise a small deposit (30% of R1,000 = R300 against a R500 minimum) would rule out
            // every split even though R500 + R500 is a perfectly valid plan.
            var first = Math.max(ctx.deposit_needed_cents, ctx.min_payment_cents || 0);
            var rest = remaining - first;
            if (rest <= 0) return null;
            amounts = [first].concat(splitEqually(rest, count - 1));
        } else {
            amounts = splitEqually(remaining, count);
        }

        var dates = [];
        var i;
        if (ctx.require_first_by && ctx.first_due_by) {
            // Normally the first payment sits on first_due_by. For a short-notice event first_due_by
            // is clamped onto latest_due, so pull the first payment forward just far enough to leave
            // one distinct day for each later payment (never before earliest_due).
            var start = ctx.first_due_by;
            if (count > 1) {
                var roomy = addDays(ctx.latest_due, -(count - 1));
                if (roomy < start) start = roomy;
                if (start < ctx.earliest_due) start = ctx.earliest_due;
            }
            var span = diffDays(ctx.latest_due, start);
            for (i = 0; i < count; i++) {
                dates.push(count === 1 ? start : addDays(start, Math.round(i * span / (count - 1))));
            }
        } else {
            var span2 = diffDays(ctx.latest_due, ctx.earliest_due);
            for (i = 0; i < count; i++) {
                dates.push(count === 1 ? ctx.latest_due : addDays(ctx.earliest_due, Math.round((i + 1) * span2 / count)));
            }
        }

        var rows = amounts.map(function (cents, j) {
            return { amount_cents: cents, amount: cents / 100, due_date: dates[j] };
        });
        return validatePlan(ctx, rows).ok ? rows : null;
    }

    // ───────────────────────── labels ─────────────────────────

    function round2(x) {
        return Math.round(x * 100) / 100;
    }

    function rowCents(row) {
        if (!row) return null;
        if (typeof row.amount_cents === 'number' && isFinite(row.amount_cents)) return row.amount_cents;
        return toCents(row.amount);
    }

    /**
     * Server-generated milestone descriptions for the new (unpaid) rows, in the order given — pass
     * validatePlan's / buildPreset's due-date-sorted rows. Clients never send descriptions.
     */
    function labelPlan(ctx, rows) {
        var list = Array.isArray(rows) ? rows : [];
        var lockedCount = ctx && ctx.locked_count > 0 ? ctx.locked_count : 0;
        var pct = ctx ? Number(ctx.deposit_percentage) : NaN;
        var total = lockedCount + list.length;

        // The classic deposit/balance pair keeps its long-standing labels (invoice/contract PDFs and
        // emails have always shown "50% Deposit" / "50% Balance").
        if (lockedCount === 0 && list.length === 2 && pct > 0 && pct < 100 && rowCents(list[0]) === ctx.deposit_floor_cents) {
            return [pct + '% Deposit', round2(100 - pct) + '% Balance'];
        }
        if (lockedCount === 0 && list.length === 1) return ['Full Payment'];

        return list.map(function (_, i) {
            var k = lockedCount + i + 1;
            if (lockedCount === 0 && i === 0) return 'Deposit ' + DASH + ' Payment 1 of ' + total;
            if (k === total) return 'Final Payment ' + DASH + ' Payment ' + total + ' of ' + total;
            return 'Payment ' + k + ' of ' + total;
        });
    }

    // True when rows (any order, amounts as rands) describe exactly the current unpaid plan: same
    // number of payments, same amounts, same dates. Lets the server skip a no-op save (no superseded
    // rows, no emails) and the browser disable "Save" until something actually changed.
    function isUnchangedPlan(ctx, rows) {
        if (!ctx || !Array.isArray(ctx.unpaid_rows) || !Array.isArray(rows)) return false;
        var current = ctx.unpaid_rows;
        if (current.length !== rows.length) return false;
        var proposed = [];
        for (var i = 0; i < rows.length; i++) {
            var r = rows[i] || {};
            var cents = rowCents(r);
            var due = typeof r.due_date === 'string' ? r.due_date.trim() : null;
            if (cents === null || !isValidDate(due)) return false;
            proposed.push({ amount_cents: cents, due_date: due });
        }
        function byDateThenAmount(a, b) {
            if (a.due_date !== b.due_date) return a.due_date < b.due_date ? -1 : 1;
            return a.amount_cents - b.amount_cents;
        }
        proposed.sort(byDateThenAmount);
        var cur = current.map(function (c) { return { amount_cents: c.amount_cents, due_date: c.due_date }; }).sort(byDateThenAmount);
        for (var j = 0; j < cur.length; j++) {
            if (cur[j].amount_cents !== proposed[j].amount_cents || cur[j].due_date !== proposed[j].due_date) return false;
        }
        return true;
    }

    return {
        MAX_PAYMENTS: MAX_PAYMENTS,
        FIRST_DUE_WITHIN_DAYS: FIRST_DUE_WITHIN_DAYS,
        LAST_DUE_DAYS_BEFORE_EVENT: LAST_DUE_DAYS_BEFORE_EVENT,
        DEFAULT_MIN_PAYMENT: DEFAULT_MIN_PAYMENT,
        DEFAULT_DEPOSIT_PERCENTAGE: DEFAULT_DEPOSIT_PERCENTAGE,

        buildContext: buildContext,
        validatePlan: validatePlan,
        buildPreset: buildPreset,
        labelPlan: labelPlan,

        toCents: toCents,
        roundToCents: roundToCents,
        formatRand: formatRand,
        formatDate: formatDate,
        addDays: addDays,
        diffDays: diffDays,
        isValidDate: isValidDate,
        parseMoneyInput: parseMoneyInput,
        planVersion: planVersion,
        isUnchangedPlan: isUnchangedPlan
    };
});
