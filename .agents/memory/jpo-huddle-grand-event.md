---
name: JPO Huddle Grand Event
description: Durable settlement and spectator-state rules for restart-safe bracket events.
---

Record the match winner and resulting bracket progression durably before attempting any stage or champion reward. Treat each event/payout purpose as one claim regardless of recipient; make per-player refunds use recipient-specific purposes. If legacy data contains multiple recipients for one semantic claim, fail startup rather than continue without the uniqueness invariant.

**Why:** Paying first creates a crash window where the old matchup can replay after restart and credit a second winner. Recipient-keyed claims make that replay look unique even though it is the same reward.

**How to apply:** For any durable tournament or organizer-funded event, make the saved outcome the commit point, recover unpaid rewards from that outcome, and reject conflicting claim ownership instead of silently treating it as an idempotent retry.

Keep eliminated status immutable. Store Quit/Spectate and optional public live viewing as separate, account-keyed viewer preferences; quitting/stopping must never refund escrow or alter bracket progression. Only explicit viewers may receive sanitized live battle events, and reconnect/restart should restore that preference without granting battle controls.

**Why:** Treating "quit" as withdrawal corrupts a locked tournament, while client-only viewer state disappears on reconnect and can tempt implementations to reuse participant channels that expose controls. Public viewing must be opt-in so coworkers can keep using the office normally.

**How to apply:** Gate spectator delivery on the current event and persisted preference, exclude the current fighters, and keep Quit available only to eliminated entrants. Send only public start/progress/round/result data; never legal move prompts or participant ownership. Keep invite dismissal client-only and event-scoped.