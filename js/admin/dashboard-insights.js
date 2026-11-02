/* The admin Dashboard's tabs (admin.html #dbInsights): Overview, Traffic & Visitors, Geography, Performance & Security, Finance - and the one
   date selector they all share. The figures come from /api/admin/insights/* (routes/admin/insights.js, lib/insights.js); the visitor charts
   in Traffic & Visitors / Geography are js/admin/dashboard.js's own, which ask window.dbInsights.rangeQs() for their dates.
   Money is shown to administrators and managers only - the server leaves it out for anyone else, and the Finance tab is hidden.
   Every chart is drawn with dashboard.js's dbApexBase() / accent colours, so it follows the portal's theme and House Accent. */
(function () {
    'use strict';

    var state = { range: '30d', from: '', to: '', resolved: null, seesMoney: true, financeKey: null, charts: {} };

    function $id(id) { return document.getElementById(id); }
    function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
    function zar(n) {
        if (n == null) return '—';
        var v = Math.round(Number(n) * 100) / 100;
        return (v < 0 ? '-R ' : 'R ') + Math.abs(v).toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    }
    function count(n) { return n == null ? '—' : Number(n).toLocaleString('en-ZA'); }
    function apexBase() { return typeof dbApexBase === 'function' ? dbApexBase() : {}; }
    function accents(n) { return typeof dbAccentShades === 'function' ? dbAccentShades(n) : ['#D4AF37', '#E8C14B', '#9A7B2C']; }

    function queryString() {
        var q = 'range=' + encodeURIComponent(state.range);
        if (state.range === 'custom') q += '&from=' + encodeURIComponent(state.from) + '&to=' + encodeURIComponent(state.to);
        return q;
    }
    function getJson(url) {
        return fetch(url, { credentials: 'same-origin', cache: 'no-store' }).then(function (r) {
            return r.json().catch(function () { return {}; }).then(function (j) { return { ok: r.ok, status: r.status, body: j }; });
        });
    }

    // ---------------------------------------------------------------- cards

    // change: % against the previous equivalent period; lowerIsBetter flips the colour (refunds, expenses)
    function changePill(change, lowerIsBetter) {
        if (change == null) return '<span class="db-change db-change--none" title="Nothing to compare with in the previous period">no comparison</span>';
        var up = change > 0, good = lowerIsBetter ? !up : up;
        if (change === 0) return '<span class="db-change db-change--flat">0% vs previous</span>';
        return '<span class="db-change ' + (good ? 'db-change--good' : 'db-change--bad') + '">' + (up ? '▲ ' : '▼ ') + Math.abs(change) + '% vs previous</span>';
    }
    // a metric card: label, value, (change), tooltip explaining the figure, optional small print
    function card(o) {
        return '<div class="db-metric' + (o.tone ? ' db-metric--' + o.tone : '') + '">' +
            '<div class="db-metric__head"><span class="db-metric__label">' + esc(o.label) + '</span>' +
            (o.tip ? '<span class="db-metric__tip" tabindex="0" role="img" aria-label="' + esc(o.tip) + '" title="' + esc(o.tip) + '"><i class="fa-solid fa-circle-info" aria-hidden="true"></i></span>' : '') + '</div>' +
            '<div class="db-metric__value">' + o.value + '</div>' +
            (o.change !== undefined ? changePill(o.change, o.lowerIsBetter) : '') +
            (o.small ? '<div class="db-metric__small">' + o.small + '</div>' : '') +
            '</div>';
    }
    function group(title, note, cardsHtml) {
        return '<section class="db-group"><div class="db-group__head"><h3>' + esc(title) + '</h3>' + (note ? '<p class="db-card-note">' + note + '</p>' : '') + '</div>' +
            '<div class="db-metric-grid" style="' + gridCols(cardsHtml) + '">' + cardsHtml + '</div></section>';
    }
    // balanced columns per screen width (at most 6 / 4 / 3): 11 cards make rows of 6 + 5, never 7 + 4, and the cards stretch to fill the row
    function gridCols(cardsHtml) {
        var n = (cardsHtml.match(/class="db-metric[ "]/g) || []).length || 1;
        return [6, 4, 3].map(function (max) { return '--db-cols-' + max + ':' + Math.ceil(n / Math.ceil(n / max)); }).join(';');
    }
    function rankList(rows, valueFmt, subFmt, empty) {
        if (!rows || !rows.length) return '<div class="db-rank-empty">' + esc(empty || 'Nothing in this period.') + '</div>';
        var max = rows.reduce(function (m, r) { return Math.max(m, Math.abs(r.value)); }, 0) || 1;
        return '<div class="db-rank-list">' + rows.map(function (r, i) {
            var pct = Math.max(4, Math.round((Math.abs(r.value) / max) * 100));
            return '<div class="db-rank-item"><span class="db-rank-idx">' + (i + 1) + '</span><span class="db-rank-main"><span class="db-rank-label">' + esc(r.label) + '</span>' +
                '<span class="db-rank-bar" style="--db-rank-pct:' + pct + '%"></span></span><span class="db-rank-value">' + valueFmt(r.value) +
                (subFmt ? '<small>' + subFmt(r) + '</small>' : '') + '</span></div>';
        }).join('') + '</div>';
    }
    function panel(title, icon, body, note) {
        return '<div class="atl-card atl-card--flush db-panel-card"><div class="atl-card-header"><h3><i class="fa-solid ' + icon + '" style="color:var(--atl-amber);margin-right:8px;" aria-hidden="true"></i>' + esc(title) + '</h3></div>' +
            '<div class="atl-card-body">' + (note ? '<p class="db-card-note">' + note + '</p>' : '') + body + '</div></div>';
    }

    // ---------------------------------------------------------------- Overview

    function renderOverview(d) {
        var w = d.website, b = d.business;
        var html = group('Website', 'Counted by the site\'s own visitor tracker. HTTP requests and bandwidth come from Cloudflare (Performance &amp; Security tab).',
            card({ label: 'Unique visitors', value: count(w.visitors.value), change: w.visitors.change, tip: 'Different browsers that visited (one person on a phone and a laptop counts twice).' }) +
            card({ label: 'Visits', value: count(w.sessions.value), change: w.sessions.change, tip: 'Separate visits: a visit ends after 30 minutes without activity.' }) +
            card({ label: 'Page views', value: count(w.pageviews.value), change: w.pageviews.change, tip: 'Pages loaded. The site is one page, so this is close to the number of visits.' })
        );
        var biz = '';
        if (d.seesMoney) {
            biz += card({ label: 'Revenue received', value: zar(b.revenue.value), change: b.revenue.change, tip: 'Money actually received in this period: booking payments and ticket sales, minus refunds. Invoices sent are not counted until they are paid.' });
            biz += card({ label: 'Payments received', value: zar(b.payments.value), change: b.payments.change, tip: 'Booking payments plus ticket sales in this period, before refunds.' });
            biz += card({ label: 'Owed to you', value: zar(b.outstanding.value), tip: 'What clients still owe on accepted and confirmed bookings, as of today (not limited to the period).', small: 'as of today' });
        }
        biz += card({ label: 'Booking enquiries', value: count(b.enquiries.value), change: b.enquiries.change, tip: 'New booking requests received in this period.' });
        biz += card({ label: 'Bookings confirmed', value: count(b.confirmedBookings.value), change: b.confirmedBookings.change, tip: 'Bookings that became confirmed in this period.' });
        biz += card({ label: 'Tickets sold', value: count(b.ticketsSold.value), change: b.ticketsSold.change, tip: 'Show tickets paid for in this period (refunded and complimentary tickets not counted).' });
        $id('dbOverview').innerHTML = html + '<div id="dbOverviewCf"></div>' + group('Business', null, biz);
    }

    // ---------------------------------------------------------------- Finance

    var METHOD_LABEL = { payfast: 'PayFast (card / instant EFT)', eft: 'EFT / bank transfer', cash: 'Cash', other: 'Other' };
    var QUOTE_LABEL = { draft: 'Draft', sent: 'Sent - awaiting the client', accepted: 'Accepted', declined: 'Declined', expired: 'Expired', rejected: 'Declined' };
    var INVOICE_LABEL = { DRAFT: 'Draft', SENT: 'Sent - unpaid', PAID: 'Paid', OVERDUE: 'Overdue', PARTIAL: 'Part paid', PARTIALLY_PAID: 'Part paid' };

    function renderFinance(f) {
        var o = f.overview, tk = f.tickets, bk = f.bookings, p = f.payments;
        var html = '';
        // A. the headline figures
        var a = card({ label: 'Total revenue received', tone: 'lead', value: zar(o.revenue.value), change: o.revenue.change, tip: 'Money received in the period, net of refunds: booking payments + ticket sales. Each rand is counted once.' }) +
            card({ label: 'Bookings', value: zar(o.bookingRevenue.value), change: o.bookingRevenue.change, tip: 'Booking payments received minus booking refunds. Manual adjustments and payments flagged as duplicates are not money and are left out.' }) +
            card({ label: 'Ticket sales', value: zar(o.ticketRevenue.value), change: o.ticketRevenue.change, tip: 'Show tickets paid for, minus ticket refunds. Complimentary tickets are R0.' }) +
            card({ label: 'Payments received', value: zar(o.paymentsReceived.value), change: o.paymentsReceived.change, tip: 'Everything paid in, before refunds.' }) +
            card({ label: 'Refunds paid out', value: zar(o.refunds.value), tip: 'Booking and ticket refunds recorded in the period. Already taken off the revenue above.' }) +
            card({ label: 'Invoiced', value: zar(o.invoiced.value), change: o.invoiced.change, tip: 'Invoices issued in the period (void invoices excluded). An invoice is a request for money, not money received.', small: count(o.invoiceCount) + ' invoice' + (o.invoiceCount === 1 ? '' : 's') }) +
            card({ label: 'Owed to you', value: zar(o.outstanding.value), tip: 'Still owed on accepted and confirmed bookings, as of today.', small: 'as of today' }) +
            card({ label: 'Unpaid invoices', value: zar(o.openInvoices.value), tip: 'Invoices sent and not yet paid, as of today.', small: count(o.openInvoices.count) + ' open · as of today' }) +
            card({ label: 'Overdue invoices', tone: o.overdueInvoices.count ? 'warn' : '', value: zar(o.overdueInvoices.value), tip: 'Unpaid invoices past their due date, as of today.', small: count(o.overdueInvoices.count) + ' overdue · as of today' });
        if (o.expenses) {
            a += card({ label: 'Expenses', value: zar(o.expenses.value), change: o.expenses.change, lowerIsBetter: true, tip: 'Expenses recorded in Finance for the period.' }) +
                 card({ label: 'Net profit', tone: o.netProfit.value < 0 ? 'warn' : '', value: zar(o.netProfit.value), change: o.netProfit.change, tip: 'Revenue received minus recorded expenses. Only as complete as the expenses captured in Finance.' });
        }
        html += group('Financial overview', o.expenses ? null : 'Net profit is not shown: no expenses have been recorded in Finance yet.', a);

        // B. revenue over time
        html += '<div class="db-pair">' +
            panel('Revenue over time', 'fa-chart-column', '<div id="dbFinSeries" class="db-chart"></div>', 'Money received in the period, bookings and tickets, net of refunds.') +
            panel('Last 12 months', 'fa-calendar', '<div id="dbFinMonthly" class="db-chart"></div>', 'Month by month - bookings vs tickets.') + '</div>';
        html += '<div class="db-pair">' +
            panel('Revenue by event type', 'fa-tags', rankList(f.byCategory, zar), null) +
            panel('Top clients', 'fa-user-tie', rankList(f.byClient, zar), 'Money received in the period.') + '</div>';

        // C. bookings and sales
        var c = bk.cohort;
        var funnel = [
            ['Enquiries received', c.enquiries], ['Quoted', c.quoted], ['Quote accepted', c.accepted], ['Confirmed', c.confirmed], ['Paid (any amount)', c.paid]
        ];
        var fmax = Math.max(1, c.enquiries);
        var funnelHtml = '<div class="db-funnel">' + funnel.map(function (s) {
            var pct = Math.round((s[1] / fmax) * 100);
            return '<div class="db-funnel__row"><span class="db-funnel__label">' + esc(s[0]) + '</span><span class="db-funnel__bar"><span style="width:' + Math.max(2, pct) + '%"></span></span><span class="db-funnel__n">' + count(s[1]) + (c.enquiries ? ' <small>' + pct + '%</small>' : '') + '</span></div>';
        }).join('') + '</div>' + (c.cancelled ? '<p class="db-card-note">' + count(c.cancelled) + ' of these enquiries were cancelled.</p>' : '');
        html += group('Bookings and sales', null,
            card({ label: 'Conversion', value: bk.conversion == null ? '—' : bk.conversion + '%', tip: 'Of the enquiries received in the period, the share that has been confirmed so far.' }) +
            card({ label: 'Average booking value', value: zar(bk.averageValue), tip: 'The agreed total of bookings confirmed in the period.' }) +
            card({ label: 'Confirmed in period', value: count(bk.period.confirmed), change: pct(bk.period.confirmed, bk.period.previous.confirmed), tip: 'Bookings confirmed in the period (whenever they were enquired).' }) +
            card({ label: 'Cancelled in period', value: count(bk.period.cancelled), lowerIsBetter: true, change: pct(bk.period.cancelled, bk.period.previous.cancelled), tip: 'Bookings cancelled in the period.' }));
        html += panel('From enquiry to payment', 'fa-filter', funnelHtml, 'What became of the ' + count(c.enquiries) + ' enquir' + (c.enquiries === 1 ? 'y' : 'ies') + ' received in this period.');

        // D. payments
        var methodsHtml = rankList(p.methods.filter(function (m) { return m.count > 0; }).map(function (m) { return { label: METHOD_LABEL[m.method], value: m.value, count: m.count }; }), zar,
            function (r) { return count(r.count) + ' payment' + (r.count === 1 ? '' : 's'); }, 'No booking payments in this period.');
        var waiting = '<ul class="db-facts">' +
            '<li><strong>' + count(p.eftAwaitingCheck.count) + '</strong> proof' + (p.eftAwaitingCheck.count === 1 ? '' : 's') + ' of payment awaiting checking (' + zar(p.eftAwaitingCheck.value) + ' claimed) - not counted until approved <small>as of today</small></li>' +
            '<li><strong>' + count(p.eftRejected) + '</strong> proof' + (p.eftRejected === 1 ? '' : 's') + ' of payment rejected or sent back in the period</li>' +
            '<li><strong>' + count(p.ticketCheckoutsOpen) + '</strong> ticket checkout' + (p.ticketCheckoutsOpen === 1 ? '' : 's') + ' still open at PayFast <small>as of today</small></li>' +
            '<li><strong>' + count(p.ticketPaymentsFailed) + '</strong> ticket payment' + (p.ticketPaymentsFailed === 1 ? '' : 's') + ' failed in the period</li>' +
            '<li><strong>' + zar(p.refunds) + '</strong> refunded in the period</li>' +
            '<li><strong>' + zar(p.outstanding) + '</strong> still owed on bookings <small>as of today</small></li></ul>';
        html += '<div class="db-pair">' + panel('Booking payments by method', 'fa-credit-card', '<div id="dbFinMethods" class="db-chart db-chart--donut"></div>' + methodsHtml) +
            panel('Pending, failed and refunded', 'fa-hourglass-half', waiting, 'PayFast records completed booking payments only, so abandoned booking checkouts are not listed.') + '</div>';

        // E. quotations and invoices
        var q = f.documents.quotes.map(function (r) { return { label: QUOTE_LABEL[r.status] || r.status, value: r.value, n: r.count }; });
        var inv = f.documents.invoices.map(function (r) { return { label: INVOICE_LABEL[r.status] || r.status, value: r.value, n: r.count }; });
        var nsub = function (r) { return count(r.n) + ' document' + (r.n === 1 ? '' : 's'); };
        html += '<div class="db-pair">' + panel('Quotations issued', 'fa-file-signature', rankList(q, zar, nsub, 'No quotations in this period.'), 'Current versions only - a revised quotation replaces the one before it.') +
            panel('Invoices issued', 'fa-file-invoice', rankList(inv, zar, nsub, 'No invoices in this period.') + (f.documents.averageInvoice != null ? '<p class="db-card-note">Average invoice: ' + zar(f.documents.averageInvoice) + '</p>' : ''), 'Status as it stands today.') + '</div>';

        // F. tickets
        html += group('Ticket sales', 'Kept apart from booking money and added to the totals once.',
            card({ label: 'Ticket sales (gross)', value: zar(tk.gross), tip: 'Orders paid in the period, before refunds.', small: count(tk.orders) + ' order' + (tk.orders === 1 ? '' : 's') }) +
            card({ label: 'Ticket refunds', value: zar(tk.refunds), tip: 'Ticket orders refunded in the period.', small: count(tk.refundedOrders) + ' order' + (tk.refundedOrders === 1 ? '' : 's') }) +
            card({ label: 'Net ticket revenue', tone: 'lead', value: zar(tk.net), tip: 'Gross ticket sales minus ticket refunds.' }) +
            card({ label: 'Tickets sold', value: count(tk.ticketsSold), tip: 'Paid tickets still valid (refunded ones not counted).', small: count(tk.complimentary) + ' complimentary' }) +
            (tk.refundDue.count ? card({ label: 'Refunds still to pay', tone: 'warn', value: zar(tk.refundDue.value), tip: 'Late payments for shows that had sold out: the money came in but no tickets were issued, so it must be refunded.', small: count(tk.refundDue.count) + ' order(s) · as of today' }) : ''));
        html += '<div class="db-pair">' + panel('By show', 'fa-masks-theater', rankList(tk.byEvent, zar, function (r) { return count(r.tickets) + ' tickets'; }, 'No ticket sales in this period.')) +
            panel('By ticket type', 'fa-ticket', rankList(tk.byTier, zar, function (r) { return count(r.tickets) + ' tickets'; }, 'No ticket sales in this period.')) + '</div>';

        $id('dbFinance').innerHTML = html;
        drawFinanceCharts(f);
    }
    function pct(c, p) { return p ? Math.round(((c - p) / p) * 1000) / 10 : null; }

    function bucketLabel(k, granularity) {
        if (/^\d{4}-\d{2}$/.test(k)) return new Date(k + '-01T00:00:00').toLocaleDateString('en-ZA', { month: 'short', year: 'numeric' });
        return new Date(k + 'T00:00:00').toLocaleDateString('en-ZA', { day: 'numeric', month: 'short' });
    }
    function chart(id, opts) {
        var el = $id(id);
        if (!el || typeof ApexCharts === 'undefined') return;
        if (state.charts[id]) { try { state.charts[id].destroy(); } catch (e) {} }
        var base = apexBase();
        var o = Object.assign({}, base, opts, { chart: Object.assign({}, base.chart || {}, opts.chart || {}) });
        state.charts[id] = new ApexCharts(el, o);
        state.charts[id].render();
    }
    function drawFinanceCharts(f) {
        var money = { formatter: function (v) { return zar(v); } };
        var colours = accents(3);
        chart('dbFinSeries', {
            chart: { type: 'bar', height: 260, stacked: true },
            series: [{ name: 'Bookings', data: f.series.map(function (r) { return r.bookings; }) }, { name: 'Tickets', data: f.series.map(function (r) { return r.tickets; }) }],
            xaxis: { categories: f.series.map(function (r) { return bucketLabel(r.bucket); }) },
            yaxis: { labels: money }, tooltip: { y: money }, dataLabels: { enabled: false }, colors: [colours[0], colours[2]],
            noData: { text: 'No money received in this period' }
        });
        chart('dbFinMonthly', {
            chart: { type: 'bar', height: 260, stacked: true },
            series: [{ name: 'Bookings', data: f.monthly.map(function (r) { return r.bookings; }) }, { name: 'Tickets', data: f.monthly.map(function (r) { return r.tickets; }) }],
            xaxis: { categories: f.monthly.map(function (r) { return bucketLabel(r.bucket); }) },
            yaxis: { labels: money }, tooltip: { y: money }, dataLabels: { enabled: false }, colors: [colours[0], colours[2]],
            noData: { text: 'No money received in the last 12 months' }
        });
        var m = f.payments.methods.filter(function (x) { return x.value > 0; });
        chart('dbFinMethods', {
            chart: { type: 'donut', height: 220 },
            series: m.map(function (x) { return x.value; }), labels: m.map(function (x) { return METHOD_LABEL[x.method]; }),
            colors: accents(4), tooltip: { y: money }, legend: { position: 'bottom' }, dataLabels: { enabled: false },
            noData: { text: 'No booking payments in this period' }
        });
    }

    // ---------------------------------------------------------------- Traffic & Visitors / Geography (tracker.js: consenting visitors)

    function journey(steps) {
        var top = Math.max(1, steps[0].visits);
        return '<div class="db-funnel">' + steps.map(function (s) {
            var pct = Math.round((s.visits / top) * 100);
            return '<div class="db-funnel__row"><span class="db-funnel__label">' + esc(s.label) + '</span><span class="db-funnel__bar"><span style="width:' + Math.max(2, pct) + '%"></span></span>' +
                '<span class="db-funnel__n">' + count(s.visits) + (steps[0].visits ? ' <small>' + pct + '%</small>' : '') + '</span></div>';
        }).join('') + '</div>';
    }
    function mins(secs) {
        if (secs == null) return '—';
        var m = Math.floor(secs / 60), s = secs % 60;
        return m ? m + 'm ' + s + 's' : s + 's';
    }
    function loadTraffic() {
        var qs = window.dbInsights.rangeQs();
        if (!qs) return;
        var mix = $id('dbTrafficMix'), extra = $id('dbTrafficExtra'), geo = $id('dbGeoExtra');
        if (mix) Promise.all([getJson('/api/admin/analytics/visitor-mix?' + qs), getJson('/api/admin/analytics/consent?' + qs)]).then(function (res) {
            var r = res[0], d = r.body, c = res[1].body;
            if (!r.ok || !d.success) { mix.innerHTML = ''; return; }
            // the cookie pop-up's answers (anonymous, counted for everyone) - how much of the traffic the figures below can see
            var consent = !res[1].ok || !c.success ? '' : group('Cookie choices', 'Every answer to the cookie pop-up, counted anonymously - also for visitors who decline tracking. Only the "yes" visitors appear in the figures below.',
                card({ label: 'Said yes to analytics', value: count(c.analyticsYes), tip: 'Answers that switched analytics on (Accept all, or analytics ticked in their own selection).', small: c.yesShare == null ? '' : c.yesShare + '% of answers' }) +
                card({ label: 'Said no to analytics', value: count(c.analyticsNo), tip: 'Answers that left analytics off. These visitors are not tracked at all.', small: c.yesShare == null ? '' : Math.round((100 - c.yesShare) * 10) / 10 + '% of answers' }) +
                card({ label: 'Button pressed', value: count(c.answers), tip: 'All answers to the pop-up, by the button used.', small: 'Accept all ' + count(c.byChoice.accept_all) + ' · Reject ' + count(c.byChoice.reject_all) + ' · Own choice ' + count(c.byChoice.custom) }) +
                card({ label: 'Changed their mind', value: count(c.changes), tip: 'Answers given later through "Cookie Settings" in the footer, after a first answer.', small: count(c.changedToNo) + ' switched analytics off' }));
            mix.innerHTML = consent + group('Who visited', null,
                card({ label: 'New visitors', value: count(d.new), tip: 'First visit from this browser in the period. A cleared cookie or another device counts as new.' }) +
                card({ label: 'Returning visitors', value: count(d.returning), tip: 'Had visited before the period began (on this browser).' }) +
                card({ label: 'Average visit', value: mins(d.avgVisitSeconds), tip: 'How long a visit lasted, on average (time with the page open and in view).' }) +
                card({ label: 'Engaged visits', value: d.engagedShare == null ? '—' : d.engagedShare + '%', tip: 'Visits that lasted 30 seconds or more.', small: count(d.engagedVisits) + ' of ' + count(d.visits) + ' visits' }) +
                (d.browsers.length ? card({ label: 'Top browser', value: esc(d.browsers[0].name), tip: 'The browser used for most visits.', small: d.browsers.slice(1, 4).map(function (b) { return esc(b.name) + ' ' + count(b.visits); }).join(' · ') }) : ''));
        });
        if (extra) Promise.all([getJson('/api/admin/analytics/sections?' + qs), getJson('/api/admin/analytics/interactions?' + qs)]).then(function (res) {
            var sec = res[0].body, act = res[1].body;
            if (!res[0].ok || !sec.success || !res[1].ok || !act.success) { extra.innerHTML = ''; return; }
            var secRows = sec.rows.map(function (r) { return { label: r.label, value: r.visits, share: r.share }; });
            var secHtml = sec.rows.some(function (r) { return r.visits; })
                ? rankList(secRows, count, function (r) { return r.share == null ? '' : r.share + '% of visits'; })
                : '<div class="db-rank-empty">No section views recorded yet in this period. They are counted from this update on.</div>';
            var acts = act.rows.filter(function (r) { return r.count; }).sort(function (a, b) { return b.count - a.count; });
            var actHtml = acts.length ? rankList(acts.map(function (r) { return { label: r.label, value: r.count, visits: r.visits }; }), count, function (r) { return count(r.visits) + ' visit' + (r.visits === 1 ? '' : 's'); })
                : '<div class="db-rank-empty">Nothing recorded yet in this period.</div>';
            var src = act.bookingSources.length ? rankList(act.bookingSources.map(function (r) { return { label: r.label, value: r.count }; }), count) : '<div class="db-rank-empty">The booking form was not opened in this period.</div>';
            extra.innerHTML =
                '<div class="db-pair">' +
                    panel('Sections people look at', 'fa-layer-group', secHtml, 'Top to bottom of the page: how many visits reached each section (on screen for a second). The site is one page, so this replaces page views.') +
                    panel('What people did', 'fa-hand-pointer', actHtml, 'Each action, and in how many visits it happened.') +
                '</div>' +
                '<div class="db-pair">' +
                    panel('Booking enquiries: where people drop off', 'fa-route', journey(act.booking), 'Visits that got to each step of the booking form.') +
                    panel('Tickets: from event to payment', 'fa-ticket', journey(act.tickets), 'Visits that got to each step of buying tickets.') +
                '</div>' +
                panel('Which "Book Me" buttons are used', 'fa-arrow-pointer', src, 'Where the booking form was opened from.');
        });
        if (geo) getJson('/api/admin/analytics/cities?' + qs).then(function (r) {
            var d = r.body;
            if (!r.ok || !d.success) { geo.innerHTML = ''; return; }
            var rows = d.rows.map(function (c) { return { label: c.city + (c.code && c.code !== 'ZZ' ? ' (' + c.code + ')' : ''), value: c.visitors, visits: c.visits }; });
            geo.innerHTML = panel('Top cities', 'fa-city', rankList(rows, count, function (c) { return count(c.visits) + ' visit' + (c.visits === 1 ? '' : 's'); }, 'No city data yet in this period - cities are recorded from this update on.'),
                'Worked out from the visitor\'s internet address (which is then discarded), so a city can be approximate - often the nearest big city of the internet provider.');
        });
    }

    // ---------------------------------------------------------------- Cloudflare (all traffic, no cookies)

    function bytes(n) {
        if (n == null) return '—';
        var u = ['B', 'KB', 'MB', 'GB', 'TB'], i = 0, v = Number(n);
        while (v >= 1000 && i < u.length - 1) { v /= 1000; i++; }
        return (i ? v.toFixed(v >= 100 ? 0 : 1) : v) + ' ' + u[i];
    }
    function cfChange(cur, prev) { return prev == null ? undefined : (prev ? Math.round(((cur - prev) / prev) * 1000) / 10 : null); }

    var CONNECT_STEPS = '<ol class="db-steps">' +
        '<li>In Cloudflare, open <strong>My Profile → API Tokens → Create Token</strong>, and choose <strong>Create Custom Token</strong>.</li>' +
        '<li>Name it e.g. <em>Website dashboard (read only)</em>. Permissions: <strong>Zone → Analytics → Read</strong> - nothing else.</li>' +
        '<li>Zone Resources: <strong>Include → Specific zone → thabisomhlongo.com</strong>. Create the token and copy it (Cloudflare shows it once).</li>' +
        '<li>Copy the <strong>Zone ID</strong> from the domain\'s <strong>Overview</strong> page in Cloudflare (right-hand column, under API).</li>' +
        '<li>On Render, open the website service → <strong>Environment</strong> and add <code>CLOUDFLARE_API_TOKEN</code> (the token) and <code>CLOUDFLARE_ZONE_ID</code> (the zone ID). Save - Render restarts the site.</li>' +
        '</ol><p class="db-card-note">The token can only read statistics: it cannot change anything in Cloudflare. It stays on the server and is never sent to a browser. Do not paste it into an e-mail or chat.</p>';

    function renderCloudflare(d) {
        var perf = $id('dbPerf'), geo = $id('dbGeoCf'), ov = $id('dbOverviewCf');
        if (!d.connected) {
            if (perf) perf.innerHTML = '<div class="atl-card db-connect-card"><div class="atl-card-body"><h3><i class="fa-brands fa-cloudflare" aria-hidden="true"></i> Connect Cloudflare</h3>' +
                '<p>Bandwidth, caching, HTTP requests, response codes and bot traffic come from Cloudflare, which sits in front of the website and counts every request - no cookies, so visitors who decline analytics are included. ' +
                (d.partial ? '<strong>Only one of the two settings is on the server - both are needed.</strong>' : 'It needs a read-only key, added once:') + '</p>' + CONNECT_STEPS + '</div></div>';
            if (geo) geo.innerHTML = '';
            if (ov) ov.innerHTML = '';
            return;
        }
        if (d.error) {
            var msg = '<div class="atl-card db-connect-card"><div class="atl-card-body"><h3><i class="fa-brands fa-cloudflare" aria-hidden="true"></i> Cloudflare figures unavailable</h3><p>' + esc(d.error) + '</p>' +
                '<p class="db-card-note">If the key was refused, create a new one with the steps below and replace CLOUDFLARE_API_TOKEN on Render. If a range is refused, your Cloudflare plan does not keep data that far back - choose a shorter range.</p>' + CONNECT_STEPS + '</div></div>';
            if (perf) perf.innerHTML = msg;
            if (geo) geo.innerHTML = '';
            if (ov) ov.innerHTML = '';
            return;
        }
        var t = d.totals, p = d.previous || null;
        var prev = function (k) { return p ? p[k] : null; };
        // Overview: all traffic
        if (ov) ov.innerHTML = group('All traffic (Cloudflare)', 'Every request that reached the site, people and automated, counted without cookies.',
            card({ label: 'HTTP requests', value: count(t.requests), change: cfChange(t.requests, prev('requests')), tip: 'Every file fetched - the page, images, scripts, data. One visit makes many requests.' }) +
            card({ label: 'Bandwidth', value: bytes(t.bytes), change: cfChange(t.bytes, prev('bytes')), tip: 'Data sent to visitors in total (from Cloudflare\'s cache and from your server).' }) +
            card({ label: 'Visitors (Cloudflare)', value: count(t.uniquesSum), change: cfChange(t.uniquesSum, prev('uniquesSum')), tip: 'Different internet addresses, added up day by day - so a returning visitor counts once per day. Includes visitors who decline analytics and some automated traffic.' }) +
            card({ label: 'Page views (Cloudflare)', value: count(t.pageViews), change: cfChange(t.pageViews, prev('pageViews')), tip: 'Pages loaded as Cloudflare counts them, including by people who decline analytics.' }));

        // Performance & Security
        var series = d.series.map(function (r) { return { label: d.hourly ? new Date(r.bucket).toLocaleTimeString('en-ZA', { hour: '2-digit', minute: '2-digit' }) : bucketLabel(r.bucket), r: r }; });
        var html = group('Bandwidth and caching', 'Render counts the data your server sends: the less that has to come from the server, the further the hosting allowance goes.',
            card({ label: 'Total bandwidth', value: bytes(t.bytes), change: cfChange(t.bytes, prev('bytes')), tip: 'All data sent to visitors.' }) +
            card({ label: 'From your server (Render)', tone: 'lead', value: bytes(t.originBytes), change: cfChange(t.originBytes, prev('originBytes')), lowerIsBetter: true, tip: 'Data that had to come from the website server - this is what uses the hosting allowance.' }) +
            card({ label: 'Saved by caching', value: t.bandwidthSavedRatio == null ? '—' : t.bandwidthSavedRatio + '%', tip: 'Share of the data served straight from Cloudflare\'s cache, without asking your server.', small: bytes(t.cachedBytes) + ' from cache' }) +
            card({ label: 'Cache hit ratio', value: t.cacheHitRatio == null ? '—' : t.cacheHitRatio + '%', tip: 'Share of requests answered from Cloudflare\'s cache.', small: count(t.cachedRequests) + ' of ' + count(t.requests) + ' requests' }) +
            card({ label: 'HTTP requests', value: count(t.requests), change: cfChange(t.requests, prev('requests')), tip: 'Every file fetched.' }));
        html += '<div class="db-pair">' + panel('Bandwidth over time', 'fa-chart-area', '<div id="dbCfBytes" class="db-chart"></div>', 'Served from cache vs from your server.') +
            panel('Requests over time', 'fa-chart-column', '<div id="dbCfReqs" class="db-chart"></div>', 'Cached vs fetched from your server.') + '</div>';
        html += panel('What uses the bandwidth', 'fa-boxes-stacked', rankList(d.resources.map(function (r) { return { label: r.label, value: r.bytes, requests: r.requests }; }), bytes, function (r) { return count(r.requests) + ' requests'; }, 'No data in this period.'),
            'By type of file. Images are usually the biggest - smaller images save the most hosting allowance.');
        html += group('Website health', 'Server response times are not part of Cloudflare\'s free plan, so they are not shown.',
            card({ label: 'Error rate', tone: t.errorRate > 5 ? 'warn' : '', value: t.errorRate == null ? '—' : t.errorRate + '%', lowerIsBetter: true, change: p ? cfChange(t.errors4xx + t.errors5xx, (p.errors4xx || 0) + (p.errors5xx || 0)) : undefined, tip: 'Requests answered with an error (4xx or 5xx).' }) +
            card({ label: 'Not found / refused (4xx)', value: count(t.errors4xx), tip: 'Missing files, blocked or unauthorised requests. Bots probing for weak spots cause many of these.' }) +
            card({ label: 'Server errors (5xx)', tone: t.errors5xx ? 'warn' : '', value: count(t.errors5xx), tip: 'The website server failed to answer - e.g. while restarting after a deploy. Should stay near zero.' }));
        html += '<div class="db-pair">' + panel('Responses by type', 'fa-circle-check', rankList(d.statusClasses.map(function (s) { return { label: s.label, value: s.requests }; }), count)) +
            panel('Most common response codes', 'fa-list-ol', rankList(d.topStatuses.map(function (s) { return { label: String(s.code) + ' ' + (STATUS_TEXT[s.code] || ''), value: s.requests }; }), count)) + '</div>';
        html += group('Security and automated traffic', 'Cloudflare\'s view of who is asking. Automated traffic never shows in the visitor figures of the Traffic tab.',
            card({ label: 'Automated traffic', value: t.automatedShare == null ? '—' : t.automatedShare + '%', tip: 'Requests from search-engine crawlers, monitoring services, scanners and known bad hosts.', small: count(t.automatedRequests) + ' requests' }) +
            card({ label: 'Threats stopped', tone: t.threats ? 'warn' : '', value: count(t.threats), change: cfChange(t.threats, prev('threats')), lowerIsBetter: true, tip: 'Requests Cloudflare identified as attacks and blocked or challenged.' }));
        html += panel('Who is asking', 'fa-robot', rankList(d.traffic.map(function (x) { return { label: x.label + (x.automated ? ' (automated)' : ''), value: x.requests }; }), count, null, 'No data in this period.'));
        if (perf) perf.innerHTML = html;
        chart('dbCfBytes', {
            chart: { type: 'area', height: 240, stacked: true },
            series: [{ name: 'From cache', data: series.map(function (s) { return s.r.cachedBytes; }) }, { name: 'From your server', data: series.map(function (s) { return Math.max(0, s.r.bytes - s.r.cachedBytes); }) }],
            xaxis: { categories: series.map(function (s) { return s.label; }) }, yaxis: { labels: { formatter: bytes } }, tooltip: { y: { formatter: bytes } },
            dataLabels: { enabled: false }, colors: [accents(3)[0], accents(3)[2]]
        });
        chart('dbCfReqs', {
            chart: { type: 'bar', height: 240, stacked: true },
            series: [{ name: 'Cached', data: series.map(function (s) { return s.r.cachedRequests; }) }, { name: 'From your server', data: series.map(function (s) { return s.r.requests - s.r.cachedRequests; }) }],
            xaxis: { categories: series.map(function (s) { return s.label; }) }, dataLabels: { enabled: false }, colors: [accents(3)[0], accents(3)[2]]
        });

        // Geography: every request by country
        var total = d.countries.reduce(function (a, c) { return a + c.requests; }, 0) || 1;
        if (geo) geo.innerHTML = panel('All traffic by country (Cloudflare)', 'fa-globe', rankList(d.countries.map(function (c) {
            return { label: (typeof dbCountryFlag === 'function' ? dbCountryFlag(c.code) + ' ' : '') + (typeof dbCountryName === 'function' ? dbCountryName(c.code, c.code) : c.code), value: c.requests, share: Math.round((c.requests / total) * 1000) / 10, bytes: c.bytes };
        }), count, function (c) { return c.share + '% · ' + bytes(c.bytes); }, 'No data in this period.'), 'Requests from each country, people and automated - so crawlers based in the US often show up high here. The map above counts consenting visitors only.');
    }
    var STATUS_TEXT = { 200: 'OK', 204: 'No content', 206: 'Partial content', 301: 'Moved permanently', 302: 'Found (redirect)', 304: 'Not modified (cached copy still good)', 400: 'Bad request', 401: 'Not signed in', 403: 'Forbidden', 404: 'Not found', 405: 'Method not allowed', 429: 'Too many requests', 499: 'Visitor gave up', 500: 'Server error', 502: 'Bad gateway (server down / restarting)', 503: 'Busy / unavailable', 504: 'Server took too long' };

    function loadCloudflare() {
        getJson('/api/admin/insights/cloudflare?' + queryString()).then(function (r) {
            if (!r.ok || !r.body.success) { renderCloudflare({ connected: true, error: (r.body && r.body.error) || 'The Cloudflare figures could not be loaded just now.' }); return; }
            renderCloudflare(r.body);
        });
    }

    // ---------------------------------------------------------------- loading

    function setLabel(text, isError) {
        var el = $id('dbRangeLabel');
        if (!el) return;
        el.textContent = text;
        el.classList.toggle('db-range-label--error', !!isError);
    }
    function describe(r) {
        var span = fmtDate(r.from) + ' – ' + fmtDate(r.to);
        return 'Showing ' + (r.key === 'custom' ? span : r.label + ' (' + span + ')') + ', compared with ' + fmtDate(r.prevFrom) + ' – ' + fmtDate(r.prevTo) + '.';
    }
    function fmtDate(d) { return new Date(d + 'T00:00:00').toLocaleDateString('en-ZA', { day: 'numeric', month: 'short', year: 'numeric' }); }

    // Works the range out (via the Overview, which every role may load), fills Overview, and Finance when it is the open tab.
    function load() {
        state.financeKey = null;
        $id('dbOverview') && ($id('dbOverview').innerHTML = '<div class="db-rank-empty">Loading…</div>');
        return getJson('/api/admin/insights/overview?' + queryString()).then(function (r) {
            if (!r.ok || !r.body.success) {
                setLabel(r.body && r.body.error ? r.body.error : 'The figures could not be loaded just now.', true);
                $id('dbOverview').innerHTML = '<div class="db-rank-empty">Nothing to show for this range.</div>';
                throw new Error('overview');
            }
            state.resolved = r.body.range;
            state.seesMoney = !!r.body.seesMoney;
            var tab = $id('dbTabFinance');
            if (tab) tab.hidden = !state.seesMoney;
            setLabel(describe(r.body.range));
            renderOverview(r.body);
            loadTraffic();
            loadCloudflare();
            if (isOpen('dbPanelFinance')) loadFinance();
        });
    }
    function loadFinance() {
        if (!state.seesMoney || !state.resolved) return;
        var key = queryString();
        if (state.financeKey === key) return;
        state.financeKey = key;
        $id('dbFinance').innerHTML = '<div class="db-rank-empty">Loading…</div>';
        getJson('/api/admin/insights/finance?' + key).then(function (r) {
            if (!r.ok || !r.body.success) {
                state.financeKey = null;
                $id('dbFinance').innerHTML = '<div class="db-rank-empty">' + esc((r.body && r.body.error) || 'The finance figures could not be loaded just now.') + '</div>';
                return;
            }
            renderFinance(r.body);
        });
    }
    function isOpen(id) { var p = $id(id); return !!p && p.classList.contains('active'); }

    // The date selector: a preset reloads at once; "Custom range" shows two dates and an Apply button.
    document.addEventListener('change', function (e) {
        if (e.target.id !== 'dbRange') return;
        state.range = e.target.value;
        var custom = $id('dbRangeCustom');
        if (state.range === 'custom') {
            custom.hidden = false;
            if (!$id('dbRangeFrom').value && state.resolved) { $id('dbRangeFrom').value = state.resolved.from; $id('dbRangeTo').value = state.resolved.to; }
            return;
        }
        custom.hidden = true;
        if (typeof loadAnalyticsDashboard === 'function') loadAnalyticsDashboard();
    });
    document.addEventListener('click', function (e) {
        if (e.target.closest && e.target.closest('#dbRangeApply')) {
            state.from = $id('dbRangeFrom').value;
            state.to = $id('dbRangeTo').value;
            if (typeof loadAnalyticsDashboard === 'function') loadAnalyticsDashboard();
            return;
        }
        // Tabs (switched by the portal's shared atl-tab-bar code): load Finance on first view; charts drawn while their tab was hidden are
        // zero-width, so nudge ApexCharts to re-measure, and redraw the map once it can be measured.
        var btn = e.target.closest && e.target.closest('#dbTabBar .atl-tab-btn');
        if (!btn) return;
        var target = btn.getAttribute('data-um-tab');
        // The portal's shared tab code switches the panels (they share #dbInsights with the tab bar); this repeats it so exactly one is
        // open even if that code has not bound yet.
        document.querySelectorAll('#dbInsights > .um-panel').forEach(function (p) { p.classList.toggle('active', p.id === target); });
        setTimeout(function () {
            if (target === 'dbPanelFinance') loadFinance();
            if (target === 'dbPanelGeo' && typeof dbLoadCountryMap === 'function') dbLoadCountryMap();
            window.dispatchEvent(new Event('resize'));
        }, 30);
    });

    window.dbInsights = {
        load: load,
        // the exact dates every other dashboard card should use (after load() has worked them out)
        rangeQs: function () { return state.resolved ? 'range=custom&from=' + state.resolved.from + '&to=' + state.resolved.to : null; }
    };
})();
