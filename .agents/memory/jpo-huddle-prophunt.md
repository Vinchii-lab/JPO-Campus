---
name: JPO Huddle Prop Hunt / hidden-player rounds
description: Secrecy rules for any round where one player's position must stay hidden (Prop Hunt pattern)
---

Prop Hunt (Hide & Seek): admin hides as furniture; joiners gather at hider's start spot, hunt at locked zoom, close-range E (`phGuess`) wins.

**Rule: hiding a sprite client-side is NOT secrecy.** For any hidden-player round, the server must stop *every* position-bearing payload:
- Suppress the hider's `playerMoved` broadcasts (and freeze phases server-side via early-return in `playerMove`).
- **Mask full snapshots**: every `currentPlayers` emit (join, restorePlayer, approve) goes through `phMaskedPlayers(forId)` which replaces the hider's x/y with the public gather spot. A vanish event after the snapshot is presentation only — modified clients keep the payload.
- Block the hider's `useItem` (confetti/fireworks/group treats emit `groupEffect` at exact x/y) and `interact` (object effects render beside them).

**Why:** the anti-cheat promise is "the server never shares the position", so every emit path counts, not just the movement stream.

Other durable bits:
- Mutual exclusion needed in *all* directions: phStart refuses during After Dark, AND `roundStart`/`adminBingoStart` refuse during propHunt.
- Refresh recovery: seekers are socket-id keyed; instead of rebinding, `phJoin` is allowed mid-hunt (re-invite sent in the join block) — latecomers + refreshed seekers both handled by one path.
- Client cleanup: socket `disconnect` handler must call the round's reset (`window._phReset`) or a server restart leaves players frozen/zoom-locked with a ghost prop.
- Reused `_roundGhostVis(id, visible)` (After Dark ghost helper) for vanish/unvanish.
- Confirmed prop textures: `water_cooler_obj` (image, ox .5), `punch_bag_idle` f0 (art in LEFT 16px → ox .25), `anim_treadmill` f0. `fridge_ss`/`vending_ss` do NOT exist.
- Test seeding: hand-picked x/y often lands on unpainted tiles and playerMove gets silently void-rejected — seed at (1,1) and let void-rescue respawn at GRASS_SPAWN, read real coords from the `approved` payload. Server sends first names in round payloads.
