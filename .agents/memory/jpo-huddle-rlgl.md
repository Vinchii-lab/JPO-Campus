---
name: JPO Huddle Red Light Green Light
description: Design decisions for the RLGL doll game — red-light detection rides playerMove, replay-until-survivor, finisher-survives-refresh, arena choice.
---

# Red Light Green Light (RLGL)

## Detection rides the validated move pipeline
`rlglOnMove(id, prevX, prevY, x, y, now)` is called in the `playerMove` handler ONLY after the move passed all
existing anti-cheat validation (speed budget, paint check). **Why:** rejected/junk moves can't trigger
false red-light eliminations, and there is no second movement-tracking system to keep in sync.
Eliminated runners are frozen server-side via `rlglFrozen(socket.id)` right next to the `phFrozen` check.
A 700ms grace after each red flip forgives in-flight moves (client latency), epsilon 10px ignores jitter.

## Replay-until-survivor + limbo state
If an attempt ends with zero finishers, `rlglReplay` fires and the game restarts 4s later with everyone revived
(Vince's rule: "same game until someone survives"). Between attempts state is `joining` **with `replayTimer` set** —
that flag distinguishes replay-limbo from the original lobby (no lobby UI refresh, cancel if <2 members remain).
`rlglStartAttempt` clears `replayTimer` to null.

## Leaves: refresh = out, EXCEPT finishers
`rlglHandleLeave` at the same 4 seams as `roundHandleLeave` (purge, dropLiveByEmail, kick, disconnect). Active
runner leaving = eliminated cause "left" (no grace — disconnect-dodge loses). **But a member with
`finished && alive && email` is KEPT** so a network blip after crossing the line doesn't void the prize — payout
is an email-keyed additive UPDATE (After Dark offline-winner pattern), pays even if never reconnected. Safe
because replays only happen with ZERO finishers, so a kept dead-socket finisher is never revived onto the field.

## Other rules
- Mutual exclusion both ways with Bingo / After Dark / Prop Hunt / Deal (checks in every starter).
- Push: server-authoritative (`rlglPush` range 70px, cooldown 5s, displacement 130px clamped to arena). Push
  during red past grace = victim eliminated, credited to pusher; push across finish during green = victim finishes.
- Slippery floor at ≤3 runners (only if >3 members): client-only velocity-lerp glide, stays under walk speed → server-safe.
- Arena: open floor tiles 93–130 × 44–56 of JPO_HQ.tmj (verified clear); constants RLGL_ARENA/START_X/FINISH_X/DOLL.
- Reconnect resync lives beside the bingoOver/dealOver resync: emits lobby/`rlglBegin` snapshot (spectator) or `rlglOver`.
- Test envs: `RLGL_MIN_PLAYERS`, `RLGL_JOIN_MS`; e2e via isolated `PORT=20999 ADMIN_PASSWORD=... node server.js` + 4 socket.io bots.
- Client: F key = shove (shared with Prop Hunt find, gated on game state); doll sprites `rlgl_doll_back/front.png`; all
  RLGL DOM built from JS (no static markup); fallen sprites = angle 90 + gray tint, restored on every teardown path.
