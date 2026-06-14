const fs = require('fs');
const path = require('path');

const adminPath = path.join(__dirname, '..', 'admin.html');
let content = fs.readFileSync(adminPath, 'utf8');

const replacements = [
    // 1. JS css color calls
    {
        search: `.css('color', isProvided ? '#4CAF50' : '#aaa')`,
        replace: `.css('color', isProvided ? 'var(--atl-green)' : 'var(--atl-muted)')`
    },
    {
        search: `const payColor = { PAID:'#4CAF50', PARTIALLY_PAID:'#ff9800', DEPOSIT_PAID:'#64B5F6', UNPAID:'#F44336', FAILED:'#ef5350' };`,
        replace: `const payColor = { PAID:'var(--atl-green)', PARTIALLY_PAID:'var(--atl-orange)', DEPOSIT_PAID:'var(--atl-blue)', UNPAID:'var(--atl-clay)', FAILED:'var(--atl-clay)' };`
    },
    {
        search: `const netClr = net >= 0 ? '#4CAF50' : '#ef5350';`,
        replace: `const netClr = net >= 0 ? 'var(--atl-green)' : 'var(--atl-clay)';`
    },
    {
        search: `+ '<span style="color:#ef5350;">- R '`,
        replace: `+ '<span style="color:var(--atl-clay);">- R '`
    },
    {
        search: `$('#bf-pl-card').html('<div style="color:#ef5350;font-size:12px;">Failed to load P&L data.</div>');`,
        replace: `$('#bf-pl-card').html('<div style="color:var(--atl-clay);font-size:12px;">Failed to load P&L data.</div>');`
    },
    {
        search: `$('#bf-doc-links').html('<div style="color:#ef5350;">Failed to load documents.</div>');`,
        replace: `$('#bf-doc-links').html('<div style="color:var(--atl-clay);">Failed to load documents.</div>');`
    },
    {
        search: `$('#be-alert').css('color', '#ef5350').text('Subject and message are required.').show();`,
        replace: `$('#be-alert').css('color', 'var(--atl-clay)').text('Subject and message are required.').show();`
    },
    {
        search: `$('#newsletterSubject').css('border-color', '#ef5350');`,
        replace: `$('#newsletterSubject').css('border-color', 'var(--atl-clay)');`
    },
    {
        search: `$('#newsletterEditorContainer .ql-container').css('border-color', '#ef5350');`,
        replace: `$('#newsletterEditorContainer .ql-container').css('border-color', 'var(--atl-clay)');`
    },
    {
        search: `$('#draftStatus').text('Draft saved at ' + new Date().toLocaleTimeString()).css('color', '#4CAF50');`,
        replace: `$('#draftStatus').text('Draft saved at ' + new Date().toLocaleTimeString()).css('color', 'var(--atl-sage)');`
    },
    {
        search: `$('#draftStatus').text('Save failed.').css('color', '#ef5350');`,
        replace: `$('#draftStatus').text('Save failed.').css('color', 'var(--atl-clay)');`
    },
    {
        search: `$('#draftStatus').text('Draft updated at ' + new Date().toLocaleTimeString()).css('color', '#4CAF50');`,
        replace: `$('#draftStatus').text('Draft updated at ' + new Date().toLocaleTimeString()).css('color', 'var(--atl-sage)');`
    },
    {
        search: `$('#draftStatus').text('Save failed.').css('color', '#ef5350');`,
        replace: `$('#draftStatus').text('Save failed.').css('color', 'var(--atl-clay)');`
    },
    {
        search: `$('#draftStatus').text('Draft deleted.').css('color', '#ef5350');`,
        replace: `$('#draftStatus').text('Draft deleted.').css('color', 'var(--atl-clay)');`
    },
    {
        search: `const statusColors = { sent:'#4CAF50', scheduled:'#FF9800', failed:'#ef5350', cancelled:'#666' };`,
        replace: `const statusColors = { sent:'var(--atl-green)', scheduled:'var(--atl-orange)', failed:'var(--atl-clay)', cancelled:'var(--atl-muted)' };`
    },
    {
        search: `\${isPending ? \`<button class="um-btn um-btn--ghost um-btn--sm campaign-cancel-btn" data-id="\${c.id}" style="margin-right:4px;color:#FF9800;border-color:#FF9800;"`,
        replace: `\${isPending ? \`<button class="um-btn um-btn--ghost um-btn--sm campaign-cancel-btn" data-id="\${c.id}" style="margin-right:4px;color:var(--atl-orange);border-color:var(--atl-orange);"`,
        allowRaw: true
    },
    {
        search: `<button class="um-btn um-btn--ghost um-btn--sm campaign-delete-btn" data-id="\${c.id}" data-source="\${c.source}" style="color:#ef5350;" title="Delete">`,
        replace: `<button class="um-btn um-btn--ghost um-btn--sm campaign-delete-btn" data-id="\${c.id}" data-source="\${c.source}" style="color:var(--atl-clay);" title="Delete">`,
        allowRaw: true
    },
    {
        search: `$tbody.html('<tr><td colspan="5" style="padding:20px;text-align:center;color:#ef5350;font-size:13px;">Could not load campaigns.</td></tr>');`,
        replace: `$tbody.html('<tr><td colspan="5" style="padding:20px;text-align:center;color:var(--atl-clay);font-size:13px;">Could not load campaigns.</td></tr>');`
    },
    {
        search: `<h5 class="modal-title" id="cancelBookingModalLabel" style="color:#ef5350;text-transform:uppercase;letter-spacing:1px;"><i class="fa-solid fa-ban"`,
        replace: `<h5 class="modal-title" id="cancelBookingModalLabel" style="color:var(--atl-clay);text-transform:uppercase;letter-spacing:1px;"><i class="fa-solid fa-ban"`
    },
    {
        search: `<button type="button" id="cancelConfirmBtn" class="btn" style="background:rgba(244,67,54,0.2);color:#ef5350;border:1px solid rgba(244,67,54,0.5);">`,
        replace: `<button type="button" id="cancelConfirmBtn" class="btn" style="background:rgba(248,113,113,0.2);color:var(--atl-clay);border:1px solid rgba(248,113,113,0.5);">`
    },
    {
        search: `<i class="fa-solid fa-file-pdf" style="color:#ef5350;margin-right:8px;"></i>`,
        replace: `<i class="fa-solid fa-file-pdf" style="color:var(--atl-clay);margin-right:8px;"></i>`
    },
    {
        search: `<i class="fa-solid fa-signature" style="margin-right:6px;color:#4CAF50;"></i>Record Signature`,
        replace: `<i class="fa-solid fa-signature" style="margin-right:6px;color:var(--atl-sage);"></i>Record Signature`
    },
    {
        search: `<button type="button" id="contractConfirmSignBtn" class="btn" style="background:rgba(76,175,80,0.2);color:#4CAF50;border:1px solid rgba(76,175,80,0.4);"`,
        replace: `<button type="button" id="contractConfirmSignBtn" class="btn" style="background:rgba(52,211,153,0.2);color:var(--atl-green);border:1px solid rgba(52,211,153,0.4);"`
    },
    {
        search: `<h5 class="modal-title" id="expenseModalLabel" style="color:#ef5350;font-size:16px;font-weight:700;">`,
        replace: `<h5 class="modal-title" id="expenseModalLabel" style="color:var(--atl-clay);font-size:16px;font-weight:700;">`
    },
    {
        search: `<button type="button" id="expenseSaveBtn" class="btn" style="background:linear-gradient(135deg,#ef5350,#b71c1c);color: var(--atl-ink);border:none;border-radius:6px;font-size:12px;font-weight:700;white-space:nowrap;cursor:pointer;">`,
        replace: `<button type="button" id="expenseSaveBtn" class="atl-btn atl-btn--danger-solid" style="font-size:12px;white-space:nowrap;padding:8px 18px;">`
    },
    {
        search: `<div class="modal-header" style="background:linear-gradient(135deg,#1a1a1a,#222); border-bottom:2px solid #D4AF37; padding:18px 24px;">`,
        replace: `<div class="modal-header" style="background:var(--atl-topbar-bg); border-bottom:1px solid var(--atl-amber-border); padding:18px 24px;">`
    },
    {
        search: `<button type="button" class="btn" data-dismiss="modal" style="background:#D4AF37;color:#111;font-weight:700;border:none;padding:8px 22px;border-radius:4px;cursor:pointer;">`,
        replace: `<button type="button" class="atl-btn atl-btn--primary" data-dismiss="modal" style="padding:8px 22px;">`
    },
    {
        search: `<div class="modal-header" style="border-bottom:2px solid #D4AF37;">`,
        replace: `<div class="modal-header" style="border-bottom:1px solid var(--atl-amber-border);background:var(--atl-topbar-bg);">`
    },
    {
        search: `.fc .fc-button-primary:hover { background: #D4AF37; border-color: var(--atl-amber); color: #111; }`,
        replace: `.fc .fc-button-primary:hover { background: var(--atl-amber); border-color: var(--atl-amber-hover); color: var(--atl-on-amber); }`
    },
    {
        search: `.fc .fc-button-primary:not(:disabled).fc-button-active { background: #D4AF37; border-color: var(--atl-amber); color: #111; }`,
        replace: `.fc .fc-button-primary:not(:disabled).fc-button-active { background: var(--atl-amber); border-color: var(--atl-amber-hover); color: var(--atl-on-amber); }`
    },
    {
        search: `.fc-event { border: none; border-radius: 4px; padding: 2px 4px; border-left: 3px solid #D4AF37; }`,
        replace: `.fc-event { border: none; border-radius: 4px; padding: 2px 4px; border-left: 3px solid var(--atl-amber); }`
    },
    {
        search: `.mini-calendar-header .change-btn:hover { background: #D4AF37; color: #111; }`,
        replace: `.mini-calendar-header .change-btn:hover { background: var(--atl-amber); color: var(--atl-on-amber); }`
    },
    {
        search: `.mini-calendar-table td.current-day { background: #D4AF37; color: #111; font-weight: bold; }`,
        replace: `.mini-calendar-table td.current-day { background: var(--atl-amber); color: var(--atl-on-amber); font-weight: bold; }`
    },
    {
        search: `'<button onclick="switchTab(\\'bookingsAdmin\\'); $(\\'#bookingStatusFilter\\').val(\\'All\\').trigger(\\'change\\'); setTimeout(() => { const el = document.getElementById(\\'bkSearchInput\\'); if (el) { el.value = \\'' + props.dbId + '\\'; el.dispatchEvent(new Event(\\'input\\')); } }, 300);" class="btn btn-xs" style="background:#D4AF37;color:#111;border:none;font-weight:700;"><i class="fa-solid fa-eye"></i> View Booking</button>'`,
        replace: `'<button onclick="switchTab(\\'bookingsAdmin\\'); $(\\'#bookingStatusFilter\\').val(\\'All\\').trigger(\\'change\\'); setTimeout(() => { const el = document.getElementById(\\'bkSearchInput\\'); if (el) { el.value = \\'' + props.dbId + '\\'; el.dispatchEvent(new Event(\\'input\\')); } }, 300);" class="atl-btn atl-btn--primary" style="padding:4px 8px;font-size:11px;"><i class="fa-solid fa-eye"></i> View Booking</button>'`
    },
    {
        search: `'<strong style="color:#17a2b8;font-size:14px;"><i class="fa-solid fa-star"></i> Public Event</strong>' +`,
        replace: `'<strong style="color:var(--atl-blue);font-size:14px;"><i class="fa-solid fa-star"></i> Public Event</strong>' +`
    },
    {
        search: `'<strong style="color:#17a2b8;font-size:13px;">' + info.event.title + '</strong>' +`,
        replace: `'<strong style="color:var(--atl-blue);font-size:13px;">' + info.event.title + '</strong>' +`
    },
    {
        search: `let dotColor = '#D4AF37'; // Default gold`,
        replace: `let dotColor = 'var(--atl-amber)'; // Default gold`
    },
    {
        search: `dotColor = '#D4AF37';`,
        replace: `dotColor = 'var(--atl-amber)';`
    },
    {
        search: `dotColor = '#17a2b8';`,
        replace: `dotColor = 'var(--atl-blue)';`
    },
    {
        search: `{ value: 'unavailable', label: '🔴 Unavailable', color: '#EF5350' },`,
        replace: `{ value: 'unavailable', label: '🔴 Unavailable', color: 'var(--atl-clay)' },`
    },
    {
        search: `{ value: 'personal',    label: '🔵 Personal',    color: '#42A5F5' },`,
        replace: `{ value: 'personal',    label: '🔵 Personal',    color: 'var(--atl-blue)' },`
    },
    {
        search: `{ value: 'travel',      label: '🟢 Travel',      color: '#66BB6A' },`,
        replace: `{ value: 'travel',      label: '🟢 Travel',      color: 'var(--atl-green)' },`
    },
    {
        search: `{ value: 'maintenance', label: '🟡 Maintenance', color: '#FFA726' }`,
        replace: `{ value: 'maintenance', label: '🟡 Maintenance', color: 'var(--atl-orange)' }`
    },
    {
        search: `$text.text(files[0].name).css('color', '#D4AF37');`,
        replace: `$text.text(files[0].name).css('color', 'var(--atl-amber)');`
    },
    {
        search: `$text.text(files.length + ' files selected').css('color', '#D4AF37');`,
        replace: `$text.text(files.length + ' files selected').css('color', 'var(--atl-amber)');`
    }
];

let replacedCount = 0;
let details = [];

replacements.forEach(rep => {
    if (content.includes(rep.search)) {
        const occurrences = content.split(rep.search).length - 1;
        content = content.split(rep.search).join(rep.replace);
        replacedCount += occurrences;
        details.push(`- Success: Replaced "${rep.search.substring(0, 50)}..." with "${rep.replace.substring(0, 50)}..." (${occurrences} occurrences)`);
    } else {
        details.push(`- Warning: Target not found: "${rep.search.substring(0, 50)}..."`);
    }
});

fs.writeFileSync(adminPath, content, 'utf8');
console.log(`JS color refactoring complete! Replaced ${replacedCount} elements.`);
console.log(details.join('\n'));
