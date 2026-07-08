---
name: JPO Huddle in-office testing
description: How to reach the "playing"/in-office state in e2e tests or DB seeding without admin approval, plus the mobile-controls QA override.
---

# Reaching the in-office ("playing") state without admin approval

To e2e-test or manually preview any feature that only exists after a player is
approved (movement, chat, shop, touch controls), you do NOT need the admin
password flow. An already-approved email auto-restores straight into the office
on register (`restorePlayer`). So seed the DB first, then register with that email.

**Rule:** the seed row's `email` PK MUST be lowercased.

**Why:** the `register` handler lowercases the email (identity key) before the
upsert/lookup. A mixed-case seed PK won't match the lowercased identity, so the
server creates a fresh `approved=false` row and you get stuck on the
"Waiting for admin approval…" pending screen. (Cost one wasted test run.)

**How to apply (test [DB] step or manual seed):**
```sql
INSERT INTO jpo_players (email, first_name, last_name, name, character, approved)
VALUES (LOWER('touchtest-<rand>@justpressone.com'), 'Touch', 'Tester', 'Touch Tester', 'adam', true)
ON CONFLICT (email) DO UPDATE SET approved = true;
```
Then register in the browser with the same email (case doesn't matter on input —
the server lowercases it). `upsertPlayerProfile` never overwrites `approved`, so
the seeded approval sticks. No email-domain validation server-side.

# Coins drift during long e2e runs (don't assert exact coin totals)

Approved players earn **+2 coins/minute** on a server tick. Any e2e test that
takes ~a minute or more (e.g. multi-context resume/grace tests) can see a seeded
coin balance increment (e.g. 30 → 32) legitimately mid-run.

**Rule:** never assert an exact coin count in a long-running test; assert `>=` the
seeded value (or that it's numeric) instead. A strict equality check will report a
false-negative "bug" that is really just the coin tick — and actually confirms
persistence rather than breaking it.

# Mobile touch-controls QA override

The on-screen mobile controls are gated behind `body.touch-device.playing`, and
`touch-device` is only added when `matchMedia('(pointer: coarse)')` matches — so a
normal headless/desktop browser won't show them. Append `?touch=1` to force
`touch-device` on for verification on non-touch browsers.

# When the e2e harness can't deliver a single keypress (E), drive puppeteer yourself

The black-box browser-test harness sometimes fails to deliver a single
keypress (E) to Phaser's `JustDown` even when HELD arrow keys walk fine —
three runs "pressed E, nothing happened" while a self-driven browser proved
the game code correct on the first try. Absence of a debug log after a
harness keypress is evidence about the HARNESS, not the game.

**How to apply:** when a key-press-dependent e2e fails but held-key movement
works, stop debugging game code and drive a browser directly:
- `puppeteer-core` (npm i in /tmp) + a nix-store `ungoogled-chromium` binary
  (`ls /nix/store | grep ungoogled-chromium`, pick newest, `bin/chromium`,
  launch args `--no-sandbox --disable-gpu`).
- **Pin `puppeteer-core@20`** for the nix Chromium 114 — the latest
  puppeteer-core silently times out (30s) on `launch` against that binary
  (protocol handshake mismatch), while v20.x (built for Chrome ~113–115)
  launches first try. Two-browser multiplayer runs work fine; drive UI
  clicks with `el.dispatchEvent(new PointerEvent('pointerdown', …))` in
  `page.evaluate` (the game's handlers listen for pointerdown, not click).
- Background long runs: `nohup node test.cjs > run.log 2>&1 &` then poll —
  a 2-browser register+matches run exceeds a 2-min foreground shell limit.
- `page.goto` MUST use `waitUntil: "domcontentloaded"` — the socket.io
  connection keeps the page from ever reaching `networkidle2` (30s timeout).
- Do NOT teleport the sprite (`body.reset`) to skip walking: the server's
  movement validation silently rejects the impossible jump, its position
  stays at the restored spawn, and `interact` fails with "Walk a little
  closer" even though the client shows the prompt. Walk legitimately.
- Naive greedy arrow-walking gets stuck on furniture. BFS-pathfind in
  `page.evaluate`: find TilemapLayers via
  `scene.children.list.filter(o => o.type === 'TilemapLayer')`, identify by
  `l.layer.name` ('Wall'/'Furniture'), a tile is solid iff
  `data[r][c].index > 0 && .collides`; player tile =
  `floor(x/48), floor((y+27)/48)` (feet offset); waypoint world px =
  `c*48+24, r*48+24-27`. Compress straight runs, then hold the arrow key
  ~(dist/220)*1000 ms per waypoint. Works first try.

# Real users may be online during e2e — never assert global world state

The dev server is live for the actual JPO team; a real player can be walking
around (and using the feature under test!) while your two-browser run executes.
An assertion like "NO other player has X" can fail legitimately.

**Rule:** scope every observer-side assertion to the specific test player's
socket id (`await pageA.evaluate(() => socket.id)`, then check
`otherPlayers[aid]` on B) — never scan all of `otherPlayers` for presence or
absence of something.

# Backgrounded test runs get reaped — run foreground with a timeout

`nohup … &` AND `setsid nohup … & disown` both died silently (empty log, no
process) when the bash tool session ended — the sandbox reaps them despite the
earlier note that nohup worked. A full 2-browser cosmetics run fits in ~60s.

**How to apply:** prefer foreground `timeout 110 node test.cjs` (under the
2-min shell cap); only if a run truly exceeds that, split the test into
phases that each fit foreground.
