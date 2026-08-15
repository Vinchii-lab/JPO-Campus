---
name: JPO Huddle seasonal weather
description: Client-only calendar-gated weather overlays; wall-clock-hashed storm schedule keeps all clients in sync with zero server code.
---

**Rainy season (Aug–Oct)** lives entirely in the client scene create()/update() ("Seasonal weather" comment): screen-space tileSprites (2x viewport so min-zoom 0.5 stays covered), tint + flash rects, depths 99988–99991 (game max elsewhere is 9000).

**Sync trick:** storms are derived from wall-clock time — 10-min slots, `(slot*2654435761)>>>0 % 4 === 0` opens the slot with a 2.5-min storm — so every client shows identical weather with no server involvement. Reuse this for Halloween (Nov?) / winter themes rather than adding server events.

**Why:** owner wanted "subtle drizzle + full storm every now and then" shared by all players; server-driven weather would add restart-sensitive state for a purely cosmetic effect.

**Backlog owner asked for (not built):** Halloween theme after Oct, seasonal RARE store pets with baby→final-form evolution stages + own animations (frog for rainy season was his example).
