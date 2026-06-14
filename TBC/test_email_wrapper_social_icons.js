const assert = require('assert');
const emailTemplates = require('../js/emailTemplates');

console.log('Testing createEmailWrapper with default/empty socials...');
const defaultHtml = emailTemplates.createEmailWrapper('<p>Hello World</p>', 'Test Subject');

// Check that it uses the correct Icons8 gold icons for default social networks
assert(defaultHtml.includes('https://img.icons8.com/ios-filled/40/D4AF37/instagram.png'), 'Missing default Instagram icon');
assert(defaultHtml.includes('https://img.icons8.com/ios-filled/40/D4AF37/x.png'), 'Missing default Twitter (X) icon');
assert(defaultHtml.includes('https://img.icons8.com/ios-filled/40/D4AF37/facebook.png'), 'Missing default Facebook icon');
console.log('✓ Default socials verified successfully.');

console.log('Testing createEmailWrapper with custom/database socials...');
const customSocialLinks = [
    { platform_name: 'Facebook', platform_url: 'https://facebook.com/thabiso' },
    { platform_name: 'Instagram', platform_url: 'https://instagram.com/thabiso' },
    { platform_name: 'LinkedIn', platform_url: 'https://linkedin.com/thabiso' },
    { platform_name: 'TikTok', platform_url: 'https://tiktok.com/@thabiso' },
    { platform_name: 'WhatsApp', platform_url: 'https://wa.me/12345' },
    { platform_name: 'YouTube', platform_url: 'https://youtube.com/thabiso' },
    { platform_name: 'X (Twitter)', platform_url: 'https://x.com/thabiso' },
    { platform_name: 'My Personal Website', platform_url: 'https://thabisomhlongo.com' }
];

const customHtml = emailTemplates.createEmailWrapper('<p>Hello World</p>', 'Test Subject', null, null, customSocialLinks);

// Assert that all platform URLs and corresponding Icons8 gold icon filenames are output correctly
const expectedMappings = {
    'https://facebook.com/thabiso': 'facebook.png',
    'https://instagram.com/thabiso': 'instagram.png',
    'https://linkedin.com/thabiso': 'linkedin.png',
    'https://tiktok.com/@thabiso': 'tiktok.png',
    'https://wa.me/12345': 'whatsapp.png',
    'https://youtube.com/thabiso': 'youtube.png',
    'https://x.com/thabiso': 'x.png',
    'https://thabisomhlongo.com': 'link.png'
};

for (const [url, iconFile] of Object.entries(expectedMappings)) {
    const expectedUrlStr = `href="${url}"`;
    const expectedIconStr = `src="https://img.icons8.com/ios-filled/40/D4AF37/${iconFile}"`;
    assert(customHtml.includes(expectedUrlStr), `Missing platform URL: ${url}`);
    assert(customHtml.includes(expectedIconStr), `Missing icon file mapping: ${iconFile} for ${url}`);
}

console.log('✓ Custom socials verified successfully.');
console.log('All tests passed!');
