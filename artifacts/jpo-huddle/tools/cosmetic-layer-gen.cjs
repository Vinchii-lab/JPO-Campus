// Phase-3: generate LAYER-REPLACEMENT cosmetic sheets from the split layers.
// The raincoat is derived from each character's SHIRT layer silhouette, so it
// is pixel-aligned on every frame of every sheet by construction.
// Output: public/assets/layers/{Char}_{suffix}_wear_raincoat.png
// Run: NODE_PATH=.agents/tools/node_modules node artifacts/jpo-huddle/tools/cosmetic-layer-gen.cjs
const { PNG } = require('pngjs');
const fs = require('fs');
const path = require('path');
const { CHAR_ZONE_COLORS } = require('./char-layer-split-lib.cjs');

const ASSETS = '/home/runner/workspace/artifacts/jpo-huddle/public/assets';
const LDIR = path.join(ASSETS, 'layers');
const CAP = c => c[0].toUpperCase() + c.slice(1);
const SUFFIXES = ['run', 'sit', 'sit2', 'sit3'];

// Classic slicker yellow; collar/hem accent is a darker rubber tone.
const COAT = [244, 196, 48];
const ACCENT_RATIO = 0.62;

for (const char of Object.keys(CHAR_ZONE_COLORS)) {
  const z = CHAR_ZONE_COLORS[char].shirt;
  const srcLum = (0.299*z.r + 0.587*z.g + 0.114*z.b) || 1;
  for (const suffix of SUFFIXES) {
    // Coat silhouette (region-based): from the shoulder line (top row of the
    // frame's shirt∪pants pixels) down to each column's bottom minus 3px (boot
    // window), cover EVERY opaque base pixel except skin (hands stay) and hair
    // (flowing hair drapes over the coat). Dark outline/shading pixels are
    // included — luminance mapping keeps them dark, so the coat keeps the
    // sprite's own pixel-art definition instead of looking like a flat blob.
    const shirt = PNG.sync.read(fs.readFileSync(path.join(LDIR, `${CAP(char)}_${suffix}_shirt.png`)));
    const pants = PNG.sync.read(fs.readFileSync(path.join(LDIR, `${CAP(char)}_${suffix}_pants.png`)));
    const skin  = PNG.sync.read(fs.readFileSync(path.join(LDIR, `${CAP(char)}_${suffix}_skin.png`)));
    const hair  = PNG.sync.read(fs.readFileSync(path.join(LDIR, `${CAP(char)}_${suffix}_hair.png`)));
    const base  = PNG.sync.read(fs.readFileSync(path.join(ASSETS, `${CAP(char)}_${suffix}_16x16.png`)));
    const { width: w, height: h } = shirt;
    const sil = new Uint8Array(w * h);
    const framesA = Math.floor(w / 16);
    const frameWA = w / framesA;              // 16 (run/sit3) or 32 (sit/sit2)
    for (let f = 0; f < framesA; f++) {
      // shoulder line for THIS frame
      let top = -1;
      for (let y = 0; y < h && top < 0; y++)
        for (let x = f * frameWA; x < (f + 1) * frameWA; x++) {
          const i = (y * w + x) * 4;
          if (shirt.data[i+3] >= 128 || pants.data[i+3] >= 128) { top = y; break; }
        }
      if (top < 0) continue;
      for (let x = f * frameWA; x < (f + 1) * frameWA; x++) {
        let bot = -1;
        for (let y = h - 1; y >= 0; y--) if (base.data[(y*w+x)*4+3] >= 128) { bot = y; break; }
        for (let y = top; y <= bot - 3; y++) {
          const i = (y * w + x) * 4;
          if (base.data[i+3] < 128) continue;
          if (skin.data[i+3] >= 128 || hair.data[i+3] >= 128) continue;
          sil[y * w + x] = 1;
        }
      }
    }
    const out = new PNG({ width: w, height: h });
    // Pass 1: luminance-mapped yellow from the BASE pixel (keeps shading).
    const baseLumRef = srcLum;   // shirt source colour anchors "full" yellow
    for (let p = 0; p < w * h; p++) {
      if (!sil[p]) continue;
      const i = p * 4;
      const lum = (0.299*base.data[i] + 0.587*base.data[i+1] + 0.114*base.data[i+2]) / baseLumRef;
      out.data[i]   = Math.min(255, Math.round(COAT[0] * lum));
      out.data[i+1] = Math.min(255, Math.round(COAT[1] * lum));
      out.data[i+2] = Math.min(255, Math.round(COAT[2] * lum));
      out.data[i+3] = 255;
    }
    // Pass 2 (per 16px frame column-wise): darken each column's TOP shirt pixel
    // (collar seam) and BOTTOM shirt pixel (rubber hem) so it reads as a coat,
    // not a yellow shirt. Frame-local so it tracks every animation pose.
    const frames = Math.floor(w / 16);
    for (let f = 0; f < frames; f++) {
      for (let cx = 0; cx < 16; cx++) {
        const x = f * 16 + cx;
        let top = -1, bot = -1;
        for (let y = 0; y < h; y++) {
          const i = (y * w + x) * 4;
          if (out.data[i+3] === 255) { if (top < 0) top = y; bot = y; }
        }
        for (const y of [top, bot]) {
          if (y < 0) continue;
          const i = (y * w + x) * 4;
          out.data[i]   = Math.round(out.data[i]   * ACCENT_RATIO);
          out.data[i+1] = Math.round(out.data[i+1] * ACCENT_RATIO);
          out.data[i+2] = Math.round(out.data[i+2] * ACCENT_RATIO);
        }
      }
    }
    fs.writeFileSync(path.join(LDIR, `${CAP(char)}_${suffix}_wear_raincoat.png`), PNG.sync.write(out));
  }
  console.log(`raincoat layers: ${char} OK`);
}
console.log('DONE');
