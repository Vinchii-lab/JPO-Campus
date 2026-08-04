---
name: JPO Huddle map furniture identification
description: How to safely anchor a new interactive station on JPO_HQ.tmj furniture.
---

# Anchoring stations on map furniture

- Never trust a GID number alone when anchoring a new station: scan `public/assets/JPO_HQ.tmj` for candidate clusters, then **visually confirm** the GID by cropping that tile out of its tileset PNG and viewing the crop. Guessed GIDs regularly turn out to be a different prop (or a desk top reused elsewhere).
- Server proximity is distance-only, so an anchor needn't be walkable — but new client `OFFICE_OBJECTS` entries must go LAST so existing stations keep winning overlap zones (the E-scan is first-match).
- The TMJ's tileset data does not expose `collides` in a directly scannable way, so map-data reachability checks come back empty; sanity-check placement with generous radii near open floor instead.
- New global broadcasts triggered at a fixed station coordinate (bursts, bubbles) must apply the Office After Dark visibility gating — a position-anchored effect leaks a hider/participant location across the round boundary.
