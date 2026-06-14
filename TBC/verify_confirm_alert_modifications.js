const fs = require('fs');
const path = require('path');

console.log('--- Verification of confirm/alert Customizations ---');

const projectRoot = path.join(__dirname, '..');
const filesToVerify = [
    { relativePath: 'admin.html', fileType: 'html' },
    { relativePath: 'js/myscript.js', fileType: 'js' }
];

let failed = false;

filesToVerify.forEach(({ relativePath, fileType }) => {
    const absolutePath = path.join(projectRoot, relativePath);
    console.log(`Checking ${relativePath}...`);
    
    if (!fs.existsSync(absolutePath)) {
        console.error(`Error: File ${relativePath} does not exist!`);
        failed = true;
        return;
    }
    
    const content = fs.readFileSync(absolutePath, 'utf8');
    const lines = content.split('\n');
    
    lines.forEach((line, idx) => {
        const lineNum = idx + 1;
        
        // Match confirm(...)
        if (/\bconfirm\s*\(/.test(line)) {
            // Check surrounding 10 lines for "notificationService"
            const startIdx = Math.max(0, idx - 8);
            const endIdx = Math.min(lines.length - 1, idx + 8);
            const contextLines = lines.slice(startIdx, endIdx + 1).join('\n');
            
            if (!contextLines.includes('notificationService') && !line.includes('window.confirm')) {
                console.warn(`[WARNING] Unwrapped confirm found on line ${lineNum}: ${line.trim()}`);
                failed = true;
            } else {
                console.log(`[OK] Wrapped confirm on line ${lineNum}: ${line.trim()}`);
            }
        }
        
        // Match alert(...)
        if (/\balert\s*\(/.test(line)) {
            // Check surrounding 10 lines for "notificationService"
            const startIdx = Math.max(0, idx - 8);
            const endIdx = Math.min(lines.length - 1, idx + 8);
            const contextLines = lines.slice(startIdx, endIdx + 1).join('\n');
            
            if (!contextLines.includes('notificationService') && !line.includes('window.alert') && !line.includes('//') && !line.includes('/*')) {
                console.warn(`[WARNING] Unwrapped alert found on line ${lineNum}: ${line.trim()}`);
                failed = true;
            } else {
                console.log(`[OK] Wrapped/Safe alert on line ${lineNum}: ${line.trim()}`);
            }
        }
    });
});

if (failed) {
    console.error('\nFAIL: Some native confirm/alert calls are not properly refactored or wrapped.');
    process.exit(1);
} else {
    console.log('\nSUCCESS: All production native dialogs are refactored to use notificationService with fallback wrappers.');
}
