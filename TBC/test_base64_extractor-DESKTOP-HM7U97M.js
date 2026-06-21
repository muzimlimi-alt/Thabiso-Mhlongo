const assert = require('assert');
const path = require('path');

// Target the email service module
const emailService = require(path.join(__dirname, '..', 'js', 'emailService'));
const extractInlineImages = emailService.extractInlineImages;

function runTests() {
    console.log("=== STARTING BASE64 EXTRACTOR TESTS ===");

    // Test Case 1: HTML without inline images
    {
        const input = '<div class="content"><p>Hello, this is standard text.</p><img src="https://example.com/image.png" alt="External image"></div>';
        const result = extractInlineImages(input);
        
        assert.strictEqual(result.html, input, "HTML with external image URLs should remain unmodified.");
        assert.strictEqual(result.attachments.length, 0, "No attachments should be generated for external URLs.");
        console.log("✓ Test Case 1 Passed: No inline images modified.");
    }

    // Test Case 2: HTML with a single base64 inline image
    {
        const base64Data = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="; // 1x1 black pixel PNG
        const input = `<p>Test content</p><img class="banner" src="data:image/png;base64,${base64Data}" alt="Base64 Image">`;
        const result = extractInlineImages(input);

        assert(result.html.includes('src="cid:inlineImage_1_'), "The base64 image src should be replaced by a cid reference.");
        assert.strictEqual(result.attachments.length, 1, "One attachment should be generated.");
        
        const attach = result.attachments[0];
        assert(attach.filename.endsWith('.png'), "Mimetype should map to correct extension (.png).");
        assert(attach.cid.startsWith('inlineImage_1_'), "Attachment CID prefix should match the image position.");
        assert(Buffer.isBuffer(attach.content), "Attachment content should be a raw Buffer object.");
        assert.strictEqual(attach.content.toString('base64'), base64Data, "Decoded buffer data must match the original base64 payload.");
        console.log("✓ Test Case 2 Passed: Single base64 image extracted successfully.");
    }

    // Test Case 3: HTML with multiple base64 inline images
    {
        const base64Png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
        const base64Jpeg = "/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=";
        const input = `
            <div>
                <img src="data:image/png;base64,${base64Png}" class="first">
                <p>Paragraph separator</p>
                <img src='data:image/jpeg;base64,${base64Jpeg}' id="second">
            </div>
        `;
        const result = extractInlineImages(input);

        assert.strictEqual(result.attachments.length, 2, "Two attachments should be generated.");
        assert(result.html.includes('src="cid:inlineImage_1_'), "First image should be replaced with cid:inlineImage_1_...");
        assert(result.html.includes('src="cid:inlineImage_2_'), "Second image should be replaced with cid:inlineImage_2_...");
        assert(result.attachments[0].filename.endsWith('.png'), "First attachment should have a .png extension.");
        assert(result.attachments[1].filename.endsWith('.jpeg'), "Second attachment should have a .jpeg extension.");
        console.log("✓ Test Case 3 Passed: Multiple base64 images extracted and mapped correctly.");
    }

    console.log("=== ALL BASE64 EXTRACTOR TESTS PASSED ===");
    process.exit(0);
}

try {
    runTests();
} catch (e) {
    console.error("Test failed with error:", e);
    process.exit(1);
}
