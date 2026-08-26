---
name: JPO Huddle Bingo roles and restart identity
description: Durable role and game-identity rules for Office Bingo hosts, players, and spectators.
---

Starting Bingo makes that person the host/spectator, not a player. Only an explicit Join action deals them a card. Other authenticated admins remain read-only spectators and must not inherit the starter's controls.

**Why:** the owner may start auto-calling only to let coworkers play. Separately, process-local numeric game IDs can repeat after a server restart; a surviving browser then mistakes a new game for its old one and displays a stale card even though the server's player list correctly excludes the host.

**How to apply:** keep hosting and player enrollment as separate server-authorized roles. Any in-memory Bingo game ID sent to long-lived clients must be unique across server boots, not only monotonic within one process.

The Bingo announcer is an optional performance layer, never part of the draw path. AI calls are prepared ahead of authoritative draws; a late, failed, oversized, or budget-exhausted clip must not delay a number, daub, claim, or payout. Audio payloads go only to sockets whose account explicitly joined, while the mute preference stays local to each browser and defaults on for new players.

**Why:** coworkers play multiple Blackout rounds per day, so fixed scripts become stale, but generative voice can be slow or unavailable and must never damage the game. Nonparticipants may be working and should not hear or receive the performance.

**How to apply:** keep a bounded rolling prebuffer and generation budget, retain successful exact-number clips as no-cost fallbacks across games, deliver audio through joined-only socket events, and use the Join click as the browser audio-unlock gesture.