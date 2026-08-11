---
name: JPO Huddle pet sprite generation pipeline
description: How to produce a pet's 6-frame set (static + walk1-3 + sit + action) from one AI sprite sheet, and the cleanup traps.
---

# Pet stage art contract
- Files: `public/assets/pets/pet_<id>_s<n>.png` (static) + `anim/<stem>_s<n>_{walk1,walk2,walk3,sit,action}.png`, all 64x64 bottom-aligned (`-resize 60x60 -gravity south -extent 64x64`).
- `_animSet` only attaches when ALL 5 anim textures exist — a missing frame silently leaves the pet static.
- ALL pet art must face RIGHT (client flips with flipX; only legacy static bunnies face left). A left-facing sheet walks backwards — check facing against `pet_<id>.png` stage 1 before installing.

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
