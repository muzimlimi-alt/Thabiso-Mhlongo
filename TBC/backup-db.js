const fs = require('fs');
const path = require('path');

const dbPath = path.join(__dirname, 'database.sqlite');
const backupDir = path.join(__dirname, 'backups');

if (!fs.existsSync(backupDir)) {
    fs.mkdirSync(backupDir, { recursive: true });
}

const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
const backupPath = path.join(backupDir, `database-${timestamp}.sqlite`);

fs.copyFileSync(dbPath, backupPath);
console.log(`✅ Database backed up to: ${backupPath}`);
