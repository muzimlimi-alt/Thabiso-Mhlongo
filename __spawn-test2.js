const { spawn } = require('child_process');
const exe = 'C:\\Users\\muzim\\.cache\\puppeteer\\chrome\\win64-147.0.7727.57\\chrome-win64\\chrome.exe';
const p = spawn(exe, ['--version']);
p.stdout.on('data', d => console.log('OUT:', d.toString()));
p.stderr.on('data', d => console.log('ERR:', d.toString()));
p.on('error', e => console.log('SPAWN ERROR:', e.message, e.code, e.errno));
p.on('exit', c => console.log('EXIT', c));
