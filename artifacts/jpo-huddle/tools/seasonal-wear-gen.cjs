// Rainy-season wearables (Aug 2026) — same style contract as
// tools/wearable-gen.cjs: flat colors, no outlines, transparent background,
// frame 0 = front (facing down), frame 1 = side profile FACING RIGHT.
// Frame sizes are LOCKSTEP with the preload calls in public/index.html:
//   wear_raincoat  12x10   wear_rainboots 10x4   wear_umbrella 14x12
const { PNG } = require('pngjs');
const fs = require('fs');
const OUT = '/home/runner/workspace/artifacts/jpo-huddle/public/assets';

const SPRITES = {
  // Classic yellow slicker: covers the torso, darker hem + center zip line.
  wear_raincoat: {
    pal: { Y: [244, 197, 66], D: [214, 160, 38], Z: [176, 126, 24] },
    front: [
      '.YYYYYYYYYY.',
      'YYYYYZZYYYYY',
      'YYYYYZZYYYYY',
      'YYYYYZZYYYYY',
      'YYYYYZZYYYYY',
      'YYYYYZZYYYYY',
      'YYYYYZZYYYYY',
      'YYYYYZZYYYYY',
      'DDDDDDDDDDDD',
      '............',
    ],
    side: [
      '..YYYYYYYY..',
      '.YYYYYYYYYY.',
      '.YYYYYYYYYY.',
      '.YYYYYYYYYY.',
      '.YYYYYYYYYY.',
      '.YYYYYYYYYY.',
      '.YYYYYYYYYY.',
      '.YYYYYYYYYY.',
      '.DDDDDDDDDD.',
      '............',
    ],
  },
  // Yellow wellies with a darker sole.
  wear_rainboots: {
    pal: { Y: [244, 197, 66], S: [120, 90, 20] },
    front: [
      '.YY....YY.',
      '.YY....YY.',
      '.YY....YY.',
      '.SS....SS.',
    ],
    side: [
      '....YY....',
      '....YY....',
      '...YYY....',
      '...SSS....',
    ],
  },
  // Red umbrella held overhead: canopy + tip + a hint of handle.
  wear_umbrella: {
    pal: { R: [214, 69, 65], D: [166, 42, 42], H: [110, 80, 50] },
    front: [
      '......H.......',
      '...RRRRRRR....',
      '..RRRRRRRRR...',
      '.RRRRRRRRRRR..',
      'RRDRRDRRDRRDR.',
      '......H.......',
      '......H.......',
      '......H.......',
      '......H.......',
      '......H.......',
      '.....HH.......',
      '..............',
    ],
    side: [
      '......H.......',
      '...RRRRRRR....',
      '..RRRRRRRRR...',
      '.RRRRRRRRRRR..',
      'RRDRRDRRDRRDR.',
      '......H.......',
      '......H.......',
      '......H.......',
      '......H.......',
      '......H.......',
      '.....HH.......',
      '..............',
    ],
  },
};

for (const [name, s] of Object.entries(SPRITES)) {
  const h = s.front.length, w = s.front[0].length;
  if (s.side.length !== h || s.side[0].length !== w) throw new Error(name + ': frame size mismatch');
  const png = new PNG({ width: w * 2, height: h });
  for (const [fi, grid] of [[0, s.front], [1, s.side]]) {
    grid.forEach((row, y) => {
      if (row.length !== w) throw new Error(name + ' row width');
      [...row].forEach((ch, x) => {
        if (ch === '.') return;
        const c = s.pal[ch];
        if (!c) throw new Error(name + ': unknown palette key ' + ch);
        const idx = ((y * w * 2) + fi * w + x) * 4;
        png.data[idx] = c[0]; png.data[idx + 1] = c[1]; png.data[idx + 2] = c[2]; png.data[idx + 3] = 255;
      });
    });
  }
  fs.writeFileSync(`${OUT}/${name}.png`, PNG.sync.write(png));
  console.log(`${name}.png ${w}x${h} x2 frames`);
}
