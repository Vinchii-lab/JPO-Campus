---
name: JPO Huddle seated facing
description: Seated avatars face the direction the player was facing when they pressed sit (approach-based), NOT the seat's baked orientation.
---

# Seated facing is APPROACH-BASED — the sprite keeps the player's pre-sit direction

When a player sits, the avatar keeps whatever direction it was facing when it pressed sit.
Face left → sit facing left; face down → sit facing down; etc. This holds for EVERY seat type
(workstations, manager desks, sofas/benches, conference chairs).

**Rule:** the `sit` handler assigns `this.lastDir = interact.dir` (the pre-sit / approach direction),
NOT the seat's baked `facing`. `interact.dir` is `this.lastDir` when standing on a walkable seat or
manager desk, or the scanned direction toward a neighbor seat (scan tries `this.lastDir` first, so a
seat in your facing direction preserves your facing).

**Why:** the earlier per-seat baked-facing model (manager desks forced 'down', 606 forced 'down',
etc.) was unpredictable to the user and read as "always facing right" at computers (the down-sit
`*_sit3` pose leans slightly right and is easily mistaken for the right profile `*_sit`). The owner
chose predictable, player-controlled facing over furniture-aware auto-orientation. This SUPERSEDES the
old "manager-desk sitters forced DOWN (product decision)" rule — do not reinstate forced facing.

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
