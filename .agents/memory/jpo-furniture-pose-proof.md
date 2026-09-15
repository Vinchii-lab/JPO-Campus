---
name: Furniture pose verification
description: Visual fixtures must use authoritative action anchors and real wearable metadata.
---

Verify furniture activities using the shared action-anchor calculation and actual wearable definitions, not manually chosen fixture positions.

**Why:** A fixture passed depth ordering while showing seated characters in front of the seats and a hat floating above the bath. Synthetic actor coordinates and guessed accessory offsets concealed which problems belonged to the fixture versus the app. Correct depth ordering alone does not establish a correct pose.

**How to apply:** Render real furniture frames and avatar sheets through production pose methods. Check mattress/pillow alignment, seat-pad placement, visible head above the bath rim, and wearable attachment. Verify reset of angle, scale, effects, and depth for local and remote actors after leaving.

An isolated pose render is not proof that live furniture interactions work.

**Why:** Pose screenshots passed while the regular scene update could overwrite poses, legacy invisible showroom blockers remained, and the live nearby-action detector could return no target at a valid authored stand.

**How to apply:** Exercise the full scene/update loop and real E admission/exit. When proximity fails, capture both authoritative demo metadata and rendered object count/action data; coordinates alone cannot distinguish collision problems from missing interaction objects.