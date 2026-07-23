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
- Do NOT teleport the sprite (`body.reset`) across the map to skip walking:
  the server's movement validation silently rejects the impossible jump, its
  position stays at the restored spawn, and `interact` fails with "Walk a
  little closer" even though the client shows the prompt. Walk legitimately —
  EXCEPT small hops: after idling, a teleport within one move budget
  (~55–300px, e.g. `player.body.reset(1320, 820)` from spawn onto the chair
  tile next door) IS accepted server-side and is the fastest way to reach an
  adjacent interactable.
- Naive greedy arrow-walking gets stuck on furniture. BFS-pathfind in
  `page.evaluate`: find TilemapLayers via
  `scene.children.list.filter(o => o.type === 'TilemapLayer')`, identify by
  `l.layer.name` ('Wall'/'Furniture'), a tile is solid iff
  `data[r][c].index > 0 && .collides`; player tile =
  `floor(x/48), floor((y+27)/48)` (feet offset); waypoint world px =
  `c*48+24, r*48+24-27`. Compress straight runs, then hold the arrow key
  ~(dist/220)*1000 ms per waypoint. Works first try.

# Seeding x/y does NOT position a BROWSER test player — micro-hop walk instead

The real client always spawns at the default spawn point and its FIRST
`playerMove` re-baselines the server (bounds-only check), overwriting any
seeded DB coords — so "seed the row next to the object" only works for
HEADLESS socket tests (no client, restored p.x/p.y stands). In puppeteer the
avatar is at spawn regardless of the seed, and a later long teleport is
rejected server-side.

**How to apply:** for far-away objects, drive a micro-hop loop from node
(`p.body.reset` toward the target, ≤43px per step, ~360ms apart — ~14s per
1700px); each hop is inside the move budget so the server accepts it, and the
E-hint/interact both work on arrival. Straight-line is fine (server checks
distance/bounds, not walls).

# Sitting a test player: stand ON/next to the chair tile first

The interact scan keys off the FEET tile (`floor(x/48), floor((y+27)/48)`) and
the spawn tile is NOT adjacent to any chair — pressing E at spawn silently does
nothing. Small-hop `body.reset` onto a chair tile (see above), wait ~800ms so a
`playerMove` lands, then `page.keyboard.press('KeyE')` sits reliably (puppeteer
key delivery verified via `keyE.isDown` while held). Gotcha: `eHint.text` keeps
its last/default string while hidden — detect an available interaction with
`eHint.visible`, never the text. `_gameScene`, `_playerCoins`, `tryRegister()`,
`tryLogin()` are reachable from `page.evaluate`; the socket itself is not
(top-level `const`).

# Verify sprite layering with a TIGHT viewport, not a wide screenshot

A wide (1280px) screenshot made a buried avatar look "fine": a seat-occluder
that redrew a chair's own front tile over the sitter hid the whole body behind
the backrest, and it shipped — a real user's zoomed screenshot caught it.

**Rule:** when judging player-vs-furniture layering, capture with a small
viewport (~520×360, camera-follow zooms the subject) or crop tight around the
avatar; explicitly ask "is the BODY in front of the chair back?" — a floating
head can pass a casual glance. For down-facing seats, redrawing the chair's own
tile over the sitter is almost always wrong (only up-pinned seats do that).

# First-run tour modal blocks screenshots — Skip it before capturing

A first-time player gets a multi-step welcome tour modal overlaying the whole
canvas right after entering the office. Assertion-only tests pass through it,
but any screenshot capture shows the modal instead of the game.

**How to apply:** after `body.playing`, click the visible "Skip" button from
`page.evaluate` (iterate buttons, match trimmed text, check `offsetParent`)
before taking screenshots. Also note: headless nix Chromium has no emoji font —
emoji game objects (💤 💨) render as hollow boxes in screenshots; verify emoji
presence via object/text assertions, judge only position/animation visually.

# Tuning visual offsets: sweep values live via the scene's def object, don't guess

Static geometry notes (e.g. "eyes ≈ y−12") can be wrong when the overlay art has
its own in-frame padding — the shades wearable needed dy=8, not −12, and two
blind guesses both looked "in the hair" in screenshots.

**How to apply:** the running scene exposes the live def object
(`window._gameScene.localCosmeticDef` etc.), so from `page.evaluate` mutate the
offset in a loop over ~5 candidate values, screenshot each (tight clip around
the avatar), stitch a comparison strip with PIL, and pick visually. One run
replaces N guess-edit-restart cycles; then hardcode the winner in the source.

# Before committing: check for unrelated opengraph.jpg drift

`public/opengraph.jpg` has twice shown up as an unexplained few-byte
working-tree change after dev-server runs. Restore it before committing
(`git show HEAD:artifacts/jpo-huddle/public/opengraph.jpg > <same path>`) to
keep commits focused.

# Real users may be online during e2e — never assert global world state

The dev server is live for the actual JPO team; a real player can be walking
around (and using the feature under test!) while your two-browser run executes.
An assertion like "NO other player has X" can fail legitimately.

**Rule:** scope every observer-side assertion to the specific test player's
socket id (`await pageA.evaluate(() => socket.id)`, then check
`otherPlayers[aid]` on B) — never scan all of `otherPlayers` for presence or
absence of something.

# Two-player puppeteer runs need isolated incognito contexts, not two pages

Two `browser.newPage()` tabs share one profile → shared `localStorage`. Player
A's resume token auto-resumes on B's fresh tab (tearing down the join form
mid-test, and one-session-per-email drops A), producing a confusing
"getElementById(...) is null" failure on the SECOND page only.

**How to apply:** give each simulated player its own
`browser.createIncognitoBrowserContext()` and open the page from that context.

# Backgrounded test runs get reaped — run foreground with a timeout

`nohup … &` AND `setsid nohup … & disown` both died silently (empty log, no
process) when the bash tool session ended — the sandbox reaps them despite the
earlier note that nohup worked. A full 2-browser cosmetics run fits in ~60s.

**How to apply:** prefer foreground `timeout 110 node test.cjs` (under the
2-min shell cap); only if a run truly exceeds that, split the test into
phases that each fit foreground.

- Headless Chromium has no emoji fonts — emoji text objects (pets, brew ☕, E-hint) render as □ boxes in screenshots. Verify emoji features NUMERICALLY (positions, depths, children-list counts via page.evaluate), only use screenshots for sprite/tile art.
- Top-level `const` tables in the classic (non-module) client script (PET_EMOJI, DIR_START, …) are reachable from page.evaluate — no window. prefix needed.

## Remote-parity tests need server-ACCEPTED movement
`body.reset` teleports render locally but the server anti-cheat silently REJECTS the move for broadcast — a second client never sees the avatar move. For any two-client parity test, move via micro-hops (≤45px per step, ~350ms apart, straight line is fine — server checks distance/bounds, not walls). Single-client visual tests can still teleport freely.
