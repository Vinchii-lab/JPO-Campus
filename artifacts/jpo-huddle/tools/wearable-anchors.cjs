// Phase-3b: extract per-frame body anchors from the split layers.
// For every character / sheet / frame: head-top row + head-center column
// (hair∪skin) and feet-bottom row (all opaque). The client bakes wearables
// into player textures by shifting each item's approved standing-pose offset
// by the anchor delta of the target frame — per-frame alignment for free.
// Output: public/assets/layers/anchors.json
//   { char: { suffix: [ {hx,hy,fy}, ... per frame ] } }
// Run: NODE_PATH=.agents/tools/node_modules node artifacts/jpo-huddle/tools/wearable-anchors.cjs
const { PNG } = require('pngjs');
const fs = require('fs');
const path = require('path');

const ASSETS = '/home/runner/workspace/artifacts/jpo-huddle/public/assets';
const LDIR = path.join(ASSETS, 'layers');
const CAP = c => c[0].toUpperCase() + c.slice(1);
const CHARS = ['adam', 'alex', 'amelia', 'bob'];
const SHEETS = { run: 16, sit: 32, sit2: 32, sit3: 16 };  // suffix → frame width

const out = {};
for (const char of CHARS) {
  out[char] = {};
  for (const [suffix, fw] of Object.entries(SHEETS)) {
    const base = PNG.sync.read(fs.readFileSync(path.join(ASSETS, `${CAP(char)}_${suffix}_16x16.png`)));
    const hair = PNG.sync.read(fs.readFileSync(path.join(LDIR, `${CAP(char)}_${suffix}_hair.png`)));
    const skin = PNG.sync.read(fs.readFileSync(path.join(LDIR, `${CAP(char)}_${suffix}_skin.png`)));
    const { width: w, height: h } = base;
    const frames = Math.floor(w / fw);
    const list = [];
    for (let f = 0; f < frames; f++) {
      let hy = -1, fy = -1, sx = 0, sn = 0;
      for (let y = 0; y < h; y++) for (let x = f * fw; x < (f + 1) * fw; x++) {
        const i = (y * w + x) * 4;
        const head = hair.data[i+3] >= 128 || skin.data[i+3] >= 128;
        if (head && hy < 0) hy = y;
        if (head && hy >= 0 && y < hy + 6) { sx += (x - f * fw); sn++; }
        if (base.data[i+3] >= 128) fy = Math.max(fy, y);
      }
      list.push({ hx: sn ? Math.round(sx / sn) : Math.floor(fw / 2), hy, fy });
    }
    out[char][suffix] = list;
  }
  console.log(char, 'OK');
}
fs.writeFileSync(path.join(LDIR, 'anchors.json'), JSON.stringify(out));
console.log('DONE →', path.join(LDIR, 'anchors.json'));
