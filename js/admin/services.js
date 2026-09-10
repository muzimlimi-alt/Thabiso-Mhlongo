/* Phase 6 (HOUSEKEEPING-NOTES.md): relocated from admin.html verbatim — the "Services CRUD"
   block (Services Catalogue tab: category pill filter, stats, list/filter rendering, the
   #svcDrawer create/edit form, save/delete/restore). Every function reachable from the
   section's static onclick/oninput/onchange attributes was already window-attached in the
   original source — no new attachments were needed. svcDrawerOpen()/atlDrawerPush() etc. are
   shared drawer-stacking helpers defined elsewhere in admin.html and are called, not moved. */

// ─── Services CRUD ───
var allServicesCache = [];
var _showArchivedServices = false;
var _svcActiveCat = '';

// Pill click — filter by category
$(document).on('click', '.svc-cat-pill', function() {
    _svcActiveCat = $(this).data('cat');
    $('.svc-cat-pill').removeClass('active');
    $(this).addClass('active');
    filterServicesTable();
});

function _updateSvcStats() {
    const all      = allServicesCache;
    const nonDel   = all.filter(function(s){ return !s.is_deleted; });
    const active   = nonDel.filter(function(s){ return s.is_active !== 0; });
    const inactive = nonDel.filter(function(s){ return s.is_active === 0; });
    const archived = all.filter(function(s){ return s.is_deleted; });
    $('#svcStat-Total').text(nonDel.length);
    $('#svcStat-Active').text(active.length);
    $('#svcStat-Inactive').text(inactive.length);
    $('#svcStat-Archived').text(archived.length);
    var cats = ['Performance','Travel','Production','Other'];
    $('#svcPill-All').text(nonDel.length);
    cats.forEach(function(c){ $('#svcPill-' + c).text(nonDel.filter(function(s){ return s.category === c; }).length); });
}

window.clearSvcFilters = function() {
    $('#svcSearchInput').val('');
    $('#svcModelFilter,#svcStatusFilter').val('');
    _svcActiveCat = '';
    $('.svc-cat-pill').removeClass('active');
    $('.svc-cat-pill[data-cat=""]').addClass('active');
    filterServicesTable();
};

window.toggleArchivedServices = async function() {
    _showArchivedServices = !_showArchivedServices;
    const $btn = $('#svcShowArchivedBtn');
    if (_showArchivedServices) {
        $btn.html('<i class="fa-solid fa-eye-slash" style="margin-right:5px;"></i>Hide Archived').css('color', 'var(--atl-amber)');
    } else {
        $btn.html('<i class="fa-solid fa-archive" style="margin-right:5px;"></i>Show Archived').css('color', '');
    }
    await loadAdminServices();
};

window.restoreService = async function(id) {
    const s = allServicesCache.find(x => x.id == id);
    if (!s) return;
    try {
        await apiCall('/api/admin/services/' + id, 'PUT', { ...s, is_deleted: 0, is_active: s.is_active !== 0 ? true : false });
        await loadAdminServices();
        window.notificationService.showSuccess('Service restored.');
    } catch(e) {}
};

window.loadAdminServices = async function() {
    const $grid = $('#svcCardGrid');
    $grid.html('<div class="svc-empty-state"><i class="fa-solid fa-spinner fa-spin"></i><p>Loading services…</p></div>');
    try {
        const endpoint = _showArchivedServices ? '/api/admin/services?include_deleted=1' : '/api/admin/services';
        const data = await apiCall(endpoint);
        allServicesCache = Array.isArray(data) ? data : [];
        _updateSvcStats();
        if (!allServicesCache.length) {
            $grid.html('<div class="svc-empty-state"><i class="fa-solid fa-layer-group"></i><p>No services yet.</p><button class="atl-btn atl-btn--primary" onclick="toggleServiceForm()"><i class="fa-solid fa-plus" style="margin-right:6px;"></i>Add First Service</button></div>');
            $('#svcFilterCount').text('');
            return;
        }
        filterServicesTable();
    } catch(e) {
        console.error('Failed to load services:', e);
        window.notificationService.showError('Could not load services — please refresh.');
        $grid.html('<div class="svc-empty-state"><i class="fa-solid fa-circle-exclamation" style="color:var(--atl-clay);"></i><p style="color:var(--atl-clay);">Failed to load services. Please refresh.</p></div>');
    }
};

window.filterServicesTable = function() {
    const q      = ($('#svcSearchInput').val() || '').toLowerCase();
    const model  = $('#svcModelFilter').val();
    const status = $('#svcStatusFilter').val();
    const filtered = allServicesCache.filter(s => {
        if (q && !(s.name || '').toLowerCase().includes(q) && !(s.description || '').toLowerCase().includes(q)) return false;
        if (_svcActiveCat && s.category !== _svcActiveCat) return false;
        if (model  && s.pricing_model !== model) return false;
        if (status === 'active'   && s.is_active === 0) return false;
        if (status === 'inactive' && s.is_active !== 0) return false;
        return true;
    });
    const $grid = $('#svcCardGrid');
    if (!filtered.length) {
        $grid.html('<div class="svc-empty-state"><i class="fa-solid fa-layer-group"></i><p>No services match the current filters.</p><button class="atl-btn atl-btn--ghost" onclick="clearSvcFilters()">Clear filters</button></div>');
    } else {
        $grid.html(filtered.map(s => {
            const statusBadge = s.is_deleted
                ? `<span style="background:rgba(100,100,100,0.15);color:var(--atl-muted-dim);padding:2px 8px;border-radius:10px;font-size:10px;font-weight:700;">ARCHIVED</span>`
                : s.is_active !== 0
                    ? `<span style="background:rgba(52,211,153,0.15);color:var(--atl-sage);padding:2px 8px;border-radius:10px;font-size:10px;font-weight:700;">ACTIVE</span>`
                    : `<span style="background:rgba(248,113,113,0.15);color:var(--atl-clay);padding:2px 8px;border-radius:10px;font-size:10px;font-weight:700;">INACTIVE</span>`;
            const modelLabel = s.pricing_model === 'per_minute' ? 'Per Min' : s.pricing_model === 'per_hour' ? 'Per Hour' : 'Flat Fee';
            const limitsHtml = s.pricing_model !== 'flat_fee' ? `<p class="svc-card__limits">${s.min_quantity || 15}–${s.max_quantity || '∞'} min</p>` : '';
            const safeNote   = (s.external_note || '').replace(/"/g, '&quot;');
            return `<div class="svc-card${s.is_deleted ? ' svc-card--archived' : ''}" data-id="${s.id}">
              <div class="svc-card__header">
                <span class="svc-card__cat-badge svc-cat--${(s.category||'Other').toLowerCase()}">${s.category||'Other'}</span>
                ${statusBadge}
              </div>
              <h4 class="svc-card__name">${s.name}</h4>
              ${s.description ? `<p class="svc-card__desc">${s.description}</p>` : ''}
              <div class="svc-card__price">
                R ${parseFloat(s.default_price||0).toLocaleString('en-ZA',{minimumFractionDigits:2})}
                <span class="svc-card__model-badge">${modelLabel}</span>
              </div>
              ${limitsHtml}
              ${s.display_unit ? `<p class="svc-card__unit">${s.display_unit}</p>` : ''}
              <div class="svc-card__tags">
                ${s.travel_included ? '<span class="svc-tag svc-tag--travel"><i class="fa-solid fa-car-side"></i> Travel incl.</span>' : ''}
                ${s.availability_rule === 'per_day' ? '<span class="svc-tag svc-tag--perday"><i class="fa-solid fa-calendar-day"></i> Per day</span>' : ''}
                ${s.external_note ? `<span class="svc-tag svc-tag--note" title="${safeNote}"><i class="fa-solid fa-note-sticky"></i> Note</span>` : ''}
              </div>
              <div class="svc-card__footer">
                ${s.is_deleted
                  ? `<button class="atl-btn atl-btn--ghost svc-card__action" onclick="restoreService(${s.id})" style="font-size:11px;width:100%;"><i class="fa-solid fa-rotate-left" style="margin-right:4px;"></i>Restore</button>`
                  : `<button class="atl-btn atl-btn--ghost svc-card__action btn-svc-edit" data-id="${s.id}"><i class="fa-solid fa-pen" style="margin-right:4px;"></i>Edit</button>
                     <button class="atl-btn svc-card__action btn-svc-delete" data-id="${s.id}" style="background:rgba(248,113,113,0.08);color:var(--atl-clay);border:1px solid rgba(248,113,113,0.2);flex:0;padding:0 12px;" title="Archive"><i class="fa-solid fa-archive"></i></button>`
                }
              </div>
            </div>`;
        }).join(''));
    }
    const total = allServicesCache.length;
    $('#svcFilterCount').text(filtered.length < total ? `${filtered.length} of ${total}` : `${total} service${total !== 1 ? 's' : ''}`);
};

// Shared open step for #svcDrawer (called from both toggleServiceForm and editService) — folds
// in the same drawer-stacking bookkeeping as .atl-drawer/.qb-drawer (see atlDrawerPush) so
// this drawer can't silently render behind another one that's already open.
function svcDrawerOpen() {
    var z = atlDrawerPush('svcDrawer', function() { cancelServiceForm(); });
    $('#svcDrawerBackdrop').css('z-index', z.backdropZ).fadeIn(200);
    $('#svcDrawer').css('z-index', z.drawerZ).addClass('svc-drawer--open');
    $('#svcDrawer .svc-drawer__body').scrollTop(0);
    atlDrawerFocusEntry({ id: 'svcDrawer' });
}

window.toggleServiceForm = function() {
    if ($('#svcDrawer').hasClass('svc-drawer--open')) { cancelServiceForm(); return; }
    $('#svcEditId').val(''); $('#svcName,#svcDesc,#svcPrice,#svcUnit,#svcBasePrice').val('');
    $('#svcCategory').val('Performance'); $('#svcPricingModel').val('flat_fee');
    $('#svcMinQty').val('15'); $('#svcMaxQty').val('1440');
    $('#svcTaxable').prop('checked', true); $('#svcActive').prop('checked', true);
    $('#svcType').val('core'); $('#svcPricingGroup').val('Standard');
    $('#svcAvailabilityRule').val('any_time'); $('#svcLeadTime').val('0');
    $('#svcSetupTime').val('0'); $('#svcPerfLength').val('0');
    $('#svcTaxClass').val('standard'); $('#svcTravelIncluded').prop('checked', false);
    $('#svcAdvancedPanel').hide();
    $('#svcFinancialCategory,#svcMarketingSegment,#svcTaxCategory').val('');
    $('#svcItemCategory').val('DIEN'); $('#svcFulfillmentType').val('on_site');
    $('#svcRevenueGlCode,#svcLegacyCode').val('');
    $('#svcCrewRequired').val('1'); $('#svcIsDeleted').prop('checked', false);
    $('#svcInternalNote,#svcExternalNote').val('');
    $('#svcValidFrom,#svcValidTo').val('');
    $('#svcDrawerTitle').text('New Service');
    window.togglePricingFields();
    svcDrawerOpen();
};

window.togglePricingFields = function() {
    const model = $('#svcPricingModel').val();
    if (model === 'flat_fee') {
        $('#svcTimeFields').hide();
        $('#svcPriceLabel').html('Flat Price (R) <span class="atl-req">*</span>');
    } else {
        $('#svcTimeFields').show();
        $('#svcPriceLabel').html('Base Price / Min (R) <span class="atl-req">*</span>');
    }
};

window.cancelServiceForm = function() {
    $('#svcDrawer').removeClass('svc-drawer--open');
    $('#svcDrawerBackdrop').fadeOut(200);
    atlDrawerFocusEntry(atlDrawerPop('svcDrawer'));
    $('#svcEditId').val('');
};

window.openQuoteDrawer = function() {
    // Same stacking bookkeeping as .atl-drawer (see atlDrawerPush) — the Quote Builder can be
    // opened via Deal View's own "Send Quote" CTA while the Deal View drawer is still open
    // behind it, and both share one static CSS z-index without this.
    var z = atlDrawerPush('quoteDrawer', function() { closeQuoteDrawer(); });
    $('#qbDrawerBackdrop').css('z-index', z.backdropZ).fadeIn(200);
    $('#quoteDrawer').css('z-index', z.drawerZ).addClass('qb-drawer--open');
    $('#quoteDrawer .qb-drawer__body').scrollTop(0);
    atlDrawerFocusEntry({ id: 'quoteDrawer' });
};
window.closeQuoteDrawer = function() {
    $('#quoteDrawer').removeClass('qb-drawer--open');
    $('#qbDrawerBackdrop').fadeOut(200);
    atlDrawerFocusEntry(atlDrawerPop('quoteDrawer'));
    if (qbAutoSaveTimeout) {
        clearTimeout(qbAutoSaveTimeout);
        qbAutoSaveTimeout = null;
    }
    qbHasUnsavedChanges = false;
};

window.editService = function(id) {
    const s = allServicesCache.find(x => x.id == id);
    if (!s) return;
    $('#svcEditId').val(s.id); $('#svcName').val(s.name); $('#svcDesc').val(s.description||'');
    $('#svcPrice').val(s.default_price); $('#svcCategory').val(s.category||'Other');
    $('#svcPricingModel').val(s.pricing_model || 'flat_fee');
    $('#svcUnit').val(s.display_unit || '');
    $('#svcMinQty').val(s.min_quantity || 15);
    $('#svcMaxQty').val(s.max_quantity || 1440);
    $('#svcTaxable').prop('checked', !!s.is_taxable);
    $('#svcActive').prop('checked', s.is_active !== 0);
    $('#svcBasePrice').val(s.base_price || '');
    $('#svcType').val(s.service_type || 'core');
    $('#svcPricingGroup').val(s.pricing_group || 'Standard');
    $('#svcAvailabilityRule').val(s.availability_rule || 'any_time');
    $('#svcLeadTime').val(s.booking_lead_time_days || 0);
    $('#svcSetupTime').val(s.setup_time_minutes || 0);
    $('#svcPerfLength').val(s.performance_length_minutes || 0);
    $('#svcTaxClass').val(s.tax_class || 'standard');
    $('#svcTravelIncluded').prop('checked', !!s.travel_included);
    $('#svcFinancialCategory').val(s.financial_category || '');
    $('#svcMarketingSegment').val(s.marketing_segment || '');
    $('#svcItemCategory').val(s.item_category || 'DIEN');
    $('#svcFulfillmentType').val(s.fulfillment_type || 'on_site');
    $('#svcTaxCategory').val(s.tax_category || '');
    $('#svcRevenueGlCode').val(s.revenue_gl_code || '');
    $('#svcCrewRequired').val(s.crew_required || 1);
    $('#svcLegacyCode').val(s.legacy_code || '');
    $('#svcIsDeleted').prop('checked', !!s.is_deleted);
    $('#svcInternalNote').val(s.internal_note || '');
    $('#svcExternalNote').val(s.external_note || '');
    $('#svcValidFrom').val(s.valid_from || '');
    $('#svcValidTo').val(s.valid_to || '');
    if (s.financial_category || s.revenue_gl_code || s.legacy_code || s.marketing_segment || s.is_deleted || s.internal_note || s.external_note || s.valid_from || s.valid_to) {
        $('#svcAdvancedPanel').show();
    } else {
        $('#svcAdvancedPanel').hide();
    }
    $('#svcDrawerTitle').text('Edit: ' + s.name);
    window.togglePricingFields();
    svcDrawerOpen();
};

window.saveService = async function() {
    const id = $('#svcEditId').val();
    const model = $('#svcPricingModel').val();
    const minQ = parseInt($('#svcMinQty').val()) || 1;
    const maxQ = parseInt($('#svcMaxQty').val()) || 1;

    // Validation
    if (model !== 'flat_fee') {
        if (minQ < 15) { window.notificationService.showError('Minimum quantity for time-based services must be at least 15 minutes.'); return; }
        if (minQ > maxQ) { window.notificationService.showError('Minimum quantity cannot exceed Maximum quantity.'); return; }
    }
    const validFrom = $('#svcValidFrom').val();
    const validTo   = $('#svcValidTo').val();
    if (validFrom && validTo && validFrom > validTo) {
        window.notificationService.showError('Valid From must be on or before Valid To.');
        return;
    }

    const body = {
        name: $('#svcName').val().trim(),
        description: $('#svcDesc').val().trim(),
        default_price: parseFloat($('#svcPrice').val()),
        category: $('#svcCategory').val(),
        pricing_model: model,
        display_unit: $('#svcUnit').val().trim(),
        // flat_fee services always get qty=1/null; server enforces the same
        min_quantity: model === 'flat_fee' ? 1 : minQ,
        max_quantity: model === 'flat_fee' ? null : maxQ,
        is_taxable: $('#svcTaxable').is(':checked'), 
        is_active: $('#svcActive').is(':checked'),
        
        // New fields
        service_type: $('#svcType').val(),
        pricing_group: $('#svcPricingGroup').val(),
        availability_rule: $('#svcAvailabilityRule').val(),
        booking_lead_time_days: parseInt($('#svcLeadTime').val()) || 0,
        setup_time_minutes: parseInt($('#svcSetupTime').val()) || 0,
        performance_length_minutes: parseInt($('#svcPerfLength').val()) || 0,
        tax_class: $('#svcTaxClass').val(),
        travel_included: $('#svcTravelIncluded').is(':checked'),
        // Advanced / financial fields
        financial_category:  $('#svcFinancialCategory').val() || null,
        marketing_segment:   $('#svcMarketingSegment').val() || null,
        item_category:       $('#svcItemCategory').val().trim() || 'DIEN',
        fulfillment_type:    $('#svcFulfillmentType').val() || 'on_site',
        tax_category:        $('#svcTaxCategory').val() || null,
        revenue_gl_code:     $('#svcRevenueGlCode').val().trim() || null,
        crew_required:       parseInt($('#svcCrewRequired').val()) || 1,
        legacy_code:         $('#svcLegacyCode').val().trim() || null,
        base_price:          parseFloat($('#svcBasePrice').val()) || null,
        is_deleted:          $('#svcIsDeleted').is(':checked') ? 1 : 0,
        internal_note:       $('#svcInternalNote').val().trim() || null,
        external_note:       $('#svcExternalNote').val().trim() || null,
        valid_from:          $('#svcValidFrom').val() || null,
        valid_to:            $('#svcValidTo').val() || null
    };
    
    if (!body.name || isNaN(body.default_price)) { 
        window.notificationService.showError('Name and price are required.'); 
        return; 
    }
    if (body.default_price < 0) {
        window.notificationService.showError('Price cannot be negative.');
        return;
    }
    try {
        if (id) {
            const originalSvc = allServicesCache.find(x => x.id == id);
            const priceChanged = originalSvc && (parseFloat(originalSvc.default_price) !== body.default_price || originalSvc.pricing_model !== body.pricing_model);
            if (priceChanged) {
                try {
                    const usage = await apiCall('/api/admin/services/' + id + '/usage');
                    if (usage && usage.draft_quote_count > 0) {
                        const proceed = await window.notificationService.showConfirm({
                            title: "Confirm Pricing Change",
                            message: `This service is currently associated with ${usage.draft_quote_count} active draft quotation(s). Changing its price or pricing model will not retroactively update those drafts. Do you want to proceed?`,
                            isDestructive: false
                        });
                        if (!proceed) return;
                    }
                } catch (err) {
                    console.error("Failed to check service usage:", err);
                }
            }
            await apiCall('/api/admin/services/' + id, 'PUT', body);
        }
        else { await apiCall('/api/admin/services', 'POST', body); }
        await loadAdminServices();
        window.notificationService.showSuccess('Service saved successfully.');
        cancelServiceForm(); // only on success — leave the form open if the save failed
    } catch(e) {
        console.error('Failed to save service:', e);
        window.notificationService.showError('Could not save service — please check your input and try again.');
    }
};

window.deleteService = async function(id) {
    if (!await window.notificationService.showConfirm({
        title: "Archive Service",
        message: 'This will archive the service so it no longer appears in new bookings. Existing bookings are unaffected.',
        isDestructive: true
    })) return;
    try {
        await apiCall('/api/admin/services/' + id, 'DELETE');
        await loadAdminServices();
        window.notificationService.showSuccess('Service archived.');
    } catch(e) {
        console.error('Failed to archive service:', e);
        window.notificationService.showError('Could not archive service — please try again.');
    }
};
