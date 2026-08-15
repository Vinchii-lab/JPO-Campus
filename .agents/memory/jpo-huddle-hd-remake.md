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
