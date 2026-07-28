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
Accessory emoji overlays on pets anchor per-species from the pet's bottom-center origin (`PET_ACC_ANCHOR` + per-accessory `PET_ACC_DY`); side-view quadrupeds (duck/cat/dog/turtle) carry heads at the FACING edge → dx ~9–11, upright pets (bunny/dragon) dx ~3–6. dx mirrors with `flipX`. Headless chromium has no color-emoji font — accessory glyphs screenshot as tofu boxes; verify position numerically in page context, not by eyeballing pixels.
