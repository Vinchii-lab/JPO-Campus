// Rainy-season wearables (Aug 2026) — same style contract as
// tools/wearable-gen.cjs: transparent background,
// frame 0 = front (facing down), frame 1 = side profile FACING RIGHT.
// Frame sizes are LOCKSTEP with the preload calls in public/index.html:
//   wear_raincoat  12x10   wear_rainboots 10x4   wear_umbrella 14x12
// v2 (Vince: "shit's ugly"): added dark outlines, left-light shading,
// hood rim + zipper on the coat; domed scalloped canopy, ferrule tip and
// J-hook handle on the umbrella; shaded wellies.
const { PNG } = require('pngjs');
const fs = require('fs');
const OUT = '/home/runner/workspace/artifacts/jpo-huddle/public/assets';

const SPRITES = {
  // Classic yellow slicker: outlined, light from the left, center zip, hood rim.
  wear_raincoat: {
    pal: {
      L: [252, 222, 118],   // highlight
      Y: [244, 197, 66],    // base yellow
      D: [206, 150, 38],    // shade
      Z: [140, 96, 20],     // outline / zipper
    },
    front: [
      '.ZDDYYYYDDZ.',
      'ZLLYYZZYYDDZ',
      'ZLLYYZZYYDDZ',
      'ZLLYYZZYYDDZ',
      'ZLLYYZZYYDDZ',
      'ZLLYYZZYYDDZ',
      'ZLDYYZZYYDDZ',
      'ZYYYYZZYYYYZ',
      '.ZZZZZZZZZZ.',
      '............',
    ],
    side: [
      '..ZDDDDDDZ..',
      '.ZLYYYYYDDZ.',
      '.ZLYYYYYDDZ.',
      '.ZLYYYYYDDZ.',
      '.ZLYYYYYDDZ.',
      '.ZLYYYYYDDZ.',
      '.ZLYYYYYDDZ.',
      '.ZYYYYYYYDZ.',
      '..ZZZZZZZZ..',
      '............',
    ],
  },
  // Yellow wellies: highlight stripe + dark sole.
  wear_rainboots: {
    pal: {
      L: [252, 222, 118],
      Y: [244, 197, 66],
      D: [206, 150, 38],
      S: [92, 70, 28],
    },
    front: [
      '.LYD..LYD.',
      '.LYD..LYD.',
      '.LYD..LYD.',
      '.SSS..SSS.',
    ],
    side: [
      '...LYD....',
      '...LYD....',
      '..LLYD....',
      '..SSSS....',
    ],
  },
  // Red umbrella held overhead: domed canopy with highlight + rib shading,
  // silver ferrule tip, brown pole with a J-hook handle.
  wear_umbrella: {
    pal: {
      R: [222, 68, 64],     // base red
      D: [160, 38, 40],     // shaded panel / ribs
      L: [246, 140, 128],   // highlight
      S: [212, 212, 218],   // ferrule tip
      H: [122, 86, 52],     // pole + handle
    },
    front: [
      '......SS......',
      '....RLLRRR....',
      '..RRLLRRRRRR..',
      '.RRLLRRRRRRDD.',
      'RRLRRRRRRRRDDD',
      'RDRRDRRDRRDRDD',
      '......H.......',
      '......H.......',
      '......H.......',
      '....H.H.......',
      '....HHH.......',
      '..............',
    ],
    side: [
      '......SS......',
      '....RLLRRR....',
      '..RRLLRRRRRR..',
      '.RRLLRRRRRRDD.',
      'RRLRRRRRRRRDDD',
      'RDRRDRRDRRDRDD',
      '......H.......',
      '......H.......',
      '......H.......',
      '....H.H.......',
      '....HHH.......',
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
