// Pet Wars Grand Event integration:
// auth, escrow/refund idempotency, deterministic 8-player bracket, frozen pet
// snapshots, restart recovery, live Pet Battle advancement, and exact payouts.
// Runs on a throwaway server and cleans up only geit-* test rows.
import { io } from "socket.io-client";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createRequire } from "node:module";

const require = createRequire("/home/runner/workspace/artifacts/jpo-huddle/server.js");
const pg = require("pg");
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const PORT = process.env.TEST_GE_PORT || "20991";
const URL = `http://localhost:${PORT}`;
const ADMIN = "ge-admin-" + Math.random().toString(36).slice(2, 10);
const run = Math.random().toString(36).slice(2, 8);
const emails = Array.from({ length: 8 }, (_, i) => `geit-${run}-${i + 1}@justpressone.com`);
const names = ["StageThree", "BracketTwo", "BracketThree", "BracketFour", "BracketFive", "BracketSix", "BracketSeven", "BracketEight"];
const chars = ["adam", "amelia", "bob", "ash", "lucy", "nancy", "oliver", "sophia"];
const fails = [];
const ok = (value, label) => {
  console.log(`${value ? "  ✓" : "  ✗"} ${label}`);
  if (!value) fails.push(label);
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function eventQueue(socket, event) {
  const q = { items: [], waiters: [] };
  socket.on(event, (data) => {
    const waiter = q.waiters.shift();
    if (waiter) waiter(data);
    else q.items.push(data);
  });
  q.next = (timeout = 15_000, label = event) => new Promise((resolve, reject) => {
    if (q.items.length) return resolve(q.items.shift());
    const waiter = (data) => { clearTimeout(timer); resolve(data); };
    const timer = setTimeout(() => {
      const i = q.waiters.indexOf(waiter);
      if (i >= 0) q.waiters.splice(i, 1);
      reject(new Error(`timeout waiting for ${label}`));
    }, timeout);
    q.waiters.push(waiter);
  });
  q.drain = () => { q.items.length = 0; };
  return q;
}

async function waitFor(test, timeout = 20_000, label = "condition") {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    const value = test();
    if (value) return value;
    await sleep(40);
  }
  throw new Error(`timeout waiting for ${label}`);
}

let server = null;
async function startServer(extraEnv = {}) {
  server = spawn("node", ["server.js"], {
    cwd: "/home/runner/workspace/artifacts/jpo-huddle",
    env: {
      ...process.env,
      PORT,
      ADMIN_PASSWORD: ADMIN,
      OWNER_PASSWORD: "",
      GE_JOIN_MS: "60000",
      GE_READY_MS: "30000",
      PET_BATTLE_PICK_MS: "1200",
      ...extraEnv,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stderr.on("data", (data) => process.stderr.write(`[srv] ${data}`));
  let output = "";
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Grand Event server did not boot")), 25_000);
    server.stdout.on("data", (data) => {
      output += String(data);
      if (/Grand Event|Pet Battle/.test(String(data))) process.stdout.write(`[srv] ${data}`);
      if (output.includes("running on port")) {
        clearTimeout(timer);
        resolve();
      }
    });
    server.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`Grand Event server exited during boot (${code})\n${output}`));
    });
  });
}

async function stopServer() {
  if (!server || server.exitCode !== null) return;
  server.kill("SIGKILL");
  await once(server, "exit").catch(() => {});
  server = null;
}

async function cleanup() {
  await pool.query(`DELETE FROM jpo_grand_events WHERE created_by=$1`, [emails[0]]);
  await pool.query(`DELETE FROM jpo_players WHERE email = ANY($1::text[])`, [emails]);
}

async function seed() {
  await cleanup();
  // Other Grand Event test fixtures also exercise restore behavior. If one was
  // deliberately crash-stopped, do not let its active snapshot hijack this
  // isolated server before the fresh geit-* roster can create its own event.
  await pool.query(
    `DELETE FROM jpo_grand_events
      WHERE created_by IN ('test-seed','test-seed-battle')
         OR created_by LIKE 'geit-%@justpressone.com'`,
  );
  for (let i = 0; i < emails.length; i++) {
    const xp = i === 0 ? { pet_dog: 70 } : { pet_dog: 0 };
    const builds = i === 0
      ? { pet_dog: { power: 6, vitality: 0, speed: 0, critical: 0, focus: 0 } }
      : { pet_dog: { power: 0, vitality: 0, speed: 0, critical: 0, focus: 0 } };
    await pool.query(
      `INSERT INTO jpo_players
        (email,first_name,last_name,name,character,department,approved,coins,cosmetics,equipped_pet,pet_xp,pet_builds,last_daily_bonus)
       VALUES ($1,$2,'GrandEvent',$3,$4,'IT',true,1000,ARRAY['pet_dog']::text[],'pet_dog',$5::jsonb,$6::jsonb,CURRENT_DATE)`,
      [emails[i], names[i], `${names[i]} GrandEvent`, chars[i], JSON.stringify(xp), JSON.stringify(builds)],
    );
  }
}

async function connectPlayers({ autoPlay = false } = {}) {
  const clients = [];
  for (let i = 0; i < emails.length; i++) {
    const socket = io(URL, { transports: ["websocket"], reconnection: false });
    const client = {
      s: socket,
      state: null,
      readySent: new Set(),
      picks: new Set(),
      action: eventQueue(socket, "grandEventActionResult"),
      admin: eventQueue(socket, "grandEventAdminResult"),
      auth: eventQueue(socket, "adminAuthOk"),
      approved: eventQueue(socket, "approved"),
      ph: eventQueue(socket, "phResult"),
      phEnd: eventQueue(socket, "phEnd"),
      battleStages: [],
      battleResults: new Map(),
      spectatorStarts: [],
      spectatorRounds: [],
      spectatorStatuses: [],
      pickStatuses: [],
    };
    socket.on("grandEventState", (state) => {
      client.state = state;
      if (autoPlay && state?.me?.canReady && state.currentMatchId && !client.readySent.has(state.currentMatchId)) {
        client.readySent.add(state.currentMatchId);
        socket.emit("grandEventReady");
      }
    });
    socket.on("petBattleStart", (payload) => {
      if (payload?.spectator) client.spectatorStarts.push(payload);
      for (const side of Object.values(payload.combatants || {})) {
        if (side?.name === names[0]) {
          client.battleStages.push({
            stage: side.stage,
            buildExposed: Object.hasOwn(side, "build"),
            tournament: payload.tournament,
          });
        }
      }
    });
    socket.on("petBattlePickStatus", (payload) => {
      client.pickStatuses.push(payload);
      if (!autoPlay || !payload?.matchId || !Array.isArray(payload.legal)) return;
      const key = `${payload.matchId}:${payload.round}`;
      if (client.picks.has(key)) return;
      client.picks.add(key);
      const move = ["ultimate", "special", "attack"].find((m) => payload.legal.includes(m));
      if (move) socket.emit("petBattlePick", { matchId: payload.matchId, move });
    });
    socket.on("petBattleResult", (payload) => {
      if (payload?.matchId) client.battleResults.set(payload.matchId, payload);
    });
    socket.on("petBattleRound", (payload) => {
      if (payload?.spectator) client.spectatorRounds.push(payload);
    });
    socket.on("petBattleSpectatorStatus", (payload) => {
      client.spectatorStatuses.push(payload);
    });
    await new Promise((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("connect_error", reject);
    });
    socket.emit("register", {
      firstName: names[i],
      lastName: "GrandEvent",
      email: emails[i],
      password: "testpass123",
      character: chars[i],
      department: "IT",
    });
    await client.approved.next(15_000, `approved ${i + 1}`);
    clients.push(client);
  }
  return clients;
}

const closePlayers = (clients) => clients.forEach((c) => c.s.close());
const config = {
  entryFee: 150,
  rewards: { opening: 10, quarterfinal: 20, semifinal: 30, final: 40 },
  prizeLabel: "Pet Wars Champion",
  prizeDetails: "Golden office trophy — manual fulfillment",
};

try {
  await seed();
  await startServer();
  let clients = await connectPlayers();
  const [admin, p2, p3] = clients;

  // A normal player cannot create the event.
  const beforeUnauthorized = Number((await pool.query(
    `SELECT count(*) AS n FROM jpo_grand_events WHERE created_by=$1`, [emails[0]],
  )).rows[0].n);
  p2.s.emit("grandEventCreate", config);
  await sleep(300);
  const afterUnauthorized = Number((await pool.query(
    `SELECT count(*) AS n FROM jpo_grand_events WHERE created_by=$1`, [emails[0]],
  )).rows[0].n);
  ok(beforeUnauthorized === afterUnauthorized, "non-admin cannot create a Grand Event");

  admin.s.emit("adminAuth", { password: ADMIN });
  ok(!!(await admin.auth.next(8_000, "admin auth")), "admin/owner host authorization accepted");

  // Mutual exclusion is bidirectional: neither event may start over the other.
  admin.s.emit("phStart", { disguise: "cooler", hideSecs: 60, huntSecs: 300 });
  ok((await admin.ph.next(8_000, "Prop Hunt start")).ok, "Prop Hunt can start before a Grand Event");
  admin.s.emit("grandEventCreate", config);
  ok(!(await admin.admin.next(8_000, "Grand Event blocked by Prop Hunt")).ok,
    "Grand Event cannot open while Prop Hunt is running");
  admin.s.emit("phCancel");
  await admin.phEnd.next(8_000, "Prop Hunt cancellation");

  // Cancellation refunds each entry exactly once.
  admin.s.emit("grandEventCreate", config);
  ok((await admin.admin.next(8_000, "cancel-lobby create")).ok, "host can open registration");
  await waitFor(() => admin.state?.state === "registration", 8_000, "registration state");
  admin.s.emit("phStart", { disguise: "cooler", hideSecs: 60, huntSecs: 300 });
  ok(!(await admin.ph.next(8_000, "Prop Hunt blocked by Grand Event")).ok,
    "Prop Hunt cannot start while Grand Event registration is open");
  for (const c of [p2, p3]) {
    c.s.emit("grandEventJoin");
    ok((await c.action.next(8_000, "cancel-lobby join")).ok, "entrant escrowed for cancellation test");
  }
  ok(Number(await pool.query(`SELECT coins FROM jpo_players WHERE email=$1`, [emails[1]]).then(r => r.rows[0].coins)) === 850,
    "entry fee is debited from the authoritative balance");
  admin.s.emit("grandEventStart");
  const undersized = await admin.admin.next(8_000, "undersized start rejection");
  ok(!undersized.ok && /at least 8 players/.test(undersized.message || ""),
    "host cannot start below the explicit eight-player minimum");
  ok(admin.state?.state === "registration",
    "an undersized start attempt leaves registration and escrow unchanged");
  const cancelledId = admin.state.id;
  admin.s.emit("grandEventCancel");
  ok((await admin.admin.next(10_000, "cancel result")).ok, "host can cancel before bracket lock");
  await waitFor(() => admin.state?.state === "cancelled", 8_000, "cancelled state");
  const refundRows = await pool.query(
    `SELECT email,amount FROM jpo_grand_event_payouts WHERE event_id=$1 AND kind='refund' ORDER BY email`,
    [cancelledId],
  );
  ok(refundRows.rowCount === 2 && refundRows.rows.every((r) => r.amount === 150), "two durable 150-coin refund claims recorded");
  ok(Number(await pool.query(`SELECT coins FROM jpo_players WHERE email=$1`, [emails[1]]).then(r => r.rows[0].coins)) === 1000,
    "cancelled entrant returns to the exact original balance");
  admin.s.emit("grandEventCancel");
  ok(!(await admin.admin.next(8_000, "repeat cancel")).ok, "repeat cancellation is rejected");
  ok(Number((await pool.query(
    `SELECT count(*) AS n FROM jpo_grand_event_payouts WHERE event_id=$1 AND kind='refund'`, [cancelledId],
  )).rows[0].n) === 2, "repeat cancellation cannot duplicate refunds");

  // Main eight-player bracket: sequential joins define deterministic seeds.
  admin.s.emit("grandEventCreate", config);
  ok((await admin.admin.next(8_000, "main create")).ok, "second registration opens after the cancellation");
  await waitFor(() => admin.state?.state === "registration" && admin.state.id !== cancelledId, 8_000, "main registration");
  for (let i = 0; i < clients.length; i++) {
    clients[i].action.drain();
    clients[i].s.emit("grandEventJoin");
    const joined = await clients[i].action.next(8_000, `main join ${i + 1}`);
    ok(joined.ok, `seed ${i + 1} joined`);
  }
  const eventId = admin.state.id;
  ok((await pool.query(
    `SELECT count(*) AS n FROM jpo_grand_event_entries WHERE event_id=$1 AND state='joined'`, [eventId],
  )).rows[0].n === "8", "all eight entry escrows are durable");
  ok((await pool.query(
    `SELECT sum(coins)::int AS coins FROM jpo_players WHERE email = ANY($1::text[])`, [emails],
  )).rows[0].coins === 6800, "entry pot is separate from organizer rewards (8 × 150 debited)");

  admin.s.emit("grandEventStart");
  ok((await admin.admin.next(12_000, "bracket start")).ok, "host locks an eligible bracket");
  const started = await waitFor(
    () => admin.state?.state === "running" && admin.state.currentMatchId && admin.state.rounds?.[0]?.matches?.length === 4 && admin.state,
    12_000,
    "quarterfinal bracket",
  );
  ok(started.rounds[0].label === "Quarterfinals", "eight entrants start at four quarterfinals");
  ok(started.entrants.every((e, i) => e.seed === i + 1 && e.name === names[i]),
    "registration order becomes deterministic seeds 1–8");
  const frozen = (await pool.query(`SELECT snapshot FROM jpo_grand_events WHERE id=$1`, [eventId])).rows[0].snapshot;
  ok(frozen.entrants.find((e) => e.email === emails[0])?.stage === 3
      && frozen.entrants.find((e) => e.email === emails[0])?.build?.power === 6,
    "final-form stage and training build freeze only inside the durable server snapshot");
  await pool.query(
    `UPDATE jpo_players SET pet_xp='{"pet_dog":0}'::jsonb, pet_builds='{"pet_dog":{"power":0,"vitality":0,"speed":0,"critical":0,"focus":0}}'::jsonb WHERE email=$1`,
    [emails[0]],
  );

  // Restart before anyone readies. The active matchup must return as a ready
  // matchup using the frozen account-keyed bracket, never socket ids.
  closePlayers(clients);
  await stopServer();
  await startServer({ GE_TEST_CRASH_AFTER_MATCH_PERSIST: "1" });
  clients = await connectPlayers({ autoPlay: true });
  const restored = await waitFor(
    () => clients.find((c) => c.state?.state === "running" && c.state.currentMatchId)?.state,
    15_000,
    "running bracket after restart",
  );
  ok(restored.id === eventId && restored.entrants.length === 8, "restart restores the same account-keyed bracket");

  const crashCode = server.exitCode !== null
    ? server.exitCode
    : (await once(server, "exit"))[0];
  ok(crashCode === 86, "fault injection crashes after durable match settlement but before payout");
  const crashSnapshot = (await pool.query(
    `SELECT snapshot FROM jpo_grand_events WHERE id=$1`, [eventId],
  )).rows[0].snapshot;
  ok(crashSnapshot.rounds[0].matches[0].state === "done" && crashSnapshot.rounds[0].matches[0].winner,
    "crash leaves the first winner durably recorded");
  ok(Number((await pool.query(
    `SELECT count(*) AS n FROM jpo_grand_event_payouts WHERE event_id=$1 AND kind='round'`, [eventId],
  )).rows[0].n) === 0, "crash occurs before the first round reward is credited");
  const preCrashStages = clients.flatMap((c) => c.battleStages);
  const preCrashResults = new Map(clients.flatMap((c) => [...c.battleResults.entries()]));
  closePlayers(clients);
  server = null;

  await startServer();
  clients = await connectPlayers({ autoPlay: true });
  const firstSettledMatch = crashSnapshot.rounds[0].matches[0];
  const firstLoserEmail = firstSettledMatch.winner === firstSettledMatch.p1
    ? firstSettledMatch.p2
    : firstSettledMatch.p1;
  const observer = clients[emails.indexOf(firstLoserEmail)];
  const observerBalanceBefore = Number((await pool.query(
    `SELECT coins FROM jpo_players WHERE email=$1`, [firstLoserEmail],
  )).rows[0].coins);

  observer.s.emit("grandEventViewMode", { mode: "spectate" });
  const spectateChoice = await observer.action.next(8_000, "spectate choice");
  ok(spectateChoice.ok, "an eliminated entrant can opt into live spectating");
  await waitFor(() => observer.state?.me?.viewMode === "spectate", 8_000, "spectator preference");
  await waitFor(() => observer.spectatorStarts.length > 0, 30_000, "sanitized spectator battle start");
  ok(observer.spectatorStarts.every((payload) => payload.spectator && payload.tournament
      && payload.viewSide === "challenger" && payload.combatants
      && Object.values(payload.combatants).every((side) =>
        ["build", "stats", "hp", "maxHp"].every((key) => !Object.hasOwn(side, key)))),
    "spectators receive a read-only sanitized tournament start snapshot");

  // Reconnect while the event is active. The durable preference should restore,
  // and either the current battle or the next one should reopen automatically.
  const startsBeforeReconnect = observer.spectatorStarts.length;
  observer.s.disconnect();
  const reconnected = new Promise((resolve, reject) => {
    observer.s.once("connect", resolve);
    observer.s.once("connect_error", reject);
  });
  observer.s.connect();
  await reconnected;
  observer.s.emit("register", {
    firstName: names[emails.indexOf(firstLoserEmail)],
    lastName: "GrandEvent",
    email: firstLoserEmail,
    password: "testpass123",
    character: chars[emails.indexOf(firstLoserEmail)],
    department: "IT",
  });
  await observer.approved.next(15_000, "spectator reconnect approved");
  await waitFor(() => observer.state?.me?.viewMode === "spectate", 8_000, "restored spectator preference");
  await waitFor(() => observer.spectatorStarts.length > startsBeforeReconnect, 30_000, "spectator battle after reconnect");
  await waitFor(() => observer.spectatorRounds.length > 0, 30_000, "sanitized spectator round");
  ok(observer.spectatorStatuses.length > 0 && observer.pickStatuses.length === 0,
    "spectators receive progress updates without legal moves or control prompts");
  ok(observer.spectatorRounds.every((payload) => payload.spectator
      && payload.result && payload.combatants
      && Object.values(payload.combatants).every((side) =>
        ["build", "stats", "hp", "maxHp"].every((key) => !Object.hasOwn(side, key)))
      && !JSON.stringify(payload.result).includes("damageDealt")),
    "live spectators receive battle animation rounds with public combatants");

  const currentAtQuit = observer.state.currentMatchId;
  observer.s.emit("grandEventViewMode", { mode: "quit" });
  const quitChoice = await observer.action.next(8_000, "quit choice");
  ok(quitChoice.ok, "an eliminated spectator can quit Pet Wars");
  await waitFor(() => observer.state?.me?.viewMode === "quit", 8_000, "quit preference");
  // Baseline only after the server acknowledges the durable Quit. Packets sent
  // while the request itself was in flight are not post-ack spectator delivery.
  const spectatorEventCountAtQuit = observer.spectatorStarts.length
    + observer.spectatorRounds.length
    + [...observer.battleResults.values()].filter((payload) => payload.spectator).length;
  await waitFor(
    () => observer.state?.state === "complete" || observer.state?.currentMatchId !== currentAtQuit,
    35_000,
    "bracket advances after spectator quits",
  );
  await sleep(300);
  const spectatorEventCountAfterQuit = observer.spectatorStarts.length
    + observer.spectatorRounds.length
    + [...observer.battleResults.values()].filter((payload) => payload.spectator).length;
  ok(spectatorEventCountAfterQuit === spectatorEventCountAtQuit,
    "quit spectators stop receiving later live battle events");
  ok(observer.state?.me?.status === "eliminated",
    "quit is a viewer preference and never reverses bracket elimination");
  ok(Number((await pool.query(
    `SELECT coins FROM jpo_players WHERE email=$1`, [firstLoserEmail],
  )).rows[0].coins) === observerBalanceBefore
    && Number((await pool.query(
      `SELECT count(*) AS n FROM jpo_grand_event_payouts WHERE event_id=$1 AND email=$2 AND kind='refund'`,
      [eventId, firstLoserEmail],
    )).rows[0].n) === 0,
  "quit does not refund the locked entry or create a refund claim");

  const completed = await waitFor(
    () => clients.find((c) => c.state?.state === "complete" && c.state.champion)?.state,
    120_000,
    "Grand Event champion",
  );
  ok(completed.rounds.map((r) => r.matches.length).join(",") === "4,2,1", "single-elimination bracket advances 4 → 2 → 1");
  ok(completed.rounds.flatMap((r) => r.matches).every((m) => m.state === "done" && m.winnerSeed),
    "all seven matches settle with a winner (no draws)");
  ok(completed.champion.prizeLabel === "Pet Wars Champion"
    && completed.champion.prizeDetails.includes("manual fulfillment"),
  "custom champion prize is recorded and displayed for manual fulfillment");
  ok(completed.champion.pot === 1200 && completed.champion.roundReward === 40,
    "champion receives the full 1,200 entry pot plus configured final reward");

  const allStageCaptures = [...preCrashStages, ...clients.flatMap((c) => c.battleStages)];
  ok(allStageCaptures.length > 0
    && allStageCaptures.every((x) => x.tournament && x.stage === 3 && !x.buildExposed),
  "post-restart battles use frozen final-form artwork without leaking training builds");
  const results = new Map([...preCrashResults, ...clients.flatMap((c) => [...c.battleResults.entries()])]);
  ok(results.size === 7 && [...results.values()].every((r) => r.tournament && !r.draw),
    "seven server-authoritative tournament Pet Battles finished without a draw");

  const payouts = await pool.query(
    `SELECT kind,count(*)::int AS n,sum(amount)::int AS amount
       FROM jpo_grand_event_payouts WHERE event_id=$1 GROUP BY kind ORDER BY kind`,
    [eventId],
  );
  const byKind = Object.fromEntries(payouts.rows.map((r) => [r.kind, r]));
  ok(byKind.round?.n === 7 && byKind.round?.amount === 180, "all seven configured stage rewards paid exactly once");
  ok(byKind.champion?.n === 1 && byKind.champion?.amount === 1200, "champion pot paid through one idempotent claim");
  ok((await pool.query(
    `SELECT sum(coins)::int AS coins FROM jpo_players WHERE email = ANY($1::text[])`, [emails],
  )).rows[0].coins === 8180, "coin conservation: fees + organizer rewards + champion pot settle exactly");

  // A second restart replays payout recovery. Ledger uniqueness must make it a no-op.
  const balancesBeforeRecovery = (await pool.query(
    `SELECT email,coins FROM jpo_players WHERE email = ANY($1::text[]) ORDER BY email`, [emails],
  )).rows;
  closePlayers(clients);
  await stopServer();
  await startServer();
  await sleep(1200);
  const balancesAfterRecovery = (await pool.query(
    `SELECT email,coins FROM jpo_players WHERE email = ANY($1::text[]) ORDER BY email`, [emails],
  )).rows;
  ok(JSON.stringify(balancesAfterRecovery) === JSON.stringify(balancesBeforeRecovery),
    "completion recovery cannot double-pay stage rewards or the champion pot");

  console.log(fails.length ? `RESULT: FAIL (${fails.length})` : "RESULT: PASS");
} catch (error) {
  console.error("TEST ERROR:", error);
  fails.push(error.message);
  console.log(`RESULT: FAIL (${fails.length})`);
} finally {
  await stopServer().catch(() => {});
  await cleanup().catch(() => {});
  await pool.end();
}
process.exit(fails.length ? 1 : 0);