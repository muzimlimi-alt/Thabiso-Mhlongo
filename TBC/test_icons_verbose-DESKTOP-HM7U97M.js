const https = require('https');

const icons = [
    'instagram',
    'facebook',
    'facebook-new',
    'youtube',
    'youtube-play',
    'x',
    'twitter',
    'linkedin',
    'tiktok',
    'whatsapp',
    'link'
];

function checkIcon(name) {
    const url = `https://img.icons8.com/ios-filled/50/D4AF37/${name}.png`;
    return new Promise((resolve) => {
        const req = https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
            console.log(`Icon: ${name} -> Status: ${res.statusCode} (${url})`);
            resolve(res.statusCode === 200);
        });
        
        req.on('error', (err) => {
            console.log(`Icon: ${name} -> Request Error:`, err.message);
            resolve(false);
        });
    });
}

async function run() {
    for (const icon of icons) {
        await checkIcon(icon);
    }
}

run();
