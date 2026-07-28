// Capture the real rendered office as one image for the minimap background.
// Logs in, hides the local player/HUD sprites, zooms the camera out to fit the
// whole map, and screenshots just the map area of the canvas.
const puppeteer = require("/home/runner/workspace/artifacts/jpo-huddle/node_modules/puppeteer-core");
const { Pool } = require("/home/runner/workspace/artifacts/jpo-huddle/node_modules/pg");
const PORT = process.env.TEST_PORT;
const CHROME = "/nix/store/zvpmjmxyjdkjs0rnby54xhwjkp7fj2ff-ungoogled-chromium-114.0.5735.90/bin/chromium";
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const OUT = process.argv[2] || "/tmp/mm-map.png";
const EMAIL = `browmm-${Math.random().toString(36).slice(2, 8)}@justpressone.com`;

(async () => {
  let browser;
  try {
    await pool.query(`DELETE FROM jpo_players WHERE email LIKE 'browmm-%@justpressone.com'`);
    await pool.query(
      `INSERT INTO jpo_players (email, first_name, last_name, name, character, approved, department, coins)
       VALUES ($1,'Mm','Shot','Mm Shot','adam',true,'QA',1000)`, [EMAIL]);
    browser = await puppeteer.launch({ executablePath: CHROME, headless: "new",
      args: ["--no-sandbox", "--disable-gpu", "--window-size=2400,1500"] });
    const page = await browser.newPage();
    await page.setViewport({ width: 2400, height: 1500 });
    await page.goto(`http://localhost:${PORT}/`, { waitUntil: "domcontentloaded", timeout: 30000 });
    await sleep(1500);
    await page.evaluate((email) => {
      document.getElementById("inp-first").value = "Mm";
      document.getElementById("inp-last").value = "Shot";
      document.getElementById("inp-nick").value = "Mm";
      document.getElementById("inp-email").value = email;
      document.getElementById("inp-password").value = "testpass123";
      tryRegister();
    }, EMAIL);
    await page.waitForFunction(() => document.body.classList.contains("playing") && window._gameScene && window._gameScene._tileMap && window._gameScene.player, { timeout: 60000 });
    await sleep(1500);

    const geom = await page.evaluate(() => {
      const sc = window._gameScene, map = sc._tileMap, cam = sc.cameras.main;
      const W = map.widthInPixels * 3, H = map.heightInPixels * 3;
      // hide every player-ish sprite (self + any real coworkers online)
      const hide = (o) => { try { o && o.setVisible && o.setVisible(false); } catch (_) {} };
      hide(sc.player); hide(sc.nameTag); hide(sc.localCosmetic); hide(sc.localPet); hide(sc.localPetAcc);
      ["nameTag","playerNameTag"].forEach(k => hide(sc[k]));
      for (const id in sc.otherPlayers) {
        const e = sc.otherPlayers[id];
        ["sprite","nameTag","cosmetic","pet","chatBubble"].forEach(k => hide(e[k]));
        if (e.pet) { hide(e.pet); hide(e.pet._acc); }
      }
      if (sc.localPet) { hide(sc.localPet); hide(sc.localPet._acc); }
      const z = Math.min(window.innerWidth / W, window.innerHeight / H);
      cam.stopFollow(); cam.setZoom(z); cam.centerOn(W / 2, H / 2);
      return { W, H, z, vw: window.innerWidth, vh: window.innerHeight };
    });
    await sleep(800);
    // hide DOM HUD so it can't overlap the canvas shot
    await page.addStyleTag({ content: "body > *:not(canvas){display:none !important} .toast,#coach-panel,#round-invite{display:none !important}" });
    await sleep(300);
    const w = geom.W * geom.z, h = geom.H * geom.z;
    await page.screenshot({ path: OUT, clip: { x: (geom.vw - w) / 2, y: (geom.vh - h) / 2, width: w, height: h } });
    console.log("saved", OUT, Math.round(w) + "x" + Math.round(h));
  } catch (e) {
    console.log("FAIL:", e && e.message || e);
    process.exitCode = 1;
  } finally {
    if (browser) await browser.close();
    await pool.query(`DELETE FROM jpo_players WHERE email LIKE 'browmm-%@justpressone.com'`);
    await pool.end();
  }
})();
