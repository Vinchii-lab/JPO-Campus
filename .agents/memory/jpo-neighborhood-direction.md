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