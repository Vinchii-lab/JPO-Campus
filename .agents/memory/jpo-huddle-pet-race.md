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

## Duel forfeit on disconnect

Settle the duel *before* removing the leaver from the players map — the shared
coin-transfer helper reads both sides out of it. Claim the race synchronously
(take a local reference, null the shared slot) before any await, so a second
disconnect or a pending tick can't settle it twice, and clear the join,
countdown, and tick timers in the same step.
