const fs = require('fs');
const path = require('path');
const http = require('http');

const logPath = 'C:\\Users\\muzim\\.gemini\\antigravity-ide\\brain\\79807dd0-d694-4ecd-9de1-8e01799e8afe\\.system_generated\\tasks\\task-65.log';

if (!fs.existsSync(logPath)) {
    console.error('Log file does not exist at ' + logPath);
    process.exit(1);
}

const content = fs.readFileSync(logPath, 'utf8');
const lines = content.split('\n');

const uniqueUrls = new Set();
for (const line of lines) {
    const match = line.match(/\[DEBUG\] (GET|POST|PUT|DELETE|PATCH) (\S+)/);
    if (match) {
        let url = match[2];
        // strip query params
        const qIdx = url.indexOf('?');
        if (qIdx !== -1) {
            url = url.substring(0, qIdx);
        }
        // check all paths
        uniqueUrls.add(url);
    }
}

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
    console.log(`Extracted ${uniqueUrls.size} unique endpoints from logs. Probing...`);
    const results = [];
    for (const ep of uniqueUrls) {
        const res = await checkRoute(ep);
        results.push(res);
        if (res.status === 404) {
            console.log(`[404 FOUND] ${res.endpoint}`);
        } else {
            console.log(`[${res.status}] ${res.endpoint}`);
        }
    }
    console.log('Done probing.');
}

run();
