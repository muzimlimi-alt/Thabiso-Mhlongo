const http = require('http');

const req = http.get('http://localhost:3000/api/public/settings', (res) => {
    console.log(`Server is RUNNING. Status code: ${res.statusCode}`);
    process.exit(0);
});

req.on('error', (err) => {
    console.log(`Server is NOT RUNNING. Error: ${err.message}`);
    process.exit(1);
});
