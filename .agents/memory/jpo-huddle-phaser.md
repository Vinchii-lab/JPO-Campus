---
name: JPO Huddle Phaser sprite & collision
description: Non-obvious facts about the Adam player spritesheet, Phaser arcade body sizing, TilemapLayer rendering order, and animation system in the JPO Huddle office game.
---

# Adam player spritesheet
- `public/assets/Adam_16x16.png` is **16×32 per frame**, NOT 16×16 (the filename misleads — the character spans two tiles tall). Each 32px frame holds one full character; frames are cleanly aligned, no misalignment.
- **So a "cut character" is NOT a spritesheet/frameHeight problem** — look at TilemapLayer insertion order (see below).

# Adam sprite pack — side-scrolling only, right-facing
- All three sheets (Adam_16x16.png, Adam_run_16x16.png, Adam_idle_anim_16x16.png) are **side-profile only**. There are no front-facing (walk_down) or back-facing (walk_up) frames anywhere.
- **Adam_run_16x16.png is right-facing by default** (flipX:false = faces right, flipX:true = faces left).
- **Do NOT mix textures across animations** — switching between Adam_16x16 and Adam_run mid-movement causes one-frame texture flicker ("twitching") that is nearly impossible to eliminate otherwise.
- **Use Adam_run exclusively** for all player animations. Drop Adam_16x16 from preload entirely.

# Final working animation setup
- Load only `player_run` (Adam_run_16x16.png, 24 frames, 16×32).
- Create exactly **two** animations: `idle` (frame 0, static, 1fps) and `walk` (frames 0–7, 10fps).
- **One walk key for ALL directions** — separate walk_left/walk_right/walk_up/walk_down keys that use identical frames cause `play()` restarts on every direction change, producing visible stutter. One key = zero restarts.
- Direction via `setFlipX`: left → `true`, right → `false`. Up/down/idle inherit `this.lastFlipX`.

# lastFlipX pattern
- Store `this.lastFlipX = false` (init in create). Update only on left/right key presses.
- Apply on up/down/idle so character holds last horizontal direction when stopped or moving vertically.
- **Down-only convention:** set `lastFlipX = false` (face right = toward camera) when `down && !left && !right`. Do NOT update flipX on up-only — inherit lastFlipX.

# player.texture.key drifts during sit animation
- Palette-swapped animations (e.g. `sit_pl_adam_h1_sk0_sh2_p3`) reference frames from a *different* texture than the run sheet. Phaser switches `sprite.texture` when playing them.
- **Never use `player.texture.key` to derive walk/idle/sit animation keys** — it returns the sit texture key after the sit anim plays, and `walk_<sit_tex>` / `idle_<sit_tex>` do not exist → `anims.exists()` guard silently blocks `play()` → character freezes on sit frame.
- **Fix:** store `this.playerTexKey = texKey` in `_onApproved`. Use `this.playerTexKey` everywhere in `update()`. On E stand-up, call `player.setTexture(this.playerTexKey)` immediately before the next `update()` tick.

# playerMoved animation keys must use texKey not character name
- Other players' sprites use palette-swapped textures (e.g. `pl_adam_h1_sk0_sh2_p3`). Building animation keys from `entry.character` (`walk_adam`) references frames from the base `run_adam` texture — Phaser switches the sprite's texture on every frame → visible color flash.
- **Fix:** store `entry.texKey` in `otherPlayers[]` and use it when building animation keys in the `playerMoved` handler.

# Idle trigger — key-state NOT velocity
- Use `!left && !right && !up && !down`, NOT `velocity.x === 0 && velocity.y === 0`.
- Velocity check fires during wall collisions even while keys are held → rapid idle↔walk flicker.

# Phaser arcade body sizing gotcha
- Arcade `body.setSize` dimensions ARE multiplied by the sprite's scale for world collision.
- **Why:** at `setScale(3)`, a `16×32` body becomes 48×96 = two 48px tiles tall. A 2-tile-tall body silently cannot fit through 1-tile horizontal doorways.
- **How to apply:** keep body ≤ 36×36 source (< 1 tile = 48 world px). Use `setSize(12,12)` with no offset — Phaser auto-centers with `origin(0.5, 0.5)`.

# TilemapLayer render ordering — CRITICAL
- **`TilemapLayer.setDepth()` does NOT work reliably relative to Phaser Physics sprites in Phaser 3.80.1 WebGL renderer.**
- **Fix: use insertion order only.** Create objects in this sequence:
  1. Floor layer
  2. Wall layer
  3. Furniture layer
  4. **Other-player sprites** ← runtime-added, always end up on top
  5. **Local player sprite** ← last = always on top of everything
- Player must be created AFTER furniture so it renders above it. Earlier attempts put player before furniture (making player ghosted/invisible behind desks).
- Remove all `setDepth` calls from TilemapLayers. Never rely on depth to lift a sprite above a tile layer.

# Office.tmj map
- Some rooms are **sealed**: the Wall layer fully encloses them with no doorway gap even though floor is painted underneath. No code/collision change can open them — a gap must be added in the Wall layer in Tiled.
- Spawn point: tile (22, 17) = world (1080, 840) — center of the starting room (cols 18–25, rows 15–20).
- World size: 2400×1728 (50×36 tiles × 48px).
