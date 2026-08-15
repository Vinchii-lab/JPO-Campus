// Phase-1 acceptance test: recoloring VIA LAYERS must equal the live
// _applySwaps output for every character/sheet across representative combos —
// including the trap combos (default hair + custom shirt) that historically
// caused bleed bugs. Differences are only acceptable where the legacy pass
// painted OUTSIDE its own layer (i.e. the bugs the layer system fixes) — every
// diff is reported with layer attribution for review.
//
//  A) legacy: applySwaps port run on the ORIGINAL sheet
//  B) layered: each pass tints ONLY its own layer's pixels (hair layer
//     re-distinguishes fill vs outline by color), then layers composite.
// Run: NODE_PATH=.agents/tools/node_modules node artifacts/jpo-huddle/tools/char-layer-verify.cjs
const { PNG } = require('pngjs');
const fs = require('fs');
const path = require('path');
const { CHAR_ZONE_COLORS, sitZones, zoneMatch, classify, applySwaps, tintPixel } =
  require('./char-layer-split-lib.cjs');

const ASSETS = '/home/runner/workspace/artifacts/jpo-huddle/public/assets';
const LDIR = path.join(ASSETS, 'layers');
const CAP = c => c[0].toUpperCase() + c.slice(1);
const LAYERS = ['body', 'skin', 'hair', 'shirt', 'pants'];
const SHEETS = [
  { suffix: 'run',  file: c => `${c}_run_16x16.png`,  zones: (ch) => CHAR_ZONE_COLORS[ch] },
  { suffix: 'sit',  file: c => `${c}_sit_16x16.png`,  zones: (ch) => ch === 'adam' ? CHAR_ZONE_COLORS.adam : sitZones(ch, 'right') },
  { suffix: 'sit2', file: c => `${c}_sit2_16x16.png`, zones: (ch) => ch === 'adam' ? CHAR_ZONE_COLORS.adam : sitZones(ch, 'up') },
  { suffix: 'sit3', file: c => `${c}_sit3_16x16.png`, zones: (ch) => ch === 'adam' ? CHAR_ZONE_COLORS.adam : sitZones(ch, 'down') },
];

// Target colors (arbitrary but far apart, like the real palettes)
const HAIR = [40, 80, 200], SKIN = [140, 90, 60], SHIRT = [30, 160, 90], PANTS = [200, 60, 40];
const COMBOS = [
  { name: 'all-custom',   hair: HAIR, skin: SKIN, shirt: SHIRT, pants: PANTS },
  { name: 'shirt-only',   hair: null, skin: null, shirt: SHIRT, pants: null  },
  { name: 'pants-only',   hair: null, skin: null, shirt: null,  pants: PANTS },
  { name: 'hair-only',    hair: HAIR, skin: null, shirt: null,  pants: null  },
  { name: 'skin-only',    hair: null, skin: SKIN, shirt: null,  pants: null  },
  { name: 'hair+shirt',   hair: HAIR, skin: null, shirt: SHIRT, pants: null  },
];

// B) layered recolor: tint each layer's own pixels only, in place on a copy.
function layeredRecolor(orig, layers, zones, combo, frameW) {
  const out = Buffer.from(orig.data);
  const w = orig.width;
  for (let i = 0; i < out.length; i += 4) {
    if (orig.data[i+3] < 128) continue;
    const px = (i >> 2) % w, y = Math.floor((i >> 2) / w), x = px % frameW;
    let layer = null;
    for (const l of LAYERS) if (layers[l].data[i+3] >= 128) { layer = l; break; }
    const r = orig.data[i], g = orig.data[i+1], b = orig.data[i+2];
    if (layer === 'hair' && combo.hair) {
      // fill vs outline by re-classification (same rules the splitter used)
      const kind = classify(zones, r, g, b, x, y);
      const z = kind === 'hairOutline' ? zones.hairOutline : zones.hair;
      const ratio = kind === 'hairOutline' ? (zones.hairOutline.darkRatio ?? 0.5) : 1;
      tintPixel(out, i, z.r, z.g, z.b,
        Math.round(combo.hair[0]*ratio), Math.round(combo.hair[1]*ratio), Math.round(combo.hair[2]*ratio));
    } else if (layer === 'skin' && combo.skin) {
      tintPixel(out, i, zones.skin.r, zones.skin.g, zones.skin.b, ...combo.skin);
    } else if (layer === 'shirt' && combo.shirt) {
      tintPixel(out, i, zones.shirt.r, zones.shirt.g, zones.shirt.b, ...combo.shirt);
    } else if (layer === 'pants' && combo.pants) {
      tintPixel(out, i, zones.pants.r, zones.pants.g, zones.pants.b, ...combo.pants);
    }
  }
  return out;
}

let totalDiff = 0;
for (const char of Object.keys(CHAR_ZONE_COLORS)) {
  for (const sheet of SHEETS) {
    const srcPath = path.join(ASSETS, sheet.file(CAP(char)));
    if (!fs.existsSync(srcPath)) continue;
    const orig = PNG.sync.read(fs.readFileSync(srcPath));
    const zones = sheet.zones(char);
    const layers = {};
    for (const l of LAYERS)
      layers[l] = PNG.sync.read(fs.readFileSync(path.join(LDIR, `${CAP(char)}_${sheet.suffix}_${l}.png`)));
    for (const combo of COMBOS) {
      // A) legacy
      const legacy = Buffer.from(orig.data);
      applySwaps(legacy, zones, combo.hair, combo.skin, combo.shirt, combo.pants, orig.width, 16);
      // B) layered
      const layered = layeredRecolor(orig, layers, zones, combo, 16);
      // Compare, attributing every diff to the layer that owns the pixel.
      const diffByLayer = {};
      for (let i = 0; i < legacy.length; i += 4) {
        if (orig.data[i+3] < 128) continue;
        if (legacy[i] !== layered[i] || legacy[i+1] !== layered[i+1] || legacy[i+2] !== layered[i+2]) {
          const l = LAYERS.find(l => layers[l].data[i+3] >= 128);
          diffByLayer[l] = (diffByLayer[l] || 0) + 1;
        }
      }
      const n = Object.values(diffByLayer).reduce((a, b) => a + b, 0);
      totalDiff += n;
      if (n) console.log(`DIFF ${char}_${sheet.suffix} [${combo.name}]: ${n}px`,
        JSON.stringify(diffByLayer));
    }
  }
}
console.log(totalDiff === 0 ? 'IDENTICAL-EVERYWHERE' : `TOTAL DIFF PX: ${totalDiff} (review above)`);
