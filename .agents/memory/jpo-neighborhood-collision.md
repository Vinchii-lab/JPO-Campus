---
name: Neighborhood collision and scene lifecycle
description: Avoid apparent collision freezes and mismatched door thresholds in reused Phaser scenes.
---
Refresh Arcade bodies with updateFromGameObject before measuring body center/half-extents during scene creation. Convert server sprite-position collision geometry to Arcade's offset body coordinates.

**Why:** A 3× 16×32 avatar with a 12×10 body offset (2,20) has a body center 27px below sprite position. Omitting this blocked home doors that server-only trajectory tests considered walkable. Body measurements before the first physics update can also be stale.

**How to apply:** Validate narrow doorways in the real browser, not only against server geometry. Preserve the measured transform when changing body size, sprite origin, or scale.

Reset all travel flags and cancel delayed callbacks whenever a reusable map scene is created or shut down.

**Why:** Phaser reuses scene instances; a retained transitionRequested flag froze all movement after the second map transition, which looked like a collision error.