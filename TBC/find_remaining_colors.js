const fs = require('fs');
const path = require('path');

const adminPath = path.join(__dirname, '..', 'admin.html');
const content = fs.readFileSync(adminPath, 'utf8');
const lines = content.split('\n');

const colorsToFind = [
    { hex: '#D4AF37', label: 'Gold' },
    { hex: '#E8C14B', label: 'Gold Hover' },
    { hex: '#ef5350', label: 'Red/Clay' },
    { hex: '#4CAF50', label: 'Green/Sage' },
    { hex: '#F44336', label: 'Red' },
    { hex: '#FF9800', label: 'Orange' },
    { hex: '#17a2b8', label: 'Blue/Cyan' },
    { hex: '#42A5F5', label: 'Light Blue' },
    { hex: '#66BB6A', label: 'Light Green' },
    { hex: '#FFA726', label: 'Orange' }
];

console.log('Auditing remaining colors (from Line 1500 to end)...');

lines.forEach((line, index) => {
    const lineNum = index + 1;
    if (lineNum < 1500) return; // Skip head stylesheet block

    colorsToFind.forEach(c => {
        const regex = new RegExp(c.hex, 'i');
        if (regex.test(line)) {
            console.log(`  L${lineNum} [Found ${c.label} (${c.hex})]: ${line.trim().substring(0, 150)}`);
        }
    });
});
