const fs = require('fs');
const path = require('path');

const content = fs.readFileSync(path.join(__dirname, '..', 'admin.html'), 'utf8');

// Regex matching comments, script blocks, style blocks, or opening/closing tags
const tagRegex = /<!--[\s\S]*?-->|<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<\/?([a-zA-Z0-9:-]+)(?:\s+[^>]*)?>/gi;

let match;
const tagStack = [];
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
const results = {};

while ((match = tagRegex.exec(content)) !== null) {
    const fullMatch = match[0];
    const tagName = match[1];

    // Skip comments, scripts, and styles
    if (fullMatch.startsWith('<!--') || fullMatch.toLowerCase().startsWith('<script') || fullMatch.toLowerCase().startsWith('<style')) {
        continue;
    }

    const isClosing = fullMatch.startsWith('</');
    const isSelfClosing = fullMatch.endsWith('/>');

    if (isClosing) {
        const name = tagName.toLowerCase();
        let foundIndex = -1;
        for (let i = tagStack.length - 1; i >= 0; i--) {
            if (tagStack[i].name === name) {
                foundIndex = i;
                break;
            }
        }
        if (foundIndex !== -1) {
            tagStack.splice(foundIndex);
        }
    } else {
        const name = tagName.toLowerCase();
        const voidTags = ['img', 'br', 'hr', 'input', 'link', 'meta', 'area', 'base', 'col', 'embed', 'param', 'source', 'track', 'wbr'];
        
        let id = null;
        const idMatch = fullMatch.match(/id\s*=\s*["']([^"']+)["']/i);
        if (idMatch) id = idMatch[1];

        let className = null;
        const classMatch = fullMatch.match(/class\s*=\s*["']([^"']+)["']/i);
        if (classMatch) className = classMatch[1];

        if (id && targets.includes(id)) {
            results[id] = [...tagStack];
        }

        if (!voidTags.includes(name) && !isSelfClosing) {
            tagStack.push({ name, id, className });
        }
    }
}

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
