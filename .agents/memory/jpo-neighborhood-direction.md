---
name: Neighborhood world direction
description: User's rejected shortcuts and intended map-to-map experience.
---
Neighborhood travel must happen by walking to the HQ garden boundary and through streets/doorways, with a Pokémon-like fade out/in between maps. Do not substitute a destination button bar.

**Why:** The user explicitly rejected the initial implementation as ugly and not proper map-building: flattened interior PNGs used as maps/facades do not meet the requested quality.

**How to apply:** Author coherent tile-based streets, buildings, gardens, and interiors with matching collisions. Use supplied screenshots as visual references, not whole background images. Preserve existing characters and customization. The user does not want to author maps in Tiled.

The user approved the original generated exterior sprite style: teal-roof homes, cream/brown townhouses, striped-awning shop, leafy trees, wooden benches, and dark streetlamps.

**Why:** They explicitly chose “Yes—use this style” after reviewing the modular sprite preview. Preserve that visual direction rather than generating unrelated replacements.

Use the user's uploaded 16×16 pack for housing furniture and interior tiles, not the legacy free tiles or guessed sprite-number mappings. Visually verify individual source sprites before labeling them.

**Why:** The user rejected the furniture implementation after mismatched sprite selections and the wrong source scale undermined the purpose of providing the ZIP. Filename suffixes alone did not identify the furniture.

Version asset URLs and Phaser texture keys when replacing artwork with different native dimensions.

**Why:** Replacing furniture files in place while changing to native-scale rendering left browsers using cached, oversized old images. A page/code reload does not necessarily invalidate the image cache.

**How to apply:** Verify decoded texture dimensions, not just files on disk; test already-placed furniture when changing asset scale.

The residential goal is player-built homes, not repeated finished house facades with furniture decoration alone.

**Why:** After seeing the shared street, the user explicitly rejected its prebuilt houses. The earlier approval of exterior art was not approval to give every player an identical completed building.

**How to apply:** The user clarified that the finished house keeps the same basic design, with color customization; players buy floor, walls, roof, then furniture using coins. Do not substitute a freeform wall editor. Preserve ownership and saved furniture while unfinished interiors are unavailable.

Keep street rendering bounded to the camera viewport, even with sparse permanent lot numbers. Account provisioning must not consume new identity values for homes that already exist.

**Why:** Repeated conflict-only inserts exhausted thousands of lot numbers for a small population. A world-sized TileSprite then allocated an enormous backing canvas, crashing scene creation before the player existed. A small repeating source texture alone does not bound Canvas memory.

**How to apply:** Filter existing rows before attempting inserts; retain concurrency conflict protection. Bound ground canvases and scenery chunks, account for camera zoom on fixed-scroll ground, and avoid full-world road-mark loops within each chunk.

Outdoor framing must fill the viewport within the authored road edges, rather than expose unplayable grass beyond them. Keep plaza benches and decorative obstacles out of roads.

**Why:** The user rejected the wide empty area caused by fixed outdoor zoom and the fountain/benches obstructing the plaza crossing.

**How to apply:** Treat outdoor zoom as responsive with the map bounds as a minimum coverage constraint. Keep indoor scale unchanged and check wide viewports.

House size means usable floor area, not enlarging the same small room with camera zoom. Treat the uploaded pack's house examples as the scale reference.

**Why:** The user rejected the compact divided interior as too small even after rooms were added, and requested whole-room scale comparable to the ZIP examples.

**How to apply:** Enlarge authored geometry and traversal space while retaining native furniture scale. Keep saved furniture coordinates where possible; conflicting placements can return to inventory without deleting ownership.

Homes must start completely unfurnished; players choose, buy, and place all furniture. Reuse HQ's controls across locations instead of introducing separate neighborhood control panels.

**Why:** The user explicitly rejected the built-in bed/kitchen/bath fittings and the added plus/minus zoom frame. They want the same HQ experience on another map, with M showing their current location.

**How to apply:** Keep only architecture in the base home. Never add free furnishings or their invisible blockers. Put furniture actions on placed shop items and make shared controls location-aware.

Show nearby blocks for a long residential street map, not a uniformly shrunk image of its entire world.

**Why:** Permanent sparse lot indices can make the street hundreds of thousands of pixels tall. Bounding canvas memory alone produces an unreadable thin strip; the map must remain useful at the player's location.

**How to apply:** Use a player-local street region with consistent origin translation for geometry and markers. Keep whole-map views for the bounded plaza, shops, and homes.