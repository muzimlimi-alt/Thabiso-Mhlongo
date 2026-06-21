const bcrypt = require('bcrypt');
const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('database.sqlite');

bcrypt.hash('AssistantPassword123!', 10, (err, h1) => {
    db.run("UPDATE admins SET password_hash = ? WHERE username = 'assistant'", [h1], () => {
        bcrypt.hash('ManagerPassword123!', 10, (err, h2) => {
            db.run("UPDATE admins SET password_hash = ? WHERE username = 'muzi'", [h2], () => {
                bcrypt.hash('AdminPassword123!', 10, (err, h3) => {
                    db.run("UPDATE admins SET password_hash = ? WHERE username = 'admin'", [h3], () => {
                        console.log('All passwords reset successfully!');
                        db.close();
                    });
                });
            });
        });
    });
});
