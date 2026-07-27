// Diagnostic: reproduce the zombie pair from voice-story (triple join, B
// talks, U hears nothing) and dump WHERE audio dies — B's outbound bytes,
// U's inbound bytes, selected candidate pair, and track state, sampled
// once a second on BOTH ends of the U↔B pair (U↔A sampled for contrast).
const puppeteer = require("puppeteer-core");
const { Pool } = require("/home/runner/workspace/artifacts/jpo-huddle/node_modules/pg");

const PORT = process.env.TEST_PORT;
const CHROME = "/nix/store/zvpmjmxyjdkjs0rnby54xhwjkp7fj2ff-ungoogled-chromium-114.0.5735.90/bin/chromium";
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const rand = Math.random().toString(36).slice(2, 8);
const EMAIL = (t) => `voiceprobe-${t}-${rand}@justpressone.com`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function cleanup() {
  await pool.query(`DELETE FROM jpo_players WHERE email LIKE 'voiceprobe-%@justpressone.com'`);
}

async function enter(ctx, email, first) {
  const page = await ctx.newPage();
  await page.goto(`http://localhost:${PORT}/`, { waitUntil: "domcontentloaded", timeout: 30000 });
  await sleep(1200);
  await page.evaluate((em, fn) => {
    document.getElementById("inp-first").value = fn;
    document.getElementById("inp-last").value = "Voiceprobe";
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

(async () => {
  let browser;
  try {
    await cleanup();
    await pool.query(
      `INSERT INTO jpo_players (email, first_name, last_name, name, character, approved, department)
       VALUES ($1,'Uma','Voiceprobe','Uma Voiceprobe','amelia',true,'QA'),
              ($2,'Al','Voiceprobe','Al Voiceprobe','bob',true,'IT'),
              ($3,'Bea','Voiceprobe','Bea Voiceprobe','amelia',true,'HR')`,
      [EMAIL("u"), EMAIL("a"), EMAIL("b")]);

    browser = await puppeteer.launch({
      executablePath: CHROME, headless: "new",
      args: ["--no-sandbox", "--disable-gpu", "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", "--autoplay-policy=no-user-gesture-required"],
    });
    const ctxU = await browser.createIncognitoBrowserContext();
    const ctxA = await browser.createIncognitoBrowserContext();
    const ctxB = await browser.createIncognitoBrowserContext();
    const pageU = await enter(ctxU, EMAIL("u"), "Uma");
    const pageA = await enter(ctxA, EMAIL("a"), "Al");
    const pageB = await enter(ctxB, EMAIL("b"), "Bea");
    const idU = await pageU.evaluate(() => socket.id);
    const idA = await pageA.evaluate(() => socket.id);
    const idB = await pageB.evaluate(() => socket.id);
    console.log(`ids: U=${idU} A=${idA} B=${idB}`);
    console.log(`roles: U${idU < idB ? " DIALS " : " ANSWERS "}B | U${idU < idA ? " DIALS " : " ANSWERS "}A | A${idA < idB ? " DIALS " : " ANSWERS "}B`);

    const uConnectedTo = (id) => pageU.waitForFunction((o) => {
      const d = window._voiceDebug && window._voiceDebug();
      const p = d && d.peers.find((x) => x.id === o);
      return p && p.st === "connected" && p.wired;
    }, { timeout: 30000 }, id);
    await Promise.all([uConnectedTo(idA), uConnectedTo(idB)]);
    console.log("U connected+wired to A and B");

    // B talks for 6s; sample each second from all three vantage points.
    await holdV(pageB);
    for (let i = 0; i < 6; i++) {
      await sleep(1000);
      const [ub, ua, bu] = await Promise.all([
        pageU.evaluate((id) => window._voiceStats(id), idB),
        pageU.evaluate((id) => window._voiceStats(id), idA),
        pageB.evaluate((id) => window._voiceStats(id), idU),
      ]);
      const f = (x) => !x ? "GONE" : `st=${x.st}/${x.ice} in=${x.inBytes} out=${x.outBytes} sel=${x.sel ? x.sel.state + ":" + x.sel.l + "→" + x.sel.r : "-"} trk=${x.trackMuted === undefined ? "?" : (x.trackMuted ? "MUTED" : "live") + "/" + x.trackState} dirs=${x.dirs}`;
      console.log(`t+${i + 1}s  U←B  ${f(ub)}`);
      console.log(`       U←A  ${f(ua)}`);
      console.log(`       B→U  ${f(bu)}`);
    }
    await releaseV(pageB);
  } catch (err) {
    console.error("FATAL:", err.message);
  } finally {
    if (browser) await browser.close().catch(() => {});
    await cleanup().catch(() => {});
    await pool.end().catch(() => {});
  }
  process.exit(0);
})();
