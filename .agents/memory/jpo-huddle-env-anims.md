---
name: JPO Huddle env animated overlays
description: How to add animated Phaser sprites that sit between tilemap layers and character sprites in the gym/cafeteria.
---

## Rule

Animated environment sprites (punching bags, treadmills, fridges) are placed in `create()` **after the tilemap layers but before any player sprite spawns**. Phaser uses insertion-order depth at depth 0, so sprites added earlier render below sprites added later — no explicit `setDepth()` needed to sit above tiles and below characters.

**Why:** Player sprites are added to the scene when the 'approved' socket event fires (after `create()` runs). Everything in `create()` before that is already in the display list below them. Coffee steam tweens follow the same pattern.

## How to apply

1. Load the spritesheet in `preload()` with correct `frameWidth`/`frameHeight`.
2. Create the animation in `create()` right after `phone_adam`.
3. Place `this.add.sprite(x, y, key).setOrigin(0.5, 0.5).setScale(3).play(animKey)` inside the env-overlay block in `create()`, before `this.otherPlayers = {}`.
4. `setScale(3)` matches the tilemap's `setScale(3)` — 1 source pixel = 3 world pixels = 1 tile at 48px world. Use `setDisplaySize(w, h)` when the sprite doesn't match the map slot exactly.

## Scale math

- 1 tile = 48 world px (16 source px × scale 3)
- A 32×32 source sprite at scale 3 = 96×96 world = 2×2 tiles
- A 32×48 source sprite at scale 3 = 96×144 world = 2×3 tiles (fridge fits drink cooler slot exactly)
- A 48×64 source sprite with `setDisplaySize(144,144)` = 3×3 tile slot (treadmill, slight vertical squish accepted)

## Punch bag specifics

- Wall-mount bracket tiles GIDs 9872/9873 are already in the map at c199/c202/c205 r18.
- Bags hang at r19 center (y = 19×48 + 24 = 936); bracket at r18 is above.
- E-key interaction: proximity 96px radius → `_doPunchBag(bag)` plays hit anim + floats 🥊.
- `nearBag` check is AFTER `OFFICE_OBJECTS` scan so bags never conflict with real interactive objects.
- Per-bag `_lastHit` timestamp gives 2s cooldown; `bag.sprite.once('animationcomplete', ...)` reverts to idle.

## Drink cooler positions

Two stacks at c115-116, r63-65 and r68-70 (Furniture GIDs 2183/2184/2199/2200 + 2215-2217).
Animated fridge sprite frame 32×48 = exact 2×3 tile match at scale 3.
