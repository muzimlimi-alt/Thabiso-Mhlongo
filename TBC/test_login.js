async function testLogin() {
    const baseUrl = 'http://localhost:3000';
    console.log('Attempting to log in as "admin" with password "password123"...');
    
    try {
        const response = await fetch(`${baseUrl}/api/admin/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: 'admin', password: 'password123' })
        });
        
        const json = await response.json();
        console.log('HTTP Status:', response.status);
        console.log('Response body:', JSON.stringify(json, null, 2));
        
        if (response.ok && json.success) {
            console.log('✓ Login Successful!');
        } else {
            console.error('❌ Login Failed:', json.message || 'Unknown error');
        }
    } catch (e) {
        console.error('❌ Error connecting to server:', e.message);
    }
}

testLogin();
