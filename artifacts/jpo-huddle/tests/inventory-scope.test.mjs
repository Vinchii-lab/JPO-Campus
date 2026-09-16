import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const source = await readFile(new URL('../public/inventory-scope.js', import.meta.url), 'utf8');
const sandbox = { window: {} };
vm.runInNewContext(source, sandbox, { filename: 'inventory-scope.js' });
const scope = sandbox.window.JpoInventoryScope;

test('keeps the complete original inventory category set in JPO HQ', () => {
  assert.equal(scope.scopeForLocation('office'), 'hq');
  assert.deepEqual([...scope.categoriesForScope('hq')], ['all', 'wearables', 'pets', 'usables', 'furniture']);
  assert.equal(scope.normalizeCategory('pets', 'hq'), 'pets');
});

test('uses furniture-only inventory on Willow Walk, Plaza, homes, and yards', () => {
  for (const location of ['neighborhood', 'city', 'home:owner@justpressone.com', 'furniture-shop']) {
    assert.equal(scope.scopeForLocation(location), 'neighborhood', location);
    assert.deepEqual([...scope.categoriesForScope(scope.scopeForLocation(location))], ['furniture'], location);
  }
});

test('map transitions clear an HQ-only selected category without changing HQ ownership scope', () => {
  let selected = 'pets';
  for (const location of ['city', 'home:owner@justpressone.com', 'neighborhood']) {
    selected = scope.normalizeCategory(selected, scope.scopeForLocation(location));
    assert.equal(selected, 'furniture', location);
  }
  assert.equal(scope.normalizeCategory('furniture', scope.scopeForLocation('office')), 'furniture');
  assert.equal(scope.normalizeCategory('pets', scope.scopeForLocation('office')), 'pets');
});