---
name: JPO Huddle seated facing
description: Seated avatars keep the player's pre-sit direction (approach-based), EXCEPT desk-type seats (computer workstations GID 606 + manager-desk baked chairs) which render the upright STANDING DOWN frame so the face shows over the desk.
---

# Seated facing is APPROACH-BASED — EXCEPT desk-type seats show the STANDING DOWN frame

When a player sits, the avatar keeps whatever direction it was facing when it pressed sit.
Face left → sit facing left; face down → sit facing down; etc. This holds for sofas/benches and
conference chairs.

## Exception: desk-type seats → forced face-forward using the STANDING DOWN frame
Computer workstations (GID 606) AND the baked-in manager-desk chairs (blue 959 / green 963 families)
seat you facing the desk, so the avatar is forced to face DOWN and rendered as the **standing DOWN
idle frame** (`DIR_START.down` on the run/idle sheet), NOT a seated sit sheet. The desk/monitor
occluder hides the legs, so an upright standing frame reads as "sitting at the desk, face visible."

**Why:** the owner wants to SEE THE FACE at a desk, and the face-forward look they approved is the
UPRIGHT standing-down frame. **None of the seated sit sheets face the viewer:** `*_sit` right/left
are hunched SIDE PROFILES (no face — this is the "WTF" ops-desk look), `*_sit2` up is the back of
the head, and `*_sit3` down BOWS the head and angles the legs to the RIGHT — the owner explicitly
reads sit3 as "facing right" and rejected it. Do NOT "upgrade" desk seats to sit3 (or any sit
sheet); this mistake has been made and reverted more than once and each time broke the computers the
owner was happy with. The standing-down frame is the intended, approved desk pose.

**How to apply:**
- Detection is by SEAT GID, not sprite facing:
  `_sitFaceForward = seatGid===606 || deskChairAt(seatGid,col,row)!==null` locally on sit;
  `_isFaceForwardSeatAt(x,y)` uses the IDENTICAL predicate (reusing `_seatOccludersFor`'s col/row
  math) for REMOTE players and the join snapshot, so everyone renders the same pose regardless of
  the broadcast approach dir. `deskChairAt` is module-level and in scope everywhere it's used.
- Render is a DEDICATED branch (not the sit-anim path): `setTexture(run/idle texKey)` +
  `setFlipX(false)` + `anims.stop()` + `setFrame(DIR_START.down)`. Local uses `this.playerTexKey`;
  remote uses `entry.texKey` (must `setTexture` first because the sprite may still hold a sit
  texture); the join snapshot's freshly-created sprite already has the run sheet so it can `setFrame`
  directly. Non-desk seats keep the real directional `sit_${texKey}_${dir}` animations.
- The sit handler forces `this.lastDir='down'` for desk seats but the down value is only used by the
  standing-frame branch's occluders/broadcast; the branch itself hardcodes `DIR_START.down`.
- Occluders stay tied to the SEAT, not the sprite, so they still hide the lower body. Remote
  occluders take the broadcast `rdir`; the desk branch ignores it, which is fine.
- Broadcast stays `{dir:lastDir, anim:'sit'}`. The SERVER's seat-snap movement allowance keys on
  `anim==='sit'` only — do not change the broadcast to 'idle'/'walk'.

**Why (non-desk seats):** the old blanket baked-facing model (every seat forced to a per-GID
direction) was unpredictable, so approach-based facing replaced it for the non-desk seats. Only
desk-type seats force facing. Do not reinstate blanket forced facing for non-desk seats.

**How to apply (occluders):**
- The seat object's `facing` field (`SEAT_FACING` / `seatFacingAt` / `fam.facing`) is vestigial for
  the SPRITE — it does not drive which way the avatar looks. Don't wire the sprite back to it.
- `_makeSeatOccluders` ignores its `facing` param: the manager-desk branch derives overlay cells from
  desk BLOCK geometry (`deskFam.gids`/`deskFam.chair`), and the 606 branch derives the desk-front
  cell from `SEAT_FACING[seatGid]` (='down'). Essential for REMOTE players (they rebuild via
  `_seatOccludersFor(x,y,rdir)` with the broadcast dir) so an up/left sitter can't mis-occlude.

## There is no separate "CEO desk" / "executive desk" sprite
The owner refers to the seated desks by role ("manager desk", "CEO desk", "executive desk"), but the
map only has TWO baked-chair desk sprites: the blue (959,960,975,976,991,992) and green
(963,964,979,980,995,996) 2×3 families in `DESK_FAMILIES`. Both are covered by the desk-seat rule
above. Other furniture nearby — study desk 1005/chair 1006, bookshelf 1013/1014 — are NOT manager
desks. So "make the CEO/executive desks face forward" = ensure both DESK_FAMILIES are in the
face-forward predicate; no new family is needed.

## Removed operations lounge couch (deliberate, not a bug)
A side-view sofa in the operations lounge (its only usable pose would be the disliked hunched side
profile) was removed at the owner's request. It's deleted at scene create via GID-keyed
`furnitureLayer.removeTileAt` for its tileset GIDs (they appear ONLY at that couch), so it stays gone
across the periodic Tiled re-import. Do NOT "restore" it thinking the map lost furniture.

## General
Any real change to seated ART is high-risk — see jpo-huddle-palette.md (`_sitZones`/`SIT_ANATOMY`).
Confirm pose facing from the tileset/sit sheets in code (crop the actual PNG), not from a low-res
in-game screenshot. Ground truth once and for all: the loved face-forward desk pose = the STANDING
DOWN run frame (`Adam_run_16x16.png` frame `DIR_START.down`=18), which is upright and symmetric;
sit3-down is bowed + angled right. They look different only when you crop both and compare.
