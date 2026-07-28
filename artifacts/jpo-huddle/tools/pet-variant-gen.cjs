// Pet breed/color variant generator: recolors the base pet sprites in
// public/assets/pets/ into variant PNGs via HAND-TUNED per-variant hue rules
// (the palette-swap lesson: auto-detection fails; classify pixels explicitly).
// Run from a dir that can resolve pngjs, e.g.:
//   node artifacts/jpo-huddle/tools/pet-variant-gen.cjs   (pngjs installed nearby)
// Output ids MUST match server PETS + client PETS entries.
const path = require("path");
let PNG;
try { ({ PNG } = require("pngjs")); }
catch { ({ PNG } = require("/tmp/petgen/node_modules/pngjs")); }
const fs = require("fs");
const DIR = "/home/runner/workspace/artifacts/jpo-huddle/public/assets/pets";

// ── color helpers ────────────────────────────────────────────────────────────
function rgb2hsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0));
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return [h * 60, s, l];
}
function hsl2rgb(h, s, l) {
  h = ((h % 360) + 360) % 360 / 360;
  if (s === 0) { const v = Math.round(l * 255); return [v, v, v]; }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
  const f = (t) => {
    t = ((t % 1) + 1) % 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return [f(h + 1 / 3), f(h), f(h - 1 / 3)].map((v) => Math.round(v * 255));
}
const clamp01 = (v) => Math.min(1, Math.max(0, v));

// Each rule: match(h,s,l) → and remap(h,s,l) → [h,s,l]. First match wins;
// no match = pixel unchanged (outlines, eyes, whites survive untouched).
const VARIANTS = {
  // Office Cat (orange tabby, white muzzle/paws; fur hue ~15–55°)
  "pet_cat_black.png": { base: "pet_cat.png", rules: [
    { m: (h, s) => s > 0.22 && h >= 8 && h <= 60, r: (h, s, l) => [270, 0.06, clamp01(l * 0.34 + 0.04)] },
  ]},
  "pet_cat_snow.png": { base: "pet_cat.png", rules: [
    { m: (h, s) => s > 0.22 && h >= 8 && h <= 60, r: (h, s, l) => [210, 0.07, clamp01(0.62 + l * 0.34)] },
  ]},
  // Office Dog (shiba: orange coat + cream chest)
  "pet_dog_husky.png": { base: "pet_dog.png", rules: [
    { m: (h, s, l) => s > 0.25 && h >= 8 && h <= 55 && l < 0.72, r: (h, s, l) => [215, 0.08, clamp01(l * 0.78 + 0.12)] },
  ]},
  "pet_dog_choco.png": { base: "pet_dog.png", rules: [
    { m: (h, s, l) => s > 0.25 && h >= 8 && h <= 55 && l < 0.72, r: (h, s, l) => [22, clamp01(s * 0.85), clamp01(l * 0.52)] },
    { m: (h, s, l) => l >= 0.72 && s > 0.1 && h >= 8 && h <= 60, r: (h, s, l) => [30, 0.35, clamp01(l * 0.93)] },
  ]},
  // Baby Dragon (purple body ~255–315°, orange belly/horns)
  "pet_dragon_crimson.png": { base: "pet_dragon.png", rules: [
    { m: (h, s) => s > 0.15 && h >= 235 && h <= 330, r: (h, s, l) => [352, clamp01(s * 1.05), l] },
  ]},
  "pet_dragon_obsidian.png": { base: "pet_dragon.png", rules: [
    { m: (h, s) => s > 0.15 && h >= 235 && h <= 330, r: (h, s, l) => [260, 0.10, clamp01(l * 0.38 + 0.03)] },
    { m: (h, s) => s > 0.3 && h >= 15 && h <= 60,    r: (h, s, l) => [35, 0.18, clamp01(l * 0.62)] },   // belly → smoky
  ]},
  // Duck (yellow body ~40–60°, orange beak/feet < ~38°)
  "pet_duck_snow.png": { base: "pet_duck.png", rules: [
    { m: (h, s) => s > 0.25 && h >= 38 && h <= 70, r: (h, s, l) => [200, 0.06, clamp01(0.60 + l * 0.38)] },
  ]},
  // Bunny (white/grey coat; keep dark eyes/outline + pink inner ear)
  "pet_bunny_cocoa.png": { base: "pet_bunny.png", rules: [
    { m: (h, s, l) => l > 0.45 && s < 0.30, r: (h, s, l) => [26, 0.42, clamp01(l * 0.55 + 0.05)] },
  ]},
  // Turtle (green skin/shell ~60–170°, brown shell rim ~15–55°)
  "pet_turtle_sapphire.png": { base: "pet_turtle.png", rules: [
    { m: (h, s) => s > 0.15 && h >= 55 && h <= 175, r: (h, s, l) => [212, clamp01(s * 1.0), l] },
    { m: (h, s, l) => s > 0.25 && h >= 12 && h <= 55 && l < 0.6, r: (h, s, l) => [225, clamp01(s * 0.7), clamp01(l * 0.85)] },
  ]},
};

for (const [out, spec] of Object.entries(VARIANTS)) {
  const png = PNG.sync.read(fs.readFileSync(path.join(DIR, spec.base)));
  const d = png.data;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] < 8) continue;                     // transparent
    const [h, s, l] = rgb2hsl(d[i], d[i + 1], d[i + 2]);
    for (const rule of spec.rules) {
      if (rule.m(h, s, l)) {
        const [nh, ns, nl] = rule.r(h, s, l);
        const [r, g, b] = hsl2rgb(nh, ns, nl);
        d[i] = r; d[i + 1] = g; d[i + 2] = b;
        break;
      }
    }
  }
  fs.writeFileSync(path.join(DIR, out), PNG.sync.write(png));
  console.log("wrote", out);
}
