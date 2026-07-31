// Admin activity log: F8 mutations are recorded with who/what/when, fetched
// paged (newest first), and hidden from non-admins. Throwaway server.
// Run: node tests/economy/adminlog.mjs   (needs DATABASE_URL + ADMIN_PASSWORD)
import { io } from "socket.io-client";
import { spawn } from "child_process";
import { createRequire } from "module";
const require = createRequire("/home/runner/workspace/artifacts/jpo-huddle/server.js");
const pg = require("pg");

const PORT = process.env.TEST_ADMINLOG_PORT || "20979";
const URL = `http://localhost:${PORT}`;
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

const rand = Math.random().toString(36).slice(2, 8);
const E_A = `alog-a-${rand}@justpressone.com`;
const E_B = `alog-b-${rand}@justpressone.com`;

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
const cleanup = async () => {
  await pool.query(`DELETE FROM jpo_players WHERE email LIKE 'alog-%@justpressone.com'`);
  await pool.query(`DELETE FROM jpo_admin_log WHERE admin_name LIKE 'Alogga%'`).catch(() => {});
};

const connect = (email, first, character) => {
  const s = io(URL, { transports: ["websocket"], reconnection: false });
  const p = new Promise((res, rej) => { s.on("connect", res); s.on("connect_error", rej); });
  return { s, ready: p.then(() => s.emit("register", {
    firstName: first, lastName: "Alog", email, password: "testpass123", character, department: "IT",
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
     VALUES ($1,'Alogga','Alog','Alogga Alog','adam',true,1000,ARRAY[]::text[],CURRENT_DATE),
            ($2,'Blogga','Alog','Blogga Alog','bob', true,1000,ARRAY[]::text[],CURRENT_DATE)`,
    [E_A, E_B]);
  console.log("seeded", rand);

  const A = connect(E_A, "Alogga", "adam"), B = connect(E_B, "Blogga", "bob");
  const aApr = queue(A.s, "approved"), bApr = queue(B.s, "approved");
  const aAuth = queue(A.s, "adminAuthOk"), aRes = queue(A.s, "adminPriceResult");
  const aLog = queue(A.s, "adminLogPage"), bLog = queue(B.s, "adminLogPage");
  await Promise.all([A.ready, B.ready]);
  await aApr.next(15000, "A approved"); await bApr.next(15000, "B approved");

  // Non-admin gets nothing back.
  B.s.emit("adminLogGet", { page: 1 });
  await sleep(2000);
  ok(bLog.items.length === 0, "non-admin request for the log is ignored");

  // Admin actions → log entries.
  A.s.emit("adminAuth", { password: process.env.ADMIN_PASSWORD });
  await aAuth.next(8000, "admin auth");
  A.s.emit("adminSetPrice", { item: "crown", price: 5000 });
  await aRes.next(8000, "price ack");
  A.s.emit("adminBanner", { text: "Log test banner" });
  await aRes.next(8000, "banner ack");
  A.s.emit("adminBanner", { text: "" });
  await aRes.next(8000, "banner clear ack");
  await sleep(600);   // log writes are fire-and-forget

  A.s.emit("adminLogGet", { page: 1 });
  const pg1 = await aLog.next(8000, "log page 1");
  ok(pg1.page === 1 && pg1.total >= 4, `page 1 returned with total >= 4 (got ${pg1.total})`);
  const all = pg1.rows.map(r => `${r.admin_name}|${r.action}|${r.detail}`).join("\n");
  ok(/Alogga.* \(alog-a-.*@justpressone\.com\)\|Panel unlocked/.test(all), "unlock logged with admin's name + email");
  ok(/Price change\|crown: [\d,]+ → 5,000 coins/.test(all), "price change logged old → new");
  ok(/Banner posted\|"Log test banner"/.test(all), "banner post logged with text");
  ok(/Banner cleared/.test(all), "banner clear logged");
  ok(pg1.rows[0].action !== "Panel unlocked", "newest first (unlock is not the top row)");
  ok(pg1.rows.every(r => r.ts), "every row has a timestamp");

  // Pagination clamp: absurd page collapses to the last real page.
  A.s.emit("adminLogGet", { page: 9999 });
  const pgLast = await aLog.next(8000, "log last page");
  ok(pgLast.page === pgLast.pages && pgLast.rows.length > 0, "out-of-range page clamps to last page");

  // Put the crown back to default so the throwaway run leaves no override.
  A.s.emit("adminSetPrice", { item: "crown", price: 8000 });
  await aRes.next(8000, "price restore ack").catch(() => {});

  A.s.close(); B.s.close();
} catch (err) {
  console.error("TEST ERROR:", err.message);
  fails.push(err.message);
} finally {
  server.kill();
  await cleanup().catch(() => {});
  await pool.end();
}
console.log(fails.length ? `RESULT: FAIL (${fails.length})` : "RESULT: PASS");
process.exit(fails.length ? 1 : 0);
