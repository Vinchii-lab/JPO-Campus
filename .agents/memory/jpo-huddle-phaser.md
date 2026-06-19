---
name: JPO Huddle Phaser sprite & collision
description: Non-obvious facts about the Adam player spritesheet, Phaser arcade body sizing, and TilemapLayer rendering order in the JPO Huddle office game.
---

# Adam player spritesheet
- `public/assets/Adam_16x16.png` is **16×32 per frame**, NOT 16×16 (the filename misleads — the character spans two tiles tall). Each 32px frame holds one full character; frames are cleanly aligned, no misalignment.
- **So a "cut character" is NOT a spritesheet/frameHeight problem** — look at TilemapLayer insertion order (see below).

# Phaser arcade body sizing gotcha
- Arcade `body.setSize` dimensions ARE multiplied by the sprite's scale for world collision.
- **Why:** at `setScale(3)`, a `16×32` body becomes 48×96 = two 48px tiles tall. A 2-tile-tall body silently cannot fit through 1-tile horizontal doorways, so the player is blocked from rooms even though the art looks fine and walls look open.
- **How to apply:** keep body ≤ 36×36 source (< 1 tile = 48 world px). Use `setSize(12,12)` with no offset — Phaser auto-centers with `origin(0.5, 0.5)`.

# TilemapLayer render ordering — CRITICAL
- **`TilemapLayer.setDepth()` does NOT work reliably relative to Phaser Physics sprites in Phaser 3.80.1 WebGL renderer.** The character's lower body was being painted over by wall/floor tiles despite having depth 100.
- **Fix: use insertion order only.** Create objects in this sequence:
  1. Floor layer
  2. Wall layer
  3. **Player sprite** ← player always renders in front of floor+walls
  4. Furniture layer ← furniture renders in front of player (optional depth illusion)
- Remove all `setDepth` calls from TilemapLayers. Never rely on depth to lift a sprite above a tile layer.

# Office.tmj map
- Some rooms are **sealed**: the Wall layer fully encloses them with no doorway gap even though floor is painted underneath (looks like an open "space"). No code/collision change can open them — a gap must be added in the Wall layer in Tiled.
- Spawn point: tile (22, 17) = world (1080, 840) — center of the starting room (cols 18–25, rows 15–20).
