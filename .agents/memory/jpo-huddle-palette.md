---
name: JPO Huddle palette swap zones
description: Hardcoded per-character hair/skin/shirt/pants zone colors with Y-range clamping. Authoritative source for all palette swap tuning decisions.
---

# Core principle: hard Y cut between hair and shirt

Hair and shirt share the same color family for all characters. The ONLY reliable way to separate them is a hard Y-row boundary — hair owns y < cutY, shirt owns y >= cutY. Do NOT rely on color distance alone.

- Adam / Bob: cut at **y=17** (head is slightly taller)
- Alex / Amelia: cut at **y=16**

# Why auto-detection fails

1. **Skin heuristic** — Alex/Amelia's warm brown hair satisfies `r > g+20 && r > b+28`, so "skin" detector changes hair.
2. **Spatial zone cuts** — Characters start at y≈9–10 (rows 0–8 are transparent). A naive 38% cut at y≈12 only captures 2–3 visible rows.
3. **Color-only threshold** — For Alex/Amelia the shirt body color (138,101,82) is also present in the head area. No threshold separates them without Y masking.

# The collar-row rule (hard-won)

**All four characters use hair = y<17, shirt = y>=17.** The collar row y=16 must be inside the HAIR zone for every character.

Why: Row y=16 spans the full character width. If it's in the shirt zone, picking a shirt color turns the full-width collar vivid yellow directly below the hair — visually merging with the sandy-gold hair above it. The user sees the entire top as yellow and perceives "shirt changed hair."

Adam/Bob already had yMax=17 for hair (correct). Alex/Amelia previously had yMax=16 for hair (bug): the collar ended up in the shirt zone.

# `_swapColorsData` signature

```js
_swapColorsData(pixels, sr, sg, sb, tr, tg, tb, threshold, fw, yMin, yMax)
```
- `fw` = image width in pixels; needed to compute `y = Math.floor(i / (fw * 4))`
- `yMax` is **exclusive** (y < yMax)
- Pass `fw=16` from `_redrawPreview`, `fw=sw` from run-sheet builder, `fw=sc.width` from sit-sheet builder

# Hardcoded zone table (CHAR_ZONE_COLORS in index.html)

| char   | zone  | r,g,b         | t  | yMin | yMax | notes |
|--------|-------|---------------|----|------|------|-------|
| adam   | hair  | 149,157,88    | 80 | —    | 17   | t=80 to catch (95,105,74) head pixels too |
| adam   | skin  | 255,203,176   | 50 | —    | —    | |
| adam   | shirt | 93,96,67      | 40 | 17   | 23   | body only; cut at y=17 |
| adam   | pants | 159,116,168   | 50 | 23   | —    | |
| adam   | shoe  | 93,96,67      | 40 | 26   | —    | same olive as shirt; swapped to pants color |
| alex   | hair  | 138,101,82    | 65 | 11   | 16   | t=65 to also catch bright (186,141,94) hair |
| alex   | skin  | 255,203,176   | 50 | —    | —    | |
| alex   | shirt | 138,101,82    | 40 | 16   | 24   | same source, body zone only; cut at y=16 |
| alex   | pants | 162,57,75     | 50 | 24   | —    | |
| amelia | hair  | 138,101,82    | 65 | 11   | 16   | |
| amelia | skin  | 191,139,120   | 50 | —    | —    | |
| amelia | shirt | 138,101,82    | 40 | 16   | 24   | |
| amelia | pants | 185,93,114    | 50 | 24   | —    | |
| bob    | hair  | 113,107,110   | 25 | —    | 17   | tight t=25: shirt (93,88,95) is only dist=23 away |
| bob    | skin  | 255,203,176   | 50 | —    | —    | |
| bob    | shirt | 93,88,95      | 40 | 17   | 23   | body only; cut at y=17 |
| bob    | pants | 194,184,213   | 50 | 23   | —    | |

# Adam shoe zone

Adam's shoes (y=28–31) are the exact same olive-green (93,96,67) as his shirt. The `shoe` zone entry causes `_applySwaps` to run an extra swap of those pixels to the chosen **pants** color, so the full lower half matches the pants selection.

# Swap order

`_applySwaps` runs: skin → hair → shirt → pants (+shoe). Hair runs before shirt so any boundary pixels get assigned to hair first; shirt then skips already-swapped pixels.

# Adding new characters

Dump frame-0 pixels with Python/Pillow to identify zone colors:
```python
from PIL import Image
img = Image.open("Char_run_16x16.png").convert("RGBA")
for y in range(9, 32):
    row = [(x, img.getpixel((x, y))) for x in range(16)]
    vis = [(x,(r,g,b)) for x,(r,g,b,a) in row if a>128 and not (r<92 and g<92 and b<92)]
    if vis: print(f"  y={y}: {vis}")
```
Find the cut-Y by looking at where head pixels end and shirt body begins. Do NOT use heuristic auto-detection.
