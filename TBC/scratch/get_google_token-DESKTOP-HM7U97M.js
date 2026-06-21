require('dotenv').config();
const { google } = require('googleapis');
const readline = require('readline');

const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.BASE_URL // Must match what was authorized in Google Cloud Console
);

const SCOPES = ['https://www.googleapis.com/auth/calendar'];

const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    prompt: 'consent' // Forces consent screen to ensure we get a new refresh token
});

console.log('===========================================================');
console.log('1. Click or copy this URL into your browser:');
console.log('===========================================================');
console.log(authUrl);
console.log('===========================================================');
console.log('2. Log in with your Google Account and grant permissions.');
console.log('3. You will be redirected to your BASE_URL (which might just load your website).');
console.log('4. Look at the URL in your browser address bar. It will look like:');
console.log('   https://.../?code=4/0AeaY...&scope=...');
console.log('5. Copy the ENTIRE value after "code=" up to the "&scope" part.');
console.log('===========================================================\n');

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
});

rl.question('Paste the authorization code here: ', (code) => {
    rl.close();
    
    // Decode if the user pasted an already URL-encoded string
    const decodedCode = decodeURIComponent(code);
    
    oauth2Client.getToken(decodedCode, (err, token) => {
        if (err) {
            console.error('\n❌ Error retrieving access token. Make sure you copied the full code and try again.', err.message || err);
            return;
        }
        console.log('\n✅ --- SUCCESS ---');
        console.log('Your new Refresh Token is:\n');
        console.log(token.refresh_token);
        console.log('\nNext Steps:');
        console.log('1. Copy the token above.');
        console.log('2. Open the .env file in the root of your project.');
        console.log('3. Replace the value of GOOGLE_REFRESH_TOKEN with the copied token.');
        console.log('4. Restart your node server (npm start).');
    });
});
