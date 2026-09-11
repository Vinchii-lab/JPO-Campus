---
name: Preview runtime verification
description: Distinguish current browser exceptions from retained old-build errors when debugging the preview.
---

Verify the loaded browser build and live function source before treating a repeated exception as a failure of a new fix.

**Why:** A teardown fix was served correctly, but a browser retest reported old-line-number errors from the previous page's disconnect/visibility handlers. Fetching source from disk or HTTP does not prove what an already-open page has evaluated.

**How to apply:** Start a clean context without custom request headers, wait for actual exported globals and the real loader to finish, then inspect the build stamp and relevant prototype methods. Count only errors occurring after that check. Never invent texture names or readiness flags as preload assertions; obtain them from the real scene source.

Build-update cooldowns must schedule another check, and recovery must not depend solely on a healthy gameplay socket.

**Why:** Several fixes within a five-minute reload cooldown can leave an open page running the original code if its sole reconnect check returns early.

**How to apply:** Preserve loop protection while retrying when the cooldown expires; use bounded visible-page/focus checks to recover when a broken socket callback prevents reconnect.