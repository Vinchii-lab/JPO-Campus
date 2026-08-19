---
name: JPO Huddle Grand Event
description: Durable settlement and spectator-state rules for restart-safe bracket events.
---

Record the match winner and resulting bracket progression durably before attempting any stage or champion reward. Treat each event/payout purpose as one claim regardless of recipient; make per-player refunds use recipient-specific purposes. If legacy data contains multiple recipients for one semantic claim, fail startup rather than continue without the uniqueness invariant.

**Why:** Paying first creates a crash window where the old matchup can replay after restart and credit a second winner. Recipient-keyed claims make that replay look unique even though it is the same reward.

**How to apply:** For any durable tournament or organizer-funded event, make the saved outcome the commit point, recover unpaid rewards from that outcome, and reject conflicting claim ownership instead of silently treating it as an idempotent retry.

Keep eliminated status immutable. Store Quit/Spectate as a separate, account-keyed viewer preference; quitting must never refund escrow or alter bracket progression. Only opted-in eliminated entrants may receive sanitized live battle events, and reconnect should restore that preference without granting battle controls.

**Why:** Treating "quit" as withdrawal corrupts a locked tournament, while client-only spectator state disappears on reconnect and can tempt implementations to reuse participant channels that expose controls.

**How to apply:** Gate spectator delivery on the current event, eliminated account, and persisted preference. Send only public start/progress/round/result data; never legal move prompts or participant ownership. Keep invite dismissal client-only and event-scoped.