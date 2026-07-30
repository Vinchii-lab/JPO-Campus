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
