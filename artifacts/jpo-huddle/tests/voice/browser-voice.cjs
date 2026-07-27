// Real-browser check: two players actually connect a WebRTC voice call
// (fake mics), the PTT key lights the sender, the 🎙️ badge shows up on the
// other client, and releasing clears it. Two isolated browser contexts so
// the pair never share a login/localStorage.
const puppeteer = require("puppeteer-core");
const { Pool } = require("/home/runner/workspace/artifacts/jpo-huddle/node_modules/pg");

const PORT = process.env.TEST_PORT;
const CHROME = "/nix/store/zvpmjmxyjdkjs0rnby54xhwjkp7fj2ff-ungoogled-chromium-114.0.5735.90/bin/chromium";
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const rand = Math.random().toString(36).slice(2, 8);
const EMAIL_A = `voicebrow-a-${rand}@justpressone.com`;
const EMAIL_B = `voicebrow-b-${rand}@justpressone.com`;

const fails = [];
const ok = (c, l) => { console.log((c ? "  ✓ " : "  ✗ ") + l); if (!c) fails.push(l); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function cleanup() {
  await pool.query(`DELETE FROM jpo_players WHERE email LIKE 'voicebrow-%@justpressone.com'`);
}

async function enter(ctx, email, first, errs) {
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errs.push(first + ": " + String(e && e.message || e).slice(0, 200)));
  page.on("console", (m) => { if (m.type() === "error") errs.push(first + " console: " + m.text().slice(0, 200)); });
  await page.goto(`http://localhost:${PORT}/`, { waitUntil: "domcontentloaded", timeout: 30000 });
  await sleep(1200);
  await page.evaluate((em, fn) => {
    document.getElementById("inp-first").value = fn;
    document.getElementById("inp-last").value = "Voicebrow";
    document.getElementById("inp-nick").value = fn;
    document.getElementById("inp-email").value = em;
    document.getElementById("inp-password").value = "testpass123";
    tryRegister();
  }, email, first);
  await page.waitForFunction(() => document.body.classList.contains("playing"), { timeout: 60000 });
  await page.waitForFunction(() => window._gameScene && window._gameScene.player, { timeout: 20000 });
  return page;
}

(async () => {
  let browser;
  try {
    await cleanup();
    await pool.query(
      `INSERT INTO jpo_players (email, first_name, last_name, name, character, approved, department)
       VALUES ($1, 'Ava', 'Voicebrow', 'Ava Voicebrow', 'amelia', true, 'QA'),
              ($2, 'Ben', 'Voicebrow', 'Ben Voicebrow', 'bob', true, 'IT')`, [EMAIL_A, EMAIL_B]);

    browser = await puppeteer.launch({
      executablePath: CHROME, headless: "new",
      args: [
        "--no-sandbox", "--disable-gpu",
        "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream",
        "--autoplay-policy=no-user-gesture-required",
      ],
    });
    const errsA = [], errsB = [];
    const ctxA = await browser.createIncognitoBrowserContext();
    const ctxB = await browser.createIncognitoBrowserContext();
    const pageA = await enter(ctxA, EMAIL_A, "Ava", errsA);
    ok(true, "A entered the office");
    const pageB = await enter(ctxB, EMAIL_B, "Ben", errsB);
    ok(true, "B entered the office (same spawn, well within earshot)");

    const idA = await pageA.evaluate(() => socket.id);
    const idB = await pageB.evaluate(() => socket.id);
    console.log(`  ids: A=${idA} B=${idB}`);

    // The 500ms roster tick should dial automatically — wait for a live pc
    await Promise.all([
      pageA.waitForFunction((other) => {
        const d = window._voiceDebug && window._voiceDebug();
        return d && d.peers.some((p) => p.id === other && p.st === "connected");
      }, { timeout: 30000 }, idB),
      pageB.waitForFunction((other) => {
        const d = window._voiceDebug && window._voiceDebug();
        return d && d.peers.some((p) => p.id === other && p.st === "connected");
      }, { timeout: 30000 }, idA),
    ]);
    ok(true, "WebRTC pc 'connected' on BOTH ends (auto-dialed by proximity)");

    const wiredB = await pageB.evaluate((other) => {
      const d = window._voiceDebug();
      const p = d.peers.find((x) => x.id === other);
      return p && p.wired;
    }, idA);
    ok(!!wiredB, "B's audio path for A is wired (gain node / element attached)");

    // A holds V → mic granted (fake device), goes live, badge lands on B
    await pageA.evaluate(() => document.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyV", key: "v", bubbles: true })));
    await pageA.waitForFunction(() => window._voiceDebug().live === true, { timeout: 10000 });
    ok(true, "A is live while holding V (fake mic granted, track enabled)");
    await pageB.waitForFunction((other) => (window._voiceDebug().badges || []).includes(other), { timeout: 10000 }, idA);
    ok(true, "B renders A's 🎙️ badge");
    const selfBadge = await pageA.evaluate(() => (window._voiceDebug().badges || []).length > 0);
    ok(selfBadge, "A sees their own badge echo");
    const hudLive = await pageA.evaluate(() => document.getElementById("voice-btn").classList.contains("live"));
    ok(hudLive, "A's HUD 🎙️ button shows the live state");

    // Release → off relayed → badge clears on B well before self-expiry
    await pageA.evaluate(() => document.dispatchEvent(new KeyboardEvent("keyup", { code: "KeyV", key: "v", bubbles: true })));
    await pageA.waitForFunction(() => window._voiceDebug().live === false, { timeout: 5000 });
    await pageB.waitForFunction((other) => !(window._voiceDebug().badges || []).includes(other), { timeout: 5000 }, idA);
    ok(true, "release: A off-air, B's badge cleared by the off event");

    ok(errsA.length === 0, `no client errors on A ${errsA.length ? "(" + errsA.join(" ; ") + ")" : ""}`);
    ok(errsB.length === 0, `no client errors on B ${errsB.length ? "(" + errsB.join(" ; ") + ")" : ""}`);
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
