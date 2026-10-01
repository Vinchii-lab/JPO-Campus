import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import {
  LOCATIONS, parseLocation, locationSpawn, streetDefinition, streetLotForOwner,
  validStreetWorldMove, validLocationMove,
} from "../../neighborhood.mjs";

const source = fs.readFileSync(new URL("../../server.js", import.meta.url), "utf8");
const between = (start, end) => {
  const a = source.indexOf(start), b = source.indexOf(end, a + start.length);
  assert(a >= 0 && b > a, `runtime section exists: ${start}`);
  return source.slice(a, b);
};
const dropAndGrace = between("function liveSocketsForEmail(", "// Put a socket into the office");
const disconnect = between('  socket.on("disconnect", async () => {', "\n});\n\nfunction _notifyAdmins");
const resume = between('  socket.on("resumeSession",', "  // ── Admin auth");
// Execute all actual restore location decisions, registration, approved and
// locationTransitionResult emissions. Unrelated shop/mail/bonus fan-out after
// these responses is deliberately outside this transport regression.
const restore = between("async function restorePlayer(", "  // Prop Hunt masks the hider") + "\n}\n";
const normalize = between("function normalizeStreetReconnectState(", "function locationInfo(");
const forfeit = between("function forfeitMatchForLeave(", "// Create a pending challenge");
const finishMatch = between("async function finishMatch(", "// Resolve a picking-phase RPS match");

async function fixture({
  location = "neighborhood", ordering = "replacement-first", approved = true,
  tokenValid = true, tokenRevoked = false, directoryFails = false, activeMatch = true,
} = {}) {
  const email = "resident@example.com";
  const position = location === "city" ? locationSpawn(parseLocation("city")) : { x: 720, y: 504, dir: "left" };
  const old = { email, name: "Resident", locationId: location, ...position, anim: "idle", coins: 50,
    residentialExitBlock: { segment: 0, roadY: 504, returnPoint: { x: 1300, y: 504 } } };
  const row = { email, name: old.name, approved, password_set_at: tokenRevoked ? new Date(2000) : null };
  const handlers = {}, emitted = [], timers = [], failures = [], leaves = [];
  let disconnected = 0, oldDisconnectTask, settled = 0, seatCleanup = 0;
  const players = { old, opponent: { email: "opponent@example.com", name: "Opponent", coins: 50 } };
  const match = { state: "playing", id: 1, game: "rps", challengerId: "old", targetId: "opponent", wager: 10 };
  const oldSocket = {
    id: "old", on(event, fn) { handlers[`old:${event}`] = fn; },
    disconnect() { disconnected++; oldDisconnectTask = handlers["old:disconnect"](); },
  };
  const newSocket = {
    id: "new", on(event, fn) { handlers[`new:${event}`] = fn; },
    join() {},
    emit(event, data) { emitted.push({ event, data }); },
  };
  const context = vm.createContext({
    players, pending: {}, graceByEmail: {}, GRACE_MS: 10000,
    socket: oldSocket,
    io: { sockets: { sockets: new Map([["old", oldSocket], ["new", newSocket]]) },
      to: () => ({ emit() {} }), emit() {} },
    console: { log() {}, error(...args) { failures.push(args); } },
    setTimeout(fn, ms) { const timer = { fn, ms, cleared: false }; timers.push(timer); return timer; },
    clearTimeout(timer) { if (timer) timer.cleared = true; },
    pool: { async query(sql) { return { rows: sql.startsWith("SELECT * FROM jpo_players") ? [row] : [] }; } },
    verifyToken: () => tokenValid ? { email, iat: 1000 } : null,
    // DB row projection is outside the transport concern; ordinary durable
    // restore starts in office, exactly as rowToPlayerState does in production.
    rowToPlayerState: () => ({ email, name: old.name, locationId: "office", ...LOCATIONS.office.spawn, anim: "idle" }),
    locationOf: (p) => p.locationId || "office", locationRoom: (id) => `location:${id}`,
    emitToLocation: (location, event, id) => leaves.push({ location, event, id }),
    LOCATIONS, GRASS_SPAWN: LOCATIONS.office.spawn, isVoidPosition: () => false,
    parseLocation, locationSpawn, validLocationMove, validStreetWorldMove,
    streetWorld: streetDefinition([]), streetHomes: [], streetLotForOwner,
    refreshStreetHomes: async () => { if (directoryFails) throw new Error("directory unavailable"); },
    emptySlots: () => ({}), locationInfo: (id) => ({ id }),
    movementPayload: (id, p) => ({ id, ...p, location: p.locationId }),
    locationPlayers: () => ({ new: players.new }),
    durableAnimFor: (p) => p.anim, stopFurnitureActivity: () => { seatCleanup++; },
    roundDeferLeave: () => false, roundHandleLeave() {}, roundLeaveGoneByEmail() {},
    roundScheduleGoneLeave() {}, rlglHandleLeave() {}, propHunt: null,
    raceDuelForfeit: async () => {}, petBattleForfeitForLeave() {},
    tradeBySocket: new Map(), admins: new Set(), owners: new Set(), _notifyAdmins() {},
    rpsBySocket: new Map(activeMatch ? [["old", match], ["opponent", match]] : []),
    rpsOtherId: (m, id) => id === m.challengerId ? m.targetId : m.challengerId,
    clearMatchTimers() {}, GAME_NAMES: {}, recordWin: async () => {},
    rpsSettle: async (_winner, loser, wager) => {
      assert(players[loser], "actual settlement claims the live player before deletion");
      settled++;
      return wager;
    },
  });
  vm.runInContext(`${dropAndGrace}\n${normalize}\n${restore}\n${forfeit}\n${finishMatch}\n${disconnect}`, context);
  // Register on the new socket without changing the lexical socket captured by
  // the old connection's actual disconnect callback.
  context.newSocket = newSocket;
  vm.runInContext(`((socket) => { ${resume} })(newSocket);`, context);
  if (ordering === "disconnect-first" || ordering === "expired") {
    oldSocket.disconnect();
    await oldDisconnectTask;
    assert.equal(context.graceByEmail[email]?.locationId, location);
    if (ordering === "expired") timers.find((t) => !t.cleared).fn();
  }
  await handlers["new:resumeSession"]({ token: "test-only" });
  await oldDisconnectTask;
  // Settle any promise tails without running a server or touching a database.
  await Promise.resolve();
  assert.deepEqual(failures, [], "no hidden resume/settlement exceptions");
  return { context, old, players, emitted, timers, disconnected, settled, seatCleanup, position };
}

for (const location of ["neighborhood", "city"]) {
  for (const ordering of ["replacement-first", "disconnect-first"]) {
    const result = await fixture({ location, ordering });
    assert.equal(result.players.new.locationId, location, `${ordering} preserves ${location}`);
    assert.equal(result.players.new.x, result.position.x);
    assert.equal(result.players.new.y, result.position.y);
    assert.equal(result.players.new.dir, result.position.dir);
    assert(result.players.new.residentialExitBlock, "residential return metadata survives");
    assert(!result.players.old, "old live session is removed");
    assert.equal(Object.values(result.players).filter((p) => p.email === result.old.email).length, 1);
    assert.equal(result.disconnected, 1, "old transport is closed once, not pre-closed then dropped again");
    assert.equal(result.settled, 1, "actual forfeit/finish handlers settle the active wager once");
    assert.equal(result.seatCleanup, 0, "copying an outdoor snapshot does not manufacture seat exits");
    assert(!result.context.graceByEmail[result.old.email], "no stale grace record can later eject the replacement");
    for (const event of ["approved", "locationTransitionResult"]) {
      assert.equal(result.emitted.find((p) => p.event === event)?.data.location, location);
    }
  }
}

for (const options of [{ tokenValid: false }, { tokenRevoked: true }]) {
  const result = await fixture(options);
  assert(result.players.old, "invalid/voided credential cannot drop the real session");
  assert(!result.players.new);
  assert.equal(result.disconnected, 0);
  assert.equal(result.settled, 0);
  assert(result.emitted.some((p) => p.event === "resumeFailed"));
}
const unapproved = await fixture({ approved: false });
assert(!unapproved.players.new, "unapproved resume must not restore a live outdoor snapshot");
assert(unapproved.context.pending.new);
assert(unapproved.emitted.some((p) => p.event === "registrationPending"));

for (const location of ["home:someone-else@example.com", "furniture-shop", "office"]) {
  const result = await fixture({ location });
  assert.equal(result.players.new.locationId, "office", "live carry-over is outdoor-only; no home access bypass");
  assert.equal(result.players.new.x, LOCATIONS.office.spawn.x);
}
const expired = await fixture({ ordering: "expired" });
assert.equal(expired.players.new.locationId, "office", "expired grace retains the established HQ fallback");
const failedDirectory = await fixture({ directoryFails: true });
assert.equal(failedDirectory.players.new.locationId, "office", "live snapshot still passes directory/geometry restore policy");

// Non-resume callers must not start carrying locations implicitly.
const signature = between("function dropLiveByEmail(", "// Cancel a pending grace");
assert.match(signature, /preserveOutdoorPosition = false/);
const preserveCalls = [...source.matchAll(/dropLiveByEmail\([^;\n]*!!row\.approved\)/g)];
assert.equal(preserveCalls.length, 1, "only the authenticated resume handler opts in");
console.log("PASS: actual resume/drop/disconnect/restore handlers preserve live or graced outdoor snapshots, one-session identity, token gates, outdoor-only access, fallback policy and single wager settlement");