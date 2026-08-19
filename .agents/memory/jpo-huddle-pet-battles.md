---
name: JPO Huddle pet battles
description: Durable authority and settlement rules for pet-vs-pet combat and battle XP.
---

Pet battles are a separate lifecycle from pet races and coin-wager games. The client may submit only a move; the server freezes each equipped pet's form and training at battle start, validates move legality, and owns every roll, stat, damage, HP, timer, and result.

**Why:** Accepting combat numbers from the browser, rereading mutable player state mid-match, or sharing unrelated match state creates cheating and race-condition seams.

**How to apply:** Any new battle mode or move must derive from the frozen server snapshot and settle through the pet-battle lifecycle rather than a client-authored receipt.

Every XP-bearing participant must have an approved email-backed account. Settlement uses a per-match/per-player idempotency claim, a UTC per-pet daily rewarded-match cap, and a same-opponent cooldown. The training bot must retain a stable synthetic identity in that pair ledger; session-only players must never receive memory-only battle XP.

**Why:** Retry/reconnect races, immediate bot rematches, and ephemeral identities otherwise bypass farming controls or double-credit XP.

**How to apply:** Route every positive battle reward through the same transaction. Forfeits settle before removing the leaver: remaining player gets +2, leaver gets +0 and an explicit zero-XP receipt.

Species identity belongs in a server-frozen kit while the network protocol keeps the four allowlisted move intents (attack, guard, special, ultimate). Kits are bounded side-grades: each pet may trade durability, speed, crit, guard, movement, and status tactics, but rarity must not become a power tier.

**Why:** Client-only names/colors made every pet mechanically identical; accepting species-specific effect parameters from the browser would fix variety by reopening cheating.

**How to apply:** Add new pets to the complete server kit registry and public metadata contract. Give variants distinct mechanics, not only renamed visuals, while keeping all calculations server-owned.

On-hit debuffs and damage-over-time do not land through a dodge. Ordinary healing and regeneration never restore a pet from zero HP; an explicitly armed Rebirth is the sole revival path. Direct attacks still resolve simultaneously.

**Why:** Letting status payloads bypass dodge makes evasion misleading, and allowing routine recovery from zero erases the special meaning of revival and produces invalid KO outcomes.

**How to apply:** Separate target effects from self-only setup, preserve simultaneous direct damage, then process bounded statuses/recovery with the zero-HP guard before the explicit Rebirth check.