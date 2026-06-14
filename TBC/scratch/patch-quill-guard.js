const fs = require('fs');
let lines = fs.readFileSync('admin.html', 'utf8').split('\n');

// Remove the misplaced guard line (line 7194, 0-indexed 7193)
lines.splice(7193, 1);

// Now insert it at the correct position: right after "if (!beQuillInstance) {" (line 7192, 0-indexed 7191)
// so it goes BEFORE "beQuillInstance = new Quill..."
const guardLine = "                if (typeof Quill === 'undefined') { window.notificationService && window.notificationService.showError('Email editor is still loading. Please try again.'); return; }";
lines.splice(7192, 0, guardLine + '\r');

fs.writeFileSync('admin.html', lines.join('\n'), 'utf8');
console.log('Fixed Quill guard position. Total lines:', lines.length);
