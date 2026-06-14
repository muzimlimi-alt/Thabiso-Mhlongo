const sqlite = require('sqlite3').verbose();
const path = require('path');

const db = new sqlite.Database(path.join(__dirname, '../database.sqlite'));

db.all("SELECT * FROM home_slider", (err, rows) => {
    if (err) {
        console.error("Error:", err);
    } else {
        console.log("Home Slider Items:", rows);
    }
    db.close();
});
