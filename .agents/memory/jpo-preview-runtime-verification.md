---
name: Preview runtime verification
description: Distinguish current browser exceptions from retained old-build errors when debugging the preview.
---

Verify the loaded browser build and live function source before treating a repeated exception as a failure of a new fix.

**Why:** A teardown fix was served correctly, but a browser retest reported old-line-number errors from the previous page's disconnect/visibility handlers. Fetching source from disk or HTTP does not prove what an already-open page has evaluated.

**How to apply:** Start a clean context without custom request headers, wait for actual exported globals and the real loader to finish, then inspect the build stamp and relevant prototype methods. Count only errors occurring after that check. Never invent texture names or readiness flags as preload assertions; obtain them from the real scene source.

Performance checks must match the reported scene, movement, renderer, and session features.

**Why:** Anonymous Canvas tests showed smooth rooms and streets while the user's signed-in WebGL session still felt heavy. Those tests omitted the actual pet and server corrections and could not establish that the reported problem was fixed.

**How to apply:** Inspect the live browser renderer and measure frame intervals, update/render cost, and correction reasons during the reported action. Treat fixture-only FPS as a narrow rendering measurement, not proof of smooth signed-in gameplay.

Build-update cooldowns must schedule another check, and recovery must not depend solely on a healthy gameplay socket.

**Why:** Several fixes within a five-minute reload cooldown can leave an open page running the original code if its sole reconnect check returns early.

**How to apply:** Preserve loop protection while retrying when the cooldown expires; use bounded visible-page/focus checks to recover when a broken socket callback prevents reconnect.

Discard Phaser return values inside browser-evaluation mutations; return only small plain values.

**Why:** Returning `scene.start(...)` implicitly from an arrow expression repeatedly disconnected the testing notebook without a page error. Using a braced callback with `return true` completed the same room transitions successfully. Scene managers are large cyclic object graphs, not useful test results.

**How to apply:** Use `data => { game.scene.start('NeighborhoodScene', data); return true; }`, then inspect readiness/location in a separate evaluation returning a small plain object. Do not diagnose a test transport disconnect alone as an app runtime crash.