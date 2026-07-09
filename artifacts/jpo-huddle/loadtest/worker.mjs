// Load-test worker: simulates `count` headless players against the JPO Huddle
// server. Forked by loadtest.mjs (do not run directly) — receives its config
// as a JSON argv, reports readiness/results over the fork IPC channel.
//
// Behavior per simulated player (mirrors the real client):
//   • register (session-only by default, email-backed with --email-backed),
//     wait for admin approval (the coordinator runs the approving admin socket)
//   • walk at the real client cadence (one playerMove every 50ms while moving,
//     silence while idle) with a configurable walk/idle duty cycle
//   • periodic public chat + emotes; one RPS duel pair per worker (clients 0+1)
//
// Latency measurement: every client is "watched" by exactly one peer in the
// same worker (a ring). Senders record send-time keyed by (socketId, x, y);
// the watching receiver looks the key up when the playerMoved broadcast comes
// back. Same process → same clock, no skew.
import { io as ioc } from "socket.io-client";

const cfg = JSON.parse(process.argv[2]);
// { url, count, offset, durationMs, duty, emailBacked, chatIntervalMs, duels, staggerMs, wanderR }

const SPEED = 150;                       // px/s — must match client SPEED / server MOVE_SPEED
const TICK_MS = 50;                      // real client's move cadence
const STEP = (SPEED * TICK_MS) / 1000;   // px per tick while walking
const CX = 1080, CY = 840;               // session-only spawn point (server constant)

const clients = [];
const sentAt = new Map();                // "sockId|x|y" -> send timestamp
const sentQueue = [];                    // insertion order, for pruning
const latencies = [];
let running = false;

const rand = (a, b) => a + Math.random() * (b - a);

function makeClient(i) {
  const n = cfg.offset + i;
  const st = {
    idx: i, sock: null, sockId: null, approved: false, authFailed: false, rejected: false,
    watchId: null,
    x: CX, y: CY, mode: "idle", wp: null, idleUntil: 0, walkStartedAt: 0,
    movesSent: 0, movedRecv: 0, pairRecv: 0, chatSent: 0, chatRecv: 0,
    duelsStarted: 0, duelsDone: 0, unexpectedDisconnects: 0,
    nextChatAt: 0, nextEmoteAt: 0, nextDuelAt: 0,
    wanderR: cfg.duels && i < 2 ? 90 : cfg.wanderR,   // duelists stay near spawn, always in range
  };
  const sock = ioc(cfg.url, { transports: ["websocket"], reconnection: false, forceNew: true });
  st.sock = sock;
  sock.on("connect", () => {
    st.sockId = sock.id;
    const reg = {
      firstName: `LT${n}`, lastName: "Bot", nickname: `LT${n}`,
      character: "adam", hairIdx: 0, skinIdx: 0, shirtIdx: 0, pantsIdx: 0,
      department: "IT",
    };
    if (cfg.emailBacked) {
      reg.email = `loadtest.${n}@lt.local`;
      reg.password = "loadtest-pass-1";
    }
    sock.emit("register", reg);
  });
  sock.on("approved", () => { st.approved = true; });
  sock.on("authFailed", (d) => { st.authFailed = true; console.error(`[worker] auth failed LT${n}: ${d && d.message}`); });
  sock.on("rejected", () => { st.rejected = true; });
  sock.on("disconnect", () => { if (running) st.unexpectedDisconnects++; });
  sock.on("playerMoved", (d) => {
    st.movedRecv++;
    if (d && d.id === st.watchId) {
      st.pairRecv++;
      const key = d.id + "|" + d.x + "|" + d.y;
      const t = sentAt.get(key);
      if (t !== undefined) {
        sentAt.delete(key);   // one echo per send — a rebroadcast can't rematch a stale time
        if (latencies.length < 60000) latencies.push(Date.now() - t);
      }
    }
  });
  sock.on("chatMessage", () => { st.chatRecv++; });
  if (cfg.duels && i < 2) {
    sock.on("rpsChallengeIncoming", (d) => {
      if (d) sock.emit("rpsRespond", { challengeId: d.challengeId, accept: true });
    });
    sock.on("rpsStart", (d) => {
      if (!d) return;
      const picks = ["rock", "paper", "scissors"];
      setTimeout(() => {
        if (sock.connected) sock.emit("rpsPick", { challengeId: d.challengeId, pick: picks[Math.floor(Math.random() * 3)] });
      }, rand(400, 1800));
    });
    sock.on("rpsResult", () => { st.duelsDone++; });
  }
  clients.push(st);
}

function stepClient(st, now) {
  if (!st.approved || !st.sock.connected) return;
  if (st.mode === "idle") {
    if (now < st.idleUntil) return;              // idle players send nothing (like the real client)
    for (let tries = 0; tries < 5 && !st.wp; tries++) {
      const ang = rand(0, Math.PI * 2), dist = rand(100, 350);
      const nx = st.x + Math.cos(ang) * dist, ny = st.y + Math.sin(ang) * dist;
      const ddx = nx - CX, ddy = ny - CY;
      if (ddx * ddx + ddy * ddy <= st.wanderR * st.wanderR) st.wp = { x: nx, y: ny };
    }
    if (!st.wp) st.wp = { x: CX + rand(-60, 60), y: CY + rand(-60, 60) };  // never an exact repeated point
    st.mode = "walk";
    st.walkStartedAt = now;
  }
  const dx = st.wp.x - st.x, dy = st.wp.y - st.y;
  const d = Math.hypot(dx, dy);
  let anim = "walk";
  if (d <= STEP) {
    st.x = st.wp.x; st.y = st.wp.y; st.wp = null;
    st.mode = "idle"; anim = "idle";
    const walked = now - st.walkStartedAt;
    st.idleUntil = now + walked * (1 / cfg.duty - 1);   // duty cycle: walk fraction of wall time
  } else {
    st.x += (dx / d) * STEP;
    st.y += (dy / d) * STEP;
  }
  st.x = Math.round(st.x * 100) / 100;
  st.y = Math.round(st.y * 100) / 100;
  const dir = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? "right" : "left") : (dy > 0 ? "down" : "up");
  // Keys must be unique per send or a later echo can match a stale timestamp:
  // nudge x by 0.01px (invisible, server doesn't care) until the key is fresh.
  // This must happen BEFORE the emit so the echoed coords equal the stored key.
  let key = st.sockId + "|" + st.x + "|" + st.y;
  for (let bump = 0; sentAt.has(key) && bump < 50; bump++) {
    st.x = Math.round((st.x + 0.01) * 100) / 100;
    key = st.sockId + "|" + st.x + "|" + st.y;
  }
  st.sock.emit("playerMove", { x: st.x, y: st.y, dir, anim });
  st.movesSent++;
  sentAt.set(key, Date.now());
  sentQueue.push(key);
  if (sentQueue.length > 8000) {
    for (const k of sentQueue.splice(0, 4000)) sentAt.delete(k);
  }
}

function behaviorTick(now) {
  for (const st of clients) {
    if (!st.approved || !st.sock.connected) continue;
    if (now >= st.nextChatAt) {
      st.sock.emit("chatMessage", { message: `lt${cfg.offset + st.idx} ping ${st.chatSent}` });
      st.chatSent++;
      st.nextChatAt = now + cfg.chatIntervalMs * rand(0.7, 1.3);
    }
    if (now >= st.nextEmoteAt) {
      st.sock.emit("emote", { emote: "wave" });
      st.nextEmoteAt = now + 45000 * rand(0.7, 1.3);
    }
  }
  if (cfg.duels && clients.length >= 2) {
    const a = clients[0], b = clients[1];
    if (a.approved && b.approved && a.sock.connected && b.sock.connected && now >= a.nextDuelAt) {
      a.sock.emit("rpsChallenge", { targetId: b.sockId, wager: 0, game: "rps" });
      a.duelsStarted++;
      a.nextDuelAt = now + 35000;
    }
  }
}

function begin(durationMs) {
  running = true;
  const now0 = Date.now();
  for (const st of clients) {
    st.idleUntil = now0 + rand(0, 2000);          // desynchronize walk phases
    st.nextChatAt = now0 + rand(2000, Math.max(3000, cfg.chatIntervalMs));
    st.nextEmoteAt = now0 + rand(5000, 45000);
    st.nextDuelAt = now0 + rand(3000, 10000);
  }
  const iv = setInterval(() => {
    const now = Date.now();
    for (const st of clients) stepClient(st, now);
    behaviorTick(now);
  }, TICK_MS);
  setTimeout(() => {
    clearInterval(iv);
    running = false;
    finish();
  }, durationMs);
}

function finish() {
  const agg = {
    approved: 0, failed: 0, movesSent: 0, movedRecv: 0, pairRecv: 0,
    chatSent: 0, chatRecv: 0, duelsStarted: 0, duelsDone: 0, unexpectedDisconnects: 0,
  };
  for (const st of clients) {
    agg.approved += st.approved ? 1 : 0;
    agg.failed += st.authFailed || st.rejected ? 1 : 0;
    agg.movesSent += st.movesSent;
    agg.movedRecv += st.movedRecv;
    agg.pairRecv += st.pairRecv;
    agg.chatSent += st.chatSent;
    agg.chatRecv += st.chatRecv;
    agg.duelsStarted += st.duelsStarted;
    agg.duelsDone += st.duelsDone;
    agg.unexpectedDisconnects += st.unexpectedDisconnects;
  }
  // Cap the IPC payload: uniform-sample down to ≤30k latency samples.
  const stride = Math.max(1, Math.ceil(latencies.length / 30000));
  agg.latencies = stride === 1 ? latencies : latencies.filter((_, k) => k % stride === 0);
  process.send({ type: "result", stats: agg });
  setTimeout(() => {
    for (const st of clients) st.sock.close();
    process.exit(0);
  }, 500);
}

async function connectAll() {
  for (let i = 0; i < cfg.count; i++) {
    makeClient(i);
    await new Promise((r) => setTimeout(r, cfg.staggerMs));
  }
  const deadline = Date.now() + 90000;
  while (Date.now() < deadline) {
    const ok = clients.filter((c) => c.approved).length;
    const dead = clients.filter((c) => c.authFailed || c.rejected).length;
    if (ok + dead >= cfg.count) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  // Watch ring among approved clients: client j samples moves from client j-1.
  const appr = clients.filter((c) => c.approved);
  for (let j = 0; j < appr.length; j++) {
    appr[j].watchId = appr[(j + appr.length - 1) % appr.length].sockId;
  }
  process.send({ type: "ready", approved: appr.length, failed: cfg.count - appr.length });
}

process.on("message", (m) => {
  if (m && m.type === "start") {
    setTimeout(() => begin(cfg.durationMs), Math.max(0, m.at - Date.now()));
  }
});

// If the coordinator dies (crash, timeout kill), the IPC channel closes —
// exit immediately instead of lingering as an orphan that holds sockets open.
process.on("disconnect", () => process.exit(0));

connectAll().catch((e) => {
  console.error("[worker] fatal:", e);
  process.exit(1);
});
