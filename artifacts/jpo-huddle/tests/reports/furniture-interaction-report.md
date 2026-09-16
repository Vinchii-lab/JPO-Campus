# Furniture interaction audit

Run `node tests/reports/furniture-interaction-matrix.mjs` for the
production-geometry assertions and the full anchor/exit coordinates. The
catalog currently has 13 supported interactive rows and 23 deliberately
decorative/storage rows. Every allowed catalog rotation (currently `0°` for
all rows) was checked against an empty, connected home using the shared
footprint body, actor-radius collision, walkable stand, and continuous
stand-to-anchor path.

## Catalog actions

| Item | Supported action(s) |
| --- | --- |
| Gold armchair | Sit |
| Cream lounge sofa | Sit, lie |
| Ivory reading sofa | Sit, lie |
| Porcelain kitchen sink | Toggle water |
| Bedroom bed | Lie, sleep |
| Walnut daybed | Lie, sleep |
| Claw-foot bath | Shower, bathe |
| Bathroom sink | Toggle water |
| Animated tap sink | Toggle water |
| Rain shower | Shower |
| Lavender ottoman | Sit |
| Animated television | Watch |
| Television | Watch |

## Deliberately decorative/storage

Potted fern; Coral floor lamp; Plum low table; Gold bookcase; Tall bookcase;
Brass arc lamp; Tall wall mirror; Oak kitchen counter; Grey refrigerator;
Kitchen range; Open-door oven; Front-load washer; Chef's steel fridge;
Gold bedroom bookcase; Bedside lamp; Dressing mirror; Blue linen dresser;
Porcelain toilet; White bathroom cabinet; Garden topiary; Window pot;
Framed print; Potted plant.

The kitchen counters/appliances are intentionally decorative today; only the
catalog sinks expose the server-owned water toggle.

## Authored commercial seating

All authored commercial seating is the separate `park-seat / sit` contract:

- City: `plaza-bench-northwest`, `plaza-bench-north`, `plaza-bench-south`,
  `plaza-bench-northeast`, `plaza-bench-southwest`,
  `plaza-bench-south-center`, `plaza-bench-east`, `plaza-bench-southeast`.
- Museum room 1: `bench1-1`, `bench1-2`, `bench1-3`.
- Decor shop: `d-s-250`, `d-s-700`.
- Cafe: `c-u-350-200`, `c-d-350-200`, `c-u-550-200`, `c-d-550-200`,
  `c-u-750-200`, `c-d-750-200`, `c-u-350-400`, `c-d-350-400`,
  `c-u-550-400`, `c-d-550-400`, `c-u-750-400`, `c-d-750-400`.
- Diner: `b-l-200`, `b-r-200`, `b-l-450`, `b-r-450`, `b-l-700`, `b-r-700`.
- Bakery: `b-t-u-300`, `b-t-d-300`, `b-t-u-660`, `b-t-d-660`.
- Sushi: `s-t-u-300`, `s-t-d-300`, `s-t-u-660`, `s-t-d-660`.

Legacy furniture-shop park-seat metadata is intentionally absent because those
invisible props are replaced by the seven server-projected catalog showroom
demos. The showroom lifecycle test exercises the real
`NeighborhoodScene._drawFurnitureShowroom()` and
`_nearbyShowroomAction()` methods through null metadata, redraw/destruction,
local/remote activity rebinding, and an E/request regression where the
replacement sprite's `getData` is absent but the stable UUID is still emitted.

The audit also found and fixed a duplicate authored city seat ID
(`plaza-bench-south` was used for two different coordinates). Unique IDs are
required because remote seat state and clean exits carry `seatId`.

## Real-game verification completed

These checks used the real server, browser client, furniture assets, keyboard
input and temporary test homes. Test-only starting positions avoided long
world travel; interaction admission, physics, inventory and persistence were
not mocked.

- **Home Store:** double-clicked Store on one of two identical chairs. Exactly
  one placed instance was removed (four placements became three). The other
  chair and other items stayed unchanged. The selected instance remained in
  inventory, and reload preserved the result. This is the home panel's Store
  action, not a shop purchase.
- **Home seating:** two separate browser sessions sat on two different chairs;
  remote seating was visible, and both exited the activity.
- **Showroom:** the seated pose persisted across updates, with an E: Stand
  prompt, instead of being erased by delayed movement corrections.
- **Walnut daybed:** E started lying down, the pose persisted, and E exit
  restored walking. Visual review also corrected the direction and position
  so the head rests at the right-hand pillow.
- **Claw-foot bath:** Shift+E started bathing, the head remained visible above
  the bath, and E exit restored walking.

The Store fix also removed destructive legacy layout repair from normal
snapshot reads, protected newer snapshots from delayed responses, and
reconciled collision state after committed removals.

## Coverage limits

- No catalog row currently allows `90°`, `180°`, or `270°`; therefore there is
  no quarter-turn art contract to validate yet.
- All 36 catalog rows and 39 fixed seats received geometry/metadata checks.
  The browser checks above are representative runtime checks, not a claim
  that every decorative object or every commercial seat was visually tested.
- Decorative items retain their existing behavior. This work did not add
  new cooking, refrigerator, laundry or toilet gameplay.
- Previously removed layout positions were not reconstructed. Tests only
  changed temporary test homes; existing player layouts were not used.