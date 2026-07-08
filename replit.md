# JPO Huddle

A top-down multiplayer virtual office (a Phaser 3 game) for the JustPressOne team: people walk around as pixel avatars, chat, earn coins, buy cosmetics, and read the announcement board. All game state is now durable in Postgres.

## Run & Operate

- `pnpm --filter @workspace/jpo-huddle run dev` — run the JPO Huddle game server (`node server.js`)
- `pnpm --filter @workspace/api-server run dev` — run the API server (port 5000)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Required env: `DATABASE_URL` — Postgres connection string; `ADMIN_PASSWORD` — gates the in-game admin panel; `SESSION_SECRET` — signs the resume tokens that auto-rejoin returning players (when unset, auto-rejoin is disabled and everyone uses the normal register flow)

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)

## Where things live

- `artifacts/jpo-huddle/server.js` — the whole game server: Express 5 static serving (with cache-busting `BUILD_STAMP`), socket.io event handlers, and all DB reads/writes via a raw `pg` Pool. Plain ES modules, run with `node server.js` (no build step).
- `artifacts/jpo-huddle/public/index.html` — the entire client (~2100 lines of plain JS): Phaser 3 + socket.io loaded from CDN, no bundler. Source of truth for socket event shapes and the `CLOTH_COLORS` palette.
- `lib/db/src/schema/jpoPlayers.ts`, `lib/db/src/schema/jpoAnnouncements.ts` — Drizzle table definitions (source of truth for the DB schema). Re-exported from `lib/db/src/schema/index.ts`. These exist so `drizzle-kit push` and future migrations work; the game server itself talks to Postgres with raw SQL, not Drizzle.

## Architecture decisions

- **DB is the source of truth; the in-memory maps (`players`, `pending`, `admins`) are only a live-connection cache.** Every durable field (coins, cosmetics, approval, announcer status, position, announcements) is read from / written to Postgres.
- **`server.js` uses a raw `pg` Pool, not the Drizzle client.** This keeps the server as plain `node server.js` (no `tsx`/transpile step) while still using the shared `@workspace/db` schema for `push` and future publish-time migrations.
- **Identity key = lowercased email.** `jpo_players.email` is the primary key. Registering an already-approved email auto-restores the player straight into the office (no re-approval). `restorePlayer()` is the single seam for this; the identity gate that decides *who* may restore lives in the `register` handler.
- **Kick = revoke.** Because an approved email auto-restores on next connect, kicking flips `approved` back to `false` (a session-only removal would just let them walk right back in).
- **Coin/position writes are batched to the once-per-minute coin tick** (and a final flush on disconnect), so per-move traffic never hits the DB. Coin awards and purchases use atomic relative SQL (`coins = coins + N ... RETURNING`) so concurrent ticks and buys can't race.
- **One live session per email:** a new connection for an email already online disconnects the older socket (`dropLiveByEmail`).

## Product

- Register with first/last name, an optional nickname (what everyone sees in-game; falls back to first name), a JustPressOne email, and a password (min 6 chars), then pick an avatar (character, hair, skin, shirt, pants). New people wait in a pending queue.
- Returning players use the Sign in card (email + password) — no profile changes, straight back in. Both forms have a "Remember me" checkbox: checked = survives closing the browser, unchecked = this tab session only.
- Admins can clear a forgotten password from the owner panel (works while the person is offline); the person sets a new one on their next Join.
- An admin (unlocked with `ADMIN_PASSWORD`) approves/rejects pending people, kicks (revokes) players, and designates "announcers".
- Approved players walk around a shared office, chat, earn +2 coins/minute, and spend coins in the shop (e.g. a 30-coin crown cosmetic).
- Admins and designated announcers post to the announcement board (scoped to individual board clusters); everyone sees the board.
- All of the above survives server restarts: reconnecting with the same email restores your coins, cosmetics, announcer status, and last position.
- Returning players auto-rejoin: a signed token stored in the browser lets a refresh or reopened tab drop you straight back into the office without re-registering, and a brief disconnect keeps your avatar in place for others during a short grace window.

## User preferences

- _None recorded yet._

## Gotchas

- **Never destructure raw socket payloads in the handler parameter list.** `socket.on("evt", ({ x } = {}) => …)` still throws on an explicit `null` payload — one malicious `emit("evt", null)` crashes the whole server (this was a live DoS until fixed). Every handler takes `(payload)` and destructures from `payload || {}`; keep this pattern for all new socket events.
- **Emote ids in the server `EMOTES` allowlist must match the client `EMOTES` array in `public/index.html`.** The client maps ids to emoji; unknown ids are silently dropped on both sides. Number keys 1–8 map to the client array order. Emote bubbles intentionally reuse the chat-bubble slot (`localBubble` / `entry.chatBubble`) so all existing follow-the-player positioning works unchanged — an emote replaces a showing chat bubble and vice versa.
- **`CLOTH_MAX` in `server.js` must equal `CLOTH_COLORS.length - 1` in `public/index.html`.** It clamps shirt/pants colour indexes; if the client palette grows, bump this or valid choices get rejected.
- **Password auth with a legacy-claim (TOFU) rule.** Accounts have a scrypt password hash (`scrypt:<salt>:<hash>`, hashed async so the event loop never blocks). A row with `password_hash IS NULL` is a legacy passwordless account: the FIRST register with that email claims it by setting a password, atomically (`UPDATE … WHERE password_hash IS NULL RETURNING` — a lost race falls back to verifying against the winner's hash). Same trust level as the old email-only model at claim time, but locked after that. Order matters in `register`/`login`: password verification happens BEFORE any profile mutation or `dropLiveByEmail` so a wrong password can't overwrite a profile or disconnect the real player. Per-EMAIL limiter (5 attempts/30s, module-level `authAttempts`) is checked BEFORE any scrypt call so a flood can't exhaust the libuv threadpool; note it counts SUCCESSFUL auths too, so 5 rapid sign-ins for one email briefly lock it — not a bug. Plaintext password over socket.io is fine — WSS terminates TLS at the proxy.
- **Admin password reset = clear hash + void all tokens.** `adminResetPassword` sets `password_hash = NULL` and `password_set_at = now()`, then drops live sessions for the email. `resumeSession` rejects any token with `iat < password_set_at`, so whoever held the account is fully signed out and can't auto-resume; the account returns to claimable state (next Join sets a new password). This is also why `password_set_at` exists as a separate column — do not repurpose it.
- **Resume tokens & the reconnection grace period are UX continuity, NOT primary auth.** On approval the server issues an HMAC-signed token (via `SESSION_SECRET`) that the browser replays on load to auto-rejoin (no re-registering/re-approval). "Remember me" picks the storage: checked → `localStorage`, unchecked → `sessionStorage` (saving to one clears the other; `_loadToken` checks localStorage first and sets `_rememberMe` from where it found the token). Tokens die on expiry (`TOKEN_MAX_AGE_MS`) or when `iat < password_set_at`. On disconnect an email-backed player is parked in a ~10s grace window (`GRACE_MS` in `server.js`, keyed by `graceByEmail`) so a refresh/blip resumes the SAME session without their avatar vanishing for others; only after it expires do others see them leave. Tokens are cleared client-side on kick/reject so a revoked user can't auto-resume back in.
- **Display name ≠ full name.** `rowToPlayerState` sets `name = nickname || first_name || name` (what nametags/chat/announcements show) and keeps `fullName` for the admin panel (`_playerList` sends both; `_pendingList` sends full name + nickname). Announcements snapshot the author's display name at post time — an accepted tradeoff, old posts keep the old name.
- **Empty-email clients fall back to session-only play** (nothing persists) because email is the PK. The web client always requires a valid email, so this only affects non-standard clients.
- **Don't add a build step to jpo-huddle.** The client is CDN-loaded plain JS and the server is plain ESM by design; `node server.js` must keep working.
- **Server-side rate/movement checks are sanity guards, NOT authoritative simulation.** `server.js` throttles chat/purchase/announcement (token buckets, excess silently dropped — never disconnected) and validates `playerMove` (per-move min interval + map-bounds reject + impossible-jump reject). Two things must stay in sync with the client: (1) movement bounds are derived from `public/assets/Office.tmj` at startup times `RENDER_SCALE`, which MUST equal the client's `setScale(3)`; (2) `MOVE_SPEED` MUST equal the client `SPEED`. Rejections just drop the update (server never rubber-bands the client). The per-move budget is tied closely to walk speed (`MOVE_SPEED · elapsed · MOVE_SPEED_TOLERANCE` + a small `MOVE_JITTER_PX` floor), so a modified client can't chain small hops to move faster than ~walking. The legit ~1-tile seat snap gets its extra `SEAT_SNAP_ALLOWANCE` **only** on a sit↔stand transition (detected via `anim === 'sit'`), cooldown-gated by `SEAT_SNAP_COOLDOWN_MS` so it can't be replayed every frame; out-of-bounds slack is a minimal `MOVE_BOUNDS_EPSILON` (~1 tile), not snap-sized. The FIRST `playerMove` is a bounds-only baseline (the client spawns the avatar at a fixed point that differs from the server's restored coords). Residual: this is not authoritative — a single teleport banked over `MOVE_ELAPSED_CAP_MS` of idling is still possible (bounded to a few tiles); closing that needs authoritative movement (out of scope).
- **Seated poses reuse Adam's geometry for every character.** All non-Adam seated sheets (`{Alex,Amelia,Bob}_sit/sit2/sit3_16x16.png`) are recolours of Adam's seated sheets, so their pixel layout is identical. `_sitZones` (in `public/index.html`) retunes only the Y-bands per direction (`SIT_ANATOMY`, values = the generator's HAIRMAX: right/down hair→y22, up→y17). Regenerating these PNGs must keep HAIRMAX in lockstep with `SIT_ANATOMY`.
- **Seated shirt/pants zones MUST keep `yMin = hairYMax` (do not "optimise" it away).** It is tempting to drop the Y gate for a character whose nominal shirt colour looks far from its hair colour — do NOT. Each zone is a multi-shade family, and a character's darker hair shades can fall inside the shirt threshold (e.g. Alex). Customizing the shirt while leaving hair at default SKIPS the hair pass, so without the gate the un-swapped hair mass gets repainted in the shirt colour. The gate costs only a ~2px shoulder seam (accepted for all seated chars). See the long comment above `_sitZones`.
- **Amelia's seated hair is short (Adam's shape), not her long standing hair.** Accepted scope tradeoff — the seated sheets inherit Adam's silhouette, so her flowing hair does not appear while sitting.

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
