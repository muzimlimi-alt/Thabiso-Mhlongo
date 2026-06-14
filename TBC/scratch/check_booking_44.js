const sqlite3 = require('sqlite3').sharp; // Wait, let's use standard sqlite3
const sqlite = require('sqlite3').verbose();
const crypto = require('crypto');
const path = require('path');
const dotenv = require('dotenv');

dotenv.config({ path: path.join(__dirname, '../.env') });

const db = new sqlite.Database(path.join(__dirname, '../database.sqlite'));

function generatePayFastSignature(pfData, passPhrase = null) {
    let pfOutput = '';
    for (let key in pfData) {
        if (pfData.hasOwnProperty(key) && pfData[key] !== '') {
            const val = pfData[key].toString().trim();
            const encoded = encodeURIComponent(val).replace(/%20/g, "+");
            const upperEncoded = encoded.replace(/%[0-9a-fA-F]{2}/g, match => match.toUpperCase());
            pfOutput += `${key}=${upperEncoded}&`;
        }
    }
    let getString = pfOutput.slice(0, -1);
    console.log('--- STRING TO HASH ---');
    console.log(getString);
    console.log('----------------------');
    
    if (passPhrase && passPhrase.trim() !== '') {
        const encodedPass = encodeURIComponent(passPhrase.trim()).replace(/%20/g, "+");
        const upperPass = encodedPass.replace(/%[0-9a-fA-F]{2}/g, match => match.toUpperCase());
        getString += `&passphrase=${upperPass}`;
        console.log('--- STRING WITH PASSPHRASE ---');
        console.log(getString);
        console.log('-------------------------------');
    }
    return crypto.createHash("md5").update(getString).digest("hex");
}

db.get("SELECT * FROM bookings WHERE id = 44", (err, row) => {
    if (err) {
        console.error(err);
        return;
    }
    if (!row) {
        console.log("Booking #44 not found.");
        return;
    }
    console.log("Booking Data:", row);
    
    const clientName = row.name || 'Client';
    const payment_type = 'FULL'; // Or DEPOSIT, let's assume FULL for now or check both
    const payStatus = (row.payment_status || 'UNPAID').toUpperCase();
    
    let amt = 0;
    if (row.quote_amount) {
        amt = parseFloat(row.quote_amount.replace(/[^0-9.]/g, ''));
    }
    
    const baseUrl = process.env.BASE_URL || 'http://localhost:3000';
    const isPortal = false; // Assume false for now
    
    const pfData = {
        merchant_id: process.env.PAYFAST_MERCHANT_ID || '10000100',
        merchant_key: process.env.PAYFAST_MERCHANT_KEY || '46f0cd694581a',
        return_url: isPortal ? `${baseUrl}/booking?id=${row.id}&payment=success` : `${baseUrl}/?track=${row.id}&payment=success`,
        cancel_url: isPortal ? `${baseUrl}/booking?id=${row.id}&payment=cancel`  : `${baseUrl}/?track=${row.id}&payment=cancel`,
        notify_url: `${baseUrl}/api/payment/webhook/payfast`,
        name_first: (clientName.split(' ')[0] || '').substring(0, 100),
        name_last: (clientName.split(' ').slice(1).join(' ') || '').substring(0, 100),
        email_address: row.email,
        m_payment_id: `${row.id}_${payment_type}`,
        amount: amt.toFixed(2),
        item_name: `Booking ${row.id} - ${row.event_name || row.event_type || 'Event'} - ${payment_type === 'DEPOSIT' ? 'Deposit 50%' : payStatus === 'DEPOSIT_PAID' ? 'Balance' : 'Full Payment'}`.substring(0, 100).replace(/[^a-zA-Z0-9.\- ]/g, '')
    };
    
    // Remove empty or null values
    Object.keys(pfData).forEach(key => {
        if (pfData[key] === '' || pfData[key] === null || pfData[key] === undefined) {
            delete pfData[key];
        }
    });
    
    const passphrase = process.env.PAYFAST_PASSPHRASE || null;
    const signature = generatePayFastSignature(pfData, passphrase);
    console.log("Generated Signature:", signature);
    
    db.close();
});
