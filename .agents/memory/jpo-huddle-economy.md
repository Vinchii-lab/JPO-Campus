---
name: JPO Huddle economy features
description: Design rules for coin gifting, pet trades, and live admin price overrides
---

**Rules:**
- Live price overrides fold into the in-memory SHOP/PETS/PET_ACCESSORIES maps at boot (from `jpo_shop_prices`), so buy handlers never change. `DEFAULT_PRICES` is snapshotted BEFORE the fold (server and client both) — setting an item back to default deletes the override row. Client catalogs get `priceList` on connect + `priceUpdate` broadcasts; labels stay display-only.
- Coin gifting reuses `rpsSettle` (receiver "wins" from sender) so a partial transfer is impossible. Gifts are blocked when EITHER side is in `rpsBySocket` — the absolute rule is "no balance moves mid-match except the wager", even though receiving would technically be safe.
- Gift daily cap (5000) is an in-memory ledger keyed by email — a soft social guardrail, deliberately reset by restarts; not a financial invariant.
- Pet trades are direct offers only (no marketplace). Both sides must be email-backed. Accept flips state synchronously (no double-settle), then ONE SQL transaction re-checks ownership/coins on both rows; accept is IRREVOCABLE — DB commit is truth, disconnect cleanup only cancels PENDING trades. Both sides auto-adopt the received pet (matches buy-auto-equip feel).
- The uniqueness invariant "one copy of an id per cosmetics array" means trades must reject when the receiver already owns the incoming pet — checked at offer time AND inside the accept transaction's `NOT ($x = ANY(cosmetics))` guards.

**Why:** the shared cosmetics-array ownership model and the RPS wager invariant constrain every future economy feature; violating either duplicates items or breaks wager settlement.

**How to apply:** any new coin-moving or item-moving feature must (a) block mid-match, (b) settle in one guarded SQL statement/transaction, (c) keep client labels display-only.

## Bid stores (player market) — escrow rules
- Bids ESCROW at placement (guarded `coins + old >= new` swap on raise); every path that deletes a bid row must refund in the SAME transaction — the listings→bids ON DELETE CASCADE will silently destroy escrow otherwise. The accept-time "seller no longer owns it" path must refund-all + delete + COMMIT, never rollback + bare delete.
- A listed item is exclusive: tradeOffer pre-checks jpo_store_listings AND both tradeAccept UPDATEs carry `NOT EXISTS (... listings ...)` guards, so a listed pet can't be traded away under live bids.
- Player-row updates in settle transactions run in EMAIL ORDER (seller/winner ordered, refunds sorted) to avoid deadlocks with concurrent trades.
- Server catalogs are plain id→price maps with NO display names — use itemLabel() to prettify ids for toasts.
- Grace-window toast trap: a just-disconnected player lingers in `players` ~10s; any "notify or queue mail" helper must require `io.sockets.sockets.has(id)` or the message dies on a dead socket. Disconnect flush only writes x/y/dir/anim, and all coin writes are delta-based (`coins = coins ± n`) — safe against overwriting refunds.
- Integration-test gotcha: the server pushes a fresh marketState after every mutation and pings sellers on new bids — always drain() event queues before re-requesting a snapshot or awaiting a specific storeOk, or stale items race the test ahead.

## Office Bingo + admin banner
- Bingo is ephemeral in-memory, keyed by EMAIL (refresh-safe); every game gets a monotonic gameId carried on all bingo events — clients ignore `bingoOver` with an older id, so a slow async payout can never tear down a newer game's UI.
- Winner claim: freeze game synchronously (bingoStop before any await), pay via guarded delta SQL with one retry, and only announce the win AFTER the DB row returns; failure announces an explicit "admin must award manually" message instead of a fake success.
- `uiSync` (client emits on approved) re-serves banner + bingo card; it is bucket-throttled. Bingo start is blocked while a lights-out round is running.
- Test timers are env-tunable (BINGO_JOIN_MS/BINGO_CALL_MS); tests/economy/bingo.mjs spawns a THROWAWAY server on its own port with fast timers instead of hitting the dev server.
- Banner is one in-memory {id,text}; dismissal is client-side localStorage by banner id, so a new post re-shows for everyone.

## Avatar makeover (hair colour + base character)
- First change per ACCOUNT free, then AVATAR_PRICE — priced in ONE guarded UPDATE using `CASE WHEN avatar_changes = 0` for both the debit and the coins guard (same row state = no TOCTOU).
- Session-only (no-email) players ALWAYS pay: a memory-only "first free" perk can be farmed by recreating sessions.
- Remote propagation gotcha: `playerMoved` only streams while moving — after changing another player's `entry.texKey`/`entry.character`, re-render their CURRENT pose immediately (seated/desk/idle branches), or a stationary player keeps the old sprite until they move.

## Owner-key tier (OWNER_PASSWORD)
- Second F8 password: `adminAuth` accepts ADMIN_PASSWORD (admins set) or OWNER_PASSWORD (admins + owners sets); `adminAuthOk` carries `{owner}` and the client shows owner-only tools from that flag. Coin adjust (`adminAdjustCoins`) is owner-gated and — per the owner's explicit request — deliberately NOT written to jpo_admin_log.
- Coin edits must update BOTH the DB row and the in-memory player (memory wins on next save); never advise direct prod-DB coin edits.

## Broadcast mini-game UI (bingo) — stale-state lessons
- Clients that miss the game-over event (tab asleep / brief disconnect) keep the old game's card. Every game broadcast carries a monotonically increasing gameId; handlers wipe local state when a NEWER id arrives (`_bingoDropStale`) and reject OLDER ids.
- Sticky DOM states (panel minimize) persist across games — always restore them when a new game shows the panel, or players report "the game never showed."

## Rare gift-only pets (Aug 2026)
- Unicorn + Phoenix: in both PETS catalogs with price 0 + client `rare:true`; server `RARE_PETS` set hard-blocks buyPet BEFORE the `!cost` check (0 is falsy — order matters). Shop shows them ("✨ RARE · not for sale", 🎁 Gift only tease button) so people pester the boss.
- Grants: `ownerGrantPet {email, pet}` gated on `owners.has(socket.id)` (OWNER_PASSWORD tier via adminAuth; plain ADMIN_PASSWORD gets owner=false and must stay blocked — Vince explicitly keeps coin/rare tools off the admin tier). Email-based like adminAdjustCoins so offline grants work; online recipients get petSuccess + rareGiftToast + playerPetUpdate.
- **Why:** boss wants rares as social currency — visible, unbuyable, personally gifted.
- Login success socket event for headless tests is `approved` (not loginSuccess); login inputs are `login-email`/`login-password` + `tryLogin()`.

**Zero-price rares & falsy checks:** rare gift-only items (unicorn/phoenix pets, phoenix wings) sit in the PETS/SHOP catalogs at price 0. Any catalog-membership validation MUST use `Object.hasOwn(catalog, id)` — a truthiness check like `!PETS[item]` silently rejects rares (broke the Bring button in prod, Aug 2026). Purchase paths keep the falsy check on purpose (0 = not buyable); trade paths block rares via RARE_IDS explicitly.

## Flash sale (Aug 2026)
- Global "X% off for N min" lives in server memory + single-row `jpo_flash_sale` (re-armed at boot). Buy handlers charge `salePrice(catalog[item])` at request time.
- **Rule:** `priceList`/`priceUpdate` always broadcast BASE prices; clients apply the sale % locally from `saleState`. **Why:** sale-adjusted broadcasts corrupted the F8 editor — the owner could save a discounted number as the permanent override.
- salePrice() must pass through falsy costs untouched (rare/unknown items rely on `!cost` gates).

**Whisper surveillance log:** whispers (text+img) are logged owner-only to jpo_whispers. Prune counter must live at MODULE scope (per-connection counter never fires under distributed traffic). Keep the F8 viewer copy NEUTRAL ("Message Records") — anything in public/index.html is readable via View Source, so never put "every whisper is logged" wording in the client bundle.
