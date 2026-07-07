---
name: JPO Huddle seated facing
description: How seated avatars face at each desk/seat type, and the product decision that manager-desk sitters face the viewer.
---

# Seated facing per seat type — triage the SEAT before "fixing"

Different seats face different ways on purpose. Establish WHICH seat before assuming a bug.

## Manager desks (blue 959.. / green 963..) → forced DOWN (product decision)
`DESK_FAMILIES` blue/green desks are 2×3 furniture sprites with the chair baked into the block.
The chair's TRUE art orientation is into the desk (blue chair left→faces right, green chair
right→faces left), still recorded as `fam.facing`. **But `deskChairAt()` intentionally returns
`facing:'down'`** so the seated avatar faces the viewer (you see its face, not a side profile).

**Why:** users repeatedly read the full right-side profile (`*_sit_16x16.png`) at a manager desk as a
bug ("whole body turned right"). The owner chose face-the-viewer over face-the-desk. Accepted visual
tradeoff: the baked-in chair back is drawn side-on, so a down-facing avatar sits slightly incongruously
against a sideways chair.

**How to apply:** this override lives ONLY in `deskChairAt()`'s return. It is safe because manager-desk
seat occluders in `_makeSeatOccluders` derive their overlay cells from the desk BLOCK geometry
(`deskFam.gids`/`deskFam.chair`), NOT from `facing` — only the `606` workstation branch reads `facing`.
`fam.facing` is otherwise unused for rendering. Do NOT "restore" right/left facing here thinking it's a
bug — it was a deliberate choice.

## Workstation chairs (GID 606) → DOWN; front-desk sofa → DOWN
606 chairs resolve to `down` via `SEAT_FACING` (verified at runtime even when walking in from the right).
Front Desk has only 606 chairs + a down-facing sectional sofa — no right-facing seat exists there, so a
"faces right at the front desk" report is impossible from resolution and was a misread.

## General
Any real change to seated ART is high-risk — see jpo-huddle-palette.md (`_sitZones`/`SIT_ANATOMY`). The
low-res in-game screenshot is a poor oracle for facing; confirm resolution in code or a runtime log.
