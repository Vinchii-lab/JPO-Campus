import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const context = { window: {} };
vm.runInNewContext(fs.readFileSync(new URL('../../public/neighborhood-ui.js', import.meta.url), 'utf8'), context);
const ui = context.window.JpoUIBuilder;
let bought = [];
let renders = 0;
const ctx = {
  cashier: { name: 'Cashier' },
  cashierMenu: { items: [{ id: 'chair', name: 'Oak chair', price: 5000 }] },
  onBuy: (...args) => bought.push(args),
};
const buttons = () => ({
  '[data-confirm-purchase]': {},
  '[data-cancel-purchase]': { focus() {} },
});
const panel = { hidden: false, innerHTML: '', elements: buttons(),
  querySelector(selector) { return this.elements[selector] || null; } };
ui.renderShopPanel = () => { renders++; panel.elements = {}; };
ui._confirmShopPurchase(panel, ctx, 'chair', 'furniture');
assert.match(panel.innerHTML, /Oak chair/);
assert.match(panel.innerHTML, /5,000 coins/);
assert.equal(bought.length, 0, 'opening confirmation cannot purchase');
panel.elements['[data-cancel-purchase]'].onclick();
assert.equal(bought.length, 0, 'Cancel cannot purchase');
panel.elements = buttons();
ui._confirmShopPurchase(panel, ctx, 'chair', 'furniture');
const confirm = panel.elements['[data-confirm-purchase]'].onclick;
confirm(); confirm();
assert.deepEqual(bought, [['chair', 'furniture']], 'confirmation submits once');
panel.elements = buttons();
ui._confirmShopPurchase(panel, ctx, 'chair', 'furniture');
panel.hidden = true;
panel.elements['[data-confirm-purchase]'].onclick();
assert.equal(bought.length, 1, 'closed cashier cannot submit stale confirmation');
assert.equal(renders, 2);
console.log('PASS: in-game purchase confirmation, Cancel, exact item/price, single submit, and close guard');