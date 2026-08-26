---
name: JPO Huddle Bingo roles and restart identity
description: Durable role and game-identity rules for Office Bingo hosts, players, and spectators.
---

Starting Bingo makes that person the host/spectator, not a player. Only an explicit Join action deals them a card. Other authenticated admins remain read-only spectators and must not inherit the starter's controls.

**Why:** the owner may start auto-calling only to let coworkers play. Separately, process-local numeric game IDs can repeat after a server restart; a surviving browser then mistakes a new game for its old one and displays a stale card even though the server's player list correctly excludes the host.

**How to apply:** keep hosting and player enrollment as separate server-authorized roles. Any in-memory Bingo game ID sent to long-lived clients must be unique across server boots, not only monotonic within one process.

The Bingo announcer is an optional performance layer, never part of the draw path. A late or failed clip must not delay a number, daub, claim, or payout. Audio goes only to accounts that explicitly joined, while mute stays local to each browser and defaults on for new players.

**Why:** coworkers play multiple Blackout rounds per day, so fixed scripts become stale, but generative voice can be slow or unavailable and must never damage the game. Nonparticipants may be working and should not hear or receive the performance.

**How to apply:** keep authoritative game state independent from generated media, preserve joined-only delivery, and use the Join click as the browser audio-unlock gesture.

The announcer uses the bright Coral voice and a commentary schedule: every ball is clear, most stay under 3 seconds, and a longer joke appears every 4–7 calls plus special-number moments.

**Why:** rigid content ratios lost the original caller rhythm. The desired flow mixes brief calls, Pinoy number memes (69, 18, 75, “trenta na”), escalating Blackout drama, and immediate claim/win reactions.

**How to apply:** schedule commentary 4–7 calls apart, let special numbers override it, grow more dramatic after 40 Blackout calls, and keep false-claim/winner reactions separate from the draw path.

Joined players may be roasted by display name only about their visibly equipped game-avatar gear. Never roast or infer real-life appearance, and never reuse a personalized clip in another game.

**Why:** avatar outfit mismatches are the desired personalized comedy, but real-person appearance and cross-game named audio would cross the line.

**How to apply:** provide only visible gear labels for current joined players; exclude emails and private card state, and keep personalized clips game-scoped.

The server-controlled Bingo practice bot may fill the second seat in an admin-hosted round and mark valid calls, but it must never claim, win, or receive coins.

**Why:** the host needs to test the announcer with one browser without creating a second account, while the bot must not affect the economy or beat a human player.

**How to apply:** treat the bot as an ephemeral non-account participant and exclude it from every claim and payout path.