---
name: JPO Huddle per-tile seat overrides
description: SEAT_TILE_FACING map for positions where the GID can't go in FURN_SEATS globally (same GID used as desk top elsewhere).
---

## The rule

When a seat GID appears as a **desk top** in other parts of the map, it cannot go into `FURN_SEATS` globally (sitting on every instance of that tile would put players on desk surfaces). Use `SEAT_TILE_FACING` instead.

## How to apply

`SEAT_TILE_FACING` is a plain object in module scope (defined just after `FURN_SEATS`):

```js
const SEAT_TILE_FACING = {
  '128,124': 'down',  // CFO office visitor bench
  '129,124': 'down',
  '130,124': 'down',
};
```

Key = `"col,row"` (tile coords). Value = sit-facing direction (`'up'`/`'down'`/`'left'`/`'right'`).

**What happens automatically (no extra code needed):**
- `isFurnSeat(gid, c, r)` checks `SEAT_TILE_FACING[c+','+r]` as a third branch — so the existing collision-clearing loop (`ft.setCollision(false…)`) opens the Furniture tile, and the Wall-layer opening loop (`isSeatCell` check) also clears any co-located Wall tile.
- After the seatFacingAt population loop, `for (const key of Object.keys(SEAT_TILE_FACING)) this.seatFacingAt[key] = SEAT_TILE_FACING[key]` bakes in the facing.

**What does NOT happen automatically:**
- Work bonus (`WALL_WORK_SEAT_GIDS` / `WORK_SEAT_GIDS`) — do not add these tiles there unless the desk actually pays the bonus.
- Server-side awareness — server only sees `anim:'sit'`; no server change needed.

## Why

The Jail-tileset tiles 5489–5508 appear as **sofas** in the upper exec offices (no Wall overlay) and as **desk tops** in the CFO's office (Wall tiles on the same cells). Adding them to FURN_SEATS globally would make every desk surface sittable.

**How to apply:** Add a new `'col,row': 'facing'` entry to `SEAT_TILE_FACING` for any future position that has the same constraint.
