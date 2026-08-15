// Character art upgrade pilot (Adam): algorithmic polish applied PER LAYER so
// recolors/wearables stay compatible. Three passes:
//   1. Top-light: lighten the top edge pixels of hair/skin/shirt (sun-from-above).
//   2. Selective outlines: very dark outline pixels adjacent to hair/shirt/pants
//      become a dark shade of that material instead of flat black — the modern
//      pixel-art look.
//   3. Ground shadow contact: darken the bottom row of pants/boots slightly.
// Writes upgraded sheets to /tmp/charup/{Char}_{suffix}_16x16.png (NOT into the
// game until approved). Run:
//   NODE_PATH=.agents/tools/node_modules node artifacts/jpo-huddle/tools/char-art-upgrade.cjs <char>
const { PNG } = require('pngjs');
const fs = require('fs');
const path = require('path');

const ASSETS = '/home/runner/workspace/artifacts/jpo-huddle/public/assets';
const LDIR = path.join(ASSETS, 'layers');
const OUT = '/tmp/charup';
fs.mkdirSync(OUT, { recursive: true });
const CAP = c => c[0].toUpperCase() + c.slice(1);
const char = process.argv[2] || 'adam';
const SUFFIXES = ['run', 'sit', 'sit2', 'sit3'];

const mul = (d, i, f) => { for (let k = 0; k < 3; k++) d[i+k] = Math.max(0, Math.min(255, Math.round(d[i+k] * f))); };
const lum = (d, i) => 0.299*d[i] + 0.587*d[i+1] + 0.114*d[i+2];

for (const suffix of SUFFIXES) {
  const base = PNG.sync.read(fs.readFileSync(path.join(ASSETS, `${CAP(char)}_${suffix}_16x16.png`)));
  const L = {};
  for (const l of ['hair', 'skin', 'shirt', 'pants'])
    L[l] = PNG.sync.read(fs.readFileSync(path.join(LDIR, `${CAP(char)}_${suffix}_${l}.png`)));
  const { width: w, height: h } = base;
  const out = new PNG({ width: w, height: h });
  out.data.set(base.data);
  const on = (png, x, y) => x >= 0 && x < w && y >= 0 && y < h && png.data[(y*w+x)*4+3] >= 128;
  const opq = (x, y) => on(base, x, y);

  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y*w + x) * 4;
    if (base.data[i+3] < 128) continue;
    // 1. top-light: owned by hair/skin/shirt and nothing opaque above
    for (const l of ['hair', 'skin', 'shirt'])
      if (on(L[l], x, y) && !opq(x, y-1)) { mul(out.data, i, l === 'hair' ? 1.25 : 1.14); break; }
    // 2. selective outline: near-black pixel next to a material → dark material
    if (lum(base.data, i) < 42) {
      let src = null;
      for (const l of ['hair', 'shirt', 'pants', 'skin'])
        if (on(L[l], x-1, y) || on(L[l], x+1, y) || on(L[l], x, y-1) || on(L[l], x, y+1)) { src = l; break; }
      if (src) {
        // 45% of the material's colour, sampled from the nearest owned neighbour
        for (const [nx, ny] of [[x-1,y],[x+1,y],[x,y-1],[x,y+1]]) {
          if (!on(L[src], nx, ny)) continue;
          const j = (ny*w + nx) * 4;
          for (let k = 0; k < 3; k++) out.data[i+k] = Math.round(base.data[j+k] * 0.42);
          break;
        }
      }
    }
    // 3. contact shading: bottom-most opaque pixel of the column, owned by pants
    if (on(L.pants, x, y) && !opq(x, y+1)) mul(out.data, i, 0.82);
  }
  fs.writeFileSync(path.join(OUT, `${CAP(char)}_${suffix}_16x16.png`), PNG.sync.write(out));
  console.log(suffix, 'OK');
}
console.log('DONE →', OUT);
