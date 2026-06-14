const fs = require('fs');
const path = require('path');

const adminPath = path.join(__dirname, '..', 'admin.html');
const content = fs.readFileSync(adminPath, 'utf8');
const lines = content.split('\n');

// Analyze between line 3218 (dashboardAdmin) and line 6800
const startLine = 3218;
const endLine = 6800;

let report = `Auditing inline styles from line ${startLine} to ${endLine}...\n\n`;

for (let i = startLine - 1; i < endLine; i++) {
    const line = lines[i];
    const lineNum = i + 1;
    if (!line) continue;

    // Check for inline style attributes containing color, background, border, etc.
    if (line.includes('style=')) {
        const styleMatch = line.match(/style=["']([^"']+)["']/i);
        if (styleMatch) {
            const styleContent = styleMatch[1];
            if (
                styleContent.includes('color') || 
                styleContent.includes('background') || 
                styleContent.includes('border')
            ) {
                const hasColor = /#(?:[0-9a-f]{3}){1,2}\b|rgb|rgba|red|green|blue|gold|orange|yellow|black|white/i.test(styleContent) ||
                                 /background:\s*(?!none|transparent|var|inherit)/i.test(styleContent) ||
                                 /color:\s*(?!inherit|var|initial)/i.test(styleContent);
                
                if (hasColor) {
                    let currentSection = 'unknown';
                    for (let j = i; j >= 0; j--) {
                        if (lines[j].includes('class="admin-section"') && lines[j].includes('id=')) {
                            const idMatch = lines[j].match(/id="([^"]+)"/);
                            if (idMatch) {
                                currentSection = idMatch[1];
                                break;
                            }
                        }
                    }
                    report += `[${currentSection}] L${lineNum}: ${line.trim()}\n`;
                }
            }
        }
    }
}

fs.writeFileSync(path.join(__dirname, 'style_audit_results.txt'), report, 'utf8');
console.log(`Saved report to TBC/style_audit_results.txt`);
