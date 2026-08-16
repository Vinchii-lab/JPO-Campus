---
name: JPO Huddle HD remake pipeline
description: How the hi-bit "HD remake" reskin works — grading recipe, room technique, occluder gotcha, HD character sheets
---

Owner-directed hi-bit remake (Eastward-soft look; style bible at `design/style-bible.png`). Reskin only — layout, coordinates and seats never move.

**Grading recipe (ImageMagick):** `-modulate 100,82 -brightness-contrast 0x-10` for props (characters use 100,88 / 2x-8), `-trim`, resize, always `PNG32:` + sRGB or composites go grayscale.

**Room technique (client-only, in create() after tile layers):**
- Masked `tileSprite` floor keyed to the room's OWN interior floor GIDs (Accounting = 35-52) — never "any floor in rect", that bleeds into corridors. Move it BELOW the Furniture layer (`this.children.moveBelow`) so remaining old furniture stands on it.
- Replaced originals must be `tile.setVisible(false)` — covering them with images is not enough; several features REDRAW tiles at runtime.
- **Occluder gotcha:** `_makeSeatOccluders` re-draws the ORIGINAL desk/monitor tiles over seated bodies — hidden tiles resurrect on sit. HD pods need an HD-image occluder branch (match the base `put()` geometry exactly).
- Seat tiles keep their (invisible) GIDs so sitting/facing logic is untouched.

**HD characters (pilot: Adam):**
- Generate 3 strips (down / side-mirrored-for-left / up), 6 frames each, heavy "frames must never touch" prompt or slicing fails; slice via corner-floodfill bg erase + `-connected-components 8` bboxes, expect ~1 broken frame per strip.
- Sheet = classic 24-frame layout (right/up/left/down × 6) at 48x96/frame = classic 16x32 at scale 3, so all geometry (BODY_DY, occluders) is unchanged at scale 1.
- `_buildPlayerTex` early-returns `run_adam_hd` only for default-look (no recolour/wearables); `_hdify()` wraps sprite.setTexture to auto-sync scale 1↔3 because sit/stand paths swap textures in ~12 places. Physics body px are unscaled-texture px → triple them for HD.
- Still classic: sit sheets, recolours, baked wearables (anchors are 16px-tuned) — the flagged remaining "boss battle" work.

**Why:** owner saw old sprites "resurrect" on interaction twice; the setVisible + occluder-branch pattern is what finally killed it.

## Scale sync & mixed-scale sitting
- Phaser `anims.play()` swaps textures WITHOUT calling `setTexture`, so the _hdify wrapper alone leaves an HD (scale-1) sprite tiny when a classic sit anim starts. _hdify must also re-sync scale on `ANIMATION_START`.
- HD sit poses don't exist yet: sit anims for `*_hd` keys are ALIASES onto the recolored classic sit textures — mixed scales per pose are expected and handled by the sync above.
- `_buildPlayerTex` early exists-check must FALL THROUGH to the HD block when the classic key was pre-built by a remote player, or the local player gets stranded on classic art.
- HD pod desks face the viewer (screen south), so pod sitters are snapped 2 rows SOUTH of the map seat tile with a 'standup' pose + chair-back occluder; local snap, `_deskPoseAt`, occluders and static chair must all share that geometry (96px snap < server's 160px allowance).
- `tryRegister` upsert RESETS look columns to payload defaults — seed custom looks in-page, never via DB pre-seed.

## HD sit poses (no more classic fallback while seated)
- HD sit sheets exist per classic layout: sit/sit2/sit3 (right/up/down), frames 96x96 (right/up) and 48x96 (down), 6 frames (0-2 normal, 3-5 one px lower bob). Generated as 3 static poses on white → thirds-slice → same grade recipe as the run sheet.
- Built HD sit textures must be NAMED ending `_hd` so the _hdify anim-start sync keeps scale 1.
- Wearable bake on HD sit sheets needs a per-sheet dy BEFORE the 3x scale (classic anchors assume classic head rows; measured: sit -11, sit2 +7, sit3 -11).
- The owner rejects ANY classic-art fallback on his HD character — seated included; scale-up of classic sheets is not acceptable, generate real HD art instead.

## HD per-part layer masks (recolor detail)
- HD recolor is mask-driven: tools/hd-layer-split.cjs partitions each HD sheet into skin/hair/shirt/pants/shoes/body layer PNGs (assets/layers/*_hd_*.png); client tints only the owning layer (shoes follow the pants pick, classic zones.shoe semantics). Centroid classifier kept as fallback when masks miss.
- Splitter gotchas: near-black outline pixels fall inside the dark pants/shoes centroids (need a max(r,g,b)<0x20 body floor), and the chest lanyard strap is the same navy as pants — upper-body pants/shoes hits must be gated to body by a per-sheet waist fraction or the strap recolors with pants.
- QA recipe: colorize each layer garishly + flatten to spot bleed; verify partition strictly (every opaque px owned by exactly one layer).
