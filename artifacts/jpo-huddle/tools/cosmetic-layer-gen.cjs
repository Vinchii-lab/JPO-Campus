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
    const hood = new Uint8Array(w * h);   // hood dome mask, drawn separately
    for (let f = 0; f < framesA; f++) {
      // Body of the coat: shoulder line down, skin (hands) and hair excluded —
      // the hair is handled by the HOOD below, not recolored.
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
      // HOOD (Aug 2026, owner request): a drawn dome that REPLACES the hair —
      // not a recolor. It must fully cover every hair pixel (layers draw over
      // the base, they can't erase), then gets smoothed into one rounded shape
      // so no hairstyle silhouette (spikes, bangs, buns) survives. Face skin
      // stays visible in the opening.
      const x0 = f * frameWA, x1 = (f + 1) * frameWA;
      const hairTop = new Int16Array(frameWA).fill(-1);
      const hairBot = new Int16Array(frameWA).fill(-1);
      for (let x = x0; x < x1; x++)
        for (let y = 0; y < h; y++)
          if (hair.data[(y*w+x)*4+3] >= 128) {
            if (hairTop[x-x0] < 0) hairTop[x-x0] = y;
            hairBot[x-x0] = y;
          }
      // The dome is a true HALF-ELLIPSE computed from the head's bounding box
      // only — NOT from the hair's own column profile (that just re-created
      // the hairstyle's silhouette). Every hair pixel is still covered
      // (domeTop is clamped above hairTop), but the outline is the ellipse's.
      let minC = -1, maxC = -1, headTop = h, headBot = -1;
      for (let cx = 0; cx < frameWA; cx++) {
        if (hairTop[cx] < 0) continue;
        if (minC < 0) minC = cx;
        maxC = cx;
        if (hairTop[cx] < headTop) headTop = hairTop[cx];
        if (hairBot[cx] > headBot) headBot = hairBot[cx];
      }
      if (minC < 0) continue;
      const ecx = (minC + maxC) / 2;
      const rx = (maxC - minC) / 2 + 0.5;        // snug — no wider than the hair
      const ry = headBot - headTop + 1;
      const cheekY = headTop + Math.round(ry * 0.6);   // taper starts at cheek level
      for (let cx = minC; cx <= maxC; cx++) {
        const t = (cx - ecx) / rx;
        if (t * t > 1) continue;
        let domeTop = Math.round(headBot - ry * Math.sqrt(1 - t * t));
        if (hairTop[cx] >= 0 && hairTop[cx] < domeTop) domeTop = hairTop[cx];  // never expose hair
        // Drape (owner's reference): the hood runs all the way DOWN to the
        // shoulder line so it meets the coat as one piece — framing the face
        // and wrapping the neck — instead of stopping at the hairline like a
        // helmet. (`top` is the coat's shoulder row from the body pass.)
        const domeBot = top >= 0 ? top - 1 : (hairBot[cx] >= 0 ? hairBot[cx] : headBot);
        for (let y = Math.max(0, domeTop); y <= domeBot; y++) {
          // Taper below cheek level: the drape narrows toward the neck so the
          // shoulders stay visible (full-width drape read as a bell/ghost).
          if (y > cheekY && Math.abs(cx - ecx) > rx * 0.75) continue;
          const i = (y * w + (x0 + cx)) * 4;
          if (skin.data[i+3] >= 128) continue;    // face opening
          hood[y * w + x0 + cx] = 1;
        }
      }
      // Hood PEAK: a small 2px point at the dome's crown — the giveaway
      // detail no hairstyle has, so the hood never reads as "yellow hair".
      {
        let crown = h;
        for (let cx = minC; cx <= maxC; cx++)
          for (let y = 0; y < h; y++)
            if (hood[y * w + x0 + cx]) { if (y < crown) crown = y; break; }
        const px = x0 + Math.round(ecx);
        if (crown - 1 >= 0) hood[(crown - 1) * w + px] = 1;
        if (crown - 2 >= 0) hood[(crown - 2) * w + px] = 1;
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
    // Pass 3: paint the HOOD — flat slicker yellow with its own shading, so
    // zero hair texture bleeds through: dark outline where the dome meets
    // nothing/body, dark rim where it borders the face (drawstring edge),
    // lighter crown highlight on the dome's top row.
    const HOOD_FLAT = [Math.round(COAT[0]*1.0), Math.round(COAT[1]*1.0), Math.round(COAT[2]*1.0)];
    for (let p = 0; p < w * h; p++) {
      if (!hood[p]) continue;
      const x = p % w, y = (p / w) | 0, i = p * 4;
      const nb = [[x-1,y],[x+1,y],[x,y-1],[x,y+1]];
      let edge = false, rim = false;
      for (const [nx, ny] of nb) {
        if (nx < 0 || nx >= w || ny < 0 || ny >= h) { edge = true; continue; }
        const q = ny * w + nx;
        if (skin.data[q*4+3] >= 128) rim = true;
        else if (!hood[q] && !sil[q]) edge = true;
      }
      let r = HOOD_FLAT[0], g = HOOD_FLAT[1], b = HOOD_FLAT[2];
      if (rim)       { r = Math.round(r*0.55); g = Math.round(g*0.55); b = Math.round(b*0.55); }
      else if (edge) { r = Math.round(r*0.45); g = Math.round(g*0.45); b = Math.round(b*0.45); }
      out.data[i] = r; out.data[i+1] = g; out.data[i+2] = b; out.data[i+3] = 255;
    }
    fs.writeFileSync(path.join(LDIR, `${CAP(char)}_${suffix}_wear_raincoat.png`), PNG.sync.write(out));
  }
  console.log(`raincoat layers: ${char} OK`);
}
console.log('DONE');
