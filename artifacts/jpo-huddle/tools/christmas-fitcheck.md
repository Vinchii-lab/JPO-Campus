# Christmas visual QA

## Run in development

```sh
python artifacts/jpo-huddle/tools/christmas-fit-layers.py
URL="https://$REPLIT_DEV_DOMAIN/" timeout 115 node artifacts/jpo-huddle/tools/christmas-fitcheck.cjs
```

The merged fitting command preserves the main app's canonical body-clothing
generator (`christmas-layer-gen.py`) and its skin/head regression check; the
padded headwear, seated wing fitting and reindeer correction remain from this QA.

The browser harness uses the running game's native texture builder, cosmetics,
source frames and display-list ordering. It waits for every required sheet,
rejects missing/invisible overlays and mismatched headwear frames, writes
`generated-artifacts/christmas-fitcheck/`, and disconnects its anonymous socket
before closing Chromium. No account is registered, borrowed, modified or deleted.
No season, stock, purchases or database state are changed.

## Coverage and findings

- Four characters: Adam, Alex, Amelia and Bob.
- All six Christmas wearables, alone and in a Santa/scarf/sweater/wings combination.
- Right, up, left and down standing facings.
- Every seated source sheet: both native directional halves, with and without
  runtime mirroring. Chair-facing names are not anatomical facings.
- Every native run and seated animation frame: 1,952 character renders total,
  including the base and combined-outfit representative poses.
- All three reindeer stages: idle, three walk frames, sit and action, both
  original and mirrored directions. All 18 loaded images are 64 × 64.
- Browser renderer completed without page errors. Development server restarted
  successfully; entry page also verified separately.

Fixed demonstrated problems:

1. Sweater/elf torso stickers covered faces. Fitted layers now follow the
   native torso while preserving hair and exposed skin.
2. Scarf's head anchor placed its collar too high. It now follows the neckline,
   and is baked after tops so the top cannot cover it.
3. Raised seated crowns clipped tall headwear. Padded pose layers now track
   source frames and mirroring without clipping.
4. Snowflake wings treated raised profile seats as rear-facing standing poses.
   They now follow seated head displacement and anatomical facing, behind the body.
5. Adult reindeer's sitting asset contained a fourth walking pose. Source slicing
   now explicitly skips that extra walk and keeps the actual sitting pose.

`contact-sheets.html` is a self-contained gallery with all full-resolution
contact sheets; click a sheet to inspect its pixels. `results.json` records
the render count, pet dimensions and browser errors.

## Boundaries

This verifies renderer fitting, not seasonal purchases, gifting or delivery.
Those flows are covered by the separate Christmas gift/delivery task. It is
not a signed-in multiplayer or furniture-occlusion acceptance test. Using the
anonymous pre-login renderer avoids unnecessary approved-account fixtures and
leaves existing players untouched.
