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
  // ── July 2026: six wearables adapted from the MV_Accessories pack ──────
  // (artifacts/api-server/MV_Accessories). MV art is 48px-native, ~3x finer
  // than the game's 16px texel density, so these are hand-redrawn from
  // downscaled+quantized extractions (tools note: /tmp/wearables/mv-extract.cjs
  // was the throwaway extractor), following the same flat-color contract.

  // Round scholarly spectacles (sheet 10): brown rims, CLEAR lenses — the
  // transparent centers show the wearer's eyes (unlike sunglasses/shades).
  wear_spectacles: {
    pal: { F: [82, 52, 34], G: [205, 225, 240] },
    front: [
      '.FF..FF.',
      'F..FF..F',
      '.FF..FF.',
    ],
    side: [
      '....FFF.',
      'FFFFFGFF',
      '....FFF.',
    ],
  },
  // Blue-grey knit beanie (sheet 3): soft dome, light stitch highlight,
  // darker folded cuff hugging the head.
  wear_beanie: {
    pal: { A: [100, 108, 138], L: [140, 148, 175], B: [64, 70, 90] },
    front: [
      '..AAAAAA..',
      '.AAAALAAA.',
      'AAAALAAAAA',
      'AAAAAAAAAA',
      'BBBBBBBBBB',
      'BBBBBBBBBB',
    ],
    side: [
      '..AAAAAA..',
      '.AAAAALAA.',
      'AAAAALAAAA',
      'AAAAAAAAAA',
      'BBBBBBBBBB',
      'BBBBBBBBBB',
    ],
  },
  // Tan newsboy flat cap (sheet 2): rounded tweed dome, green sprig tucked
  // in the band, dark front brim.
  wear_flatcap: {
    pal: { T: [168, 148, 128], D: [126, 108, 92], G: [72, 130, 96], B: [62, 56, 66] },
    front: [
      '..TTTTTT..',
      '.TTTTTGTT.',
      'TTTTTTTTTT',
      'TTTTTTTTTT',
      'DDDDDDDDDD',
      '..BBBBBB..',
    ],
    side: [
      '..TTTTTT..',
      '.TTTTTTGT.',
      'TTTTTTTTTT',
      'TTTTTTTTTT',
      'DDDDDDDDDD',
      '.....BBBBB',
    ],
  },
  // Brown wide-brim ranger hat (sheet 17): tall dome, orange band, full brim
  // with a shaded underside.
  wear_rangerhat: {
    pal: { H: [150, 96, 70], S: [112, 70, 52], O: [230, 150, 40] },
    front: [
      '....HHHH....',
      '...HHHHHH...',
      '..HHHHHHHH..',
      '..OOOOOOOO..',
      'HHHHHHHHHHHH',
      '.SSSSSSSSSS.',
    ],
    side: [
      '....HHHH....',
      '...HHHHHH...',
      '..HHHHHHHH..',
      '..OOOOOOOO..',
      '.HHHHHHHHHHH',
      '..SSSSSSSSS.',
    ],
  },
  // Gold cat-ear headset (sheet 8): dark band with pointy ears (light inner),
  // chunky yellow cups landing OUTSIDE the head like the other headsets.
  wear_catears: {
    pal: { K: [52, 52, 66], Y: [240, 205, 70], L: [255, 230, 120] },
    front: [
      '.KK......KK.',
      '.KLK....KLK.',
      '.KKK....KKK.',
      '..KKKKKKKK..',
      '..K......K..',
      'YY........YY',
      'YY........YY',
      'YY........YY',
    ],
    side: [
      '...KK.......',
      '...KLK......',
      '..KKKK......',
      '..K.........',
      '..K.........',
      '..YYY.......',
      '..YYY.......',
      '..YYY.......',
    ],
  },
  // Sci-fi helmet (sheet 19): full-head steel dome with a glowing blue visor
  // band; the ONLY wearable that covers the whole head (front + side).
  wear_scifihelmet: {
    // Full-head bucket: 13x16 so it actually encloses the chibi head
    // (hair top ≈ -31 … chin ≈ +14 at scale 3) with the visor band landing
    // over the eyes (≈ +8). The ONLY wearable that covers the whole head.
    pal: { E: [70, 72, 96], M: [105, 108, 132], H: [132, 136, 162], V: [110, 190, 240] },
    front: [
      '....EEEEE....',
      '..EEMHHHMEE..',
      '.EMMHMMMMMME.',
      '.EMMHMMMMMME.',
      'EMMMHMMMMMMME',
      'EMMMMMMMMMMME',
      'EMMMMMMMMMMME',
      'EMMMMMMMMMMME',
      'EMMMMMMMMMMME',
      'EMMMMMMMMMMME',
      'EMMMMMMMMMMME',
      'EEVVVVVVVVVEE',
      'EVVVVVVVVVVVE',
      'EEVVVVVVVVVEE',
      'EMMMMMMMMMMME',
      '.EEEEEEEEEEE.',
    ],
    side: [
      '....EEEEE....',
      '..EEMHHHMEE..',
      '.EMMMHMMMMME.',
      '.EMMMHMMMMME.',
      'EMMMMHMMMMMME',
      'EMMMMMMMMMMME',
      'EMMMMMMMMMMME',
      'EMMMMMMMMMMME',
      'EMMMMMMMMMMME',
      'EMMMMMMMMMMME',
      'EMMMMMMMMMMME',
      'EMMMMMEVVVVEE',
      'EMMMMMEVVVVVE',
      'EMMMMMEVVVVEE',
      'EMMMMMMMMMMME',
      '.EEEEEEEEEEE.',
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
