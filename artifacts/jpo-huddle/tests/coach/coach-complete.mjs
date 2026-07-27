// Mission completion paths: play_new via a real RPS win (draws share this hook),
// QD armed-tap forfeit NOT counting, whisper both-ways, coffee_crowd via machine brew.
import { io } from "socket.io-client";
import { createRequire } from "module";
const require = createRequire("/home/runner/workspace/artifacts/jpo-huddle/server.js");
const pg = require("pg");

const PORT = process.env.TEST_PORT;
if (!PORT) { console.error("TEST_PORT missing"); process.exit(1); }
const URL = `http://localhost:${PORT}`;
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

const rand = Math.random().toString(36).slice(2, 8);
const EM = {
  a: `coachx-a-${rand}@justpressone.com`,
  b: `coachx-b-${rand}@justpressone.com`,
  c: `coachx-c-${rand}@justpressone.com`,
};
const fails = [];
const ok = (cond, label) => { console.log((cond ? "  ✓ " : "  ✗ ") + label); if (!cond) fails.push(label); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function queue(socket, name) {
  const q = { items: [], waiters: [] };
  socket.on(name, (d) => { const w = q.waiters.shift(); if (w) w(d); else q.items.push(d); });
  q.next = (timeoutMs = 15000, label = name) => new Promise((res, rej) => {
    if (q.items.length) return res(q.items.shift());
    const t = setTimeout(() => rej(new Error(`timeout waiting for ${label}`)), timeoutMs);
    q.waiters.push((d) => { clearTimeout(t); res(d); });
  });
  return q;
}

async function cleanup() {
  await pool.query(`DELETE FROM jpo_coach WHERE email LIKE 'coachx-%@justpressone.com'`);
  await pool.query(`DELETE FROM jpo_pair_plays WHERE email_a LIKE 'coachx-%' OR email_b LIKE 'coachx-%'`);
  await pool.query(`DELETE FROM jpo_players WHERE email LIKE 'coachx-%@justpressone.com'`);
}

async function connectPlayer(email, first, char) {
  const s = io(URL, { transports: ["websocket"], reconnection: false });
  const qA = queue(s, "approved");
  s.state = {
    approved: qA, joined: queue(s, "playerJoined"), current: queue(s, "currentPlayers"),
    mission: queue(s, "missionComplete"), cheer: queue(s, "missionCheer"),
    incoming: queue(s, "rpsChallengeIncoming"), start: queue(s, "rpsStart"),
    result: queue(s, "rpsResult"), coin: queue(s, "coinUpdate"),
  };
  s.missionCompletes = [];
  s.on("missionComplete", (d) => s.missionCompletes.push(d));
  await new Promise((res, rej) => { s.on("connect", res); s.on("connect_error", rej); });
  s.emit("register", { firstName: first, lastName: "Xtest", email, password: "testpass123", character: char, department: "HR" });
  await qA.next(15000, `approved(${first})`);
  return s;
}

// Find another player's live socket id via the currentPlayers roster (scoped by email)
async function sidOf(sock, email) {
  const roster = await sock.state.current.next(10000, "currentPlayers");
  for (const [sid, p] of Object.entries(roster)) if (p.email === email) return sid;
  return null;
}

try {
  await cleanup();
  await pool.query(
    `INSERT INTO jpo_players (email, first_name, last_name, name, character, approved, department)
     VALUES ($1,'Ax','Xtest','Ax Xtest','adam',true,'HR'),
            ($2,'Bx','Xtest','Bx Xtest','bob',true,'IT'),
            ($3,'Cx','Xtest','Cx Xtest','alex',true,'QA')`,
    [EM.a, EM.b, EM.c]);
  // Deterministic missions straight in the DB (generation is covered by the other script):
  await pool.query(
    `INSERT INTO jpo_coach (email, intake, intake_at, mission_date, mission, rerolled) VALUES
     ($1, '{"goal":"meet_new","depts":[]}', now(), CURRENT_DATE, $4::jsonb, false),
     ($2, '{"goal":"meet_new","depts":[]}', now(), CURRENT_DATE, $5::jsonb, false),
     ($3, '{"goal":"meet_new","depts":[]}', now(), CURRENT_DATE, $6::jsonb, false)`,
    [EM.a, EM.b, EM.c,
     JSON.stringify({ type: "play_new", flavor: "t", reward: 50, by: "test" }),
     JSON.stringify({ type: "whisper_person", target_email: EM.a, target_name: "Ax", flavor: "t", reward: 50, by: "test" }),
     JSON.stringify({ type: "coffee_crowd", n: 2, flavor: "t", reward: 50, by: "test" })]);
  console.log("seeded", EM.a, EM.b, EM.c);

  const A = await connectPlayer(EM.a, "Ax", "adam");
  const B = await connectPlayer(EM.b, "Bx", "bob");
  const aSid = await sidOf(B, EM.a);              // B's roster includes A
  const bJoin = await A.state.joined.next(8000, "playerJoined(B)"); // A sees B join
  const bSid = bJoin.id;
  ok(!!aSid && !!bSid, `live ids resolved (A=${aSid}, B=${bSid})`);

  // ── 1. play_new completes via a real RPS win (non-forfeit settle) ──
  A.emit("rpsChallenge", { targetId: bSid, wager: 0, game: "rps" });
  const inc = await B.state.incoming.next(8000, "rpsChallengeIncoming");
  B.emit("rpsRespond", { challengeId: inc.challengeId, accept: true });
  await Promise.all([A.state.start.next(8000, "rpsStart(A)"), B.state.start.next(8000, "rpsStart(B)")]);
  A.emit("rpsPick", { challengeId: inc.challengeId, pick: "rock" });
  B.emit("rpsPick", { challengeId: inc.challengeId, pick: "scissors" });
  const mcA = await A.state.mission.next(10000, "missionComplete(A)");
  ok(mcA?.reward === 50 && /never played/i.test(mcA?.label || ""), `A mission complete: "${mcA?.label}" +${mcA?.reward}`);
  ok(Number.isFinite(mcA?.coins) && mcA.coins >= 110, `A coins ${mcA?.coins} >= 110 (50 seed +10 daily +50 mission)`);
  const cheer = await B.state.cheer.next(8000, "missionCheer at B");
  ok(cheer?.id === aSid, "everyone sees A's cheer");
  let r = await pool.query(`SELECT games FROM jpo_pair_plays WHERE email_a = LEAST($1::text,$2::text) AND email_b = GREATEST($1::text,$2::text)`, [EM.a, EM.b]);
  ok(r.rows[0]?.games === 1, `pair history games=1`);
  r = await pool.query(`SELECT mission_done_at FROM jpo_coach WHERE email = $1`, [EM.a]);
  ok(r.rows[0]?.mission_done_at !== null, "A's jpo_coach marked done");

  // ── 2. QD armed-tap = forfeit → pair NOT recorded ──
  await sleep(2200);   // rps bucket pacing
  B.emit("rpsChallenge", { targetId: aSid, wager: 0, game: "qd" });
  const inc2 = await A.state.incoming.next(8000, "rpsChallengeIncoming(qd)");
  A.emit("rpsRespond", { challengeId: inc2.challengeId, accept: true });
  await B.state.start.next(8000, "rpsStart(qd)");
  B.emit("qdTap", { challengeId: inc2.challengeId });   // firing while armed = instant forfeit loss
  await B.state.result.next(8000, "rpsResult(qd)");
  await sleep(1500);   // let any (wrong) hook land
  r = await pool.query(`SELECT games FROM jpo_pair_plays WHERE email_a = LEAST($1::text,$2::text) AND email_b = GREATEST($1::text,$2::text)`, [EM.a, EM.b]);
  ok(r.rows[0]?.games === 1, `forfeit did NOT touch pair history (games still 1)`);

  // ── 3. Whisper mission: one way is not enough, both ways completes B ──
  A.emit("whisper", { targetId: bSid, message: "hello from A" });
  await sleep(2000);
  ok(B.missionCompletes.length === 0, "one-way whisper does NOT complete");
  B.emit("whisper", { targetId: aSid, message: "hello back" });
  const mcB = await B.state.mission.next(8000, "missionComplete(B)");
  ok(mcB?.reward === 50 && /whisper/i.test(mcB?.label || ""), `B whisper mission complete: "${mcB?.label}"`);

  // ── 4. coffee_crowd: brew at the machine with 2 coworkers around ──
  const C = await connectPlayer(EM.c, "Cx", "alex");
  // First playerMove is the bounds-only baseline → park everyone at the machine
  for (const s of [A, B, C]) s.emit("playerMove", { x: 4800, y: 1776, dir: "down", anim: "idle" });
  await sleep(400);
  C.emit("interact", { object: "coffee_machine5" });
  const mcC = await C.state.mission.next(10000, "missionComplete(C)");
  ok(mcC?.reward === 50 && /coworkers around/i.test(mcC?.label || ""), `C coffee mission complete: "${mcC?.label}"`);
  r = await pool.query(`SELECT mission_done_at FROM jpo_coach WHERE email = $1`, [EM.c]);
  ok(r.rows[0]?.mission_done_at !== null, "C's jpo_coach marked done");

  A.disconnect(); B.disconnect(); C.disconnect();
} catch (err) {
  console.error("FATAL:", err.message);
  fails.push("fatal: " + err.message);
} finally {
  await cleanup().catch(() => {});
  await pool.end().catch(() => {});
}
console.log(fails.length ? `RESULT: FAIL (${fails.length}): ${fails.join(" | ")}` : "RESULT: PASS");
process.exit(fails.length ? 1 : 0);
