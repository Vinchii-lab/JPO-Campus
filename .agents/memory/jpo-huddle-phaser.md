---
name: JPO Huddle Phaser sprite & collision
description: Non-obvious facts about character spritesheets, animation keys, collision, and rendering in the JPO Huddle office game.
---

# Sprite sheet layout — per character

| Character | File | Dimensions | Frames |
|-----------|------|-----------|--------|
| adam | Adam_16x16.png | 384×224 | 24 cols × 7 rows = 168 frames |
| alex | Alex_run_16x16.png | 384×32 | 24 cols × 1 row = 24 frames |
| amelia | Amelia_run_16x16.png | 384×32 | 24 cols × 1 row = 24 frames |
| bob | Bob_run_16x16.png | 384×32 | 24 cols × 1 row = 24 frames |

- All frames are **16×32** (not 16×16 — the filename is misleading).
- Adam has the **full LPC-style directional sheet**; Alex/Amelia/Bob have only a single run-cycle row.

# Animation keys and frame spec (CHAR_ANIM_SPEC)

Phaser texture key is the character name (`adam`, `alex`, `amelia`, `bob`).
Animation keys: `${char}_idle`, `${char}_walk_down`, `${char}_walk_up`, `${char}_walk_left`, `${char}_walk_right`.
Adam-specific: `sit_adam` (adam_sit sheet, frames 0–5), `phone_adam` (adam_phone, frames 0–8).

Adam frame ranges (full sheet):
- idle: 0–3, walk_down: 0–7, walk_up: 48–55, walk_left: 72–79, walk_right: 96–103

Alex/Amelia/Bob frame ranges (single-row fallback — all walk dirs use 0–7):
- idle: 0–3, walk_down/up/left/right: all 0–7

**Why:** Alex/Amelia/Bob sheets only have 24 frames; frames 48–103 don't exist and generate Phaser warnings. CHAR_ANIM_SPEC holds the correct ranges per character.

# Directional movement — NO flipX

Characters have proper left/right walk animations, so `setFlipX` is NOT used.
- left → `${char}_walk_left`, right → `${char}_walk_right`
- up → `${char}_walk_up`, down → `${char}_walk_down`
- stopped → `${char}_idle`

Animation state sent in `playerMove` emit: `idle`, `sit`, `walk_down`, `walk_up`, `walk_left`, `walk_right`.

# Character assignment

- Player character is randomly assigned on page load: `CHARACTERS[Math.floor(Math.random()*CHARACTERS.length)]`
- Server confirms character in `approved` event; `_playerChar` is updated then.

# Phaser arcade body sizing

- At `setScale(3)`, a `16×32` body becomes 48×96 = too tall for 1-tile doorways.
- Keep body ≤ 36×36 source. Use `body.setSize(12,12)` with no offset.

# TilemapLayer render ordering — CRITICAL

- `setDepth()` does NOT work reliably relative to Physics sprites in Phaser 3.80.1.
- Use **insertion order only**: Floor → Wall → Furniture → other-player sprites → local player.
- Player must be created AFTER furniture to render above desks.

# Office.tmj map

- Some rooms are sealed (no doorway gap in Wall layer). Must be fixed in Tiled, not code.
- Spawn point: tile (22, 17) = world (1080, 840).
- World size: 2400×1728 (50×36 tiles × 48px).

# Registration flow

- No character builder. Name + email → "Request Access →" → pending → admin approves → office.
- No palette swap system. Characters display their native sprite colors.
