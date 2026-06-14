const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, '..', 'admin.html');
const content = fs.readFileSync(filePath, 'utf8');

// A simple parser to find the direct children of <body>
const bodyStart = content.indexOf('<body');
if (bodyStart === -1) {
    console.log("Could not find <body");
    process.exit(1);
}

const bodyEnd = content.indexOf('</body>');
const bodyContent = content.slice(bodyStart, bodyEnd !== -1 ? bodyEnd : content.length);

let index = 0;
let depth = 0;
const children = [];

while (index < bodyContent.length) {
    // Skip comments
    if (bodyContent.startsWith('<!--', index)) {
        const endComment = bodyContent.indexOf('-->', index + 4);
        if (endComment === -1) break;
        index = endComment + 3;
        continue;
    }

    // Skip scripts
    if (bodyContent.toLowerCase().startsWith('<script', index)) {
        const endScript = bodyContent.toLowerCase().indexOf('</script>', index + 7);
        if (endScript === -1) break;
        if (depth === 1) {
            children.push({ name: 'script', details: '' });
        }
        index = endScript + 9;
        continue;
    }

    // Skip styles
    if (bodyContent.toLowerCase().startsWith('<style', index)) {
        const endStyle = bodyContent.toLowerCase().indexOf('</style>', index + 6);
        if (endStyle === -1) break;
        if (depth === 1) {
            children.push({ name: 'style', details: '' });
        }
        index = endStyle + 8;
        continue;
    }

    if (bodyContent[index] === '<') {
        const tagEnd = bodyContent.indexOf('>', index);
        if (tagEnd === -1) break;

        const tagContent = bodyContent.slice(index + 1, tagEnd).trim();
        index = tagEnd + 1;

        if (tagContent.startsWith('/')) {
            // Closing tag
            const name = tagContent.slice(1).trim().split(/\s+/)[0].toLowerCase();
            const voidTags = ['img', 'br', 'hr', 'input', 'link', 'meta', 'area', 'base', 'col', 'embed', 'param', 'source', 'track', 'wbr'];
            if (!voidTags.includes(name)) {
                depth--;
            }
        } else if (!tagContent.endsWith('/') && !tagContent.startsWith('!') && !tagContent.startsWith('?')) {
            // Opening tag
            const name = tagContent.split(/\s+/)[0].toLowerCase();
            
            const voidTags = ['img', 'br', 'hr', 'input', 'link', 'meta', 'area', 'base', 'col', 'embed', 'param', 'source', 'track', 'wbr'];
            
            if (depth === 1) {
                // This is a direct child of <body>
                let id = null;
                const idMatch = tagContent.match(/id\s*=\s*["']([^"']+)["']/i);
                if (idMatch) id = idMatch[1];
                
                let className = null;
                const classMatch = tagContent.match(/class\s*=\s*["']([^"']+)["']/i);
                if (classMatch) className = classMatch[1];

                children.push({ name, id, className, tag: `<${name}${id ? ` id="${id}"` : ''}${className ? ` class="${className}"` : ''}>` });
            }

            if (!voidTags.includes(name)) {
                depth++;
            }
        }
        continue;
    }

    index++;
}

console.log("Direct children of <body>:");
children.forEach(c => {
    console.log(`- ${c.tag}`);
});
