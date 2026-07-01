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

# Adam_sit sheet poses are 32px wide — slicing at 16px makes the seated avatar SWAY
- `public/assets/Adam_sit_16x16.png` filename lies: its seated poses are **32px wide** (each spans two 16px columns), unlike the 16px-wide run frames. Slicing at `frameWidth:16` splits each pose into left/right halves and the looping sit anim alternates them → a large on-screen left-right sway (the "chair sitting jitter / goes back and forth").
- **Key lesson — animation-frame sway is invisible to transform probes:** `player.x/y` never move, only the rendered frame pixels shift, so position/physics jitter checks read exactly 0 and miss it. Diagnose by measuring per-frame content centroid in the source sheet (or diffing screenshots across anim frames), not the sprite transform.
- **Fix:** slice at `frameWidth:32` in BOTH the `adam_sit` preload and the palette-swapped `addSpriteSheet(sitKey,…)` in `_buildPlayerTex`; keep frames 0–5. `_applySwaps` runs on raw pixels BEFORE slicing, so slice width doesn't affect palette swaps or remote avatars.

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
- **The map is user-authored in Tiled and swapped in periodically.** Swap procedure: user drops a `.tmx` (CSV encoding, layers Floor/Wall/Furniture, tilesets Room_Builder firstgid=1 + Interiors_free_16x16 firstgid=392). Convert by loading the current `Office.tmj` as a template and replacing each tilelayer's `data` array (matched by layer NAME) with the parsed CSV — this keeps the tileset defs/metadata the Phaser loader needs. **Preserve flip-flag GID ints verbatim** (e.g. 1610612800, 3221225536 = wall GID 64 + Tiled flip bits 0x80000000/0x40000000/0x20000000); Phaser strips them at render. Confirm firstgids match between tmx and tmj (else remap needed) and each layer = 1800 ints (50×36).
- **Faithful conversion reproduces the source's design quirks — do NOT "fix" them in code.** User layouts routinely include sealed cubicle interiors (Wall layer fully encloses cells, no doorway) and decorative board-art tiles (BOARD_GIDS) embedded in exterior/double walls with no walkable neighbor, plus the odd chair boxed in by its own cluster. These aren't conversion bugs — opening/relocating them means editing the Tiled source (redesign), out of scope for a straight swap. Validate with flood-fill from spawn (blocked = wall!=0 OR furniture!=0, 4-conn) + chair/board adjacency, then REPORT gaps for user signoff rather than fabricating doorways.
- Spawn point: tile (22, 17) = world (1080, 840); validated open (wall=0, furniture=0) — re-verify after every swap since a new layout can put a wall/desk there.
- World size: 2400×1728 (50×36 tiles × 48px).
- **Screen-glow ambiance must be anchored to explicitly identified monitor tiles in the CURRENT source, never hardcoded tile coords** — hardcoded coords silently point at the wrong furniture (or empty floor) after any map swap. Removed on the last swap because the new layout had no lit-monitor workstations.

# Furniture collision + sit model + announcement boards
- **Making the whole Furniture layer solid is SAFE** — rugs/carpets live on the **Floor** layer, not Furniture, so it blocks no walkway, doorway, or the spawn tile. Don't fear a blanket furniture collider here.
- **Chairs ARE their own tiles** — sitting is gated to an explicit allowlist `CHAIR_GIDS` (office 453/523, conference 510/472/474, wooden 750/751), identified by rendering the Interiors tileset against the Furniture-layer GID grid. Only chairs are sit-interactable; desks/tables/cabinets/sofas/plants are solid but not.
- **Sitting snaps the player ONTO the chair tile** (the neighbour in the facing dir), not the adjacent tile. Because the whole Furniture layer is a solid collider, seat by storing `_preSitPos`, then `player.body.enable=false` while seated so the collider can't eject the player; on stand, restore `_preSitPos` and set `body.enable=true`. Facing = `interact.dir` (chairs are placed backrest-toward-approach, so you sit facing the seat/desk, which reads as "facing outward").
- **Boards are wall-mounted on multiple sides** (including the right wall), so board/sit interaction must scan all 4 neighbours, not just the tile below — a below-only check misses side-wall boards.
- **Only Adam has seated artwork.** Alex/Amelia/Bob have no sit frames, so they hold a static facing frame both locally AND for remote viewers — the remote (`playerMoved`/`_addOtherPlayer`) sit path must special-case "no sit anim → freeze on the directional frame", NOT fall back to the down-facing idle, or other clients see the wrong seated pose. A true seated pose for them needs new art.
- Announcements are **server-side in-memory only** (lost on restart), **admin-gated** for both post and delete; new clients get the current list on connect and posts broadcast live. Admin identity is the F8 password (stored in the server's `ADMIN_PASSWORD`, sourced from env/secret — never hardcode or record the value).
