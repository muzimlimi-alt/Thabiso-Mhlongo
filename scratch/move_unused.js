const fs = require('fs');
const path = require('path');

const rootDir = path.resolve(__dirname, '..');
const tbcDir = path.join(rootDir, 'TBC');

// Files to move from root to TBC (exact root files)
const rootFilesToMove = [
    'apply-item5.js',
    'atelier-contact-social-newsletter-inquiries-prompt.md'
];

function ensureDirectoryExistence(filePath) {
    const dirname = path.dirname(filePath);
    if (fs.existsSync(dirname)) {
        return true;
    }
    ensureDirectoryExistence(dirname);
    fs.mkdirSync(dirname);
}

function moveFile(src, dest) {
    try {
        ensureDirectoryExistence(dest);
        fs.renameSync(src, dest);
        console.log(`Moved: ${path.relative(rootDir, src)} -> ${path.relative(rootDir, dest)}`);
    } catch (err) {
        console.error(`Error moving ${src} to ${dest}:`, err.message);
    }
}

function scanAndMove(dir) {
    const files = fs.readdirSync(dir);
    for (const file of files) {
        const fullPath = path.join(dir, file);
        const relativePath = path.relative(rootDir, fullPath);

        // Skip node_modules, .git, .agents, .claude, and the TBC folder itself
        if (file === 'node_modules' || file === '.git' || file === 'TBC' || file === '.agents' || file === '.claude') {
            continue;
        }

        const stat = fs.statSync(fullPath);
        if (stat.isDirectory()) {
            scanAndMove(fullPath);
        } else {
            const isConflict = file.includes('-DESKTOP-HM7U97M');
            const isUnusedRootFile = dir === rootDir && rootFilesToMove.includes(file);

            if (isConflict || isUnusedRootFile) {
                // Determine destination path inside TBC maintaining directory structure
                const destPath = path.join(tbcDir, relativePath);
                moveFile(fullPath, destPath);
            }
        }
    }
}

console.log('Starting cleanup and file migration to TBC directory...');
scanAndMove(rootDir);
console.log('Cleanup finished.');
