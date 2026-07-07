---
name: JPO Huddle seated facing
description: Seated avatars keep the player's pre-sit direction (approach-based), EXCEPT computer workstations (GID 606) which force face-forward down using the standing frame.
---

# Seated facing is APPROACH-BASED — EXCEPT computer workstations face the monitor

When a player sits, the avatar keeps whatever direction it was facing when it pressed sit.
Face left → sit facing left; face down → sit facing down; etc. This holds for sofas/benches,
conference chairs, and manager desks.

## Exception: computer workstations (GID 606) → forced face-forward DOWN, STANDING frame
At a 606 computer seat the avatar is forced to face DOWN (toward the monitor) AND rendered with
the **standing down idle frame** (`DIR_START.down`), NOT any seated sit sheet.

**Why:** the owner wants to SEE THE FACE while working at a computer (confirmed with a reference
screenshot of the standing down pose at a desk). None of the seated sheets show a front face — the
down-sit `*_sit3` is a bowed head that reads as "right", up-sit is the back of the head, and
right/left are profiles. The ONLY face-forward down pose in the art is the standing idle frame. The
desk/monitor occluder (depth 900, redrawn over the chair cell + one forward cell) hides the legs, so
a standing frame at the seat still reads as "sitting at the desk facing the screen".

**How to apply:**
- Detection is by SEAT GID, not sprite facing: `_sitFaceForward = (furnAt(seatCol,seatRow) === 606)`
  locally; `_isFaceForwardSeatAt(x,y)` (reuses `_seatOccludersFor`'s col/row math) for REMOTE players
  and the join snapshot, so everyone renders the same thing. Set on sit, cleared on stand-up.
- The face-forward render is: `setTexture(playerTexKey/entry.texKey)` + `anims.stop()` +
  `setFrame(DIR_START.down)`. Do NOT play a sit anim for 606.
- Broadcast stays `{dir:'down', anim:'sit'}` so the SERVER's `anim==='sit'` seat-snap movement
  allowance is unaffected — do not change the broadcast to 'idle'/'walk' or the snap gets rejected.
- Do NOT "restore" approach-based facing for 606 thinking the forced-down is a bug — it is the
  deliberate face-the-monitor choice. (This is the one place forced facing is intentional.)

**Rule:** the `sit` handler assigns `this.lastDir = interact.dir` (the pre-sit / approach direction),
NOT the seat's baked `facing`. `interact.dir` is `this.lastDir` when standing on a walkable seat or
manager desk, or the scanned direction toward a neighbor seat (scan tries `this.lastDir` first, so a
seat in your facing direction preserves your facing).

**Why:** the earlier blanket baked-facing model (every seat forced to a per-GID direction) was
unpredictable, so approach-based facing replaced it for sofas/benches, conference chairs, and manager
desks. Computers (606) are the ONE deliberate exception (see the section above): the bowed down-sit
`*_sit3` pose leans slightly right and read as "always facing right", so 606 uses the standing
face-forward frame instead. Do not reinstate blanket forced facing for the NON-606 seats.

**How to apply:**
- The seat object's `facing` field (`SEAT_FACING` / `seatFacingAt` / `fam.facing`) is now vestigial for
  the SPRITE — it does not drive which way the avatar looks. Don't wire the sprite back to it.
- Occluders must stay tied to the SEAT, not the sprite. `_makeSeatOccluders` ignores its `facing` param:
  the manager-desk branch derives overlay cells from desk BLOCK geometry (`deskFam.gids`/`deskFam.chair`),
  and the `606` workstation branch derives the desk-front cell from `SEAT_FACING[seatGid]` (='down').
  This is essential for REMOTE players: they rebuild occluders via `_seatOccludersFor(x,y,rdir)` where
  `rdir` is the broadcast SPRITE dir — if the occluder read that, an up/left sitter would mis-occlude.
- All four directions have sit anims for every character (`SIT_DIR` collapses left→right sheet with
  `setFlipX`), so any approach direction renders fine.

## General
Any real change to seated ART is high-risk — see jpo-huddle-palette.md (`_sitZones`/`SIT_ANATOMY`). The
down-sit (`*_sit3`) and right-sit (`*_sit`) poses look near-identical at game res (both bowed-head), so
the low-res screenshot is a poor oracle for facing — confirm resolution in code or a runtime log.
