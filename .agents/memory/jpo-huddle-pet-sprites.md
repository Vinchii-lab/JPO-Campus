---
name: JPO Huddle pet sprite generation pipeline
description: How to produce a pet's 6-frame set (static + walk1-3 + sit + action) from one AI sprite sheet, and the cleanup traps.
---

# Pet stage art contract
- Files: `public/assets/pets/pet_<id>_s<n>.png` (static) + `anim/<stem>_s<n>_{walk1,walk2,walk3,sit,action}.png`, all 64x64 bottom-aligned (`-resize 60x60 -gravity south -extent 64x64`).
- `_animSet` only attaches when ALL 5 anim textures exist — a missing frame silently leaves the pet static.
- ALL pet art must face RIGHT (client flips with flipX; only legacy static bunnies face left). A left-facing sheet walks backwards — check facing against `pet_<id>.png` stage 1 before installing.

# WHITE pets: don't fight the checkerboard — regenerate on a DARK background
For white/near-white pets (snow duck/swan, snow cats), NO flood threshold wins:
strict cutoffs leave opaque checker patches, permissive ones leak through the
soft anti-aliased outline and eat the fur (happened twice, at 64px AND full res).
**How to apply:** regenerate the sheet with "plain SOLID very dark charcoal
background #1e1e28, absolutely NO checkerboard" (no removeBackground), sample
the real bg color from a corner pixel, `magick -fuzz 9% -transparent <bg>`,
slice with the light-flood disabled (LIGHT_MIN=255), then a border flood erasing
DARK pixels (max<=95) on the final frames to catch leftover bg shading — a dark
flood is always safe on a white subject. Colored pets keep the old light-flood
pipeline (enclosed pockets, e.g. between feet, still need a targeted local
erase — border floods can't reach them).

# Dark-bg pipeline works for COLORED pets too (bunny lines)
Generating any pet sheet on solid #1e1e28 then keying (corner-sample + fuzz 9%) beats
removeBackground. Leftover navy patches: border flood erasing pixels with max<=95 AND
blue>=red — the blue-heavy test spares dark warm-brown outlines, so it's safe on brown
coats (a plain dark flood is NOT). Trick FX must also gate on petObj.visible, not just
.active — hidden-round (prop hunt) pets otherwise leak their position via trick particles.

# Flying pets (dragons st2+) hover via display ORIGIN, not y
Hover bob = petObj.setOrigin(0.5, 1 + hov/displayHeight) so follow logic, tricks, and
depth (all keyed on x/y) are untouched; pair with a ground-shadow ellipse tracked via
_trackPetFx (lazily recreated if purged) and hide shadow + reset origin when seated.
Black/near-black pets can't be generated on the dark #1e1e28 bg — keying eats them;
use a light cream bg for dark-colored characters instead.

# Big-winged sheets defeat the auto-slicer — hand-crop + dilated largest-blob
When sheet characters have huge wings that touch/overlap x-ranges, slice5's blob merge
produces garbage. Fix: manual x-crops per pose, then keep the largest connected blob
with DILATED connectivity (radius ~5, /tmp/keepbig2.cjs pattern) — plain 8-connectivity
fragments the art because keying leaves hairline alpha gaps. Skip darkflood on dark
purple art (eats rune wings). Chunky silhouettes read better than skinny at 64px.
Dragons break the pet size cap on purpose: s2 1.3x, s3 1.7x (boss rule: priciest = biggest).

# Walk frames need ONE uniform scale, not per-frame fit
Per-frame `-resize 60x60` makes compact poses (crouch) render HUGE vs stretched ones —
the pet visibly "grows" mid-walk. Trim each frame, find the max dimension across the
cycle, resize ALL frames by that single factor, then bottom-extent 64x64. Also: blob
slicing can split one pose (dark goggle straps break connectivity) — merge blobs whose
x-ranges overlap >=50% of the smaller width before picking poses. Multiply-recolor of a
white pet into brown loses face detail (mud) — regenerate or rescale instead.

# One-sheet generation beats per-frame generation
Generate ONE horizontal strip ("exactly 6 evenly-spaced frames of the SAME character, transparent background") — per-frame generations drift into different animals. Describe the pose list left→right (stand, 3 trot steps, sit, howl).

# Slicing: use blob bounding boxes, not tile math
Fixed-width tile crops (sheet/6) bleed neighbors (noses/tails cross tile edges) and tighter insets amputate tails. Instead list blobs on the full sheet:
`magick sheet.png -alpha extract -threshold 15% -define connected-components:verbose=true -define connected-components:area-threshold=3000 -connected-components 8 null:`
then crop each blob's exact bbox (shrink a bbox edge when two boxes overlap by a few px). Mask each crop with area-threshold CC (keep-top=1 can return an EMPTY mask when background is the largest component).

# "White background" trap: opaque baked-in checkerboard
removeBackground output can contain FULLY OPAQUE near-white checkerboard patches inside the subject's bbox (alpha histogram is binary 254/0 — it's not a soft-alpha problem). Alpha thresholds can't remove them. Fix: BFS flood-erase from the image borders over light low-saturation pixels (r,g,b ≥ ~205, spread ≤ 20) — the sprite's dark outline stops the flood before the white fur. Script: /tmp/floodclean.cjs pattern (pngjs). ALWAYS verify frames zoomed 300% flattened on a dark bg before installing; small strips look clean when they aren't.

# Approval workflow that works with the owner
He rejects art repeatedly unless aligned first: generate 3-4 single-pose style options, `presentAsset` a labeled lineup (ReadFile renders only to the agent — the USER sees nothing until presentAsset), let him pick, then sheet → sliced strip + evolution-line size comparison → explicit 👍 → install. Keep static+anim in the same visual family as the stage-1/2 pets (chunky cute, not realistic).

## Evolution must change anatomy, not merely scale
Later forms need distinct faces, head/ear proportions, silhouettes, and species-specific details at the same art quality as established evolved pets.

**Why:** The first Halloween bat was rejected as “just got big”; a procedural repeat of one face plus larger wings did not meet the established pet standard.

**How to apply:** Compare stages side by side before delivery. For hovering bats, verify the actual stationary runtime cycles wing textures, not just that animation files exist. Asset replacements also require cache-busted URLs across world, shop, race, and battle consumers.
