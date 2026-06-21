const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, '..', 'admin.html');
const content = fs.readFileSync(filePath, 'utf8');

// Find <body> and print first few lines after it
const bodyIndex = content.indexOf('<body');
if (bodyIndex === -1) {
    console.log("Could not find <body in admin.html");
} else {
    console.log("--- <body> found ---");
    console.log(content.slice(bodyIndex, bodyIndex + 2000));
}
