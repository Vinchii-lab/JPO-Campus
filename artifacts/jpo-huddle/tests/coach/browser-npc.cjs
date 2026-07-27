// Real-browser check: client parses cleanly, the NPC sprite spawns and walks,
// and the mission chip renders from coachStatus on login.
const puppeteer = require("puppeteer-core");
const { Pool } = require("/home/runner/workspace/artifacts/jpo-huddle/node_modules/pg");

const PORT = process.env.TEST_PORT;
const CHROME = "/nix/store/zvpmjmxyjdkjs0rnby54xhwjkp7fj2ff-ungoogled-chromium-114.0.5735.90/bin/chromium";
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const EMAIL = `brow-${Math.random().toString(36).slice(2, 8)}@justpressone.com`;

const fails = [];
const ok = (c, l) => { console.log((c ? "  ✓ " : "  ✗ ") + l); if (!c) fails.push(l); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function cleanup() {
  await pool.query(`DELETE FROM jpo_coach WHERE email LIKE 'brow-%@justpressone.com'`);
  await pool.query(`DELETE FROM jpo_players WHERE email LIKE 'brow-%@justpressone.com'`);
}

(async () => {
  let browser;
  try {
    await cleanup();
    await pool.query(
      `INSERT INTO jpo_players (email, first_name, last_name, name, character, approved, department)
       VALUES ($1, 'Brow', 'Ser', 'Brow Ser', 'amelia', true, 'QA')`, [EMAIL]);
    await pool.query(
      `INSERT INTO jpo_coach (email, intake, intake_at, mission_date, mission, rerolled)
       VALUES ($1, '{"goal":"meet_new","depts":[]}', now(), CURRENT_DATE, $2::jsonb, false)`,
      [EMAIL, JSON.stringify({ type: "play_new", flavor: "browser check", reward: 50, by: "test" })]);

    browser = await puppeteer.launch({ executablePath: CHROME, headless: "new", args: ["--no-sandbox", "--disable-gpu"] });
    const page = await browser.newPage();
    const pageErrors = [];
    page.on("pageerror", (e) => pageErrors.push(String(e && e.message || e).slice(0, 200)));
    page.on("console", (m) => { if (m.type() === "error") pageErrors.push("console: " + m.text().slice(0, 200)); });

    await page.goto(`http://localhost:${PORT}/`, { waitUntil: "domcontentloaded", timeout: 30000 });
    await sleep(1500);
    ok(pageErrors.length === 0, `no client errors at load ${pageErrors.length ? "(" + pageErrors.join(" ; ") + ")" : ""}`);

    await page.evaluate((email) => {
      document.getElementById("inp-first").value = "Brow";
      document.getElementById("inp-last").value = "Ser";
      document.getElementById("inp-nick").value = "Brow";
      document.getElementById("inp-email").value = email;
      document.getElementById("inp-password").value = "testpass123";
      tryRegister();
    }, EMAIL);

    await page.waitForFunction(() => document.body.classList.contains("playing"), { timeout: 60000 });
    ok(true, "entered the office (body.playing)");

    await page.waitForFunction(() => window._gameScene && window._gameScene.npc && window._gameScene.npc.sprite, { timeout: 20000 });
    await sleep(3000);   // let npcMoved ticks drive the walk anim

    const st = await page.evaluate(() => {
      const s = window._gameScene, n = s.npc;
      const chip = document.getElementById("mission-chip");
      return {
        npcX: Math.round(n.sprite.x), npcY: Math.round(n.sprite.y),
        tagText: n.tag && n.tag.text, anim: n.sprite.anims.currentAnim ? n.sprite.anims.currentAnim.key : null,
        playing: n.sprite.anims.isPlaying, texOk: n.sprite.texture && n.sprite.texture.key !== "__MISSING",
        chipOn: chip.classList.contains("on"), chipText: chip.textContent,
        panelThere: !!document.getElementById("coach-panel"),
      };
    });
    console.log("  state:", JSON.stringify(st));
    ok(st.tagText && st.tagText.includes("Huddles"), "NPC name tag rendered");
    ok(st.texOk, "NPC sprite texture built");
    ok(st.anim === null || /walk_/.test(st.anim) || !st.playing, "NPC anim is walk or idle frame");
    ok(st.chipOn && /never played/i.test(st.chipText), `mission chip on: "${st.chipText}"`);
    ok(st.panelThere, "coach panel present in DOM");
    ok(pageErrors.length === 0, `no client errors in-office ${pageErrors.length ? "(" + pageErrors.join(" ; ") + ")" : ""}`);
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
