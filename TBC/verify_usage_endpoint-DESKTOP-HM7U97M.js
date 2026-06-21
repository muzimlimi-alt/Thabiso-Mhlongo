const http = require('http');

http.get('http://localhost:3000/api/admin/services/1/usage', (res) => {
    let data = '';
    res.on('data', chunk => { data += chunk; });
    res.on('end', () => {
        console.log("Response:", JSON.parse(data));
    });
}).on('error', err => {
    console.error("Error:", err.message);
});
