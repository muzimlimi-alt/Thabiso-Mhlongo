// Phase 6 (HOUSEKEEPING-NOTES.md): relocated from admin.html verbatim — the "6. Contact Logic"
// block. No drawer here (unlike every prior Phase 6 section) — just two plain forms
// (#contactAdminForm, #managerAdminForm) living directly in the section markup — so no
// atlActivateDrawerTab/uploadFileToServer shared-candidate dependency this time.
// Email Validation Helper
function isValidEmail(email) {
    var re = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return re.test(email);
}

var itiManagerCell; // globally scoped for access
var itiManagerWhatsApp;

async function loadContactData() {
    try {
        const data = await apiCall('/api/public/contact_info');
        if (data && !data.error) {
            $('#contactDeliveryEmail').val(data.email || '');
            $('#contactQuote').val(data.quote || '');
            $('#contactSig').val(data.signature || '');
        }
    } catch (e) {
        console.error("Failed to load contact info from API:", e);
        if (window.notificationService) window.notificationService.showError('Could not load contact settings — please refresh.');
    }
}
window.loadContactData = loadContactData;

async function loadManagerData() {
    try {
        const data = await apiCall('/api/public/manager');
        if (data && !data.error && data.name) {
            $('#managerName').val(data.name || '');
            $('#managerEmail').val(data.email || '');
            $('#managerWhatsAppLink').val(data.whatsapp_link || '');
            if (data.cell_number && itiManagerCell) {
                itiManagerCell.setNumber(data.cell_number);
            }
            if (data.whatsapp_number && itiManagerWhatsApp) {
                itiManagerWhatsApp.setNumber(data.whatsapp_number);
            }
        } else {
            $('#managerAdminForm')[0].reset();
        }
    } catch (e) {
        console.error("Failed to load manager details from API:", e);
        if (window.notificationService) window.notificationService.showError('Could not load manager details — please refresh.');
    }
}

$(document).ready(function() {
    var input = document.querySelector("#managerCell");
    itiManagerCell = window.intlTelInput(input, {
        utilsScript: "https://cdnjs.cloudflare.com/ajax/libs/intl-tel-input/17.0.19/js/utils.js",
        separateDialCode: true,
        initialCountry: "za"
    });
    var waInput = document.querySelector("#managerWhatsApp");
    itiManagerWhatsApp = window.intlTelInput(waInput, {
        utilsScript: "https://cdnjs.cloudflare.com/ajax/libs/intl-tel-input/17.0.19/js/utils.js",
        separateDialCode: true,
        initialCountry: "za"
    });
    // Re-call load to populate it after init if necessary
    loadContactData();
    loadManagerData();
});

$('#contactAdminForm').on('submit', async function (e) {
    e.preventDefault();
    var em = $('#contactDeliveryEmail').val().trim();
    if (!isValidEmail(em)) {
        window.notificationService.showError("Please enter a valid Form Delivery Email address.");
        return;
    }

    var data = {
        email: em,
        quote: $('#contactQuote').val().trim(),
        sig: $('#contactSig').val().trim()
    };

    // Explicitly sync to local storage for backward compatibility if any old scripts still rely on it
    localStorage.setItem('tm_contact_data', JSON.stringify(data));

    var $btn = $('#contactSubmitBtn');
    var origHtml = $btn.html();
    $btn.prop('disabled', true).html('<i class="fa-solid fa-spinner fa-spin"></i> Saving...');
    try {
        // apiCall throws on non-OK / {error} responses; without this guard the success UI ran unconditionally.
        await apiCall('/api/admin/contact_info', 'POST', { data: data });
        $btn.html('<i class="fa-solid fa-check"></i> Saved!');
    } catch (err) {
        // apiCall already surfaced the specific error toast; reflect the failure on the button.
        $btn.html('<i class="fa-solid fa-triangle-exclamation"></i> Error!');
    } finally {
        setTimeout(function () { $btn.prop('disabled', false).html(origHtml); }, 2000);
    }
});

$('#managerAdminForm').on('submit', async function (e) {
    e.preventDefault();
    var em = $('#managerEmail').val().trim();
    if (!isValidEmail(em)) {
        window.notificationService.showError("Please enter a valid Manager Email address.");
        return;
    }

    if (!itiManagerCell.isValidNumber()) {
        window.notificationService.showError("Please enter a valid, complete cell number matching the selected country code.");
        return;
    }
    if (!itiManagerWhatsApp.isValidNumber()) {
        window.notificationService.showError("Please enter a valid, complete WhatsApp number matching the selected country code.");
        return;
    }

    var data = {
        name: $('#managerName').val().trim(),
        cell_number: itiManagerCell.getNumber(), // strice E.164
        whatsapp_number: itiManagerWhatsApp.getNumber(),
        email: em,
        whatsapp_link: $('#managerWhatsAppLink').val().trim()
    };

    var $btn = $('#managerSubmitBtn');
    var origText = $btn.text();
    $btn.prop('disabled', true).text('Saving...');

    try {
        // apiCall throws on non-OK / {error} responses (raw fetch did not — D1 silent-success bug).
        await apiCall('/api/admin/manager', 'PUT', data);
        $btn.text('Saved Successfully!').addClass('btn-admin-success').removeClass('btn-admin-primary');
    } catch (err) {
        // apiCall already surfaced the specific error toast; reflect the failure on the button.
        $btn.text('Error!').addClass('btn-admin-danger').removeClass('btn-admin-primary');
    } finally {
        setTimeout(function () {
            $btn.prop('disabled', false).text(origText).removeClass('btn-admin-success btn-admin-danger').addClass('btn-admin-primary');
        }, 2000);
    }
});

$('#managerClearBtn').on('click', async function (e) {
    e.preventDefault();
    if (await window.notificationService.showConfirm({ message: "Are you sure you want to completely clear the manager details from the website?", isDestructive: true })) {
        var $btn = $(this);
        var origText = $btn.text();
        $btn.prop('disabled', true).text('Clearing...');

        try {
            await apiCall('/api/admin/manager', 'DELETE');
            $('#managerAdminForm')[0].reset();
            $btn.text('Cleared!').addClass('btn-admin-success').removeClass('btn-admin-danger');
        } catch (err) {
            // apiCall already surfaced the specific error toast.
            $btn.text('Error!').removeClass('btn-admin-danger');
        } finally {
            setTimeout(function () {
                $btn.prop('disabled', false).text(origText).removeClass('btn-admin-success').addClass('btn-admin-danger');
            }, 2000);
        }
    }
});
