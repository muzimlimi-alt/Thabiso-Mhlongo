#!/usr/bin/env node
/*
 * One-time helper to re-authorize Google Calendar access and obtain a fresh refresh_token.
 * Needed because GOOGLE_REFRESH_TOKEN in .env has expired/been revoked (server logs show
 * "invalid_grant" on every calendar sync attempt).
 *
 * Usage:
 *   node scripts/get-google-refresh-token.js
 *   -> opens a local listener, prints a Google consent URL to open in your browser.
 *   -> after you approve access, this script catches the redirect, exchanges the code,
 *      and prints the new refresh_token to paste into .env as GOOGLE_REFRESH_TOKEN.
 *
 * Requires GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET already in .env (unchanged — only the
 * refresh_token is being replaced).
 *
 * If Google shows "Error 400: redirect_uri_mismatch", this redirect URI isn't registered on
 * your OAuth client yet: go to Google Cloud Console -> APIs & Services -> Credentials -> your
 * OAuth 2.0 Client ID -> Authorized redirect URIs -> add http://localhost:3000/oauth2callback
 * -> Save, then re-run this script.
 */
require('dotenv').config();
const { google } = require('googleapis');
const http = require('http');

const REDIRECT_URI = process.env.GOOGLE_REDIRECT_URL || 'http://localhost:3000/oauth2callback';
const { port, pathname } = new URL(REDIRECT_URI);
const PORT = port || 3000;

if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
    console.error('GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET missing from .env — cannot proceed.');
    process.exit(1);
}

const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    REDIRECT_URI
);

const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent', // force Google to reissue a refresh_token even if this app was authorized before
    scope: ['https://www.googleapis.com/auth/calendar']
});

const server = http.createServer(async (req, res) => {
    const reqUrl = new URL(req.url, `http://localhost:${PORT}`);
    if (reqUrl.pathname !== pathname) { res.end('Waiting for the Google OAuth redirect...'); return; }

    const code = reqUrl.searchParams.get('code');
    if (!code) {
        res.end('No authorization code received — check the terminal for details.');
        console.error('Redirect had no ?code= param:', req.url);
        return;
    }

    try {
        const { tokens } = await oauth2Client.getToken(code);
        res.end('Success — you can close this tab and go back to the terminal.');
        if (!tokens.refresh_token) {
            console.warn(
                '\nNo refresh_token was returned. This can happen if Google considers this app already ' +
                'fully authorized. Revoke its access at https://myaccount.google.com/permissions and re-run this script.'
            );
        } else {
            console.log('\n=== SUCCESS ===');
            console.log('New refresh_token — copy this into .env as GOOGLE_REFRESH_TOKEN:\n');
            console.log(tokens.refresh_token);
            console.log('\nThen restart the server for it to take effect.');
        }
    } catch (e) {
        console.error('\nToken exchange failed:', e.message);
        res.end('Token exchange failed — check the terminal.');
    } finally {
        server.close();
        setTimeout(() => process.exit(0), 300);
    }
});

server.listen(PORT, () => {
    console.log(`Listening on http://localhost:${PORT}${pathname} for the OAuth redirect...\n`);
    console.log('Open this URL in a browser, signed in as the Google account that owns the target calendar:\n');
    console.log(authUrl);
    console.log('\nThen approve access. This script will catch the redirect automatically.');
});
