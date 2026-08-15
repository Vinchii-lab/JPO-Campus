// Phase-1 proof image: Adam (and Amelia, the hard case) rebuilt from layers.
// Panels (all frame 18 = front portrait, from the run sheet):
//   original | recomposite from layers | body | skin | hair | shirt | pants | layered recolor
// Writes /tmp/layerdemo/*.png pieces; montage assembly happens in shell.
const { PNG } = require('pngjs');
const fs = require('fs');
const path = require('path');
const { CHAR_ZONE_COLORS, classify, tintPixel } = require('./char-layer-split-lib.cjs');

const ASSETS = '/home/runner/workspace/artifacts/jpo-huddle/public/assets';
const LDIR = path.join(ASSETS, 'layers');
const OUT = '/tmp/layerdemo';
fs.mkdirSync(OUT, { recursive: true });
const LAYERS = ['body', 'skin', 'hair', 'shirt', 'pants'];
const CAP = c => c[0].toUpperCase() + c.slice(1);

function crop(png, fx) { // one 16x32 frame
  const o = new PNG({ width: 16, height: 32 });
  for (let y = 0; y < 32; y++) for (let x = 0; x < 16; x++) {
    const si = (y * png.width + fx * 16 + x) * 4, di = (y * 16 + x) * 4;
    for (let k = 0; k < 4; k++) o.data[di + k] = png.data[si + k];
  }
  return o;
}
const save = (png, name) => fs.writeFileSync(path.join(OUT, name), PNG.sync.write(png));

const RECOLOR = { hair: [70, 110, 220], skin: [150, 96, 64], shirt: [40, 160, 90], pants: [205, 80, 50] };

for (const char of ['adam', 'amelia']) {
  const orig = PNG.sync.read(fs.readFileSync(path.join(ASSETS, `${CAP(char)}_run_16x16.png`)));
  const zones = CHAR_ZONE_COLORS[char];
  const layers = {};
  for (const l of LAYERS)
    layers[l] = PNG.sync.read(fs.readFileSync(path.join(LDIR, `${CAP(char)}_run_${l}.png`)));

  save(crop(orig, 18), `${char}_orig.png`);
  // recomposite
  const comp = new PNG({ width: orig.width, height: orig.height });
  for (const l of LAYERS) for (let i = 0; i < comp.data.length; i += 4)
    if (layers[l].data[i + 3] >= 128) for (let k = 0; k < 4; k++) comp.data[i + k] = layers[l].data[i + k];
  save(crop(comp, 18), `${char}_recomp.png`);
  for (const l of LAYERS) save(crop(layers[l], 18), `${char}_L_${l}.png`);
  // layered recolor demo (all four zones custom)
  const rec = new PNG({ width: orig.width, height: orig.height });
  rec.data.set(orig.data);
  for (let i = 0; i < rec.data.length; i += 4) {
    if (orig.data[i + 3] < 128) continue;
    const px = (i >> 2) % orig.width, y = Math.floor((i >> 2) / orig.width), x = px % 16;
    const layer = LAYERS.find(l => layers[l].data[i + 3] >= 128);
    if (!layer || layer === 'body') continue;
    const r = orig.data[i], g = orig.data[i + 1], b = orig.data[i + 2];
    if (layer === 'hair') {
      const kind = classify(zones, r, g, b, x, y);
      const z = kind === 'hairOutline' ? zones.hairOutline : zones.hair;
      const ratio = kind === 'hairOutline' ? (zones.hairOutline.darkRatio ?? 0.5) : 1;
      tintPixel(rec.data, i, z.r, z.g, z.b,
        Math.round(RECOLOR.hair[0] * ratio), Math.round(RECOLOR.hair[1] * ratio), Math.round(RECOLOR.hair[2] * ratio));
    } else {
      const z = zones[layer];
      tintPixel(rec.data, i, z.r, z.g, z.b, ...RECOLOR[layer]);
    }
  }
  save(crop(rec, 18), `${char}_recolor.png`);
  // 6 walk frames of the recolor (DOWN row = frames 18-23) to show per-frame alignment
  for (let f = 18; f < 24; f++) save(crop(rec, f), `${char}_walk_${f}.png`);
}
console.log('demo pieces written');
