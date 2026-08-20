---
name: JPO Huddle Bingo roles and restart identity
description: Durable role and game-identity rules for Office Bingo hosts, players, and spectators.
---

Starting Bingo makes that person the host/spectator, not a player. Only an explicit Join action deals them a card. Other authenticated admins remain read-only spectators and must not inherit the starter's controls.

**Why:** the owner may start auto-calling only to let coworkers play. Separately, process-local numeric game IDs can repeat after a server restart; a surviving browser then mistakes a new game for its old one and displays a stale card even though the server's player list correctly excludes the host.

**How to apply:** keep hosting and player enrollment as separate server-authorized roles. Any in-memory Bingo game ID sent to long-lived clients must be unique across server boots, not only monotonic within one process.