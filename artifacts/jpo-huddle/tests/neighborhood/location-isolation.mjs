// Run against an already started test server:
// TEST_PORT=... DATABASE_URL=... node tests/neighborhood/location-isolation.mjs
// This intentionally uses real Socket.IO clients; it covers the room boundary
// rather than re-testing client presentation.
import { io } from "socket.io-client";
import pg from "pg";
import { FURNITURE_CATALOG, LOCATION_PORTALS, effectiveRotation, furnitureFootprint, layoutBlockers, parseLocation, portalForTransition, validLocationMove } from "../../neighborhood.mjs";

const port = process.env.TEST_PORT;
if (!port || !process.env.DATABASE_URL) {
  console.error("TEST_PORT and DATABASE_URL are required");
  process.exit(1);
}
const db = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const suffix = Math.random().toString(36).slice(2, 9);
const emails = ["a", "b", "c"].map((x) => `neighborhood-${x}-${suffix}@justpressone.com`);
const url = `http://localhost:${port}`;
const clients = [];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const failures = [];
const check = (ok, message, actual = undefined) => {
  console.log(`${ok ? "✓" : "✗"} ${message}${ok || actual === undefined ? "" : `\n  actual: ${JSON.stringify(actual)}`}`);
  if (!ok) failures.push(`${message}${actual === undefined ? "" : ` (${JSON.stringify(actual)})`}`);
};

function inbox(socket, name) {
  const messages = [];
  socket.on(name, (message) => messages.push(message));
  return {
    async next(ms = 7000) {
      const start = Date.now();
      while (!messages.length && Date.now() - start < ms) await sleep(20);
      if (!messages.length) throw new Error(`timed out waiting for ${name}`);
      return messages.shift();
    },
    async collect(ms = 500) { await sleep(ms); const out = messages.splice(0); return out; },
    clear() { messages.length = 0; },
  };
}
async function connect(email, first) {
  const socket = io(url, { transports: ["websocket"], reconnection: false });
  clients.push(socket);
  const q = {
    approved: inbox(socket, "approved"), transition: inbox(socket, "locationTransitionResult"),
    joined: inbox(socket, "playerJoined"), moved: inbox(socket, "playerMoved"),
    chat: inbox(socket, "chatMessage"), voice: inbox(socket, "voiceSignal"), correction: inbox(socket, "playerMoveCorrection"),
    home: inbox(socket, "homeSnapshot"), buy: inbox(socket, "homePurchaseResult"),
    action: inbox(socket, "homeActionResult"), invite: inbox(socket, "homeInviteResult"), access: inbox(socket, "homeAccessResult"),
    directory: inbox(socket, "homeDirectory"), color: inbox(socket, "homeColorResult"),
    colorChanged: inbox(socket, "homeColorChanged"),
  };
  await new Promise((resolve, reject) => { socket.once("connect", resolve); socket.once("connect_error", reject); });
  socket.emit("register", { firstName: first, lastName: "Neighborhood", email, password: "testpass123", character: "adam", department: "IT" });
  const approved = await q.approved.next();
  return {
    socket, q, email, location: "office",
    position: [Number.isFinite(approved?.x) ? approved.x : 1272, Number.isFinite(approved?.y) ? approved.y : 2253],
  };
}

const OFFICE_GARDEN_ROUTE = [
  [26, 47], [25, 47], [24, 47], [23, 47], [22, 47], [21, 47], [20, 47], [19, 47], [18, 47], [17, 47], [16, 47], [15, 47], [14, 47], [13, 47], [12, 47],
  [12, 48], [12, 49], [12, 50], [12, 51], [12, 52], [11, 52], [10, 52], [9, 52], [8, 52], [8, 53], [8, 54], [8, 55], [8, 56], [8, 57], [8, 58], [8, 59],
  [8, 60], [8, 61], [8, 62], [8, 63], [8, 64], [8, 65], [8, 66], [8, 67], [8, 68], [8, 69], [8, 70], [7, 70], [6, 70], [5, 70], [4, 70], [3, 70],
  [3, 71], [3, 72], [3, 73], [3, 74],
].map(([col, row]) => [col * 48 + 24, row * 48 + 24 - 27]);

async function walkLine(client, from, to) {
  const distance = Math.hypot(to[0] - from[0], to[1] - from[1]);
  const steps = Math.ceil(distance / 42);
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    client.socket.emit("playerMove", { x: from[0] + (to[0] - from[0]) * t, y: from[1] + (to[1] - from[1]) * t, dir: "left", anim: "walk" });
    await sleep(150); // 42px/150ms stays below the authoritative 195px/s budget with tolerance.
  }
  return to;
}

async function walkRoute(client, points) {
  let at = points[0];
  // First packet establishes a baseline at the server's known spawn.
  client.socket.emit("playerMove", { x: at[0], y: at[1], dir: "left", anim: "idle" });
  await sleep(80);
  for (const point of points.slice(1)) at = await walkLine(client, at, point);
  return at;
}

function routeToPortal(location, destination, position, residenceLot = 1) {
  if (location === "office" && destination === "neighborhood")
    return [position, ...OFFICE_GARDEN_ROUTE.slice(1), [168, 3600]];
  if (location === "neighborhood" && destination === "city")
    return position[0] > 1000 ? [position, [1392, 504]] : [position, [720, 528], [1392, 528], [1392, 504]];
  if (location === "neighborhood" && destination.startsWith("home:"))
    return [position, [720, 528], [636, 528], [636, 350], [636, 293]];
  if (location === "city" && destination === "neighborhood")
    return position[0] > 500 ? [position, [852, 400], [700, 400], [432, 400], [432, 550], [48, 550], [48, 504]] : [position, [48, 504]];
  if (location === "city" && destination === "furniture-shop")
    return position[0] > 500
      ? [position, [852, 400], [700, 400], [432, 400], [432, 550], [700, 550], [700, 400], [852, 400], [852, 286], [872, 286]]
      : [position, [432, 550], [700, 550], [700, 400], [852, 400], [852, 286], [872, 286]];
  if (location === "city" && destination === "maple-row")
    return [position, [432, 550], [1100, 550], [1100, 504]];
  if (location === "maple-row" && destination === "city")
    return [position, [48, 504]];
  if (location === "maple-row" && destination.startsWith("home:")) {
    const door = LOCATION_PORTALS["maple-row"].find((portal) => portal.residence && portal.lot === residenceLot);
    if (!door) throw new Error(`No Maple Row door for residence ${residenceLot}`);
    const center = [door.x + door.width / 2, door.y + door.height / 2];
    return [position, [center[0], 504], center];
  }
  if (location === "city" && destination === "juniper-square")
    return [position, [1056, 550], [432, 550], [432, 864], [576, 864]];
  if (location === "juniper-square" && destination === "city")
    return [position, [576, 48]];
  if (location === "furniture-shop" && destination === "city")
    return [position, [480, 684]];
  if (location.startsWith("home:") && destination === "neighborhood")
    return [position, [288, 402]];
  throw new Error(`No authored route from ${location} to ${destination}`);
}

async function findResidenceSlot(client, ownerEmail) {
  client.q.directory.clear();
  for (let page = 0; page < 10_000; page++) {
    client.socket.emit("homeDirectoryRequest", { page });
    const listing = await client.q.directory.next();
    const lot = listing.homes?.findIndex((home) => home.ownerEmail === ownerEmail) ?? -1;
    if (lot >= 0) return { page: listing.page, lot: lot + 1 };
    if (page >= (listing.pageCount || 1) - 1) break;
  }
  throw new Error(`No visible directory slot for ${ownerEmail}`);
}

async function moveTo(client, destination, { expectOk = true } = {}) {
  // Homes are reached only through their real addresses: the owner uses
  // Willow Walk and guests use a numbered directory residence. City never
  // mirrors the authenticated player's home.
  if (client.location === "city" && destination.startsWith("home:")) {
    if (destination.slice(5).toLowerCase() === client.email) await moveTo(client, "neighborhood");
    else {
      client.residenceSlot = await findResidenceSlot(client, destination.slice(5).toLowerCase());
      await moveTo(client, "maple-row");
    }
  }
  if (client.location.startsWith("home:") && destination === "city") {
    await moveTo(client, "neighborhood");
  }
  const route = routeToPortal(client.location, destination, client.position, client.residenceSlot?.lot);
  await walkRoute(client, route);
  client.socket.emit("locationTransition", {
    destination,
    ...(client.location === "maple-row" && destination.startsWith("home:")
      ? { residencePage: client.residenceSlot?.page || 0 }
      : {}),
  });
  const result = await client.q.transition.next();
  check(result.ok === expectOk && (!expectOk || result.location === destination), `${expectOk ? "walk portal accepted" : "blocked doorway"}: ${destination}`, result);
  if (result.ok) {
    client.location = result.location;
    client.position = [result.spawn.x, result.spawn.y];
    if (result.location.startsWith("home:")) delete client.residenceSlot;
  } else client.position = route.at(-1);
  return result;
}
async function setAccess(client, mode) {
  client.socket.emit("homeAccessSet", { mode });
  const result = await client.q.access.next();
  check(result.ok && result.mode === mode, `home access saved: ${mode}`, result);
  return result;
}

try {
  const canonical = parseLocation("home:Case.Owner@JustPressOne.COM");
  check(canonical?.id === "home:case.owner@justpressone.com" && canonical.ownerEmail === "case.owner@justpressone.com",
    "case-variant home targets canonicalize to one room id");
  check(!validLocationMove(parseLocation("city"), 200, 200) &&
    validLocationMove(parseLocation("city"), 480, 720),
  "city facade blockers reject clipping but preserve plaza spawn");
  check(
    !LOCATION_PORTALS.city.some((portal) => portal.destination === "home") &&
      !portalForTransition("city", `home:${emails[0]}`, 290, 300, emails[0]) &&
      !validLocationMove(parseLocation("city"), 290, 300),
    "city has a closed market facade, never a mirrored personal-home entrance",
  );
  const testHome = parseLocation("home:test@example.com");
  const homeExitTrajectory = [360, 372, 384, 402, 416];
  check(
    homeExitTrajectory.every((y) => validLocationMove(testHome, 288, y)) &&
      !!portalForTransition(testHome.id, "neighborhood", 288, 384, "test@example.com"),
    "home floor-mat exit remains walkable to its Willow Walk address",
    homeExitTrajectory,
  );
  const shopDoor = { x: 872, y: 286 };
  const shopExit = { x: 480, y: 684 };
  check(
    validLocationMove(parseLocation("city"), shopDoor.x, shopDoor.y) &&
      !!portalForTransition("city", "furniture-shop", shopDoor.x, shopDoor.y, emails[0]) &&
      validLocationMove(parseLocation("furniture-shop"), shopExit.x, shopExit.y) &&
      !!portalForTransition("furniture-shop", "city", shopExit.x, shopExit.y, emails[0]),
    "shop entry, catalog interior, and plaza exit share walkable portal geometry",
  );
  for (const block of ["maple-row", "juniper-square"]) {
    const residenceDoors = LOCATION_PORTALS[block].filter((portal) => portal.residence);
    check(
      residenceDoors.length === 8 && residenceDoors.every((door) =>
        door.label === `Residence ${door.lot}` &&
        validLocationMove(parseLocation(block), door.x + door.width / 2, door.y + door.height / 2) &&
        !!portalForTransition(block, `home:${emails[0]}`, door.x + door.width / 2, door.y + door.height / 2, emails[0])),
      `${block} has eight numbered, labelled, walkable residence entrances`,
    );
  }
  check(
    !!portalForTransition("maple-row", "home:other@justpressone.com", 180, 300, emails[1]) &&
      !portalForTransition("city", "home:other@justpressone.com", 290, 300, emails[1]) &&
    !portalForTransition("neighborhood", "home:other@justpressone.com", 636, 293, emails[1]),
    "a guest home is reachable only through a numbered directory residence doorway",
  );
  const chairBlocker = layoutBlockers([{ furnitureId: "oak_chair", gridX: 2, gridY: 2, rotation: 0 }]);
  check(!validLocationMove(parseLocation("home:test@example.com"), 120, 120, chairBlocker) &&
    validLocationMove(parseLocation("home:test@example.com"), 312, 360, chairBlocker),
  "home furniture collision blocks its tile but preserves door spawn");
  const legacyTable = { furnitureId: "coffee_table", gridX: 1, gridY: 1, rotation: 90 };
  const canonicalTable = furnitureFootprint(FURNITURE_CATALOG.coffee_table, effectiveRotation(FURNITURE_CATALOG.coffee_table, legacyTable.rotation));
  const legacyBlocker = layoutBlockers([legacyTable])[0];
  check(
    effectiveRotation(FURNITURE_CATALOG.coffee_table, legacyTable.rotation) === 0 &&
      canonicalTable.width === 2 && canonicalTable.height === 1 &&
      legacyBlocker.width === canonicalTable.width * 48 && legacyBlocker.height === canonicalTable.height * 48,
    "legacy 90° nonsquare furniture canonicalizes to the snapshot/client upright footprint",
    { canonicalTable, legacyBlocker },
  );
  // Never clean by a test-name prefix: another concurrent/aborted integration
  // run is not ours to delete.  Every cleanup query is restricted to this
  // process's exact generated email list.
  await db.query(`DELETE FROM jpo_home_layout_items WHERE home_owner_email = ANY($1)`, [emails]);
  await db.query(`DELETE FROM jpo_home_furniture WHERE owner_email = ANY($1)`, [emails]);
  await db.query(`DELETE FROM jpo_home_invitations WHERE owner_email = ANY($1) OR invitee_email = ANY($1)`, [emails]);
  await db.query(`DELETE FROM jpo_homes WHERE owner_email = ANY($1)`, [emails]);
  await db.query(`DELETE FROM jpo_players WHERE email = ANY($1)`, [emails]);
  await db.query(`INSERT INTO jpo_players (email, first_name,last_name,name,character,approved,department,coins)
                  SELECT e, 'Test','Neighborhood','Test Neighborhood','adam',true,'IT',1000 FROM unnest($1::text[]) e`, [emails]);
  const [a, b, c] = await Promise.all(emails.map((email, i) => connect(email, "ABC"[i])));

  // A and B walk through the office garden and Willow Walk into the city; C
  // remains in HQ. No lifecycle, movement, chat or
  // voice signal may cross this room boundary.
  await moveTo(a, "neighborhood"); await moveTo(a, "city");
  await moveTo(b, "neighborhood"); await moveTo(b, "city");
  await c.q.joined.collect(); c.q.moved.clear(); c.q.chat.clear(); c.q.voice.clear();
  a.socket.emit("playerMove", { x: 520, y: 700, dir: "right", anim: "walk" });
  // Socket.IO can still deliver an already-queued office movement frame after
  // the room switch. Assert specifically that no city-state frame from A leaks
  // to C, rather than treating historical office traffic as a cross-room leak.
  const leakedCityMoves = (await c.q.moved.collect()).filter((move) =>
    move.id === a.socket.id && move.locationId === "city");
  check(leakedCityMoves.length === 0, "office cannot see city movement", leakedCityMoves);
  a.socket.emit("chatMessage", { text: "city-only" });
  check((await c.q.chat.collect()).length === 0, "office cannot receive city chat");
  a.socket.emit("voiceSignal", { targetId: c.socket.id, data: { k: "offer", sdp: "cross-location" } });
  check((await c.q.voice.collect()).length === 0, "voice relay rejects cross-location peer");

  // A first visit creates the starter home. C walks through the same authored
  // office/neighborhood/plaza route, enters while public, then gets ejected
  // when the owner makes the home private.
  await moveTo(a, `home:${emails[0]}`);
  await setAccess(a, "public");
  const aHome = await a.q.home.next();
  check(aHome.canEdit && Array.isArray(aHome.inventory), "owner receives editable starter-home snapshot");
  a.socket.emit("homeDirectoryRequest");
  const directory = await a.q.directory.next();
  check(directory.homes?.some((h) => h.ownerEmail === emails[0] && h.name && h.accessMode),
    "home directory exposes only safe owner/name/access metadata", directory);

  // Exterior colors are free starter-home personalization. The requested owner
  // field is deliberately ignored: B may only update B's own home, never A's.
  // B is outdoors; C remains in the office, which also checks the safe
  // colorChanged room signal does not become an office-wide broadcast.
  a.q.color.clear(); b.q.color.clear(); a.q.home.clear();
  b.q.colorChanged.clear(); c.q.colorChanged.clear();
  const aColorBefore = (await db.query(`SELECT exterior_color FROM jpo_homes WHERE owner_email=$1`, [emails[0]])).rows[0]?.exterior_color;
  a.socket.emit("homeColorSet", { color: "chartreuse" });
  const rejectedColor = await a.q.color.next();
  check(!rejectedColor.ok && (await db.query(`SELECT exterior_color FROM jpo_homes WHERE owner_email=$1`, [emails[0]])).rows[0]?.exterior_color === aColorBefore,
    "unknown exterior color is rejected without persistence", rejectedColor);

  b.socket.emit("homeColorSet", { color: "plum", ownerEmail: emails[0] });
  const forgedOwnerResult = await b.q.color.next();
  const forgedOwnerRows = await db.query(
    `SELECT owner_email, exterior_color FROM jpo_homes WHERE owner_email = ANY($1) ORDER BY owner_email`,
    [[emails[0], emails[1]]],
  );
  check(
    forgedOwnerResult.ok && forgedOwnerResult.home?.ownerEmail === emails[1] &&
      forgedOwnerRows.rows.some((row) => row.owner_email === emails[0] && row.exterior_color === aColorBefore) &&
      forgedOwnerRows.rows.some((row) => row.owner_email === emails[1] && row.exterior_color === "plum"),
    "forged owner field cannot mutate another resident's home", { result: forgedOwnerResult, rows: forgedOwnerRows.rows },
  );

  b.q.colorChanged.clear(); c.q.colorChanged.clear();
  a.socket.emit("homeColorSet", { color: "terracotta" });
  const savedColor = await a.q.color.next();
  const colorSnapshot = await a.q.home.next();
  const persistedColor = (await db.query(`SELECT exterior_color FROM jpo_homes WHERE owner_email=$1`, [emails[0]])).rows[0]?.exterior_color;
  a.socket.emit("homeDirectoryRequest");
  const coloredDirectory = await a.q.directory.next();
  const bOutdoorSignal = await b.q.colorChanged.next().catch(() => null);
  const cOfficeSignals = await c.q.colorChanged.collect();
  check(
    savedColor.ok && savedColor.home?.exteriorColor === "terracotta" &&
      colorSnapshot.exteriorColor === "terracotta" && persistedColor === "terracotta" &&
      coloredDirectory.homes?.some((home) => home.ownerEmail === emails[0] && home.exteriorColor === "terracotta"),
    "owner exterior color persists and snapshots/directory use authoritative safe color",
    { result: savedColor, snapshot: colorSnapshot, persistedColor, directory: coloredDirectory },
  );
  check(
    bOutdoorSignal?.refreshDirectory === true && cOfficeSignals.length === 0,
    "color change signal is scoped to outdoor locations with no private metadata",
    { outdoor: bOutdoorSignal, office: cOfficeSignals },
  );

  await moveTo(c, "neighborhood"); await moveTo(c, "city"); await moveTo(c, `home:${emails[0]}`);
  const ejected = inbox(c.socket, "homeEjected");
  await setAccess(a, "private");
  const eject = await ejected.next().catch(() => null);
  check(!!eject, "private switch ejects existing visitor");

  // Purchase only works at the shop, produces an immutable inventory instance,
  // and placement returns a revisioned room snapshot.
  await moveTo(a, "city"); await moveTo(a, "furniture-shop");
  const beforePurchase = await db.query(`SELECT coins FROM jpo_players WHERE email=$1`, [emails[0]]);
  a.socket.emit("homePurchase", { furnitureId: "oak_chair" });
  const purchase = await a.q.buy.next();
  const afterPurchase = await db.query(`SELECT coins FROM jpo_players WHERE email=$1`, [emails[0]]);
  check(
    purchase.ok && purchase.item?.id && purchase.coins === beforePurchase.rows[0].coins - 90 &&
      afterPurchase.rows[0].coins === purchase.coins,
    "atomic furniture purchase debits exactly once and returns an instance",
    { before: beforePurchase.rows[0]?.coins, response: purchase, persisted: afterPurchase.rows[0]?.coins },
  );
  await moveTo(a, "city"); await moveTo(a, `home:${emails[0]}`);
  // homePurchase sends a private inventory snapshot while the player is in the
  // shop. It is intentionally stale for this assertion; only inspect snapshots
  // emitted after the layout mutation.
  a.q.home.clear();
  a.socket.emit("homeLayoutSet", { instanceId: purchase.item.id, gridX: 1, gridY: 1, rotation: 0 });
  let changed = null;
  for (let attempts = 0; attempts < 3 && !changed; attempts++) {
    const candidate = await a.q.home.next();
    if (candidate.layout?.some((x) => x.id === purchase.item.id && x.gridX === 1)) changed = candidate;
  }
  check(!!changed, "owner layout placement persists", changed || { queuedSnapshot: "did not contain placed instance", purchase });

  // An invite-only home rejects an uninvited doorway attempt. Inviting B
  // allows the same physical doorway; revoke immediately ejects B.
  await setAccess(a, "invite_only");
  await moveTo(b, `home:${emails[0]}`, { expectOk: false });
  a.socket.emit("homeInvite", { email: emails[1] });
  check((await a.q.invite.next()).ok, "owner can invite a coworker");
  await moveTo(b, `home:${emails[0]}`);
  const revoked = inbox(b.socket, "homeEjected");
  a.socket.emit("homeInviteRevoke", { email: emails[1] });
  check(!!(await revoked.next().catch(() => null)), "revoking an invite ejects an invite-only visitor");
  await b.q.transition.next(); // authoritative ejection map result
  b.location = "city"; b.position = [144, 960];

  // Regression: access changes queued behind a case-variant physical doorway
  // request must win before a visitor remains in a stale alternate-cased room.
  await setAccess(a, "public");
  b.q.transition.clear();
  await walkRoute(b, routeToPortal(b.location, `home:${emails[0]}`, b.position));
  b.socket.emit("locationTransition", { destination: `home:${emails[0].toUpperCase()}` });
  a.socket.emit("homeAccessSet", { mode: "private" });
  await sleep(900);
  const racedTransitions = await b.q.transition.collect(50);
  check(racedTransitions.length > 0 && racedTransitions.at(-1)?.location !== `home:${emails[0]}`,
    "access/transition race cannot leave a visitor in a stale home room");

  // Regression: concurrent place/return operations share the home row lock.
  // Both acknowledgements must succeed and each must advance the revision;
  // checking only the primary-key row count would be a meaningless assertion.
  const revisionBeforeRace = await db.query(`SELECT layout_revision FROM jpo_homes WHERE owner_email=$1`, [emails[0]]);
  a.q.action.clear();
  a.socket.emit("homeLayoutSet", { instanceId: purchase.item.id, gridX: 2, gridY: 1, rotation: 0 });
  a.socket.emit("homeLayoutReturn", { instanceId: purchase.item.id });
  const raceActions = await Promise.all([a.q.action.next(), a.q.action.next()]);
  const placedRows = await db.query(
    `SELECT count(*)::int AS n FROM jpo_home_layout_items WHERE furniture_instance_id=$1 AND home_owner_email=$2`,
    [purchase.item.id, emails[0]],
  );
  const revisionAfterRace = await db.query(`SELECT layout_revision FROM jpo_homes WHERE owner_email=$1`, [emails[0]]);
  check(
    raceActions.every((r) => r?.ok) && placedRows.rows[0].n <= 1 &&
      revisionAfterRace.rows[0].layout_revision === revisionBeforeRace.rows[0].layout_revision + 2,
    "concurrent place/return serializes both commits with two revision increments",
    { actions: raceActions, rows: placedRows.rows[0]?.n, before: revisionBeforeRace.rows[0]?.layout_revision, after: revisionAfterRace.rows[0]?.layout_revision },
  );

  // Both additional streets are real walking maps, not a travel menu. Their
  // edge routes and all residence door geometry are exercised above; this
  // covers the authoritative transitions and safe no-bounce return spawns.
  await moveTo(a, "city");
  await moveTo(a, "maple-row");
  await moveTo(a, "city");
  await moveTo(a, "juniper-square");
  await moveTo(a, "city");
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
if (failures.length) process.exitCode = 1;