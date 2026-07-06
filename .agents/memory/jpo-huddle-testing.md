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
