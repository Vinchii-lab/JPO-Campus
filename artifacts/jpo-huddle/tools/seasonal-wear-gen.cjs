// Rainy-season wearables (Aug 2026) — v3 "match the character art".
// Style contract now mirrors the LimeZu character sheets themselves:
//   - navy outlines (58,58,80) like every character sprite outline
//   - light-from-the-left shading ramps (L highlight / base / D shade)
//   - THREE frames per item: 0 = front (down), 1 = side (RIGHT), 2 = back (up)
// Frame sizes are LOCKSTEP with the preload calls in public/index.html:
//   wear_raincoat  12x10   wear_rainboots 10x4   wear_umbrella 14x12
const { PNG } = require('pngjs');
const fs = require('fs');
const OUT = '/home/runner/workspace/artifacts/jpo-huddle/public/assets';

const O = [58, 58, 80];       // character-sheet navy outline

const SPRITES = {
  // Yellow slicker: navy outline, zip placket, pocket flaps, hood on the back.
  wear_raincoat: {
    pal: {
      O,
      L: [252, 224, 124],   // highlight (left)
      Y: [245, 197, 66],    // base
      D: [204, 146, 40],    // shade (right)
    },
    frames: [
      [ // front: zip placket down the middle, pocket flaps
        '.ODYYYYYYDO.',
        'OLYYYOOYYYDO',
        'OLLYYOOYYDDO',
        'OLLYYOOYYDDO',
        'OLYYYOOYYYDO',
        'OLYDDOOYDDDO',
        'OLYDDOOYDDDO',
        'OYYYYOOYYYYO',
        '.OOOOOOOOOO.',
        '............',
      ],
      [ // side (right): front edge + zip line on the right
        '..ODDDDDDO..',
        '.OLYYYYYODO.',
        '.OLLYYYYODO.',
        '.OLLYYYYODO.',
        '.OLYYYYYODO.',
        '.OLYYDDYODO.',
        '.OLYYDDYODO.',
        '.OYYYYYYODO.',
        '..OOOOOOOO..',
        '............',
      ],
      [ // back: hood hanging between the shoulders, no zip
        '.ODYYYYYYDO.',
        'OLYYDDDDYYDO',
        'OLYDDDDDDYDO',
        'OLLYDDDDYDDO',
        'OLLYYYYYYDDO',
        'OLYYYYYYYYDO',
        'OLYYYYYYYYDO',
        'OYYYYYYYYYYO',
        '.OOOOOOOOOO.',
        '............',
      ],
    ],
  },
  // Wellies: highlight stripe, navy outline, dark sole.
  wear_rainboots: {
    pal: {
      O,
      L: [252, 224, 124],
      Y: [245, 197, 66],
      D: [204, 146, 40],
    },
    frames: [
      [ // front
        '.LYO..LYO.',
        '.LYO..LYO.',
        '.LYD..LYD.',
        '.OOO..OOO.',
      ],
      [ // side: one boot forward with a toe
        '...LYO....',
        '...LYO....',
        '..LLYD....',
        '..OOOO....',
      ],
      [ // back: same silhouette, shaded (no highlight — light comes from front-left)
        '.YDO..YDO.',
        '.YDO..YDO.',
        '.YDD..YDD.',
        '.OOO..OOO.',
      ],
    ],
  },
  // Red umbrella: outlined domed canopy, highlight, rib shading, silver
  // ferrule, brown pole with J-hook. Canopy is symmetric so back = front;
  // side gets its own tilted-forward canopy.
  wear_umbrella: {
    pal: {
      O,
      R: [222, 68, 64],
      D: [158, 38, 42],
      L: [246, 142, 130],
      S: [214, 214, 220],
      H: [122, 86, 52],
    },
    frames: [
      [ // front
        '......SS......',
        '....ORLLRO....',
        '..ORLLRRRRRO..',
        '.ORLLRRRRRDDO.',
        'ORLRRRRRRRRDDO',
        'ORDRRDRRDRRDDO',
        '......H.......',
        '......H.......',
        '......H.......',
        '....H.H.......',
        '....HHH.......',
        '..............',
      ],
      [ // side: canopy tilted toward the walk direction (right)
        '.......SS.....',
        '.....ORLLRO...',
        '...ORLLRRRRO..',
        '..ORLLRRRRDDO.',
        '.ORLRRRRRRRDDO',
        '.ORDRRDRRDRDDO',
        '......H.......',
        '......H.......',
        '......H.......',
        '....H.H.......',
        '....HHH.......',
        '..............',
      ],
      [ // back: same dome, pole reads behind the head
        '......SS......',
        '....ORLLRO....',
        '..ORLLRRRRRO..',
        '.ORLLRRRRRDDO.',
        'ORLRRRRRRRRDDO',
        'ORDRRDRRDRRDDO',
        '......H.......',
        '......H.......',
        '......H.......',
        '......H.......',
        '.....HH.......',
        '..............',
      ],
    ],
  },
};

for (const [name, s] of Object.entries(SPRITES)) {
  const h = s.frames[0].length, w = s.frames[0][0].length;
  for (const f of s.frames)
    if (f.length !== h || f.some(r => r.length !== w)) throw new Error(name + ': frame size mismatch');
  const png = new PNG({ width: w * s.frames.length, height: h });
  s.frames.forEach((grid, fi) => {
    grid.forEach((row, y) => {
      [...row].forEach((ch, x) => {
        if (ch === '.') return;
        const c = s.pal[ch];
        if (!c) throw new Error(name + ': unknown palette key ' + ch);
        const idx = ((y * w * s.frames.length) + fi * w + x) * 4;
        png.data[idx] = c[0]; png.data[idx + 1] = c[1]; png.data[idx + 2] = c[2]; png.data[idx + 3] = 255;
      });
    });
  });
  fs.writeFileSync(`${OUT}/${name}.png`, PNG.sync.write(png));
  console.log(`${name}.png ${w}x${h} x${s.frames.length} frames`);
}
