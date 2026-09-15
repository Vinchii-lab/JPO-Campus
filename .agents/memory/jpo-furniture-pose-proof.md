---
name: Furniture pose verification
description: Visual fixtures must use authoritative action anchors and real wearable metadata.
---

Verify furniture activities using the shared action-anchor calculation and actual wearable definitions, not manually chosen fixture positions.

**Why:** A fixture passed depth ordering while showing seated characters in front of the seats and a hat floating above the bath. Synthetic actor coordinates and guessed accessory offsets concealed which problems belonged to the fixture versus the app. Correct depth ordering alone does not establish a correct pose.

**How to apply:** Render real furniture frames and avatar sheets through production pose methods. Check mattress/pillow alignment, seat-pad placement, visible head above the bath rim, and wearable attachment. Verify reset of angle, scale, effects, and depth for local and remote actors after leaving.