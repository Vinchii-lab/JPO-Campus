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

Species identity is visual and physical, not a hidden combat rules layer. The network protocol keeps the four allowlisted move intents (attack, guard, special, ultimate), every species uses the same stat/damage rules, and the pet kit controls names plus body-appropriate arena movement.

**Why:** “Fight differently” means porting the recognizable in-office pet trick choreography into battle—not generic bite/scratch/hover substitutes and not hidden mechanics. Examples include Splash Dive, Moonlit/Void Blink, Blizzard Binky, Ice Shell, Dragon breath, Rain Dance, Prism Beam, and Ember Dive.

**How to apply:** Map every battle pet/form deterministically by the authoritative round-result move: Attack uses its lower office beat, Special uses a distinct mid-tier beat, and Ultimate uses the exact form's signature final trick. Use the same resolved move path for players and bots. Translate Phaser choreography into cancellable arena-relative DOM effects, and restore all visual state afterward. Dragons and phoenixes stay airborne even while stationary (including when the owner sits) and continuously cycle exact-form wing frames; a static bob or sit pose is not an acceptable idle. Dragon breath is a chunky cluster of fireballs and smoke, never a simple beam. Obsidian's ultimate must combine its heavy stomp with fire breath rather than stopping after the landing. Keep form/training as the only stat inputs and do not dispatch species-specific status effects.

Move identity changes choreography only; action-pose artwork must follow the pet's frozen current evolution stage for every move. A final-form pet must never briefly render baby or stage-two artwork to perform Attack or Special.

**Why:** Selecting action art by move tier made evolved pets visibly change form mid-skill even though the movement mapping itself was correct.

**How to apply:** Choose movement/effects from Attack, Special, or Ultimate, but use only the exact action sprite for the battle snapshot's current stage. If that action asset is absent, keep the current-stage idle sprite; never fall back to another evolution's action art. Restore the same stage's idle sprite afterward.