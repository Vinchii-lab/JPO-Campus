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

## Vertical lawn track + phases (owner spec, Aug 2026)
Arena is the WEST LAWN (tiles 12-19 × 16-95, all Ext grass): runners race DOWNWARD (faces visible), doll at the
bottom. Doll art semantics for top-down: green = front view (facing away downhill), red = back view w/ red glow.
Phases escalate by attempt via RLGL_PHASES (CLASSIC → ANGRY DOLL → NARROW PATH halfW strip w/ "path" elimination →
SUDDEN DEATH: narrower + slippery + rlglFake doll twitches, client-only theater). Coin bait scattered per attempt,
claimed server-side from validated positions. Boosts (coffee/pizza) fully banned for active runners: item use,
group-boost receipt, coffee machines, move-budget multiplier, and stripped at attempt start (coffeeBoost
durationMs:1 = client "off" signal — durationMs:0 falls back to the 45s default!).

## Tournament rounds (owner spec, Aug 2026)
Crossing the line only survives the ROUND. 0 finishers → `rlglReplay`, same field revived. 1 finisher → sole
champion, whole pot. ≥2 finishers → `rlglRound`: non-finishers deleted from members (auto-releases their freeze,
they spectate), survivors race again; each finish bumps `m.safe`. Exactly 2 left with safe ≥ 3 each → co-champions
split. Between attempts state is `joining` **with `replayTimer` set** — that flag distinguishes round/replay-limbo
from the original lobby. `rlglStartAttempt` clears `replayTimer`; 1 member left between rounds = walkover win
(flip state to "running" first — rlglFinish guards against state "ending").

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
