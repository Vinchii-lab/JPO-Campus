---
name: JPO Huddle seated facing
description: Seated facing = pin first (seatFacingAt per-tile || SEAT_FACING per-GID), approach direction only as fallback. UP-pinned seats render the STANDING UP frame (back of head) + chair-tile occluder ('standup' pose) because NO sit sheet shows a back view. Desk seats keep forced poses. Seated state (anim) persists server-side.
---

> **Map swap (July 2026):** the map is now `JPO_HQ.tmj`. Old-map GIDs below (606, 959–996, 1005/1006, etc.) are HISTORICAL. Current equivalents: workstation = Furniture chair **2231** + a `WORKSTATION_WALL_GIDS` Wall tile sharing the cell (`_isWorkstation`) — monitor **2078** (desk-front 2094 below) or cash register **2148** (counter-front 2164 below; Market checkout + library counters get the same stand pose + occluders); manager-desk chair cells **2600** (blue) / **2605** (green); carrel chairs **2763/2764**. All principles (poses, `_deskPoseAt`, persistence) still apply unchanged. The durable rule: any chair sharing its cell with a "thing on a desk in front of you" Wall tile should be a workstation — matching on ONE hardcoded gid is how the register bug happened.

## Same GID, different room → per-tile SEAT_TILE_FACING override (not a SEAT_FACING change)
When the same chair GID appears in multiple rooms whose desks face DIFFERENT directions, the global
`SEAT_FACING[gid]` pin is correct for some instances and wrong for others. Fix with per-tile entries
in `SEAT_TILE_FACING` (keyed `"col,row"`) — these are checked FIRST by `seatFacingAt[ptx+','+pty]`
and override the global pin for just those cells without touching any other room.
**Why:** changing `SEAT_FACING[gid]` globally would break every other room that uses the same GID
correctly. Example: GID 2589/2605/2621 (mirrored green desk chair) is 'left' everywhere (COO,
Accounting) but at the L&D trainer's desk (c160, r72–74) the desk is to the east → override via
`'160,72':'right', '160,73':'right', '160,74':'right'`. All three rows need entries because the
seatFacingAt lookup fires against the SCAN tile (the row the player pressed E on), not the
SEAT_DY-snapped cell.

## SEAT_FACING must cover ALL aliased tiles, not just the seat tile
`SEAT_FACING` is keyed by the GID at the player's CURRENT tile when E is pressed — BEFORE SEAT_DY snapping.
For multi-tile furniture (cap/seat/pedestal 3-stacks, alias seats), the facing lookup fires against whichever
tile the player happens to stand on. Adding only the seat tile (e.g. 2893) leaves the cap (2877) and pedestal
(2909) without a pin, so they fall through to `lastDir`. Always add all GIDs in the aliased set.
**Why:** the E-handler resolves `seatFacingAt[col,row] || SEAT_FACING[gid] || lastDir` at press-time (line 6583/6592 in index.html); the SEAT_DY snap that moves the player to the canonical seat tile happens later.

# Seated facing is PIN-FIRST — approach direction is only the fallback (changed July 2026)

Sit facing resolves `seatFacingAt["c,r"] || SEAT_FACING[gid] || approachDir`, and `lastDir` must be
set from that SAME resolved value — an earlier bug set `lastDir` from the approach direction, so a
side approach to a pinned chair ignored the pin and played the side sit anim. Seats with no pin
(most sofas/benches/stools) still use the approach direction.

## UP-pinned seats → 'standup' pose (STANDING UP frame + chair-tile occluder)
**No sit sheet contains a back-of-head pose** (see the sit2 correction below), so 'up' facing cannot
use a sit anim. The 'standup' desk pose renders the standing UP idle frame (genuine back of head on
the run sheet) with the chair's OWN tile overlaid as a depth-900 occluder so the chair back covers
the body — reads as "seated facing away". GID lists, layer choice, and broadcast details live in the
replit.md seating gotcha (code-derivable); the durable rule is: any seat pinned 'up' MUST take this
pose, never a sit sheet.

## CORRECTION: Adam_sit2 is NOT a back view (earlier notes here were wrong)
Skin-pixel counting proved sit2 frames 0–5 have ~41 face-skin px — same as the RIGHT sit sheet; a
genuine back-of-head frame (run-sheet UP rows) has ~3. sit2 is a face-visible profile pose. Never
use any sit sheet for 'up' facing; only the run sheet's UP rows show the back of the head.

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

## The RELOADING client itself must also restore the pose (July 2026)
Server-side persistence alone is NOT enough: the resumed client's own 50ms position stream is
authoritative-looking to observers, so if it boots standing at spawn it un-seats the avatar for
everyone within a second — every deploy's build-stamp force-reload stood ALL seated players up.
**Why:** two independent restore paths exist (server broadcast state + the local client's own
spawn), and they must agree; the local one silently won.
**How to apply:** the local restore must derive pose/occluders from the restored coordinates with
the SAME coordinate-based helpers remote viewers use — never duplicate the E-press branch's
seat-cell inputs (those are press-time, not position-derived). Also restore a stand-up tile by
probing the seat's walkable neighbours; the pre-sit tile is gone after a reload.

**Why (non-desk seats):** the old blanket baked-facing model (every seat forced to a per-GID
direction) was unpredictable, so approach-based facing replaced it for the non-desk seats. Only
desk-type seats force a pose. Do not reinstate blanket forced facing for non-desk seats.
RE-CONFIRMED July 2026: owner explicitly asked for approach-facing on all sofas/long chairs/benches
after pinned sofas kept "facing the wrong way" — the pins on the grey side sofas, studio sofa,
loveseat, white lounge sofa, green couch, and wooden benches were removed AGAIN. Keep pins only on
desk/computer chairs, single armchairs the owner asked to pin (CEO set, tan), art-constrained
back-view TV couches ('up' → standup pose), and beds.

## Side-view HIGH-BACK single chairs: pin + center on the pad + sink + base-row occluder
A playing sit anim is NOT enough — Vince's July 2026 "everyone looks standing" report was seats
where the anim played but the sitter was rendered BESIDE/ON TOP of the furniture. Side-view
high-back chairs (tall backrest column + seat column) are ART-CONSTRAINED like desk chairs, not
approach-facing like sofas: pin facing AWAY from the backrest, center the sitter on the actual
seat-pad pixels (measure the tileset PNG, not the tile grid), sink ~12px so the head stays below
the chair top, and redraw the chair's BASE row over the feet as an occluder so the legs tuck
behind the chair front. Side desk-chairs (classroom style, desk in the next column) instead shift
the sitter INTO the desk column and redraw the desk's FRONT tile over the lap — never the desk-top
tile at head height.
**Why:** the chair art is thin; the 48px avatar fully covers it, so without overlap+occlusion
nothing on screen says "chair" and the profile sit frames read as standing.
**How to apply:** keep all alias tiles' DX/DY summing to ONE canonical point on the middle seat
tile with derived-cell parity (interior offsets < 24px; boundary-crossing alias components > 24px);
gate occluder branches on the DERIVED cell's gid. Verify with in-game screenshots, not state dumps.

## Sit trigger range includes DIAGONALS (owner request July 2026)
The E-scan checks the standing tile, 4 cardinal neighbours, then the 4 diagonal neighbours (seats
only — boards stay cardinal). Diagonal approaches face `lastDir`. The server's 160px seat-snap
allowance already covers the ~68px diagonal snap; don't widen the scan beyond 1 tile without
checking that allowance.

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
