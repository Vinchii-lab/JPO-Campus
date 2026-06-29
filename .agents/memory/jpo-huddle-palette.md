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
| alex   | 17                   | (none needed)             | **19**     | 20      |
| bob    | 17                   | (none needed)             | 17         | 40      |

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

# The collar-row bleed problem (Alex / Amelia)

Alex and Amelia's hair and shirt share the EXACT SAME source color (138,101,82). Their hair strands extend physically into y=17..19 (Alex) and y=17..20 (Amelia) — the same rows as the shirt body. Setting shirt yMin too low causes those hair-height pixels to turn shirt color, which the user sees as "shirt bleeding into hair."

**Fix applied (verified pixel-by-pixel with Pillow dump):**
- Alex shirt `yMin=19` — y=17..18 are still at head-height visually; excluding them stops the bleed.
- Amelia shirt `yMin=20`, hair `shirtYMax=20` — y=17..19 have hair strands at head-height on the right side.
- Shirt `t=20` for Alex (catches (149,115,80) d=18 pixels at y=19+ for better shirt-body coverage).

# Amelia's flowing hair — special shirt source solution

Amelia's HAIR source (138,101,82) also fills x=2..7, y=20..23 (the shirt zone). Using hair source as shirt source caused ALL flowing-hair pixels in the shirt zone to turn shirt color — the classic "bleed into hair" complaint.

**Root cause confirmed by pixel dump:**
- Left side (x=0..7), y=20..23: `(138,101,82)` flowing hair pixels → would turn shirt color
- Right/center side, y=20..23: plaid pixels `(181,121,114)`, `(170,94,86)`, `(191,139,120)` — these are shirt fabric

**The fix: change Amelia's shirt source to `(185,93,114)` (same as pants source) with t=50:**
- dist² from `(138,101,82)` to `(185,93,114)` = 3297 > t²=2500 → flowing hair NOT caught ✓
- dist² from `(181,121,114)` = 800 < 2500 → plaid caught ✓
- dist² from `(170,94,86)` = 1010 < 2500 → plaid caught ✓
- Y zones keep shirt and pants separate even though they share source: shirt `yMax:24` vs pants `yMin:24`

**Why shirtYMax=20 stays relevant:** When BOTH hat and shirt selected, hair still shrinks to y=11..19 so the hat color doesn't double-process the shirt zone.

# Amelia's flowing hair rule

Amelia's hair flows from y=11 all the way to y=23. Use `yMax=24` to cover the full visible flowing hair.

- When BOTH hat and shirt selected: hair covers y=11..19 (shirtYMax=20), shirt covers y=20..23. Clean.
- When ONLY shirt selected (hairIdx=0): hair zone skipped; new shirt source catches PLAID pixels only (not hair).
- When ONLY hat selected: hair covers y=11..23 (full yMax=24). Flowing hair fully recolored ✓

# Hardcoded zone table (CHAR_ZONE_COLORS in index.html)

| char   | zone  | r,g,b         | t  | yMin | yMax | notes |
|--------|-------|---------------|----|------|------|-------|
| adam   | hair  | 110,118,78    | 80 | —    | **23** | yMax=23 hat-only; shirtYMax=17 when shirt selected |
| adam   | skin  | 255,203,176   | 50 | —    | —    | |
| adam   | shirt | 93,96,67      | **11** | 17 | 23 | t=11 (t²=121) — only pure (93,96,67) caught; collar (95,105,74) dist²=134 excluded |
| adam   | pants | 159,116,168   | 50 | 23   | —    | |
| adam   | shoe  | 93,96,67      | 11 | 26   | —    | same olive as shirt; swapped to pants color |
| alex   | hair  | 138,101,82    | 65 | 11   | **17** | yMax=17: hair zone covers y=11..16 incl. collar |
| alex   | skin  | 255,203,176   | 50 | —    | —    | |
| alex   | shirt | 138,101,82    | **20** | **19** | 24 | yMin=19: skips y=17..18 which are at head-height |
| alex   | pants | 162,57,75     | 50 | 24   | —    | |
| amelia | hair  | 138,101,82    | 65 | 11   | **24** | yMax=24: full flowing hair; shirtYMax=20 |
| amelia | skin  | 191,139,120   | 50 | —    | —    | |
| amelia | shirt | **185,93,114** | **50** | **20** | 24 | PLAID source — NOT hair source; same as pants source but Y-separated |
| amelia | pants | 185,93,114    | 50 | 24   | —    | |
| bob    | hair  | 113,107,110   | **35** | — | 17   | t=35: catches (93,88,95) at dist=31; Y-mask separates from shirt |
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

# Pixel-dump recipe for tuning

```python
from PIL import Image
img = Image.open("Char_run_16x16.png").convert("RGBA")
SR,SG,SB=138,101,82
for y in range(14,24):
    row=[]
    for x in range(16):
        r,g,b,a=img.getpixel((x,y))
        if a<128: continue
        dr,dg,db=r-SR,g-SG,b-SB
        dist=(dr*dr+dg*dg+db*db)**0.5
        if dist<80: row.append(f"x{x}:d={dist:.0f}")
    if row: print(f"  y={y}: {' '.join(row)}")
```
Use this to find the first Y row where brownish pixels (d<20) are ONLY on the left-back side of the sprite (x<8), not on the right/front head area. That Y is the correct `shirt yMin`.

# Adding new characters

- Find cut-Y where head pixels end and shirt body begins.
- Use MID-RANGE hair color as source (not brightest, not darkest) so outlines are within catch radius.
- Outlines being caught is CORRECT — luminance scaling turns them into dark hair-colored outlines.
- Do NOT use heuristic auto-detection.
- If hair and shirt share the same source color (common for characters with flowing hair), use the PANTS SOURCE as the shirt source instead — the plaid/fabric pixels of the shirt often match the pants fabric color, and Y masking (yMax vs yMin at the same boundary) keeps them fully separate.
