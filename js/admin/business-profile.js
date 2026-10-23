/* Business > Business Profile - who issues our quotations and invoices, and which SARS registrations apply
   (docs-internal/business-profile-2026.md). The form is built here from one field list so the six sections stay consistent.

   The server is the only judge (lib/business-profile-core.js): this page mirrors a few rules so the administrator sees consequences
   immediately, but every rule is re-checked on save, including the confirmation a registration change needs.

   Roles: administrators edit; managers read (income-tax reference masked); assistants never see the tab (css) and the API refuses them.
   Plain top-level jQuery like the other admin modules; feedback through window.notificationService (no alert()). */
(function () {
    'use strict';

    var ENT_TYPES = ['Private company', 'Public company', 'Non-profit company', 'Personal liability company', 'State-owned company', 'Close corporation', 'Other'];
    var ENT_STATUS = ['In business', 'Business rescue', 'Deregistration in process', 'Deregistered', 'In liquidation'];
    var MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
    var VAT_RE = /^4\d{9}$/;

    var state = { loaded: null, baselines: {}, canEdit: false, computed: null, directors: [], built: false, busy: false, clearId: false, dirty: false };

    function esc(s) {
        if (window.escHtml) return window.escHtml(s == null ? '' : s);
        return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }
    function toast(kind, title, msg) { if (window.notificationService && window.notificationService[kind]) window.notificationService[kind](title, msg); }
    function call(method, url, body) {
        var opts = { method: method, credentials: 'same-origin', headers: {}, bypassInterceptor: true, cache: 'no-store' };
        if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
        return fetch(url, opts).then(function (res) {
            return res.json().catch(function () { return {}; }).then(function (json) { return { status: res.status, ok: res.ok, json: json || {} }; });
        });
    }

    // ── form building ──────────────────────────────────────────────────────────────────────────────────────────
    function group(key, label, control, hint) {
        return '<div class="um-field-group bp-field" data-field="' + key + '"><label class="um-label" for="bp_' + key + '">' + label + '</label>' + control +
            (hint ? '<div class="um-section-desc bp-hint">' + hint + '</div>' : '') + '<div class="atl-field-error" id="bpErr_' + key + '" style="display:none;" role="alert"></div></div>';
    }
    function input(key, label, o) {
        o = o || {};
        var type = o.type || 'text';
        var attrs = ' id="bp_' + key + '" type="' + type + '" class="um-input" autocomplete="off"' + (o.placeholder ? ' placeholder="' + esc(o.placeholder) + '"' : '') +
            (o.inputmode ? ' inputmode="' + o.inputmode + '"' : '') + (o.maxlength ? ' maxlength="' + o.maxlength + '"' : '') + (type === 'text' ? ' spellcheck="false"' : '');
        return group(key, label, '<div class="um-input-wrap"><i class="fa-solid ' + (o.icon || 'fa-pen') + ' um-input-icon"></i><input' + attrs + '></div>', o.hint);
    }
    function textarea(key, label, hint) {
        return group(key, label, '<div class="um-input-wrap"><textarea id="bp_' + key + '" class="um-input bp-textarea" rows="3" maxlength="300"></textarea></div>', hint);
    }
    function select(key, label, options, hint, icon) {
        return group(key, label, '<div class="um-input-wrap"><i class="fa-solid ' + (icon || 'fa-list') + ' um-input-icon"></i><select id="bp_' + key + '" class="um-input">' +
            options.map(function (o) { var v = Array.isArray(o) ? o[0] : o, l = Array.isArray(o) ? o[1] : o; return '<option value="' + esc(v) + '">' + esc(l) + '</option>'; }).join('') + '</select></div>', hint);
    }
    function check(key, title, text, extra) {
        return '<div class="bp-check" data-field="' + key + '"><label class="bp-check__row" for="bp_' + key + '"><input type="checkbox" id="bp_' + key + '" class="bp-check__box">' +
            '<span class="bp-check__title">' + title + '</span></label><div class="um-section-desc bp-check__text">' + text + '</div>' + (extra || '') +
            '<div class="atl-field-error" id="bpErr_' + key + '" style="display:none;" role="alert"></div></div>';
    }
    // Every editable card saves on its own: it owns the fields below, sends only those to the server (a partial PUT - the server merges it with
    // what is stored and validates the whole), and has its own Save / Discard / "unsaved" indicator. Banking and the preview have nothing to save.
    var SECTIONS = {
        profile: { title: 'Business details', save: 'Save business details', keys: ['business_type', 'legal_name', 'trading_name'] },
        cipc: { title: 'CIPC and directors', save: 'Save CIPC and directors', keys: ['registration_number', 'enterprise_number', 'cipc_tracking_number', 'registration_date', 'enterprise_type', 'enterprise_status', 'financial_year_end', 'directors'] },
        tax: { title: 'Tax and VAT', save: 'Save tax and VAT', keys: ['is_tax_registered', 'sars_registered_name', 'sars_taxpayer_number', 'income_tax_reference', 'tax_registration_date', 'provisional_tax_period', 'is_vat_registered', 'vat_number', 'vat_registration_date', 'vat_number_verified'] },
        addr: { title: 'Addresses and contact details', save: 'Save addresses and contacts', keys: ['registered_address', 'postal_address', 'physical_address', 'correspondence_address', 'contact_email', 'contact_phone', 'website', 'admin_email'] },
        bbbee: { title: 'B-BBEE details', save: 'Save B-BBEE details', keys: ['bbbee_certificate_number', 'bbbee_level', 'bbbee_issue_date', 'bbbee_expiry_date'] }
    };
    var SECTION_ORDER = ['profile', 'cipc', 'tax', 'addr', 'bbbee'];
    function bar(id) {
        return '<div class="bp-cardbar" id="bpBar_' + id + '"><span class="um-section-desc bp-cardbar__msg" id="bpDirty_' + id + '" style="margin:0;"></span>' +
            '<span class="bp-cardbar__btns"><button type="button" class="atl-btn atl-btn--ghost bp-discard" id="bpDiscard_' + id + '" data-section="' + id + '" disabled>Discard changes</button>' +
            '<button type="button" class="atl-btn atl-btn--primary bp-save" id="bpSave_' + id + '" data-section="' + id + '" disabled><i class="fa-solid fa-floppy-disk" style="margin-right:6px;"></i>' + SECTIONS[id].save + '</button></span></div>';
    }
    function card(id, icon, title, desc, body, section) {
        return '<div class="atl-card um-settings-card bp-card" id="' + id + '"><div class="um-icon-header"><div class="um-icon-header__icon"><i class="fa-solid ' + icon + '"></i></div><div>' +
            '<h4 class="um-section-label" style="margin-bottom:4px;">' + title + '</h4><p class="um-section-desc">' + desc + '</p></div></div><div class="um-divider"></div>' + body + (section ? bar(section) : '') + '</div>';
    }
    function row(cols) { return '<div class="row">' + cols.map(function (c) { return '<div class="col-md-' + (c[1] || 6) + '">' + c[0] + '</div>'; }).join('') + '</div>'; }

    function build() {
        // The tab bar and its panels are static HTML in admin.html (initTabs binds tab buttons once, at page load); the cards are built here
        // into each panel's mount.
        if (!$('.bp-mount').length || state.built) return;
        var m = { company: '', tax: '', addr: '', bbbee: '', letterhead: '' };

        m.company += card('bpCardProfile', 'fa-building', 'Business Profile',
            'Who issues your quotations and invoices. The name here is the legal name printed on every document.',
            select('business_type', 'Business type', [['company', 'Registered company or other legal entity'], ['individual', 'Individual or sole proprietor']], '', 'fa-id-card-clip') +
            '<div class="um-section-desc bp-hint" id="bpTypeNote"></div>' +
            row([[input('legal_name', '<span id="bpLegalNameLabel">Registered company name</span>', { icon: 'fa-signature', maxlength: 120, placeholder: 'MTV CREATIVES (PTY) LTD' }), 7],
                 [input('trading_name', 'Trading name <small>(optional)</small>', { icon: 'fa-store', maxlength: 120, hint: 'Printed as "t/a ..." next to the legal name.' }), 5]]), 'profile');

        m.company += '<div id="bpCompanyOnly">' + card('bpCardCipc', 'fa-landmark', 'CIPC and Directors',
            'The company\'s registration with the Companies and Intellectual Property Commission. Kept apart from every SARS number below - they are different registrations.',
            row([[input('registration_number', 'Registration number', { icon: 'fa-hashtag', placeholder: '2025/575967/07', maxlength: 30, hint: 'Format YYYY/NNNNNN/NN. Printed on every document (Companies Act s32).' }), 4],
                 [input('enterprise_number', 'Enterprise number', { icon: 'fa-hashtag', placeholder: 'K2025575967', maxlength: 20 }), 4],
                 [input('cipc_tracking_number', 'Tracking / certificate number', { icon: 'fa-hashtag', inputmode: 'numeric', maxlength: 20 }), 4]]) +
            row([[input('registration_date', 'Registration date', { type: 'date', icon: 'fa-calendar-day' }), 4],
                 [select('enterprise_type', 'Enterprise type', ENT_TYPES), 4],
                 [select('enterprise_status', 'Status', ENT_STATUS), 4]]) +
            row([[select('financial_year_end', 'Financial year-end', MONTHS, '', 'fa-calendar'), 4]]) +
            '<h5 class="um-section-label bp-sub">Directors</h5><div id="bpDirectors"></div>' +
            '<button type="button" class="atl-btn atl-btn--ghost" id="bpAddDirector"><i class="fa-solid fa-plus" style="margin-right:6px;"></i>Add director</button>' +
            '<div class="atl-field-error" id="bpErr_directors" style="display:none;" role="alert"></div>' +
            '<div class="um-field-group bp-dirid" style="margin-top:16px;"><label class="um-label" for="bp_director_id_number">Director ID number <small>(optional - hidden, stored encrypted, never printed on documents)</small></label>' +
            '<div class="bp-dirid__row"><div class="um-input-wrap"><i class="fa-solid fa-lock um-input-icon"></i><input type="password" id="bp_director_id_number" class="um-input" autocomplete="off" inputmode="numeric" maxlength="13"></div>' +
            '<button type="button" class="atl-btn atl-btn--ghost" id="bpRevealId" style="display:none;">Reveal</button><button type="button" class="atl-btn atl-btn--ghost" id="bpClearId" style="display:none;">Remove</button></div>' +
            '<div class="um-section-desc bp-hint" id="bpIdNote"></div><div class="atl-field-error" id="bpErr_director_id_number" style="display:none;" role="alert"></div></div>', 'cipc') + '</div>';

        m.tax += card('bpCardTax', 'fa-file-invoice-dollar', 'Tax and VAT',
            'Two separate registrations. Income-tax registration with SARS does <strong>not</strong> make you a VAT vendor - VAT is only ever charged once you tick the second box <em>and</em> confirm your VAT number.',
            check('is_tax_registered', 'Is this company or individual registered for tax with SARS?',
                'This is your <strong>income-tax</strong> registration (the SARS notice of registration with your taxpayer reference number). It does not mean you charge VAT.') +
            '<div class="bp-reveal" id="bpTaxFields">' +
            row([[input('sars_registered_name', 'Name registered with SARS', { icon: 'fa-signature', maxlength: 120 }), 6],
                 [input('sars_taxpayer_number', 'Taxpayer registration number', { icon: 'fa-hashtag', maxlength: 30, hint: 'For a company this is usually its CIPC number.' }), 6]]) +
            row([[input('income_tax_reference', 'Income-tax reference number', { icon: 'fa-hashtag', inputmode: 'numeric', maxlength: 20, placeholder: '10 digits', hint: 'Not printed on documents.' }), 4],
                 [input('tax_registration_date', 'Tax registration date', { type: 'date', icon: 'fa-calendar-day' }), 4],
                 [input('provisional_tax_period', 'Provisional tax liability from', { icon: 'fa-calendar', inputmode: 'numeric', maxlength: 6, placeholder: 'YYYYMM', hint: 'For example 202508.' }), 4]]) +
            '</div>' +
            check('is_vat_registered', 'Is this company or individual registered for VAT?',
                'Tick this only if SARS has registered you as a VAT vendor and issued a VAT number. Until then no VAT is added to quotations, and invoices read INVOICE, not TAX INVOICE.') +
            '<div class="bp-reveal" id="bpVatFields">' +
            row([[input('vat_number', 'VAT registration number', { icon: 'fa-hashtag', inputmode: 'numeric', maxlength: 20, placeholder: '10 digits starting with 4' }), 6],
                 [input('vat_registration_date', 'VAT registration date', { type: 'date', icon: 'fa-calendar-day' }), 6]]) +
            check('vat_number_verified', 'I have confirmed this VAT number with SARS',
                'Format is checked here; only <em>you</em> can confirm the number is the one SARS issued to this business (SARS eFiling, or your VAT registration letter). VAT stays off until you do.') +
            '<div class="um-section-desc bp-hint" id="bpVatRate"></div></div>' +
            '<div class="bp-effect" id="bpEffect" role="status" aria-live="polite"></div>', 'tax');

        m.company += card('bpCardBank', 'fa-building-columns', 'Banking and Payments',
            'Banking details live in one place only: the versioned bank details used for manual EFT. Invoices keep the version they were issued with. This is a read-only summary.',
            '<div id="bpBank"></div><button type="button" class="atl-btn atl-btn--ghost" id="bpGoBank"><i class="fa-solid fa-arrow-right" style="margin-right:6px;"></i>Open Payment Setup</button>');

        m.addr += card('bpCardAddr', 'fa-location-dot', 'Addresses and Contact Details',
            'The registered address is printed on documents. Leave the others blank to use it. The contact details below are what <em>customers</em> see - they never replace your booking or support email.',
            row([[textarea('registered_address', 'Registered address', 'Printed on quotations and invoices.'), 6], [textarea('postal_address', 'Postal address'), 6]]) +
            row([[textarea('physical_address', 'Physical address <small>(optional)</small>'), 6], [textarea('correspondence_address', 'Correspondence address <small>(optional)</small>'), 6]]) +
            row([[input('contact_email', 'Customer-facing email', { type: 'email', icon: 'fa-envelope', maxlength: 120, placeholder: 'bookings@thabisomhlongo.com' }), 4],
                 [input('contact_phone', 'Customer-facing phone', { type: 'tel', icon: 'fa-phone', maxlength: 30, placeholder: '+27 ...' }), 4],
                 [input('website', 'Website', { type: 'text', icon: 'fa-globe', maxlength: 120, placeholder: 'www.thabisomhlongo.com' }), 4]]) +
            row([[input('admin_email', 'CIPC / SARS email <small>(internal)</small>', { type: 'email', icon: 'fa-envelope-circle-check', maxlength: 120, hint: 'Where CIPC and SARS write to you. Never printed.' }), 6]]), 'addr');

        m.bbbee += card('bpCardBbbee', 'fa-award', 'B-BBEE and Compliance',
            'Certificate details for procurement. You get a warning here 60 days before the certificate expires.',
            '<div class="bp-bbbee-chip" id="bpBbbeeChip"></div>' +
            row([[input('bbbee_certificate_number', 'Certificate number', { icon: 'fa-hashtag', maxlength: 40 }), 4],
                 [input('bbbee_issue_date', 'Date of issue', { type: 'date', icon: 'fa-calendar-day' }), 4],
                 [input('bbbee_expiry_date', 'Expiry date', { type: 'date', icon: 'fa-calendar-xmark' }), 4]]) +
            row([[input('bbbee_level', 'Level / status', { icon: 'fa-medal', maxlength: 120 }), 12]]), 'bbbee');

        m.letterhead += card('bpCardPreview', 'fa-file-pdf', 'Letterhead preview',
            'See the real quotation or invoice letterhead with the values currently in this form (nothing is saved or sent). It uses made-up sample items.',
            '<div class="bp-preview-btns"><button type="button" class="atl-btn atl-btn--ghost" id="bpPreviewQuote"><i class="fa-solid fa-file-lines" style="margin-right:6px;"></i>Preview quotation</button>' +
            '<button type="button" class="atl-btn atl-btn--ghost" id="bpPreviewInvoice"><i class="fa-solid fa-file-invoice" style="margin-right:6px;"></i>Preview invoice</button></div>');

        Object.keys(m).forEach(function (k) { $('.bp-mount[data-mount="' + k + '"]').html(m[k]); });
        state.built = true;
    }

    // ── values <-> form ────────────────────────────────────────────────────────────────────────────────────────
    var TEXT_KEYS = ['business_type', 'legal_name', 'trading_name', 'registration_number', 'enterprise_number', 'cipc_tracking_number', 'registration_date', 'enterprise_type', 'enterprise_status', 'financial_year_end',
        'sars_registered_name', 'sars_taxpayer_number', 'income_tax_reference', 'tax_registration_date', 'provisional_tax_period', 'vat_number', 'vat_registration_date',
        'registered_address', 'postal_address', 'physical_address', 'correspondence_address', 'contact_email', 'contact_phone', 'website', 'admin_email',
        'bbbee_certificate_number', 'bbbee_level', 'bbbee_issue_date', 'bbbee_expiry_date'];
    var BOOL_KEYS = ['is_tax_registered', 'is_vat_registered', 'vat_number_verified'];

    function ensureOption($sel, value) {
        if (value && !$sel.find('option').filter(function () { return this.value === value; }).length) $sel.append($('<option>').val(value).text(value));
    }
    var ALL_KEYS = TEXT_KEYS.concat(BOOL_KEYS, ['directors']);
    // put the stored values for just these fields into the form (a card's Discard, or the card that was just saved)
    function fillKeys(p, keys) {
        keys.forEach(function (k) {
            if (k === 'directors') return;
            if (BOOL_KEYS.indexOf(k) >= 0) { $('#bp_' + k).prop('checked', !!p[k]); return; }
            var $e = $('#bp_' + k); if (!$e.length) return;
            if ($e.is('select')) ensureOption($e, p[k]);
            $e.val(p[k] == null ? '' : p[k]);
        });
        if (keys.indexOf('directors') >= 0) {
            state.directors = (p.directors || []).map(function (d) { return { name: d.name || '', role: d.role || 'Director', status: d.status || 'active', appointed: d.appointed || '' }; });
            renderDirectors();
            $('#bp_director_id_number').val('');
            state.clearId = false;
            $('#bpRevealId, #bpClearId').toggle(!!p.director_id_set && state.canEdit);
            $('#bpIdNote').text(p.director_id_set ? 'An ID number is on file (hidden). Type a new one to replace it, or use Reveal / Remove.' : 'No ID number on file.');
        }
    }
    function fill(p) { fillKeys(p, ALL_KEYS); }
    // Fields that only matter while a registration box is ticked. While the box is unticked its fields are hidden, so whatever is left in them
    // (a half-typed VAT number) cannot be seen or corrected: it must not be sent, previewed or compared. The stored value stands.
    var TAX_ONLY = ['sars_registered_name', 'sars_taxpayer_number', 'income_tax_reference', 'tax_registration_date', 'provisional_tax_period'];
    var VAT_ONLY = ['vat_number', 'vat_registration_date', 'vat_number_verified'];
    function collect(keys) {
        var out = {};
        var taxOn = $('#bp_is_tax_registered').is(':checked'), vatOn = taxOn && $('#bp_is_vat_registered').is(':checked');
        (keys || ALL_KEYS).forEach(function (k) {
            if (state.loaded && ((!taxOn && TAX_ONLY.indexOf(k) >= 0) || (!vatOn && VAT_ONLY.indexOf(k) >= 0))) {
                out[k] = BOOL_KEYS.indexOf(k) >= 0 ? !!state.loaded[k] : (state.loaded[k] == null ? '' : state.loaded[k]);
                return;
            }
            if (k === 'directors') out.directors = state.directors.map(function (d) { return { name: d.name, role: d.role, status: d.status, appointed: d.appointed }; });
            else if (BOOL_KEYS.indexOf(k) >= 0) out[k] = $('#bp_' + k).is(':checked');
            else { var $e = $('#bp_' + k); if ($e.length) out[k] = $e.val(); }
        });
        return out;
    }
    // what a card currently holds, as one comparable string (the director ID box and its "remove" flag belong to the CIPC card)
    function snapshotSection(id) {
        return JSON.stringify(collect(SECTIONS[id].keys)) + (id === 'cipc' ? '|' + ($('#bp_director_id_number').val() ? 'id' : '') + (state.clearId ? 'clr' : '') : '');
    }

    function renderDirectors() {
        var h = state.directors.map(function (d, i) {
            return '<div class="bp-director" data-i="' + i + '"><div class="um-input-wrap"><i class="fa-solid fa-user-tie um-input-icon"></i><input type="text" class="um-input bp-dir-name" aria-label="Director ' + (i + 1) + ' name" placeholder="Full name" maxlength="120" value="' + esc(d.name) + '"></div>' +
                '<select class="um-input bp-dir-status" aria-label="Director ' + (i + 1) + ' status"><option value="active"' + (d.status === 'active' ? ' selected' : '') + '>Active</option><option value="resigned"' + (d.status === 'resigned' ? ' selected' : '') + '>Resigned</option></select>' +
                '<input type="date" class="um-input bp-dir-date" aria-label="Director ' + (i + 1) + ' appointment date" value="' + esc(d.appointed) + '">' +
                '<button type="button" class="atl-btn atl-btn--ghost bp-dir-remove" aria-label="Remove director ' + (i + 1) + '"><i class="fa-solid fa-trash"></i></button></div>';
        }).join('');
        $('#bpDirectors').html(h || '<p class="um-section-desc">No directors listed.</p>');
        applyEditable();
    }

    // ── conditional display + live "what changes" panel ───────────────────────────────────────────────────────────
    function vatWouldBeActive() {
        return $('#bp_is_tax_registered').is(':checked') && $('#bp_is_vat_registered').is(':checked') && $('#bp_vat_number_verified').is(':checked') && VAT_RE.test(String($('#bp_vat_number').val() || '').replace(/[\s-]/g, ''));
    }
    function refresh() {
        var company = $('#bp_business_type').val() !== 'individual';
        $('#bpCompanyOnly').toggle(company);
        $('#bpLegalNameLabel').text(company ? 'Registered company name' : 'Full legal name or trading name');
        $('#bp_legal_name').attr('placeholder', company ? 'MTV CREATIVES (PTY) LTD' : 'Name as it should appear on documents');
        $('#bpTypeNote').text(company ? 'A company\'s registration number is printed on every quotation and invoice.' : 'A sole proprietor does not need a CIPC number. Existing company details are kept (not deleted) if you switch back.');
        var tax = $('#bp_is_tax_registered').is(':checked');
        $('#bpTaxFields').toggle(tax);
        // VAT sits on top of SARS registration: it cannot be ticked while tax registration is off
        var $vat = $('#bp_is_vat_registered');
        if (!tax) $vat.prop('checked', false);
        $vat.prop('disabled', !tax || !state.canEdit);
        var vat = $vat.is(':checked');
        $('#bpVatFields').toggle(vat);
        var vr = state.computed && state.computed.vat_rate;
        $('#bpVatRate').text(vr ? 'VAT rate in force: ' + (vr.rate * 100).toFixed(0) + '%' + (vr.effective_from ? ' (effective ' + vr.effective_from + ')' : '') + '. Changed in the tax-rate table, not here.' : '');
        var active = vatWouldBeActive();
        var legal = $('#bp_legal_name').val() || 'your business';
        var msg;
        if (active) msg = '<strong>VAT is ON.</strong> Quotations can include VAT; an invoice that charges VAT is titled <strong>TAX INVOICE</strong> and shows ' + esc(legal) + '\'s VAT number.';
        else if (vat) msg = '<strong>VAT is still OFF.</strong> ' + (!VAT_RE.test(String($('#bp_vat_number').val() || '').replace(/[\s-]/g, '')) ? 'Enter a valid VAT number (10 digits, starting with 4)' : 'Tick "I have confirmed this VAT number with SARS"') + ' to switch it on. Until then documents are issued as an unregistered business would: no VAT, titled INVOICE.';
        else msg = '<strong>VAT is OFF.</strong> The Quote Builder cannot add VAT, invoices are titled <strong>INVOICE</strong> and no VAT number is shown. ' + (tax ? 'Your income-tax registration does not change this.' : '');
        $('#bpEffect').html('<div class="bp-effect__title"><i class="fa-solid fa-circle-info"></i> What this means for new documents</div><div>' + msg + '</div><div class="bp-effect__fine">Quotations and invoices already issued are never changed, whatever you save here.</div>')
            .toggleClass('bp-effect--on', active);
        updateDirty();
    }
    // each card tracks its own unsaved state: its Save / Discard buttons wake up only when something in THAT card differs from what was last saved
    // which tab each card sits on (admin.html), so a tab with unsaved work says so
    var TAB_OF = { profile: 'bpPanelCompany', cipc: 'bpPanelCompany', tax: 'bpPanelTax', addr: 'bpPanelAddr', bbbee: 'bpPanelBbbee' };
    function updateDirty() {
        var any = false, dirtyTabs = {};
        SECTION_ORDER.forEach(function (id) {
            var dirty = !!state.canEdit && state.baselines[id] !== undefined && snapshotSection(id) !== state.baselines[id];
            $('#bpSave_' + id + ', #bpDiscard_' + id).prop('disabled', !dirty || state.busy);
            $('#bpDirty_' + id).html(dirty ? '<i class="fa-solid fa-circle" style="color:var(--atl-amber);font-size:8px;margin-right:6px;"></i>Unsaved changes in this section.'
                : (state.canEdit && state.baselines[id] !== undefined ? '<i class="fa-solid fa-check" style="color:var(--atl-sage);margin-right:6px;"></i>Saved.' : ''));
            if (dirty) { any = true; dirtyTabs[TAB_OF[id]] = true; }
        });
        Object.keys(TAB_OF).forEach(function (id) { var t = TAB_OF[id]; $('[data-um-tab="' + t + '"]').toggleClass('bp-tab-dirty', !!dirtyTabs[t]); });
        state.dirty = any;
    }
    function applyEditable() {
        var ro = !state.canEdit;
        $('#bpRoot').find('input, select, textarea, button.bp-dir-remove, #bpAddDirector').prop('disabled', ro);
        $('#bpRoot .bp-cardbar').toggle(!ro);
        if (!ro) $('#bp_is_vat_registered').prop('disabled', !$('#bp_is_tax_registered').is(':checked'));
    }

    function renderStatus(d) {
        var p = d.profile || {};
        var h = '';
        if (!state.canEdit) h += '<div class="bp-note bp-note--info"><i class="fa-solid fa-eye"></i> View only - only an administrator can change the business profile.</div>';
        (d.computed.warnings || []).forEach(function (w) { h += '<div class="bp-note bp-note--warn"><i class="fa-solid fa-triangle-exclamation"></i> ' + esc(w) + '</div>'; });
        if (p.updated_at) h += '<div class="um-section-desc bp-updated">Last saved ' + esc(String(p.updated_at).slice(0, 16)) + ' (version ' + esc(p.version) + ').' + (p.vat_verified_at ? ' VAT number confirmed ' + esc(String(p.vat_verified_at).slice(0, 10)) + '.' : '') + '</div>';
        $('#bpStatus').html(h);
        var b = d.computed.bbbee || {};
        var chip = { valid: ['bp-chip--ok', 'Valid - ' + b.days + ' days left'], expiring: ['bp-chip--warn', 'Expires in ' + b.days + ' day' + (b.days === 1 ? '' : 's')], expired: ['bp-chip--bad', 'Expired'], none: ['bp-chip--muted', 'No expiry date set'] }[b.state || 'none'];
        $('#bpBbbeeChip').html('<span class="bp-chip ' + chip[0] + '">' + esc(chip[1]) + '</span>');
        var bk = d.computed.banking || {};
        var bh;
        if (!bk.configured) bh = '<div class="bp-note bp-note--warn"><i class="fa-solid fa-triangle-exclamation"></i> No bank details are set up yet.</div>';
        else bh = '<dl class="eft-kv"><dt>Account holder</dt><dd>' + esc(bk.account_holder) + '</dd><dt>Bank</dt><dd>' + esc(bk.bank_name) + ' - ' + esc(bk.account_type) + '</dd><dt>Account number</dt><dd>' + esc(bk.account_number_masked) + '</dd><dt>Branch code</dt><dd>' + esc(bk.branch_code) + '</dd>' +
            (bk.swift_code ? '<dt>SWIFT / BIC</dt><dd>' + esc(bk.swift_code) + '</dd>' : '') + '<dt>Manual EFT</dt><dd>' + (bk.eft_enabled ? 'On - printed on new invoices' : 'Off - not printed on invoices') + '</dd></dl>' +
            (bk.holder_matches_legal_name ? '' : '<div class="bp-note bp-note--warn"><i class="fa-solid fa-triangle-exclamation"></i> The account holder does not match the legal name above. Check it before clients pay.</div>');
        $('#bpBank').html(bh);
    }

    // ── load / save ────────────────────────────────────────────────────────────────────────────────────────────
    function clearErrors() { $('#bpRoot .atl-field-error').hide().text(''); $('#bpRoot .um-input').removeClass('is-invalid'); }
    function showErrors(errors) {
        var first = null;
        Object.keys(errors || {}).forEach(function (k) {
            var $err = $('#bpErr_' + k); if (!$err.length) return;
            $err.text(errors[k]).show(); $('#bp_' + k).addClass('is-invalid');
            if (!first) first = $('#bp_' + k).length ? $('#bp_' + k) : $err;
        });
        if (first && first.length) {
            var panel = first.closest('.um-panel');
            if (panel.length && !panel.hasClass('active')) { var tabBtn = document.querySelector('[data-um-tab="' + panel.attr('id') + '"]'); if (tabBtn) tabBtn.click(); }
            if (first[0] && first[0].scrollIntoView) first[0].scrollIntoView({ block: 'center', behavior: 'smooth' });
        }
    }
    function apply(d) {
        state.loaded = d.profile; state.computed = d.computed; state.canEdit = !!d.can_edit;
        fill(d.profile);
        renderStatus(d);
        applyEditable();
        refresh();
        SECTION_ORDER.forEach(function (id) { state.baselines[id] = snapshotSection(id); });
        updateDirty();
    }
    // One card was saved: show what the server now holds for THAT card only. Unsaved edits in the other cards stay exactly as typed
    // (their own baselines are untouched); the new version number is kept so their next save is not refused as stale.
    function applySection(id, d) {
        state.loaded = d.profile; state.computed = d.computed;
        fillKeys(d.profile, SECTIONS[id].keys);
        renderStatus(d);
        refresh();
        state.baselines[id] = snapshotSection(id);
        updateDirty();
    }
    // The only reason this page can be newer than the server it talks to is a server that was started before the feature existed
    // (a dev server nobody restarted, or the minute of a deploy): the API answers 404. Say so, instead of a generic "try again".
    var OLD_SERVER = 'The server is still running an older version of the site, without the Business Profile. Stop it and start it again (in the terminal running "npm start": Ctrl+C, then "npm start"), then press "Try again".';
    // A form that could not be loaded must not be left on screen: it would be empty, editable and unsaveable. Show why, with a retry.
    function loadFailed(message) {
        $('#bpLoading').hide();
        state.loaded = null; state.built = false; state.baselines = {};
        $('.bp-mount').empty(); $('#bpTabs').hide(); $('#bpStatus').empty();
        $('#bpFail').html('<div class="bp-note bp-note--warn"><i class="fa-solid fa-triangle-exclamation"></i><div><strong>The business profile could not be loaded.</strong><br>' + esc(message) + '</div></div>' +
            '<button type="button" class="atl-btn atl-btn--primary bp-retry" id="bpRetry" style="margin-top:12px;"><i class="fa-solid fa-rotate" style="margin-right:6px;"></i>Try again</button>');
    }
    function load(force) {
        $('#bpFail').empty(); $('#bpTabs').show();
        build();
        if (state.loaded && !force) return Promise.resolve();
        $('#bpLoading').show();
        return call('GET', '/api/admin/business-profile').then(function (r) {
            $('#bpLoading').hide();
            if (r.status === 403) { state.built = false; $('.bp-mount').empty(); $('#bpTabs').hide(); $('#bpFail').html('<div class="bp-note bp-note--info"><i class="fa-solid fa-lock"></i> You do not have access to the business profile.</div>'); return; }
            if (r.status === 404) { loadFailed(OLD_SERVER); return; }
            if (!r.ok || !r.json.success || !r.json.profile) { loadFailed(r.json.message || 'Please try again in a moment.'); return; }
            apply(r.json);
        }).catch(function () { loadFailed('The server could not be reached.'); });
    }

    // The registration facts a card is about to change (only the ones that card owns), for the confirmation dialog.
    function registrationChanges(keys) {
        var p = state.loaded || {}, c = collect(keys), out = [];
        var has = function (k) { return keys.indexOf(k) >= 0; };
        var yn = function (v) { return v ? 'yes' : 'no'; };
        if (has('business_type') && c.business_type !== p.business_type) out.push('Business type: ' + (p.business_type === 'individual' ? 'individual' : 'company') + ' → ' + (c.business_type === 'individual' ? 'individual' : 'company'));
        if (has('is_tax_registered') && !!c.is_tax_registered !== !!p.is_tax_registered) out.push('Registered for tax with SARS: ' + yn(p.is_tax_registered) + ' → ' + yn(c.is_tax_registered));
        if (has('is_vat_registered') && !!c.is_vat_registered !== !!p.is_vat_registered) out.push('Registered for VAT: ' + yn(p.is_vat_registered) + ' → ' + yn(c.is_vat_registered));
        if (has('vat_number') && String(c.vat_number || '').replace(/[\s-]/g, '') !== String(p.vat_number || '')) out.push('VAT number changed');
        if (has('vat_number_verified') && !!c.vat_number_verified !== !!p.vat_number_verified) out.push('VAT number confirmed with SARS: ' + yn(p.vat_number_verified) + ' → ' + yn(c.vat_number_verified));
        return out;
    }

    // Save ONE card. Only that card's fields are sent (the server merges them with the stored profile and validates the whole thing), so an
    // unsaved edit in another card is neither sent nor lost.
    async function saveSection(id) {
        var sec = SECTIONS[id];
        if (!sec || state.busy || !state.canEdit) return;
        clearErrors();
        var changes = registrationChanges(sec.keys);
        var payload = collect(sec.keys);
        payload.version = state.loaded.version;
        if (id === 'cipc') {
            var idv = $('#bp_director_id_number').val();
            if (idv) payload.director_id_number = idv;
            else if (state.clearId) payload.clear_director_id = true;
        }
        if (changes.length) {
            var ok = await window.notificationService.showConfirm({
                title: 'Change registration settings?',
                // plain text only: the dialog escapes its message on purpose (js/notificationService.js), so markup would show as literal tags
                message: 'This changes what new quotations and invoices say and charge. ' + changes.join('; ') + '. Documents already issued are not changed.',
                confirmText: 'Save change', cancelText: 'Cancel'
            });
            if (!ok) return;
            payload.confirm_registration_change = true;
        }
        state.busy = true; updateDirty();
        var $btn = $('#bpSave_' + id), orig = $btn.html();
        $btn.html('<i class="fa fa-spinner fa-spin" style="margin-right:6px;"></i>Saving...');
        try {
            var r = await call('PUT', '/api/admin/business-profile', payload);
            if (r.status === 409 && r.json.code === 'CONFIRM_REQUIRED') { toast('showError', 'Confirmation needed', r.json.message); }
            else if (r.status === 409) { toast('showError', 'Not saved', r.json.message); }
            else if (!r.ok || !r.json.success) { showErrors(r.json.errors); toast('showError', sec.title + ' not saved', r.json.message || 'Please check the form.'); }
            else {
                applySection(id, r.json);
                toast('showSuccess', sec.title + ' saved', 'New quotations and invoices use these details.');
                // the standing B-BBEE expiry warning is already shown at the top of the page: do not repeat it after every save
                (r.json.warnings || []).filter(function (w) { return !/B-BBEE/.test(w); }).forEach(function (w) { toast('showWarning', 'Note', w); });
            }
        } catch (e) { toast('showError', sec.title + ' not saved', 'The server could not be reached. Please try again.'); }
        finally { state.busy = false; $btn.html(orig); updateDirty(); }
    }

    async function preview(kind) {
        var w = window.open('', '_blank');   // opened first, inside the click, so pop-up blockers allow it
        try {
            var res = await fetch('/api/admin/business-profile/preview', { method: 'POST', credentials: 'same-origin', bypassInterceptor: true, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ document: kind, profile: collect() }) });
            if (!res.ok) {
                var j = await res.json().catch(function () { return {}; });
                if (w) w.close();
                toast('showError', 'Preview not available', res.status === 404 ? OLD_SERVER : (j.message || 'Please check the form.'));
                showErrors(j.errors); return;
            }
            var url = URL.createObjectURL(await res.blob());
            if (w) w.location.href = url; else window.open(url, '_blank');
            setTimeout(function () { URL.revokeObjectURL(url); }, 60000);
        } catch (e) { if (w) w.close(); toast('showError', 'Preview not available', 'Please try again.'); }
    }

    // ── events ─────────────────────────────────────────────────────────────────────────────────────────────────
    $(document).on('shown.bs.tab', 'a[href="#businessAdmin"]', function () { load(false); });
    $(document).on('click', '#bpRetry', function () { load(true); });
    $(document).on('input change', '#bpRoot input, #bpRoot select, #bpRoot textarea', function (e) {
        var $t = $(e.target);
        if ($t.hasClass('bp-dir-name') || $t.hasClass('bp-dir-status') || $t.hasClass('bp-dir-date')) {
            var i = parseInt($t.closest('.bp-director').attr('data-i'), 10); var d = state.directors[i]; if (!d) return;
            if ($t.hasClass('bp-dir-name')) d.name = $t.val(); else if ($t.hasClass('bp-dir-status')) d.status = $t.val(); else d.appointed = $t.val();
        }
        $t.removeClass('is-invalid'); $('#bpErr_' + String($t.attr('id') || '').replace(/^bp_/, '')).hide();
        refresh();
    });
    $(document).on('click', '#bpAddDirector', function () { state.directors.push({ name: '', role: 'Director', status: 'active', appointed: '' }); renderDirectors(); refresh(); });
    $(document).on('click', '.bp-dir-remove', function () { state.directors.splice(parseInt($(this).closest('.bp-director').attr('data-i'), 10), 1); renderDirectors(); refresh(); });
    $(document).on('click', '.bp-save', function () { saveSection($(this).attr('data-section')); });
    $(document).on('click', '.bp-discard', function () {
        var id = $(this).attr('data-section');
        if (!state.loaded || !SECTIONS[id]) return;
        clearErrors(); fillKeys(state.loaded, SECTIONS[id].keys); refresh(); state.baselines[id] = snapshotSection(id); updateDirty();
    });
    $(document).on('click', '#bpPreviewQuote', function () { preview('quote'); });
    $(document).on('click', '#bpPreviewInvoice', function () { preview('invoice'); });
    $(document).on('click', '#bpGoBank', function () {
        window.admNav.go('paymentSetupAdmin', { tab: 'payPanelBank', scroll: '#stEftCard' });
    });
    $(document).on('click', '#bpRevealId', async function () {
        var ok = await window.notificationService.showConfirm({ title: 'Show the director\'s ID number?', message: 'This is recorded in the audit log.', confirmText: 'Show', cancelText: 'Cancel' });
        if (!ok) return;
        var r = await call('POST', '/api/admin/business-profile/reveal-director-id', {});
        if (!r.ok) { toast('showError', 'Could not show the ID number', r.json.message || 'Please try again.'); return; }
        var $n = $('#bpIdNote').text('ID number: ' + r.json.director_id_number + '  (hidden again in 15 seconds)');
        setTimeout(function () { $n.text('An ID number is on file (hidden). Type a new one to replace it, or use Reveal / Remove.'); }, 15000);
    });
    $(document).on('click', '#bpClearId', async function () {
        var ok = await window.notificationService.showConfirm({ title: 'Remove the stored ID number?', message: 'It is deleted from the profile when you save.', confirmText: 'Remove', cancelText: 'Cancel' });
        if (!ok) return;
        $('#bp_director_id_number').val(''); $('#bpIdNote').text('The ID number will be removed when you save.'); state.loaded.director_id_set = false; $('#bpRevealId, #bpClearId').hide();
        state.clearId = true; updateDirty();
    });
    window.addEventListener('beforeunload', function (e) { if (state.dirty) { e.preventDefault(); e.returnValue = ''; } });

    window.loadBusinessProfile = load;
    window.bpTestHooks = { collect: collect, state: state, sections: SECTIONS, allKeys: ALL_KEYS };
})();
