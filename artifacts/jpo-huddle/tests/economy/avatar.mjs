// Avatar makeover: first change FREE, later changes cost AVATAR_PRICE (100),
// no-op rejected, broadcast carries the new character. Throwaway server.
// Run: node tests/economy/avatar.mjs   (needs DATABASE_URL + ADMIN_PASSWORD)
import { io } from "socket.io-client";
import { spawn } from "child_process";
import { createRequire } from "module";
const require = createRequire("/home/runner/workspace/artifacts/jpo-huddle/server.js");
const pg = require("pg");

const PORT = process.env.TEST_AVATAR_PORT || "20978";
const URL = `http://localhost:${PORT}`;
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

const rand = Math.random().toString(36).slice(2, 8);
const E_A = `avt-a-${rand}@justpressone.com`;
const E_B = `avt-b-${rand}@justpressone.com`;

const fails = [];
const ok = (c, l) => { console.log((c ? "  ✓ " : "  ✗ ") + l); if (!c) fails.push(l); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function queue(socket, name) {
  const q = { items: [], waiters: [] };
  socket.on(name, (d) => { const w = q.waiters.shift(); if (w) w(d); else q.items.push(d); });
  q.next = (timeoutMs = 15000, label = name) => new Promise((res, rej) => {
    if (q.items.length) return res(q.items.shift());
    const w = (d) => { clearTimeout(t); res(d); };
    const t = setTimeout(() => { const i = q.waiters.indexOf(w); if (i >= 0) q.waiters.splice(i, 1); rej(new Error(`timeout waiting for ${label}`)); }, timeoutMs);
    q.waiters.push(w);
  });
  q.drain = () => { q.items.length = 0; };
  return q;
}
const rowOf = async (email) =>
  (await pool.query(`SELECT coins, character, hair_idx, avatar_changes FROM jpo_players WHERE email=$1`, [email])).rows[0];
const cleanup = () => pool.query(`DELETE FROM jpo_players WHERE email LIKE 'avt-%@justpressone.com'`);

const connect = (email, first, character) => {
  const s = io(URL, { transports: ["websocket"], reconnection: false });
  const p = new Promise((res, rej) => { s.on("connect", res); s.on("connect_error", rej); });
  return { s, ready: p.then(() => s.emit("register", {
    firstName: first, lastName: "Avt", email, password: "testpass123", character, department: "IT",
  })) };
};

// ── throwaway server ──
const server = spawn("node", ["server.js"], {
  cwd: "/home/runner/workspace/artifacts/jpo-huddle",
  env: { ...process.env, PORT },
  stdio: ["ignore", "pipe", "pipe"],
});
server.stderr.on("data", (d) => process.stderr.write(`[srv] ${d}`));
await new Promise((res, rej) => {
  const t = setTimeout(() => rej(new Error("server didn't boot")), 20000);
  server.stdout.on("data", (d) => { if (String(d).includes("running on port")) { clearTimeout(t); res(); } });
});

try {
  await cleanup();
  await pool.query(
    `INSERT INTO jpo_players (email, first_name, last_name, name, character, approved, coins, cosmetics, last_daily_bonus)
     VALUES ($1,'Ava','Avt','Ava Avt','adam',true,1000,ARRAY[]::text[],CURRENT_DATE),
            ($2,'Ben','Avt','Ben Avt','bob', true,1000,ARRAY[]::text[],CURRENT_DATE)`,
    [E_A, E_B]);
  console.log("seeded", rand);
  const A = connect(E_A, "Ava", "adam");
  const B = connect(E_B, "Ben", "bob");
  const aOk = queue(A.s, "avatarSuccess"), aErr = queue(A.s, "shopError"), aCoin = queue(A.s, "coinUpdate");
  const bBroadcast = queue(B.s, "playerOutfitUpdate");
  const aApproved = queue(A.s, "approved");
  await Promise.all([A.ready, B.ready]);
  const approvedA = await aApproved.next(15000, "A approved");
  ok(approvedA.avatarChanges === 0, "approved payload carries avatarChanges=0");
  await sleep(500);
  const before = await rowOf(E_A);

  // no-op look rejected
  A.s.emit("changeAvatar", { character: "adam", hairIdx: before.hair_idx });
  const e1 = await aErr.next(8000, "no-op rejected");
  ok(/already/i.test(e1), "same look rejected without charge");

  // bad payloads ignored (no crash, no state change)
  A.s.emit("changeAvatar", { character: "shrek", hairIdx: 2 });
  A.s.emit("changeAvatar", { character: "alex", hairIdx: 99 });
  await sleep(600);
  ok((await rowOf(E_A)).avatar_changes === 0, "invalid character/hair silently ignored");

  // first makeover: FREE
  bBroadcast.drain();
  A.s.emit("changeAvatar", { character: "amelia", hairIdx: 3 });
  const s1 = await aOk.next(8000, "first avatarSuccess");
  ok(s1.character === "amelia" && s1.hairIdx === 3, "first makeover applied (amelia, hair 3)");
  ok(s1.avatarChanges === 1, "change counter = 1");
  await aCoin.next(8000, "coinUpdate after free change");
  const r1 = await rowOf(E_A);
  ok(r1.coins === before.coins, "first makeover was FREE (coins unchanged)");
  ok(r1.character === "amelia" && r1.hair_idx === 3, "DB row updated");
  const bc = await bBroadcast.next(8000, "broadcast to others");
  ok(bc.character === "amelia" && bc.hairIdx === 3, "others told the new character + hair");

  // second makeover: costs 100
  A.s.emit("changeAvatar", { character: "alex", hairIdx: 5 });
  const s2 = await aOk.next(8000, "second avatarSuccess");
  ok(s2.avatarChanges === 2, "change counter = 2");
  const r2 = await rowOf(E_A);
  ok(r2.coins === before.coins - 100, "second makeover charged 100 coins");
  ok(r2.character === "alex" && r2.hair_idx === 5, "DB row updated again");

  // broke player can't pay for a second change
  await pool.query(`UPDATE jpo_players SET coins = 10 WHERE email=$1`, [E_A]);
  A.s.emit("changeAvatar", { character: "bob", hairIdx: 1 });
  const e2 = await aErr.next(8000, "broke rejection");
  ok(/coins/i.test(e2), "not enough coins → rejected");
  ok((await rowOf(E_A)).character === "alex", "look unchanged after failed purchase");

  A.s.close(); B.s.close();
} catch (err) {
  console.error("TEST ERROR:", err.message);
  fails.push(err.message);
} finally {
  await cleanup().catch(() => {});
  server.kill("SIGKILL");
  await pool.end();
}
console.log(fails.length ? `RESULT: FAIL (${fails.length})` : "RESULT: PASS");
process.exit(fails.length ? 1 : 0);
