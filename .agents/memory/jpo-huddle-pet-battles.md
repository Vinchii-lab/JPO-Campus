---
name: JPO Huddle pet battles
description: Durable authority and settlement rules for pet-vs-pet combat and battle XP.
---

Pet battles are a separate lifecycle from pet races and coin-wager games. The client may submit only a move; the server freezes each equipped pet's form and training at battle start, validates move legality, and owns every roll, stat, damage, HP, timer, and result.

**Why:** Accepting combat numbers from the browser, rereading mutable player state mid-match, or sharing unrelated match state creates cheating and race-condition seams.

**How to apply:** Any new battle mode or move must derive from the frozen server snapshot and settle through the pet-battle lifecycle rather than a client-authored receipt.

Standard player-facing Pet Battles are social PvP. A coworker's Pet Profile shows identity/form and the battle action, but exact attributes, unspent points, and derived stats are private; only the owner receives or edits their full build. There is no training-bot route.

**Why:** The intended loop is inspecting and challenging fellow coworkers' pets, not launching an isolated training-bot match from a separate arena.

**How to apply:** Keep the avatar popover to View Profile. Coworker profiles hold whisper/challenge/gift/trade/store cards, but Pet Battle belongs on the clicked pet's profile. Local/remote office pets and a player's Pet row open that profile. Retain server-side eligibility/distance checks, explain point/XP progression on the owner's profile, and redact builds at server serialization for profiles, opponents, and spectators.

Battle wire payloads use rounded health/damage percentages and a relative first-moving side; never serialize exact HP, max HP, raw damage, builds, or derived stats.

**Why:** exact max HP reveals Vitality directly, and raw combat numbers make private builds easy to reverse-engineer even when the profile is hidden.

Pet Point allocations are permanent once committed: an owner may only add newly available points and may never subtract, reset, or reshuffle prior points. Only the owner may read or submit the exact build.

**Why:** Respeccing would erase build identity, and hiding minus controls is not security—stale or modified clients could still lower stored attributes.

**How to apply:** Validate monotonic extension against the live authoritative build, then repeat every attribute floor in the database update so concurrent/stale saves cannot overwrite newer allocations. Correlate async profile/save responses so navigating mid-save cannot show or edit the wrong pet.

Every XP-bearing participant must have an approved email-backed account. Settlement uses a per-match/per-player idempotency claim and a same-opponent cooldown; there is deliberately no daily XP cap, and session-only players must never receive memory-only battle XP.

**Why:** Retry/reconnect races and ephemeral identities must not double-credit XP, but the owner explicitly wants players free to earn battle XP without a daily ceiling.

**How to apply:** Route every positive battle reward through the same transaction. Forfeits settle before removing the leaver: remaining player gets +2, leaver gets +0 and an explicit zero-XP receipt.

Species identity is visual and physical, not a hidden combat rules layer. The network protocol keeps the four allowlisted move intents (attack, guard, special, ultimate), every species uses the same stat/damage rules, and the pet kit controls names plus body-appropriate arena movement.

**Why:** “Fight differently” means porting the recognizable in-office pet trick choreography into battle—not generic bite/scratch/hover substitutes and not hidden mechanics. Examples include Splash Dive, Moonlit/Void Blink, Blizzard Binky, Ice Shell, Dragon breath, Rain Dance, Prism Beam, and Ember Dive.

**How to apply:** Map every battle pet/form deterministically by the authoritative round-result move: Attack uses its lower office beat, Special uses a distinct mid-tier beat, and Ultimate uses the exact form's signature final trick. Use the same resolved move path for both players. Translate Phaser choreography into cancellable arena-relative DOM effects, and restore all visual state afterward. Inside Pet Wars, dragons and phoenixes stay airborne even while stationary and continuously cycle exact-form wing frames; a static bob or sit pose is not an acceptable battle idle. This rule does not apply to the office: there they fly only while following, land when stopped, and use their sit/nest art when the owner sits. Dragon breath is a chunky cluster of fireballs and smoke, never a simple beam. Obsidian's ultimate must combine its heavy stomp with fire breath rather than stopping after the landing. Keep form/training as the only stat inputs and do not dispatch species-specific status effects.

Move identity changes choreography only; action-pose artwork must follow the pet's frozen current evolution stage for every move. A final-form pet must never briefly render baby or stage-two artwork to perform Attack or Special.

**Why:** Selecting action art by move tier made evolved pets visibly change form mid-skill even though the movement mapping itself was correct.

**How to apply:** Choose movement/effects from Attack, Special, or Ultimate, but use only the exact action sprite for the battle snapshot's current stage. If that action asset is absent, keep the current-stage idle sprite; never fall back to another evolution's action art. Restore the same stage's idle sprite afterward.