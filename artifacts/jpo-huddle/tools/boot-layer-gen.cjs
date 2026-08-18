// Rainboots as a LAYER-REPLACEMENT sheet (like the raincoat): the boots are
// painted onto each frame's own bottom foot pixels, so they track every
// animation frame and pose by construction — a painted layer can never float
// or detach the way an anchored overlay sticker can.
// Boot window = each column's bottom 3 opaque rows (the rows the raincoat
// deliberately leaves uncovered), skin/hair excluded (sit poses tuck hands
// near the feet).
// Output: public/assets/layers/{Char}_{suffix}_wear_rainboots.png
// Run: NODE_PATH=/home/runner/workspace/.agents/tools/node_modules node artifacts/jpo-huddle/tools/boot-layer-gen.cjs
const { PNG } = require('pngjs');
const fs = require('fs');
const path = require('path');
const { CHAR_ZONE_COLORS } = require('./char-layer-split-lib.cjs');

const ASSETS = '/home/runner/workspace/artifacts/jpo-huddle/public/assets';
const LDIR = path.join(ASSETS, 'layers');
const CAP = c => c[0].toUpperCase() + c.slice(1);
const SUFFIXES = ['run', 'sit', 'sit2', 'sit3'];

const BOOT = [245, 197, 66];      // rubber yellow (matches the shop icon)
const CUFF_RATIO = 0.62;          // darker top edge so it reads as a boot cuff
const WINDOW = 3;                 // rows per column, from the bottom

for (const char of Object.keys(CHAR_ZONE_COLORS)) {
  for (const suffix of SUFFIXES) {
    const skin = PNG.sync.read(fs.readFileSync(path.join(LDIR, `${CAP(char)}_${suffix}_skin.png`)));
    const hair = PNG.sync.read(fs.readFileSync(path.join(LDIR, `${CAP(char)}_${suffix}_hair.png`)));
    const base = PNG.sync.read(fs.readFileSync(path.join(ASSETS, `${CAP(char)}_${suffix}_16x16.png`)));
    const { width: w, height: h } = base;
    const out = new PNG({ width: w, height: h });
    for (let x = 0; x < w; x++) {
      let bot = -1;
      for (let y = h - 1; y >= 0; y--) if (base.data[(y*w+x)*4+3] >= 128) { bot = y; break; }
      if (bot < 0) continue;
      let painted = 0;
      for (let y = bot; y > bot - WINDOW && y >= 0; y--) {
        const i = (y * w + x) * 4;
        if (base.data[i+3] < 128) continue;
        if (skin.data[i+3] >= 128 || hair.data[i+3] >= 128) continue;
        // Luminance-map the base pixel into boot yellow so the sprite's own
        // shading (outline vs lit side) survives instead of a flat blob.
        const lum = (0.299*base.data[i] + 0.587*base.data[i+1] + 0.114*base.data[i+2]) / 96;
        const cuff = painted === WINDOW - 1 ? CUFF_RATIO : 1;   // top row = cuff
        out.data[i]   = Math.min(255, Math.round(BOOT[0] * lum * cuff));
        out.data[i+1] = Math.min(255, Math.round(BOOT[1] * lum * cuff));
        out.data[i+2] = Math.min(255, Math.round(BOOT[2] * lum * cuff));
        out.data[i+3] = 255;
        painted++;
      }
    }
    fs.writeFileSync(path.join(LDIR, `${CAP(char)}_${suffix}_wear_rainboots.png`), PNG.sync.write(out));
  }
  console.log(`rainboots layers: ${char} OK`);
}
console.log('DONE');
