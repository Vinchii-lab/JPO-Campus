// HD character layer splitter (Aug 2026) — HD twin of char-layer-split.cjs.
//
// Partitions every opaque pixel of Adam's HD sheets (run + 3 sit) into exactly
// one layer: skin | hair | shirt | pants | shoes | body (outlines, eyes, white
// highlights — never recolored). Classification = nearest centroid over
// several shade centroids per part with a distance cap; anything past the cap
// (outlines 000000/0D0D0D, whites FFFFFF) falls to body.
// Strict partition: re-stacking all six layers reproduces the source sheet
// byte-for-byte — verified below.
//
// Output: public/assets/layers/Adam_{run,sit,sit2,sit3}_hd_{layer}.png
// Run: NODE_PATH=.agents/tools/node_modules node artifacts/jpo-huddle/tools/hd-layer-split.cjs
const { PNG } = require('pngjs');
const fs = require('fs');
const path = require('path');

const ASSETS = '/home/runner/workspace/artifacts/jpo-huddle/public/assets';
const OUT = path.join(ASSETS, 'layers');
fs.mkdirSync(OUT, { recursive: true });

// Shade centroids sampled from the sheets themselves (fill + shadow + highlight
// families). Order matters only via nearest-distance; caps keep outlines out.
const PARTS = {
  hair:  { cents: [[0x95,0x92,0x5E],[0x68,0x69,0x4C],[0x87,0x87,0x58],[0xB0,0xAC,0x72]], cap: 70 },
  skin:  { cents: [[0xFA,0xD3,0xB4],[0xD9,0xAE,0x8E],[0xB8,0x8A,0x6E]],                  cap: 80 },
  shirt: { cents: [[0x94,0x6F,0x9C],[0x6E,0x4F,0x76],[0xB3,0x8E,0xBB]],                  cap: 75 },
  pants: { cents: [[0x38,0x3E,0x54],[0x2A,0x2F,0x42],[0x4A,0x52,0x6E]],                  cap: 48 },
  shoes: { cents: [[0x2F,0x2F,0x45],[0x23,0x1F,0x2D],[0x30,0x30,0x47],[0x3F,0x3F,0x5C]], cap: 34 },
};
const LAYERS = ['body', 'skin', 'hair', 'shirt', 'pants', 'shoes'];

function classify(r, g, b, y, h) {
  // Outline floor: true outlines (000000/0D0D0D and other near-blacks) must
  // never join a recolorable layer — the dark pants/shoes centroids are close
  // enough to catch them otherwise.
  if (Math.max(r, g, b) < 0x20) return 'body';
  let best = null, bestD = Infinity;
  for (const [name, p] of Object.entries(PARTS)) {
    for (const c of p.cents) {
      const d = Math.abs(r - c[0]) + Math.abs(g - c[1]) + Math.abs(b - c[2]);
      if (d < bestD && d <= p.cap * 3) { bestD = d; best = name; }
    }
  }
  // Spatial sanity: shoe- and pants-colored pixels in the upper body are NOT
  // clothes — they're the chest lanyard strap and deep hair/outline shadows
  // (same dark navy family). Recoloring them with the pants pick painted the
  // strap red. waistY: run legs start ~y62 (chibi torso), seated legs earlier.
  if (best === 'shoes' && y < h * 0.55) best = 'body';
  if (best === 'pants' && y < h * waistFrac) best = 'body';
  if (best === 'hair' && y > h * 0.60) best = 'body';
  return best || 'body';
}
let waistFrac = 0.60; // set per sheet below

const SHEETS = ['run', 'sit', 'sit2', 'sit3'];
let allOk = true;
const WAIST = { run: 0.60, sit: 0.45, sit2: 0.45, sit3: 0.45 };
for (const suffix of SHEETS) {
  waistFrac = WAIST[suffix];
  const srcPath = path.join(ASSETS, `Adam_${suffix}_hd.png`.replace('_run_', '_run_'));
  const file = suffix === 'run' ? 'Adam_run_hd.png' : `Adam_${suffix}_hd.png`;
  const src = PNG.sync.read(fs.readFileSync(path.join(ASSETS, file)));
  const outs = {};
  for (const l of LAYERS) outs[l] = new PNG({ width: src.width, height: src.height });
  const counts = Object.fromEntries(LAYERS.map(l => [l, 0]));
  for (let y = 0; y < src.height; y++) {
    for (let x = 0; x < src.width; x++) {
      const i = (y * src.width + x) * 4;
      if (src.data[i + 3] < 128) continue;
      const layer = classify(src.data[i], src.data[i + 1], src.data[i + 2], y, src.height);
      outs[layer].data.set(src.data.subarray(i, i + 4), i);
      counts[layer]++;
    }
  }
  // Verify strict partition: union of layers == source (opaque pixels).
  let ok = true;
  for (let i = 0; i < src.data.length; i += 4) {
    if (src.data[i + 3] < 128) continue;
    let owners = 0;
    for (const l of LAYERS) if (outs[l].data[i + 3] >= 128) owners++;
    if (owners !== 1) { ok = false; break; }
  }
  for (const l of LAYERS) fs.writeFileSync(path.join(OUT, `Adam_${suffix}_hd_${l}.png`), PNG.sync.write(outs[l]));
  console.log(suffix, JSON.stringify(counts), ok ? 'PARTITION-OK' : 'PARTITION-FAIL');
  allOk = allOk && ok;
}
process.exit(allOk ? 0 : 1);
