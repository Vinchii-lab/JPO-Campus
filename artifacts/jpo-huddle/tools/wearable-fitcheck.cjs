// Fitting-room check: dress a character in each wearable and dump the baked
// frames (4 facings, standing) into one contact sheet for eyeball review.
// Catches floating/misaligned items BEFORE players see them. Run this for any
// new or changed wearable, plus a seated in-game check for layer items.
//
// Usage:
//   1. Seed an approved player row (lowercase email, see below).
//   2. Puppeteer lives in /tmp/jpotest (npm install puppeteer-core@22 there).
//   3. EMAIL=fit-$RANDOM@justpressone.com URL="https://$REPLIT_DEV_DOMAIN/" \
//      ITEMS=rainboots,raincoat,umbrella,crown \
//      NODE_PATH=/tmp/jpotest/node_modules timeout 115 node tools/wearable-fitcheck.cjs
//   Output: design/fitcheck.png (one row per item: right, up, left, down)
const puppeteer = require('puppeteer-core');
const fs = require('fs');
const path = require('path');
const CHROMIUM = '/nix/store/m7qi78k6711fpwnrm4r2kn4p3ga3jal9-ungoogled-chromium-123.0.6312.105/bin/chromium';
const ITEMS = (process.env.ITEMS || 'rainboots,raincoat,umbrella').split(',');

(async () => {
  const b = await puppeteer.launch({ executablePath: CHROMIUM, headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage', '--use-gl=swiftshader'] });
  const p = await b.newPage();
  await p.evaluateOnNewDocument(() => localStorage.setItem('jpo_tutorial_seen', '1'));
  await p.goto(process.env.URL, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await p.waitForSelector('#inp-first', { timeout: 30000 });
  await p.type('#inp-first', 'Fit'); await p.type('#inp-last', 'Check');
  await p.type('#inp-nick', 'FitChk'); await p.type('#inp-email', process.env.EMAIL);
  await p.type('#inp-password', 'test1234');
  await p.evaluate(() => tryRegister());
  await p.waitForFunction(() => document.body.classList.contains('playing'), { timeout: 30000 });
  await new Promise(r => setTimeout(r, 4000));   // let layer sheets + anchors settle
  const data = await p.evaluate((items) => {
    const s = window._gameScene;
    const fw = 16, fh = 32, dirs = [0, 6, 12, 18];   // right, up, left, down frame starts
    const cv = document.createElement('canvas');
    cv.width = fw * dirs.length; cv.height = fh * items.length;
    const cx = cv.getContext('2d');
    items.forEach((item, row) => {
      const key = s._buildPlayerTex('adam', 0, 0, 0, 0, [item]);
      const img = s.textures.get(key).source[0].image;
      dirs.forEach((f, col) => cx.drawImage(img, f * fw, 0, fw, fh, col * fw, row * fh, fw, fh));
    });
    return cv.toDataURL();
  }, ITEMS);
  fs.writeFileSync(path.join(__dirname, '../design/fitcheck.png'), Buffer.from(data.split(',')[1], 'base64'));
  await b.close();
  console.log(`fitcheck: ${ITEMS.join(', ')} -> design/fitcheck.png`);
})().catch(e => { console.error(e); process.exit(1); });
