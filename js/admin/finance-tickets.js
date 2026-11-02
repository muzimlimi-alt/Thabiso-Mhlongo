/* Finance <- Event ticketing (lib/ticket-finance.js; GET /api/admin/ticketing/finance*).
   Two pieces, both read-only views of figures the server works out (nothing is recalculated here):
   (A) "Where the money came from": client bookings + event tickets + other, for the period chosen at the top of Finance (#ftsSources).
   (B) Finance -> "Ticket Sales" tab (#finTickets): ticket money (gross, refunds, fees, net), by category, by show, over time, upcoming shows
       (a projection, always apart from real money), what is NOT revenue, a reconciliation, and a drill-down show -> orders -> money trail.
   Loaded after js/admin/financials.js, which calls window.refreshFinanceTickets() once its own stats for the period are in. */
(function () {
    'use strict';

    var data = null, charts = {}, loading = null;

    function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
    function zar(n) { return 'R ' + (Number(n) || 0).toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
    function sast(iso) {
        if (!iso) return '';
        try { return new Date(iso).toLocaleString('en-ZA', { timeZone: 'Africa/Johannesburg', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }); } catch (e) { return iso; }
    }
    function day(iso) { try { return new Date(iso).toLocaleDateString('en-ZA', { timeZone: 'Africa/Johannesburg', day: 'numeric', month: 'short', year: 'numeric' }); } catch (e) { return iso || ''; } }
    function cssVar(name, fb) { var v = getComputedStyle(document.documentElement).getPropertyValue(name).trim(); return v || fb; }
    function monthLabel(m) { var p = String(m).split('-'); return p.length === 2 ? new Date(+p[0], +p[1] - 1, 1).toLocaleString('default', { month: 'short', year: '2-digit' }) : m; }
    function period() {
        if (window._finLastPeriod) return window._finLastPeriod;
        var n = new Date(); return { from: new Date(n.getFullYear(), n.getMonth(), 1).toISOString().slice(0, 10), to: n.toISOString().slice(0, 10) };
    }
    function pct(part, whole) { return whole > 0 ? Math.max(0, Math.round(part / whole * 100)) : 0; }

    var STATUS = { paid: ['Paid', 'atl-badge--paid'], refunded: ['Refunded', 'atl-badge--cancelled'], refund_owed: ['Refund owed', 'atl-badge--overdue'], pending: ['Pending', 'atl-badge--pending'], failed: ['Failed', 'atl-badge--cancelled'], expired: ['Abandoned', 'atl-badge--unpaid'] };
    function badge(s) { var b = STATUS[s] || [s, 'atl-badge--info']; return '<span class="atl-badge ' + b[1] + '">' + esc(b[0]) + '</span>'; }

    // ------------------------------------------------------------------ the data
    function fetchData() {
        var p = period();
        loading = apiCall('/api/admin/ticketing/finance?date_from=' + p.from + '&date_to=' + p.to, 'GET').then(function (r) {
            if (r && r.success) { data = r; return r; }
            return null;
        }).catch(function () { return null; });
        return loading;
    }
    window.refreshFinanceTickets = function () {
        fetchData().then(function () {
            renderSources();
            if ($('#finTickets').hasClass('active') || $('#finTickets').is(':visible')) renderTab();
        });
    };

    // ------------------------------------------------------------------ (A) the consolidated strip
    function renderSources() {
        var el = document.getElementById('ftsSources');
        if (!el) return;
        if (!data) { el.innerHTML = ''; return; }
        var s = window._finLastStats || {};
        var t = data.totals, b = data.bookings;
        var main = (b.payfast || 0) + (b.eft || 0), other = (b.cash || 0) + (b.other || 0), tickets = t.net_revenue;
        var total = main + other + tickets;
        var expenses = Number(s.monthly_expenses) || 0, fees = t.fees || 0;
        var profit = total - expenses - fees;
        var parts = [
            { key: 'bookings', label: 'Client bookings', icon: 'fa-handshake', color: 'var(--atl-sage)', value: main, sub: 'PayFast ' + zar(b.payfast) + ' &middot; Bank transfer (EFT) ' + zar(b.eft) },
            { key: 'tickets', label: 'Event tickets', icon: 'fa-ticket', color: 'var(--atl-amber)', value: tickets, sub: 'Gross ' + zar(t.gross) + ' &minus; refunds ' + zar(t.refunded + t.refund_owed), link: true },
            { key: 'other', label: 'Other recorded payments', icon: 'fa-coins', color: 'var(--atl-blue)', value: other, sub: 'Cash ' + zar(b.cash) + ' &middot; Other ' + zar(b.other) }
        ];
        var bar = parts.map(function (x) { return x.value > 0 ? '<span class="fts-bar__seg" style="flex:' + x.value + '; background:' + x.color + ';" title="' + esc(x.label) + ' ' + zar(x.value) + '"></span>' : ''; }).join('');
        el.innerHTML =
            '<div class="fts-head"><div><div class="fts-eyebrow">All money in &middot; <span>' + esc(data.period.from) + ' &rarr; ' + esc(data.period.to) + '</span></div>' +
            '<div class="fts-total">' + zar(total) + '</div><div class="fts-note">Received from client bookings and direct ticket sales, after refunds. Pending, failed and abandoned payments are not counted.</div></div>' +
            '<div class="fts-profit"><div class="fts-eyebrow">Profit, all sources</div><div class="fts-profit__v" style="color:' + (profit >= 0 ? 'var(--atl-sage)' : 'var(--atl-clay)') + ';">' + zar(profit) + '</div>' +
            '<div class="fts-note">Revenue &minus; expenses ' + zar(expenses) + (fees ? ' &minus; PayFast ticket fees ' + zar(fees) : '') + '</div></div></div>' +
            '<div class="fts-bar" role="img" aria-label="Share of revenue by source">' + (bar || '<span class="fts-bar__seg" style="flex:1;background:var(--atl-line);"></span>') + '</div>' +
            '<div class="fts-grid">' + parts.map(function (x) {
                return '<div class="fts-src' + (x.link ? ' fts-src--link' : '') + '" style="--c:' + x.color + ';"' + (x.link ? ' data-fts-open="finTickets" tabindex="0" role="button" title="Open Ticket Sales"' : '') + '>' +
                    '<div class="fts-src__top"><i class="fa-solid ' + x.icon + '" aria-hidden="true"></i><span>' + x.label + '</span><b>' + pct(x.value, total) + '%</b></div>' +
                    '<div class="fts-src__v">' + zar(x.value) + '</div><div class="fts-src__sub">' + x.sub + '</div></div>';
            }).join('') +
            '<div class="fts-src fts-src--owed" style="--c:var(--atl-orange);"><div class="fts-src__top"><i class="fa-solid fa-hourglass-half" aria-hidden="true"></i><span>Still to come in / go out</span></div>' +
            '<div class="fts-src__sub"><div>Client balances owed to you: <b>' + zar(s.outstanding) + '</b></div><div>Refunds owed to ticket buyers: <b>' + zar(data.refunds.outstanding_now) + '</b>' + (data.refunds.outstanding_orders ? ' (' + data.refunds.outstanding_orders + ' order' + (data.refunds.outstanding_orders === 1 ? '' : 's') + ')' : '') + '</div>' +
            '<div>Upcoming ticket sales are a projection, kept on the Ticket Sales tab.</div></div></div></div>';
    }
    $(document).on('click keydown', '[data-fts-open]', function (e) {
        if (e.type === 'keydown' && e.key !== 'Enter' && e.key !== ' ') return;
        $('#finTabBar .atl-tab-btn[data-um-tab="' + this.getAttribute('data-fts-open') + '"]').trigger('click');
        var bar = document.getElementById('finTabBar'); if (bar && bar.scrollIntoView) bar.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });

    // ------------------------------------------------------------------ (B) the Ticket Sales tab
    function kpi(color, icon, label, value, sub) {
        return '<div class="fin-card" style="--c:' + color + ';"><div class="fin-card__top"><div class="fin-card__icon"><i class="fa-solid ' + icon + '"></i></div><div class="fin-card__label">' + label + '</div></div>' +
            '<div class="fin-card__value">' + value + '</div><div class="fin-card__sub">' + (sub || '') + '</div></div>';
    }
    function renderTab() {
        var el = document.getElementById('finTickets');
        if (!el) return;
        var host = el.querySelector('.fts-tab'); if (!host) return;
        if (!data) { host.innerHTML = '<p class="fts-empty">Ticket figures could not be loaded. Use Refresh Stats to try again.</p>'; return; }
        var t = data.totals, nr = data.not_revenue, rc = data.reconciliation;
        var feeSub = t.fees_unknown_orders ? 'known for ' + t.fees_known_orders + ' of ' + (t.fees_known_orders + t.fees_unknown_orders) + ' payments' : (t.fees_known_orders ? 'from PayFast, every payment' : 'PayFast sent no fee figures');
        var h = '';
        h += '<div class="fts-period">Ticket money for <b>' + esc(data.period.from) + ' &rarr; ' + esc(data.period.to) + '</b>. Only payments PayFast confirmed count; a refund comes off; complimentary tickets are never revenue.</div>';
        h += '<div class="fin-card-grid">' +
            kpi('var(--atl-amber)', 'fa-ticket', 'Gross ticket sales', zar(t.gross), t.orders + ' confirmed payment' + (t.orders === 1 ? '' : 's')) +
            kpi('var(--atl-clay)', 'fa-rotate-left', 'Refunds issued', zar(t.refunded), 'Recorded as refunded in this period&rsquo;s sales') +
            kpi('var(--atl-orange)', 'fa-hourglass-half', 'Refunds outstanding', zar(data.refunds.outstanding_now), data.refunds.outstanding_orders + ' order(s) paid but sold out &mdash; owed back (all time)') +
            kpi('var(--atl-sage)', 'fa-circle-check', 'Net ticket revenue', zar(t.net_revenue), 'Gross &minus; refunds') +
            kpi('var(--atl-blue)', 'fa-percent', 'PayFast fees', zar(t.fees), feeSub) +
            kpi('var(--atl-sage)', 'fa-wallet', 'Net receipts', zar(t.net_receipts), 'Net revenue &minus; known fees') +
            kpi('var(--atl-amber)', 'fa-people-group', 'Tickets sold', t.tickets_sold, (nr.complimentary_tickets ? nr.complimentary_tickets + ' complimentary (not revenue)' : 'Refunded tickets not counted')) +
            kpi('var(--atl-sage)', 'fa-receipt', 'Successful payments', t.orders, 'Confirmed by PayFast') +
            '</div>';
        h += '<div class="fts-notrev"><div class="fts-notrev__h"><i class="fa-solid fa-ban" aria-hidden="true"></i> Not revenue &mdash; never counted as received</div><div class="fts-notrev__row">' +
            '<span>' + badge('pending') + ' <b>' + nr.pending.orders + '</b> order(s) &middot; ' + zar(nr.pending.value) + ' <em>in a checkout right now</em></span>' +
            '<span>' + badge('failed') + ' <b>' + nr.failed.orders + '</b> &middot; ' + zar(nr.failed.value) + '</span>' +
            '<span>' + badge('expired') + ' <b>' + nr.abandoned.orders + '</b> &middot; ' + zar(nr.abandoned.value) + ' <em>(' + nr.abandoned.reached_checkout + ' reached PayFast)</em></span></div></div>';

        h += '<div class="fts-pair"><div class="atl-card atl-card--flush"><div class="atl-card-header"><h3><i class="fa-solid fa-chart-column" style="color:var(--atl-amber); margin-right:8px;"></i>Ticket revenue over 12 months</h3></div><div class="atl-card-body" style="padding:8px 12px 12px;"><div id="ftsTrendChart"></div></div></div>' +
            '<div class="atl-card atl-card--flush"><div class="atl-card-header"><h3><i class="fa-solid fa-ranking-star" style="color:var(--atl-amber); margin-right:8px;"></i>Shows compared (net revenue)</h3></div><div class="atl-card-body" style="padding:8px 12px 12px;"><div id="ftsEventChart"></div></div></div></div>';

        // by ticket category
        var maxTier = data.by_tier.reduce(function (m, x) { return Math.max(m, x.net_revenue); }, 0) || 1;
        h += '<div class="atl-card atl-card--flush fts-block"><div class="atl-card-header"><h3><i class="fa-solid fa-tags" style="color:var(--atl-amber); margin-right:8px;"></i>Revenue by ticket category</h3></div><div class="atl-card-body">' +
            (data.by_tier.length ? '<div class="table-responsive"><table class="table fts-table"><thead><tr><th>Category</th><th class="r">Tickets</th><th class="r">Gross</th><th class="r">Net of refunds</th><th class="fts-w"></th></tr></thead><tbody>' +
                data.by_tier.map(function (x) { return '<tr><td><b>' + esc(x.tier) + '</b></td><td class="r">' + x.tickets_sold + '</td><td class="r">' + zar(x.gross) + '</td><td class="r">' + zar(x.net_revenue) + '</td><td class="fts-w"><span class="fts-meter"><i style="width:' + pct(x.net_revenue, maxTier) + '%"></i></span></td></tr>'; }).join('') + '</tbody></table></div>'
                : '<p class="fts-empty">No confirmed ticket sales in this period.</p>') + '</div></div>';

        // by show, with drill-down
        h += '<div class="atl-card atl-card--flush fts-block"><div class="atl-card-header"><h3><i class="fa-solid fa-calendar-check" style="color:var(--atl-amber); margin-right:8px;"></i>By show <small class="fts-hint">select a show to see its orders</small></h3></div><div class="atl-card-body">' +
            (data.by_event.length ? '<div class="table-responsive"><table class="table fts-table fts-table--click"><thead><tr><th>Show</th><th class="r">Tickets</th><th class="r">Gross</th><th class="r">Refunds</th><th class="r">Net revenue</th><th class="r">PayFast fees</th><th class="r">Net receipts</th></tr></thead><tbody>' +
                data.by_event.map(function (x) {
                    return '<tr class="fts-ev" data-fts-event="' + x.event_id + '" tabindex="0" role="button" aria-expanded="false"><td><i class="fa-solid fa-chevron-right fts-chev" aria-hidden="true"></i> <b>' + esc(x.title) + '</b><div class="fts-sub">' + esc(day(x.starts)) + '</div></td><td class="r">' + x.tickets_sold + '</td><td class="r">' + zar(x.gross) + '</td><td class="r">' + zar(x.refunded + x.refund_owed) + '</td><td class="r"><b>' + zar(x.net_revenue) + '</b></td><td class="r">' + (x.fees_unknown_orders && !x.fees_known_orders ? '<span class="fts-sub">not known</span>' : zar(x.fees)) + '</td><td class="r">' + zar(x.net_receipts) + '</td></tr>' +
                        '<tr class="fts-drill" id="ftsDrill-' + x.event_id + '" hidden><td colspan="7"></td></tr>';
                }).join('') + '</tbody></table></div>' : '<p class="fts-empty">No ticket payments were confirmed in this period.</p>') + '</div></div>';

        // upcoming: a projection, visibly apart from money
        h += '<div class="atl-card atl-card--flush fts-block fts-proj"><div class="atl-card-header"><h3><i class="fa-solid fa-forward" style="color:var(--atl-blue); margin-right:8px;"></i>Upcoming shows <span class="atl-badge atl-badge--info">Projection &mdash; not revenue</span></h3></div><div class="atl-card-body">' +
            (data.upcoming.length ? '<div class="table-responsive"><table class="table fts-table"><thead><tr><th>Show</th><th class="r">Sold / capacity</th><th class="r">Received so far (real)</th><th class="r">In checkout now</th><th class="r">Still on sale</th><th class="r">If it sells out</th></tr></thead><tbody>' +
                data.upcoming.map(function (x) { return '<tr><td><b>' + esc(x.title) + '</b><div class="fts-sub">' + esc(day(x.starts)) + '</div></td><td class="r">' + x.sold + ' / ' + x.capacity + '</td><td class="r"><b>' + zar(x.actual_net_revenue) + '</b></td><td class="r fts-proj__n">' + zar(x.held_in_checkout) + '</td><td class="r fts-proj__n">' + zar(x.unsold_open_potential) + '</td><td class="r fts-proj__n">' + zar(x.projected_if_sold_out) + '</td></tr>'; }).join('') + '</tbody></table></div>' +
                '<p class="fts-sub" style="margin:8px 0 0;">&ldquo;Still on sale&rdquo; is seats left &times; price &mdash; a ceiling, not a forecast. Only the &ldquo;Received&rdquo; column is money in the bank.</p>'
                : '<p class="fts-empty">No upcoming show has tickets on sale.</p>') + '</div></div>';

        // reconciliation
        h += '<div class="atl-card atl-card--flush fts-block"><div class="atl-card-header"><h3><i class="fa-solid fa-scale-balanced" style="color:var(--atl-amber); margin-right:8px;"></i>Reconciliation &mdash; orders &harr; PayFast payments &harr; tickets ' +
            (rc.clean ? '<span class="atl-badge atl-badge--paid">All agree</span>' : '<span class="atl-badge atl-badge--overdue">' + rc.issues.length + ' to check</span>') + '</h3></div><div class="atl-card-body">' +
            '<p class="fts-sub" style="margin:0 0 8px;">Checked across all ' + rc.confirmed_orders + ' confirmed ticket order(s): each has a verified PayFast payment for the right amount, the right number of valid tickets (none left on a refunded order), and its payment is not also recorded against a booking.</p>' +
            (rc.clean ? '' : '<ul class="fts-issues">' + rc.issues.map(function (i) { return '<li><a href="#" data-fts-order="' + i.order_id + '">Order #' + i.order_id + '</a> &mdash; ' + esc(i.text) + '</li>'; }).join('') + '</ul>') + '</div></div>';

        host.innerHTML = h;
        drawCharts();
    }

    function drawCharts() {
        if (typeof ApexCharts === 'undefined' || !data) return;
        var fb = (typeof finApexBase === 'function') ? finApexBase() : { axisColor: '#b0b0b0', gridColor: 'rgba(255,255,255,0.08)', tooltip: 'dark', legend: '#b0b0b0' };
        var sage = cssVar('--atl-sage', '#7aa874'), clay = cssVar('--atl-clay', '#c4694f'), amber = cssVar('--atl-amber', '#D4AF37');
        var yfmt = function (v) { return v >= 1000 ? 'R' + (v / 1000).toFixed(0) + 'k' : 'R' + Math.round(v); };
        Object.keys(charts).forEach(function (k) { try { charts[k].destroy(); } catch (e) { /* gone */ } delete charts[k]; });
        var tr = data.trend, tel = document.getElementById('ftsTrendChart');
        if (tel) {
            if (!tr.length) tel.innerHTML = '<p class="fts-empty">No ticket sales in the last 12 months.</p>';
            else {
                charts.trend = new ApexCharts(tel, {
                    series: [{ name: 'Net revenue', data: tr.map(function (x) { return x.net_revenue; }) }, { name: 'Refunds', data: tr.map(function (x) { return x.refunded; }) }],
                    chart: { type: 'bar', height: 280, toolbar: { show: false }, background: 'transparent' }, colors: [sage, clay], plotOptions: { bar: { columnWidth: '55%', borderRadius: 3 } },
                    dataLabels: { enabled: false }, grid: { borderColor: fb.gridColor }, legend: { labels: { colors: fb.legend } },
                    xaxis: { categories: tr.map(function (x) { return monthLabel(x.month); }), labels: { style: { colors: fb.axisColor } } },
                    yaxis: { labels: { style: { colors: fb.axisColor }, formatter: yfmt } }, tooltip: { theme: fb.tooltip, y: { formatter: zar } }
                }); charts.trend.render();
            }
        }
        var ev = data.by_event.slice(0, 8), eel = document.getElementById('ftsEventChart');
        if (eel) {
            if (!ev.length) eel.innerHTML = '<p class="fts-empty">No shows with confirmed sales in this period.</p>';
            else {
                charts.ev = new ApexCharts(eel, {
                    series: [{ name: 'Net revenue', data: ev.map(function (x) { return x.net_revenue; }) }],
                    chart: { type: 'bar', height: Math.max(240, ev.length * 42 + 60), toolbar: { show: false }, background: 'transparent' }, colors: [amber], plotOptions: { bar: { horizontal: true, barHeight: '60%', borderRadius: 3 } },
                    dataLabels: { enabled: true, formatter: zar, style: { colors: ['#111'] } }, grid: { borderColor: fb.gridColor },
                    xaxis: { categories: ev.map(function (x) { return x.title.length > 26 ? x.title.slice(0, 25) + '…' : x.title; }), labels: { style: { colors: fb.axisColor }, formatter: yfmt } },
                    yaxis: { labels: { style: { colors: fb.axisColor } } }, tooltip: { theme: fb.tooltip, y: { formatter: zar } }
                }); charts.ev.render();
            }
        }
    }

    // ---- drill-down: show -> its orders -> one order's money trail
    function toggleEvent(row) {
        var id = row.getAttribute('data-fts-event'), drill = document.getElementById('ftsDrill-' + id);
        if (!drill) return;
        var open = !drill.hidden;
        drill.hidden = open; row.setAttribute('aria-expanded', open ? 'false' : 'true'); $(row).find('.fts-chev').toggleClass('fa-chevron-right', open).toggleClass('fa-chevron-down', !open);
        if (open || drill.getAttribute('data-loaded')) return;
        var cell = drill.firstElementChild; cell.innerHTML = '<span class="fts-sub"><i class="fa fa-spinner fa-spin"></i> Loading orders&hellip;</span>';
        apiCall('/api/admin/ticketing/finance/events/' + id + '/orders', 'GET').then(function (r) {
            var rows = (r && r.orders) || [];
            drill.setAttribute('data-loaded', '1');
            cell.innerHTML = rows.length ? '<table class="table fts-table fts-table--inner"><thead><tr><th>Order</th><th>Buyer</th><th class="r">Tickets</th><th class="r">Amount</th><th class="r">PayFast fee</th><th>Status</th><th>Paid</th></tr></thead><tbody>' +
                rows.map(function (o) {
                    return '<tr class="fts-ord" data-fts-order="' + o.id + '" tabindex="0" role="button"><td>#' + o.id + (o.complimentary ? ' <span class="atl-badge atl-badge--info">Complimentary</span>' : '') + '</td><td>' + esc(o.buyer || '') + '<div class="fts-sub">' + esc(o.email || '') + '</div></td><td class="r">' + o.tickets + '</td><td class="r">' + zar(o.amount) + '</td><td class="r">' + (o.fee === null ? '<span class="fts-sub">&mdash;</span>' : zar(o.fee)) + '</td><td>' + badge(o.status) + '</td><td>' + esc(sast(o.paid_at)) + '</td></tr>' +
                        '<tr class="fts-trail" id="ftsTrail-' + o.id + '" hidden><td colspan="7"></td></tr>';
                }).join('') + '</tbody></table>' : '<span class="fts-sub">No orders yet.</span>';
        });
    }
    function toggleOrder(row, scroll) {
        var id = row.getAttribute('data-fts-order');
        var trail = document.getElementById('ftsTrail-' + id);
        if (!trail) { openOrderOnly(id); return; }
        var open = !trail.hidden; trail.hidden = open;
        if (open || trail.getAttribute('data-loaded')) return;
        var cell = trail.firstElementChild; cell.innerHTML = '<span class="fts-sub"><i class="fa fa-spinner fa-spin"></i></span>';
        apiCall('/api/admin/ticketing/finance/orders/' + id, 'GET').then(function (r) { trail.setAttribute('data-loaded', '1'); cell.innerHTML = trailHtml(r && r.payment); });
    }
    function trailHtml(p) {
        if (!p) return '<span class="fts-sub">Not found.</span>';
        return '<div class="fts-trail__grid">' +
            '<div><span>Gross received</span><b>' + zar(p.gross) + '</b></div><div><span>PayFast fee</span><b>' + (p.fee === null ? 'not known' : zar(p.fee)) + '</b></div>' +
            '<div><span>Net receipt</span><b>' + (p.net_receipt === null ? '&mdash;' : zar(p.net_receipt)) + '</b></div><div><span>Refunded</span><b>' + zar(p.refunded) + '</b></div>' +
            '<div><span>Refund owed</span><b>' + zar(p.refund_owed) + '</b></div><div><span>PayFast payment id</span><b class="fts-mono">' + esc(p.pf_payment_id || '—') + '</b></div></div>' +
            (p.refund_note ? '<div class="fts-sub">Refund note: ' + esc(p.refund_note) + '</div>' : '') +
            '<div class="fts-sub" style="margin-top:6px;">PayFast notifications</div>' +
            (p.notifications.length ? '<ul class="fts-notes">' + p.notifications.map(function (n) { return '<li>' + esc(sast(n.at)) + ' &middot; ' + esc(n.status || '') + (n.amount === null ? '' : ' ' + zar(n.amount)) + ' &middot; ' + esc(n.source) + ' &middot; ' + (n.verified ? '<b style="color:var(--atl-sage)">verified</b>' : '<span style="color:var(--atl-clay)">not verified</span>') + (n.outcome ? ' &middot; ' + esc(n.outcome) : '') + '</li>'; }).join('') + '</ul>' : '<div class="fts-sub">None recorded.</div>') +
            '<div style="margin-top:8px;"><a href="#" class="atl-btn atl-btn--ghost" data-fts-ticketsales="' + p.order_id + '"><i class="fa-solid fa-ticket"></i> Open in Events &rarr; Ticket Sales</a></div>';
    }
    // an order that is not on screen (reconciliation list): show its trail in a small panel under the list
    function openOrderOnly(id) {
        var host = document.getElementById('ftsOrderPanel');
        if (!host) { host = document.createElement('div'); host.id = 'ftsOrderPanel'; host.className = 'fts-orderpanel'; document.querySelector('#finTickets .fts-tab').appendChild(host); }
        host.innerHTML = '<span class="fts-sub"><i class="fa fa-spinner fa-spin"></i></span>';
        apiCall('/api/admin/ticketing/finance/orders/' + id, 'GET').then(function (r) { host.innerHTML = '<h4 class="fts-orderpanel__h">Order #' + id + '</h4>' + trailHtml(r && r.payment); host.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); });
    }
    $(document).on('click keydown', '.fts-ev', function (e) { if (e.type === 'keydown' && e.key !== 'Enter' && e.key !== ' ') return; e.preventDefault(); toggleEvent(this); });
    $(document).on('click keydown', '.fts-ord', function (e) { if (e.type === 'keydown' && e.key !== 'Enter' && e.key !== ' ') return; e.preventDefault(); toggleOrder(this); });
    $(document).on('click', 'a[data-fts-order]', function (e) { e.preventDefault(); openOrderOnly(this.getAttribute('data-fts-order')); });
    $(document).on('click', '[data-fts-ticketsales]', function (e) {
        e.preventDefault();
        if (typeof window.switchTab === 'function') window.switchTab('eventsAdmin');
        setTimeout(function () { $('#eventsAdmin .atl-tab-btn[data-um-tab="evtPanelTickets"]').trigger('click'); }, 300);
    });

    // the tab opens -> load (or reuse what the period change already fetched)
    $(document).on('click', '#finTabBar .atl-tab-btn[data-um-tab="finTickets"]', function () {
        var host = document.querySelector('#finTickets .fts-tab');
        if (host && !host.getAttribute('data-ready')) host.innerHTML = '<p class="fts-empty"><i class="fa fa-spinner fa-spin"></i> Loading ticket sales&hellip;</p>';
        (data ? Promise.resolve(data) : fetchData()).then(function () { if (host) host.setAttribute('data-ready', '1'); renderTab(); });
    });
    $(document).on('click', '#ftsRefresh', function () { window.refreshFinanceTickets(); });
})();
