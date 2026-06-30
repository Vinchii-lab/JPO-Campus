---
name: JPO Huddle palette swap zones
description: Hardcoded per-character hair/skin/shirt/pants zone colors with Y-range clamping. Authoritative source for all palette swap tuning decisions.
---

# Core principle: hard Y cut between hair and shirt

Hair and shirt share the same color family for all characters. The ONLY reliable way to separate them is a hard Y-row boundary. Do NOT rely on color distance alone.

## `shirtYMax` — dynamic hair zone shrink when shirt is selected

For characters where the hair zone extends into the shirt zone (Adam, Amelia), the hair zone config has a `shirtYMax` field. `_applySwaps` uses it when `shirtIdx > 0`: `hairYMax = shirtIdx && zone.hair.shirtYMax != null ? shirtYMax : yMax`.

- **Hat only selected**: hair uses full `yMax` → whole region changes together
- **Shirt also selected**: hair shrinks to `shirtYMax` → shirt zone gets its pixels back

| char   | hair yMax (hat-only) | hair shirtYMax (hat+shirt) | shirt yMin | shirt t |
|--------|----------------------|---------------------------|------------|---------|
| adam   | 23                   | **17**                    | 17         | **11**  |
| amelia | 24                   | **20**                    | **20**     | **50**  |
| alex   | 19                   | (none needed)             | **17**     | 20      |
| bob    | 17                   | (none needed)             | 17         | 40      |

# Why auto-detection fails

1. **Skin heuristic** — Alex/Amelia's warm brown hair satisfies `r > g+20 && r > b+28`, so "skin" detector changes hair.
2. **Spatial zone cuts** — Characters start at y≈9–10 (rows 0–8 are transparent). A naive 38% cut at y≈12 only captures 2–3 visible rows.
3. **Color-only threshold** — For Alex/Amelia the shirt body color (138,101,82) is also present in the head area. No threshold separates them without Y masking.

# Hair source selection: character-specific rules

**Alex**: use bright-highlight `(186,141,94)` with t=65.
- Alex skin (255,203,176) is dist=124 → completely safe.
- Alex shirt source stays (138,101,82) — different from hair source, no cross-contamination.
- Outlines (86,89,114) at dist=114 > 65 → stay dark ✓

**Amelia**: use mid-range `(138,101,82)` with t=65. Do NOT use (186,141,94) here.
- Amelia skin (191,139,120) is dist=**26.5** from (186,141,94) → face pixels at y=18..21 get HAIR colored if you use the bright source. Bug confirmed by pixel dump.
- Amelia skin (191,139,120) is dist=**75.5** from (138,101,82) → safely outside t=65 ✓
- With (138,101,82), outlines (86,89,114) at dist=62 < 65 are caught — luminance-scaled to dark hair outlines, which looks correct at pixel-art scale ✓

# The xMin sheet-coordinate bug — FIXED

**Problem**: `xMin:8` in Amelia's shirt zone used absolute SHEET x-coordinates (0..383 for a 384px sheet). In frame 0 (sheet x=0..15), x=8 correctly excluded the left half. But in frames 1–23, sheet x=16..383 all exceeded 8, so the flowing-hair columns (frame-local x=0..7) were shirt-colored in every animation frame after frame 0.

**Fix**: Added `frameW` parameter to `_swapColorsData` and `_applySwaps`. When `frameW` is provided, x-coordinate is computed as `((i >> 2) % fw) % frameW` — this gives frame-local x regardless of which frame in the sheet. `_buildPlayerTex` now passes `frameW=16` (both main and sit variant). Preview (`_redrawPreview`) uses fw=16 so x%16=x — behavior unchanged there.

# The collar-row gap (Alex) — FIXED

With the old config (shirt yMin=19, hair yMax=17), rows y=17..18 were never touched by either zone — they showed original brownish even with purple clothes selected.

**Fix applied:**
- Alex hair `yMax:19` — hair covers y=11..18 (hair runs first, wins those rows when hairIdx>0)
- Alex shirt `yMin:17` — shirt covers y=17..23 (when no hair: collar rows get clothes color; when hair+clothes: hair wins y=17..18, shirt gets y=17..23 but finds those pixels already recolored)
- Result: clean visual boundary — no brownish collar gap regardless of color selection

# Amelia's flowing hair — special shirt source solution

Amelia's HAIR source (138,101,82) also fills x=2..7, y=20..23 (the shirt zone). Using hair source as shirt source caused ALL flowing-hair pixels in the shirt zone to turn shirt color.

**The fix: Amelia's shirt source = `(185,93,114)` (plaid source) with t=50:**
- dist² from `(138,101,82)` to `(185,93,114)` = 3297 > t²=2500 → flowing hair NOT caught ✓
- dist² from `(181,121,114)` = 800 < 2500 → plaid caught ✓
- dist² from `(170,94,86)` = 1010 < 2500 → plaid caught ✓
- `xMin:8` on shirt zone + `frameW=16` fix → only shirt fabric (x=8..15) gets shirt color in ALL 24 animation frames ✓
- `flowXMax:8` on hair config → second hair pass covers y=20..23 x=0..7 (flowing hair preserved) ✓

# Data model: clothesIdx (not shirtIdx/pantsIdx)

The builder was simplified from 4 steps to 3 steps. Shirt and pants now share a single `clothesIdx` value. The client emits `clothesIdx`, the server stores `clothesIdx`, and `_applySwaps` receives it as both `shirtIdx` and `pantsIdx` internally. Zone configs (shirt/pants entries in CHAR_ZONE_COLORS) are unchanged — the same value just gets applied to both.

# Hardcoded zone table (CHAR_ZONE_COLORS in index.html)

| char   | zone  | r,g,b         | t  | yMin | yMax | notes |
|--------|-------|---------------|----|------|------|-------|
| adam   | hair  | 110,118,78    | 80 | —    | **23** | yMax=23 hat-only; shirtYMax=17 when shirt selected |
| adam   | skin  | 255,203,176   | 50 | —    | —    | |
| adam   | shirt | 93,96,67      | **11** | 17 | 23 | t=11 (t²=121) — only pure (93,96,67) caught; collar (95,105,74) dist²=134 excluded |
| adam   | pants | 159,116,168   | 50 | 23   | —    | |
| adam   | shoe  | 93,96,67      | 11 | 26   | —    | same olive as shirt; swapped to pants color |
| alex   | hair  | **186,141,94** | 65 | 11 | **19** | bright-highlight source; outlines dist=114>65, not caught; yMax=19 covers collar rows |
| alex   | skin  | 255,203,176   | 50 | —    | —    | |
| alex   | shirt | 138,101,82    | **20** | **17** | 24 | yMin=17 covers collar rows; when hair selected, hair wins y=17..18 first |
| alex   | pants | 162,57,75     | 50 | 24   | —    | |
| amelia | hair  | **138,101,82** | 65 | 11 | **24** | mid-range source — NOT 186,141,94 (Amelia skin dist=26, face gets colored); yMax=24; shirtYMax=20; flowXMax=8 |
| amelia | skin  | 191,139,120   | 50 | —    | —    | |
| amelia | shirt | **185,93,114** | **50** | **20** | 24 | PLAID source — NOT hair source; xMin:8 + frameW=16 fix stops per-frame bleed |
| amelia | pants | 185,93,114    | 50 | 24   | —    | |
| bob    | hair  | 113,107,110   | **50** | — | 17   | t=50: catches edge-fill (85,81,87) at dist=45 → no toupee; (70,70,94) outlines at dist=59 stay dark; shirt yMin=17 so no Y-overlap |
| bob    | skin  | 255,203,176   | 50 | —    | —    | |
| bob    | shirt | 93,88,95      | 40 | 17   | 23   | body only; cut at y=17 |
| bob    | pants | 194,184,213   | 50 | 23   | —    | |

# Adam shoe zone

Adam's shoes (y=28–31) are the exact same olive-green (93,96,67) as his shirt. The `shoe` zone entry causes `_applySwaps` to run an extra swap of those pixels to the chosen **pants** color, so the full lower half matches the pants selection.

# Swap order

`_applySwaps` runs: skin → hair → shirt → pants (+shoe for Adam). Hair runs before shirt; this is critical for collar/flowing-hair overlap zones.

# `_swapColorsData` / `_applySwaps` signatures

```js
_swapColorsData(pixels, sr, sg, sb, tr, tg, tb, threshold, fw, yMin, yMax, xMin, xMax, frameW)
_applySwaps(pixels, zones, hairIdx, skinIdx, shirtIdx, pantsIdx, fw, frameW)
```
- `fw` = sheet width in pixels; needed to compute `y = Math.floor(i / (fw * 4))`
- `frameW` = per-frame width for x-masking. Pass `16` from `_buildPlayerTex` (multi-frame sheet). Omit/undefined from `_redrawPreview` (fw=16 already, so x%16=x — no change).
- `yMax` is **exclusive** (y < yMax)
- In `_buildPlayerTex`: call `_applySwaps(..., sw, 16)` for BOTH main sheet and sit-sheet variants

# Pixel-dump recipe for tuning

```python
from PIL import Image
img = Image.open("Char_run_16x16.png").convert("RGBA")
SR,SG,SB=186,141,94   # use bright-highlight source for Alex/Amelia
for y in range(11,25):
    row=[]
    for x in range(16):
        r,g,b,a=img.getpixel((x,y))
        if a<128: continue
        dr,dg,db=r-SR,g-SG,b-SB
        dist=(dr*dr+dg*dg+db*db)**0.5
        if dist<80: row.append(f"x{x}:d={dist:.0f}")
    if row: print(f"  y={y}: {' '.join(row)}")
```
Use this to find the first Y row where brownish pixels are ONLY shirt fabric (not hair), and confirm outlines (86,89,114) are NOT within threshold.

# Adding new characters

- Find cut-Y where head pixels end and shirt body begins.
- Use BRIGHT-HIGHLIGHT hair color as source (not mid-range) — outlines fall outside threshold, plaid/shirt colors unlikely to interfere.
- If hair and shirt share the same source color (common for characters with flowing hair), use the PANTS SOURCE as the shirt source instead — the plaid/fabric pixels of the shirt often match the pants fabric color, and Y masking (yMax vs yMin at the same boundary) keeps them fully separate.
- Do NOT use heuristic auto-detection.
