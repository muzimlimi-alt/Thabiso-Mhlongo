const https = require('https');

const icons = [
    'instagram-new',
    'facebook-new',
    'linkedin',
    'tiktok',
    'whatsapp',
    'youtube-play',
    'twitter',
    'x',
    'link'
];

async function checkIcon(name) {
    const url = `https://img.icons8.com/ios-filled/50/D4AF37/${name}.png`;
    return new Promise((resolve) => {
        https.get(url, (res) => {
            console.log(`Icon: ${name} -> Status: ${res.statusCode} (${url})`);
            resolve(res.statusCode === 200);
        }).on('error', (err) => {
            console.log(`Icon: ${name} -> Error: ${err.message}`);
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
