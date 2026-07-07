---
name: JPO Huddle seated facing
description: Seated avatars keep the player's pre-sit direction (approach-based), EXCEPT desk-type seats (computer workstations GID 606 + manager-desk baked chairs) which force the face-visible DOWN sit3 pose.
---

# Seated facing is APPROACH-BASED — EXCEPT desk-type seats face the viewer (sit3 down)

When a player sits, the avatar keeps whatever direction it was facing when it pressed sit.
Face left → sit facing left; face down → sit facing down; etc. This holds for sofas/benches and
conference chairs.

## Exception: desk-type seats → forced face-forward DOWN sit3 pose
Computer workstations (GID 606) AND the baked-in manager-desk chairs seat you facing the desk, so
the avatar is forced to face DOWN and render the **`*_sit3` (down) seated sheet** — the ONLY seated
pose whose face is visible.

**Why:** the owner wants to SEE THE FACE at a desk (confirmed with reference screenshots) and loves
the sit3 look (face visible, legs tucked). The other seated sheets do NOT show a front face —
right/left `*_sit` are hunched SIDE PROFILES (no face; this is what looked "WTF" at the ops manager
desk), and up `*_sit2` is the back of the head. sit3 (down) IS a proper front-facing seated pose.
(Correcting an earlier MISTAKEN belief that "no seated sprite faces the viewer" — that led to a
now-removed workaround which rendered the STANDING down idle frame at 606. Do NOT reintroduce a
standing frame for seated desks; sit3 is the correct, better-looking seated pose.)

**How to apply:**
- Detection is by SEAT GID, not sprite facing:
  `_sitFaceForward = seatGid===606 || deskChairAt(seatGid,col,row)!==null` locally on sit;
  `_isFaceForwardSeatAt(x,y)` uses the IDENTICAL predicate (reusing `_seatOccludersFor`'s col/row
  math) for REMOTE players and the join snapshot, so everyone renders the same pose regardless of
  the broadcast approach dir. `deskChairAt` is module-level and in scope everywhere it's used.
- Render goes through the NORMAL sit path: force the direction to `down` (`this.lastDir='down'`
  locally; `sdir = faceForward ? 'down' : approachDir` for remote/snapshot) and play
  `sit_${texKey}_down`. There is no special standing-frame branch anymore.
- Occluders stay tied to the SEAT, not the sprite (see below), so they still hide the lower body —
  the face/upper body shows above the desk. Remote occluders still take the broadcast `rdir`; the
  desk branches ignore it, so that's fine.
- Broadcast stays `{dir:lastDir, anim:'sit'}` (dir is 'down' at desks). The SERVER's seat-snap
  movement allowance keys on `anim==='sit'` only — do not change the broadcast to 'idle'/'walk'.

**Rule:** the `sit` handler assigns `this.lastDir = _sitFaceForward ? 'down' : interact.dir`, where
`interact.dir` is the pre-sit/approach direction (`this.lastDir` when standing on a walkable seat, or
the scanned direction toward a neighbour seat; the scan tries `this.lastDir` first). Do NOT wire the
sprite to the seat's baked `facing`.

**Why (non-desk seats):** the old blanket baked-facing model (every seat forced to a per-GID
direction) was unpredictable, so approach-based facing replaced it for the non-desk seats. Only
desk-type seats force facing, and now they force DOWN sit3 (not a standing frame). Do not reinstate
blanket forced facing for non-desk seats.

**How to apply (occluders):**
- The seat object's `facing` field (`SEAT_FACING` / `seatFacingAt` / `fam.facing`) is vestigial for
  the SPRITE — it does not drive which way the avatar looks. Don't wire the sprite back to it.
- `_makeSeatOccluders` ignores its `facing` param: the manager-desk branch derives overlay cells from
  desk BLOCK geometry (`deskFam.gids`/`deskFam.chair`), and the 606 branch derives the desk-front
  cell from `SEAT_FACING[seatGid]` (='down'). Essential for REMOTE players (they rebuild via
  `_seatOccludersFor(x,y,rdir)` with the broadcast dir) so an up/left sitter can't mis-occlude.

## Removed operations lounge couch (deliberate, not a bug)
A side-view sofa in the operations lounge (its only usable pose would be the disliked hunched side
profile) was removed at the owner's request. It's deleted at scene create via GID-keyed
`furnitureLayer.removeTileAt` for its tileset GIDs (they appear ONLY at that couch), so it stays gone
across the periodic Tiled re-import. Do NOT "restore" it thinking the map lost furniture.

## General
Any real change to seated ART is high-risk — see jpo-huddle-palette.md (`_sitZones`/`SIT_ANATOMY`).
Confirm pose facing from the tileset/sit sheets in code (crop the actual PNG), not from a low-res
in-game screenshot: sit3 (down, face visible) vs `*_sit` (side profile) look similar at game res.
