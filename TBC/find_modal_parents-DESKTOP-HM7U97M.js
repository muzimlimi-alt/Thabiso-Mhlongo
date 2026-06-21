const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, '..', 'admin.html');
const content = fs.readFileSync(filePath, 'utf8');

// A simple HTML tokenizer/parser that tracks tags to find the hierarchy for specific elements
function parseHierarchy(html) {
    let index = 0;
    const tagStack = [];
    const results = {};
    const targets = [
        'blockOutModal',
        'adminBookingModal',
        'bookingInfoModal',
        'bookingFinancialsModal',
        'bookingEmailModal',
        'manualBookingModal',
        'importSubscribersModal',
        'newsletterPreviewModal'
    ];

    while (index < html.length) {
        // Skip comments
        if (html.startsWith('<!--', index)) {
            const endComment = html.indexOf('-->', index + 4);
            if (endComment === -1) break;
            index = endComment + 3;
            continue;
        }

        // Skip scripts
        if (html.toLowerCase().startsWith('<script', index)) {
            const endScript = html.toLowerCase().indexOf('</script>', index + 7);
            if (endScript === -1) break;
            index = endScript + 9;
            continue;
        }

        // Skip styles
        if (html.toLowerCase().startsWith('<style', index)) {
            const endStyle = html.toLowerCase().indexOf('</style>', index + 6);
            if (endStyle === -1) break;
            index = endStyle + 8;
            continue;
        }

        // Tag matching
        if (html[index] === '<') {
            const tagEnd = html.indexOf('>', index);
            if (tagEnd === -1) break;

            const tagContent = html.slice(index + 1, tagEnd).trim();
            index = tagEnd + 1;

            if (tagContent.startsWith('/')) {
                // Closing tag
                const tagName = tagContent.slice(1).trim().split(/\s+/)[0].toLowerCase();
                // Pop elements up to the matching tag name
                let foundIndex = -1;
                for (let i = tagStack.length - 1; i >= 0; i--) {
                    if (tagStack[i].name === tagName) {
                        foundIndex = i;
                        break;
                    }
                }
                if (foundIndex !== -1) {
                    tagStack.splice(foundIndex);
                }
            } else if (!tagContent.endsWith('/') && !tagContent.startsWith('!') && !tagContent.startsWith('?')) {
                // Opening tag
                const parts = tagContent.split(/\s+/);
                const name = parts[0].toLowerCase();
                
                // Get id and class
                let id = null;
                let className = null;
                
                const idMatch = tagContent.match(/id\s*=\s*["']([^"']+)["']/i);
                if (idMatch) id = idMatch[1];
                
                const classMatch = tagContent.match(/class\s*=\s*["']([^"']+)["']/i);
                if (classMatch) className = classMatch[1];

                // Check if this opening tag is one of our targets
                if (id && targets.includes(id)) {
                    results[id] = [...tagStack];
                }

                // If not self-closing or void tags
                const voidTags = ['img', 'br', 'hr', 'input', 'link', 'meta', 'area', 'base', 'col', 'embed', 'param', 'source', 'track', 'wbr'];
                if (!voidTags.includes(name)) {
                    tagStack.push({ name, id, className });
                }
            }
            continue;
        }

        index++;
    }

    return results;
}

console.log("Parsing admin.html structure...");
const results = parseHierarchy(content);
for (const [id, stack] of Object.entries(results)) {
    console.log(`\nModal: #${id}`);
    if (stack.length === 0) {
        console.log("  -> Direct child of root/body");
    } else {
        stack.forEach((node, idx) => {
            console.log(`  [${idx}] <${node.name}${node.id ? ` id="${node.id}"` : ''}${node.className ? ` class="${node.className}"` : ''}>`);
        });
    }
}
