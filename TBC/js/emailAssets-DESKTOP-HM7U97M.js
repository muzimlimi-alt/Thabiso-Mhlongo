/**
 * Thabiso Mhlongo — Brand Asset Manager for Emails
 * Handles absolute paths and attachments for Nodemailer.
 */

const path = require('path');
const fs = require('fs');

// Absolute paths to key assets
// Assuming __dirname is /js/ - we need to go up one level since assets are in /images/
const BASE_DIR = path.join(__dirname, '..');
const ASSETS = {
    banner: path.join(BASE_DIR, 'images', 'banner', 'banner_4_centerstage1.png'),
    logo: path.join(BASE_DIR, 'images', 'logo4.png')
};

const CIDS = {
    banner: 'thabisoBanner',
    logo: 'thabisoLogo'
};

/**
 * Returns Nodemailer-compatible attachment objects for brand assets.
 */
function getBrandAttachments(includeLogo = true, includeBanner = true) {
    const attachments = [];

    if (includeBanner && fs.existsSync(ASSETS.banner)) {
        attachments.push({
            filename: 'banner_4_centerstage1.png',
            path: ASSETS.banner,
            cid: CIDS.banner
        });
    }

    if (includeLogo && fs.existsSync(ASSETS.logo)) {
        attachments.push({
            filename: 'logo4.png',
            path: ASSETS.logo,
            cid: CIDS.logo
        });
    }

    return attachments;
}

/**
 * Returns the CIDs used for brand assets.
 */
function getBrandCids() {
    return { ...CIDS };
}

module.exports = {
    getBrandAttachments,
    getBrandCids,
    ASSETS
};
