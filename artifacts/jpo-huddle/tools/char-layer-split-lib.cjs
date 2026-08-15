// Shared zone tables + classifier for the layered-character rebuild.
// MUST mirror CHAR_ZONE_COLORS / SIT_ANATOMY / _sitZones / _swapColorsData in
// public/index.html — this is the single offline source of truth for both the
// splitter (char-layer-split.cjs) and the acceptance test (char-layer-verify.cjs).
const CHAR_ZONE_COLORS = {
  adam: {
    hair:  { r:110, g:118, b:78,  t:80, yMax:23 },
    skin:  { r:255, g:203, b:176, t:50 },
    shirt: { r:159, g:116, b:168, t:50, yMin:23 },
    pants: { r:93,  g:96,  b:67,  t:40, yMin:23 },
  },
  alex: {
    hair:        { r:186, g:141, b:94, t:65, yMin:10, yMax:23 },
    hairOutline: { r:70,  g:70,  b:94, t:35, yMin:10, yMax:23, darkRatio:0.49 },
    skin:  { r:255, g:203, b:176, t:50 },
    shirt: { r:162, g:57,  b:75,  t:73, yMin:23 },
    pants: { r:120, g:125, b:147, t:40, yMin:23 },
  },
  amelia: {
    hair:        { r:138, g:101, b:82, t:65, yMin:11, yMax:24, shirtYMax:20, flowXMax:8 },
    hairOutline: { r:70,  g:70,  b:94, t:22, yMin:11, yMax:24, darkRatio:0.66 },
    skin:  { r:191, g:139, b:120, t:50 },
    shirt: { r:185, g:93,  b:114, t:40, yMin:20, yMax:24, xMin:8 },
    pants: { r:185, g:93,  b:114, t:50, yMin:24 },
  },
  bob: {
    hair:        { r:113, g:107, b:110, t:60, yMax:23 },
    hairOutline: { r:58,  g:58,  b:80,  t:18, yMax:23, darkRatio:0.55 },
    skin:  { r:255, g:203, b:176, t:50 },
    shirt: { r:70,  g:70,  b:94,  t:70, yMin:23, yMax:28 },
    pants: { r:70,  g:70,  b:94,  t:70, yMin:28 },
  },
};
const SIT_ANATOMY = {
  down:  { hairYMax:22, split:28 },
  right: { hairYMax:22, split:29 },
  up:    { hairYMax:17, split:24 },
};
// mirror of client _sitZones (Adam is never passed through it)
function sitZones(char, dir) {
  const base = CHAR_ZONE_COLORS[char];
  const a = SIT_ANATOMY[dir] || SIT_ANATOMY.down;
  const sharedSrc = base.shirt && base.pants &&
    base.shirt.r === base.pants.r && base.shirt.g === base.pants.g && base.shirt.b === base.pants.b;
  const z = { ...base };
  if (base.hair)        z.hair        = { ...base.hair, yMin:undefined, yMax:a.hairYMax, shirtYMax:undefined, flowXMax:undefined };
  if (base.hairOutline) z.hairOutline = { ...base.hairOutline, yMin:undefined, yMax:a.hairYMax };
  if (base.shirt) z.shirt = { ...base.shirt, yMin:a.hairYMax, yMax:sharedSrc ? a.split : undefined, xMin:undefined };
  if (base.pants) z.pants = { ...base.pants, yMin:sharedSrc ? a.split : a.hairYMax, yMax:undefined, xMin:undefined };
  return z;
}
// One zone match test — same geometry/threshold rules as _swapColorsData.
function zoneMatch(z, r, g, b, x, y) {
  if (!z) return false;
  if (z.yMin !== undefined && y < z.yMin) return false;
  if (z.yMax !== undefined && y >= z.yMax) return false;
  if (z.xMin !== undefined && x < z.xMin) return false;
  if (z.xMax !== undefined && x >= z.xMax) return false;
  const dr = r - z.r, dg = g - z.g, db = b - z.b;
  return dr*dr + dg*dg + db*db <= z.t * z.t;
}
// Partition priority — mirrors _applySwaps order WITH a shirt selected (hair
// capped at shirtYMax + flowing-hair region), so Amelia's plaid stays shirt.
function classify(zones, r, g, b, x, y) {
  const h = zones.hair;
  if (h) {
    const capped = h.shirtYMax != null ? { ...h, yMax: h.shirtYMax } : h;
    if (zoneMatch(capped, r, g, b, x, y)) return 'hair';
    if (h.shirtYMax != null && h.flowXMax != null &&
        zoneMatch({ ...h, yMin: h.shirtYMax, xMax: h.flowXMax }, r, g, b, x, y)) return 'hair';
    // Flowing hair BEYOND flowXMax in the capped band (Amelia's right-side
    // strands): hair-threshold pixels there are hair UNLESS the shirt zone
    // claims them by its own color test (keeps the plaid in the shirt layer).
    if (h.shirtYMax != null &&
        zoneMatch({ ...h, yMin: h.shirtYMax }, r, g, b, x, y) &&
        !zoneMatch(zones.shirt, r, g, b, x, y)) return 'hair';
    if (zoneMatch(zones.hairOutline, r, g, b, x, y)) return 'hairOutline';
  }
  if (zoneMatch(zones.skin, r, g, b, x, y)) return 'skin';
  if (zoneMatch(zones.shirt, r, g, b, x, y)) return 'shirt';
  if (zoneMatch(zones.pants, r, g, b, x, y)) return 'pants';
  return 'body';
}
// Faithful port of the client's _swapColorsData (luminance-preserving tint).
function swapColorsData(pixels, sr, sg, sb, tr, tg, tb, threshold, fw, yMin, yMax, xMin, xMax, frameW, srcPixels) {
  const src = srcPixels || pixels;
  const srcLum = (0.299*sr + 0.587*sg + 0.114*sb) || 1;
  const t2 = threshold * threshold;
  const rowBytes = (fw || 0) * 4;
  const useY = rowBytes > 0 && (yMin !== undefined || yMax !== undefined);
  const useX = rowBytes > 0 && (xMin !== undefined || xMax !== undefined);
  const fwX  = frameW || fw;
  for (let i = 0; i < pixels.length; i += 4) {
    if (src[i+3] < 128) continue;
    if (useY || useX) {
      const y = Math.floor(i / rowBytes);
      if (useY) {
        if (yMin !== undefined && y < yMin) continue;
        if (yMax !== undefined && y >= yMax) continue;
      }
      if (useX) {
        const x = ((i >> 2) % fw) % fwX;
        if (xMin !== undefined && x < xMin) continue;
        if (xMax !== undefined && x >= xMax) continue;
      }
    }
    const dr = src[i]-sr, dg = src[i+1]-sg, db = src[i+2]-sb;
    if (dr*dr + dg*dg + db*db > t2) continue;
    const lum = (0.299*src[i] + 0.587*src[i+1] + 0.114*src[i+2]) / srcLum;
    pixels[i]   = Math.min(255, Math.round(tr * lum));
    pixels[i+1] = Math.min(255, Math.round(tg * lum));
    pixels[i+2] = Math.min(255, Math.round(tb * lum));
  }
}
// Faithful port of the client's _applySwaps (idx args are truthy flags; colors
// passed explicitly instead of via the palette tables).
function applySwaps(pixels, zones, hair, skin, shirt, pants, fw, frameW) {
  if (hair && zones?.hair) {
    const [r,g,b] = hair;
    const hairYMax = (shirt && zones.hair.shirtYMax != null) ? zones.hair.shirtYMax : zones.hair.yMax;
    swapColorsData(pixels, zones.hair.r, zones.hair.g, zones.hair.b, r,g,b, zones.hair.t??44, fw, zones.hair.yMin, hairYMax, zones.hair.xMin, zones.hair.xMax, frameW);
    if (shirt && zones.hair.flowXMax != null && hairYMax < zones.hair.yMax) {
      swapColorsData(pixels, zones.hair.r, zones.hair.g, zones.hair.b, r,g,b, zones.hair.t??44, fw, hairYMax, zones.hair.yMax, zones.hair.xMin, zones.hair.flowXMax, frameW);
    }
    if (zones.hairOutline) {
      const oz = zones.hairOutline, ratio = oz.darkRatio ?? 0.5;
      swapColorsData(pixels, oz.r, oz.g, oz.b, Math.round(r*ratio), Math.round(g*ratio), Math.round(b*ratio), oz.t??22, fw, oz.yMin, oz.yMax, oz.xMin, oz.xMax, frameW);
    }
  }
  if (skin && zones?.skin) { const [r,g,b]=skin; swapColorsData(pixels,zones.skin.r,zones.skin.g,zones.skin.b,r,g,b,zones.skin.t??50,fw,zones.skin.yMin,zones.skin.yMax,zones.skin.xMin,zones.skin.xMax,frameW); }
  const clothesSrc = (shirt || pants) ? Buffer.from(pixels) : null;
  if (shirt && zones?.shirt) { const [r,g,b]=shirt; swapColorsData(pixels,zones.shirt.r,zones.shirt.g,zones.shirt.b,r,g,b,zones.shirt.t??40,fw,zones.shirt.yMin,zones.shirt.yMax,zones.shirt.xMin,zones.shirt.xMax,frameW,clothesSrc); }
  if (pants && zones?.pants) { const [r,g,b]=pants; swapColorsData(pixels,zones.pants.r,zones.pants.g,zones.pants.b,r,g,b,zones.pants.t??50,fw,zones.pants.yMin,zones.pants.yMax,zones.pants.xMin,zones.pants.xMax,frameW,clothesSrc); }
}
// The luminance tint for one pixel (same math as swapColorsData's write step).
function tintPixel(data, i, sr, sg, sb, tr, tg, tb) {
  const srcLum = (0.299*sr + 0.587*sg + 0.114*sb) || 1;
  const lum = (0.299*data[i] + 0.587*data[i+1] + 0.114*data[i+2]) / srcLum;
  data[i]   = Math.min(255, Math.round(tr * lum));
  data[i+1] = Math.min(255, Math.round(tg * lum));
  data[i+2] = Math.min(255, Math.round(tb * lum));
}
module.exports = { CHAR_ZONE_COLORS, SIT_ANATOMY, sitZones, zoneMatch, classify, swapColorsData, applySwaps, tintPixel };
