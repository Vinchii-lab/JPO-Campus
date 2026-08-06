---
name: JPO Huddle Deal or No Deal
description: Owner-hosted game show — state machine gotchas, majority + payout rules, and test setup
---

# Deal or No Deal (The Vince Show)

- Owner-only hosting: `ownerDeal*` handlers gate on `owners.has(socket.id)` (OWNER_PASSWORD via adminAuth), NOT `admins`. F8 section `#op-owner-deal` shown only on `adminAuthOk d.owner`; client also sets `window._ownerAuthed`.
- Closed case values never leave the server: `dealSnap()` sends a sorted ladder + `opened[]` (null for closed). Any new emit must respect this.
- **State machine rule:** a case-open reveal sets `state = "revealing"` — Banker offers are only legal in `"voting"`. Without this, an offer during the FINAL reveal cleared the payout timer and the show could loop forever unpaid. Keep finalization non-interruptible.
- **Why single-attempt payouts:** `coins = coins + N` is not idempotent; retrying after an ambiguous connection error can double-pay. One attempt per email, failures logged loudly for manual award (unlike bingo's 2-attempt single-winner pattern — N players multiplies the risk).
- DEAL needs a true majority of ALL entrants (`yes > players.size/2`); abstain = no. Tie/no votes on case-vote → random unopened case.
- Vote handlers: takeToken(interactBucket) + drop unchanged votes, or a modified client turns tallies into a broadcast pump.
- Mutual exclusion: deal blocks/blocked-by bingo, Office After Dark round, prop hunt (guards in all four start handlers).
- Env-fast testing: `DEAL_JOIN_MS/DEAL_VOTE_MS/DEAL_OFFER_MS/DEAL_REVEAL_MS`; run an isolated `PORT=20999 node server.js` instance so tests don't broadcast lobbies to real coworkers on dev.
- Second approved test account now exists: `pilotdrg2@justpressone.com` (same password as pilotdrg; hash copied in dev DB). Logging one email in twice kicks the older socket — never reuse an email across test sockets.
- Browser login in headless tests: set input values via `page.evaluate` (page.type left the field unread → "A valid email is required").
