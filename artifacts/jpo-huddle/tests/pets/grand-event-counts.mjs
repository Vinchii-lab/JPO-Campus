// Live bracket-shape smoke test for every non-eight-player Grand Event roster.
// Match ready clocks intentionally expire so deterministic seed walkovers can
// exercise every play-in/bye transition without running dozens of Pet Battles.
import { io } from "socket.io-client";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createRequire } from "node:module";

const require = createRequire("/home/runner/workspace/artifacts/jpo-huddle/server.js");
const pg = require("pg");
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const PORT = process.env.TEST_GE_COUNTS_PORT || "20992";
const URL = `http://localhost:${PORT}`;
const ADMIN = "ge-counts-admin-" + Math.random().toString(36).slice(2, 10);
const run = Math.random().toString(36).slice(2, 8);
const emails = Array.from({ length: 16 }, (_, i) => `gecount-${run}-${i + 1}@justpressone.com`);
const expected = {
  10: [2, 4, 2, 1],
  12: [4, 4, 2, 1],
  14: [6, 4, 2, 1],
  16: [8, 4, 2, 1],
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(test, timeout = 20_000, label = "condition") {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    const value = test();
    if (value) return value;
    await sleep(30);
  }
  throw new Error(`timeout waiting for ${label}`);
}
function queue(socket, event) {
  const items = [], waiters = [];
  socket.on(event, (data) => {
    const next = waiters.shift();
    if (next) next(data);
    else items.push(data);
  });
  return {
    next(timeout = 10_000) {
      if (items.length) return Promise.resolve(items.shift());
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`timeout waiting for ${event}`)), timeout);
        waiters.push((data) => { clearTimeout(timer); resolve(data); });
      });
    },
  };
}

let server;
const clients = [];
try {
  await pool.query(`DELETE FROM jpo_grand_events WHERE created_by=$1`, [emails[0]]);
  await pool.query(`DELETE FROM jpo_players WHERE email=ANY($1::text[])`, [emails]);
  for (let i = 0; i < emails.length; i++) {
    await pool.query(
      `INSERT INTO jpo_players
        (email,first_name,last_name,name,character,department,approved,coins,cosmetics,equipped_pet,pet_xp,pet_builds,last_daily_bonus)
       VALUES ($1,$2,'Counts',$2,'adam','IT',true,5000,ARRAY['pet_dog']::text[],'pet_dog','{}'::jsonb,'{}'::jsonb,CURRENT_DATE)`,
      [emails[i], `CountSeed${i + 1}`],
    );
  }

  server = spawn("node", ["server.js"], {
    cwd: "/home/runner/workspace/artifacts/jpo-huddle",
    env: {
      ...process.env,
      PORT,
      ADMIN_PASSWORD: ADMIN,
      OWNER_PASSWORD: "",
      GRAND_EVENT_READY_MS: "80",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stderr.on("data", (data) => process.stderr.write(`[srv] ${data}`));
  await new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(new Error("counts server did not boot")), 25_000);
    server.stdout.on("data", (data) => {
      output += String(data);
      if (output.includes("running on port")) {
        clearTimeout(timer);
        resolve();
      }
    });
    server.once("exit", (code) => reject(new Error(`counts server exited during boot (${code})`)));
  });

  for (let i = 0; i < emails.length; i++) {
    const s = io(URL, { transports: ["websocket"], reconnection: false });
    const c = { s, state: null, action: queue(s, "grandEventActionResult"), admin: queue(s, "grandEventAdminResult"), auth: queue(s, "adminAuthOk"), approved: queue(s, "approved") };
    s.on("grandEventState", (state) => { c.state = state; });
    await once(s, "connect");
    s.emit("register", {
      firstName: `CountSeed${i + 1}`,
      lastName: "Counts",
      email: emails[i],
      password: "testpass123",
      character: "adam",
      department: "IT",
    });
    await c.approved.next();
    clients.push(c);
  }

  const admin = clients[0];
  admin.s.emit("adminAuth", { password: ADMIN });
  await admin.auth.next();

  for (const count of [10, 12, 14, 16]) {
    admin.s.emit("grandEventCreate", {
      entryFee: 150,
      rewards: { opening: 0, quarterfinal: 0, semifinal: 0, final: 0 },
      prizeLabel: "Pet Wars Champion",
      prizeDetails: `Counts test ${count}`,
    });
    const created = await admin.admin.next();
    if (!created.ok) throw new Error(`${count}: create failed: ${created.message}`);
    const registration = await waitFor(() => admin.state?.state === "registration" && admin.state);
    for (let i = 0; i < count; i++) {
      clients[i].s.emit("grandEventJoin");
      const joined = await clients[i].action.next();
      if (!joined.ok) throw new Error(`${count}: seed ${i + 1} join failed: ${joined.message}`);
    }
    admin.s.emit("grandEventStart");
    const started = await admin.admin.next();
    if (!started.ok) throw new Error(`${count}: start failed: ${started.message}`);
    const complete = await waitFor(
      () => admin.state?.id === registration.id && admin.state?.state === "complete" && admin.state,
      30_000,
      `${count}-player completion`,
    );
    const shape = complete.rounds.map((r) => r.matches.length);
    if (JSON.stringify(shape) !== JSON.stringify(expected[count])) {
      throw new Error(`${count}: bracket shape ${shape.join(",")} != ${expected[count].join(",")}`);
    }
    if (complete.champion?.seed !== 1 || complete.champion?.pot !== count * 150) {
      throw new Error(`${count}: deterministic champion/pot mismatch`);
    }
    const ledger = (await pool.query(
      `SELECT kind,count(*)::int AS n,sum(amount)::int AS amount
         FROM jpo_grand_event_payouts WHERE event_id=$1 GROUP BY kind`,
      [registration.id],
    )).rows;
    if (ledger.length !== 1 || ledger[0].kind !== "champion" || ledger[0].n !== 1 || ledger[0].amount !== count * 150) {
      throw new Error(`${count}: payout ledger mismatch ${JSON.stringify(ledger)}`);
    }
    console.log(`  ✓ ${count} players: ${shape.join(" → ")} matches; seed 1 champion; ${count * 150}-coin pot`);
  }

  const total = Number((await pool.query(
    `SELECT sum(coins)::int AS coins FROM jpo_players WHERE email=ANY($1::text[])`,
    [emails],
  )).rows[0].coins);
  if (total !== 16 * 5000) throw new Error(`coin conservation failed: ${total}`);
  console.log("RESULT: PASS (10/12/14/16 live bracket lifecycles)");
} finally {
  clients.forEach((c) => c.s.close());
  if (server?.exitCode == null) {
    server.kill("SIGKILL");
    await once(server, "exit").catch(() => {});
  }
  await pool.query(`DELETE FROM jpo_grand_events WHERE created_by=$1`, [emails[0]]).catch(() => {});
  await pool.query(`DELETE FROM jpo_players WHERE email=ANY($1::text[])`, [emails]).catch(() => {});
  await pool.end();
}