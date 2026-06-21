const fs = require('fs');
const path = require('path');

const content = fs.readFileSync(path.join(__dirname, '..', 'admin.html'), 'utf8');

// Search for any CSS rules or JS lines containing 'blur', 'filter', or 'opacity'
const lines = content.split('\n');
const targets = ['blur', 'filter', 'opacity'];

console.log("Searching for keywords in admin.html...");
lines.forEach((line, idx) => {
    const lower = line.toLowerCase();
    targets.forEach(target => {
        if (lower.includes(target)) {
            // Ignore common occurrences like image paths, form validation blur events
            if (lower.includes('on(\'blur\'') || lower.includes('blur()') || lower.includes('filter_') || lower.includes('filters') || lower.includes('sparkline') || lower.includes('apexcharts')) {
                return;
            }
            console.log(`Line ${idx + 1}: ${line.trim()}`);
        }
    });
});
