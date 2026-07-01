---
name: JPO Huddle Phaser sprite & collision
description: Non-obvious facts about the Adam player spritesheet, Phaser arcade body sizing, TilemapLayer rendering order, and animation system in the JPO Huddle office game.
---

# Adam player spritesheet
- `public/assets/Adam_16x16.png` is **16×32 per frame**, NOT 16×16 (the filename misleads — the character spans two tiles tall). Each 32px frame holds one full character; frames are cleanly aligned, no misalignment.
- **So a "cut character" is NOT a spritesheet/frameHeight problem** — look at TilemapLayer insertion order (see below).

# Run sheets are 4-directional (24 frames) — NOT side-only (supersedes old flipX approach)
- Every `*_run_16x16.png` (Adam, Alex, Amelia, Bob) is 384×32 = **24 frames = 4 directions × 6**: RIGHT 0–5, UP (back-of-head, no face) 6–11, LEFT 12–17, DOWN (front, full face) 18–23.
- **Why the old "side-profile only, flipX for left" belief was wrong:** confirmed by counting skin-colored pixels in the face band per frame — UP rows ≈0 face skin, DOWN rows have the most (centered), and the two side rows mirror each other. Dedicated LEFT and RIGHT rows both exist.
- **How to apply:** never flip a side frame for the opposite side and never flip to fake up/down — use the real rows. Keep `setFlipX(false)` everywhere; there is no `lastFlipX` anymore.
- **Front frame 18 is the "portrait":** character-builder preview + hair-style thumbnails must draw source x=288 (frame 18) so every character shows its face. Drawing frame 0 (side view) makes long-haired characters (Amelia) look faceless/"broken".

# Directional animation setup (current)
- Per texture key `k`, `_createDirAnims(k)` builds `idle_${k}` (single frame = DIR_START.down = 18) + `walk_${k}_${dir}` for right/up/left/down. Idempotent (guarded by anims.exists). Called for base `run_${char}` and per-player `pl_...` textures.
- update() picks facing from input (vertical sets dir, then horizontal overrides so diagonals show a side view), plays `walk_${texKey}_${dir}`; when not moving, `anims.stop()` + `setFrame(DIR_START[lastDir])` to hold last facing. Track `this.lastDir` (default 'down') and `this._moving`.
- **Network protocol carries `dir`, not flipX:** emit `{x,y,dir,anim}`. Validate incoming dir with `DIR_START[data.dir] !== undefined ? data.dir : 'down'` — note `DIR_START.right === 0`, so test `!== undefined`, never truthiness (a `data.dir || 'down'` fallback silently drops a valid 'right').
- Chat/owner-panel idle must preserve facing (`setFrame(DIR_START[lastDir])`, skip if sitting) and still emit a throttled idle/sit update, or remote clients keep seeing your last walk animation while you type.

# Sit animation key
- Sit uses anim `sit_${texKey}` (frames come from the swapped `pl_sit_...` texture, but the anim is keyed off the run texKey). Remote joiners in `_addOtherPlayer` must play `sit_${texKey}`, never base `sit_adam`, or the sitting player renders un-customized until a later move event corrects it.

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
