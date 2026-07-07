---
name: JPO Huddle seated facing
description: Seated avatars keep the player's pre-sit direction (approach-based), EXCEPT desk-type seats — computer workstations (GID 606) render the upright STANDING DOWN frame; manager-desk baked chairs render sit3-down MIRRORED toward the desk. Seated state (anim) is persisted server-side so refresh/restart never shows a sitter standing.
---

# Seated facing is APPROACH-BASED — EXCEPT desk-type seats, which have forced poses

When a player sits, the avatar keeps whatever direction it was facing when it pressed sit.
Face left → sit facing left; face down → sit facing down; etc. This holds for sofas/benches and
conference chairs.

## Exception 1: computer workstations (GID 606) → STANDING DOWN frame (LOVED — do not change)
Workstations seat you facing the desk; the avatar is rendered as the **standing DOWN idle frame**
(`DIR_START.down` on the run/idle sheet), NOT a seated sit sheet. The desk/monitor occluder hides
the legs, so the upright frame reads as "sitting at the desk, face visible."
**Why:** the owner wants to SEE THE FACE at a computer, and explicitly approved this exact look.
Unmirrored sit3-down bows the head and angles legs right — the owner rejected it for computers.
Do NOT "upgrade" computers to any sit sheet; that mistake was made and reverted more than once.

## Exception 2: manager-desk baked chairs → sit3-down MIRRORED toward the desk
The blue (959,960,975,976,991,992) and green (963,964,979,980,995,996) `DESK_FAMILIES` chairs play
the **sit3 sheet's down animation (`sit_${texKey}_down`) with `setFlipX` chosen so the legs angle
TOWARD the desk**: blue = unflipped (legs right), green = flipped (legs left).
**Why:** the standing-down frame that works for computers reads as "standing ON the chair" here,
because the manager chair sits BESIDE the desk (no occluder hides the legs). The owner's earlier
rejection of sit3 was about the unmirrored version facing away from the desk; mirrored-toward-desk
was verified against PNG composites and accepted. The hunched side-profile `*_sit` sheets remain
banned for desks.

**How to apply:**
- Single predicate `_deskPoseAt(x, y)` (client, near the old `_isFaceForwardSeatAt` spot): returns
  `{pose:'stand'}` for GID 606, `{pose:'sit3', flip:...}` for manager-desk chairs, `null` otherwise.
  Used in FOUR places with identical 3-way logic (desk pose → forced pose; `anim==='sit'` →
  directional sit anim; else idle): remote `playerMoved`, join-snapshot `_addOtherPlayer`, the local
  sit handler, and the local sitting render. Stand-up resets `this._deskPose = null`.
- Render for sit3: `setTexture` to the sit3 texKey first (sprite may hold another sheet), play
  `sit_${texKey}_down`, then `setFlipX(flip)`. For 'stand': run/idle sheet + `anims.stop()` +
  `setFrame(DIR_START.down)` + `setFlipX(false)`.
- Occluders stay tied to the SEAT, not the sprite (`_seatOccludersFor` / `_makeSeatOccluders`
  derive cells from desk-block geometry, ignoring sprite facing).
- Broadcast stays `{dir:lastDir, anim:'sit'}` — the SERVER's seat-snap movement allowance keys on
  `anim==='sit'`; never broadcast 'idle' while seated.

## Seated state PERSISTS server-side (the "resume ghost" fix)
`jpo_players.anim` (text, default 'idle', clamped to 'sit'/'idle') is flushed on the coin tick and
on disconnect, restored in `rowToPlayerState`, and carried through the `graceByEmail` snapshot, so
a refresh/reconnect/server-restart broadcasts `anim:'sit'` and everyone re-renders the sitter
SEATED at their seat coords.
**Why:** before this, restored players always broadcast `anim:'idle'`, so anyone who refreshed
while seated appeared STANDING on their sofa/chair to others.
**How to apply:** any new durable player-state field follows the same path: schema column →
`rowToPlayerState` → coin-tick + disconnect flush → grace snapshot. Remote clients must be able to
derive the correct pose from `{x, y, dir, anim}` alone (that is why `_deskPoseAt` is
coordinate-based, not event-based).

**Why (non-desk seats):** the old blanket baked-facing model (every seat forced to a per-GID
direction) was unpredictable, so approach-based facing replaced it for the non-desk seats. Only
desk-type seats force a pose. Do not reinstate blanket forced facing for non-desk seats.

## There is no separate "CEO desk" / "executive desk" sprite
The owner refers to the seated desks by role ("manager desk", "CEO desk", "executive desk"), but the
map only has TWO baked-chair desk sprites: the blue and green 2×3 families in `DESK_FAMILIES`. Both
get the mirrored-sit3 rule. Other furniture nearby — study desk 1005/chair 1006, bookshelf
1013/1014 — are NOT manager desks.

## Removed operations lounge couch (deliberate, not a bug)
A side-view sofa in the operations lounge (its only usable pose would be the disliked hunched side
profile) was removed at the owner's request. It's deleted at scene create via GID-keyed
`furnitureLayer.removeTileAt` for its tileset GIDs (they appear ONLY at that couch), so it stays gone
across the periodic Tiled re-import. Do NOT "restore" it thinking the map lost furniture.

## General
Any real change to seated ART is high-risk — see jpo-huddle-palette.md (`_sitZones`/`SIT_ANATOMY`).
Confirm pose facing from the tileset/sit sheets in code (crop the actual PNG and composite), not
from a low-res in-game screenshot. Ground truth: the loved face-forward computer pose = the
STANDING DOWN run frame (upright, symmetric); sit3-down is bowed + legs angled right (mirror with
flipX to angle left).
