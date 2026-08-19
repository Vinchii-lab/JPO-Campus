---
name: JPO Huddle Grand Event settlement
description: Durable ordering and payout identity rules for restart-safe bracket events.
---

Record the match winner and resulting bracket progression durably before attempting any stage or champion reward. Treat each event/payout purpose as one claim regardless of recipient; make per-player refunds use recipient-specific purposes. If legacy data contains multiple recipients for one semantic claim, fail startup rather than continue without the uniqueness invariant.

**Why:** Paying first creates a crash window where the old matchup can replay after restart and credit a second winner. Recipient-keyed claims make that replay look unique even though it is the same reward.

**How to apply:** For any durable tournament or organizer-funded event, make the saved outcome the commit point, recover unpaid rewards from that outcome, and reject conflicting claim ownership instead of silently treating it as an idempotent retry.