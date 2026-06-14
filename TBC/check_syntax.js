const fs = require('fs');
const path = require('path');
const vm = require('vm');

const adminPath = path.join(__dirname, '..', 'admin.html');
const content = fs.readFileSync(adminPath, 'utf8');

// We want to find all inline <script> blocks
const scriptBlocks = [];
let startIndex = 0;

while (true) {
    const openTagIdx = content.indexOf('<script>', startIndex);
    if (openTagIdx === -1) {
        // Also look for <script type="text/javascript"> or similar, but without src attribute
        const customOpenIdx = content.search(/<script(?![^>]*src=)[^>]*>/i);
        // Let's do a more robust regex-based extraction
        break;
    }
    const closeTagIdx = content.indexOf('</script>', openTagIdx);
    if (closeTagIdx === -1) break;

    const scriptText = content.substring(openTagIdx + '<script>'.length, closeTagIdx);
    scriptBlocks.push({
        startLine: content.substring(0, openTagIdx).split('\n').length,
        code: scriptText
    });
    startIndex = closeTagIdx + '</script>'.length;
}

// Let's do a robust regex match for script blocks without src attributes
const regex = /<script(?![^>]*src=)[^>]*>([\s\S]*?)<\/script>/gi;
let match;
let count = 0;

while ((match = regex.exec(content)) !== null) {
    const code = match[1];
    const index = match.index;
    const startLine = content.substring(0, index).split('\n').length;
    count++;
    
    console.log(`Checking Script Block #${count} (starts near line ${startLine})...`);
    try {
        new vm.Script(code, { filename: `inline-script-${count}.js`, lineOffset: startLine - 1 });
        console.log(`  [OK] Block #${count} parsed successfully.`);
    } catch (e) {
        console.error(`  [SYNTAX ERROR] in Script Block #${count} near line ${startLine}:`);
        console.error(e.message);
        console.error(e.stack);
    }
}
