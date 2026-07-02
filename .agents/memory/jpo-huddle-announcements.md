---
name: JPO Huddle per-room announcement boards
description: How boards map to rooms, the walk-up posting model, and the unread "!" invariant.
---

# Per-room announcement boards

Announcements are per-ROOM, not global. A room is a hardcoded rectangular tile
region (`ROOMS` array + `roomForTile(col,row)` in `public/index.html`). Posting is
walk-up only: press E at a board → `openBoardPanel(roomForTile(bcol,brow))` →
compose emits `postAnnouncement {text, room}`. The server (`server.js`) stores a
sanitized `room` field on each announcement and still broadcasts the full list;
clients filter by `room`. There is intentionally NO owner-panel global composer and
NO campus-wide broadcast (user decision). The owner panel keeps a read+delete list
of ALL rooms' posts, each labeled with its room name.

**Why edit server.js:** per-room announcements must sync across clients, so the room
tag has to live on the server. (A prior task had treated server.js as read-only;
that was a scoping choice, not a platform lock.)

## Invariant — keep board→room mapping consistent
Every cluster of adjacent board tiles (BOARD_GIDS on the Furniture layer) must fall
ENTIRELY inside exactly one `ROOMS` rectangle. The room used for the "!" badge is
`roomForTile(cluster center)`; the room used when you press E is
`roomForTile(interact tile)`. If a board straddles two rectangles (or lands in the
`'office'` fallback), pressing E and the floating "!" can disagree, or a room's "!"
never clears.
**How to apply:** Office.tmj is periodically re-imported. If boards move, re-run the
8-connected board-tile clustering against the map and confirm each cluster still sits
in one rectangle before shipping. There are 12 clusters across 8 rooms (one mid-left
workstation room has no board).

## Unread "!" markers
Per-browser only: `localStorage['jpo_seen_rooms']` = `{roomId: lastSeenTs}`. A room is
unread when any of its announcements has `ts > seen[room]` (fresh browser = all
existing posts unread). `refreshBoardMarkers()` toggles one badge per board cluster;
it no-ops until the scene sets `window._gameScene.boardMarkers` in `create()`.
Reading a board (`openBoardPanel`) or having its panel open when a post arrives calls
`markRoomSeen`, which clears that room's badge.
