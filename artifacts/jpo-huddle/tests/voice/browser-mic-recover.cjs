// Real-browser check: PTT recovers from a DEAD master mic track.
// A mic track can end behind our back (headset unplug, Bluetooth switch,
// another app stealing the device). Old behavior: every later press cloned
// the ended track = silent PTT until reload. New behavior: the press detects
// the dead master and re-acquires.
// Run: TEST_PORT=<port> node tests/voice/browser-mic-recover.cjs
const puppeteer = require("/home/runner/workspace/artifacts/jpo-huddle/node_modules/puppeteer-core");
const { Pool } = require("/home/runner/workspace/artifacts/jpo-huddle/node_modules/pg");

const PORT = process.env.TEST_PORT;
const CHROME = "/nix/store/zvpmjmxyjdkjs0rnby54xhwjkp7fj2ff-ungoogled-chromium-114.0.5735.90/bin/chromium";
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const EMAIL = `browmic-${Math.random().toString(36).slice(2, 8)}@justpressone.com`;

const fails = [];
const ok = (c, l) => { console.log((c ? "  ✓ " : "  ✗ ") + l); if (!c) fails.push(l); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function cleanup() {
  await pool.query(`DELETE FROM jpo_players WHERE email LIKE 'browmic-%@justpressone.com'`);
}

(async () => {
  let browser;
  try {
    await cleanup();
    await pool.query(
      `INSERT INTO jpo_players (email, first_name, last_name, name, character, approved, department, coins)
       VALUES ($1,'Browmic','Ser','Browmic Ser','adam',true,'QA',1000)`, [EMAIL]);

    browser = await puppeteer.launch({ executablePath: CHROME, headless: "new",
      args: ["--no-sandbox", "--disable-gpu",
        "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"] });
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    await page.goto(`http://localhost:${PORT}/`, { waitUntil: "domcontentloaded", timeout: 30000 });
    await sleep(1500);
    await page.evaluate((email) => {
      document.getElementById("inp-first").value = "Browmic";
      document.getElementById("inp-last").value = "Ser";
      document.getElementById("inp-nick").value = "Browmic";
      document.getElementById("inp-email").value = email;
      document.getElementById("inp-password").value = "testpass123";
      tryRegister();
    }, EMAIL);
    await page.waitForFunction(() => document.body.classList.contains("playing"), { timeout: 60000 });
    await sleep(1000);

    // 1. First press acquires a live master mic.
    await page.keyboard.down("KeyV");
    await page.waitForFunction(() => window._voiceDebug && _voiceDebug().held, { timeout: 5000 });
    await sleep(600);
    await page.keyboard.up("KeyV");
    const first = await page.evaluate(() =>
      ({ live: !!(window._voiceMicState ? 0 : 0), state: (typeof _voiceMic !== "undefined" && _voiceMic) ? _voiceMic.getAudioTracks()[0].readyState : "none" }));
    ok(first.state === "live", `first press acquired a live mic (${first.state})`);

    // 2. Kill the master track (simulates unplug / device theft).
    await page.evaluate(() => { _voiceMic.getAudioTracks()[0].stop(); });
    const dead = await page.evaluate(() => _voiceMic ? _voiceMic.getAudioTracks()[0].readyState : "none");
    ok(dead === "ended", `master track killed (${dead})`);

    // 3. Next press must detect the corpse and re-acquire a LIVE mic.
    await page.keyboard.down("KeyV");
    await sleep(800);
    await page.keyboard.up("KeyV");
    const second = await page.evaluate(() =>
      (typeof _voiceMic !== "undefined" && _voiceMic) ? _voiceMic.getAudioTracks()[0].readyState : "none");
    ok(second === "live", `press after device death re-acquired a live mic (${second})`);
  } catch (e) {
    fails.push(String(e && e.message || e));
    console.log("  ✗ EXCEPTION: " + (e && e.message || e));
  } finally {
    if (browser) await browser.close();
    await cleanup();
    await pool.end();
  }
  console.log(fails.length ? `RESULT: FAIL (${fails[0]})` : "RESULT: PASS");
  process.exit(fails.length ? 1 : 0);
})();
