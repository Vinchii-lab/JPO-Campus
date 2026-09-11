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

Test full paths through room doorways, not just isolated waypoint positions.

**Why:** Individually valid points on opposite sides of a wall incorrectly passed a room-access test; the route between them was blocked.

**How to apply:** Sample the segments between waypoints at smaller than tile resolution, then confirm narrow doorways against the actual Arcade body in-browser.

Validate house returns and static-seat exits against the complete live collision geometry, not just expected coordinate formulas.

**Why:** A south-facing house return was inside its own facade, and an apparently reasonable bench exit intersected a nearby planter. Metadata-only assertions missed both.

**How to apply:** Include every facing and all public seats, sparse lot indices, actor radius, and the full exit path. A valid destination alone does not establish a usable route.

Treat Phaser start/wake as queued operations: apply arrival state only after the target scene's CREATE/WAKE and runtime objects are ready.

**Why:** Immediate camera access after a cold start, or input access during a reused scene's teardown, reproduced runtime TypeErrors. A scene reference does not guarantee its camera, player, or keys exist yet.

**How to apply:** Register readiness callbacks before requesting the lifecycle change, cancel callbacks superseded by newer transitions, and keep update handlers inert during teardown/creation.

During shutdown or blur/disconnect cleanup, guard the physics body itself; a surviving sprite does not imply a surviving Arcade body.

**Why:** An actual city→shop browser transition crashed inside sprite.setVelocity after Arcade had already destroyed its body. Optional chaining on the sprite did not help because the method dereferences the missing body internally.

**How to apply:** Stop velocity through an optional body reference in cleanup. Include a retained sprite with a destroyed body in teardown tests. Keep CDN scripts CORS-enabled so library exceptions expose their stack instead of only “Script error.”