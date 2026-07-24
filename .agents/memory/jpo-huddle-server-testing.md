---
name: JPO Huddle server integration testing
description: How to verify the jpo-huddle socket.io game server end-to-end without a browser
---

The jpo-huddle server (`artifacts/jpo-huddle/server.js`) is a socket.io server — you
cannot verify its real behaviour with `curl`. To integration-test it headlessly:

- Install `socket.io-client` in a throwaway dir **outside** the workspace (e.g.
  `/tmp/jpotest`, `npm init -y` + `npm install socket.io-client`) so you don't
  pollute workspace deps, then run a Node ESM script there.
- Connect directly to the server's assigned port (`http://localhost:$PORT` — read
  the actual port from the jpo-huddle workflow logs; it's stable across restarts
  for a given artifact). `io(URL, { transports:["websocket"] })`.
- The admin flow needs `ADMIN_PASSWORD`; the script inherits it from
  `process.env` when run via bash, so you can authenticate without ever printing
  the secret value.
- Full persistence loop worth re-running after server changes: admin `adminAuth` →
  player `register` → read admin `pendingList` for the target socket id →
  `approvePlayer` → `buyCosmetic` → `postAnnouncement`, then **restart the
  workflow** and reconnect with the same email to confirm the player is auto-restored
  (approved, coins, cosmetics, announcer status, announcements all survive).
- Auth-era additions to the loop: `register` now needs a `password` (min 6) and
  optionally `nickname`; failures come back as `authFailed`/`loginFailed`
  `{message}` events, success is `approved`. Two test traps:
  1. The per-email limiter counts SUCCESSFUL auths too (5/30s) — a multi-step
     test reusing one email must sleep ~31s mid-run or it locks itself out and
     misreads the lockout as a bug.
  2. Tests are not idempotent: a leftover approved row makes the next
     `register` restore instead of emitting `registrationPending`. DELETE the
     test row before AND after each run (use `pg` from the artifact's own
     node_modules — the workspace root and /tmp both lack it).

**Why:** this loop is the only way to catch regressions in the DB-as-source-of-truth
wiring; unit-level checks miss the socket payload shapes the un-editable client depends on.

Additional traps learned while testing RPS challenges:
- **Attach `once()` listeners BEFORE awaiting any other event.** The server often
  emits to two sockets back-to-back (e.g. incoming-to-target before echo-to-sender);
  if you `await` the first, the second arrives while nobody listens and is lost.
  Create all the promises first, then emit, then await.
- Fresh players start with **50 coins** (DB default) — an "insufficient coins" test
  must wager above that. To test funded wagers, disconnect (final flush lands),
  `UPDATE jpo_players SET coins=…`, then re-login so restore re-reads the DB.
- Per-socket action buckets (e.g. the RPS challenge bucket, 3 tokens / +1 per 2s)
  are consumed BEFORE validation, so even rejected emits burn tokens — pace test
  blocks with ~2.1s sleeps per extra emit or bursts misread as rate-limit bugs.
- Assertions on coins need tick slack: the +2/min coin tick can land mid-test, so
  assert `n >= base && (n - base) % 2 === 0` with a small cap, not exact equality.
- Movement-budget assertions: the FIRST playerMove after approve is a bounds-only
  baseline (free teleport — use it to place the player, e.g. onto grass). After an
  idle, the per-move budget caps at `MOVE_SPEED · (cap 1.5s) · 1.6 + 12` px — pick a
  jump distance between the normal and boosted caps (e.g. 430px for ×1.4 coffee:
  normal max 372, boosted max 516) to prove a speed change both ways. Rejected moves
  are SILENT drops — assert via a second observer socket that a matching
  `playerMoved` broadcast does/doesn't arrive within a timeout, never via an error event.
- To test proximity-gated `interact` objects headlessly, seed the approved row's x/y AT the object anchor before registering — restore places the server-side position there, so no movement (and no move-budget fight) is needed at all.
- Rerunning a test within ~10s of the previous run's exit hits the disconnect GRACE window: re-registering the same email resumes the OLD in-memory session (stale position — DELETE+reseed doesn't help, it's not a DB read). Sleep ≥12s between runs or use fresh emails.
- Real-time interval games (e.g. Ping Pong ~30Hz `pongState`): don't try to win rallies with timing — park both paddles at opposite extremes via a 100ms `pongPaddle` drip so every serve scores; a first-to-5 match then settles in ~15-25s, well inside the 115s foreground budget.
