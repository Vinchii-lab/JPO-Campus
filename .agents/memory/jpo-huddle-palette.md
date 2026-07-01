---
name: JPO Huddle palette swap zones
description: Hardcoded per-character hair/skin/shirt/pants zone colors with Y-range clamping. Authoritative source for all palette swap tuning decisions.
---

# Core principle: map zones to the REAL body anatomy by Y region

The 16×32 sprites are NOT "hair-cap on top, shirt below". Verified via full pixel dump (frame 0, y=0..31):

| y-rows | body part | notes |
|--------|-----------|-------|
| 10–16  | top of hair | |
| 16–22  | **hair fringe on the sides** + FACE (skin) in the center | fringe shares the hair fill colour |
| 23     | collar / neck line | all dark outline colour |
| 24–27  | **real torso / shirt** | Alex = reddish (162,57,75); Bob = near-black navy |
| 28–31  | **real legs / pants** | Alex = blue-grey (120,125,147); Bob = near-black navy |

**The bug that fooled every earlier attempt:** the hair fringe hangs down to y≈22 and shares colour with the torso, so a shirt zone set at yMin=17 painted the *fringe* (a blue band across the face). And the *actual* shirt/pants live at y=24+, which earlier configs had mis-assigned. FIX = hair zone must extend to y≈22 to claim the fringe (face pixels are far from the hair source so skin still gets them), and shirt/pants zones must start at y≈23/28 on the real torso/legs.

**Bob special case:** his entire outfit is the SAME near-black navy (58,58,80 / 70,70,94) as every outline on the sprite. It CANNOT be recoloured by a unique source colour — only by REGION (yMin/yMax gating). Bob shirt/pants both use source (70,70,94) t=70 gated to y=23..27 / y=28+.

**Walk-cycle caveat (do NOT use tight torso/leg bands):** the body parts SHIFT between animation frames. For Alex the legs ride UP to y=23 and the torso drops to y=30 mid-stride. A shirt band of y=23..27 + pants band of y=28+ leaves gaps where original leg colour flashes. Since shirt & pants share ONE clothes colour (single clothesIdx), the fix is to overlap both zones across the WHOLE lower body (yMin=23, no yMax) so every body pixel is claimed in every frame. Verify a fix by rendering ALL 24 frames, not just frame 0 (the preview only shows frame 0). Bob's two zones already share one navy source and are contiguous, so no gap there.

Hair and shirt share the same color family for all characters. The ONLY reliable way to separate them is a hard Y-row boundary. Do NOT rely on color distance alone.

## `shirtYMax` — dynamic hair zone shrink when shirt is selected

For characters where the hair zone extends into the shirt zone (Adam, Amelia), the hair zone config has a `shirtYMax` field. `_applySwaps` uses it when `shirtIdx > 0`: `hairYMax = shirtIdx && zone.hair.shirtYMax != null ? shirtYMax : yMax`.

- **Hat only selected**: hair uses full `yMax` → whole region changes together
- **Shirt also selected**: hair shrinks to `shirtYMax` → shirt zone gets its pixels back

| char   | hair yMax (hat-only) | hair shirtYMax (hat+shirt) | shirt yMin | shirt t |
|--------|----------------------|---------------------------|------------|---------|
| adam   | 23                   | (none — removed)          | 23         | 50      |
| amelia | 24                   | **20**                    | **20**     | **40**  |
| alex   | 17                   | (none needed)             | **17**     | 20      |
| bob    | 17                   | (none needed)             | 17         | 40      |

**Adam no longer uses `shirtYMax`.** Its shirt zone is the PURPLE torso (y24-27), color-separated from the olive hair/legs, so hair can keep its full y<23 range even when a shirt is picked — no shrink needed. See the adam anatomy note below.

## Swap order: HAIR → SKIN → SHIRT → PANTS (critical)

Hair **must** run first on original pixels. If skin runs before hair, it pre-colors face pixels to a brownish tone that can fall inside the hair zone threshold, causing hair color to bleed into the face on dark skin tones. With hair first, skin runs on already-hair-colored pixels (far from skin source) so no cross-contamination is possible. Skin before shirt also protects shirt: skin pre-empts face pixels so the shirt zone can't catch them.

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

# Data model: independent shirtIdx + pantsIdx (legacy clothesIdx fallback)

Shirt and trousers are now SEPARATE colors, each chosen from `CLOTH_COLORS` (index 0 = "Original"/no-swap; 23 entries total). The client emits `shirtIdx` + `pantsIdx`; the server stores both and clamps each to `CLOTH_MAX`.

**`CLOTH_MAX` must always equal `CLOTH_COLORS.length - 1` (currently 22).** They live in different files (`server.js` vs `public/index.html`) — changing the palette length requires updating both in lockstep or the server clamps to the wrong bound.

**Legacy compatibility:** old saved/remote payloads only have `clothesIdx`. Everywhere an incoming payload is read (register-approved path, `_addOtherPlayer`), use `data.shirtIdx ?? data.clothesIdx ?? 0` and `data.pantsIdx ?? data.clothesIdx ?? 0` so a single legacy value still colors both. Do NOT drop the `clothesIdx` fallback.

## Clothes snapshot fix — overlapping shirt/pants zones must NOT cascade

**Why:** Alex's shirt and pants zones spatially overlap (both yMin=23, no yMax) and their sources differ. Running shirt then pants IN-PLACE meant the pants pass re-matched the shirt's freshly-painted output (e.g. Slate shirt output falls within the pants source threshold), so the pants color would overwrite the shirt — a cascade bug that only appears when the two chosen colors are near each other.

**How to apply:** `_applySwaps` snapshots the buffer AFTER the hair+skin passes (`clothesSrc`) and passes it as the new final `srcPixels` arg to every clothes pass (shirt, pants, shoe). Each clothes pass MATCHES against `clothesSrc` (the original post-hair/skin body) but WRITES into the live buffer. So shirt and pants both match the same untouched basis and never see each other's output. Disjoint-zone characters (adam/amelia/bob) are byte-identical to the old in-place behavior; only the overlap case changes. Because clothes still match the same post-hair/skin basis as before, this introduces NO new hair/face bleed.

# Hardcoded zone table (CHAR_ZONE_COLORS in index.html)

| char   | zone  | r,g,b         | t  | yMin | yMax | notes |
|--------|-------|---------------|----|------|------|-------|
| adam   | hair  | 110,118,78    | 80 | —    | **23** | olive; yMax=23 caps hair off the olive legs (y28+); NO shirtYMax |
| adam   | skin  | 255,203,176   | 50 | —    | —    | |
| adam   | shirt | **159,116,168** | 50 | **23** | — | PURPLE torso (y24-27); matches only purple — never the olive hair-fringe/legs |
| adam   | pants | **93,96,67**  | **40** | **23** | — | OLIVE legs (y28-31); matches only olive — never the purple torso |
| alex   | hair  | **186,141,94** | 65 | **10** | **23** | bright-highlight source; extends to y=22 to claim the fringe; face pixels dist>65 survive for skin |
| alex   | hairOutline | 70,70,94 | **35** | 10 | 23 | catches (86,89,114) at d=31.9 too; darkRatio 0.49 |
| alex   | skin  | 255,203,176   | 50 | —    | —    | also catches the hand pixels in the torso |
| alex   | shirt | **162,57,75** | **73** | **23** | — | reddish torso; NO yMax — torso drops to y=30 mid-stride so it must span whole lower body |
| alex   | pants | **120,125,147** | **40** | **23** | — | blue-grey legs; yMin=23 (NOT 28) — legs ride UP to y=23 mid-stride; overlaps shirt (same clothes colour) |
| amelia | hair  | **138,101,82** | 65 | 11 | **24** | mid-range source — NOT 186,141,94 (Amelia skin dist=26, face gets colored); yMax=24; shirtYMax=20; flowXMax=8 |
| amelia | skin  | 191,139,120   | 50 | —    | —    | |
| amelia | shirt | **185,93,114** | **40** | **20** | 24 | PLAID source — NOT hair source; t:40 excludes skin pixels (191,139,120) at d=46.8; xMin:8 + frameW=16 fix stops per-frame bleed |
| amelia | pants | 185,93,114    | 50 | 24   | —    | |
| bob    | hair  | 113,107,110   | **60** | — | **23** | t=60 catches top-head + fringe (85,81,87) d=45; extends to y=22 to claim the fringe |
| bob    | hairOutline | 58,58,80 | 18 | — | **23** | catches outer outline (58,58,80) d=79 from hair src; darkRatio 0.55 |
| bob    | skin  | 255,203,176   | 50 | —    | —    | also catches hand pixels in torso |
| bob    | shirt | **70,70,94**  | **70** | **23** | **28** | REGION-gated: whole outfit is same navy as outlines, so gate by y only |
| bob    | pants | **70,70,94**  | **70** | **28** | — | REGION-gated navy legs |

# Adam anatomy — the mis-assigned-zones bug (FIXED)

**Symptom reported:** picking a SHIRT colour recoloured Adam's hair, and picking TROUSERS recoloured both shirt and trousers. **Root cause:** Adam's zones were mislabelled against his real anatomy. Frame-0 pixel dump: hair+fringe OLIVE `93,96,67`/`104,114,83`/`149,157,88` at y9-21 (the fringe olive hangs beside the face down to y≈21); face y17-22; collar y23; **shirt/torso PURPLE `159,116,168`/`128,94,142` at y24-27**; **legs/pants OLIVE `93,96,67` at y28-31**.
- Old `shirt` zone = olive `93,96,67` at y17-23 → that's the **hair fringe**, so the shirt picker painted hair.
- Old `pants` zone = purple `159,116,168` at y≥23 (the real shirt) + a `shoe` hack for the olive legs → the trousers picker painted the real torso AND legs.
**Fix:** shirt → purple source `159,116,168` t50 y≥23; pants → olive source `93,96,67` t40 y≥23; removed the `shoe` zone and `shirtYMax`. Purple vs olive are far apart, so both zones span the whole lower body and separate purely by SOURCE COLOUR — no cross-bleed, no touching the hair fringe.
**Key lesson:** Adam's hair, legs, AND shirt-fringe are all olive — do NOT tune his clothes zones by Y-band alone. Verify against a real frame-0 pixel dump, and separate torso vs legs by their distinct source colours (purple torso vs olive legs), not by a hard Y cut that the walk cycle shifts across.

# Swap order

`_applySwaps` runs: hair → skin → shirt → pants. Hair runs FIRST on original pixels (claims fringe before shirt); skin second (claims face); then shirt/pants. (A generic `shoe` pass still exists in `_applySwaps` but no character defines a `shoe` zone anymore — it's inert.) See the top-of-file swap-order section for why.

# `_swapColorsData` / `_applySwaps` signatures

```js
_swapColorsData(pixels, sr, sg, sb, tr, tg, tb, threshold, fw, yMin, yMax, xMin, xMax, frameW, srcPixels)
_applySwaps(pixels, zones, hairIdx, skinIdx, shirtIdx, pantsIdx, fw, frameW)
```
- `srcPixels` (15th, optional) = buffer to MATCH against; `const src = srcPixels || pixels`. Writes still go to `pixels`. Hair/skin passes omit it (match in-place); clothes passes pass the post-hair/skin snapshot so overlapping shirt/pants don't cascade (see snapshot fix above).
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
