const path = require('path');
const assert = require('assert');

const projectDir = path.join(__dirname, '..');
const db = require(path.join(projectDir, 'database'));

function findOrCreateVenueFromPlace(venueName, address, city, country, placeId) {
    return new Promise((resolve, reject) => {
        if (!venueName && !address) return resolve(null);
        const searchName = venueName || address;
        const query = placeId
            ? "SELECT id FROM venues WHERE place_id = ?"
            : "SELECT id FROM venues WHERE name = ? OR address = ?";
        const params = placeId ? [placeId] : [searchName, address];
        db.get(query, params, (err, row) => {
            if (err) return reject(err);
            if (row) {
                db.run("UPDATE venues SET city = COALESCE(city, ?), country = COALESCE(country, ?), place_id = COALESCE(place_id, ?), updated_at = CURRENT_TIMESTAMP WHERE id = ?",
                    [city || null, country || null, placeId || null, row.id]);
                return resolve(row.id);
            }
            db.run(
                `INSERT INTO venues (name, address, city, country, place_id)
                 VALUES (?, ?, ?, ?, ?)`,
                [venueName, address || null, city || null, country || null, placeId || null],
                function(insertErr) {
                    if (insertErr) return reject(insertErr);
                    resolve(this.lastID);
                }
            );
        });
    });
}

async function runTest() {
    console.log("Starting Google Places Venue Auto-population Test...");

    const testPlaceId = `test_place_${Date.now()}`;
    const testName = "Test Theater";
    const testAddress = "123 Comedy St, Cape Town";
    const testCity = "Cape Town";
    const testCountry = "South Africa";

    // 1. Create venue from place details
    const venueId = await findOrCreateVenueFromPlace(testName, testAddress, testCity, testCountry, testPlaceId);
    console.log("✓ Resolved venue ID:", venueId);
    assert(venueId > 0, "Venue ID must be a positive integer");

    // 2. Query from database to verify all columns are filled
    const row = await new Promise((resolve, reject) => {
        db.get("SELECT * FROM venues WHERE id = ?", [venueId], (err, row) => {
            if (err) reject(err);
            else resolve(row);
        });
    });

    console.log("✓ Retrieved venue from database:", JSON.stringify(row, null, 2));
    assert.strictEqual(row.name, testName);
    assert.strictEqual(row.address, testAddress);
    assert.strictEqual(row.city, testCity);
    assert.strictEqual(row.country, testCountry);
    assert.strictEqual(row.place_id, testPlaceId);

    // 3. Clean up test data
    await new Promise((resolve) => {
        db.run("DELETE FROM venues WHERE id = ?", [venueId], () => {
            resolve();
        });
    });

    console.log("✓ Cleanup complete. Test PASSED!");
    process.exit(0);
}

runTest().catch(err => {
    console.error("Test FAILED:", err);
    process.exit(1);
});
