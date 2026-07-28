// Real-browser check: pet accessory overlay renders, is anchored on the pet
// (not floating off), flips with the pet, and dies with the pet.
// Run: TEST_PORT=<port> node tests/pets/browser-petacc.cjs
// Deps resolve like the coach browser tests (puppeteer-core from tests/coach).
const puppeteer = require("puppeteer-core");
const { Pool } = require("/home/runner/workspace/artifacts/jpo-huddle/node_modules/pg");

const PORT = process.env.TEST_PORT;
const CHROME = "/nix/store/zvpmjmxyjdkjs0rnby54xhwjkp7fj2ff-ungoogled-chromium-114.0.5735.90/bin/chromium";
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const EMAIL = `browacc-${Math.random().toString(36).slice(2, 8)}@justpressone.com`;

const fails = [];
const ok = (c, l) => { console.log((c ? "  ✓ " : "  ✗ ") + l); if (!c) fails.push(l); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function cleanup() {
  await pool.query(`DELETE FROM jpo_players WHERE email LIKE 'browacc-%@justpressone.com'`);
}

(async () => {
  let browser;
  try {
    await cleanup();
    // Seed a player who already owns + wears duck & top hat → restore path
    // must dress the pet with no shop interaction at all.
    await pool.query(
      `INSERT INTO jpo_players (email, first_name, last_name, name, character, approved, department,
                                coins, cosmetics, equipped_pet, equipped_pet_acc)
       VALUES ($1, 'Browacc', 'Ser', 'Browacc Ser', 'amelia', true, 'QA',
               100000, ARRAY['pet_duck','petacc_tophat'], 'pet_duck', 'petacc_tophat')`, [EMAIL]);

    browser = await puppeteer.launch({ executablePath: CHROME, headless: "new", args: ["--no-sandbox", "--disable-gpu"] });
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    const pageErrors = [];
    page.on("pageerror", (e) => pageErrors.push(String(e && e.message || e).slice(0, 200)));
    page.on("console", (m) => { if (m.type() === "error") pageErrors.push("console: " + m.text().slice(0, 200)); });

    await page.goto(`http://localhost:${PORT}/`, { waitUntil: "domcontentloaded", timeout: 30000 });
    await sleep(1500);
    ok(pageErrors.length === 0, `no client errors at load ${pageErrors.length ? "(" + pageErrors.join(" ; ") + ")" : ""}`);

    await page.evaluate((email) => {
      document.getElementById("inp-first").value = "Browacc";
      document.getElementById("inp-last").value = "Ser";
      document.getElementById("inp-nick").value = "Browacc";
      document.getElementById("inp-email").value = email;
      document.getElementById("inp-password").value = "testpass123";
      tryRegister();
    }, EMAIL);
    await page.waitForFunction(() => document.body.classList.contains("playing"), { timeout: 60000 });
    await page.waitForFunction(() => window._gameScene && window._gameScene.localPet, { timeout: 20000 });
    await sleep(1500);

    const st1 = await page.evaluate(() => {
      const p = window._gameScene.localPet;
      return {
        hasAcc: !!p._acc, accText: p._acc && p._acc.text, depth: p._acc && p._acc.depth,
        px: Math.round(p.x), py: Math.round(p.y),
        ax: p._acc && Math.round(p._acc.x), ay: p._acc && Math.round(p._acc.y),
      };
    });
    console.log("  state:", JSON.stringify(st1));
    ok(st1.hasAcc && st1.accText === "🎩", "top hat overlay exists on restored pet");
    ok(st1.depth === 3, `overlay depth 3 (got ${st1.depth})`);
    ok(st1.hasAcc && Math.abs(st1.ax - st1.px) <= 12 && st1.py - st1.ay >= 20 && st1.py - st1.ay <= 60,
       `overlay anchored on the pet (dx=${st1.ax - st1.px}, dy=${st1.ay - st1.py})`);

    // Walk left a bit — accessory must follow and mirror with the pet's flip.
    await page.keyboard.down("ArrowLeft"); await sleep(1200); await page.keyboard.up("ArrowLeft"); await sleep(1200);
    const st2 = await page.evaluate(() => {
      const p = window._gameScene.localPet;
      return { flip: !!p.flipX, dx: Math.round(p._acc.x - p.x), dist: Math.round(Math.hypot(p._acc.x - p.x, p._acc.y - p.y)) };
    });
    console.log("  after walk:", JSON.stringify(st2));
    ok(st2.dist <= 60, `overlay still riding the pet after a walk (dist=${st2.dist})`);
    ok(!st2.flip || st2.dx <= 0, `offset mirrors with flip (flip=${st2.flip}, dx=${st2.dx})`);

    await page.screenshot({ path: "/tmp/petacc-anchor.png" });
    console.log("  screenshot: /tmp/petacc-anchor.png");

    // Send the pet home — overlay must die with it (no orphaned emoji).
    await page.evaluate(() => window._gameScene._setLocalPet(""));
    const orphan = await page.evaluate(() =>
      window._gameScene.children.list.filter(o => o.text === "🎩").length);
    ok(orphan === 0, `no orphaned accessory after pet removal (found ${orphan})`);
    ok(pageErrors.length === 0, `no client errors in-office ${pageErrors.length ? "(" + pageErrors.join(" ; ") + ")" : ""}`);
  } catch (err) {
    console.error("FATAL:", err.message);
    fails.push("fatal: " + err.message);
  } finally {
    if (browser) await browser.close().catch(() => {});
    await cleanup().catch(() => {});
    await pool.end();
  }
  console.log(fails.length ? `RESULT: FAIL (${fails.join(" | ")})` : "RESULT: PASS");
  process.exit(fails.length ? 1 : 0);
})();
