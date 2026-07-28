---
name: JPO Huddle wearable geometry
description: Verified avatar head geometry for placing wearable overlays, and how to test seated wearables with seeded rows.
---

# Avatar geometry for wearable dy tuning (verified by screenshot sweeps, July 2026)

All values in world px relative to the avatar sprite origin (center of the 16×32 frame at scale 3), for images with default center origin:

- **Eyes ≈ +8** (sunglasses/spectacles dy 8 lands on the eyes). The old note "eyes ≈ -12" was WRONG — never reuse it.
- **Hats perch at dy ≈ -21..-22** for 6-row art (cap -22, flatcap -21, beanie -22, rangerhat -22). dy ≤ -24 for 6-row art visibly FLOATS above the hair.
- **The chibi head is huge (~45px tall, hair top ≈ -31 … chin below +15)**: a full-head helmet needs ~13×16 art at dy -7 to enclose it with a visor band landing on the eyes. Neck/shoulder skin showing below the rim is natural, not a placement bug.
- **Side-view detail needs dark colors**: a 1px light-brown ring is invisible against the skin at 3×; darken and add a light glint pixel instead.

**How to apply:** start hats at -21, eye items at +8, sanity-check via the 3× deviceScaleFactor screenshot sweep before trusting any estimate.

# Testing seated wearables with seeded rows

Seed `anim='sit'` + on-seat x/y and the client restores the pose, but the wearable's visibility follows the seeded `dir` — `dir='up'` hides the overlay by design (back view). Seed the `dir` an actual E-press would set for that seat (e.g. 'left' for a pod chair with the desk to its left) or the wearable will "mysteriously" not render.

## Pet accessories (July 2026)
Accessory emoji overlays on pets anchor per-species from the pet's bottom-center origin (`PET_ACC_ANCHOR`), then a per-accessory FIT (`PET_ACC_FIT` {mx,my,dy}) scales it by TYPE — a single head anchor + vertical nudge is NOT enough (a bell at the raw head anchor floats in front of a quadruped's face; user-reported). Collars tuck IN and DOWN (mx~0.4, my~0.55), shades ride the eye line (mx~1.1, my~0.85), hats sit ON the crown with dy +2 because the emoji em-box has ~3px internal padding (a negative "perch" dy reads as floating). Side-view quadrupeds carry heads at the FACING edge → anchor dx ~9–11; upright pets dx ~3–6; dx mirrors with `flipX`. Headless chromium has no color-emoji font — glyphs screenshot as tofu boxes, but the BOX outlines the em-box, so zoomed (camera setZoom(4)) screenshots ARE good enough to tune placement visually; confirm exact offsets numerically in page context.
