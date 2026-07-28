// Voice signaling relay: near-pair relays, distance/size/NPC/self drops,
// rate limiting, talking-badge broadcast, and After Dark split isolation.
// The server never parses SDP — these fake payloads only prove RELAY rules.
import { io } from "socket.io-client";
import { createRequire } from "module";
const require = createRequire("/home/runner/workspace/artifacts/jpo-huddle/server.js");
const pg = require("pg");

const PORT = process.env.TEST_PORT;
if (!PORT) { console.error("TEST_PORT missing"); process.exit(1); }
const URL = `http://localhost:${PORT}`;
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

const rand = Math.random().toString(36).slice(2, 8);
const EMAILS = ["a", "b", "c", "d", "e"].map((k) => `voice-${k}-${rand}@justpressone.com`.toLowerCase());

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
    // On timeout the waiter MUST be removed, or the next real event is
    // swallowed by the dead waiter (bit us: a 50ms silent-drain before a
    // later .next() on the same queue ate the awaited playerJoined).
    const w = (d) => { clearTimeout(t); res(d); };
    const t = setTimeout(() => { const i = q.waiters.indexOf(w); if (i >= 0) q.waiters.splice(i, 1); rej(new Error(`timeout waiting for ${label}`)); }, timeoutMs);
    q.waiters.push(w);
  });
  q.drain = () => { q.items.length = 0; };
  // settle window: resolves with everything that arrives in the next N ms
  q.collect = async (ms) => { await sleep(ms); const got = q.items.slice(); q.items.length = 0; return got; };
  return q;
}

async function cleanup() {
  await pool.query(`DELETE FROM jpo_players WHERE email LIKE 'voice-%@justpressone.com'`);
}

const socks = [];
async function join(email, first) {
  const s = io(URL, { transports: ["websocket"], reconnection: false });
  socks.push(s);
  const q = {
    approved: queue(s, "approved"),
    sig: queue(s, "voiceSignal"),
    talk: queue(s, "voiceTalking"),
    begin: queue(s, "roundBegin"),
    rerr: queue(s, "roundError"),
  };
  await new Promise((res, rej) => { s.on("connect", res); s.on("connect_error", rej); });
  s.emit("register", { firstName: first, lastName: "Voicetest", email, password: "testpass123", character: "adam", department: "IT" });
  await q.approved.next(15000, `approved(${first})`);
  return { s, q, id: () => s.id };
}

try {
  await cleanup();
  await pool.query(
    `INSERT INTO jpo_players (email, first_name, last_name, name, character, approved, department)
     SELECT e, initcap(split_part(e, '-', 2)), 'Voicetest', initcap(split_part(e, '-', 2)) || ' Voicetest', 'adam', true, 'IT'
     FROM unnest($1::text[]) AS e`, [EMAILS]);
  console.log("seeded", EMAILS.join(", "));

  const [A, B, C, D, E] = await Promise.all(EMAILS.map((em, i) => join(em, "ABCDE"[i])));
  ok(true, "A–E registered and restored into the office (all at grass spawn)");

  // E walks far away. The FIRST *accepted* playerMove after joining is a
  // bounds-only baseline, but void/unpainted spots are still rejected — so
  // try several far candidates and confirm one landed via A's playerMoved
  // feed (rejected moves never update lastMoveAt, so each retry is still a
  // baseline).
  const SP = { x: 26 * 48 + 24, y: 47 * 48 + 24 - 27 };   // GRASS_SPAWN (TILE_PX = 48)
  const qMovedA = queue(A.s, "playerMoved");
  const farSpots = [
    [SP.x, SP.y - 1200], [SP.x + 1200, SP.y - 300], [SP.x + 900, SP.y - 900],
    [SP.x - 900, SP.y - 900], [SP.x + 1500, SP.y], [SP.x, SP.y - 1600],
  ];
  let eMoved = null;
  for (const [fx, fy] of farSpots) {
    qMovedA.drain();
    E.s.emit("playerMove", { x: fx, y: fy, dir: "up", anim: "idle" });
    const got = (await qMovedA.collect(700)).filter((m) => m.id === E.id());
    if (got.length) { eMoved = got[got.length - 1]; break; }
  }
  A.s.off("playerMoved");   // stop buffering the whole office's move stream
  const eDist = eMoved ? Math.hypot(eMoved.x - SP.x, eMoved.y - SP.y) : 0;
  ok(eMoved && eDist > 800, `E parked far away (${eMoved ? Math.round(eDist) + "px" : "no accepted move"} from spawn)`);

  // 1. Near pair relays, opaquely, both directions
  A.s.emit("voiceSignal", { targetId: B.id(), data: { k: "offer", sdp: { type: "offer", sdp: "x".repeat(500) } } });
  const gotB = await B.q.sig.next(4000, "B←A offer");
  ok(gotB?.fromId === A.id() && gotB?.data?.k === "offer" && gotB.data.sdp.sdp.length === 500, "near pair: offer relayed A→B intact");
  B.s.emit("voiceSignal", { targetId: A.id(), data: { k: "answer", sdp: { type: "answer", sdp: "y" } } });
  const gotA = await A.q.sig.next(4000, "A←B answer");
  ok(gotA?.fromId === B.id() && gotA?.data?.k === "answer", "near pair: answer relayed B→A");

  // 2. Distant pair is refused (E is ~1200px away; earshot+slack is 740px)
  A.s.emit("voiceSignal", { targetId: E.id(), data: { k: "offer", sdp: "far" } });
  ok((await E.q.sig.collect(900)).length === 0, "distant pair: relay silently dropped");

  // 3. Oversized payload is refused (>40KB), and ICE gets a tighter cap (4KB)
  B.q.sig.drain();
  A.s.emit("voiceSignal", { targetId: B.id(), data: { k: "offer", sdp: "z".repeat(45000) } });
  ok((await B.q.sig.collect(900)).length === 0, "oversized payload: dropped");
  A.s.emit("voiceSignal", { targetId: B.id(), data: { k: "ice", c: "z".repeat(10000) } });
  ok((await B.q.sig.collect(900)).length === 0, "oversized ICE (10KB fake candidate): dropped");
  A.s.emit("voiceSignal", { targetId: B.id(), data: { k: "ice", c: { candidate: "normal", mid: "0" } } });
  ok((await B.q.sig.next(4000, "B←A normal ice"))?.data?.k === "ice", "normal-sized ICE still relays");

  // 4. NPC / self / junk targets: no crash, and the lane stays healthy after
  A.s.emit("voiceSignal", { targetId: "npc:huddles", data: { k: "offer" } });
  A.s.emit("voiceSignal", { targetId: A.id(), data: { k: "offer" } });
  A.s.emit("voiceSignal", { targetId: 42, data: { k: "offer" } });
  A.s.emit("voiceSignal", null);
  await sleep(300);
  A.s.emit("voiceSignal", { targetId: B.id(), data: { k: "ice", c: { candidate: "c" } } });
  const after = await B.q.sig.next(4000, "B←A ice after junk");
  ok(after?.data?.k === "ice", "npc/self/junk targets dropped; relay still healthy after");

  // 5. Talking badge broadcast (no round: everyone gets it, sender included)
  A.s.emit("voiceTalking", { on: true });
  const [tA, tB, tE] = await Promise.all([
    A.q.talk.next(4000, "A badge echo"),
    B.q.talk.next(4000, "B sees A badge"),
    E.q.talk.next(4000, "E sees A badge"),
  ]);
  ok([tA, tB, tE].every((t) => t?.id === A.id() && t?.on === true), "badge on: broadcast to all (sender echoed)");
  A.s.emit("voiceTalking", { on: false });
  const offB = await B.q.talk.next(4000, "B sees A badge off");
  ok(offB?.id === A.id() && offB?.on === false, "badge off: broadcast");

  // 6. Rate limit: a 200-signal blast lands ~80 (bucket) + refill, never all
  B.q.sig.drain();
  for (let i = 0; i < 200; i++) A.s.emit("voiceSignal", { targetId: B.id(), data: { k: "ice", i } });
  const blast = (await B.q.sig.collect(2500)).length;
  ok(blast >= 40 && blast <= 130, `rate limit: 200-blast → ${blast} relayed (bucket ~80 + refill)`);

  // 7. After Dark: A,B,C in the round (dark), D,E lit outside it
  console.log("  starting a round (30s join window — this section is slow)…");
  A.s.emit("roundStart");
  await sleep(1000);
  B.s.emit("roundJoin"); C.s.emit("roundJoin");
  const raced = await Promise.race([
    A.q.begin.next(45000, "roundBegin"),
    A.q.rerr.next(45000, "roundError").then((e) => ({ __err: e })),
  ]).catch((e) => ({ __timeout: e }));
  if (raced && raced.__err) {
    console.log(`  ! SKIPPED round section (server said: "${raced.__err?.message}") — likely a real round in progress`);
  } else if (raced && raced.__timeout) {
    ok(false, "roundBegin arrived");
  } else {
    ok(Array.isArray(raced?.players) && raced.players.length >= 3, `round began with ${raced?.players?.length} members`);
    await sleep(500);
    // dark↔dark near pair still relays
    B.q.sig.drain();
    A.s.emit("voiceSignal", { targetId: B.id(), data: { k: "offer", sdp: "dark" } });
    const dark = await B.q.sig.next(4000, "B←A in the dark");
    ok(dark?.data?.sdp === "dark", "dark↔dark near pair still relays");
    // lit→dark refused both ways (D is at spawn beside A — distance passes, split fails)
    A.q.sig.drain(); D.q.sig.drain();
    D.s.emit("voiceSignal", { targetId: A.id(), data: { k: "offer", sdp: "cross" } });
    A.s.emit("voiceSignal", { targetId: D.id(), data: { k: "offer", sdp: "cross" } });
    const [crossA, crossD] = await Promise.all([A.q.sig.collect(900), D.q.sig.collect(900)]);
    ok(crossA.length === 0 && crossD.length === 0, "lit↔dark pair: refused in both directions");
    // badges: lit D's badge reaches lit E but NOT dark A; dark A's badge reaches everyone
    A.q.talk.drain(); E.q.talk.drain(); D.q.talk.drain();
    D.s.emit("voiceTalking", { on: true });
    const litSeen = await E.q.talk.next(4000, "E sees D badge");
    ok(litSeen?.id === D.id() && litSeen.on === true, "lit badge → lit players");
    ok((await A.q.talk.collect(900)).filter((t) => t.id === D.id()).length === 0, "lit badge NEVER reaches the dark");
    D.q.talk.drain();
    A.s.emit("voiceTalking", { on: true });
    const darkSeen = await D.q.talk.next(4000, "D sees A badge");
    ok(darkSeen?.id === A.id() && darkSeen.on === true, "dark badge → everyone (public drama, like their chat)");
  }
} catch (err) {
  console.error("ERROR:", err?.message || err);
  fails.push(String(err?.message || err));
} finally {
  for (const s of socks) { try { s.disconnect(); } catch {} }
  try { await cleanup(); } catch {}
  await pool.end().catch(() => {});
}

if (fails.length) { console.log(`RESULT: FAIL (${fails.length}: ${fails.join(" | ")})`); process.exit(1); }
console.log("RESULT: PASS");
process.exit(0);
