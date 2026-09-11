---
name: Neighborhood collision and scene lifecycle
description: Avoid apparent collision freezes and mismatched door thresholds in reused Phaser scenes.
---
Refresh Arcade bodies with updateFromGameObject before measuring body center/half-extents during scene creation. Convert server sprite-position collision geometry to Arcade's offset body coordinates.

**Why:** A 3× 16×32 avatar with a 12×10 body offset (2,20) has a body center 27px below sprite position. Omitting this blocked home doors that server-only trajectory tests considered walkable. Body measurements before the first physics update can also be stale.

**How to apply:** Validate narrow doorways in the real browser, not only against server geometry. Preserve the measured transform when changing body size, sprite origin, or scale.

Reset all travel flags and cancel delayed callbacks whenever a reusable map scene is created or shut down.

**Why:** Phaser reuses scene instances; a retained transitionRequested flag froze all movement after the second map transition, which looked like a collision error.

Register cleanup on Phaser's SHUTDOWN event; naming a class method `shutdown` does not register it. Clear retained display-object references between maps, and allow initial snapshot hydration during CREATING.

**Why:** Street visuals survived as references to destroyed objects on home entry, leaving the shared scene inactive. Timer-generation guards alone did not fix it. ACTIVE-only guards also skipped initial furniture hydration.

**How to apply:** Exercise street → home → street when changing this scene, including a placed item. Reset street-only references before constructing interiors and retain generation guards for delayed fades.

Exercise avatar rendering with a cold texture cache when reusing HQ rendering methods in another scene.

**Why:** HQ's globally cached avatar textures masked missing nested helper bridges until a previously unseen avatar appeared outdoors. Testing only the logged-in avatar missed the crash.

**How to apply:** Include fresh running and sitting sheets with equipped clothing, and check nested method calls use the receiving scene's renderer.