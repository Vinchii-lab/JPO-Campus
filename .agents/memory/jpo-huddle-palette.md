---
name: JPO Huddle palette swap zones
description: Why auto-detection of hair/skin/shirt/pants zones fails, the correct hardcoded values, and the Y-masking fix for zone bleed.
---

# Why auto-detection fails

The original `_detectZoneColors` used two methods:
1. **Skin heuristic** (`r > 148 && r > g + 20 && r > b + 28 && g > 80 && b > 50`) — Alex and Amelia's warm brownish hair (e.g. `186,141,94`) satisfies this, so the skin selector changed hair instead of face.
2. **Spatial zone cuts** (38% / 68% of 32px frame) — characters start at y≈9–10 (rows 0–8 are transparent), so the "hair zone" (y < 12) captured only 2–3 rows with very few non-outline pixels, often picking outline colors as the hair source.

# Why color-only thresholds aren't enough (zone bleed)

Even with correct source colors, thresholds alone cause bleed:
- **Adam shirt → head**: (95,105,74) and (104,114,83) appear in BOTH the head (y=11–16) and shirt body (y=14–22). The shirt swap source (93,96,67) at threshold 40 matches them (dist 11–26), so shirt swap recolors part of the head.
- **Adam shirt → shoes**: Adam's shoes (y=28–31) are the exact same olive-green (93,96,67) as his shirt. Shirt swap changes both torso AND shoes.
- **Adam pants misidentified**: The purple pants band is narrow (y=24–27) and sandwiched between olive shirt and olive shoes. Without Y masking, the "pants" picker appeared to change the wrong area.

# Fix: Y-range masking in `_swapColorsData`

`_swapColorsData` accepts `fw, yMin, yMax` parameters:
- `fw` = image width in pixels (used to compute `y = Math.floor(i / (fw * 4))`)
- `yMin/yMax` clamp the swap to specific row ranges
- Both callers must pass `fw`: preview passes `16`, run spritesheet passes `sw` (384 for Adam), sit sheet passes `sc.width`

# Hardcoded source colors + Y bounds (frame-0 pixel analysis)

Stored in `CHAR_ZONE_COLORS` in `index.html`. All row indices are 0-based within the 16×32 frame:

| char   | zone  | r,g,b         | t  | yMin | yMax |
|--------|-------|---------------|----|------|------|
| adam   | hair  | 149,157,88    | 70 | —    | 17   |
| adam   | skin  | 255,203,176   | 50 | —    | —    |
| adam   | shirt | 93,96,67      | 40 | 9    | 23   |
| adam   | pants | 159,116,168   | 50 | 23   | —    |
| adam   | shoe  | 93,96,67      | 40 | 26   | —    |
| alex   | hair  | 186,141,94    | 48 | —    | 17   |
| alex   | skin  | 255,203,176   | 50 | —    | —    |
| alex   | shirt | 138,101,82    | 40 | 12   | 24   |
| alex   | pants | 162,57,75     | 50 | 24   | —    |
| amelia | hair  | 186,141,94    | 48 | —    | 17   |
| amelia | skin  | 191,139,120   | 50 | —    | —    |
| amelia | shirt | 138,101,82    | 40 | 12   | 24   |
| amelia | pants | 185,93,114    | 50 | 24   | —    |
| bob    | hair  | 113,107,110   | 25 | —    | 17   |
| bob    | skin  | 255,203,176   | 50 | —    | —    |
| bob    | shirt | 93,88,95      | 40 | 10   | 23   |
| bob    | pants | 194,184,213   | 50 | 23   | —    |

**Adam shoe zone**: Adam's shoes are the same olive as his shirt. The `shoe` entry in `CHAR_ZONE_COLORS` causes `_applySwaps` to run an extra swap of the shoe area to the chosen PANTS color (not shirt color), so the bottom of the character always matches the pants choice.

**Why hair threshold is 70 for Adam**: Adam's head contains (104,114,83) pixels (dist 69 from hair source) that must be caught to visibly change the hair. At threshold 44 only the 3 brightest olive pixels changed. Y bound (yMax:17) prevents the higher threshold from bleeding into the shirt body.

**Bob hair threshold is 25**: Bob's hair (113,107,110) and shirt (93,88,95) are only distance 30.7 apart — threshold must be ≤ 28 to avoid hair swap bleeding into the shirt. Y bound (yMax:17) provides additional safety.

# Swap order matters

Order in `_applySwaps`: skin → hair → shirt → pants. Hair runs before shirt so boundary pixels get assigned to hair first; shirt swap then skips them since they no longer match the shirt source.

# Adding new characters

If a new character is added, dump frame-0 pixels with Python/Pillow:
```python
from PIL import Image
img = Image.open("NewChar_run_16x16.png").convert("RGBA")
for y in range(32):
    row = [img.getpixel((x,y)) for x in range(16)]
    print(y, [(r,g,b) for r,g,b,a in row if a>128 and not (r<90 and g<90 and b<90)])
```
Identify the dominant non-outline color in each body region. Do NOT use heuristic auto-detection.
