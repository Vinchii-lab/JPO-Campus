---
name: JPO Huddle palette swap zones
description: Hardcoded per-character hair/skin/shirt/pants zone colors with Y-range clamping. Authoritative source for all palette swap tuning decisions.
---

# Core principle: hard Y cut between hair and shirt

Hair and shirt share the same color family for all characters. The ONLY reliable way to separate them is a hard Y-row boundary. Do NOT rely on color distance alone.

## `shirtYMax` — dynamic hair zone shrink when shirt is selected

For characters where the hair zone extends into the shirt zone (Adam, Amelia), the hair zone config has a `shirtYMax` field. `_applySwaps` uses it when `shirtIdx > 0`: `hairYMax = shirtIdx && zone.hair.shirtYMax != null ? shirtYMax : yMax`.

- **Hat only selected**: hair uses full `yMax` → whole olive region changes together (looks complete)
- **Shirt also selected**: hair shrinks to `shirtYMax` → shirt zone gets its pixels back

| char   | hair yMax (hat-only) | hair shirtYMax (hat+shirt) | shirt yMin |
|--------|----------------------|---------------------------|------------|
| adam   | 23                   | 18                        | 17         |
| amelia | 24                   | 16                        | 16         |
| alex   | 17                   | (none needed)             | 16         |
| bob    | 17                   | (none needed)             | 17         |

# Why auto-detection fails

1. **Skin heuristic** — Alex/Amelia's warm brown hair satisfies `r > g+20 && r > b+28`, so "skin" detector changes hair.
2. **Spatial zone cuts** — Characters start at y≈9–10 (rows 0–8 are transparent). A naive 38% cut at y≈12 only captures 2–3 visible rows.
3. **Color-only threshold** — For Alex/Amelia the shirt body color (138,101,82) is also present in the head area. No threshold separates them without Y masking.

# Hair source selection: use the MID-RANGE hair color (138,101,82)

Use `(138,101,82)` as the hair source for Alex/Amelia — NOT `(186,141,94)`.

**Why the bright highlight source (186,141,94) is WRONG:**
- Outlines (86,89,114) are dist=114 away → NOT caught → outlines stay blue-purple → hair looks thin/incomplete.
- With source (138,101,82), outlines (86,89,114) are dist=62 → caught at t=65 → luminance-scaled to a correctly-dark shade of the chosen hair color → outlines look like natural dark hair outlines ✓

**Why outlines SHOULD be caught:**
- At pixel-art scale, including the outline pixels makes the hair look full and complete.
- Luminance scaling preserves the darkness: dark outlines → dark hair-colored outlines. This is visually correct.
- NOT catching outlines makes the hair look like a thin unbordered blob.

# The collar-row rule (Alex)

Alex's collar at y=16 is brownish (same as hair), not shirt. Include it in the HAIR zone (yMax=17).

- With **only hair selected**: y=11..16 → hair color. Collar matches hair ✓
- With **only shirt selected**: y=16..23 shirt zone catches (138,101,82) at y=16 → collar turns shirt color ✓ (hair zone skipped since hairIdx=0)
- With **both selected**: y=11..16 → hair color first; shirt zone at y=16 finds already-swapped pixels (not brownish anymore) → shirt doesn't override collar → collar stays hair color ✓

# Amelia's flowing hair rule

Amelia's hair flows from y=11 all the way to y=23. Use `yMax=24` to cover the full visible flowing hair.

- The shirt zone (yMin=16, yMax=24) overlaps. Since hair swap runs first, shirt has no effect on y=16..23 when hair is selected.
- If ONLY shirt is selected (hairIdx=0): hair swap skipped → shirt catches y=16..23 brownish pixels → shirt color shows ✓
- 6 skin pixels (181,121,114) at y=17..22 are dist=57 from source → caught at t=65 → turn hair color → makes hair look more solid (no skin gaps between hair strands). Acceptable trade-off.

# The shirt threshold rule

Shirt `t=15` for Alex/Amelia stops the flowing-hair shade `(149,115,80)` at dist=18 > 15 from being caught in the shirt zone when no hair selected. Do NOT raise shirt t above 15 for these characters.

# Hardcoded zone table (CHAR_ZONE_COLORS in index.html)

| char   | zone  | r,g,b         | t  | yMin | yMax | notes |
|--------|-------|---------------|----|------|------|-------|
| adam   | hair  | 110,118,78    | 80 | —    | **23** | yMax=23 hat-only; shirtYMax=18 when shirt selected (gives shirt y=18..22) |
| adam   | skin  | 255,203,176   | 50 | —    | —    | |
| adam   | shirt | 93,96,67      | 40 | 17   | 23   | body only; cut at y=17 |
| adam   | pants | 159,116,168   | 50 | 23   | —    | |
| adam   | shoe  | 93,96,67      | 40 | 26   | —    | same olive as shirt; swapped to pants color |
| alex   | hair  | 138,101,82    | 65 | 11   | **17** | yMax=17: includes collar row at y=16 in hair zone |
| alex   | skin  | 255,203,176   | 50 | —    | —    | |
| alex   | shirt | 138,101,82    | 15 | 16   | 24   | overlaps hair at y=16; hair runs first so collar follows hair |
| alex   | pants | 162,57,75     | 50 | 24   | —    | |
| amelia | hair  | 138,101,82    | 65 | 11   | **24** | yMax=24: covers FULL flowing hair to bottom of body zone |
| amelia | skin  | 191,139,120   | 50 | —    | —    | |
| amelia | shirt | 138,101,82    | 15 | 16   | 24   | mostly overridden by hair zone; only active when no hair selected |
| amelia | pants | 185,93,114    | 50 | 24   | —    | |
| bob    | hair  | 113,107,110   | **35** | — | 17   | t=35: catches (93,88,95) at dist=31 for 56px total; Y-mask separates from shirt |
| bob    | skin  | 255,203,176   | 50 | —    | —    | |
| bob    | shirt | 93,88,95      | 40 | 17   | 23   | body only; cut at y=17 |
| bob    | pants | 194,184,213   | 50 | 23   | —    | |

# Adam shoe zone

Adam's shoes (y=28–31) are the exact same olive-green (93,96,67) as his shirt. The `shoe` zone entry causes `_applySwaps` to run an extra swap of those pixels to the chosen **pants** color, so the full lower half matches the pants selection.

# Swap order

`_applySwaps` runs: skin → hair → shirt → pants (+shoe for Adam). Hair runs before shirt; this is critical for collar/flowing-hair overlap zones.

# `_swapColorsData` signature

```js
_swapColorsData(pixels, sr, sg, sb, tr, tg, tb, threshold, fw, yMin, yMax)
```
- `fw` = image width in pixels; needed to compute `y = Math.floor(i / (fw * 4))`
- `yMax` is **exclusive** (y < yMax)
- Pass `fw=16` from `_redrawPreview`, `fw=sw` from run-sheet builder, `fw=sc.width` from sit-sheet builder

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
- Find cut-Y where head pixels end and shirt body begins.
- Use MID-RANGE hair color as source (not brightest, not darkest) so outlines are within catch radius.
- Outlines being caught is CORRECT — luminance scaling turns them into dark hair-colored outlines.
- Do NOT use heuristic auto-detection.
