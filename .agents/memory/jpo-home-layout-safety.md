---
name: Home layout safety
description: Preserve user placements during reads and version every snapshot-visible mutation.
---

Home refreshes must never repair or delete persisted furniture placements.

**Why:** A normal Store operation triggered legacy layout repair during its subsequent snapshot read, allowing unrelated placements to disappear. New collision rules are not consent to discard an existing layout.

**How to apply:** Keep snapshot reads non-destructive. Perform any destructive layout repair only through an explicit, authorized operation. Store targets a placed instance, not an item type or a replacement of the whole layout.

Version all snapshot-visible mutations, not just furniture movement, and keep collision state consistent with committed removals even if the follow-up snapshot fails.

**Why:** Delayed inventory responses can overwrite newer layouts; a committed removal followed by a failed refresh can leave an invisible authoritative blocker.

**How to apply:** Route full snapshots through one owner/version gate. Increment the shared version transactionally for inventory and layout changes, and reconcile collision state as part of commit/recovery.