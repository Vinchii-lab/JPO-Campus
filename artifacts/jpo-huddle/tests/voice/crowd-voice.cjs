// Crowd behavior: three real browsers prove (1) two people talking at the
// SAME TIME both come through — no turn-taking anywhere in the stack — and
// (2) when a client is at its peer cap (forced tiny via the ?vmax QA hook),
// a TALKER still gets a connection by bumping a silent peer, whichever side
// of the pair happens to be the dialer.
//
// Cast: Ava & Ben run the normal cap. Cid runs ?vmax=1 (one slot). Cid's
// slot fills with whoever's pair forms first ("X"); the OTHER one ("Y")
// then starts talking, and Cid must swap the slot to Y automatically.
const puppeteer = require("puppeteer-core");
const { Pool } = require("/home/runner/workspace/artifacts/jpo-huddle/node_modules/pg");

const PORT = process.env.TEST_PORT;
const CHROME = "/nix/store/zvpmjmxyjdkjs0rnby54xhwjkp7fj2ff-ungoogled-chromium-114.0.5735.90/bin/chromium";
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const rand = Math.random().toString(36).slice(2, 8);
const EMAIL = (t) => `voicecrowd-${t}-${rand}@justpressone.com`;

const fails = [];
const ok = (c, l) => { console.log((c ? "  ✓ " : "  ✗ ") + l); if (!c) fails.push(l); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function cleanup() {
  await pool.query(`DELETE FROM jpo_players WHERE email LIKE 'voicecrowd-%@justpressone.com'`);
}

async function enter(ctx, email, first, errs, query) {
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errs.push(first + ": " + String(e && e.message || e).slice(0, 200)));
  page.on("console", (m) => { if (m.type() === "error") errs.push(first + " console: " + m.text().slice(0, 200)); });
  await page.goto(`http://localhost:${PORT}/${query || ""}`, { waitUntil: "domcontentloaded", timeout: 30000 });
  await sleep(1200);
  await page.evaluate((em, fn) => {
    document.getElementById("inp-first").value = fn;
    document.getElementById("inp-last").value = "Voicecrowd";
    document.getElementById("inp-nick").value = fn;
    document.getElementById("inp-email").value = em;
    document.getElementById("inp-password").value = "testpass123";
    tryRegister();
  }, email, first);
  await page.waitForFunction(() => document.body.classList.contains("playing"), { timeout: 60000 });
  await page.waitForFunction(() => window._gameScene && window._gameScene.player, { timeout: 20000 });
  return page;
}

const holdV = (page) => page.evaluate(() => document.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyV", key: "v", bubbles: true })));
const releaseV = (page) => page.evaluate(() => document.dispatchEvent(new KeyboardEvent("keyup", { code: "KeyV", key: "v", bubbles: true })));

(async () => {
  let browser;
  try {
    await cleanup();
    await pool.query(
      `INSERT INTO jpo_players (email, first_name, last_name, name, character, approved, department)
       VALUES ($1, 'Ava', 'Voicecrowd', 'Ava Voicecrowd', 'amelia', true, 'QA'),
              ($2, 'Ben', 'Voicecrowd', 'Ben Voicecrowd', 'bob', true, 'IT'),
              ($3, 'Cid', 'Voicecrowd', 'Cid Voicecrowd', 'amelia', true, 'HR')`,
      [EMAIL("a"), EMAIL("b"), EMAIL("c")]);

    browser = await puppeteer.launch({
      executablePath: CHROME, headless: "new",
      args: [
        "--no-sandbox", "--disable-gpu",
        "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream",
        "--autoplay-policy=no-user-gesture-required",
      ],
    });
    const errs = { A: [], B: [], C: [] };
    const ctxA = await browser.createIncognitoBrowserContext();
    const ctxB = await browser.createIncognitoBrowserContext();
    const ctxC = await browser.createIncognitoBrowserContext();
    const pageA = await enter(ctxA, EMAIL("a"), "Ava", errs.A, "");
    const pageB = await enter(ctxB, EMAIL("b"), "Ben", errs.B, "");
    const pageC = await enter(ctxC, EMAIL("c"), "Cid", errs.C, "?vmax=1");
    ok(true, "A, B (normal cap) and C (?vmax=1, single slot) all entered at spawn");

    const idA = await pageA.evaluate(() => socket.id);
    const idB = await pageB.evaluate(() => socket.id);
    const idC = await pageC.evaluate(() => socket.id);
    console.log(`  ids: A=${idA} B=${idB} C=${idC}`);

    // A↔B must fully connect; C must fill its single slot with someone.
    await Promise.all([
      pageA.waitForFunction((o) => { const d = window._voiceDebug && window._voiceDebug(); return d && d.peers.some((p) => p.id === o && p.st === "connected"); }, { timeout: 30000 }, idB),
      pageB.waitForFunction((o) => { const d = window._voiceDebug && window._voiceDebug(); return d && d.peers.some((p) => p.id === o && p.st === "connected"); }, { timeout: 30000 }, idA),
      pageC.waitForFunction(() => { const d = window._voiceDebug && window._voiceDebug(); return d && d.peers.some((p) => p.st === "connected"); }, { timeout: 30000 }),
    ]);
    const cPeers = await pageC.evaluate(() => window._voiceDebug().peers.map((p) => p.id));
    ok(cPeers.length === 1, `C is capped at exactly one connection (has: ${cPeers.length})`);
    const X = cPeers[0], Y = X === idA ? idB : idA;
    const pageY = Y === idA ? pageA : pageB;
    console.log(`  C's slot went to X=${X}; Y=${Y} is the outsider`);

    // ── Phase 1: BOTH A and B talk at the same time — nobody takes turns ──
    await holdV(pageA);
    await holdV(pageB);
    await Promise.all([
      pageA.waitForFunction(() => window._voiceDebug().live === true, { timeout: 10000 }),
      pageB.waitForFunction(() => window._voiceDebug().live === true, { timeout: 10000 }),
    ]);
    await pageC.waitForFunction((a, b) => {
      const bd = window._voiceDebug().badges || [];
      return bd.includes(a) && bd.includes(b);
    }, { timeout: 10000 }, idA, idB);
    ok(true, "C renders BOTH talkers' 🎙️ badges simultaneously (no turn-taking upstream)");
    const bothLivePcs = await pageA.evaluate((o) => {
      const d = window._voiceDebug();
      const p = d.peers.find((x) => x.id === o);
      return d.live && p && p.st === "connected" && p.wired;
    }, idB);
    ok(!!bothLivePcs, "A talks and hears B on the same still-connected pc (full duplex, no renegotiation drop)");
    await releaseV(pageA);
    await releaseV(pageB);
    await pageC.waitForFunction(() => (window._voiceDebug().badges || []).length === 0, { timeout: 12000 });

    // ── Phase 2: Y (not in C's full house) starts talking → C must bump X ──
    await holdV(pageY);
    await pageY.waitForFunction(() => window._voiceDebug().live === true, { timeout: 10000 });
    // Covers BOTH directions of the fix: C tick-evicts and dials (C lower id)
    // or Y's redial offer lands and C offer-evicts (Y lower id). Y's redial
    // cadence after dead dials can take a cooldown cycle — allow 45s.
    await pageC.waitForFunction((y) => {
      const d = window._voiceDebug();
      return d.peers.length === 1 && d.peers[0].id === y && d.peers[0].st === "connected";
    }, { timeout: 45000 }, Y);
    ok(true, "C bumped its silent peer and now holds the TALKER as its only connection");
    const wiredY = await pageC.evaluate((y) => {
      const p = window._voiceDebug().peers.find((x) => x.id === y);
      return p && p.wired;
    }, Y);
    ok(!!wiredY, "C's audio path for the talker is wired");
    await releaseV(pageY);

    ok(errs.A.length === 0, `no client errors on A ${errs.A.length ? "(" + errs.A.join(" ; ") + ")" : ""}`);
    ok(errs.B.length === 0, `no client errors on B ${errs.B.length ? "(" + errs.B.join(" ; ") + ")" : ""}`);
    ok(errs.C.length === 0, `no client errors on C ${errs.C.length ? "(" + errs.C.join(" ; ") + ")" : ""}`);
  } catch (err) {
    console.error("FATAL:", err.message);
    fails.push("fatal: " + err.message);
  } finally {
    if (browser) await browser.close().catch(() => {});
    await cleanup().catch(() => {});
    await pool.end().catch(() => {});
  }
  console.log(fails.length ? `RESULT: FAIL (${fails.length}): ${fails.join(" | ")}` : "RESULT: PASS");
  process.exit(fails.length ? 1 : 0);
})();
