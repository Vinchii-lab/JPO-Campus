// Focused cashier contracts. The handlers are evaluated in small, explicit
// fixtures so room/proximity gates and the existing atomic debit path can be
// checked without starting the app or connecting to a database.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../../server.js'), 'utf8');
const menuStart = source.indexOf('  socket.on("cashierMenuRequest",');
const menuEnd = source.indexOf('  socket.on("homePurchase",', menuStart);
assert(menuStart >= 0 && menuEnd > menuStart, 'cashier menu handler remains bounded');
const foodStart = source.indexOf('  socket.on("buyFood",');
const foodEnd = source.indexOf('  socket.on("equipCosmetic",', foodStart);
assert(foodStart >= 0 && foodEnd > foodStart, 'food purchase handler remains bounded');

const CASHIERS = {
  'cashier:furniture-shop': { locationId: 'furniture-shop', x: 480, y: 340, radius: 116, kind: 'furniture' },
  'cashier:cafe': { locationId: 'cafe', x: 760, y: 180, radius: 116, kind: 'food', menuKey: 'cafe' },
};

function cashierCheck(player, location, id) {
  const cashier = CASHIERS[id];
  if (!cashier || location !== cashier.locationId) {
    return { ok: false, code: 'cashier', message: 'That cashier is not available here.' };
  }
  if (Math.hypot(player.x - cashier.x, player.y - cashier.y) > cashier.radius) {
    return { ok: false, code: 'distance', message: 'Walk closer.' };
  }
  return { ok: true, locationId: location, cashier: { id, ...cashier } };
}

async function openMenu({ location = 'cafe', cashierId = 'cashier:cafe', x = 760, y = 180 } = {}) {
  const events = [];
  let handler;
  const player = { x, y };
  const context = {
    socket: {
      id: 'cashier-fixture',
      on(_name, fn) { handler = fn; },
      emit(name, data) { events.push({ name, data }); },
    },
    players: { 'cashier-fixture': player },
    locationOf: () => location,
    validateCommercialCashier: (candidate, id) => cashierCheck(candidate, location, id),
    cashierMenu: () => ({
      kind: 'food', title: 'Cafe Counter',
      items: [{ id: 'espresso', name: 'Espresso', icon: '☕', price: 5 }],
    }),
  };
  vm.runInNewContext(source.slice(menuStart, menuEnd), context);
  await handler({ cashierId });
  return events;
}

async function buyFood({
  location = 'cafe', cashierId = 'cashier:cafe', station = cashierId,
  item = 'espresso', x = 760, y = 180, startingCoins = 200,
} = {}) {
  const events = [], queries = [];
  let handler, connections = 0;
  const player = { email: 'food-fixture@example.com', coins: startingCoins, x, y };
  const context = {
    socket: {
      id: 'food-fixture',
      on(_name, fn) { handler = fn; },
      emit(name, data) { events.push({ name, data }); },
    },
    players: { 'food-fixture': player },
    locationOf: () => location,
    validateCommercialCashier: (candidate, id) => cashierCheck(candidate, location, id),
    FOOD_STATIONS: { fridge: 'drinks' },
    FOOD_MENUS: {
      cafe: { items: [{ id: 'espresso', name: 'Espresso', icon: '☕', price: 5 }] },
      drinks: { items: [{ id: 'soda', name: 'Fizzy soda', icon: '🥤', price: 4 }] },
    },
    OBJECTS: { fridge: { x: 5592, y: 4008, r: 190 } },
    buyBucket: {},
    takeToken: () => true,
    inAnyMatch: () => false,
    inActiveRound: () => false,
    feedPetTreat: async () => { throw new Error('unexpected pet treat path'); },
    pool: {
      async query(sql) {
        queries.push(sql);
        return sql.includes('UPDATE jpo_players') ? { rows: [{ coins: startingCoins - (item === 'soda' ? 4 : 5) }] } : { rows: [] };
      },
    },
    emitToLocation() {},
    coachCoffeeMoment() {},
    console: { log() {}, error() {} },
  };
  vm.runInNewContext(source.slice(foodStart, foodEnd), context);
  await handler({ cashierId, station, item });
  return { events, queries, connections, player };
}

(async () => {
  const opened = await openMenu();
  assert.equal(opened[0].name, 'cashierMenuResult');
  assert.equal(opened[0].data.ok, true, 'an in-range cashier opens the server menu');

  const outOfRange = await openMenu({ x: 760 + 117 });
  assert.equal(outOfRange[0].data.ok, false);
  assert.equal(outOfRange[0].data.code, 'distance', 'out-of-range menu open is rejected');

  const wrongMap = await openMenu({ location: 'diner' });
  assert.equal(wrongMap[0].data.ok, false);
  assert.equal(wrongMap[0].data.code, 'cashier', 'a cafe cashier id cannot open a diner menu');

  const unauthorizedFood = await buyFood({ cashierId: '', station: 'cashier:cafe' });
  assert.equal(unauthorizedFood.queries.length, 0, 'food without a cashier never reaches debit');
  assert.equal(unauthorizedFood.events.length, 0, 'unknown cashier station is not purchasable');

  const farFood = await buyFood({ x: 760 + 117 });
  assert.equal(farFood.queries.length, 0, 'out-of-range food never reaches debit');
  assert.equal(farFood.events[0].data.code, 'distance');

  const wrongFoodMap = await buyFood({ location: 'diner' });
  assert.equal(wrongFoodMap.queries.length, 0, 'wrong-map food never reaches debit');
  assert.equal(wrongFoodMap.events[0].data.code, 'cashier');

  const food = await buyFood();
  assert.equal(food.queries.filter((sql) => sql.includes('UPDATE jpo_players')).length, 1,
    'authorized food uses one conditional debit');
  assert.equal(food.events.find((event) => event.name === 'foodBought').data.price, 5);
  assert.equal(food.player.coins, 195);

  const officeFood = await buyFood({
    location: 'office', cashierId: '', station: 'fridge', item: 'soda',
    x: 5592, y: 4008,
  });
  assert.equal(officeFood.queries.filter((sql) => sql.includes('UPDATE jpo_players')).length, 1,
    'the established office station path remains atomic');
  assert.equal(officeFood.events.find((event) => event.name === 'foodBought').data.station, 'fridge');

  console.log('PASS: cashier menu room/range guards and food debit compatibility');
})().catch((error) => { console.error(error); process.exitCode = 1; });