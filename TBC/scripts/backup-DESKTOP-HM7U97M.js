const fs = require('fs');
const path = require('path');

const DB_FILE = path.join(__dirname, '../database.sqlite');
const BACKUP_DIR = path.join(__dirname, '../backups');

if (!fs.existsSync(BACKUP_DIR)) {
    fs.mkdirSync(BACKUP_DIR);
}

function backup() {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupFile = path.join(BACKUP_DIR, `database_backup_${timestamp}.sqlite`);

    console.log(`[Backup] Starting snapshot for: ${DB_FILE}`);
    
    if (!fs.existsSync(DB_FILE)) {
        console.error(`[Error] Database file not found at ${DB_FILE}`);
        return;
    }

    try {
        fs.copyFileSync(DB_FILE, backupFile);
        console.log(`✅ [Success] Database backed up to: ${backupFile}`);
        
        // Cleanup old backups (keep last 10)
        const files = fs.readdirSync(BACKUP_DIR)
            .filter(f => f.endsWith('.sqlite'))
            .map(f => ({ name: f, time: fs.statSync(path.join(BACKUP_DIR, f)).mtime }))
            .sort((a, b) => b.time - a.time);

        if (files.length > 10) {
            files.slice(10).forEach(f => {
                fs.unlinkSync(path.join(BACKUP_DIR, f.name));
                console.log(`[Cleanup] Deleted old backup: ${f.name}`);
            });
        }

    } catch (err) {
        console.error(`❌ [Error] Backup failed:`, err.message);
    }
}

backup();
