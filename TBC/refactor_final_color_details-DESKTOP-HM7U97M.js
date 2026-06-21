const fs = require('fs');
const path = require('path');

const adminPath = path.join(__dirname, '..', 'admin.html');
let content = fs.readFileSync(adminPath, 'utf8');

const replacements = [
    // L10448 - L10549
    { search: `$(this).find('.qb-qty').css('border-color', '#ef5350');`, replace: `$(this).find('.qb-qty').css('border-color', 'var(--atl-clay)');` },
    { search: `$msg.css('color','#F44336').text('Please add at least one item and set expiry.');`, replace: `$msg.css('color','var(--atl-clay)').text('Please add at least one item and set expiry.');` },
    { search: `$msg.css('color','#4CAF50').text('Quote sent successfully!');`, replace: `$msg.css('color','var(--atl-sage)').text('Quote sent successfully!');` },
    { search: `$msg.css('color','#F44336').text(d.message || 'Failed to send quote.');`, replace: `$msg.css('color','var(--atl-clay)').text(d.message || 'Failed to send quote.');` },
    { search: `$msg.css('color','#F44336').text('Network error.');`, replace: `$msg.css('color','var(--atl-clay)').text('Network error.');` },
    
    // L10724 - L10727
    { search: `$('#cancelModalMsg').css('color','#ef5350').text(d.message || 'Cancellation failed.');`, replace: `$('#cancelModalMsg').css('color','var(--atl-clay)').text(d.message || 'Cancellation failed.');` },
    { search: `$('#cancelModalMsg').css('color','#ef5350').text('Network error. Please try again.');`, replace: `$('#cancelModalMsg').css('color','var(--atl-clay)').text('Network error. Please try again.');` },
    
    // L10795
    { search: `style="background:none;border:none;color:#EF5350;font`, replace: `style="background:none;border:none;color:var(--atl-clay);font` },
    
    // L10981 - L11042 (Contract alert texts)
    { search: `$('#contractModalMsg').css('color','#ef5350')`, replace: `$('#contractModalMsg').css('color','var(--atl-clay)')` },
    { search: `$('#contractModalMsg').css('color','#4CAF50')`, replace: `$('#contractModalMsg').css('color','var(--atl-sage)')` },
    { search: `$('#contractSignMsg').css('color','#ef5350')`, replace: `$('#contractSignMsg').css('color','var(--atl-clay)')` },
    { search: `$('#contractSignMsg').css('color','#4CAF50')`, replace: `$('#contractSignMsg').css('color','var(--atl-sage)')` },
    
    // L11128
    { search: `style="color:#ef5350;"` + `>Failed to load expenses.`, replace: `style="color:var(--atl-clay);"` + `>Failed to load expenses.` },
    
    // L11160
    { search: `const netColor = net >= 0 ? '#4CAF50' : '#ef5350';`, replace: `const netColor = net >= 0 ? 'var(--atl-green)' : 'var(--atl-clay)';` },
    { search: `style="color:#4CAF50;font-weight:600;"`, replace: `style="color:var(--atl-green);font-weight:600;"` },
    { search: `style="color:#ef5350;font-weight:600;"`, replace: `style="color:var(--atl-clay);font-weight:600;"` },
    
    // L11224 - L11244 (Expense alerts)
    { search: `$('#expenseModalMsg').css('color','#ef5350')`, replace: `$('#expenseModalMsg').css('color','var(--atl-clay)')` },
    { search: `$('#expenseModalMsg').css('color','#4CAF50')`, replace: `$('#expenseModalMsg').css('color','var(--atl-sage)')` },
    
    // L11288 - L11296
    { search: `color:#4CAF50;">\${R_FMT(s.total_received)}`, replace: `color:var(--atl-green);">\${R_FMT(s.total_received)}` },
    { search: `color:#ef5350;">\${R_FMT(s.total_duplicates_flagged)}`, replace: `color:var(--atl-clay);">\${R_FMT(s.total_duplicates_flagged)}` },
    { search: `color:#FF9800;">\${R_FMT(parseFloat(s.total_quoted) - parseFloat(s.total_received))}`, replace: `color:var(--atl-orange);">\${R_FMT(parseFloat(s.total_quoted) - parseFloat(s.total_received))}` },
    
    // L11311 - L11332
    { search: `background:rgba(239,83,80,0.2);color:#ef5350;border:1px solid #ef5350;`, replace: `background:rgba(248,113,113,0.15);color:var(--atl-clay);border:1px solid var(--atl-clay);` },
    { search: `background:rgba(255,152,0,0.2);color:#FF9800;border:1px solid #FF9800;`, replace: `background:rgba(251,146,60,0.15);color:var(--atl-orange);border:1px solid var(--atl-orange);` },
    { search: `color:#4CAF50;font-size:12px;`, replace: `color:var(--atl-green);font-size:12px;` },
    { search: `const psColor = r.payment_status === 'PAID' ? '#4CAF50' : r.payment_status === 'UNPAID' ? '#ef5350' : '#FF9800';`, replace: `const psColor = r.payment_status === 'PAID' ? 'var(--atl-green)' : r.payment_status === 'UNPAID' ? 'var(--atl-clay)' : 'var(--atl-orange)';` },
    { search: `const effectiveColor = warnOver ? '#ef5350' : '#fff';`, replace: `const effectiveColor = warnOver ? 'var(--atl-clay)' : 'var(--atl-ink)';` },
    { search: `style="color:#FF9800;"`, replace: `style="color:var(--atl-orange);"` },
    { search: `style="color:#ef5350;"` + `>Failed to load reconciliation data.`, replace: `style="color:var(--atl-clay);"` + `>Failed to load reconciliation data.` },
    
    // L11399
    { search: `style="accent-color:#ef5350;`, replace: `style="accent-color:var(--atl-clay);` },
    
    // L11413
    { search: `style="color:#ef5350;font-size:12px;"` + `>Failed to load transactions.`, replace: `style="color:var(--atl-clay);font-size:12px;"` + `>Failed to load transactions.` },
    
    // L13491 Expense Save button
    {
        search: `<button type="button" id="expenseSaveBtn" class="btn" style="background:linear-gradient(135deg,#ef5350,#b71c1c);color: var(--atl-ink);border:none;border-radius:6px;font-size:12px;font-weight:700;white-space:nowrap;cursor:pointer;">`,
        replace: `<button type="button" id="expenseSaveBtn" class="atl-btn atl-btn--primary" style="background:var(--atl-clay);border-color:var(--atl-clay);color:var(--atl-paper);font-size:12px;white-space:nowrap;padding:8px 18px;">`
    },
    // L13798 Mini calendar event dot
    {
        search: `width: 4px; height: 4px; border-radius: 50%; background: #D4AF37; }`,
        replace: `width: 4px; height: 4px; border-radius: 50%; background: var(--atl-amber); }`
    },
    // L14161
    {
        search: `color:#17a2b8;font-size:12px;text-decoration:underline;`,
        replace: `color:var(--atl-blue);font-size:12px;text-decoration:underline;`
    },
    // L3518, L3646
    { search: `border-left: 3px solid #D4AF37;`, replace: `border-left: 3px solid var(--atl-amber);` },
    { search: `background: #D4AF37;`, replace: `background: var(--atl-amber);` }
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
        details.push(`- Skip: Target not found "${rep.search.substring(0, 50)}..."`);
    }
});

fs.writeFileSync(adminPath, content, 'utf8');
console.log(`Refactoring finished! Replaced ${replacedCount} elements.`);
console.log(details.join('\n'));
