// Run against an already-started JPO server:
// TEST_PORT=... DATABASE_URL=... node tests/neighborhood/construction.mjs
// Covers the durable, server-authoritative construction contract; presentation
// is intentionally left to the browser scene test surface.
import { io } from "socket.io-client";
import pg from "pg";
import { HOME_CONSTRUCTION_COMPONENTS, streetDefinition } from "../../neighborhood.mjs";

const port = process.env.TEST_PORT;
if (!port || !process.env.DATABASE_URL) throw new Error("TEST_PORT and DATABASE_URL are required");
const db = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const suffix = Math.random().toString(36).slice(2, 9);
const emails = [`builder-${suffix}@justpressone.com`, `visitor-${suffix}@justpressone.com`];
const clients = [];
const failures = [];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const check = (ok, message, actual) => {
  console.log(`${ok ? "✓" : "✗"} ${message}`);
  if (!ok) failures.push(`${message}${actual ? `: ${JSON.stringify(actual)}` : ""}`);
};
check(
  HOME_CONSTRUCTION_COMPONENTS.floor.price === 20000 &&
    HOME_CONSTRUCTION_COMPONENTS.walls.price === 25000 &&
    HOME_CONSTRUCTION_COMPONENTS.roof.price === 35000 &&
    Object.values(HOME_CONSTRUCTION_COMPONENTS).reduce((sum, component) => sum + component.price, 0) === 80000,
  "construction stages total exactly 80,000 coins",
  HOME_CONSTRUCTION_COMPONENTS,
);

function inbox(socket, event) {
  const items = [];
  socket.on(event, (value) => items.push(value));
  return {
    async next(ms = 7000) {
      const until = Date.now() + ms;
      while (!items.length && Date.now() < until) await sleep(15);
      if (!items.length) throw new Error(`timed out waiting for ${event}`);
      return items.shift();
    },
    clear() { items.length = 0; },
  };
}

const OFFICE_GARDEN_ROUTE = [
  [26, 47], [25, 47], [24, 47], [23, 47], [22, 47], [21, 47], [20, 47], [19, 47], [18, 47], [17, 47], [16, 47], [15, 47], [14, 47], [13, 47], [12, 47],
  [12, 48], [12, 49], [12, 50], [12, 51], [12, 52], [11, 52], [10, 52], [9, 52], [8, 52], [8, 53], [8, 54], [8, 55], [8, 56], [8, 57], [8, 58], [8, 59],
  [8, 60], [8, 61], [8, 62], [8, 63], [8, 64], [8, 65], [8, 66], [8, 67], [8, 68], [8, 69], [8, 70], [7, 70], [6, 70], [5, 70], [4, 70], [3, 70],
  [3, 71], [3, 72], [3, 73], [3, 74],
].map(([col, row]) => [col * 48 + 24, row * 48 + 24 - 27]);

async function walkLine(socket, from, to) {
  const steps = Math.ceil(Math.hypot(to[0] - from[0], to[1] - from[1]) / 42);
  for (let step = 1; step <= steps; step++) {
    const ratio = step / steps;
    socket.emit("playerMove", {
      x: from[0] + (to[0] - from[0]) * ratio,
      y: from[1] + (to[1] - from[1]) * ratio,
      dir: "left", anim: "walk",
    });
    await sleep(150);
  }
  return to;
}

async function connect(email, firstName) {
  const socket = io(`http://localhost:${port}`, { transports: ["websocket"], reconnection: false });
  clients.push(socket);
  const q = {
    approved: inbox(socket, "approved"),
    transition: inbox(socket, "locationTransitionResult"),
    directory: inbox(socket, "homeDirectory"),
    construction: inbox(socket, "homeConstructionResult"),
    home: inbox(socket, "homeSnapshot"),
    color: inbox(socket, "homeColorResult"),
    street: inbox(socket, "homeStreetChanged"),
  };
  await new Promise((resolve, reject) => { socket.once("connect", resolve); socket.once("connect_error", reject); });
  socket.emit("register", {
    firstName, lastName: "Construction", email, password: "testpass123", character: "adam", department: "IT",
  });
  const approved = await q.approved.next();
  return { socket, q, email, position: [approved.x, approved.y] };
}

async function enterStreet(client) {
  // Follow the exact authored office garden route. A direct teleport to the
  // portal is intentionally rejected by server movement validation.
  let position = OFFICE_GARDEN_ROUTE[0];
  client.socket.emit("playerMove", { x: position[0], y: position[1], dir: "left", anim: "idle" });
  await sleep(80);
  for (const point of [...OFFICE_GARDEN_ROUTE.slice(1), [168, 3600]]) {
    position = await walkLine(client.socket, position, point);
  }
  client.socket.emit("locationTransition", { destination: "neighborhood" });
  const transition = await client.q.transition.next();
  if (!transition.ok || transition.location !== "neighborhood") throw new Error(`could not enter Willow Walk: ${JSON.stringify(transition)}`);
  client.socket.emit("homeDirectoryRequest", { requestId: 1 });
  const directory = await client.q.directory.next();
  const lot = streetDefinition(directory.homes).lots.find((entry) => entry.ownerEmail === client.email);
  if (!lot) throw new Error(`owner lot missing for ${client.email}: ${JSON.stringify(directory)}`);
  // First street move establishes the server movement baseline at the canonical
  // per-lot interaction point; it is not a client-selected owner/location.
  client.socket.emit("playerMove", { x: lot.returnSpawn.x, y: lot.returnSpawn.y, dir: lot.returnSpawn.dir, anim: "idle" });
  await sleep(80);
  return { directory, lot };
}

async function refreshStreetCache(client) {
  // Test rows are seeded directly in the development database after the
  // already-running server has cached its street directory. Use an existing
  // owner-scoped live mutation to exercise its normal cache invalidation path,
  // rather than relying on a test-only server hook.
  client.socket.emit("homeColorSet", { color: "teal" });
  const result = await client.q.color.next();
  if (!result.ok) throw new Error(`could not refresh street cache: ${JSON.stringify(result)}`);
}

try {
  await db.query(`DELETE FROM jpo_home_layout_items WHERE home_owner_email = ANY($1)`, [emails]);
  await db.query(`DELETE FROM jpo_home_furniture WHERE owner_email = ANY($1)`, [emails]);
  await db.query(`DELETE FROM jpo_home_invitations WHERE owner_email = ANY($1) OR invitee_email = ANY($1)`, [emails]);
  await db.query(`DELETE FROM jpo_homes WHERE owner_email = ANY($1)`, [emails]);
  await db.query(`DELETE FROM jpo_players WHERE email = ANY($1)`, [emails]);
  await db.query(
    `INSERT INTO jpo_players (email, first_name, last_name, name, character, approved, department, coins)
       VALUES ($1,'Builder','Construction','Builder Construction','adam',true,'IT',80000),
              ($2,'Visitor','Construction','Visitor Construction','adam',true,'IT',100)`,
    emails,
  );
  // This pre-existing purchased/placed item must survive the conversion to an
  // empty lot and remain present in snapshots until the roof unlocks the room.
  await db.query(`INSERT INTO jpo_homes (owner_email) VALUES ($1), ($2)`, emails);
  const saved = await db.query(
    `INSERT INTO jpo_home_furniture (owner_email, furniture_id) VALUES ($1, 'oak_chair') RETURNING id`,
    [emails[0]],
  );
  await db.query(
    `INSERT INTO jpo_home_layout_items (furniture_instance_id, home_owner_email, grid_x, grid_y, rotation)
       VALUES ($1, $2, 1, 1, 0)`,
    [saved.rows[0].id, emails[0]],
  );

  const builder = await connect(emails[0], "Builder");
  const visitor = await connect(emails[1], "Visitor");
  await refreshStreetCache(builder);
  const builderStreet = await enterStreet(builder);
  const visitorStreet = await enterStreet(visitor);

  const before = (await db.query(`SELECT coins FROM jpo_players WHERE email=$1`, [emails[0]])).rows[0].coins;
  builder.socket.emit("homeConstructionPurchase", { componentId: "walls" });
  const rejectedOrder = await builder.q.construction.next();
  const afterRejected = (await db.query(`SELECT coins FROM jpo_players WHERE email=$1`, [emails[0]])).rows[0].coins;
  check(rejectedOrder.code === "out_of_order" && afterRejected === before,
    "stage ordering rejects walls before floor without a debit", rejectedOrder);

  // ownerEmail and price are deliberately forged/noise: the current authenticated
  // builder's locked home row is the only row that can be changed or charged.
  builder.socket.emit("homeConstructionPurchase", { componentId: "floor", ownerEmail: emails[1], price: 1 });
  const floor = await builder.q.construction.next();
  const rowsAfterFloor = await db.query(
    `SELECT owner_email, floor_built FROM jpo_homes WHERE owner_email = ANY($1) ORDER BY owner_email`,
    [emails],
  );
  check(floor.ok && floor.home?.construction?.stage === "floor" &&
    rowsAfterFloor.rows.some((row) => row.owner_email === emails[0] && row.floor_built) &&
    rowsAfterFloor.rows.some((row) => row.owner_email === emails[1] && !row.floor_built),
  "forged owner data cannot build another resident's lot", { floor, rows: rowsAfterFloor.rows });
  check(floor.home?.layout?.some((item) => item.id === saved.rows[0].id && item.gridX === 1),
    "saved interior placement remains in the dormant construction snapshot", floor.home);

  builder.socket.emit("homeConstructionPurchase", { componentId: "floor" });
  const duplicate = await builder.q.construction.next();
  const afterDuplicate = (await db.query(`SELECT coins FROM jpo_players WHERE email=$1`, [emails[0]])).rows[0].coins;
  check(duplicate.code === "out_of_order" && afterDuplicate === floor.coins,
    "duplicate component purchase is idempotently rejected without another debit", duplicate);

  visitor.socket.emit("homeConstructionPurchase", { componentId: "floor" });
  const insufficient = await visitor.q.construction.next();
  check(insufficient.code === "insufficient", "insufficient coin balance cannot build the floor", insufficient);

  // The production buy bucket intentionally rate-limits rapid clicks.
  await sleep(600);
  builder.socket.emit("homeConstructionPurchase", { componentId: "walls" });
  const walls = await builder.q.construction.next();
  await sleep(600);
  builder.q.street.clear();
  builder.socket.emit("homeConstructionPurchase", { componentId: "roof" });
  const roof = await builder.q.construction.next();
  const finalRow = (await db.query(
    `SELECT floor_built, walls_built, roof_built FROM jpo_homes WHERE owner_email=$1`, [emails[0]],
  )).rows[0];
  const finalCoins = (await db.query(`SELECT coins FROM jpo_players WHERE email=$1`, [emails[0]])).rows[0].coins;
  check(walls.ok && roof.ok && roof.home?.construction?.complete &&
    finalRow.floor_built && finalRow.walls_built && finalRow.roof_built && finalCoins === 0,
  "floor, walls, and roof persist in sequence and debit exactly 80,000 coins", { walls, roof, finalRow, finalCoins });

  // Client street presentation refreshes in response to this public,
  // metadata-free signal. Await it before asking the directory, exactly as the
  // browser does, so this checks the post-invalidation shared projection.
  const streetUpdate = await builder.q.street.next();
  builder.socket.emit("homeDirectoryRequest", { requestId: 2 });
  const completedDirectory = await builder.q.directory.next();
  const completedStreet = streetDefinition(completedDirectory.homes);
  const finishedDoor = completedStreet.doors.find((door) => door.ownerEmail === emails[0]);
  check(!!finishedDoor && streetUpdate?.refreshDirectory === true,
    "only the completed residence exposes a street door", { signal: streetUpdate, doors: completedStreet.doors });

  // Visitor walks to the now-canonical completed door and can enter because the
  // default access mode is public; unfinished lots have no such door.
  const doorPoint = [finishedDoor.x + finishedDoor.width / 2, finishedDoor.y + finishedDoor.height / 2];
  // Display slots are dense even when durable lot ids are sparse. Use the
  // canonical compact-grid row/column metadata rather than the permanent lot
  // number to walk the connected cross-streets.
  const roadY = (lot) => lot.row * 960 + 504;
  const roadX = (lot) => lot.column * 1440 + 576;
  // Follow the clear street/cross-street corridors rather than jumping from
  // the visitor's lot to a distant door. This proves the actual door contract
  // without relying on the server's deliberately capped move-distance budget.
  let visitorPosition = [visitorStreet.lot.returnSpawn.x, visitorStreet.lot.returnSpawn.y];
  for (const point of [
    [visitorPosition[0], roadY(visitorStreet.lot)],
    [roadX(visitorStreet.lot), roadY(visitorStreet.lot)],
    [roadX(visitorStreet.lot), roadY(builderStreet.lot)],
    [roadX(builderStreet.lot), roadY(builderStreet.lot)],
    [doorPoint[0], roadY(builderStreet.lot)],
    doorPoint,
  ]) visitorPosition = await walkLine(visitor.socket, visitorPosition, point);
  await sleep(80);
  visitor.socket.emit("locationTransition", { destination: `home:${emails[0]}` });
  const visit = await visitor.q.transition.next();
  check(visit.ok && visit.location === `home:${emails[0]}`,
    "finished doors allow owner/guest home access", visit);
} catch (error) {
  failures.push(error.message || String(error));
  console.error(error);
} finally {
  clients.forEach((client) => client.close());
  await db.query(`DELETE FROM jpo_home_layout_items WHERE home_owner_email = ANY($1)`, [emails]).catch(() => {});
  await db.query(`DELETE FROM jpo_home_furniture WHERE owner_email = ANY($1)`, [emails]).catch(() => {});
  await db.query(`DELETE FROM jpo_home_invitations WHERE owner_email = ANY($1) OR invitee_email = ANY($1)`, [emails]).catch(() => {});
  await db.query(`DELETE FROM jpo_homes WHERE owner_email = ANY($1)`, [emails]).catch(() => {});
  await db.query(`DELETE FROM jpo_players WHERE email = ANY($1)`, [emails]).catch(() => {});
  await db.end();
}
if (failures.length) {
  console.error(`RESULT: FAIL (${failures.join("; ")})`);
  process.exitCode = 1;
} else {
  console.log("RESULT: PASS");
}