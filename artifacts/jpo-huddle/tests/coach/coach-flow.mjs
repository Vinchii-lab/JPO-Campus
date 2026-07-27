// Coach flow: npcState → proximity reject → intake → mission → reroll → reroll exhausted
import { io } from "socket.io-client";
import { createRequire } from "module";
const require = createRequire("/home/runner/workspace/artifacts/jpo-huddle/server.js");
const pg = require("pg");

const PORT = process.env.TEST_PORT;
if (!PORT) { console.error("TEST_PORT missing"); process.exit(1); }
const URL = `http://localhost:${PORT}`;
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

const rand = Math.random().toString(36).slice(2, 8);
const EMAIL_A = `coach-a-${rand}@justpressone.com`.toLowerCase();
const EMAIL_B = `coach-b-${rand}@justpressone.com`.toLowerCase();
const MISSION_TYPES = ["play_new", "play_dept", "play_person", "whisper_person", "coffee_crowd"];

const fails = [];
const ok = (cond, label) => { console.log((cond ? "  ✓ " : "  ✗ ") + label); if (!cond) fails.push(label); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function queue(socket, name) {
  const q = { items: [], waiters: [] };
  socket.on(name, (d) => {
    const w = q.waiters.shift();
    if (w) w(d); else q.items.push(d);
  });
  q.next = (timeoutMs = 15000, label = name) => new Promise((res, rej) => {
    if (q.items.length) return res(q.items.shift());
    const t = setTimeout(() => rej(new Error(`timeout waiting for ${label}`)), timeoutMs);
    q.waiters.push((d) => { clearTimeout(t); res(d); });
  });
  return q;
}

async function cleanup() {
  await pool.query(`DELETE FROM jpo_coach WHERE email LIKE 'coach-%@justpressone.com'`);
  await pool.query(`DELETE FROM jpo_pair_plays WHERE email_a LIKE 'coach-%' OR email_b LIKE 'coach-%'`);
  await pool.query(`DELETE FROM jpo_players WHERE email LIKE 'coach-%@justpressone.com'`);
}

try {
  await cleanup();
  // A = the tester; B = a recently-active coworker so the candidate roster is non-empty.
  await pool.query(
    `INSERT INTO jpo_players (email, first_name, last_name, name, character, approved, department, last_daily_bonus)
     VALUES ($1, 'Alpha', 'Coachtest', 'Alpha Coachtest', 'adam', true, 'HR', NULL),
            ($2, 'Beta',  'Coachtest', 'Beta Coachtest',  'bob',  true, 'IT', CURRENT_DATE)`,
    [EMAIL_A, EMAIL_B]);
  console.log("seeded", EMAIL_A, EMAIL_B);

  const s = io(URL, { transports: ["websocket"], reconnection: false });
  const qApproved = queue(s, "approved");
  const qNpcState = queue(s, "npcState");
  const qPanel    = queue(s, "coachPanel");
  const qMission  = queue(s, "coachMission");
  const qErr      = queue(s, "interactError");
  let npcMovedCount = 0, lastNpc = null;
  s.on("npcMoved", (d) => { npcMovedCount++; lastNpc = d; });

  await new Promise((res, rej) => { s.on("connect", res); s.on("connect_error", rej); });
  s.emit("register", { firstName: "Alpha", lastName: "Coachtest", email: EMAIL_A, password: "testpass123", character: "adam", department: "HR" });
  const approved = await qApproved.next(15000, "approved");
  ok(true, "A approved+restored");

  const npc = await qNpcState.next(8000, "npcState");
  ok(npc && npc.name === "Huddles" && Number.isFinite(npc.x) && Number.isFinite(npc.y), `npcState snapshot (${npc?.x},${npc?.y} ${npc?.anim})`);

  // 1. Too far away → proximity rejection
  s.emit("coachInteract");
  const far = await qErr.next(6000, "interactError(far)");
  ok(/Huddles/i.test(far?.message || ""), `proximity reject: "${far?.message}"`);

  // 1b. Intake without ever having talked to Huddles → session gate rejects
  s.emit("coachIntake", { goal: "meet_new", depts: [] });
  const noSess = await qErr.next(6000, "interactError(no session)");
  ok(/Huddles/i.test(noSess?.message || ""), `intake without a talk session rejected: "${noSess?.message}"`);

  // Give the wander ticker a moment (also samples whether the NPC actually walks)
  await sleep(2500);
  console.log(`  npcMoved events so far: ${npcMovedCount}${lastNpc ? ` (last ${lastNpc.x},${lastNpc.y} ${lastNpc.anim})` : ""}`);

  // 2. First playerMove = bounds-only baseline → park right on the NPC, then talk
  const tx = lastNpc ? lastNpc.x : npc.x, ty = lastNpc ? lastNpc.y : npc.y;
  s.emit("playerMove", { x: tx, y: ty, dir: "down", anim: "idle" });
  await sleep(250);
  s.emit("coachInteract");
  const p1 = await qPanel.next(6000, "coachPanel(intake)");
  ok(p1?.needIntake === true && Array.isArray(p1?.departments) && p1.departments.length === 9, "intake panel with 9 departments");

  // 3. Intake → generating → mission (AI or fallback, ≤ ~12s)
  s.emit("coachIntake", { goal: "cross_team", depts: ["IT", "QA"] });
  const gen = await qPanel.next(6000, "coachPanel(generating)");
  ok(gen?.generating === true, "generating panel");
  const m1 = (await qMission.next(20000, "coachMission#1"))?.mission;
  console.log("  mission#1:", JSON.stringify(m1));
  ok(m1 && MISSION_TYPES.includes(m1.type), "mission type on the allowlist");
  ok(typeof m1?.label === "string" && m1.label.length > 5, "mission has a label");
  ok(m1?.reward === 50 && m1?.done === false && m1?.canReroll === true, "reward 50, not done, can re-roll");

  // 4. Re-roll (one per day)
  await sleep(2600);   // bucket refill
  s.emit("coachReroll");
  const gen2 = await qPanel.next(6000, "coachPanel(generating#2)");
  ok(gen2?.generating === true, "re-roll → generating");
  const m2 = (await qMission.next(20000, "coachMission#2"))?.mission;
  console.log("  mission#2:", JSON.stringify(m2));
  ok(m2 && MISSION_TYPES.includes(m2.type), "re-rolled mission on the allowlist");
  ok(m2?.canReroll === false, "re-roll spent");

  // 5. Second re-roll → rejected
  await sleep(2600);
  s.emit("coachReroll");
  const noRe = await qErr.next(6000, "interactError(reroll spent)");
  ok(/re-?roll/i.test(noRe?.message || ""), `second re-roll rejected: "${noRe?.message}"`);

  // 6. Replayed intake after a mission exists → cheap idempotent re-emit (no regeneration)
  await sleep(2600);
  s.emit("coachIntake", { goal: "cross_team", depts: ["IT"] });
  const m3 = (await qMission.next(8000, "coachMission#3 (idempotent)"))?.mission;
  ok(m3?.type === m2?.type && m3?.label === m2?.label && m3?.canReroll === false, "replayed intake re-emits today's mission unchanged");

  // 7. DB state sane
  const { rows } = await pool.query(`SELECT mission_date = CURRENT_DATE AS today, rerolled, mission_done_at, intake FROM jpo_coach WHERE email = $1`, [EMAIL_A]);
  ok(rows[0]?.today === true && rows[0]?.rerolled === true && rows[0]?.mission_done_at === null, "jpo_coach row: today, rerolled, not done");
  ok(rows[0]?.intake?.goal === "cross_team", "intake persisted");

  s.disconnect();
} catch (err) {
  console.error("FATAL:", err.message);
  fails.push("fatal: " + err.message);
} finally {
  await cleanup().catch(() => {});
  await pool.end().catch(() => {});
}
console.log(fails.length ? `RESULT: FAIL (${fails.length}): ${fails.join(" | ")}` : "RESULT: PASS");
process.exit(fails.length ? 1 : 0);
