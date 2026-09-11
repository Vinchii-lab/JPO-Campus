// Run against an already started test server:
// TEST_PORT=... DATABASE_URL=... node tests/neighborhood/location-isolation.mjs
// This intentionally uses real Socket.IO clients; it covers the room boundary
// rather than re-testing client presentation.
import { io } from "socket.io-client";
import pg from "pg";
import { layoutBlockers, parseLocation, validLocationMove } from "../../neighborhood.mjs";

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
    chat: inbox(socket, "chatMessage"), voice: inbox(socket, "voiceSignal"),
    home: inbox(socket, "homeSnapshot"), buy: inbox(socket, "homePurchaseResult"),
    action: inbox(socket, "homeActionResult"),
    directory: inbox(socket, "homeDirectory"),
  };
  await new Promise((resolve, reject) => { socket.once("connect", resolve); socket.once("connect_error", reject); });
  socket.emit("register", { firstName: first, lastName: "Neighborhood", email, password: "testpass123", character: "adam", department: "IT" });
  await q.approved.next();
  return { socket, q };
}
async function moveTo(client, destination) {
  client.socket.emit("locationTransition", { destination });
  const result = await client.q.transition.next();
  check(result.ok && result.location === destination, `transition accepted: ${destination}`);
  return result;
}

try {
  const canonical = parseLocation("home:Case.Owner@JustPressOne.COM");
  check(canonical?.id === "home:case.owner@justpressone.com" && canonical.ownerEmail === "case.owner@justpressone.com",
    "case-variant home targets canonicalize to one room id");
  check(!validLocationMove(parseLocation("city"), 100, 100) &&
    validLocationMove(parseLocation("city"), 480, 720),
  "city facade blockers reject clipping but preserve plaza spawn");
  const chairBlocker = layoutBlockers([{ furnitureId: "oak_chair", gridX: 2, gridY: 2, rotation: 0 }]);
  check(!validLocationMove(parseLocation("home:test@example.com"), 120, 120, chairBlocker) &&
    validLocationMove(parseLocation("home:test@example.com"), 312, 360, chairBlocker),
  "home furniture collision blocks its tile but preserves door spawn");
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

  // A and B share city; C remains in HQ.  No lifecycle, movement, chat or
  // voice signal may cross this room boundary.
  await moveTo(a, "city"); await moveTo(b, "city");
  await c.q.joined.collect(); c.q.moved.clear(); c.q.chat.clear(); c.q.voice.clear();
  a.socket.emit("playerMove", { x: 520, y: 700, dir: "right", anim: "walk" });
  check((await c.q.moved.collect()).length === 0, "office cannot see city movement");
  a.socket.emit("chatMessage", { text: "city-only" });
  check((await c.q.chat.collect()).length === 0, "office cannot receive city chat");
  a.socket.emit("voiceSignal", { targetId: c.socket.id, data: { k: "offer", sdp: "cross-location" } });
  check((await c.q.voice.collect()).length === 0, "voice relay rejects cross-location peer");

  // A first visit creates the starter home. C is allowed while public, then
  // gets ejected on invite-only access without an invite.
  await moveTo(a, `home:${emails[0]}`);
  const aHome = await a.q.home.next();
  check(aHome.canEdit && Array.isArray(aHome.inventory), "owner receives editable starter-home snapshot");
  a.socket.emit("homeDirectoryRequest");
  const directory = await a.q.directory.next();
  check(directory.homes?.some((h) => h.ownerEmail === emails[0] && h.name && h.accessMode),
    "home directory exposes only safe owner/name/access metadata", directory);
  await moveTo(c, `home:${emails[0]}`);
  const ejected = inbox(c.socket, "homeEjected");
  a.socket.emit("homeAccessSet", { mode: "private" });
  const eject = await ejected.next().catch(() => null);
  check(!!eject, "access revocation ejects existing visitor");

  // Purchase only works at the shop, produces an immutable inventory instance,
  // and placement returns a revisioned room snapshot.
  await moveTo(a, "furniture-shop");
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
  await moveTo(a, `home:${emails[0]}`);
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

  // Regression: access changes queued behind a case-variant transition must
  // win before the visitor can remain in a stale, alternate-cased room.
  a.socket.emit("homeAccessSet", { mode: "public" });
  await sleep(100);
  b.q.transition.clear();
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