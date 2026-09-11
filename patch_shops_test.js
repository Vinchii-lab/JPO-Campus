const fs = require('fs');
let content = fs.readFileSync('artifacts/jpo-huddle/tests/neighborhood/shops.mjs', 'utf8');

const newVenuesCode = `
const venueIds = ["cafe", "diner", "bakery", "sushi"];
for (const venueId of venueIds) {
  const entry = LOCATION_PORTALS.city.find((portal) => portal.destination === venueId);
  assert.ok(entry, \`\${venueId} has a city entrance\`);
  const entryPoint = {
    x: entry.x + entry.width / 2,
    y: entry.y + entry.height / 2,
  };
  assert.ok(validLocationMove(city, entryPoint.x, entryPoint.y), \`\${venueId} entry clears city blockers\`);
  assert.ok(
    portalForTransition("city", venueId, entryPoint.x, entryPoint.y, "tester@example.com"),
    \`\${venueId} entry accepts an actor-foot point\`,
  );

  const room = parseLocation(venueId);
  assert.equal(room.id, venueId);
  const exit = LOCATION_PORTALS[venueId][0];
  assert.equal(exit.destination, "city", \`\${venueId} exit goes to city\`);
  const exitPoint = {
    x: exit.x + exit.width / 2,
    y: exit.y + exit.height / 2,
  };
  assert.ok(validLocationMove(room, exitPoint.x, exitPoint.y), \`\${venueId} exit clears room blockers\`);
  assert.ok(portalForTransition(venueId, "city", exitPoint.x, exitPoint.y, "tester@example.com"),
    \`\${venueId} exit accepts an actor-foot point\`);
  assert.equal(LOCATION_GEOMETRY[venueId].doors[0].destination, "city");
}
`;

content = content.replace(
  'assert.equal(shopIds.length, 3, "the plaza has one home shop and two themed shops");',
  'assert.equal(shopIds.length, 3, "the plaza has one home shop and two themed shops");\n' + newVenuesCode
);

content = content.replace(
  /\{ x: 456, y: 0, width: 240, height: 912 \},/,
  '{ x: 456, y: 0, width: 240, height: 1600 },'
);

content = content.replace(
  /console\.log\(`✓ \$\{shopIds\.length\} enterable shops, filtered catalogs, and off-road benches`\);/,
  'console.log(`✓ ${shopIds.length} enterable shops, 4 new venues, filtered catalogs, and off-road benches`);'
);

fs.writeFileSync('artifacts/jpo-huddle/tests/neighborhood/shops.mjs', content);
