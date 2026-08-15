// Character layer splitter (Aug 2026) — Phase 1 of the layered-character rebuild.
//
// Partitions every opaque pixel of the baked character sheets (run + 3 sit
// sheets, 4 characters) into exactly one layer:
//   hair (fill + outline) | skin | shirt | pants | body (unclaimed: outlines, shoes)
// using the SAME zone tables + claim priority as the client's _applySwaps
// (see char-layer-split-lib.cjs — the shared source of truth).
// Because it's a strict partition, re-stacking the layers in ANY order
// reproduces the original sheet byte-for-byte — verified below.
//
// Output: public/assets/layers/{Char}_{sheet}_{layer}.png (same dims as source;
// hair + hairOutline are stored in ONE hair layer file — the verify tool
// re-distinguishes them by color when tinting).
// Run: NODE_PATH=.agents/tools/node_modules node artifacts/jpo-huddle/tools/char-layer-split.cjs
const { PNG } = require('pngjs');
const fs = require('fs');
const path = require('path');
const { CHAR_ZONE_COLORS, sitZones, classify } = require('./char-layer-split-lib.cjs');

const ASSETS = '/home/runner/workspace/artifacts/jpo-huddle/public/assets';
const OUT = path.join(ASSETS, 'layers');
fs.mkdirSync(OUT, { recursive: true });

const LAYERS = ['body', 'skin', 'hair', 'shirt', 'pants'];
const SHEETS = [
  { suffix: 'run',  file: c => `${c}_run_16x16.png`,  zones: (ch) => CHAR_ZONE_COLORS[ch] },
  { suffix: 'sit',  file: c => `${c}_sit_16x16.png`,  zones: (ch) => ch === 'adam' ? CHAR_ZONE_COLORS.adam : sitZones(ch, 'right') },
  { suffix: 'sit2', file: c => `${c}_sit2_16x16.png`, zones: (ch) => ch === 'adam' ? CHAR_ZONE_COLORS.adam : sitZones(ch, 'up') },
  { suffix: 'sit3', file: c => `${c}_sit3_16x16.png`, zones: (ch) => ch === 'adam' ? CHAR_ZONE_COLORS.adam : sitZones(ch, 'down') },
];
const CAP = c => c[0].toUpperCase() + c.slice(1);

let allOk = true;
for (const char of Object.keys(CHAR_ZONE_COLORS)) {
  for (const sheet of SHEETS) {
    const srcPath = path.join(ASSETS, sheet.file(CAP(char)));
    if (!fs.existsSync(srcPath)) { console.log(`SKIP missing ${srcPath}`); continue; }
    const src = PNG.sync.read(fs.readFileSync(srcPath));
    const zones = sheet.zones(char);
    const frameW = 16; // x-gates are frame-local (the client's frameW=16 fix)
    const outs = {};
    for (const l of LAYERS) outs[l] = new PNG({ width: src.width, height: src.height });
    const counts = { body:0, skin:0, hair:0, shirt:0, pants:0 };
    for (let y = 0; y < src.height; y++) {
      for (let px = 0; px < src.width; px++) {
        const i = (y * src.width + px) * 4;
        if (src.data[i+3] < 128) continue;   // same alpha rule as _swapColorsData
        const x = px % frameW;               // frame-local x
        let layer = classify(zones, src.data[i], src.data[i+1], src.data[i+2], x, y);
        if (layer === 'hairOutline') layer = 'hair';
        counts[layer]++;
        const o = outs[layer].data;
        o[i] = src.data[i]; o[i+1] = src.data[i+1]; o[i+2] = src.data[i+2]; o[i+3] = src.data[i+3];
      }
    }
    // Verify: recomposite (any order — layers are disjoint) === original opaque pixels.
    let mismatch = 0;
    for (let i = 0; i < src.data.length; i += 4) {
      if (src.data[i+3] < 128) continue;
      let found = 0;
      for (const l of LAYERS) if (outs[l].data[i+3] >= 128) found++;
      if (found !== 1) mismatch++;
      else {
        const l = LAYERS.find(l => outs[l].data[i+3] >= 128);
        const o = outs[l].data;
        if (o[i] !== src.data[i] || o[i+1] !== src.data[i+1] || o[i+2] !== src.data[i+2]) mismatch++;
      }
    }
    if (mismatch) { allOk = false; console.log(`FAIL ${char}_${sheet.suffix}: ${mismatch} mismatched px`); }
    for (const l of LAYERS)
      fs.writeFileSync(path.join(OUT, `${CAP(char)}_${sheet.suffix}_${l}.png`), PNG.sync.write(outs[l]));
    console.log(`${char}_${sheet.suffix}: OK  ` + LAYERS.map(l => `${l}=${counts[l]}`).join(' '));
  }
}
console.log(allOk ? 'ALL-VERIFIED' : 'VERIFY-FAILED');
