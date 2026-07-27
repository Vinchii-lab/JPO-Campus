---
name: JPO Huddle NPC & AI coach
description: Server-authoritative NPC pattern (outside players map), and the AI-spend gating pattern for socket-triggered model calls.
---

# NPC pattern

The walking NPC ("Huddles") is server-authoritative but lives OUTSIDE the `players` map, with dedicated events (`npcState` snapshot, `npcMoved` stream, `npcSync` client pull on scene create).
**Why:** everything that iterates `players` (whisper rosters, duel target scans, After Dark rounds, leaderboards, group payouts, nearby counts) must never see the NPC; keeping it out of the map makes that safe BY CONSTRUCTION instead of needing exclusion checks at every consumer.
**How to apply:** any future NPC gets its own object + events; never add one to `players`. Client renders it with the same `_buildPlayerTex`/anim keys as remote players. Ticker freezes when the office is empty (skip pathing when `players` is empty). Walkability = painted Floor minus Wall/Furniture from the TMJ; runtime BFS per leg, skip unreachable stops with a log. Verify tour connectivity offline by re-deriving the mask from the TMJ and BFS-ing consecutive stops (fast node one-liner) before blaming the mask.

# AI-spend gating for socket-triggered model calls

Any socket event that can trigger a paid AI call needs THREE layers (rate-limit buckets are NOT enough — they refill):
1. **Pre-gate read:** check whether the work product already exists (today's mission) BEFORE gathering candidates / calling the model; replayed events must cost a SELECT, not a model call.
2. **Per-email/day spend cap** (in-memory map, UTC day key): over cap → deterministic fallback, never a user-facing block. Cost damper, not correctness gate.
3. **Atomic claim for variants:** re-roll style "regenerate" paths must claim their once-a-day flag with a conditional UPDATE ... RETURNING BEFORE the model call.
**Why:** an architect review flagged replayed `coachIntake` as a spend-amplification vector — generation ran before the day-gate UPDATE, so every replay burned a model call even though the UPDATE no-op'd.

# Form events after a proximity-checked talk

Follow-up form events (intake submit, re-roll click) can't re-check raw distance — the NPC strolls away while the player fills the form. Instead the proximity-verified E-press stamps `p.coachTalkAt`; form events require the stamp to be < 2 min old (and refresh it). Unforgeable server-side, immune to NPC movement.
