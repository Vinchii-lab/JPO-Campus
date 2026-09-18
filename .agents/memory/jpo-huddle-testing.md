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

**Gotcha (July 2026):** a seeded `approved=true` row still showed up as
"Pending" once — the seed was lost between the psql seed and the register
(the same interruption also wiped /tmp mid-session). No server code path
flips `approved` on register (the TOFU claim only sets `password_hash`).
**How to apply:** if a seeded player lands in the pending queue, don't debug
the game — re-run `UPDATE jpo_players SET approved=true, dismissed=false
WHERE email='…'` and register again (the row now has the claimed password,
which still verifies). Cheap to check: `SELECT approved` right before the
browser run.

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
  (~55–300px) IS accepted server-side and is the fastest way to reach an
  adjacent interactable. Never hardcode hop coords (the old 1320,820 "chair
  next to spawn" died with the map swap) — find targets live instead.
- Naive greedy arrow-walking gets stuck on furniture. BFS-pathfind in
  `page.evaluate`: find TilemapLayers via
  `scene.children.list.filter(o => o.type === 'TilemapLayer')`, identify by
  `l.layer.name` ('Wall'/'Furniture' — AND 'Floor': the dark band at row 97
  is solid floor art, gid 1237), a tile is solid iff
  `data[r][c].index > 0 && .collides`; player tile =
  `floor(x/48), floor((y+27)/48)` (feet offset); waypoint world px =
  `c*48+24, r*48+24-27`. Compress straight runs, then hold the arrow key
  ~(dist/220)*1000 ms per waypoint. Works first try.

# Seeding x/y DOES position a BROWSER test player now (since the July 2026 seated-restore fix)

The `approved` payload carries the restored x/y and the client spawns there
(fallback to SPAWN only when coords are absent/non-finite), and the FIRST
`playerMove` is a bounds-only baseline — so seeding the row's x/y next to the
test object works for BOTH headless socket tests AND puppeteer browser runs
(verified July 2026: a browser client seeded at the Gym spawned at the Gym).
An older note here claimed browser clients always spawn at default spawn —
that was true before the restore fix and is now stale.

**How to apply:** seed `x`/`y` in the same INSERT/UPDATE as `approved`; if the
avatar still needs fine positioning after load, micro-hop (`p.body.reset`
≤43px per step, ~360ms apart — each hop fits the move budget). Long teleports
are still rejected server-side.

# Sitting a test player: stand ON/next to the chair tile first

The interact scan keys off the FEET tile (`floor(x/48), floor((y+27)/48)`) and
the spawn tile is NOT adjacent to any chair — pressing E at spawn silently does
nothing. Find the nearest seat LIVE in `page.evaluate`: scan the furniture
layer and keep tiles where `_gameScene.isFurnSeat(tile.index, c, r)` is true
(world px = `c*48+24, r*48+24-27`), micro-hop there (≤42px per ~360ms step),
wait ~800ms so a `playerMove` lands, then `page.keyboard.press('KeyE')` sits
reliably (verify via `player.anims.currentAnim.key` containing `sit`) (puppeteer
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

## Invisible-chair class of bug
The Wall layer renders over Furniture, so a seat gid on a cell covered by solid Wall art is invisible but still seatable — the sitter gets buried and users report it as "sitting broken". When a sit-bug report doesn't match known seat tables, dump all three layers at the player's stored DB position (x/48, (y+27)/48) first; the real fixture there may not be what the screenshot suggests.

## Socket-level resume tests pass where a REAL reload fails — always test the actual reload
A headless socket.io client can disconnect+resume in ~2s, but a real browser
reload gates `resumeSession` on the full Phaser scene boot (map + tilesets), which
in multi-page headless runs exceeds the 10s session grace. A grace/resume feature
"proven" by a socket test alone can still be broken for every real refresh.
**How to apply:** for any grace-window/resume feature, add a puppeteer
`page.reload()` mid-flow test alongside the socket test; watch the server log
order (`left (grace expired)` before `Resumed:` = the reload lost the race).

## Border-clamp tests need collider-free border rows
On the west map border, row 47 has a real wall collider that stops a walker
before any void clamp can act — a clamp test there passes vacuously. Rows 52-58
are clean grass(col2)/void(col1) rows where only the clamp can stop the walk.
**How to apply:** before testing an edge-containment change, scan the target
rows for Wall-layer tiles and pick a row where nothing else blocks movement.

## Multi-page Phaser runs are ~10x throttled — scale walk budgets, latch in-page
Three Phaser WebGL games in ONE headless Chromium run each game loop at ~1/10
wall speed (CPU contention; `bringToFront` does NOT fix it — it's not tab
throttling). Symptom looks exactly like a game bug: an avatar with vy=-253
"freezes" after covering only 0.4s of simulated distance in 2.5s of wall time.
**How to apply:** (1) diagnose with an in-page recorder — if `performance.now()`
gaps between fixed-interval samples are ~10x the requested interval, it's loop
throttle, not game code; (2) multiply every held-key walk budget by ~10x for
3-page runs; (3) detect transient states (e.g. crossing a 1-tile wall band)
with an in-page `setInterval` latch (`window.__hit = true`), never by polling
`page.evaluate` from Node — evaluate round-trips miss sub-second windows.
Single-page runs are full speed (that's why a solo diag can pass while the
3-player run fails on the identical code path).

## Puppeteer ↔ pinned chromium version lock (updated Aug 2026)
The old chromium-114 nix path no longer has a usable binary. Working pairing:
`puppeteer-core@21` + `/nix/store/m7qi78k6711fpwnrm4r2kn4p3ga3jal9-ungoogled-chromium-123.0.6312.105/bin/chromium`.
General rule: match puppeteer-core major to the chromium major era; a mismatch
doesn't error, it TIMES OUT on launch/goto, which looks like an app bug.
Gotcha: the /tmp harness scripts read `process.env.URL` — an unset URL surfaces
as `Protocol error (Page.navigate): Invalid parameters ... deserialize
params.url`, not a clear "missing URL". Export `URL="https://$REPLIT_DEV_DOMAIN/"`.

## /tmp test deps are fragile
- `npm install <pkg> --no-save` in /tmp PRUNES the other throwaway deps (installing socket.io-client deleted puppeteer-core). Reinstall pinned `puppeteer-core@21` (pairs with the nix chromium 123 binary above) if launches fail/hang after any /tmp npm churn.
- Back-to-back headless logins with the SAME seeded email trip the server's one-live-session-per-email drop (socket shows connected:false) — use a fresh email per run or wait out the grace period.
- Puppeteer `page.keyboard.press` sometimes never reaches Phaser Key objects headless even when arrows work; dispatch an in-page `new KeyboardEvent('keydown', {keyCode…})` on `window` instead to test key-bound features.

## Distinguish a failed test route from an inaccessible interaction

Prove reachability using the full player collision body before treating a stopped
test character as a broken doorway or furniture interaction.

**Why:** Real keyboard tests falsely reported the garden gate, showroom cashier,
and bed as inaccessible. The routes crossed hedges or neighboring furniture;
host-side key-release polling also overshot turns under browser load.

**How to apply:** Keep sprite, feet, server blocker, and Arcade body coordinate
conventions explicit. Route around the entire body footprint and record actual
input/position progression when a turn fails. Frame-bound key release passed a
timing double but still failed in a real browser; it is not a proven general fix.
Require actual portal/action acknowledgement at the destination. A failed
hardcoded waypoint alone is not a product bug.
