---
name: JPO Huddle outfit slots & seasonal shop
description: Multi-slot wearables (top/bottom/neckwear/held) alongside legacy equipped_cosmetic, plus seasonal shop gating — invariants to keep.
---

- Slots are ADDITIVE to the legacy single `equipped_cosmetic` column: hats/eyewear stay legacy; slot routing lives in `WEAR_SLOT` (item id → slot) duplicated server+client in lockstep. Take-off with empty item requires an allowlisted `payload.slot` (never a raw column name — SQL column picked server-side from `SLOT_COL`).
- **Every ownership-changing path must clear ALL equip columns** (legacy, wings, pet, pet acc, AND the four slot columns) with `CASE WHEN col = $item` — the storefront sale path shipped missing the slot columns and left sold gear rendered/persisted on the seller. When adding a new equip column, grep every `equipped_` CASE list (buy/trade/gift/storefront) and the session-refresh + broadcast that follows.
- `slots` object rides every payload that carries `equipped`: approved, shopSuccess (incl. owner-grant), equipUpdate, playerCosmeticUpdate, grace snapshot, session init. A missing emit site doesn't error — clients just silently keep stale slots.
- Seasonal gating: `seasonNow()` date windows mirrored client+server; server buy handlers are the authority (reject off-season), client `_seasonRowOk` only HIDES shop rows — owned seasonal gear must always stay equipable off-season.
- Wearable sprite offsets (raincoat dy13, rainboots dy25, umbrella dy-30 side8) were guessed then verified by seeded puppeteer screenshots in 3 facings — cap + umbrella + coat + boots coexist visually.
- **Why:** review round caught the storefront slot-clearing gap after all happy-path tests passed — settlement paths are where new equip state silently rots.
