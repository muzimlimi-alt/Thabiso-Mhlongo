const express = require('express');
const db = require('../../database');
const { requireAdmin } = require('../../middleware/auth');
const { getServiceDraftQuoteUsage, countQuoteLineItemsForService } = require('../../database/repositories/invoices-quotations.repository');
const { countBookingLineItemsForService } = require('../../database/repositories/bookings.repository');
const {
    normalizeServicePricing, normalizeQuantityLimits, describePrice, catalogueUnitPrice,
    GROUPS, FEATURED_GROUP, PRICE_TYPES, PRICE_UNITS, PRICE_TYPE_INFO, PRICE_UNIT_LABELS
} = require('../../lib/service-pricing');
const { getVatRate } = require('../../lib/document-totals');
const { requireRole } = require('../../middleware/rbac');
const { getSettingsByKeys, upsertSetting } = require('../../database/repositories/settings.repository');
const moment = require('moment-timezone');
const router = express.Router();

const RATE_CARD_KEYS = ['rate_card_title', 'rate_card_updated', 'rate_card_valid_until', 'rate_card_currency'];
const settingsMap = (rows) => Object.fromEntries((rows || []).map(r => [r.setting_key, r.setting_value]));
// Days from today (business timezone) to the rate card's validity date; negative once it has passed.
function rateCardView(map) {
    if (!map.rate_card_valid_until) return null;
    const tz = 'Africa/Johannesburg';
    const until = moment.tz(map.rate_card_valid_until, 'YYYY-MM-DD', true, tz);
    const daysLeft = until.isValid() ? until.diff(moment.tz(tz).startOf('day'), 'days') : null;
    return {
        title: map.rate_card_title || '', updated: map.rate_card_updated || '', currency: map.rate_card_currency || 'ZAR',
        valid_until: map.rate_card_valid_until, days_left: daysLeft, expired: daysLeft !== null && daysLeft < 0
    };
}

// The pricing columns an audit row records, so every rate change shows what it was and what it became.
const pricingSnapshot = (r) => ({
    default_price: r.default_price, base_price: r.base_price, pricing_model: r.pricing_model,
    price_type: r.price_type, price_min: r.price_min, price_max: r.price_max, price_unit: r.price_unit,
    is_active: r.is_active, is_deleted: r.is_deleted
});

// --- Services CRUD ---
router.get('/api/admin/services', requireAdmin, (req, res) => {
    const activeOnly = req.query.active_only === '1';
    const includeDeleted = req.query.include_deleted === '1';
    let query = "SELECT * FROM services WHERE COALESCE(is_deleted, 0) = 0";
    if (activeOnly) query += " AND COALESCE(is_active, 1) = 1";
    if (includeDeleted) query = "SELECT * FROM services";
    query += " ORDER BY category, name";
    db.all(query, [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        // price_label / quote_required are computed here so every admin screen reads one definition of
        // "what this price means" (lib/service-pricing.js) rather than re-deriving it in the browser.
        // catalogue_unit_price is the ONLY amount a screen may pre-fill for a new booking / quote line
        // (base_price wins over default_price; 0 for every non-fixed type).
        res.json((rows || []).map(r => ({
            ...r, ...describePrice(r), catalogue_unit_price: catalogueUnitPrice(r), service_group_label: GROUPS[r.service_group] || null
        })));
    });
});

// Vocabulary + rate-card validity for the admin screens (declared before the /:id routes).
router.get('/api/admin/services/meta', requireAdmin, (req, res) => {
    getSettingsByKeys(RATE_CARD_KEYS, async (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({
            price_types: PRICE_TYPES.map(value => ({ value, ...PRICE_TYPE_INFO[value] })),
            price_units: PRICE_UNITS.map(value => ({ value, label: PRICE_UNIT_LABELS[value] })),
            groups: Object.keys(GROUPS).map(value => ({ value, label: GROUPS[value], featured: value === FEATURED_GROUP })),
            rate_card: rateCardView(settingsMap(rows)),
            // The VAT rate the server charges (lib/document-totals getVatRate) — the Quote Builder previews with
            // this instead of its own hard-coded 15%, so the preview cannot disagree with the saved quote.
            vat_rate: await getVatRate()
        });
    });
});

// The date the published rates are valid until. It is printed on every quotation and quotation email (and the
// sentence disappears by itself once the date has passed), so the owner needs a way to move it when a new card arrives.
router.put('/api/admin/services/rate-card', requireAdmin, requireRole(['administrator', 'manager']), (req, res) => {
    const validUntil = String((req.body || {}).valid_until || '').trim();
    if (!moment(validUntil, 'YYYY-MM-DD', true).isValid()) {
        return res.status(400).json({ error: 'Enter a real date for "Rates valid until".' });
    }
    getSettingsByKeys(RATE_CARD_KEYS, (gErr, rows) => {
        if (gErr) return res.status(500).json({ error: gErr.message });
        const before = settingsMap(rows).rate_card_valid_until || null;
        upsertSetting('rate_card_valid_until', validUntil, (uErr) => {
            if (uErr) return res.status(500).json({ error: uErr.message });
            db.run(`INSERT INTO audit_log (table_name, record_id, action, changed_by, old_values, new_values, reason)
                    VALUES ('settings', 0, 'RATE_CARD_VALIDITY_UPDATE', ?, ?, ?, 'rate_card_valid_until')`,
                [req.session.username || 'system', JSON.stringify({ valid_until: before }), JSON.stringify({ valid_until: validUntil })], () => {});
            getSettingsByKeys(RATE_CARD_KEYS, (e2, rows2) => res.json({ success: true, rate_card: rateCardView(settingsMap(rows2)) }));
        });
    });
});

router.post('/api/admin/services', requireAdmin, (req, res) => {
    const {
        name, description, category, is_taxable, is_active,
        display_unit, min_quantity, max_quantity,
        service_type, base_uom, pricing_group, is_capital_asset, tax_class,
        sac_code, availability_rule, booking_lead_time_days, setup_time_minutes,
        performance_length_minutes, travel_included, preferred_resource_id,
        cost_center, profit_center, internal_note, external_note, valid_from, valid_to,
        crew_required, financial_category, legacy_code,
        revenue_gl_code, marketing_segment, item_category,
        tax_category, fulfillment_type
    } = req.body;
    if (!name || !String(name).trim()) return res.status(400).json({ error: 'name is required.' });
    const pricing = normalizeServicePricing(req.body, null);
    if (!pricing.ok) return res.status(400).json({ error: pricing.error });
    const p = pricing.fields;
    if (valid_from && valid_to && valid_from > valid_to)
        return res.status(400).json({ error: 'valid_from must be on or before valid_to.' });
    const validCats = ['Performance', 'Travel', 'Production', 'Other'];
    const cat = validCats.includes(category) ? category : 'Other';
    const qty = normalizeQuantityLimits(p.pricing_model, min_quantity, max_quantity);
    if (!qty.ok) return res.status(400).json({ error: qty.error });
    const unitLabel = display_unit || (p.pricing_model === 'per_hour' ? 'hr' : p.pricing_model === 'per_minute' ? 'min' : 'unit');

    db.get("SELECT id FROM services WHERE name = ? AND COALESCE(is_deleted,0) = 0", [name.trim()], (dupErr, dup) => {
    if (dup) return res.status(409).json({ error: `A service named "${name.trim()}" already exists.` });

    db.run(`INSERT INTO services (
        name, description, default_price, category, is_taxable, is_active,
        pricing_model, base_price, min_quantity, max_quantity, display_unit,
        service_type, base_uom, pricing_group, is_capital_asset, tax_class,
        sac_code, availability_rule, booking_lead_time_days, setup_time_minutes,
        performance_length_minutes, travel_included, preferred_resource_id,
        cost_center, profit_center, internal_note, external_note, valid_from, valid_to,
        crew_required, financial_category, legacy_code,
        revenue_gl_code, marketing_segment, item_category,
        tax_category, fulfillment_type,
        price_type, price_min, price_max, price_unit, is_featured, service_group
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
            name, description || null, p.default_price, cat, is_taxable ? 1 : 0, is_active !== false ? 1 : 0,
            p.pricing_model, p.base_price, qty.min, qty.max, unitLabel,
            service_type || 'core', base_uom || 'ea', pricing_group || 'Standard', is_capital_asset ? 1 : 0, tax_class || 'standard',
            sac_code || null, availability_rule || 'any_time', parseInt(booking_lead_time_days) || 0, parseInt(setup_time_minutes) || 0,
            parseInt(performance_length_minutes) || 0, travel_included ? 1 : 0, preferred_resource_id ? parseInt(preferred_resource_id) : null,
            cost_center || null, profit_center || null, internal_note || null, external_note || null, valid_from || null, valid_to || null,
            parseInt(crew_required) || 1, financial_category || null, legacy_code || null,
            revenue_gl_code || null, marketing_segment || null, item_category || 'DIEN',
            tax_category || null, fulfillment_type || 'on_site',
            p.price_type, p.price_min, p.price_max, p.price_unit, p.is_featured, p.service_group
        ],
        function(err) {
            if (err) return res.status(500).json({ error: err.message });

            const adminUser = req.session.username || 'system';
            db.run(
                `INSERT INTO audit_log (table_name, record_id, action, changed_by, new_values)
                 VALUES ('services', ?, 'CREATE', ?, ?)`,
                [this.lastID, adminUser, JSON.stringify({ name, ...pricingSnapshot(p) })],
                () => {}
            );
            db.run(
                `INSERT INTO financial_audit_log (event_type, entity_type, entity_id, amount, changed_by, notes)
                 VALUES ('SERVICE_CREATED', 'service', ?, ?, ?, ?)`,
                [this.lastID, p.default_price, adminUser, `Created service: ${name} (${p.pricing_model}, ${p.price_type})`],
                () => {}
            );

            res.json({ success: true, id: this.lastID });
        });
    }); // end db.get duplicate check
});

router.put('/api/admin/services/:id', requireAdmin, (req, res) => {
    const {
        name, description, category, is_taxable, is_active,
        display_unit, min_quantity, max_quantity,
        service_type, base_uom, pricing_group, is_capital_asset, tax_class,
        sac_code, availability_rule, booking_lead_time_days, setup_time_minutes,
        performance_length_minutes, travel_included, preferred_resource_id,
        cost_center, profit_center, internal_note, external_note, valid_from, valid_to,
        crew_required, financial_category, legacy_code, is_deleted,
        revenue_gl_code, marketing_segment, item_category,
        tax_category, fulfillment_type
    } = req.body;
    if (!name || !String(name).trim()) return res.status(400).json({ error: 'name is required.' });
    if (valid_from && valid_to && valid_from > valid_to)
        return res.status(400).json({ error: 'valid_from must be on or before valid_to.' });
    const validCats = ['Performance', 'Travel', 'Production', 'Other'];
    const cat = validCats.includes(category) ? category : 'Other';

    db.get("SELECT * FROM services WHERE id = ?", [req.params.id], (exErr, existing) => {
    if (exErr) return res.status(500).json({ error: exErr.message });
    if (!existing) return res.status(404).json({ error: 'Service not found.' });

    // Pricing fields the request does not mention keep their stored values (see normalizeServicePricing),
    // so an older admin screen saving an edit cannot turn a range / "from" / enquiry into a free fixed fee.
    const pricing = normalizeServicePricing(req.body, existing);
    if (!pricing.ok) return res.status(400).json({ error: pricing.error });
    const p = pricing.fields;
    const qty = normalizeQuantityLimits(p.pricing_model, min_quantity, max_quantity);
    if (!qty.ok) return res.status(400).json({ error: qty.error });
    const unitLabel = display_unit || (p.pricing_model === 'per_hour' ? 'hr' : p.pricing_model === 'per_minute' ? 'min' : 'unit');
    // Fields the admin form does not send (the Advanced / Financial panel is not on the page, and base unit, SAC code,
    // cost / profit centre and preferred resource never were): a request that does not mention one keeps what is
    // stored instead of resetting it to a default on every save.
    const kept = (k) => (req.body[k] !== undefined ? req.body[k] : existing[k]);

    db.get("SELECT id FROM services WHERE name = ? AND id != ? AND COALESCE(is_deleted,0) = 0", [name.trim(), req.params.id], (dupErr, dup) => {
    if (dup) return res.status(409).json({ error: `Another service named "${name.trim()}" already exists.` });

    db.run(`UPDATE services SET
        name=?, description=?, default_price=?, category=?, is_taxable=?, is_active=?,
        pricing_model=?, base_price=?, min_quantity=?, max_quantity=?, display_unit=?,
        service_type=?, base_uom=?, pricing_group=?, is_capital_asset=?, tax_class=?,
        sac_code=?, availability_rule=?, booking_lead_time_days=?, setup_time_minutes=?,
        performance_length_minutes=?, travel_included=?, preferred_resource_id=?,
        cost_center=?, profit_center=?, internal_note=?, external_note=?, valid_from=?, valid_to=?,
        crew_required=?, financial_category=?, legacy_code=?, is_deleted=?,
        revenue_gl_code=?, marketing_segment=?, item_category=?,
        tax_category=?, fulfillment_type=?,
        price_type=?, price_min=?, price_max=?, price_unit=?, is_featured=?, service_group=?
        WHERE id=?`,
        [
            name, description || null, p.default_price, cat, is_taxable ? 1 : 0, is_active !== false ? 1 : 0,
            p.pricing_model, p.base_price, qty.min, qty.max, unitLabel,
            service_type || 'core', kept('base_uom') || 'ea', pricing_group || 'Standard', kept('is_capital_asset') ? 1 : 0, tax_class || 'standard',
            kept('sac_code') || null, availability_rule || 'any_time', parseInt(booking_lead_time_days) || 0, parseInt(setup_time_minutes) || 0,
            parseInt(performance_length_minutes) || 0, travel_included ? 1 : 0, kept('preferred_resource_id') ? parseInt(kept('preferred_resource_id')) : null,
            kept('cost_center') || null, kept('profit_center') || null, internal_note || null, external_note || null, valid_from || null, valid_to || null,
            parseInt(kept('crew_required')) || 1, kept('financial_category') || null, kept('legacy_code') || null, kept('is_deleted') ? 1 : 0,
            kept('revenue_gl_code') || null, kept('marketing_segment') || null, kept('item_category') || 'DIEN',
            kept('tax_category') || null, kept('fulfillment_type') || 'on_site',
            p.price_type, p.price_min, p.price_max, p.price_unit, p.is_featured, p.service_group,
            req.params.id
        ],
        function(err) {
            if (err) return res.status(500).json({ error: err.message });
            if (this.changes === 0) return res.status(404).json({ error: 'Service not found.' });

            const adminUser = req.session.username || 'system';
            db.run(
                `INSERT INTO audit_log (table_name, record_id, action, changed_by, old_values, new_values)
                 VALUES ('services', ?, 'UPDATE', ?, ?, ?)`,
                [req.params.id, adminUser, JSON.stringify({ name: existing.name, ...pricingSnapshot(existing) }),
                    JSON.stringify({ name, ...pricingSnapshot({ ...p, is_active: is_active !== false ? 1 : 0, is_deleted: kept('is_deleted') ? 1 : 0 }) })],
                () => {}
            );
            db.run(
                `INSERT INTO financial_audit_log (event_type, entity_type, entity_id, amount, changed_by, notes)
                 VALUES ('SERVICE_UPDATED', 'service', ?, ?, ?, ?)`,
                [req.params.id, p.default_price, adminUser, `Updated service: ${name}. Archived: ${kept('is_deleted') ? 'Yes' : 'No'}`],
                () => {}
            );

            res.json({ success: true });
        });
    }); // end db.get duplicate check
    }); // end db.get existing row
});

router.get('/api/admin/services/:id/usage', requireAdmin, (req, res) => {
    const serviceId = req.params.id;
    getServiceDraftQuoteUsage(serviceId, (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ draft_quote_count: row ? row.draft_count : 0 });
    });
});

router.delete('/api/admin/services/:id', requireAdmin, (req, res) => {
    const force = req.query.force === '1';
    const adminUser = req.session.username || 'system';
    if (!force) {
        db.run("UPDATE services SET is_deleted=1 WHERE id=?", [req.params.id], function(err) {
            if (err) return res.status(500).json({ error: err.message });
            if (this.changes === 0) return res.status(404).json({ error: 'Service not found.' });

            db.run(
                `INSERT INTO audit_log (table_name, record_id, action, changed_by)
                 VALUES ('services', ?, 'ARCHIVE', ?)`,
                [req.params.id, adminUser],
                () => {}
            );
            db.run(
                `INSERT INTO financial_audit_log (event_type, entity_type, entity_id, amount, changed_by, notes)
                 VALUES ('SERVICE_ARCHIVED', 'service', ?, 0, ?, 'Service marked as archived (soft-deleted)')`,
                [req.params.id, adminUser],
                () => {}
            );

            res.json({ success: true, soft_deleted: true });
        });
        return;
    }
    countBookingLineItemsForService(req.params.id, (e1, r1) => {
        countQuoteLineItemsForService(req.params.id, (e2, r2) => {
            if ((r1 && r1.cnt > 0) || (r2 && r2.cnt > 0)) {
                return res.status(409).json({ error: 'Service is referenced by existing line items and cannot be hard-deleted.' });
            }
            db.run("DELETE FROM services WHERE id=?", [req.params.id], function(err) {
                if (err) return res.status(500).json({ error: err.message });
                if (this.changes === 0) return res.status(404).json({ error: 'Service not found.' });

                db.run(
                    `INSERT INTO audit_log (table_name, record_id, action, changed_by)
                     VALUES ('services', ?, 'HARD_DELETE', ?)`,
                    [req.params.id, adminUser],
                    () => {}
                );

                res.json({ success: true });
            });
        });
    });
});

module.exports = router;
