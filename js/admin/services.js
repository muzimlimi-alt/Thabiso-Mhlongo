/* Phase 6 (HOUSEKEEPING-NOTES.md): relocated from admin.html verbatim — the "Services CRUD"
   block (Services Catalogue tab: category pill filter, stats, list/filter rendering, the
   #svcDrawer create/edit form, save/delete/restore). Every function reachable from the
   section's static onclick/oninput/onchange attributes was already window-attached in the
   original source — no new attachments were needed. svcDrawerOpen()/atlDrawerPush() etc. are
   shared drawer-stacking helpers defined elsewhere in admin.html and are called, not moved. */

// ─── Services CRUD ───
var allServicesCache = [];
var _showArchivedServices = false;
// Vocabulary + rate-card validity from GET /api/admin/services/meta (price types, units, rate-card groups). The
// server owns it (lib/service-pricing.js); the browser keeps no copy of the list.
var _svcMeta = null;
var _svcActiveGroup = '';          // '' = all, '__none' = services without a rate-card group (add-ons etc.), else a group slug
var SVC_NO_GROUP = '__none';

// Labels from the server are plain text (not entity-encoded stored text), so they are escaped here before going into HTML.
function _svcEsc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function _svcGroups() { return (_svcMeta && _svcMeta.groups) || []; }
function _svcGroupRank(s) {
    var i = _svcGroups().findIndex(function(g) { return g.value === s.service_group; });
    return i === -1 ? 999 : i;
}
// A thumb icon stands in for a photo (services have none) — one per rate-card group, matching
// the shared .atl-edit-card list's thumb slot used by Events/Accolades/Career/etc.
var SVC_GROUP_ICON = {
    club_theatre: 'fa-masks-theater', corporate_events: 'fa-briefcase', private_functions: 'fa-champagne-glasses',
    writing_creative: 'fa-pen-nib', acting_voice_brand: 'fa-microphone-lines'
};
var SVC_CATEGORY_ICON = { performance: 'fa-masks-theater', travel: 'fa-car-side', production: 'fa-clapperboard', other: 'fa-ellipsis' };
function _svcThumbIcon(s) {
    if (s.service_group) return SVC_GROUP_ICON[s.service_group] || 'fa-concierge-bell';
    // ungrouped rows (Add-ons & other): fall back to the legacy category, else a generic add-on icon
    return (s.category && SVC_CATEGORY_ICON[s.category.toLowerCase()]) || 'fa-layer-group';
}

// Pill click — filter by rate-card group
$(document).on('click', '.svc-cat-pill', function() {
    _svcActiveGroup = $(this).attr('data-group') || '';
    $('.svc-cat-pill').removeClass('active');
    $(this).addClass('active');
    filterServicesTable();
});

// The group pills are built from the server's list (club / corporate / private / writing / acting-voice-brand), then
// "Add-ons & other" for services with no group (travel, accommodation, rider, merchandise, legacy rows).
function _renderSvcGroupPills() {
    var html = '<button type="button" class="atl-pill svc-cat-pill' + (!_svcActiveGroup ? ' active' : '') + '" data-group="">All <span class="atl-pill-count" id="svcPill-All">0</span></button>';
    _svcGroups().forEach(function(g) {
        html += '<button type="button" class="atl-pill svc-cat-pill' + (_svcActiveGroup === g.value ? ' active' : '') + '" data-group="' + _svcEsc(g.value) + '">'
            + '<span class="atl-pill-dot" style="background:var(--atl-amber);"></span>' + _svcEsc(g.label)
            + (g.featured ? ' <i class="fa-solid fa-star" title="Most Booked" aria-label="Most Booked" style="color:var(--atl-amber);font-size:10px;"></i>' : '')
            + ' <span class="atl-pill-count" id="svcPill-' + _svcEsc(g.value) + '">0</span></button>';
    });
    html += '<button type="button" class="atl-pill svc-cat-pill' + (_svcActiveGroup === SVC_NO_GROUP ? ' active' : '') + '" data-group="' + SVC_NO_GROUP + '">'
        + '<span class="atl-pill-dot" style="background:var(--atl-muted);"></span>Add-ons &amp; other <span class="atl-pill-count" id="svcPill-none">0</span></button>';
    $('#svcCategoryPipeline').html(html);
}

// Fill the price-type / unit / group selects from the server's lists (the static markup only carries a fallback option).
function _populateSvcSelects() {
    if (!_svcMeta) return;
    function fill(sel, firstLabel, items) {
        var $s = $(sel); if (!$s.length) return;
        var cur = $s.val();
        var html = firstLabel != null ? '<option value="">' + _svcEsc(firstLabel) + '</option>' : '';
        items.forEach(function(it) { html += '<option value="' + _svcEsc(it.value) + '">' + _svcEsc(it.label) + '</option>'; });
        $s.html(html);
        if (cur != null && $s.find('option[value="' + cur + '"]').length) $s.val(cur);
    }
    fill('#svcPriceType', null, _svcMeta.price_types || []);
    fill('#svcPriceTypeFilter', 'All Price Types', _svcMeta.price_types || []);
    fill('#svcPriceUnit', '— not applicable —', _svcMeta.price_units || []);
    fill('#svcGroup', '— none (add-on / other) —', _svcGroups());
}

// Validity of the published rates (printed on every quotation + quotation email) — a banner, with the date editable.
function _renderRateCardBanner() {
    var rc = _svcMeta && _svcMeta.rate_card;
    var $b = $('#svcRateCardBanner');
    if (!rc) { $b.hide(); return; }
    $b.removeClass('svc-ratecard--soon svc-ratecard--expired');
    var d = rc.days_left;
    var longDate = rc.valid_until;
    try { longDate = new Date(rc.valid_until + 'T00:00:00').toLocaleDateString('en-ZA', { day: 'numeric', month: 'long', year: 'numeric' }); } catch (e) {}
    var plural = function(n) { return n + ' day' + (Math.abs(n) === 1 ? '' : 's'); };
    var status;
    if (rc.expired) {
        $b.addClass('svc-ratecard--expired');
        status = 'Expired on ' + longDate + ' (' + plural(Math.abs(d)) + ' ago). Quotations no longer print a rate-validity line — update the fees and this date.';
    } else if (d !== null && d <= 45) {
        $b.addClass('svc-ratecard--soon');
        status = 'Valid until ' + longDate + ' — ' + plural(d) + ' left. Plan the rate update.';
    } else {
        status = 'Valid until ' + longDate + (d !== null ? ' (' + plural(d) + ' left).' : '.');
    }
    $('#svcRcTitle').text((rc.title || 'Rate card') + (rc.updated ? ' · updated ' + rc.updated : ''));
    $('#svcRcStatus').text(status);
    $('#svcRcValidUntil').val(rc.valid_until || '');
    $b.show();
}

window.saveRateCardValidity = async function() {
    var v = $('#svcRcValidUntil').val();
    if (!v) { window.notificationService.showError('Choose the date the rates are valid until.'); return; }
    var $btn = $('#svcRcSaveBtn').prop('disabled', true);
    try {
        var r = await apiCall('/api/admin/services/rate-card', 'PUT', { valid_until: v });
        if (r && r.rate_card && _svcMeta) { _svcMeta.rate_card = r.rate_card; _renderRateCardBanner(); }
        window.notificationService.showSuccess('Rate-card validity saved.');
    } catch (e) { /* apiCall already showed the server's message */ }
    $btn.prop('disabled', false);
};

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
    $('#svcPill-All').text(nonDel.length);
    _svcGroups().forEach(function(g){ $('#svcPill-' + g.value).text(nonDel.filter(function(s){ return s.service_group === g.value; }).length); });
    $('#svcPill-none').text(nonDel.filter(function(s){ return !s.service_group; }).length);
}

window.clearSvcFilters = function() {
    $('#svcSearchInput').val('');
    $('#svcModelFilter,#svcStatusFilter,#svcPriceTypeFilter').val('');
    _svcActiveGroup = '';
    $('.svc-cat-pill').removeClass('active');
    $('.svc-cat-pill[data-group=""]').addClass('active');
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
        const loaded = await Promise.all([
            apiCall(endpoint),
            fetch('/api/admin/services/meta', { credentials: 'same-origin', cache: 'no-store' })
                .then(function(r) { return r.ok ? r.json() : null; }).catch(function() { return null; })
        ]);
        const data = loaded[0];
        if (loaded[1]) _svcMeta = loaded[1];   // a failed/older meta response keeps the last good one (the page still works)
        allServicesCache = Array.isArray(data) ? data : [];
        _renderSvcGroupPills();
        _populateSvcSelects();
        _renderRateCardBanner();
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
    const ptype  = $('#svcPriceTypeFilter').val();
    const status = $('#svcStatusFilter').val();
    const filtered = allServicesCache.filter(s => {
        // searchable: name, description, the price as shown (e.g. "50,000" or "enquire") and the group name
        if (q && !(s.name || '').toLowerCase().includes(q) && !(s.description || '').toLowerCase().includes(q)
              && !(s.price_label || '').toLowerCase().includes(q) && !(s.service_group_label || '').toLowerCase().includes(q)) return false;
        if (_svcActiveGroup === SVC_NO_GROUP) { if (s.service_group) return false; }
        else if (_svcActiveGroup && s.service_group !== _svcActiveGroup) return false;
        if (model  && s.pricing_model !== model) return false;
        if (ptype  && (s.price_type || 'fixed') !== ptype) return false;
        if (status === 'active'   && s.is_active === 0) return false;
        if (status === 'inactive' && s.is_active !== 0) return false;
        return true;
    }).sort(function(a, b) {   // rate-card order: group by group, then by name
        return (_svcGroupRank(a) - _svcGroupRank(b)) || String(a.name || '').localeCompare(String(b.name || ''));
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
            // Quantity limits are minutes for per-minute services and whole hours for hourly ones.
            const limitsHtml = s.pricing_model !== 'flat_fee' ? `<p class="svc-card__limits">${s.min_quantity || 1}–${s.max_quantity || '∞'} ${s.pricing_model === 'per_hour' ? 'hr' : 'min'}</p>` : '';
            const safeNote   = (s.external_note || '').replace(/"/g, '&quot;');
            // The price exactly as the rate card publishes it ("R28,000", "R12,000 – R25,000", "From R50,000", "Enquire …"),
            // built by the server (lib/service-pricing.js describePrice) so every screen reads one definition.
            const priceLabel = s.price_label || ('R ' + parseFloat(s.default_price || 0).toLocaleString('en-ZA', { minimumFractionDigits: 2 }));
            const badge = s.service_group_label
                ? `<span class="svc-card__cat-badge svc-cat--group">${_svcEsc(s.service_group_label)}</span>`
                : `<span class="svc-card__cat-badge svc-cat--${(s.category||'Other').toLowerCase()}">${s.category||'Other'}</span>`;
            const safeName = _svcEsc(s.name || '');
            // Same shared card shell as Events/Accolades/Career/etc. (.atl-edit-card): icon thumb (services
            // have no photo) + a main column + a right-aligned icon action column, instead of the old
            // bespoke vertical tile. Classes the browser suite reads (svc-card, svc-card__name,
            // svc-card__price, svc-tag--featured) are unchanged; only the surrounding layout moved.
            return `<article class="atl-edit-card svc-card${s.is_deleted ? ' svc-card--archived' : ''}" data-id="${s.id}">
              <div class="atl-card-inner"><div class="atl-edit-card__header">
                <div class="svc-card__thumb" aria-hidden="true"><i class="fa-solid ${_svcThumbIcon(s)}"></i></div>
                <div class="svc-card__main">
                  <h4 class="atl-edit-card__title svc-card__name">${s.name}</h4>
                  <div class="svc-card__price${priceLabel.length > 22 ? ' svc-card__price--long' : ''}">
                    ${_svcEsc(priceLabel)}
                    <span class="svc-card__model-badge">${modelLabel}</span>
                  </div>
                  <div class="svc-card__badges">
                    ${badge}
                    ${statusBadge}
                    ${s.is_featured ? '<span class="svc-tag svc-tag--featured"><i class="fa-solid fa-star"></i> Most Booked</span>' : ''}
                    ${s.travel_included ? '<span class="svc-tag svc-tag--travel"><i class="fa-solid fa-car-side"></i> Travel incl.</span>' : ''}
                    ${s.availability_rule === 'per_day' ? '<span class="svc-tag svc-tag--perday"><i class="fa-solid fa-calendar-day"></i> Per day</span>' : ''}
                    ${s.external_note ? `<span class="svc-tag svc-tag--note" title="${safeNote}"><i class="fa-solid fa-note-sticky"></i> Note</span>` : ''}
                  </div>
                  ${s.description ? `<p class="atl-edit-card__desc svc-card__desc">${s.description}</p>` : ''}
                  ${s.quote_required ? '<p class="svc-card__quote-note"><i class="fa-solid fa-file-signature"></i> Priced individually &mdash; enter the agreed amount on each quote</p>' : ''}
                  ${limitsHtml}
                  ${s.display_unit ? `<p class="svc-card__unit">${s.display_unit}</p>` : ''}
                </div>
                <div class="svc-card__actions">
                  ${s.is_deleted
                    ? `<button type="button" class="atl-btn atl-btn--ghost um-btn--sm" onclick="restoreService(${s.id})" title="Restore service" aria-label="Restore ${safeName}"><i class="fa-solid fa-rotate-left"></i></button>`
                    : `<button type="button" class="atl-btn atl-btn--ghost um-btn--sm btn-svc-edit" data-id="${s.id}" title="Edit service" aria-label="Edit ${safeName}"><i class="fa-solid fa-pen"></i></button>
                       <button type="button" class="um-btn um-btn--danger um-btn--sm btn-svc-delete" data-id="${s.id}" title="Archive service" aria-label="Archive ${safeName}"><i class="fa-solid fa-archive"></i></button>`
                  }
                </div>
              </div></div>
            </article>`;
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
    $('#svcPriceType').val('fixed'); $('#svcPriceMin,#svcPriceMax').val(''); $('#svcPriceUnit').val('');
    $('#svcGroup').val(''); $('#svcFeatured').prop('checked', false);
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

// Shows only the fields that apply to the chosen price type (rules mirror lib/service-pricing.js, which stays authoritative).
window.togglePricingFields = function() {
    const type  = $('#svcPriceType').val() || 'fixed';
    const fixed = type === 'fixed';
    let model   = $('#svcPricingModel').val();

    // Only a fixed price can be billed per hour / per minute; a range, "from" or enquiry is always one unit whose
    // amount is agreed on the quote.
    if (!fixed && model !== 'flat_fee') { $('#svcPricingModel').val('flat_fee'); model = 'flat_fee'; }
    $('#svcPricingModel').prop('disabled', !fixed);
    $('#svcModelField').toggleClass('svc-field--off', !fixed);

    $('#svcFixedPriceField').toggle(fixed);
    $('#svcPriceMinField').toggle(type === 'range' || type === 'from' || type === 'enquire_min');
    $('#svcPriceMaxField').toggle(type === 'range');
    const minLabel = type === 'range' ? 'From (R)' : type === 'from' ? 'Starting Price (R)' : 'Minimum Fee (R)';
    $('#svcPriceMinLabel').html(minLabel + ' <span class="atl-req">*</span>');

    const priceLabel = model === 'per_hour' ? 'Rate per Hour (R)' : model === 'per_minute' ? 'Rate per Minute (R)' : 'Flat Price (R)';
    $('#svcPriceLabel').html(priceLabel + ' <span class="atl-req">*</span>');

    // An hourly / per-minute model fixes the billing unit; otherwise any unit may be chosen.
    const timeUnit = model === 'per_hour' ? 'hour' : model === 'per_minute' ? 'minute' : '';
    if (timeUnit) {
        $('#svcPriceUnit').val(timeUnit).prop('disabled', true);
    } else if ($('#svcPriceUnit').prop('disabled')) {
        $('#svcPriceUnit').prop('disabled', false).val('');
    }

    // Quantity limits: minutes for a per-minute service, whole hours for an hourly one.
    const timeBased = model !== 'flat_fee';
    $('#svcTimeFields').toggle(timeBased);
    const qtyUnit = model === 'per_hour' ? 'hours' : 'mins';
    $('#svcMinQtyLabel').text('Min Quantity (' + qtyUnit + ')');
    $('#svcMaxQtyLabel').text('Max Quantity (' + qtyUnit + ')');

    const info = ((_svcMeta && _svcMeta.price_types) || []).find(function(t) { return t.value === type; });
    $('#svcPriceTypeHint').text(info ? info.hint : '');
};

// Switching the quantity basis swaps the limits' sensible defaults (they were minutes; hourly limits are hours).
window.onPricingModelChange = function() {
    const model = $('#svcPricingModel').val();
    const minQ = parseInt($('#svcMinQty').val()) || 0;
    if (model === 'per_hour' && minQ >= 15) { $('#svcMinQty').val('1'); $('#svcMaxQty').val('8'); }
    else if (model === 'per_minute' && minQ < 15) { $('#svcMinQty').val('15'); $('#svcMaxQty').val('1440'); }
    window.togglePricingFields();
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
    const sType = s.price_type || 'fixed';
    $('#svcEditId').val(s.id); $('#svcName').val(s.name); $('#svcDesc').val(s.description||'');
    $('#svcPriceType').val(sType);
    // a non-fixed service has no catalogue price of its own: its amounts are the published band / starting price / minimum
    $('#svcPrice').val(sType === 'fixed' ? s.default_price : '');
    $('#svcPriceMin').val(s.price_min != null ? s.price_min : '');
    $('#svcPriceMax').val(s.price_max != null ? s.price_max : '');
    $('#svcPriceUnit').val(s.price_unit || '');
    $('#svcGroup').val(s.service_group || '');
    $('#svcFeatured').prop('checked', !!s.is_featured);
    $('#svcCategory').val(s.category||'Other');
    $('#svcPricingModel').val(s.pricing_model || 'flat_fee');
    $('#svcUnit').val(s.display_unit || '');
    // limits are minutes (per-minute) or hours (hourly); fall back to a sensible default per basis
    $('#svcMinQty').val(s.min_quantity || (s.pricing_model === 'per_hour' ? 1 : 15));
    $('#svcMaxQty').val(s.max_quantity || (s.pricing_model === 'per_hour' ? 8 : 1440));
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

// Mirrors the server's price rules (lib/service-pricing.js normalizeServicePricing) for instant feedback; the server stays authoritative.
function _svcNumOrNull(sel) {
    const raw = $(sel).val();
    if (raw === '' || raw == null) return null;
    const n = parseFloat(raw);
    return isNaN(n) ? NaN : n;
}
function _svcValidatePricing(type, body) {
    const pos = function(n) { return typeof n === 'number' && isFinite(n) && n > 0; };
    if (!body.name) return 'Enter a service name.';
    if (type === 'fixed') {
        if (isNaN(body.default_price)) return 'Enter the price.';
        if (body.default_price < 0) return 'Price cannot be negative.';
    } else if (type === 'range') {
        if (!pos(body.price_min) || !pos(body.price_max)) return 'Enter both amounts of the range (each above zero).';
        if (body.price_min >= body.price_max) return 'The first amount must be less than the second; use a fixed price for a single amount.';
    } else if (type === 'from' || type === 'enquire_min') {
        if (!pos(body.price_min)) return 'Enter the ' + (type === 'from' ? 'starting price' : 'minimum fee') + ' (above zero).';
    }
    return null;
}

window.saveService = async function() {
    const id    = $('#svcEditId').val();
    const type  = $('#svcPriceType').val() || 'fixed';
    const fixed = type === 'fixed';
    // Only a fixed price can be billed per hour / per minute (the server enforces the same).
    const model = fixed ? $('#svcPricingModel').val() : 'flat_fee';
    const minQ  = parseInt($('#svcMinQty').val()) || 1;
    const maxQ  = parseInt($('#svcMaxQty').val()) || 0;   // blank = no upper limit

    // Quantity limits: per-minute services need at least 15 minutes; hourly ones count whole hours from 1.
    if (model === 'per_minute' && minQ < 15) { window.notificationService.showError('Minimum quantity for per-minute services must be at least 15 minutes.'); return; }
    if (model === 'per_hour' && minQ < 1)    { window.notificationService.showError('Minimum quantity for hourly services must be at least 1 hour.'); return; }
    if (model !== 'flat_fee' && maxQ && minQ > maxQ) { window.notificationService.showError('Minimum quantity cannot exceed Maximum quantity.'); return; }
    const validFrom = $('#svcValidFrom').val();
    const validTo   = $('#svcValidTo').val();
    if (validFrom && validTo && validFrom > validTo) {
        window.notificationService.showError('Valid From must be on or before Valid To.');
        return;
    }

    // Advanced / financial fields live in a panel that is not on the page at the moment. A field that is not on the page
    // is simply not sent, and the server keeps the stored value (this used to throw on the missing inputs, so no service
    // could be saved at all).
    const adv = {};
    const optStr = function(sel) { const $e = $(sel); return $e.length ? String($e.val() == null ? '' : $e.val()).trim() : undefined; };
    [['financial_category', '#svcFinancialCategory'], ['marketing_segment', '#svcMarketingSegment'], ['item_category', '#svcItemCategory'],
     ['fulfillment_type', '#svcFulfillmentType'], ['tax_category', '#svcTaxCategory'], ['revenue_gl_code', '#svcRevenueGlCode'],
     ['legacy_code', '#svcLegacyCode']].forEach(function(pair) { const v = optStr(pair[1]); if (v !== undefined) adv[pair[0]] = v || null; });
    if ($('#svcCrewRequired').length) adv.crew_required = parseInt($('#svcCrewRequired').val()) || 1;
    if ($('#svcIsDeleted').length)    adv.is_deleted = $('#svcIsDeleted').is(':checked') ? 1 : 0;

    const needsMin = type === 'range' || type === 'from' || type === 'enquire_min';
    const baseOverride = parseFloat($('#svcBasePrice').val());
    const body = Object.assign({
        name: $('#svcName').val().trim(),
        description: $('#svcDesc').val().trim(),
        // price: a fixed price is the fee; every other type carries no catalogue price (its amounts are the band / starting price / minimum)
        default_price: fixed ? parseFloat($('#svcPrice').val()) : 0,
        price_type: type,
        price_min: needsMin ? _svcNumOrNull('#svcPriceMin') : null,
        price_max: type === 'range' ? _svcNumOrNull('#svcPriceMax') : null,
        price_unit: $('#svcPriceUnit').val() || null,
        service_group: $('#svcGroup').val() || null,
        is_featured: $('#svcFeatured').is(':checked'),
        category: $('#svcCategory').val(),
        pricing_model: model,
        display_unit: $('#svcUnit').val().trim(),
        // flat_fee services always get qty=1/null; server enforces the same
        min_quantity: model === 'flat_fee' ? 1 : minQ,
        max_quantity: model === 'flat_fee' ? null : (maxQ || null),
        is_taxable: $('#svcTaxable').is(':checked'),
        is_active: $('#svcActive').is(':checked'),
        service_type: $('#svcType').val(),
        pricing_group: $('#svcPricingGroup').val(),
        availability_rule: $('#svcAvailabilityRule').val(),
        booking_lead_time_days: parseInt($('#svcLeadTime').val()) || 0,
        setup_time_minutes: parseInt($('#svcSetupTime').val()) || 0,
        performance_length_minutes: parseInt($('#svcPerfLength').val()) || 0,
        tax_class: $('#svcTaxClass').val(),
        travel_included: $('#svcTravelIncluded').is(':checked'),
        // optional booking-rate override (wins over the price when set); only meaningful for a fixed price
        base_price: (fixed && isFinite(baseOverride) && baseOverride > 0) ? baseOverride : null,
        internal_note: $('#svcInternalNote').val().trim() || null,
        external_note: $('#svcExternalNote').val().trim() || null,
        valid_from: $('#svcValidFrom').val() || null,
        valid_to: $('#svcValidTo').val() || null
    }, adv);

    const problem = _svcValidatePricing(type, body);
    if (problem) { window.notificationService.showError(problem); return; }
    try {
        if (id) {
            const originalSvc = allServicesCache.find(x => x.id == id);
            const num = function(v) { return v == null || v === '' ? null : parseFloat(v); };
            const priceChanged = originalSvc && (
                parseFloat(originalSvc.default_price) !== body.default_price || originalSvc.pricing_model !== body.pricing_model ||
                (originalSvc.price_type || 'fixed') !== body.price_type ||
                num(originalSvc.price_min) !== num(body.price_min) || num(originalSvc.price_max) !== num(body.price_max));
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
        // apiCall has already shown the server's own message (e.g. "price_min must be less than price_max")
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
