---
name: JPO Huddle per-board announcement boards
description: How announcement threads map to individual board clusters, the walk-up post/delete model, and the unread "!" invariant.
---

# Per-board announcement boards

Announcements are PER-BOARD, not per-room and not global. Each cluster of adjacent
board tiles (8-connected, `BOARD_GIDS` on the Furniture layer) is its own thread with
a stable `boardId` of the form `"<roomId>#<n>"`. In `create()` the scene clusters the
board tiles, sorts clusters by `(minRow, minCol)` for deterministic numbering, then
builds:
- `this.boardIdByTile` — `"c,r" -> boardId` (E-press at any board tile resolves its cluster)
- top-level `_boardLabels` — `boardId -> human label`, shared with the announcement UI.
  Label = room name, with `" · Board N"` appended ONLY when a room has more than one board.

Posting/reading is walk-up only: press E at a board → `openBoardPanel(this.boardIdByTile[...])`
→ compose emits `postAnnouncement {text, board}`. The server (`server.js`) stores a
sanitized `board` field on each announcement and broadcasts the full list; clients
filter by `board`. There is intentionally NO global composer and NO campus-wide broadcast.

## Delete
The board panel renders a per-item ✕ delete button gated on `_adminAuthed`; it calls
`deleteAnnouncement(id)` → emits `deleteAnnouncement`. The server handler is admin-only
(server-enforced, not just UI-gated). Announcement ids are server-generated (`a<n>`), so
the inline onclick is injection-safe; body text is escaped via `escHtml`.

## Why edit server.js
Per-board announcements must sync across clients, so the board tag lives on the server.
(A prior task treated server.js as read-only; that was a scoping choice, not a lock.)

## boardId is POSITIONAL — the one caveat
boardIds encode cluster position/order, so re-importing Office.tmj (adding/moving/removing
board clusters) renumbers them. Announcements are in-memory server state (lost on restart),
so drift only affects the client's `localStorage['jpo_seen_boards']` timestamps — worst case
a stale unread "!" for one board. Not a correctness bug.

## Unread "!" markers
Per-browser only: `localStorage['jpo_seen_boards']` = `{boardId: lastSeenTs}`. A board is
unread when any of its announcements has `ts > seen[boardId]` (fresh browser = all existing
posts unread). `refreshBoardMarkers()` toggles one badge per cluster; it no-ops until the
scene sets `this.boardMarkers` in `create()`. Reading a board (`openBoardPanel`) or having
its panel open when a post arrives calls `markBoardSeen`, which clears that board's badge.
Because E-press, "!" badge, and panel filtering all key off the SAME clustering pass and the
same `boardIdByTile`, they cannot disagree (this removed the old per-room straddling-rect
failure mode).
