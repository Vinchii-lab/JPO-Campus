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

# Hair source selection rationale (CRITICAL)

**Alex/Amelia**: Use `(186,141,94)` as hair source — NOT `(138,101,82)`.
- Old source (138,101,82): outline color (86,89,114) is only dist=62 away → caught at t=65 → outlines turn hair color (bad)
- New source (186,141,94): outlines (86,89,114) are dist=114 away → never caught at t=65 ✓
- All four hair shades (186→149→141→138) are within dist=64 of the new source → all caught ✓

**Adam**: Use `yMax=16` NOT `yMax=17`.
- Source (149,157,88) with t=80 catches skin pixel (187,163,134) at y=16 (dist≈60 < 80)
- Lowering yMax to 16 excludes that row entirely → no skin leak ✓
- Loses 8 hair pixels at bottom row — acceptable trade-off

**Bob**: Use `t=35` NOT `t=25`.
- Old t=25: only (113,107,110) caught = 15 pixels (very sparse, hair barely visible)
- New t=35: also catches (93,88,95) at dist=31 = 56 pixels total ✓
- (93,88,95) is Bob's shirt source BUT Y-masking keeps hair (y<17) and shirt (y≥17) separate ✓

# The collar-row and shirt threshold rules

**Alex/Amelia**: hair yMax=16 (y=11..15), shirt yMin=16 (y=16..23), shirt **t=15**.
**Adam/Bob**: hair yMax=16/17 (see above), shirt yMin=17 (y=17+), shirt t=40.

Why collar is in the SHIRT zone for Alex/Amelia (shirt yMin=16):
- Putting collar in HAIR zone left a dark ring between golden hair and shirt body ("fucked up").
- Collar in SHIRT zone turns collar the shirt color — clean visual.

Why shirt threshold is 15 for Alex/Amelia:
- Amelia's flowing hair pixels (149,115,80) are dist=18 from shirt source (138,101,82).
- t=15: only (138,101,82) and (141,112,81) (dist≤11.4) caught. Flowing hair stays original.
- t≥18: (149,115,80) caught → flowing hair turns shirt color (bad).

# Hardcoded zone table (CHAR_ZONE_COLORS in index.html)

| char   | zone  | r,g,b         | t  | yMin | yMax | notes |
|--------|-------|---------------|----|------|------|-------|
| adam   | hair  | 149,157,88    | 80 | —    | **16** | yMax=16 (not 17!) avoids skin pixel at y=16 |
| adam   | skin  | 255,203,176   | 50 | —    | —    | |
| adam   | shirt | 93,96,67      | 40 | 17   | 23   | body only; cut at y=17 |
| adam   | pants | 159,116,168   | 50 | 23   | —    | |
| adam   | shoe  | 93,96,67      | 40 | 26   | —    | same olive as shirt; swapped to pants color |
| alex   | hair  | **186,141,94** | 65 | 11   | 16   | source is BRIGHT HIGHLIGHT, not (138,101,82)! |
| alex   | skin  | 255,203,176   | 50 | —    | —    | |
| alex   | shirt | 138,101,82    | 15 | 16   | 24   | t=15 stops (149,115,80) flowing-hair at dist=18>15 |
| alex   | pants | 162,57,75     | 50 | 24   | —    | |
| amelia | hair  | **186,141,94** | 65 | 11   | 16   | source is BRIGHT HIGHLIGHT, not (138,101,82)! |
| amelia | skin  | 191,139,120   | 50 | —    | —    | |
| amelia | shirt | 138,101,82    | 15 | 16   | 24   | same; stops flowing-hair from turning shirt color |
| amelia | pants | 185,93,114    | 50 | 24   | —    | |
| bob    | hair  | 113,107,110   | **35** | — | 17   | t=35 (not 25!) to also catch (93,88,95) at dist=31 |
| bob    | skin  | 255,203,176   | 50 | —    | —    | |
| bob    | shirt | 93,88,95      | 40 | 17   | 23   | body only; cut at y=17 |
| bob    | pants | 194,184,213   | 50 | 23   | —    | |

# Adam shoe zone

Adam's shoes (y=28–31) are the exact same olive-green (93,96,67) as his shirt. The `shoe` zone entry causes `_applySwaps` to run an extra swap of those pixels to the chosen **pants** color, so the full lower half matches the pants selection.

# Swap order

`_applySwaps` runs: skin → hair → shirt → pants (+shoe). Hair runs before shirt so any boundary pixels get assigned to hair first; shirt then skips already-swapped pixels.

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
Find the cut-Y by looking at where head pixels end and shirt body begins.
Use brightest hair pixel as source (not darkest) to keep outlines out of the catch radius.
Do NOT use heuristic auto-detection.
