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

## Behind-the-body wearables (wings) — display-list trick, not depth
Wings render BEHIND the wearer via EQUAL depth + `children.moveBelow(img, sprite)` (players & floor are all depth 0; a negative depth sinks under the floor). Facing 'up' shows the wearer's BACK, so behind-wearables must flip to `moveAbove` on 'up' (and back to below otherwise) — done per-frame in `_placeWearable` via `img._under`, flags `behind:true, showUp:true` in WEARABLE_DEFS. Infinite flap tweens (scaleX yoyo) MUST be `killTweensOf`'d at EVERY cosmetic destroy path incl. `_removeOtherPlayer`, or join/leave churn leaks immortal tweens.

## Lively pets pilot (Aug 2026)
Procedural pet animation (walk waddle+trot bounce, idle breathing, random idle tricks) lives in `_stepPet`, gated by `PET_LIVELY` species set — mirroring a species = add to the set (+ a `_petTrick` case). Tricks must `return` when `!petObj.visible`: a sparkle burst at a round-hidden player's pet leaks their location. `_trickBusy` parks the procedural writes while a trick tween owns angle/y.

Fairywings final empirical fit (screenshot-swept): `dy 16, side -14, sideDy 6`. Side-view wing: the WINNING recipe (after many rejections) = take the SHAPE the user pointed at (old frame's alpha, morphology-Close to fill translucent holes), repaint flat with the current palette (pink fill + cyan inner band + dark outline via erode/difference masks), full 20px frame height stretched 140% wider, `side -18, sideDy 12` ('spread it more' = wider art + further out). Shrunken, separately-generated, or raw-crop side wings all failed ('blob', 'not uniform', 'too small'). Recover old sprite versions from git history (checkpoints commit assets). Side wing must TUCK INTO the body silhouette (side ≈ -14) or it reads as floating/detached. AI wing art needs a noise pass: dark speckles + green chroma fringe must be scrubbed (fuzz/channel-fx) or they read as "black spots" on grey floors.

## Wearable/wing art pipeline (Aug 2026)
- Generate art on a MAGENTA (#FF00FF) background, never white — white/pale items (angel wings, chef hat) get erased by `-transparent white`.
- Side frames: deriving them from the front/spread art (crop one half, squish, `-flop`) matches style better than generating a separate side view, which comes out as oversized blobs. Side frame must point AWAY from facing dir (mirror with -flop; flipX handles left).
- `generateImage` outputPath is workspace-relative (`tmp/...` = workspace/tmp), NOT shell /tmp.
- WEARABLE_DEFS supports per-item `scale` (default 3). Sizing feedback loop: force-resize content with `WxH!` inside the frame; always confirm with an in-game screenshot sweep (front + side).
