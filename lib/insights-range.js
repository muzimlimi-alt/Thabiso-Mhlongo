// Dashboard date ranges (the admin Dashboard's one date selector - js/admin/dashboard.js). Pure: no database, no clock of its own
// (callers pass `now`), so every preset and its "previous equivalent period" is unit-tested (test/insights-range.test.js).
// All dates are calendar dates in South African time (Africa/Johannesburg), as 'YYYY-MM-DD', both ends inclusive.
const moment = require('moment-timezone');

const TZ = 'Africa/Johannesburg';
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const PRESETS = ['24h', '7d', '30d', '90d', 'month', 'last_month', 'fy', 'custom'];
const MAX_CUSTOM_DAYS = 3 * 366;
const DAY = 'YYYY-MM-DD';

// Which bucket a chart uses: hours for a day or two, days up to about a quarter, months beyond that.
function granularityFor(days) {
    if (days <= 2) return 'hour';
    if (days <= 92) return 'day';
    return 'month';
}

// The financial year containing `today`, from the Business Profile's year-end month (e.g. 'July' -> 1 Aug .. 31 Jul). No month set:
// the South African tax year (year end February).
function financialYear(today, yearEndMonth) {
    const set = MONTHS.indexOf(yearEndMonth);
    const endIdx = set >= 0 ? set : 1;                                     // February when no month is set
    // start = the month after the year-end month
    let start = today.clone().month((endIdx + 1) % 12).startOf('month');
    if (start.isAfter(today)) start = start.subtract(1, 'year');
    const end = start.clone().add(1, 'year').subtract(1, 'day');
    return { start, end };
}

// resolveRange({ range, from, to }, { now, yearEndMonth }) -> { key, label, from, to, prevFrom, prevTo, days, granularity }
// or { error } for an unusable custom range. The previous period is the one of equal length straight before it - except calendar
// presets: this month to date vs last month to the same day; last month vs the month before; FY to date vs the previous FY to the
// same point.
function resolveRange(query, opts) {
    const q = query || {};
    const o = opts || {};
    const now = moment.tz(o.now || new Date(), TZ);
    const today = now.clone().startOf('day');
    const key = PRESETS.includes(q.range) ? q.range : '30d';
    let from, to, prevFrom, prevTo, label;

    const lastN = (n) => {
        to = today.clone(); from = today.clone().subtract(n - 1, 'days');
        prevTo = from.clone().subtract(1, 'day'); prevFrom = prevTo.clone().subtract(n - 1, 'days');
    };

    switch (key) {
        case '24h':
            // finance works in whole days: yesterday and today; the hourly charts use the last 24 hours themselves
            lastN(2); label = 'Last 24 hours'; break;
        case '7d': lastN(7); label = 'Last 7 days'; break;
        case '90d': lastN(90); label = 'Last 90 days'; break;
        case 'month': {
            from = today.clone().startOf('month'); to = today.clone();
            prevFrom = from.clone().subtract(1, 'month');
            prevTo = moment.min(prevFrom.clone().add(today.date() - 1, 'days'), prevFrom.clone().endOf('month').startOf('day'));
            label = 'This month (' + from.format('MMMM YYYY') + ')'; break;
        }
        case 'last_month': {
            from = today.clone().subtract(1, 'month').startOf('month'); to = from.clone().endOf('month').startOf('day');
            prevFrom = from.clone().subtract(1, 'month'); prevTo = prevFrom.clone().endOf('month').startOf('day');
            label = 'Last month (' + from.format('MMMM YYYY') + ')'; break;
        }
        case 'fy': {
            const fy = financialYear(today, o.yearEndMonth);
            from = fy.start; to = today.clone();
            prevFrom = from.clone().subtract(1, 'year'); prevTo = to.clone().subtract(1, 'year');
            label = 'Financial year ' + fy.start.format('MMM YYYY') + ' - ' + fy.end.format('MMM YYYY') + ' (to date)'; break;
        }
        case 'custom': {
            const f = moment.tz(String(q.from || ''), DAY, true, TZ), t = moment.tz(String(q.to || ''), DAY, true, TZ);
            if (!f.isValid() || !t.isValid()) return { error: 'Choose a start and an end date.' };
            if (f.isAfter(t)) return { error: 'The start date is after the end date.' };
            const n = t.diff(f, 'days') + 1;
            if (n > MAX_CUSTOM_DAYS) return { error: 'Choose at most three years.' };
            from = f; to = t;
            prevTo = from.clone().subtract(1, 'day'); prevFrom = prevTo.clone().subtract(n - 1, 'days');
            label = from.format('D MMM YYYY') + ' - ' + to.format('D MMM YYYY'); break;
        }
        default: lastN(30); label = 'Last 30 days';
    }
    const days = to.diff(from, 'days') + 1;
    return {
        key, label,
        from: from.format(DAY), to: to.format(DAY),
        prevFrom: prevFrom.format(DAY), prevTo: prevTo.format(DAY),
        days,
        granularity: key === '24h' ? 'hour' : granularityFor(days)
    };
}

// Percentage change for a card: null when there is nothing to compare with (a previous value of 0 or missing).
function pctChange(current, previous) {
    const c = Number(current) || 0, p = Number(previous) || 0;
    if (!p) return null;
    return Math.round(((c - p) / Math.abs(p)) * 1000) / 10;
}

module.exports = { TZ, PRESETS, MONTHS, granularityFor, financialYear, resolveRange, pctChange };
