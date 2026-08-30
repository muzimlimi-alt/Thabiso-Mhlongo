const express = require('express');
const db = require('../../database');
const { requireAdmin } = require('../../middleware/auth');
const { getServiceDraftQuoteUsage, countQuoteLineItemsForService } = require('../../database/repositories/invoices-quotations.repository');
const { countBookingLineItemsForService } = require('../../database/repositories/bookings.repository');
const router = express.Router();

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
        res.json(rows || []);
    });
});

router.post('/api/admin/services', requireAdmin, (req, res) => {
    const {
        name, description, default_price, category, is_taxable, is_active,
        pricing_model, base_price, min_quantity, max_quantity, display_unit,
        service_type, base_uom, pricing_group, is_capital_asset, tax_class,
        sac_code, availability_rule, booking_lead_time_days, setup_time_minutes,
        performance_length_minutes, travel_included, preferred_resource_id,
        cost_center, profit_center, internal_note, external_note, valid_from, valid_to,
        crew_required, financial_category, legacy_code,
        revenue_gl_code, marketing_segment, item_category,
        tax_category, fulfillment_type
    } = req.body;
    if (!name || default_price === undefined || isNaN(parseFloat(default_price))) return res.status(400).json({ error: 'name and default_price are required.' });
    if (parseFloat(default_price) < 0) return res.status(400).json({ error: 'default_price cannot be negative.' });
    if (valid_from && valid_to && valid_from > valid_to)
        return res.status(400).json({ error: 'valid_from must be on or before valid_to.' });
    const validCats = ['Performance', 'Travel', 'Production', 'Other'];
    const cat = validCats.includes(category) ? category : 'Other';
    const isFlat = (pricing_model || 'flat_fee') === 'flat_fee';
    const normMinQty = isFlat ? 1 : (parseInt(min_quantity) || 1);
    const normMaxQty = isFlat ? null : (parseInt(max_quantity) || null);
    if (!isFlat) {
        if (normMinQty < 15) return res.status(400).json({ error: 'Minimum quantity for time-based services must be at least 15 minutes.' });
        if (normMinQty > (normMaxQty || Infinity)) return res.status(400).json({ error: 'Minimum quantity cannot exceed maximum quantity.' });
    }

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
        tax_category, fulfillment_type
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
            name, description || null, parseFloat(default_price), cat, is_taxable ? 1 : 0, is_active !== false ? 1 : 0,
            pricing_model || 'flat_fee', base_price ? parseFloat(base_price) : null, normMinQty, normMaxQty, display_unit || 'unit',
            service_type || 'core', base_uom || 'ea', pricing_group || 'Standard', is_capital_asset ? 1 : 0, tax_class || 'standard',
            sac_code || null, availability_rule || 'any_time', parseInt(booking_lead_time_days) || 0, parseInt(setup_time_minutes) || 0,
            parseInt(performance_length_minutes) || 0, travel_included ? 1 : 0, preferred_resource_id ? parseInt(preferred_resource_id) : null,
            cost_center || null, profit_center || null, internal_note || null, external_note || null, valid_from || null, valid_to || null,
            parseInt(crew_required) || 1, financial_category || null, legacy_code || null,
            revenue_gl_code || null, marketing_segment || null, item_category || 'DIEN',
            tax_category || null, fulfillment_type || 'on_site'
        ],
        function(err) {
            if (err) return res.status(500).json({ error: err.message });
            
            const adminUser = req.session.username || 'system';
            db.run(
                `INSERT INTO audit_log (table_name, record_id, action, changed_by, new_values)
                 VALUES ('services', ?, 'CREATE', ?, ?)`,
                [this.lastID, adminUser, JSON.stringify({ name, default_price: parseFloat(default_price), pricing_model })],
                () => {}
            );
            db.run(
                `INSERT INTO financial_audit_log (event_type, entity_type, entity_id, amount, changed_by, notes)
                 VALUES ('SERVICE_CREATED', 'service', ?, ?, ?, ?)`,
                [this.lastID, parseFloat(default_price), adminUser, `Created service: ${name} (${pricing_model})`],
                () => {}
            );

            res.json({ success: true, id: this.lastID });
        });
    }); // end db.get duplicate check
});

router.put('/api/admin/services/:id', requireAdmin, (req, res) => {
    const {
        name, description, default_price, category, is_taxable, is_active,
        pricing_model, base_price, min_quantity, max_quantity, display_unit,
        service_type, base_uom, pricing_group, is_capital_asset, tax_class,
        sac_code, availability_rule, booking_lead_time_days, setup_time_minutes,
        performance_length_minutes, travel_included, preferred_resource_id,
        cost_center, profit_center, internal_note, external_note, valid_from, valid_to,
        crew_required, financial_category, legacy_code, is_deleted,
        revenue_gl_code, marketing_segment, item_category,
        tax_category, fulfillment_type
    } = req.body;
    if (!name || default_price === undefined || isNaN(parseFloat(default_price))) return res.status(400).json({ error: 'name and default_price are required.' });
    if (parseFloat(default_price) < 0) return res.status(400).json({ error: 'default_price cannot be negative.' });
    if (valid_from && valid_to && valid_from > valid_to)
        return res.status(400).json({ error: 'valid_from must be on or before valid_to.' });
    const validCats = ['Performance', 'Travel', 'Production', 'Other'];
    const cat = validCats.includes(category) ? category : 'Other';
    const isFlat = (pricing_model || 'flat_fee') === 'flat_fee';
    const normMinQty = isFlat ? 1 : (parseInt(min_quantity) || 1);
    const normMaxQty = isFlat ? null : (parseInt(max_quantity) || null);
    if (!isFlat) {
        if (normMinQty < 15) return res.status(400).json({ error: 'Minimum quantity for time-based services must be at least 15 minutes.' });
        if (normMinQty > (normMaxQty || Infinity)) return res.status(400).json({ error: 'Minimum quantity cannot exceed maximum quantity.' });
    }

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
        tax_category=?, fulfillment_type=?
        WHERE id=?`,
        [
            name, description || null, parseFloat(default_price), cat, is_taxable ? 1 : 0, is_active !== false ? 1 : 0,
            pricing_model || 'flat_fee', base_price ? parseFloat(base_price) : null, normMinQty, normMaxQty, display_unit || 'unit',
            service_type || 'core', base_uom || 'ea', pricing_group || 'Standard', is_capital_asset ? 1 : 0, tax_class || 'standard',
            sac_code || null, availability_rule || 'any_time', parseInt(booking_lead_time_days) || 0, parseInt(setup_time_minutes) || 0,
            parseInt(performance_length_minutes) || 0, travel_included ? 1 : 0, preferred_resource_id ? parseInt(preferred_resource_id) : null,
            cost_center || null, profit_center || null, internal_note || null, external_note || null, valid_from || null, valid_to || null,
            parseInt(crew_required) || 1, financial_category || null, legacy_code || null, is_deleted ? 1 : 0,
            revenue_gl_code || null, marketing_segment || null, item_category || 'DIEN',
            tax_category || null, fulfillment_type || 'on_site',
            req.params.id
        ],
        function(err) {
            if (err) return res.status(500).json({ error: err.message });
            if (this.changes === 0) return res.status(404).json({ error: 'Service not found.' });
            
            const adminUser = req.session.username || 'system';
            db.run(
                `INSERT INTO audit_log (table_name, record_id, action, changed_by, new_values)
                 VALUES ('services', ?, 'UPDATE', ?, ?)`,
                [req.params.id, adminUser, JSON.stringify({ name, default_price: parseFloat(default_price), pricing_model, is_deleted })],
                () => {}
            );
            db.run(
                `INSERT INTO financial_audit_log (event_type, entity_type, entity_id, amount, changed_by, notes)
                 VALUES ('SERVICE_UPDATED', 'service', ?, ?, ?, ?)`,
                [req.params.id, parseFloat(default_price), adminUser, `Updated service: ${name}. Archived: ${is_deleted ? 'Yes' : 'No'}`],
                () => {}
            );

            res.json({ success: true });
        });
    }); // end db.get duplicate check
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
