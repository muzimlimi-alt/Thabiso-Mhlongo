const pdfService = require('../js/pdfService.js');

async function run() {
    console.log("Testing quote endpoint");
    try {
        const r = await fetch('http://localhost:3000/api/admin/bookings/45/quote', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                // Mock an admin session if possible, but since we can't easily, we will bypass it in server.js temporarily or check if it throws 401
            },
            body: JSON.stringify({
                quote_expiry_date: "2026-05-16",
                terms: "test",
                items: [{description: "test", quantity_minutes: 1, unit_price: 100}],
                discount: 0,
                apply_vat: false
            })
        });
        const text = await r.text();
        console.log("Response:", r.status, text);
    } catch (e) {
        console.error("Error", e);
    }
}
run();
