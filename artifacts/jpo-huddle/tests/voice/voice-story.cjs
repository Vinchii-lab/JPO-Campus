// The "I can't hear the others" story, reproduced end-to-end with REAL audio
// energy measurements (not just pc states):
//   U listens. A talks → U must hear A. B talks → U must hear B. A talks
//   AGAIN → U must STILL hear A (the reported bug: hearing B killed A).
//   Then A leaves the room (teleport far), comes back → talking must be
//   audible again (reported: return after a room-switch stays silent).
// "Hear" = raw stream RMS (lvl) above noise AND applied gain (g) above zero
// on U's side — exactly what reaches the ear, via the _voiceDebug lvl tap.
const puppeteer = require("puppeteer-core");
const { Pool } = require("/home/runner/workspace/artifacts/jpo-huddle/node_modules/pg");

const PORT = process.env.TEST_PORT;
const CHROME = "/nix/store/zvpmjmxyjdkjs0rnby54xhwjkp7fj2ff-ungoogled-chromium-114.0.5735.90/bin/chromium";
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const rand = Math.random().toString(36).slice(2, 8);
const EMAIL = (t) => `voicestory-${t}-${rand}@justpressone.com`;

const fails = [];
const ok = (c, l) => { console.log((c ? "  ✓ " : "  ✗ ") + l); if (!c) fails.push(l); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function cleanup() {
  await pool.query(`DELETE FROM jpo_players WHERE email LIKE 'voicestory-%@justpressone.com'`);
}

async function enter(ctx, email, first, errs) {
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errs.push(first + ": " + String(e && e.message || e).slice(0, 200)));
  page.on("console", (m) => { if (m.type() === "error") errs.push(first + " console: " + m.text().slice(0, 200)); });
  await page.goto(`http://localhost:${PORT}/`, { waitUntil: "domcontentloaded", timeout: 30000 });
  await sleep(1200);
  await page.evaluate((em, fn) => {
    document.getElementById("inp-first").value = fn;
    document.getElementById("inp-last").value = "Voicestory";
    document.getElementById("inp-nick").value = fn;
    document.getElementById("inp-email").value = em;
    document.getElementById("inp-password").value = "testpass123";
    tryRegister();
  }, email, first);
  await page.waitForFunction(() => document.body.classList.contains("playing"), { timeout: 60000 });
  await page.waitForFunction(() => window._gameScene && window._gameScene.player, { timeout: 20000 });
  return page;
}

const holdV = (p) => p.evaluate(() => document.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyV", key: "v", bubbles: true })));
const releaseV = (p) => p.evaluate(() => document.dispatchEvent(new KeyboardEvent("keyup", { code: "KeyV", key: "v", bubbles: true })));

// Sample U's debug for `ms`, tracking per-peer max lvl / max g / states seen.
// Also samples the TALKER's own mic RMS — a dead capture at the source means
// a harness (fake-device) glitch, not a game bug.
async function listen(pageU, ms, talkerPage, uId) {
  const out = {};
  let mic = -1, tx = -1;
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const [d, td] = await Promise.all([
      pageU.evaluate(() => window._voiceDebug()),
      talkerPage ? talkerPage.evaluate(() => window._voiceDebug()) : Promise.resolve(null),
    ]);
    if (td) {
      if (td.micLvl > mic) mic = td.micLvl;
      const tp = uId && td.peers.find((p) => p.id === uId);
      if (tp && tp.tx > tx) tx = tp.tx;   // talker's OUTGOING level toward U
    }
    for (const p of d.peers) {
      const o = out[p.id] || (out[p.id] = { maxLvl: 0, maxG: 0, sts: new Set(), gone: false });
      o.maxLvl = Math.max(o.maxLvl, p.lvl);
      o.maxG = Math.max(o.maxG, p.g);
      o.sts.add(p.st);
      o.dirs = p.dirs;
      if (p.elp) o.elp = true;   // pump <audio> paused at any point in window
      if (p.rtm) o.rtm = true;   // receiver track reported muted at any point
    }
    for (const id of Object.keys(out)) if (!d.peers.some((p) => p.id === id)) out[id].gone = true;
    await sleep(150);
  }
  return { peers: out, mic, tx };
}
const fmt = (o) => !o ? "ABSENT" : `lvl=${o.maxLvl.toFixed(3)} g=${o.maxG.toFixed(2)} st=[${[...o.sts]}] dirs=${(o.dirs || []).join("/") || "?"}${o.elp ? " PUMP-PAUSED" : ""}${o.rtm ? " RTRACK-MUTED" : ""}${o.gone ? " DROPPED" : ""}`;
const HEAR = 0.02;   // fake-device tone RMS runs ~0.1+; silence ~0.00x

(async () => {
  const browsers = [];
  try {
    await cleanup();
    await pool.query(
      `INSERT INTO jpo_players (email, first_name, last_name, name, character, approved, department)
       VALUES ($1, 'Uma', 'Voicestory', 'Uma Voicestory', 'amelia', true, 'QA'),
              ($2, 'Al',  'Voicestory', 'Al Voicestory',  'bob',    true, 'IT'),
              ($3, 'Bea', 'Voicestory', 'Bea Voicestory', 'amelia', true, 'HR')`,
      [EMAIL("u"), EMAIL("a"), EMAIL("b")]);

    // One Chrome PROCESS per player. Three incognito contexts in one process
    // share a single fake-audio pipeline, which cross-contaminates captures
    // under load (one press can hand tone to one pair and silence to another
    // — a rig artifact that per-machine real users cannot hit).
    const launch = () => puppeteer.launch({
      executablePath: CHROME, headless: "new",
      args: [
        "--no-sandbox", "--disable-gpu",
        "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream",
        "--autoplay-policy=no-user-gesture-required",
      ],
    });
    for (let i = 0; i < 3; i++) browsers.push(await launch());
    const errs = { U: [], A: [], B: [] };
    const pageU = await enter(browsers[0], EMAIL("u"), "Uma", errs.U);
    const pageA = await enter(browsers[1], EMAIL("a"), "Al", errs.A);
    const pageB = await enter(browsers[2], EMAIL("b"), "Bea", errs.B);
    ok(true, "U, A, B all in the office at spawn");

    const idU = await pageU.evaluate(() => socket.id);
    const idA = await pageA.evaluate(() => socket.id);
    const idB = await pageB.evaluate(() => socket.id);
    console.log(`  ids: U=${idU} A=${idA} B=${idB}`);

    // RTP byte counters from both ends of each U-pair: talker's outBytes vs
    // U's inBytes per phase says WHERE audio died (sender / wire / receiver).
    const snap = async () => {
      const [uA, uB, aU, bU] = await Promise.all([
        pageU.evaluate((id) => window._voiceStats(id), idA),
        pageU.evaluate((id) => window._voiceStats(id), idB),
        pageA.evaluate((id) => window._voiceStats(id), idU),
        pageB.evaluate((id) => window._voiceStats(id), idU),
      ]);
      return { uA, uB, aU, bU };
    };
    const dlt = (a, b, k) => (a && b ? b[k] - a[k] : -1);

    const uConnectedTo = (id) => pageU.waitForFunction((o) => {
      const d = window._voiceDebug && window._voiceDebug();
      const p = d && d.peers.find((x) => x.id === o);
      return p && p.st === "connected" && p.wired;
    }, { timeout: 30000 }, id);
    await Promise.all([uConnectedTo(idA), uConnectedTo(idB)]);
    ok(true, "U holds live wired pcs to BOTH A and B");

    // Warm-up: in headless Chrome the first fake-device capture and the
    // AudioContexts spin up lazily (synthetic keys aren't real gestures), so
    // one throwaway press per talker keeps phase 1 measuring the GAME, not
    // the rig. Real players click/type long before their first call forms.
    await holdV(pageA); await sleep(1200); await releaseV(pageA);
    await holdV(pageB); await sleep(1200); await releaseV(pageB);
    await sleep(600);

    // ── Phase 1: A talks — U must hear A ──
    let s0 = await snap();
    await holdV(pageA);
    let r = await listen(pageU, 8000, pageA, idU);   // 8s: room for the zombie auto-heal to land
    let s = r.peers;
    await releaseV(pageA);
    let s1 = await snap();
    console.log(`  P1  A:${fmt(s[idA])}  B:${fmt(s[idB])}  mic=${r.mic.toFixed(3)} tx=${r.tx.toFixed(3)} AoutΔ=${dlt(s0.aU, s1.aU, "outBytes")} UinΔA=${dlt(s0.uA, s1.uA, "inBytes")}`);
    ok(s[idA] && s[idA].maxLvl > HEAR && s[idA].maxG > 0.1, "U hears A (stream energy + audible gain)");
    await sleep(800);

    // ── Phase 2: B talks — U must hear B ──
    s0 = await snap();
    await holdV(pageB);
    r = await listen(pageU, 3000, pageB, idU);
    s = r.peers;
    await releaseV(pageB);
    s1 = await snap();
    console.log(`  P2  A:${fmt(s[idA])}  B:${fmt(s[idB])}  mic=${r.mic.toFixed(3)} tx=${r.tx.toFixed(3)} BoutΔ=${dlt(s0.bU, s1.bU, "outBytes")} UinΔB=${dlt(s0.uB, s1.uB, "inBytes")}`);
    ok(s[idB] && s[idB].maxLvl > HEAR && s[idB].maxG > 0.1, "U hears B");
    ok(s[idA] && !s[idA].gone, "A's pc SURVIVED B's talking (the reported kill)");
    await sleep(800);

    // ── Phase 3: A talks AGAIN — the exact reported failure ──
    s0 = await snap();
    await holdV(pageA);
    r = await listen(pageU, 3000, pageA, idU);
    s = r.peers;
    await releaseV(pageA);
    s1 = await snap();
    console.log(`  P3  A:${fmt(s[idA])}  B:${fmt(s[idB])}  mic=${r.mic.toFixed(3)} tx=${r.tx.toFixed(3)} AoutΔ=${dlt(s0.aU, s1.aU, "outBytes")} UinΔA=${dlt(s0.uA, s1.uA, "inBytes")}`);
    ok(s[idA] && s[idA].maxLvl > HEAR && s[idA].maxG > 0.1, "U STILL hears A after having heard B");

    // ── Phase 4: A leaves the room and comes back — must be audible again ──
    await pageA.evaluate(() => { const sc = window._gameScene; sc.player.x += 3000; });
    await pageU.waitForFunction((o) => !window._voiceDebug().peers.some((p) => p.id === o), { timeout: 20000 }, idA);
    ok(true, "A walked far away — U's call to A hung up (expected)");
    await sleep(1500);
    await pageA.evaluate(() => { const sc = window._gameScene; sc.player.x -= 3000; });
    try {
      await uConnectedTo(idA);
      ok(true, "A came back — call re-formed automatically");
    } catch (_) {
      const dU = await pageU.evaluate(() => window._voiceDebug());
      const dA = await pageA.evaluate(() => window._voiceDebug());
      ok(false, `return redial NEVER re-formed — U sees [${dU.peers.map((p) => p.id + ":" + p.st)}] A sees [${dA.peers.map((p) => p.id + ":" + p.st)}]`);
    }
    s0 = await snap();
    await holdV(pageA);
    r = await listen(pageU, 8000, pageA, idU);   // 8s: fresh pair after return + heal headroom
    s = r.peers;
    await releaseV(pageA);
    s1 = await snap();
    console.log(`  P4  A:${fmt(s[idA])}  B:${fmt(s[idB])}  mic=${r.mic.toFixed(3)} tx=${r.tx.toFixed(3)} AoutΔ=${dlt(s0.aU, s1.aU, "outBytes")} UinΔA=${dlt(s0.uA, s1.uA, "inBytes")}`);
    ok(s[idA] && s[idA].maxLvl > HEAR && s[idA].maxG > 0.1, "U hears A again after the room-return");

    ok(errs.U.length === 0, `no client errors on U ${errs.U.length ? "(" + errs.U.join(" ; ") + ")" : ""}`);
    ok(errs.A.length === 0, `no client errors on A ${errs.A.length ? "(" + errs.A.join(" ; ") + ")" : ""}`);
    ok(errs.B.length === 0, `no client errors on B ${errs.B.length ? "(" + errs.B.join(" ; ") + ")" : ""}`);

    if (fails.length) {
      for (const [nm, pg] of [["U", pageU], ["A", pageA], ["B", pageB]]) {
        const lg = await pg.evaluate(() => (window._voiceLog ? window._voiceLog() : [])).catch(() => ["<unreadable>"]);
        console.log(`  ── voiceLog ${nm} ──\n    ${lg.join("\n    ")}`);
      }
    }
  } catch (err) {
    console.error("FATAL:", err.message);
    fails.push("fatal: " + err.message);
  } finally {
    for (const b of browsers) await b.close().catch(() => {});
    await cleanup().catch(() => {});
    await pool.end().catch(() => {});
  }
  console.log(fails.length ? `RESULT: FAIL (${fails.length}): ${fails.join(" | ")}` : "RESULT: PASS");
  process.exit(fails.length ? 1 : 0);
})();
