// Which origin PayFast's return / cancel / notify URLs are built from. The local .env sets BASE_URL to the LIVE site (it is used for the links in
// emails), so a sandbox checkout started on a developer machine used to send PayFast's notification - and the buyer - to the live site: a sandbox
// ITN then landed on production's webhook (rejected there, but only after it had logged an ITN row against whichever live booking shares the
// number). PAYFAST_BASE_URL lets a local run point PayFast at the local site or a tunnel without touching BASE_URL.
// Pure function of (request, environment) in a database-free module, so it is tested directly.
const { payfastBaseUrl, payfastNotifyBaseUrl } = require('../lib/payfast-signature');

const fakeReq = (headers = {}, protocol = 'http') => ({ protocol, get: (h) => headers[String(h).toLowerCase()] });

module.exports = async function ({ check }) {
    const eq = (name, got, want) => check(name, got === want, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
    const req = fakeReq({ host: 'localhost:3000' });

    eq('PAYFAST_BASE_URL wins over BASE_URL', payfastBaseUrl(req, { PAYFAST_BASE_URL: 'http://localhost:3000', BASE_URL: 'https://www.thabisomhlongo.com' }), 'http://localhost:3000');
    eq('...and a trailing slash is dropped', payfastBaseUrl(req, { PAYFAST_BASE_URL: 'https://abc123.ngrok-free.app/' }), 'https://abc123.ngrok-free.app');
    eq('without it BASE_URL is used, exactly as before', payfastBaseUrl(req, { BASE_URL: 'https://www.thabisomhlongo.com/' }), 'https://www.thabisomhlongo.com');
    eq('with neither, the request\'s own host is used', payfastBaseUrl(req, {}), 'http://localhost:3000');
    eq('...preferring the forwarded host and protocol a proxy or tunnel sends',
        payfastBaseUrl(fakeReq({ host: 'localhost:3000', 'x-forwarded-host': 'abc123.ngrok-free.app', 'x-forwarded-proto': 'https' }), {}), 'https://abc123.ngrok-free.app');
    eq('an empty PAYFAST_BASE_URL is ignored', payfastBaseUrl(req, { PAYFAST_BASE_URL: '', BASE_URL: 'https://www.thabisomhlongo.com' }), 'https://www.thabisomhlongo.com');
    eq('a blank (spaces only) PAYFAST_BASE_URL is ignored too', payfastBaseUrl(req, { PAYFAST_BASE_URL: '   ', BASE_URL: 'https://www.thabisomhlongo.com' }), 'https://www.thabisomhlongo.com');
    eq('surrounding spaces are trimmed', payfastBaseUrl(req, { PAYFAST_BASE_URL: '  http://localhost:3000  ' }), 'http://localhost:3000');

    // The notification URL: PayFast's servers cannot reach localhost, the buyer's browser can - so only the notification may go through a tunnel.
    const local = { PAYFAST_BASE_URL: 'http://localhost:3000', BASE_URL: 'https://www.thabisomhlongo.com' };
    eq('PAYFAST_NOTIFY_BASE_URL sends ONLY the notification through the tunnel', payfastNotifyBaseUrl(req, { ...local, PAYFAST_NOTIFY_BASE_URL: 'https://abc123.ngrok-free.app/' }), 'https://abc123.ngrok-free.app');
    eq('...the return / cancel pages still use the local site (the buyer\'s browser can reach it)', payfastBaseUrl(req, { ...local, PAYFAST_NOTIFY_BASE_URL: 'https://abc123.ngrok-free.app' }), 'http://localhost:3000');
    eq('unset, the notification goes exactly where it always went (PAYFAST_BASE_URL)', payfastNotifyBaseUrl(req, local), 'http://localhost:3000');
    eq('...or BASE_URL on the live site, which sets neither', payfastNotifyBaseUrl(req, { BASE_URL: 'https://www.thabisomhlongo.com/' }), 'https://www.thabisomhlongo.com');
    eq('...or the request\'s own host when nothing is set', payfastNotifyBaseUrl(req, {}), 'http://localhost:3000');
    eq('a blank or empty PAYFAST_NOTIFY_BASE_URL is ignored', payfastNotifyBaseUrl(req, { ...local, PAYFAST_NOTIFY_BASE_URL: '   ' }), 'http://localhost:3000');
    eq('surrounding spaces are trimmed', payfastNotifyBaseUrl(req, { PAYFAST_NOTIFY_BASE_URL: '  https://abc123.ngrok-free.app  ' }), 'https://abc123.ngrok-free.app');
};
