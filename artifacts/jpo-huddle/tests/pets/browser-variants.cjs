// Real-browser check: every pet variant texture loads (never __MISSING),
// variants render pixel-distinct from their classic base, and an accessory
// anchors on a variant via the species anchor map.
// Run: TEST_PORT=<port> node tests/pets/browser-variants.cjs
const puppeteer = require("/home/runner/workspace/artifacts/jpo-huddle/node_modules/puppeteer-core");
const { Pool } = require("/home/runner/workspace/artifacts/jpo-huddle/node_modules/pg");

const PORT = process.env.TEST_PORT;
const CHROME = "/nix/store/zvpmjmxyjdkjs0rnby54xhwjkp7fj2ff-ungoogled-chromium-114.0.5735.90/bin/chromium";
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const EMAIL = `browvar-${Math.random().toString(36).slice(2, 8)}@justpressone.com`;

const VARIANTS = ["pet_duck_snow", "pet_cat_black", "pet_cat_snow", "pet_dog_choco",
  "pet_dog_husky", "pet_bunny_cocoa", "pet_turtle_sapphire", "pet_dragon_crimson", "pet_dragon_obsidian"];

const fails = [];
const ok = (c, l) => { console.log((c ? "  ✓ " : "  ✗ ") + l); if (!c) fails.push(l); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function cleanup() {
  await pool.query(`DELETE FROM jpo_players WHERE email LIKE 'browvar-%@justpressone.com'`);
}

(async () => {
  let browser;
  try {
    await cleanup();
    await pool.query(
      `INSERT INTO jpo_players (email, first_name, last_name, name, character, approved, department,
                                coins, cosmetics, equipped_pet, equipped_pet_acc)
       VALUES ($1, 'Browvar', 'Ser', 'Browvar Ser', 'amelia', true, 'QA',
               100000, ARRAY['pet_dragon_obsidian','petacc_crown'], 'pet_dragon_obsidian', 'petacc_crown')`, [EMAIL]);

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
      document.getElementById("inp-first").value = "Browvar";
      document.getElementById("inp-last").value = "Ser";
      document.getElementById("inp-nick").value = "Browvar";
      document.getElementById("inp-email").value = email;
      document.getElementById("inp-password").value = "testpass123";
      tryRegister();
    }, EMAIL);
    await page.waitForFunction(() => document.body.classList.contains("playing"), { timeout: 60000 });
    await page.waitForFunction(() => window._gameScene && window._gameScene.localPet, { timeout: 20000 });
    await sleep(1000);

    // 1. Every variant texture registered and none fell back to __MISSING.
    const tex = await page.evaluate((ids) => {
      const s = window._gameScene;
      return ids.map((id) => ({ id, exists: s.textures.exists(id) }));
    }, VARIANTS);
    for (const t of tex) ok(t.exists, `texture loaded: ${t.id}`);

    // 2. Variants are pixel-distinct from their classic base (recolor actually applied).
    const distinct = await page.evaluate(() => {
      const s = window._gameScene;
      const px = (key) => {
        const src = s.textures.get(key).getSourceImage();
        const cv = document.createElement("canvas");
        cv.width = src.width; cv.height = src.height;
        const cx = cv.getContext("2d");
        cx.drawImage(src, 0, 0);
        return cx.getImageData(0, 0, src.width, src.height).data;
      };
      const diff = (a, b) => {
        const base = px(a), v = px(b);
        if (base.length !== v.length) return -1; // different dims = trivially distinct
        let d = 0;
        for (let i = 0; i < base.length; i += 4) {
          if (base[i + 3] > 8 && (Math.abs(base[i] - v[i]) + Math.abs(base[i + 1] - v[i + 1]) + Math.abs(base[i + 2] - v[i + 2]) > 30)) d++;
        }
        return d;
      };
      return {
        dragon: diff("pet_dragon", "pet_dragon_obsidian"),
        cat: diff("pet_cat", "pet_cat_black"),
        dog: diff("pet_dog", "pet_dog_husky"),
      };
    });
    ok(distinct.dragon === -1 || distinct.dragon > 100, `obsidian dragon differs from classic (${distinct.dragon} px)`);
    ok(distinct.cat === -1 || distinct.cat > 100, `black cat differs from tabby (${distinct.cat} px)`);
    ok(distinct.dog === -1 || distinct.dog > 100, `husky differs from golden (${distinct.dog} px)`);

    // 3. The local pet IS the variant and the accessory anchored via the species map.
    const st = await page.evaluate(() => {
      const p = window._gameScene.localPet;
      return {
        texKey: p.texture && p.texture.key, hasAcc: !!p._acc, accText: p._acc && p._acc.text,
        dxAbs: p._acc ? Math.abs(Math.round(p._acc.x - p.x)) : null,
        dyUp: p._acc ? Math.round(p.y - p._acc.y) : null,
      };
    });
    console.log("  state:", JSON.stringify(st));
    ok(st.texKey === "pet_dragon_obsidian", `local pet uses the variant texture (${st.texKey})`);
    ok(st.hasAcc && st.accText === "👑", "crown overlay present on the variant");
    ok(st.dxAbs !== null && st.dxAbs <= 12 && st.dyUp >= 30 && st.dyUp <= 60,
       `accessory inherits the dragon species anchor (dx=${st.dxAbs}, dyUp=${st.dyUp})`);
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
