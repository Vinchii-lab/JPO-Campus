const { PNG } = require('pngjs');
const fs = require('fs');
const OUT = '/home/runner/workspace/artifacts/jpo-huddle/public/assets';

// Style contract (matches wear_shades/cap/chain): flat colors, no outlines,
// 1-3 colors per item, transparent background. Frame 0 = front (facing down),
// frame 1 = side profile FACING RIGHT (game flipX-mirrors for left).
const SPRITES = {
  // Aviator sunglasses: gold top bar + dark teardrop lenses (distinct from
  // the plain black rectangles of "shades").
  wear_sunglasses: {
    pal: { G: [241,196,15], D: [17,17,17] },
    front: [
      'GGGGGGGG',
      'DDD..DDD',
      '.DD..DD.',
    ],
    side: [
      '.GGGGGGG',
      '....DDDD',
      '.....DD.',
    ],
  },
  // Street cap (baseball style): rounded red dome + darker brim band.
  // Replaces the old solid-red trapezoid that read as a papal mitre.
  // MUST stay 10x6 per frame (preload frameWidth/frameHeight lockstep).
  wear_cap: {
    pal: { R: [192,57,43], D: [146,43,33] },
    front: [
      '..RRRRRR..',
      '.RRRRRRRR.',
      'RRRRRRRRRR',
      'DDDDDDDDDD',
      '..........',
      '..........',
    ],
    side: [
      '..RRRRRR..',
      '.RRRRRRRR.',
      '.RRRRRRRR.',
      '..DDDDDDDD',
      '..........',
      '..........',
    ],
  },
  // Gold crown with red jewels.
  wear_crown: {
    pal: { A: [241,196,15], B: [212,160,23], R: [231,76,60] },
    front: [
      'A...AA...A',
      'AA..AA..AA',
      'AAAAAAAAAA',
      'ARAABAABRA' + '',
      'AAAAAAAAAA',
      'BBBBBBBBBB',
    ],
    side: [
      '.A...AA..A',
      '.AA..AA.AA',
      '.AAAAAAAAA',
      '.AARABAARA'.slice(0,10),
      '.AAAAAAAAA',
      '.BBBBBBBBB',
    ],
  },
  // Silver band + black cups. 12 wide: cups land OUTSIDE the chibi head
  // (10-11 px wide), not on the face.
  wear_headphones: {
    pal: { A: [150,154,160], B: [17,17,17] },
    front: [
      '...AAAAAA...',
      '..AA....AA..',
      '.AA......AA.',
      '.A........A.',
      'BB........BB',
      'BB........BB',
      'BB........BB',
    ],
    side: [
      '...AAAAAA...',
      '..AA....AA..',
      '..A.........',
      '..A.........',
      '..BBB.......',
      '..BBB.......',
      '..BBB.......',
    ],
  },
  // Purple artist beret, tilted left, little stem on top.
  wear_beret: {
    pal: { A: [142,68,173], B: [108,52,131] },
    front: [
      '....A.....',
      '.AAAAAAA..',
      'AAAAAAAAA.',
      'BAAAAAAB..',
      '..........',
    ],
    side: [
      '.....A....',
      '..AAAAAAA.',
      '.AAAAAAAAA',
      '..BAAAAAB.',
      '..........',
    ],
  },
  // White toque with band.
  wear_chefhat: {
    pal: { W: [245,245,245], S: [205,205,210] },
    front: [
      '.WW.WW.WW.',
      'WWWWWWWWWW',
      'WWWWWWWWWW',
      '.WWWWWWWW.',
      '.WWWWWWWW.',
      '.SSSSSSSS.',
    ],
    side: [
      '.WW.WW.WW.',
      'WWWWWWWWWW',
      'WWWWWWWWWW',
      '.WWWWWWWW.',
      '.WWWWWWWW.',
      '.SSSSSSSS.',
    ],
  },
  // Camera on a neck strap: dark strap V, gray body, dark lens.
  wear_camera: {
    pal: { S: [60,60,64], B: [120,124,130], L: [17,17,17], R: [231,76,60] },
    front: [
      'S......S',
      '.S....S.',
      '..BBBB..',
      '.RBLLB..',
      '..BLLB..',
      '..BBBB..',
    ],
    side: [
      '..S.....',
      '..S.....',
      '..BBBB..',
      '..BBBLL.',
      '..BBBLL.',
      '..BBBB..',
    ],
  },
  // Green gamer headset: dark band, green cups, mic boom to the mouth.
  wear_gamerheadset: {
    pal: { A: [40,42,46], G: [46,204,113] },
    front: [
      '...AAAAAA...',
      '..AA....AA..',
      '.AA......AA.',
      '.A........A.',
      'GG........GG',
      'GG........GG',
      'GG.......AGG',
      '.....AAAA...',
    ],
    side: [
      '...AAAAAA...',
      '..AA....AA..',
      '..A.........',
      '..A.........',
      '..GGG.......',
      '..GGG.......',
      '..GGGA......',
      '......AAA...',
    ],
  },
  // Open book held in front: tan cover, white pages.
  wear_book: {
    pal: { C: [155,89,42], W: [250,250,245] },
    front: [
      'WWWWCWWWW',
      'WWWWCWWWW',
      'CWWWCWWWC',
      '.CCCCCCC.',
    ],
    side: [
      '...CWWWW.',
      '..CWWWWW.',
      '..CWWWWC.',
      '..CCCCC..',
    ],
  },
  // Acoustic guitar slung across the torso: tan neck up-right, brown body
  // low-left, dark soundhole.
  wear_guitar: {
    pal: { N: [222,184,135], B: [139,90,43], D: [60,40,20] },
    front: [
      '........NN',
      '.......NN.',
      '......NN..',
      '..BBBBN...',
      '.BBBBBB...',
      '.BBDDBB...',
      '.BBBBBB...',
      '..BBBB....',
    ],
    side: [
      '........N.',
      '.......NN.',
      '......NN..',
      '..BBBBN...',
      '.BBBBBB...',
      '.BBDDBB...',
      '.BBBBBB...',
      '..BBBB....',
    ],
  },
};

let manifest = [];
for (const [name, def] of Object.entries(SPRITES)) {
  const { pal, front, side } = def;
  const h = front.length;
  const w = Math.max(...front.map(r => r.length), ...side.map(r => r.length));
  if (side.length !== h) { console.error(`${name}: frame height mismatch front=${h} side=${side.length}`); process.exit(1); }
  const png = new PNG({ width: w * 2, height: h });
  png.data.fill(0);
  const draw = (rows, xoff) => {
    rows.forEach((row, y) => {
      for (let x = 0; x < row.length; x++) {
        const ch = row[x];
        if (ch === '.' || ch === ' ' || !pal[ch]) continue;
        const i = (y * png.width + (x + xoff)) * 4;
        const [r,g,b] = pal[ch];
        png.data[i] = r; png.data[i+1] = g; png.data[i+2] = b; png.data[i+3] = 255;
      }
    });
  };
  draw(front, 0); draw(side, w);
  fs.writeFileSync(`${OUT}/${name}.png`, PNG.sync.write(png));
  manifest.push(`${name}: sheet ${w*2}x${h}, frame ${w}x${h}`);
}
console.log(manifest.join('\n'));
