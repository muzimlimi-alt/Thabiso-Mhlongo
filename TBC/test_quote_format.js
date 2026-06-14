const it1 = { pricing_model: 'flat', quantity: 1, unit_price: 3800, description: 'Technical Rider & Sound Package' };
const it2 = { pricing_model: 'per_minute', quantity_minutes: 30, unit_price: 250, description: 'Stand-Up Comedy Set (30 min)' };
const it3 = { pricing_model: 'flat_fee', quantity: 2, unit_price: 2500, description: 'Travel Buyout (Gauteng)' };
const it4 = { pricing_model: 'per_hour', quantity: 2, unit_price: 2950, description: 'MC & Host' };

const items = [it1, it2, it3, it4];

let itemsHtml = '';
let subtotal = 0;
items.forEach(it => {
    const qty = parseFloat(it.quantity_minutes) || parseFloat(it.quantity) || 0;
    const p = parseFloat(it.unit_price) || 0;
    const model = it.pricing_model || 'flat';
    const total = (qty === 0 && (model === 'flat' || model === 'flat_fee')) ? p : (qty * p);
    const desc = it.description || it.service_name || it.name;
    subtotal += total;
    
    let qtyStr = '';
    if (model === 'per_minute') {
        qtyStr = `${qty} min × R ${p.toFixed(2)}`;
    } else if (model === 'per_hour') {
        qtyStr = `${qty} hr × R ${p.toFixed(2)}`;
    } else if (model === 'flat' || model === 'flat_fee') {
        qtyStr = qty > 1 ? `${qty} × R ${p.toFixed(2)}` : 'Flat Fee';
    } else {
        qtyStr = `${qty} × R ${p.toFixed(2)}`;
    }
    
    itemsHtml += `<tr>
        <td>${desc}</td>
        <td>${qtyStr}</td>
        <td>R ${total.toFixed(2)}</td>
    </tr>\n`;
});

console.log(itemsHtml);
console.log('Subtotal: R', subtotal.toFixed(2));
