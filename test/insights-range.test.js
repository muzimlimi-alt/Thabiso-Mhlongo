// Dashboard date ranges (lib/insights-range.js): every preset, its previous equivalent period, the financial year from the Business
// Profile's year-end month, custom ranges and their refusals, chart granularity, and the % change rule. Pure - no server needed.
const { resolveRange, financialYear, pctChange } = require('../lib/insights-range');
const moment = require('moment-timezone');

module.exports = async function ({ check }) {
    // 14:00 SAST on Wed 18 Nov 2026
    const now = new Date('2026-11-18T12:00:00Z');
    const r = (q, o) => resolveRange(q, Object.assign({ now }, o));

    let x = r({ range: '7d' });
    check('7 days: the last 7 calendar days including today, previous = the 7 before', x.from === '2026-11-12' && x.to === '2026-11-18' && x.prevFrom === '2026-11-05' && x.prevTo === '2026-11-11' && x.days === 7 && x.granularity === 'day', JSON.stringify(x));
    x = r({ range: '30d' });
    check('30 days (also the default for an unknown range)', x.from === '2026-10-20' && x.to === '2026-11-18' && x.prevTo === '2026-10-19' && x.prevFrom === '2026-09-20' && r({ range: 'nonsense' }).from === x.from, JSON.stringify(x));
    x = r({ range: '90d' });
    check('90 days: daily buckets', x.days === 90 && x.granularity === 'day', JSON.stringify(x));
    x = r({ range: '24h' });
    check('24 hours: hourly charts, finance covers yesterday + today', x.granularity === 'hour' && x.from === '2026-11-17' && x.to === '2026-11-18', JSON.stringify(x));
    x = r({ range: 'month' });
    check('this month: 1 Nov to today, compared with 1 Oct to 18 Oct', x.from === '2026-11-01' && x.to === '2026-11-18' && x.prevFrom === '2026-10-01' && x.prevTo === '2026-10-18', JSON.stringify(x));
    x = resolveRange({ range: 'month' }, { now: new Date('2026-03-31T10:00:00Z') });
    check('this month on 31 March compares with February up to its last day (never 31 Feb)', x.prevFrom === '2026-02-01' && x.prevTo === '2026-02-28', JSON.stringify(x));
    x = r({ range: 'last_month' });
    check('last month: all of October, compared with all of September', x.from === '2026-10-01' && x.to === '2026-10-31' && x.prevFrom === '2026-09-01' && x.prevTo === '2026-09-30', JSON.stringify(x));
    x = resolveRange({ range: 'last_month' }, { now: new Date('2026-01-10T10:00:00Z') });
    check('last month in January is December of the year before', x.from === '2025-12-01' && x.to === '2025-12-31' && x.prevFrom === '2025-11-01', JSON.stringify(x));

    x = r({ range: 'fy' }, { yearEndMonth: 'July' });
    check('financial year (year end July): 1 Aug 2026 to today, compared with 1 Aug 2025 to 18 Nov 2025', x.from === '2026-08-01' && x.to === '2026-11-18' && x.prevFrom === '2025-08-01' && x.prevTo === '2025-11-18' && /Aug 2026 - Jul 2027/.test(x.label), JSON.stringify(x));
    x = resolveRange({ range: 'fy' }, { now: new Date('2026-05-05T10:00:00Z'), yearEndMonth: 'July' });
    check('financial year in May (year end July) started the August before', x.from === '2025-08-01', JSON.stringify(x));
    x = r({ range: 'fy' });
    check('no year-end month set: the South African tax year (1 March)', x.from === '2026-03-01', JSON.stringify(x));
    const fy = financialYear(moment.tz('2026-12-31', 'Africa/Johannesburg'), 'December');
    check('year end December: the calendar year', fy.start.format('YYYY-MM-DD') === '2026-01-01' && fy.end.format('YYYY-MM-DD') === '2026-12-31', fy.start.format() + ' ' + fy.end.format());

    x = r({ range: 'custom', from: '2026-01-01', to: '2026-01-31' });
    check('custom: exactly the dates chosen, compared with the same number of days before', x.from === '2026-01-01' && x.to === '2026-01-31' && x.prevTo === '2025-12-31' && x.prevFrom === '2025-12-01' && x.granularity === 'day', JSON.stringify(x));
    x = r({ range: 'custom', from: '2024-01-01', to: '2026-01-31' });
    check('a long custom range is charted by month', x.granularity === 'month', JSON.stringify(x));
    check('custom refusals: missing / impossible / reversed / over three years',
        !!r({ range: 'custom' }).error && !!r({ range: 'custom', from: '2026-02-30', to: '2026-03-01' }).error &&
        !!r({ range: 'custom', from: '2026-03-01', to: '2026-02-01' }).error && !!r({ range: 'custom', from: '2020-01-01', to: '2026-01-01' }).error, '');

    check('% change: up, down, nothing to compare with', pctChange(150, 100) === 50 && pctChange(75, 100) === -25 && pctChange(10, 0) === null && pctChange(0, 0) === null, '');
};
