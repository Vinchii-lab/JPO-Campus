---
name: JPO Huddle palette swap zones
description: Why auto-detection of hair/skin/shirt/pants zones fails and what the correct hardcoded values are per character.
---

# Why auto-detection fails

The original `_detectZoneColors` used two methods:
1. **Skin heuristic** (`r > 148 && r > g + 20 && r > b + 28 && g > 80 && b > 50`) — Alex and Amelia's warm brownish hair (e.g. `186,141,94`) satisfies this, so the skin selector changed hair instead of face.
2. **Spatial zone cuts** (38% / 68% of 32px frame) — characters start at y≈9–10 (rows 0–8 are transparent), so the "hair zone" (y < 12) captured only 2–3 rows with very few non-outline pixels, often picking outline colors as the hair source.

# Hardcoded source colors (frame-0 pixel analysis)

Stored in `CHAR_ZONE_COLORS` constant in `index.html`. Each zone has `r/g/b` (centroid of representative pixels) and `t` (swap threshold radius):

| char   | hair           | skin             | shirt          | pants           |
|--------|----------------|------------------|----------------|-----------------|
| adam   | 149,157,88 t44 | 255,203,176 t50  | 93,96,67 t40   | 159,116,168 t50 |
| alex   | 186,141,94 t44 | 255,203,176 t50  | 138,101,82 t40 | 162,57,75 t50   |
| amelia | 186,141,94 t44 | 191,139,120 t50  | 138,101,82 t40 | 185,93,114 t50  |
| bob    | 113,107,110 t25| 255,203,176 t50  | 93,88,95 t40   | 194,184,213 t50 |

**Why:** Bob's hair (113,107,110) and shirt (93,88,95) are only distance 30.7 apart — threshold must be ≤ 28 to avoid hair swap bleeding into the shirt. All other chars have enough distance at their respective thresholds.

**How to apply:** If a new character is added, dump frame-0 pixels with Python/Pillow (`from PIL import Image`) and manually identify the dominant non-outline color in each body region. Do NOT use heuristic auto-detection.

# Swap order matters

Order in `_applySwaps`: skin → hair → shirt → pants. Hair runs before shirt so that shared boundary pixels (e.g. Alex's `149,115,80` appears in both head and shoulder area) get swapped to hair color first; shirt swap then skips them since they no longer match the shirt source.
