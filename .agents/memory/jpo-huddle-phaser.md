---
name: JPO Huddle Phaser sprite & collision
description: Non-obvious facts about the Adam player spritesheet, Phaser arcade body sizing, TilemapLayer rendering order, and multi-texture animation in the JPO Huddle office game.
---

# Adam player spritesheet layout
- `Adam_16x16.png` is **16×32 per frame** (not 16×16). Each 32px frame holds one full character.
- Animation frame indices (confirmed working):
  - idle: frame 0
  - walk_down: frames 24–31 (row 1 of sheet)
  - walk_up: frames 48–55 (row 2)
  - walk_left: originally row 3 (frames 72+), but ROW 3 AND 4 have alternating near-zero pixel frames (every odd col = 0–1px visible) causing flickering. Fix: skip odd frames, use only [72,74,76,78].
  - walk_right: row 4 frames are 6 source-rows HIGHER in the frame than all other animations → character floats 18 world-px up. Fix: use walk_left frames + setFlipX(true).
- `Adam_run_16x16.png` is a single-row 24-frame run sheet (all frames solid, no alternating empties). The sprite **faces RIGHT**. Use frames 0–7 for walk_left (setFlipX(true)) and walk_right (setFlipX(false)).

# Multi-texture animation — CRITICAL
- Phaser 3.80.1 does NOT reliably auto-switch textures between animations when different animation keys use different texture keys (`'player'` vs `'player_run'`). Symptoms: sprite stays on wrong texture after direction change, twitching, frozen frame.
- **Fix: use a single texture for ALL animations.** Use row 3 even frames `[72,74,76,78]` from `'player'` for both walk_left and walk_right (no `player_run` sheet), and setFlipX(true) to mirror for right. This eliminates all cross-texture switching.

# Animation switching — `play(key, true)` vs manual `anim !==` guard — CRITICAL
- `player.anims.currentAnim?.key` can be `null` or return the OLD key for one or more frames during transitions. If you guard with `if (anim !== "walk_down") player.play(...)`, the guard passes every frame while `currentAnim` is stale → animation restarts from frame 0 every tick → constant twitching / frozen on frame 0.
- **Fix: use Phaser's built-in `ignoreIfPlaying` flag.** Call `player.play("walk_left", true)` — the second arg `true` tells Phaser to skip the call if the same animation is already playing, using its own internal state (not `currentAnim?.key`). This is reliable across all direction transitions.

# Phaser arcade body sizing
- `body.setSize(w, h)` uses SOURCE pixels; world size = source × scale.
- At `setScale(3)`, a 16×32 body = 48×96 world px — too tall for 1-tile doorways (48px). Keep body ≤ 12×12 source (36×36 world). Use `setSize(12,12)` with no offset; Phaser auto-centers when origin is (0.5, 0.5).

# TilemapLayer render ordering
- `TilemapLayer.setDepth()` does NOT work reliably vs sprites in Phaser 3.80.1 WebGL renderer. Use **insertion order** instead:
  1. Floor layer
  2. Wall layer
  3. Player sprite (always in front of floors/walls)
  4. Furniture layer (in front of player for depth illusion)
- Remove all `setDepth` calls from TilemapLayers.

# Phaser screenshot tool vs user browser
- The screenshot tool uses **Canvas** renderer; the user's browser uses **WebGL**. Fixes that appear to work in screenshots may still fail in the user's WebGL session. Always rely on user feedback for WebGL-specific rendering bugs.

# Office.tmj map
- Some rooms are sealed (Wall layer has no doorway gap). Must be fixed in Tiled — add a gap tile in the Wall layer.
- Spawn point: tile (22, 17) = world (1080, 840) — center of starting room (cols 18–25, rows 15–20).
