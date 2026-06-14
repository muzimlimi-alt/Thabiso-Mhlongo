async function run() {
    console.log("Testing endpoint");
    try {
        const r = await fetch('http://localhost:3000/api/admin/bookings/45/quote', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({
                quote_expiry_date: '2026/05/16', 
                terms: '50% Deposit (R 11500.00) required to secure the booking.', 
                items: [{service_id: 'some_id', description: 'Main Performance (15 min)', quantity_minutes: 1, unit_price: 20000, pricing_model: 'flat'}], 
                discount: 0, 
                apply_vat: true
            })
        });
        const text = await r.text();
        console.log("Status:", r.status, "Text:", text);
    } catch(e) {
        console.error("Error:", e);
    }
}
run();
