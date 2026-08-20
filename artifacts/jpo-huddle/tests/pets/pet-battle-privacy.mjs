// Pet Battle privacy + unlimited daily XP integration:
// - owners receive their own editable build, coworkers do not
// - live battle payloads never serialize either build
// - an old/legacy daily-cap row cannot stop an otherwise eligible XP award
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createRequire } from "node:module";
import { io } from "socket.io-client";

const require = createRequire("/home/runner/workspace/artifacts/jpo-huddle/server.js");
const { Pool } = require("pg");
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const PORT = process.env.TEST_PB_PRIVACY_PORT || "20994";
const URL = `http://localhost:${PORT}`;
const run = Math.random().toString(36).slice(2, 9);
const EMAIL_A = `pb-private-a-${run}@justpressone.com`;
const EMAIL_B = `pb-private-b-${run}@justpressone.com`;
const fails = [];

const ok = (value, label) => {
  console.log(`${value ? "  ✓" : "  ✗"} ${label}`);
  if (!value) fails.push(label);
};

function queue(socket, event) {
  const items = [];
  const waiters = [];
  socket.on(event, (data) => {
    const waiter = waiters.shift();
    if (waiter) waiter(data);
    else items.push(data);
  });
  return {
    next(timeout = 12_000, label = event) {
      return new Promise((resolve, reject) => {
        if (items.length) return resolve(items.shift());
        const waiter = (data) => {
          clearTimeout(timer);
          resolve(data);
        };
        const timer = setTimeout(() => {
          const index = waiters.indexOf(waiter);
          if (index >= 0) waiters.splice(index, 1);
          reject(new Error(`timeout waiting for ${label}`));
        }, timeout);
        waiters.push(waiter);
      });
    },
  };
}

function connect(email, firstName, character) {
  const socket = io(URL, { transports: ["websocket"], reconnection: false });
  const approved = queue(socket, "approved");
  const profile = queue(socket, "petBattleProfile");
  const start = queue(socket, "petBattleStart");
  const result = queue(socket, "petBattleResult");
  const pickStatuses = [];
  socket.on("petBattlePickStatus", (payload) => {
    pickStatuses.push(payload);
    if (payload?.matchId && Array.isArray(payload.legal)) {
      const move = payload.legal.includes("attack") ? "attack" : payload.legal[0];
      if (move) socket.emit("petBattlePick", { matchId: payload.matchId, move });
    }
  });
  const ready = new Promise((resolve, reject) => {
    socket.once("connect", () => {
      socket.emit("register", {
        firstName,
        lastName: "Privacy",
        email,
        password: "testpass123",
        character,
        department: "IT",
      });
      resolve();
    });
    socket.once("connect_error", reject);
  });
  return { socket, approved, profile, start, result, pickStatuses, ready };
}

async function cleanup() {
  await pool.query(`DELETE FROM jpo_pet_battles WHERE email = ANY($1::text[])`, [[EMAIL_A, EMAIL_B]]);
  await pool.query(
    `DELETE FROM jpo_pet_battle_pairs
      WHERE email_a = ANY($1::text[]) OR email_b = ANY($1::text[])`,
    [[EMAIL_A, EMAIL_B]],
  );
  await pool.query(`DELETE FROM jpo_pet_battle_caps WHERE email = ANY($1::text[])`, [[EMAIL_A, EMAIL_B]]);
  await pool.query(`DELETE FROM jpo_players WHERE email = ANY($1::text[])`, [[EMAIL_A, EMAIL_B]]);
}

let server;
let A;
let B;
try {
  await pool.query(`CREATE TABLE IF NOT EXISTS jpo_pet_battle_caps (
    day text NOT NULL, email text NOT NULL, pet text NOT NULL, n int NOT NULL DEFAULT 0,
    PRIMARY KEY (day, email, pet)
  )`);
  await cleanup();
  for (const [email, firstName, character, build] of [
    [EMAIL_A, "PrivateAlpha", "adam", { power: 6, vitality: 0, speed: 0, critical: 0, focus: 0 }],
    [EMAIL_B, "PrivateBeta", "bob", { power: 0, vitality: 0, speed: 0, critical: 0, focus: 6 }],
  ]) {
    await pool.query(
      `INSERT INTO jpo_players
        (email,first_name,last_name,name,character,department,approved,coins,cosmetics,
         equipped_pet,pet_xp,pet_builds,last_daily_bonus)
       VALUES ($1,$2,'Privacy',$3,$4,'IT',true,1000,ARRAY['pet_dog']::text[],'pet_dog',
               '{"pet_dog":70}'::jsonb,$5::jsonb,CURRENT_DATE)`,
      [email, firstName, `${firstName} Privacy`, character, JSON.stringify({ pet_dog: build })],
    );
    await pool.query(
      `INSERT INTO jpo_pet_battle_caps (day,email,pet,n)
       VALUES (to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD'),$1,'pet_dog',999)`,
      [email],
    );
  }

  server = spawn("node", ["server.js"], {
    cwd: "/home/runner/workspace/artifacts/jpo-huddle",
    env: { ...process.env, PORT, PET_BATTLE_PICK_MS: "100" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stderr.on("data", (data) => process.stderr.write(`[srv] ${data}`));
  let boot = "";
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("privacy test server did not boot")), 25_000);
    server.stdout.on("data", (data) => {
      boot += String(data);
      if (boot.includes("running on port")) {
        clearTimeout(timer);
        resolve();
      }
    });
    server.once("exit", (code) => reject(new Error(`server exited during boot (${code})\n${boot}`)));
  });

  A = connect(EMAIL_A, "PrivateAlpha", "adam");
  B = connect(EMAIL_B, "PrivateBeta", "bob");
  await Promise.all([A.ready, B.ready]);
  await Promise.all([A.approved.next(), B.approved.next()]);

  console.log("― profile privacy");
  A.socket.emit("petBattleGetProfile", { targetId: A.socket.id, requestId: 1 });
  const own = await A.profile.next(8_000, "owner profile");
  ok(own.ok && own.self && own.build?.power === 6 && own.stats && own.attrs,
    "owner receives their own editable attributes and derived stats");

  A.socket.emit("petBattleGetProfile", { targetId: B.socket.id, requestId: 2 });
  const coworker = await A.profile.next(8_000, "coworker profile");
  const privateKeys = ["build", "budget", "spent", "attrs", "stats"];
  ok(coworker.ok && !coworker.self
      && privateKeys.every((key) => !Object.hasOwn(coworker, key)),
    "coworker profile omits exact attributes, points, and derived stats");

  console.log("― live battle privacy and unlimited daily XP");
  const incoming = queue(B.socket, "petBattleChallengeIncoming");
  A.socket.emit("petBattleChallenge", { targetId: B.socket.id });
  const challenge = await incoming.next(8_000, "battle challenge");
  B.socket.emit("petBattleRespond", { matchId: challenge.matchId, accept: true });
  const [startA, startB] = await Promise.all([
    A.start.next(8_000, "A battle start"),
    B.start.next(8_000, "B battle start"),
  ]);
  const hidesBuilds = (payload) => Object.values(payload.combatants || {})
    .every((side) => ["build", "stats", "hp", "maxHp"].every((key) => !Object.hasOwn(side, key)));
  ok(hidesBuilds(startA) && hidesBuilds(startB),
    "both participants receive battle state without either training build");

  const [resultA, resultB] = await Promise.all([
    A.result.next(30_000, "A battle result"),
    B.result.next(30_000, "B battle result"),
  ]);
  ok(hidesBuilds(resultA) && hidesBuilds(resultB)
      && [...A.pickStatuses, ...B.pickStatuses].every((payload) =>
        [payload.you, payload.foe].every((side) =>
          ["build", "stats", "hp", "maxHp"].every((key) => !Object.hasOwn(side || {}, key)))
        && (!payload.result || !JSON.stringify(payload.result).includes("damageDealt"))),
    "round, pick, and result payloads keep builds and exact derived values private");

  const { rows } = await pool.query(
    `SELECT email,(pet_xp->>'pet_dog')::int AS xp FROM jpo_players
      WHERE email = ANY($1::text[])`,
    [[EMAIL_A, EMAIL_B]],
  );
  ok(rows.length === 2 && rows.every((row) => Number(row.xp) > 70),
    "both pets earn battle XP despite legacy daily counters already at 999");
} catch (err) {
  console.error(err);
  fails.push(err.stack || String(err));
} finally {
  A?.socket.disconnect();
  B?.socket.disconnect();
  if (server && server.exitCode === null) {
    server.kill("SIGKILL");
    await once(server, "exit").catch(() => {});
  }
  await cleanup().catch((err) => {
    console.error("cleanup failed", err);
    fails.push(`cleanup failed: ${err}`);
  });
  await pool.end();
}

if (fails.length) {
  console.error(`RESULT: FAIL (${fails.length})`);
  process.exit(1);
}
console.log("RESULT: PASS");