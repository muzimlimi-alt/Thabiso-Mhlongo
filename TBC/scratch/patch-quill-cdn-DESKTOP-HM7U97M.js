// Patch: Move Quill script tag from line 7925 to right before the script block
// that uses it, and switch to cdnjs CDN for reliability
const fs = require('fs');
let lines = fs.readFileSync('admin.html', 'utf8').split('\n');

// Find and remove the current Quill script line
const quillIdx = lines.findIndex(l => l.includes('cdn.quilljs.com') && l.includes('quill.min.js'));
if (quillIdx === -1) { console.log('ERROR: Quill script tag not found'); process.exit(1); }
console.log('Found Quill script at line', quillIdx + 1, ':', lines[quillIdx].trim());
const removedLine = lines.splice(quillIdx, 1);
console.log('Removed from line', quillIdx + 1);

// Find the CSS link too and update CDN
const cssIdx = lines.findIndex(l => l.includes('cdn.quilljs.com') && l.includes('quill.snow.css'));
if (cssIdx >= 0) {
    lines[cssIdx] = lines[cssIdx].replace('cdn.quilljs.com/1.3.7', 'cdnjs.cloudflare.com/ajax/libs/quill/1.3.7');
    console.log('Updated CSS CDN at line', cssIdx + 1);
}

// Insert Quill JS right before the <script> block that contains beQuillInstance
// Find the script block containing 'beQuillInstance'
const handlerBlockIdx = lines.findIndex(l => l.includes('var beQuillInstance'));
if (handlerBlockIdx === -1) { console.log('ERROR: beQuillInstance not found'); process.exit(1); }
console.log('beQuillInstance found at line', handlerBlockIdx + 1);

// Walk backward to find the <script> tag that starts this block
let scriptOpenIdx = handlerBlockIdx;
while (scriptOpenIdx > 0 && !lines[scriptOpenIdx].trim().startsWith('<script>') && !lines[scriptOpenIdx].trim().startsWith('<script ')) {
    scriptOpenIdx--;
}
console.log('Script block starts at line', scriptOpenIdx + 1, ':', lines[scriptOpenIdx].trim().substring(0, 80));

// Insert the Quill CDN script tag right BEFORE this script block
const newQuillLine = '    <script src="https://cdnjs.cloudflare.com/ajax/libs/quill/1.3.7/quill.min.js"></script>\r';
lines.splice(scriptOpenIdx, 0, newQuillLine);
console.log('Inserted Quill CDN script at line', scriptOpenIdx + 1);

fs.writeFileSync('admin.html', lines.join('\n'), 'utf8');
console.log('Done. Total lines:', lines.length);
