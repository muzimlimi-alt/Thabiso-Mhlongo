const fs = require('fs');
const path = require('path');

const adminHtml = fs.readFileSync(path.join(__dirname, '../admin.html'), 'utf8');
const redesignCss = fs.readFileSync(path.join(__dirname, '../css/redesign.css'), 'utf8');

const classes = ['fin-tile', 'settings-panel', 'log-row', 'cms-card', 'atl-btn', 'atl-card'];
classes.forEach(cls => {
    console.log(`${cls} in admin.html:`, adminHtml.includes(cls));
    console.log(`${cls} in redesign.css:`, redesignCss.includes(cls));
});
