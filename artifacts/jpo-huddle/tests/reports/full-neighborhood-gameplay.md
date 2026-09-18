# Full neighborhood gameplay pass

Date: 2026-09-18 (UTC)

## Verdict

**Partial failure / incomplete matrix.** The real route and substantial isolated
real-server/browser coverage were exercised. The pass did not reach the
requested all-36 purchase and all-room persistence matrix because the existing
real-game harness stopped on production-geometry movement assertions before the
cashier and before bed/bath actions. No app code was changed.

## Real preview route (owner)

Account created through the visible registration and character-builder UI:

- `qaowner1789754434273@justpressone.com` (Adam QA Owner)
- Approval/funding was limited to this exact development row.
- Normal sign-in succeeded; the first-run 1/10 tour was skipped.

The earlier gate allegation is **amended**: it was caused by an incorrect
approach route, not a confirmed app bug. The supplied FullbodyBFS route was
used with real Arrow input:

`(236,2484) → east (620,2484) → north (620,2380) → west (420,2380) → north (420,2280) → west (240,2280)`

This crossed the live `_gardenExit` from the east side and verified:

1. `OfficeScene` / JPO HQ → `NeighborhoodScene` / Willow Walk.
2. Real eastward walk across Willow Walk → authored Huddle Plaza portal.
3. `NeighborhoodScene`, `location:"city"`, label `Huddle Plaza`.

Evidence screenshots: `eu36z6` (pre-correction blocked approach),
`52u1tu` (Willow Walk), `wuna4o` (Huddle Plaza). The earlier `eu36z6`
observation must not be treated as a product failure after the corrected route.

The owner reached the Huddle Plaza FURNISHINGS storefront through the live
Plaza route and inspected authored doors. The final real storefront approach
stopped at approximately `{x:456,y:399}` beneath the visible door
`x:444..516,y:282..382`; the furniture-shop transition did not fire in the
public preview. This was not counted as shop entry. The isolated harness below
did enter the same shop via its real city/shop portals.

## Isolated real-server/browser harness runs

Command family:

`REAL_GAME_QA=1 timeout 240 node tests/neighborhood/real-game-furniture.mjs`

Harness uses isolated local server, isolated incognito owner/guest contexts,
real registration UI, real keyboard/canvas/UI events, server admission, real
snapshots, and screenshots. Loader/bootstrap phases are setup only and are not
counted as travel coverage.

### Successful focused run

`REAL_GAME_HOME_PLACED_CHAIR_QA=1` **PASS**

Evidence directory:
`tests/evidence/real-game-furniture-9ptx73j/`

Verified through real UI/server:

- Owner home rendered the real Plum low table and stored HQ gold stool.
- Inventory hotbar exposed Place.
- Hover preview, invalid/unconfirmed preview state, valid cell selection,
  Confirm, and Cancel controls were exercised.
- Confirm persisted the exact UUID beside the table and removed it from
  inventory.
- Real E Sit and E Stand worked from the south approach beside the low table.
- Move preview/Cancel left the exact layout unchanged.
- Explicit browser reload preserved coordinates and interactivity.
- Close-up pose checks verified directional seated texture, anchor/depth,
  scale/angle reset, and body above the stool surface.

### Visitor/home partial coverage

`REAL_GAME_HOME_INTERACTIONS_ONLY=1` reached the owner home with an isolated
guest context before failing during the later bed approach. Both owner and
guest visibly received the same four real placed rows (two chairs, bed, bath);
rendered sprites carried real instance/furniture IDs and real textures. This
is evidence of layout observation, not a complete private-home permissions
claim: the run did not reach the full permitted/denied interaction matrix.

Failure:

`bed approach waypoint 3 reached (545,722), 74px from target` in
`tests/evidence/real-game-furniture-4joba9a/fatal-evidence.json`.

### Focused bed/bath run

`REAL_GAME_HOME_BED_BATH_ONLY=1` failed before E Lie/Bathe:

`focused bed approach waypoint 3 reached (545,626), 23px from target`.

Evidence:
`tests/evidence/real-game-furniture-s9tgn16/fatal-evidence.json`.

#### Fixed-helper regression rerun (2026-09-18)

The route-helper changes were rerun without repeating the already-verified
registration or HQ→Willow travel coverage. The bed/bath mode still did not
reach the requested live actions: the new simulation-frame keyboard-release
path stopped at the first bed approach turn with
`focused bed approach turn 1: arrival outside 10px tolerance`
(`real-game-furniture-g1av0pm/fatal-evidence.json`). Consequently no live
`E Lie`, `E Bathe`, pose screenshot, or exit result can be counted from this
rerun.

The Plaza cashier rerun used
`REAL_GAME_PLAZA_SKIP_SHOWROOM_COLLISION=1` and the corrected cashier route
`(571,536.5) → (571,552.5) → (539,552.5) → (539,408.5)`. It successfully
reached the cashier route's three simulated arrivals, but failed immediately
before opening the cashier UI because the assertion that cashier `E` opens
every for-sale product did not pass. No visible Buy action, purchase result,
or purchase row can be counted. Evidence:
`real-game-furniture-t353j15/fatal-evidence.json`.

These remain test-helper/regression failures, not confirmed production
gameplay failures. No application code was changed.

### Plaza/showroom/purchase run

The harness entered the real furniture shop through its real city/shop
portals and verified the server-delivered showroom:

- 11 showroom demos delivered.
- 11 rendered sprites matched demos.
- All demos had server-supplied physical collision bodies.
- Sprite instance IDs, furniture IDs, textures, and action descriptors were
  present.
- Screenshot: `tests/evidence/real-game-furniture-o13f83m/showroom-full-catalog-before.png`.

The earlier `o13f83m` result was superseded by the fixed helper. In
`t353j15`, the corrected cashier route reached the cashier and `E` succeeded.
The cashier returned all 36 canonical for-sale product names and prices
(including retained display decor); the prior failure was only a stale
test assertion expecting old lamp/table/sofa names. Therefore cashier
visibility and the canonical 36-row catalog are verified by that run. The
old `o13f83m` movement result must not be reported as the current cashier
outcome. Evidence:
`tests/evidence/real-game-furniture-t353j15/fatal-evidence.json`.

The subsequent `REAL_GAME_FULL_CATALOG_QA=1` run (`d356dyb`) reached the real
showroom, corrected cashier route, and began the per-item catalog UI loop.
It timed out at the five-minute bound while processing `chef_fridge`; its
`full-catalog-matrix.json` was still empty, so it provides no additional
completed per-item purchase/place/action rows. No second run was started.

## Furniture catalog matrix (36 rows)

Catalog names/prices were read from the real showroom catalog payload. A row
is marked **UI purchase verified** only if a visible cashier Buy action emitted a
successful purchase result. No row reached that bar in this pass.

| ID | Name | Price | Purchase | Place/confirm | Move/cancel | Store/reload | Action |
|---|---|---:|---|---|---|---|---|
| oak_chair | HQ gold stool | 5,000 | **cashier E/catalog verified; purchase-result matrix unchecked** | **verified in focused setup** | **verified in focused setup** | **verified in focused setup** | **verified Sit/Stand** |
| fern | Potted fern | 5,000 | unchecked | unchecked | unchecked | unchecked | decorative |
| reading_lamp | Coral floor lamp | 8,000 | unchecked | unchecked | unchecked | unchecked | decorative |
| coffee_table | Plum low table | 12,000 | unchecked | setup only | setup only | setup only | decorative/collision |
| blue_sofa | Cream lounge sofa | 18,000 | unchecked | unchecked | unchecked | unchecked | unchecked |
| bookcase | Gold bookcase | 18,000 | unchecked | unchecked | unchecked | unchecked | decorative |
| lounge_sofa | Ivory reading sofa | 25,000 | unchecked | unchecked | unchecked | unchecked | unchecked |
| living_shelf | Tall bookcase | 18,000 | unchecked | unchecked | unchecked | unchecked | decorative |
| living_lamp | Coral floor lamp | 12,000 | unchecked | unchecked | unchecked | unchecked | decorative |
| living_mirror | Tall wall mirror | 18,000 | unchecked | unchecked | unchecked | unchecked | decorative |
| kitchen_counter | Oak kitchen counter | 12,000 | unchecked | unchecked | unchecked | unchecked | decorative |
| kitchen_fridge | Grey refrigerator | 25,000 | unchecked | unchecked | unchecked | unchecked | decorative |
| kitchen_sink | Porcelain kitchen sink | 18,000 | unchecked | unchecked | unchecked | unchecked | unchecked |
| kitchen_stove | Kitchen range | 25,000 | unchecked | unchecked | unchecked | unchecked | decorative |
| kitchen_oven | Open-door oven | 35,000 | unchecked | unchecked | unchecked | unchecked | decorative |
| coffee_machine | Front-load washer | 12,000 | unchecked | unchecked | unchecked | unchecked | decorative |
| chef_fridge | Chef's steel fridge | 50,000 | unchecked | unchecked | unchecked | unchecked | decorative |
| bed | Bedroom bed | 35,000 | unchecked | unchecked | unchecked | unchecked | Lie/Sleep unchecked |
| plush_bed | Walnut daybed | 50,000 | unchecked | unchecked | unchecked | unchecked | Lie/Sleep unchecked |
| bedroom_shelf | Gold bedroom bookcase | 18,000 | unchecked | unchecked | unchecked | unchecked | decorative |
| bedroom_lamp | Bedroom floor lamp | 8,000 | unchecked | unchecked | unchecked | unchecked | decorative |
| bedroom_mirror | Dressing mirror | 18,000 | unchecked | unchecked | unchecked | unchecked | decorative |
| bedroom_dresser | Blue linen dresser | 25,000 | unchecked | unchecked | unchecked | unchecked | decorative |
| bathtub | Claw-foot bath | 35,000 | unchecked | unchecked | unchecked | unchecked | Shower/Bathe unchecked |
| bathroom_sink | Bathroom sink | 12,000 | unchecked | unchecked | unchecked | unchecked | Toggle water unchecked |
| bathroom_sink_tap | Animated tap sink | 25,000 | unchecked | unchecked | unchecked | unchecked | Toggle water unchecked |
| bathroom_toilet | Porcelain toilet | 12,000 | unchecked | unchecked | unchecked | unchecked | decorative |
| bathroom_cabinet | White bathroom cabinet | 18,000 | unchecked | unchecked | unchecked | unchecked | decorative |
| shower | Rain shower | 35,000 | unchecked | unchecked | unchecked | unchecked | Shower unchecked |
| floor_rug | Lavender ottoman | 12,000 | unchecked | unchecked | unchecked | unchecked | Sit unchecked |
| plant_palm | Garden topiary | 18,000 | unchecked | unchecked | unchecked | unchecked | decorative |
| plant_small | Window pot | 8,000 | unchecked | unchecked | unchecked | unchecked | decorative |
| wall_art | Framed print | 25,000 | unchecked | unchecked | unchecked | unchecked | decorative |
| planter | Potted plant | 8,000 | unchecked | unchecked | unchecked | unchecked | decorative |
| tv | Animated television | 35,000 | unchecked | unchecked | unchecked | unchecked | Watch unchecked |
| television | Television | 35,000 | unchecked | unchecked | unchecked | unchecked | Watch unchecked |

The catalog totals 36 rows. The existing audit's 13 interactive rows and
geometry checks are not substituted for this browser purchase matrix.

## Commercial seating / visitor gaps

The showroom diagnostics delivered all fixed showroom seats and action
descriptors, but the run did not complete visitor permissions or live E
interactions for cafe, diner, bakery, and sushi. Those rows remain unchecked.
The prior home-interactions run verified that an isolated visitor can observe
the owner's four real placed items; it did not complete denied
place/move/store/purchase assertions.

## Cleanup and test changes

- No production/app code was changed.
- Test-only changes to
  `tests/neighborhood/real-game-furniture.mjs`:
  `REAL_GAME_PLAZA_SKIP_SHOWROOM_COLLISION=1` skips only the known showroom
  collision subcase so independent Plaza cashier coverage can run, and the
  cashier approach uses the real corridor between the counter and bath.
- Focused harness runs clean their generated QA fixtures. The original
  public-preview owner account remains available only for the requested
  targeted gate retest; it should be deleted after that retest is no longer
  needed.