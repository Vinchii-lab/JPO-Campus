---
name: JPO Huddle Phaser sprite & collision
description: Non-obvious facts about the Adam player spritesheet and Phaser arcade body sizing in the JPO Huddle office game.
---

# Adam player spritesheet
- `public/assets/Adam_16x16.png` is **16×32 per frame**, NOT 16×16 (the filename misleads — the character spans two tiles tall). Each 32px frame holds one full character; frames are cleanly aligned, no misalignment.
- **So a "cut character" is NOT a spritesheet/frameHeight problem** — look at depth/origin (sprite being overdrawn by walls) instead.

# Phaser arcade body sizing gotcha
- Arcade `body.setSize` dimensions ARE multiplied by the sprite's scale for world collision.
- **Why:** at `setScale(3)`, a `16×32` body becomes 48×96 = two 48px tiles tall. A 2-tile-tall body silently cannot fit through 1-tile horizontal doorways, so the player is blocked from rooms even though the art looks fine and walls look open.
- **How to apply:** for top-down movement use a feet-sized body well under one tile, anchored with `setOrigin(0.5,1)`. Verify reachability by flood-filling the Wall layer of `Office.tmj`.

# Office.tmj map
- Some rooms are **sealed**: the Wall layer fully encloses them with no doorway gap even though floor is painted underneath (looks like an open "space"). No code/collision change can open them — a gap must be added in the Wall layer in Tiled.
