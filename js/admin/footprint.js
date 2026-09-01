// Phase 6 (HOUSEKEEPING-NOTES.md): relocated from admin.html verbatim — the "5b. Footprint Logic"
// block. window.atlActivateDrawerTab (admin.html ~14783) is called from inside
// openFootprintEditor but is NOT moved here: it's a shared drawer-tab helper used verbatim by
// Events/Gallery/Career/Home Slider/Testimonials/Footprint (see its own comment there) — a Phase 7
// "Shared candidate," left in admin.html untouched.
//
// resetFootprintForm/openFootprintEditor/loadFootprint are attached to window explicitly:
// loadFootprint has two call sites in a later, separately-scoped <script> block in admin.html
// (the reconciliation/change-history refresh code), so all three are made explicitly reachable
// rather than relying on implicit classic-script global scoping.
let editingFootprintId = null;

const footprintCountriesList = [
    { code: 'af', name: 'Afghanistan' },
    { code: 'al', name: 'Albania' },
    { code: 'dz', name: 'Algeria' },
    { code: 'ad', name: 'Andorra' },
    { code: 'ao', name: 'Angola' },
    { code: 'ag', name: 'Antigua and Barbuda' },
    { code: 'ar', name: 'Argentina' },
    { code: 'am', name: 'Armenia' },
    { code: 'au', name: 'Australia' },
    { code: 'at', name: 'Austria' },
    { code: 'az', name: 'Azerbaijan' },
    { code: 'bs', name: 'Bahamas' },
    { code: 'bh', name: 'Bahrain' },
    { code: 'bd', name: 'Bangladesh' },
    { code: 'bb', name: 'Barbados' },
    { code: 'by', name: 'Belarus' },
    { code: 'be', name: 'Belgium' },
    { code: 'bz', name: 'Belize' },
    { code: 'bj', name: 'Benin' },
    { code: 'bt', name: 'Bhutan' },
    { code: 'bo', name: 'Bolivia' },
    { code: 'ba', name: 'Bosnia and Herzegovina' },
    { code: 'bw', name: 'Botswana' },
    { code: 'br', name: 'Brazil' },
    { code: 'bn', name: 'Brunei' },
    { code: 'bg', name: 'Bulgaria' },
    { code: 'bf', name: 'Burkina Faso' },
    { code: 'bi', name: 'Burundi' },
    { code: 'kh', name: 'Cambodia' },
    { code: 'cm', name: 'Cameroon' },
    { code: 'ca', name: 'Canada' },
    { code: 'cv', name: 'Cape Verde' },
    { code: 'cf', name: 'Central African Republic' },
    { code: 'td', name: 'Chad' },
    { code: 'cl', name: 'Chile' },
    { code: 'cn', name: 'China' },
    { code: 'co', name: 'Colombia' },
    { code: 'km', name: 'Comoros' },
    { code: 'cg', name: 'Congo' },
    { code: 'cr', name: 'Costa Rica' },
    { code: 'hr', name: 'Croatia' },
    { code: 'cu', name: 'Cuba' },
    { code: 'cy', name: 'Cyprus' },
    { code: 'cz', name: 'Czechia' },
    { code: 'dk', name: 'Denmark' },
    { code: 'dj', name: 'Djibouti' },
    { code: 'dm', name: 'Dominica' },
    { code: 'do', name: 'Dominican Republic' },
    { code: 'ec', name: 'Ecuador' },
    { code: 'eg', name: 'Egypt' },
    { code: 'sv', name: 'El Salvador' },
    { code: 'gq', name: 'Equatorial Guinea' },
    { code: 'er', name: 'Eritrea' },
    { code: 'ee', name: 'Estonia' },
    { code: 'sz', name: 'Eswatini' },
    { code: 'et', name: 'Ethiopia' },
    { code: 'fj', name: 'Fiji' },
    { code: 'fi', name: 'Finland' },
    { code: 'fr', name: 'France' },
    { code: 'ga', name: 'Gabon' },
    { code: 'gm', name: 'Gambia' },
    { code: 'ge', name: 'Georgia' },
    { code: 'de', name: 'Germany' },
    { code: 'gh', name: 'Ghana' },
    { code: 'gr', name: 'Greece' },
    { code: 'gd', name: 'Grenada' },
    { code: 'gt', name: 'Guatemala' },
    { code: 'gn', name: 'Guinea' },
    { code: 'gw', name: 'Guinea-Bissau' },
    { code: 'gy', name: 'Guyana' },
    { code: 'ht', name: 'Haiti' },
    { code: 'hn', name: 'Honduras' },
    { code: 'hu', name: 'Hungary' },
    { code: 'is', name: 'Iceland' },
    { code: 'in', name: 'India' },
    { code: 'id', name: 'Indonesia' },
    { code: 'ir', name: 'Iran' },
    { code: 'iq', name: 'Iraq' },
    { code: 'ie', name: 'Ireland' },
    { code: 'il', name: 'Israel' },
    { code: 'it', name: 'Italy' },
    { code: 'jm', name: 'Jamaica' },
    { code: 'jp', name: 'Japan' },
    { code: 'je', name: 'Jersey' },
    { code: 'jo', name: 'Jordan' },
    { code: 'kz', name: 'Kazakhstan' },
    { code: 'ke', name: 'Kenya' },
    { code: 'kp', name: 'North Korea' },
    { code: 'kr', name: 'South Korea' },
    { code: 'kw', name: 'Kuwait' },
    { code: 'kg', name: 'Kyrgyzstan' },
    { code: 'la', name: 'Laos' },
    { code: 'lv', name: 'Latvia' },
    { code: 'lb', name: 'Lebanon' },
    { code: 'ls', name: 'Lesotho' },
    { code: 'lr', name: 'Liberia' },
    { code: 'ly', name: 'Libya' },
    { code: 'li', name: 'Liechtenstein' },
    { code: 'lt', name: 'Lithuania' },
    { code: 'lu', name: 'Luxembourg' },
    { code: 'mg', name: 'Madagascar' },
    { code: 'mw', name: 'Malawi' },
    { code: 'my', name: 'Malaysia' },
    { code: 'mv', name: 'Maldives' },
    { code: 'ml', name: 'Mali' },
    { code: 'mt', name: 'Malta' },
    { code: 'mr', name: 'Mauritania' },
    { code: 'mu', name: 'Mauritius' },
    { code: 'mx', name: 'Mexico' },
    { code: 'md', name: 'Moldova' },
    { code: 'mc', name: 'Monaco' },
    { code: 'mn', name: 'Mongolia' },
    { code: 'me', name: 'Montenegro' },
    { code: 'ma', name: 'Morocco' },
    { code: 'mz', name: 'Mozambique' },
    { code: 'mm', name: 'Myanmar' },
    { code: 'na', name: 'Namibia' },
    { code: 'np', name: 'Nepal' },
    { code: 'nl', name: 'Netherlands' },
    { code: 'nz', name: 'New Zealand' },
    { code: 'ni', name: 'Nicaragua' },
    { code: 'ne', name: 'Niger' },
    { code: 'ng', name: 'Nigeria' },
    { code: 'no', name: 'Norway' },
    { code: 'om', name: 'Oman' },
    { code: 'pk', name: 'Pakistan' },
    { code: 'pa', name: 'Panama' },
    { code: 'pg', name: 'Papua New Guinea' },
    { code: 'py', name: 'Paraguay' },
    { code: 'pe', name: 'Peru' },
    { code: 'ph', name: 'Philippines' },
    { code: 'pl', name: 'Poland' },
    { code: 'pt', name: 'Portugal' },
    { code: 'qa', name: 'Qatar' },
    { code: 'ro', name: 'Romania' },
    { code: 'ru', name: 'Russia' },
    { code: 'rw', name: 'Rwanda' },
    { code: 'sa', name: 'Saudi Arabia' },
    { code: 'sn', name: 'Senegal' },
    { code: 'rs', name: 'Serbia' },
    { code: 'sc', name: 'Seychelles' },
    { code: 'sl', name: 'Sierra Leone' },
    { code: 'sg', name: 'Singapore' },
    { code: 'sk', name: 'Slovakia' },
    { code: 'si', name: 'Slovenia' },
    { code: 'so', name: 'Somalia' },
    { code: 'za', name: 'South Africa' },
    { code: 'ss', name: 'South Sudan' },
    { code: 'es', name: 'Spain' },
    { code: 'lk', name: 'Sri Lanka' },
    { code: 'sd', name: 'Sudan' },
    { code: 'sr', name: 'Suriname' },
    { code: 'se', name: 'Sweden' },
    { code: 'ch', name: 'Switzerland' },
    { code: 'sy', name: 'Syria' },
    { code: 'tw', name: 'Taiwan' },
    { code: 'tj', name: 'Tajikistan' },
    { code: 'tz', name: 'Tanzania' },
    { code: 'th', name: 'Thailand' },
    { code: 'tg', name: 'Togo' },
    { code: 'tt', name: 'Trinidad and Tobago' },
    { code: 'tn', name: 'Tunisia' },
    { code: 'tr', name: 'Turkey' },
    { code: 'ug', name: 'Uganda' },
    { code: 'ua', name: 'Ukraine' },
    { code: 'ae', name: 'United Arab Emirates' },
    { code: 'gb', name: 'United Kingdom' },
    { code: 'us', name: 'United States' },
    { code: 'uy', name: 'Uruguay' },
    { code: 'uz', name: 'Uzbekistan' },
    { code: 've', name: 'Venezuela' },
    { code: 'vn', name: 'Vietnam' },
    { code: 'ye', name: 'Yemen' },
    { code: 'zm', name: 'Zambia' },
    { code: 'zw', name: 'Zimbabwe' }
];

function resetFootprintForm() {
    $('#footprintForm')[0].reset();
    $('#footprintCountrySelect').val('');
    $('#footprintFlagPreview').hide();
    $('#footprintFlagPreviewImg').attr('src', '');
    $('#err-footprintForm').hide();
    editingFootprintId = null;
    $('#footprint-tab-history').hide();
    window.atlActivateDrawerTab('footprintDrawer', 'footprint-tab-edit');
    $('#footprintDrawerTitle').html('<i class="fa-solid fa-earth-africa"></i> Add Country');
    $('#footprintSubmitBtn').html('<i class="fa-solid fa-plus-circle"></i> Add Country').prop('disabled', false);
}
window.resetFootprintForm = resetFootprintForm;

function openFootprintEditor(item) {
    resetFootprintForm();
    editingFootprintId = item.id;
    const country = footprintCountriesList.find(c => c.name.toLowerCase() === (item.country_name || '').toLowerCase());
    if (country) {
        $('#footprintCountrySelect').val(country.code);
    } else {
        $('#footprintCountrySelect').val('');
    }
    if (item.flag_image_path) {
        $('#footprintFlagPreviewImg').attr('src', item.flag_image_path);
        $('#footprintFlagPreview').show();
    }
    $('#footprintDrawerTitle').html('<i class="fa-solid fa-earth-africa"></i> Edit Country');
    $('#footprintSubmitBtn').html('<i class="fa-solid fa-floppy-disk"></i> Update Country');
    $('#footprint-tab-history').show();
    if (window.loadChangeHistoryCard) window.loadChangeHistoryCard('footprintChangeHistoryList', 'footprint_countries', item.id);
    openAtlDrawer('footprintDrawer');
}
window.openFootprintEditor = openFootprintEditor;

async function loadFootprint() {
    var $list = $('#adminFootprintList');
    $list.html('<div class="um-empty-state" style="grid-column:1/-1; padding:30px 20px;"><i class="fa-solid fa-circle-notch fa-spin" style="font-size:22px;color:var(--atl-amber);display:block;margin-bottom:8px;"></i>Loading countries…</div>');
    try {
        const rows = await apiCall('/api/admin/footprint');
        const items = Array.isArray(rows) ? rows : [];
        $list.empty();
        if (!items.length) {
            $list.html('<div class="um-empty-state" style="grid-column:1/-1; padding:30px 20px;"><i class="fa-solid fa-earth-africa" style="font-size:22px;color:var(--atl-muted-dim);display:block;margin-bottom:8px;"></i>No countries yet — add the first one.</div>');
            return;
        }
        items.forEach(function (item) {
            var safeName = $('<span>').text(item.country_name || '').html();
            var safeThumb = $('<span>').text(item.flag_image_path || '').html();
            var html = `
                <article class="atl-edit-card" data-id="${item.id}">
                    <div class="atl-card-inner">
                        <div class="atl-edit-card__header">
                            <div class="atl-edit-card__thumb">
                                <img src="${safeThumb}" alt="Flag of ${safeName}" onerror="this.style.opacity='0.2';">
                            </div>
                            <div style="flex:1; min-width:0;">
                                <h3 class="atl-edit-card__title">${safeName}</h3>
                            </div>
                            <div style="display:flex; flex-direction:column; align-items:flex-end; gap:6px; flex-shrink:0;">
                                <button type="button" class="atl-btn atl-btn--ghost um-btn--sm footprint-edit-btn" data-id="${item.id}" title="Edit" aria-label="Edit ${safeName}"><i class="fa-solid fa-pen"></i></button>
                                <button type="button" class="um-btn um-btn--danger um-btn--sm footprint-delete-btn" data-id="${item.id}" title="Delete" aria-label="Delete ${safeName}"><i class="fa-solid fa-trash"></i></button>
                            </div>
                        </div>
                    </div>
                </article>`;
            $list.append(html);
        });
    } catch (err) {
        console.error('Failed to load footprint countries:', err);
        $list.html('<div class="um-empty-state" style="grid-column:1/-1; padding:30px 20px;"><i class="fa-solid fa-triangle-exclamation" style="font-size:22px;color:var(--atl-clay);display:block;margin-bottom:8px;"></i>Could not load countries.</div>');
    }
}
window.loadFootprint = loadFootprint;

$(document).on('click', '#footprintAddNewBtn', function () {
    resetFootprintForm();
    openAtlDrawer('footprintDrawer');
});
$(document).on('click', '#footprintDrawerClose, #footprintDrawerBackdrop, #footprintCancelBtn', function () {
    if (window.closeAtlDrawer) closeAtlDrawer('footprintDrawer');
});
$(document).on('click', '.footprint-edit-btn', async function () {
    var id = $(this).data('id');
    try {
        const rows = await apiCall('/api/admin/footprint');
        const item = (Array.isArray(rows) ? rows : []).find(r => r.id === id);
        if (item) openFootprintEditor(item);
    } catch (err) {
        console.error('Failed to load country for edit:', err);
    }
});
$(document).on('click', '.footprint-delete-btn', async function () {
    var id = $(this).data('id');
    if (!(await window.notificationService.showConfirm({ title: 'Delete Country', message: 'Permanently remove this country from Footprint? This cannot be undone.', isDestructive: true }))) return;
    try {
        await apiCall('/api/admin/footprint/' + id, 'DELETE');
        window.notificationService.showSuccess('Country removed.');
        loadFootprint();
    } catch (err) {
        console.error('Delete footprint country failed:', err);
        window.notificationService.showError('Could not delete this country.');
    }
});

$(function () {
    const $select = $('#footprintCountrySelect');
    if ($select.length) {
        footprintCountriesList.forEach(c => {
            $select.append(new Option(c.name, c.code));
        });
    }
});

$(document).on('change', '#footprintCountrySelect', function () {
    const code = $(this).val();
    if (code) {
        const flagUrl = `https://flagcdn.com/w320/${code}.png`;
        $('#footprintFlagPreviewImg').attr('src', flagUrl);
        $('#footprintFlagPreview').show();
    } else {
        $('#footprintFlagPreview').hide();
        $('#footprintFlagPreviewImg').attr('src', '');
    }
});

$(document).on('submit', '#footprintForm', async function (e) {
    e.preventDefault();
    var code = $('#footprintCountrySelect').val();
    if (!code) {
        $('#err-footprintForm').text('Please select a country.').show();
        return;
    }
    $('#err-footprintForm').hide();

    const country = footprintCountriesList.find(c => c.code === code);
    const countryName = country ? country.name : '';
    const flagUrl = `https://flagcdn.com/w320/${code}.png`;
    var isEdit = editingFootprintId !== null;

    var $btn = $('#footprintSubmitBtn');
    $btn.prop('disabled', true).html('<i class="fa-solid fa-spinner fa-spin"></i> Saving...');

    try {
        if (isEdit) {
            var jsonBody = { country_name: countryName, fallback_url: flagUrl };
            await apiCall('/api/admin/footprint/' + editingFootprintId, 'PUT', jsonBody);
        } else {
            var formData = new FormData();
            formData.append('country_name', countryName);
            formData.append('fallback_url', flagUrl);
            formData.append('section', 'footprint');
            const res = await fetch('/api/admin/footprint', { method: 'POST', body: formData });
            if (!res.ok) throw new Error('Server error saving country');
        }

        closeAtlDrawer('footprintDrawer');
        resetFootprintForm();
        await loadFootprint();
        window.notificationService.showSuccess(isEdit ? 'Country updated.' : 'Country added.');
    } catch (err) {
        console.error('Footprint save error', err);
        window.notificationService.showError('An error occurred while saving.');
        $btn.prop('disabled', false).html(isEdit ? '<i class="fa-solid fa-floppy-disk"></i> Update Country' : '<i class="fa-solid fa-plus-circle"></i> Add Country');
    }
});
