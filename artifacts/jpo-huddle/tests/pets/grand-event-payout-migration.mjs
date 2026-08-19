// A legacy Grand Event ledger could key payouts by recipient as well as match,
// permitting two winners to receive the same semantic reward. Startup must
// refuse that database rather than run without the new uniqueness invariant.
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createRequire } from "node:module";

const require = createRequire("/home/runner/workspace/artifacts/jpo-huddle/server.js");
const pg = require("pg");
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const schema = `ge_legacy_${Math.random().toString(36).slice(2, 10)}`;
const eventId = `legacy-${Math.random().toString(36).slice(2)}`;
let server;
let serverExited = false;

try {
  await pool.query(`CREATE SCHEMA ${schema}`);
  await pool.query(`CREATE TABLE ${schema}.jpo_grand_events (
    id text PRIMARY KEY,
    state text NOT NULL,
    config jsonb NOT NULL DEFAULT '{}'::jsonb,
    snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_by text NOT NULL DEFAULT '',
    champion_email text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    completed_at timestamptz
  )`);
  await pool.query(`CREATE TABLE ${schema}.jpo_grand_event_payouts (
    event_id text NOT NULL REFERENCES ${schema}.jpo_grand_events(id) ON DELETE CASCADE,
    payout_key text NOT NULL,
    email text NOT NULL,
    amount integer NOT NULL CHECK (amount > 0),
    kind text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (event_id,payout_key,email)
  )`);
  await pool.query(`INSERT INTO ${schema}.jpo_grand_events (id,state) VALUES ($1,'complete')`, [eventId]);
  await pool.query(
    `INSERT INTO ${schema}.jpo_grand_event_payouts (event_id,payout_key,email,amount,kind)
     VALUES ($1,'round:match-1','winner-a@test.local',100,'round'),
            ($1,'round:match-1','winner-b@test.local',100,'round')`,
    [eventId],
  );

  server = spawn("node", ["server.js"], {
    cwd: "/home/runner/workspace/artifacts/jpo-huddle",
    env: {
      ...process.env,
      PORT: "20993",
      PGOPTIONS: `-c search_path=${schema},public`,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  server.stdout.on("data", (data) => { output += String(data); });
  server.stderr.on("data", (data) => { output += String(data); });
  const timer = setTimeout(() => server.kill("SIGKILL"), 30_000);
  const [code] = await once(server, "exit");
  serverExited = true;
  clearTimeout(timer);
  if (code === 0) throw new Error("server accepted a conflicting legacy payout ledger");
  if (!output.includes("Grand Event payout ledger is unsafe; refusing to start")) {
    throw new Error(`server failed for the wrong reason:\n${output}`);
  }
  console.log("Grand Event legacy duplicate-ledger migration: PASS (startup failed closed)");
} finally {
  if (server && !serverExited) {
    server.kill("SIGKILL");
    await once(server, "exit").catch(() => {});
  }
  await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => {});
  await pool.end();
}