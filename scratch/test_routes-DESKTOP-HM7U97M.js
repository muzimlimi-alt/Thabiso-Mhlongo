const http = require('http');

const endpoints = [
    '/api/admin/home-slider',
    '/api/admin/about-me',
    '/api/public/highlights',
    '/api/public/gallery',
    '/api/admin/social_links',
    '/api/admin/events',
    '/api/public/contact_info',
    '/api/admin/inquiries',
    '/api/admin/bookings/full',
    '/api/admin/calendar/events',
    '/api/admin/financials/stats',
    '/api/admin/newsletter/subscribers',
    '/api/admin/services',
    '/api/admin/policies',
    '/api/admin/email-logs?limit=1',
    '/api/admin/audit_log?limit=500',
    '/api/admin/settings',
    '/api/admin/users',
    '/api/public/branding',
    '/api/admin/social_embeds',
    '/api/admin/newsletter/drafts',
    '/api/admin/campaigns/unified?page=1&status=all&sort=date_desc&search=',
    '/api/admin/analytics/summary?period=30d',
    '/api/admin/analytics/visits-over-time?period=30d',
    '/api/admin/analytics/traffic-sources?period=30d',
    '/api/admin/analytics/devices?period=30d',
    '/api/admin/analytics/bookings-trend?period=30d',
    '/api/admin/analytics/todays-schedule',
    '/api/public/manager',
    '/api/admin/session',
    '/api/admin/bookings'
];

async function checkRoute(endpoint) {
    return new Promise((resolve) => {
        const req = http.request({
            host: 'localhost',
            port: 3000,
            path: endpoint,
            method: 'GET'
        }, (res) => {
            resolve({ endpoint, status: res.statusCode });
        });
        req.on('error', (err) => {
            resolve({ endpoint, status: 'ERROR', error: err.message });
        });
        req.end();
    });
}

async function run() {
    console.log('Probing endpoints...');
    for (const ep of endpoints) {
        const res = await checkRoute(ep);
        console.log(`[${res.status}] ${res.endpoint}${res.error ? ' - ' + res.error : ''}`);
    }
}

run();
