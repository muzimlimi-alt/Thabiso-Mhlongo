const http = require('http');

http.get('http://localhost:3000/api/test-b78', (res) => {
    let data = '';
    res.on('data', (chunk) => {
        data += chunk;
    });
    res.on('end', () => {
        try {
            const parsed = JSON.parse(data);
            console.log('HTTP Response for Booking 78:');
            console.log(JSON.stringify(parsed, null, 2));
        } catch (e) {
            console.error('Failed to parse JSON:', e.message);
            console.log('Raw data received:', data);
        }
    });
}).on('error', (err) => {
    console.error('HTTP Request failed:', err.message);
});
