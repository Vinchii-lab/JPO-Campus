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

**How to apply:** Review a labeled contact sheet of the actual extracted assets before trusting descriptive aliases. “16×16 pack” describes the source grid, not every PNG's dimensions: singles include multi-tile furniture, ticket-office composites, and wide floor pieces. Tiling all of them at 48px spacing caused overlapping floors and misleading furniture arrangements. Verify the assembled room screenshot, not just asset existence or object counts (hundreds of floor tiles can conceal an almost empty room).

Version asset URLs and Phaser texture keys when replacing artwork with different native dimensions.

**Why:** Replacing furniture files in place while changing to native-scale rendering left browsers using cached, oversized old images. A page/code reload does not necessarily invalidate the image cache.

**How to apply:** Verify decoded texture dimensions, not just files on disk; test already-placed furniture when changing asset scale.

The residential goal is player-built homes, not repeated finished house facades with furniture decoration alone.

**Why:** After seeing the shared street, the user explicitly rejected its prebuilt houses. The earlier approval of exterior art was not approval to give every player an identical completed building.

**How to apply:** The user clarified that the finished house keeps the same basic design, with color customization; players buy floor, walls, roof, then furniture using coins. Do not substitute a freeform wall editor. Preserve ownership and saved furniture while unfinished interiors are unavailable.

Keep street rendering bounded to the camera viewport, even with sparse permanent lot numbers. Account provisioning must not consume new identity values for homes that already exist.

**Why:** Repeated conflict-only inserts exhausted thousands of lot numbers for a small population. A world-sized TileSprite then allocated an enormous backing canvas, crashing scene creation before the player existed. A small repeating source texture alone does not bound Canvas memory.

**How to apply:** Filter existing rows before attempting inserts; retain concurrency conflict protection. Bound scenery chunks and avoid full-world road-mark loops within each chunk. Use pooled immutable world-space ground images: even viewport-sized Canvas TileSprites become expensive when scrolling changes their tile position/scale every frame. Street performance checks must include sustained walking/camera panning, not idle room FPS.

HQ-equivalent zoom takes priority over automatic outdoor viewport filling. Keep plaza benches and decorative obstacles out of roads.

**Why:** The user originally disliked excess empty space, but later explicitly rejected the resulting restricted zoom and missing indoor zoom. They want the same zoom in/out behavior as HQ everywhere, not a map-fit minimum that prevents zooming out.

**How to apply:** Preserve HQ's wheel steps and range across outdoor maps and all interiors. Resizing, per-frame camera fitting, and scene transitions must not silently undo the chosen zoom. Keep source artwork at native 3×; camera zoom is independent of asset scale.

House size means usable floor area, not enlarging the same small room with camera zoom. Treat the uploaded pack's house examples as the scale reference.

**Why:** The user rejected the compact divided interior as too small even after rooms were added, and requested whole-room scale comparable to the ZIP examples.

**How to apply:** Enlarge authored geometry and traversal space while retaining native furniture scale. Keep saved furniture coordinates where possible; conflicting placements can return to inventory without deleting ownership.

Homes must start completely unfurnished; players choose, buy, and place all furniture. Reuse HQ's controls across locations instead of introducing separate neighborhood control panels.

**Why:** The user explicitly rejected the built-in bed/kitchen/bath fittings and the added plus/minus zoom frame. They want the same HQ experience on another map, with M showing their current location.

**How to apply:** Keep only architecture in the base home. Never add free furnishings or their invisible blockers. Put furniture actions on placed shop items and make shared controls location-aware.

Use a compact residential grid no wider than four blocks, not one long vertical strip or a uniformly shrunk whole-world image.

**Why:** The user rejected the vertical street because it left most of the screen as unused grass, then rejected five columns because the walk to the plaza was too long. They requested four columns and five rows for the current neighborhood. Permanent lot numbers represent ownership/address identity, not empty physical cells; sparse IDs must not inflate the map.

**How to apply:** Pack occupied lots across connected rows and columns while preserving permanent addresses and ownership. Render only nearby blocks on both axes. Any future directory change that reflows positions must synchronize the full geometry, not merely update owner labels.