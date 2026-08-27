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

The announcer uses Coral, reads numbers in English, and pronounces the O column as the English word “Oh” while displaying “O.” Draw commentary uses server-curated, BPO-focused, kanto-punchy Taglish; Coral performs the exact line rather than inventing jokes.

**Why:** generated number puns became long, confusing, and unnatural (“translated” or random associations). The user prefers fewer jokes over any line that needs explaining.

**How to apply:** keep most calls to the ball only; every 4–7 calls add one clear micro-aside, with no number pun, mini-story, translation, or second punchline. Reject any audio transcript that rewrites the curated line.

The owner-host may privately preview the already-shuffled next ball during manual Bingo and prepare commentary for that ball. The server adds and locks the ball call; the owner types only the words after it.

**Why:** owner-written lines are more authentic to the team than generated humor, but free-form full calls could announce the wrong ball or drift when the pool advances.

**How to apply:** keep previews owner/host-only, bind each prepared line to the exact next pool value, use it once, accept a matching ball prefix, and block a manual draw while that prepared line is not ready so it cannot be silently skipped.

Owner-authored lines may deliberately use fake-result language such as “May tumama na” for pranks; automatic/generated lines must still reject any unverified winner claim.

**Why:** the owner asked for hidden prank control, while AI-authored fake results would misrepresent authoritative game state.

**How to apply:** relax only the result-word check for exact owner-provided commentary; continue validating the locked ball, rejecting rewritten text, and keeping automated draw lines under the strict result guard.

Live office Bingo uses real joined players only. Bingo Bot is disabled by default and may exist only behind an explicit test-only opt-in.

**Why:** including the practice bot in real games inflated the participant count and made a live office event look inauthentic.

**How to apply:** never let the bot auto-join normal games or satisfy the minimum-player requirement; keep any bot usage isolated to deliberate testing.

Bingo host authority must survive a socket reconnect during the join countdown. Capture whether the starter was the owner in the game state and restore host UI/permissions by the authenticated player email.

**Why:** admin/owner sets are socket-scoped; a brief disconnect otherwise leaves the same joined account playing without host controls even though the game still identifies that email as its host.

**How to apply:** send host flags with card resync, re-send the private next-ball preview to a reconnecting owner-host, and authorize ongoing host actions from the game’s captured host identity rather than the original socket ID.

Announcer Tagalog must sound conversational rather than translated or formal. Repeated false claims are tracked per player and may trigger a named “tantanan mo / huwag atat / bukas ka na tatama” callout with a short laugh.

**Why:** phrases such as “confidence lang ang kumpleto” sounded unnatural; “confidence lang ang baon” and direct barkada teasing better match the desired Filipino radio-DJ energy.

**How to apply:** use everyday idioms and occasional real laughter, avoid English calques, and escalate from a generic first false-claim reaction to a named repeat-offender roast.

Joined players may be roasted by display name only about their visibly equipped game-avatar gear. Never roast or infer real-life appearance, and never reuse a personalized clip in another game.

**Why:** avatar outfit mismatches are the desired personalized comedy, but real-person appearance and cross-game named audio would cross the line.

**How to apply:** provide only visible gear labels for current joined players; exclude emails and private card state, and keep personalized clips game-scoped.

The server-controlled Bingo practice bot may fill the second seat in an admin-hosted round and mark valid calls, but it must never claim, win, or receive coins.

**Why:** the host needs to test the announcer with one browser without creating a second account, while the bot must not affect the economy or beat a human player.

**How to apply:** treat the bot as an ephemeral non-account participant and exclude it from every claim and payout path.

Announcer proximity is presentation-only and must come from the authoritative shuffled call prefix projected through the candidate prefetched ball. Only announce new one/two-uncalled-number transitions; exclude the bot, never expose the missing number, and never turn zero uncalled numbers into a claim instruction.

**Why:** prefetch runs ahead of the visible draw, while manual daubs can lag called numbers. Treating “all card numbers called” as a verified claim can prompt a false Bingo, and exposing the needed number leaks private card state.

**How to apply:** compare missing counts before/after the candidate ball for each current human card, phrase the result as uncalled-card-number proximity, and leave all winner declarations to the paid valid-claim path.

Generated speech and all player context must stay within the current game. Prior winners, player names, and personalized lines must never carry into a later game; important claim reactions take priority over optional future-call speech.

**Why:** cross-game context can expose a coworker to unrelated participants or the AI provider, while unsafe generated speech can misstate authoritative game truth.

**How to apply:** provide only current-game context, fail closed on absent or contradictory transcripts, and never let speculative draw narration outrank a verified claim or payout reaction.