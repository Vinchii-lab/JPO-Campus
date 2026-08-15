---
name: JPO Huddle seasonal weather
description: Client-only calendar-gated weather overlays; wall-clock-hashed storm schedule keeps all clients in sync with zero server code.
---

**Rainy season (Aug–Oct)** lives entirely in the client scene create()/update() ("Seasonal weather" comment): screen-space tileSprites (2x viewport so min-zoom 0.5 stays covered), tint + flash rects, depths 99988–99991 (game max elsewhere is 9000).

**Sync trick:** storms are derived from wall-clock time — 10-min slots, `(slot*2654435761)>>>0 % 4 === 0` opens the slot with a 2.5-min storm — so every client shows identical weather with no server involvement. Reuse this for Halloween (Nov?) / winter themes rather than adding server events.

**Why:** owner wanted "subtle drizzle + full storm every now and then" shared by all players; server-driven weather would add restart-sensitive state for a purely cosmetic effect.

**Owner's season calendar (authoritative, Aug 2026):** rainy Aug 1–Oct 10 · Halloween Oct 10–Nov 4 · Christmas Nov 5–Dec 26 · New Years Dec 27–Jan 15 · Valentine's Jan 16–Feb 16. Only rainy is built; date gate + calendar comment live at the weather init in create().

**Backlog owner asked for (not built):** themed visuals for the other four seasons, plus seasonal RARE store pets with baby→final-form evolution stages + own animations (frog for rainy season was his example).
