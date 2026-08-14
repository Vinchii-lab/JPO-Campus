---
name: JPO Huddle pet race rendering & duel forfeit
description: Why race pet movement must be driven by the server position event rather than the sprite-animation interval, and the ordering constraint for settling a duel on disconnect.
---

## Position updates must not ride the sprite-animation loop

Pet movement on the race track is driven by the server's periodic position
broadcast. Apply `left` for **every** pet in that payload, inside the socket
handler itself.

**Why:** the original client only wrote position from the 130ms sprite-frame
interval, so a pet's horizontal movement was coupled to its sprite rendering.
Every one of these froze a pet on the start line — or, if the loop threw, froze
the *entire field*:
- the action-lock set (a special race event locks a pet out of the loop for
  ~900ms; the lock also suppressed its movement)
- a missing `img`, or missing `_walkN` / `_action` pet assets
- any throw inside the loop body, which kills the remaining iterations for that
  tick and every pet after the failing one

Symptom is distinctive: all pets pinned at the left track bound while the server
log shows the race ran to completion and paid out normally.

**How to apply:** the sprite interval sets frames only. The position handler
owns `left`, iterating the payload's own socket-ID keys (not a cached entrant
array) so the DOM lookup can't drift. Wrap each pet's sprite update in its own
try/catch so one bad entrant can't stall the others.

## Verify the wire before rewriting the client

A headless socket client that authenticates as admin, starts a race, and asserts
positions actually climb above 0 across ticks settles "is this server or client?"
in one run. Note: starting a race requires the socket to be a *logged-in player*
as well as an admin — admin auth alone silently no-ops. Seed an approved row with
a scrypt hash matching the server's stored format, and delete it afterwards.

**Why:** an inferred root cause here was wrong. The server and the event IDs were
provably correct; only the client rendering was at fault. Cheap to check, and it
stops a plausible-but-false theory from shaping the fix.

## Sprite frame swaps must be cache-backed

The 130ms sprite loop swaps `img.src` between frame URLs. Without an explicit
`Cache-Control` on static art, browsers heuristic-cache (10% of file age) — right
after a deploy that's ~seconds, so every swap refetched over the internet:
frozen sprites + a request flood that lagged the whole prod page, while dev
(localhost) looked perfect. Fix is two-sided: serve art with
`public, max-age=86400` and preload each racer's walk/action frames once at
track build.

**How to apply:** any prod-only "lag + frozen animation" report with a healthy
server log should point here first — check response cache headers before
touching the game loop.

## Power-up boosts are real but visually illegible without help

Special-move boosts land as one multi-point jump inside a single position tick
(verified: +3 to +10 pts vs a ~0.4 pt normal crawl). With the 0.14s left
transition — and the teleport effect hiding the sprite during exactly that
window — the jump reads as "nothing happened". Fix: the position handler draws
a fading motion streak from old→new position whenever a single-tick jump
exceeds ~1 pt. Cosmetic only, wrapped in try/catch.

**Measurement trap:** the server emits racePositions BEFORE raceEvent in the
same tick, so "position at event time" already contains the boost. To measure a
boost from the wire, diff successive position ticks — don't anchor on the event.

## Bet payouts: settle by email, idempotent ledger, notify only after commit

Race bets are keyed by the bettor's socket id; a mid-race refresh kills that id,
so payouts must credit by the EMAIL captured at bet time, not `players[sid]`.
Retrying a failed payout transaction is mandatory (prod has transient DB blips)
but naive retries double-pay on an ambiguous COMMIT — each credit must first
claim a (settlement-id, email) row in an idempotency ledger table inside the
same transaction (`ON CONFLICT DO NOTHING`; skip credit when the claim loses).
Cache updates and coin/payout notifications must happen only AFTER a confirmed
commit, never inside the transaction. NB: the server is ESM — no `require()`;
use `globalThis.crypto.randomUUID()`.

**Test recipe:** isolated instance on a spare PORT (no bots), two seeded racers
+ one bettor who bets on a pet then disconnects; a win must restore the
bettor's DB balance exactly. Lobby entrants arrive via `raceEntrantUpdate`
(not `raceLobby`, which fires once with an empty list); races need ≥2 pets.

## Duel forfeit on disconnect

Settle the duel *before* removing the leaver from the players map — the shared
coin-transfer helper reads both sides out of it. Claim the race synchronously
(take a local reference, null the shared slot) before any await, so a second
disconnect or a pending tick can't settle it twice, and clear the join,
countdown, and tick timers in the same step.
