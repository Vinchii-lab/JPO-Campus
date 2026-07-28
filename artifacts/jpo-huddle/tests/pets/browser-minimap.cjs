// Real-browser check: the M-key minimap opens, draws the office + player dots,
// closes on M/Esc, and refuses to open during an After Dark round phase.
// Run: TEST_PORT=<port> node tests/pets/browser-minimap.cjs
const puppeteer = require("/home/runner/workspace/artifacts/jpo-huddle/node_modules/puppeteer-core");
const { Pool } = require("/home/runner/workspace/artifacts/jpo-huddle/node_modules/pg");

const PORT = process.env.TEST_PORT;
const CHROME = "/nix/store/zvpmjmxyjdkjs0rnby54xhwjkp7fj2ff-ungoogled-chromium-114.0.5735.90/bin/chromium";
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const EMAIL = `browmap-${Math.random().toString(36).slice(2, 8)}@justpressone.com`;

const fails = [];
const ok = (c, l) => { console.log((c ? "  ✓ " : "  ✗ ") + l); if (!c) fails.push(l); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function cleanup() {
  await pool.query(`DELETE FROM jpo_players WHERE email LIKE 'browmap-%@justpressone.com'`);
}

(async () => {
  let browser;
  try {
    await cleanup();
    await pool.query(
      `INSERT INTO jpo_players (email, first_name, last_name, name, character, approved, department, coins)
       VALUES ($1, 'Browmap', 'Ser', 'Browmap Ser', 'adam', true, 'QA', 1000)`, [EMAIL]);

    browser = await puppeteer.launch({ executablePath: CHROME, headless: "new", args: ["--no-sandbox", "--disable-gpu"] });
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    const pageErrors = [];
    page.on("pageerror", (e) => pageErrors.push(String(e && e.message || e).slice(0, 200)));
    page.on("console", (m) => { if (m.type() === "error") pageErrors.push("console: " + m.text().slice(0, 200)); });

    await page.goto(`http://localhost:${PORT}/`, { waitUntil: "domcontentloaded", timeout: 30000 });
    await sleep(1500);
    await page.evaluate((email) => {
      document.getElementById("inp-first").value = "Browmap";
      document.getElementById("inp-last").value = "Ser";
      document.getElementById("inp-nick").value = "Browmap";
      document.getElementById("inp-email").value = email;
      document.getElementById("inp-password").value = "testpass123";
      tryRegister();
    }, EMAIL);
    await page.waitForFunction(() => document.body.classList.contains("playing"), { timeout: 60000 });
    await page.waitForFunction(() => window._gameScene && window._gameScene._tileMap, { timeout: 20000 });
    await sleep(800);

    // 1. M opens the minimap and the canvas actually has drawn content.
    await page.keyboard.press("KeyM");
    await sleep(600);
    const opened = await page.evaluate(() => {
      const el = document.getElementById("minimap");
      const cv = document.getElementById("minimapCanvas");
      const g = cv.getContext("2d");
      const d = g.getImageData(0, 0, cv.width, cv.height).data;
      let lit = 0;
      for (let i = 0; i < d.length; i += 4) if (d[i] + d[i + 1] + d[i + 2] > 60) lit++;
      return { open: el.classList.contains("open"), w: cv.width, h: cv.height, lit };
    });
    ok(opened.open, "M opens the minimap overlay");
    ok(opened.w > 100 && opened.h > 100, `canvas sized to the map (${opened.w}x${opened.h})`);
    ok(opened.lit > 500, `map background + dots drawn (${opened.lit} lit px)`);

    await page.screenshot({ path: "/tmp/minimap-open.png" });

    // 2. Esc closes it.
    await page.keyboard.press("Escape");
    await sleep(200);
    ok(await page.evaluate(() => !document.getElementById("minimap").classList.contains("open")),
      "Esc closes the minimap");

    // 3. M again re-opens; M closes (toggle).
    await page.keyboard.press("KeyM"); await sleep(200);
    await page.keyboard.press("KeyM"); await sleep(200);
    ok(await page.evaluate(() => !document.getElementById("minimap").classList.contains("open")),
      "M toggles closed");

    // 4. Blocked during After Dark: simulate a round phase client-side.
    await page.evaluate(() => { _roundPhase = "active"; });
    await page.keyboard.press("KeyM");
    await sleep(200);
    ok(await page.evaluate(() => !document.getElementById("minimap").classList.contains("open")),
      "minimap refuses to open while a round is active");
    // ...and force-closes if a round starts while it's open.
    await page.evaluate(() => { _roundPhase = null; });
    await page.keyboard.press("KeyM"); await sleep(200);
    await page.evaluate(() => { _roundPhase = "lobby"; });
    await sleep(700); // one redraw tick
    ok(await page.evaluate(() => !document.getElementById("minimap").classList.contains("open")),
      "minimap force-closes when a round begins");

    ok(pageErrors.length === 0, `no client errors ${pageErrors.length ? "(" + pageErrors.join(" ; ") + ")" : ""}`);
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
