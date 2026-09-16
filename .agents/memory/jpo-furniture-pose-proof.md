---
name: Furniture pose verification
description: Visual fixtures must use authoritative action anchors and real wearable metadata.
---

Verify furniture activities using the shared action-anchor calculation and actual wearable definitions, not manually chosen fixture positions.

**Why:** A fixture passed depth ordering while showing seated characters in front of the seats and a hat floating above the bath. Synthetic actor coordinates and guessed accessory offsets concealed which problems belonged to the fixture versus the app. Correct depth ordering alone does not establish a correct pose.

**How to apply:** Render real furniture frames and avatar sheets through production pose methods. Check mattress/pillow alignment, seat-pad placement, visible head above the bath rim, and wearable attachment. Verify reset of angle, scale, effects, and depth for local and remote actors after leaving.

Align a sitter's visible hips with the cushion, not the sprite pivot. Require the full face and torso to remain visible above the chair front.

**Why:** Moving the front mask could hide the standing-looking legs while also covering the lower face and entire torso. A successful Sit event, correct animation, and correct depth all passed despite that visibly wrong pose.

**How to apply:** Compare bounded seat-height alternatives using the real avatar before adjusting the front mask, then inspect live local and observer close-ups. Do not accept a head-only silhouette as a successful seated pose.

An isolated pose render is not proof that live furniture interactions work.

**Why:** Pose screenshots passed while the regular scene update could overwrite poses, legacy invisible showroom blockers remained, and the live nearby-action detector could return no target at a valid authored stand.

**How to apply:** Exercise the full scene/update loop and real E admission/exit. When proximity fails, capture both authoritative demo metadata and rendered object count/action data; coordinates alone cannot distinguish collision problems from missing interaction objects.

Anchored furniture activities must not be cleared by ordinary walking corrections that were already in flight when the activity started.

**Why:** Live server admission succeeded, but a delayed speed correction for the previous standing position cleared the local activity. The animation could briefly be seated while the interaction was already gone.

**How to apply:** Suspend walking updates while admission is pending or an activity is active. Preserve activity across corrections that omit activity state; reliable activity stop events remain authoritative.

Direct-start test players still need the catalog supplied by normal room entry.

**Why:** A test-only home spawn showed correct database placements but raw item IDs and no rendered furniture. That was incomplete bootstrap hydration, not evidence that the furniture itself could not be used.

**How to apply:** Assert real rendered furniture count, action data, textures, and readable catalog names before testing proximity or poses. Follow the normal entry protocol rather than injecting replacement drawing data.

Match the exact source artwork before diagnosing an interaction or occlusion complaint.

**Why:** The purple-and-gold low table was mistaken for a similarly styled ottoman, and a firewood rack had been assigned a chair name and Sit action. Passing action tests did not establish that the image was actually seating.

**How to apply:** Compare source silhouettes, trim bounds, and details against the screenshot; confirm whether that catalog item even has actions before adjusting poses.

Synchronized collision coordinates do not prove that the visible body stays outside furniture.

**Why:** Client and server agreed on the player's pivot while the visible feet overlapped the table. Correcting movement exposed a second error: front-side actors still sorted behind the table until draw depth used the same coordinate convention.

**How to apply:** Verify real walking from both north and south, comparing body bounds and visible alpha bounds as well as server positions. Keep physical floor/placement anchors separate from movement and sorting offsets. Cover indoor and yard paths and revalidate saved positions after changing blockers.