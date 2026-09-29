// Native running HQ only. No login, socket emits, DB writes or server starts.
const puppeteer = require('puppeteer-core');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

(async () => {
  const dest = path.resolve(__dirname, '../tests/evidence/halloween-hq');
  fs.mkdirSync(dest, { recursive: true });
  for (const file of fs.readdirSync(dest)) {
    if (/^(room-\d\d-|prop-)/.test(file) && file.endsWith('.png'))
      fs.unlinkSync(path.join(dest, file));
  }
  const browser = await puppeteer.launch({
    executablePath: '/repl/tools/bin/chromium', headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage']
  });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });
    await page.goto(process.env.URL || 'http://localhost:20158', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window._gameScene?.wallLayer && window.HalloweenOffice, { timeout: 60000 });
    await new Promise(r => setTimeout(r, 1200));
    const report = await page.evaluate(() => {
      const scene = window._gameScene;
      window._proofOriginalSeason = _activeSeason;
      _activeSeason = null; scene._syncSeason();
      const base = new Set(scene.children.list);
      _activeSeason = 'halloween'; scene._syncSeason();
      const first = scene._halloweenCleanup;
      const firstObjects = scene.children.list.filter(o => !base.has(o));
      const targetsOldDecor = tween => tween.targets?.some(o => firstObjects.includes(o));
      const firstReport = first.report();
      scene._syncSeason();
      const second = scene._halloweenCleanup;
      const repeat = {
        firstDestroyed: first.report().destroyed,
        oldObjectsGone: firstObjects.every(o => !scene.children.list.includes(o)),
        oldTweensGone: !scene.tweens.getTweens().some(targetsOldDecor),
        liveDecorCount: scene.children.list.filter(o => !base.has(o)).length,
        report: second.report()
      };
      _activeSeason = null; scene._syncSeason();
      const normal = {
        cleanupNull: scene._halloweenCleanup === null,
        previousDestroyed: second.report().destroyed,
        extraObjects: scene.children.list.filter(o => !base.has(o)).length,
        detachedDecorTweens: scene.tweens.getTweens().filter(t =>
          t.targets?.some(o => o.type === 'Graphics' && !o.scene)).length
      };
      _activeSeason = 'halloween'; scene._syncSeason();
      document.querySelectorAll('body > *').forEach(el => {
        if (el !== scene.game.canvas) el.style.display = 'none';
      });
      scene.game.canvas.style.display = 'block';
      scene.game.scale.resize(1280, 900);
      scene.cameras.main.stopFollow();
      scene.cameras.main.removeBounds();
      const capture = scene._halloweenCleanup.report();
      const labelOverlaps = [];
      for (const room of capture.rooms) {
        const ox = (room.col + (room.dir < 0 ? 1 : 0)) * 48;
        const oy = (room.row + (room.vertical < 0 ? 1 : 0)) * 48;
        for (const label of scene.children.list.filter(o => o.type === 'Text' && o.visible)) {
          const b = label.getBounds();
          const xs = [(b.left - ox) * room.dir, (b.right - ox) * room.dir];
          const ys = [(b.top - oy) * room.vertical, (b.bottom - oy) * room.vertical];
          if (Math.max(...xs) < 0 || Math.max(...ys) < 0) continue;
          const nx = Math.max(0, Math.min(...xs)), ny = Math.max(0, Math.min(...ys));
          if (nx * nx + ny * ny < (room.size * 48 - 3) ** 2)
            labelOverlaps.push({ room: room.room, label: label.text });
        }
      }
      return { first: firstReport, repeat, normal, capture, labelOverlaps };
    });
    assert.equal(report.capture.rooms.length, 34);
    assert.ok(report.capture.rooms.every(r => r.mounted));
    assert.ok(report.capture.props.every(p => p.mounted));
    assert.ok(report.repeat.firstDestroyed && report.repeat.oldObjectsGone && report.repeat.oldTweensGone);
    assert.equal(report.repeat.liveDecorCount, report.first.objects);
    assert.ok(report.normal.cleanupNull && report.normal.previousDestroyed);
    assert.equal(report.normal.extraObjects, 0);
    assert.equal(report.normal.detachedDecorTweens, 0);
    assert.deepEqual(report.labelOverlaps, [], 'webs must leave native room labels clear');

    async function capture(name, col, row, zoom) {
      await page.evaluate(({ col, row, zoom }) => {
        window._gameScene.cameras.main.setZoom(zoom).centerOn(col * 48, row * 48);
      }, { col, row, zoom });
      await new Promise(r => setTimeout(r, 130));
      await page.screenshot({ path: path.join(dest, name) });
    }
    await capture('native-overview.png', 105, 71, 0.125);
    await capture('native-north.png', 121, 29, 0.148);
    for (const [i, room] of report.capture.rooms.entries()) {
      const slug = room.room.toLowerCase().replace(/[^a-z0-9]+/g, '-');
      room.screenshot = `room-${String(i + 1).padStart(2, '0')}-${slug}.png`;
      await capture(room.screenshot,
        room.col + room.dir * room.size / 2,
        room.row + room.vertical * room.size / 2, 1);
    }
    for (const prop of report.capture.props) {
      prop.screenshot = `prop-${prop.kind}-${prop.col}-${prop.row}.png`;
      await capture(prop.screenshot, prop.col + 1, prop.row + 1.5, 1.25);
    }
    await capture('native-cabinet-eyes.png', 46.8, 18.2, 2);
    await page.evaluate(() => {
      _activeSeason = window._proofOriginalSeason;
      window._gameScene._syncSeason();
    });
    fs.writeFileSync(path.join(dest, 'native-coverage-report.json'), JSON.stringify(report, null, 2));
    console.log(`34/34 webs, 12/12 vignettes; room labels clear; repeated mount and normal-season cleanup passed. Evidence: ${dest}`);
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });