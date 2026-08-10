---
name: JPO Huddle HR librarian quiz
description: Ms. Poli stationary HR NPC + daily Code of Discipline quiz — patterns and constraints
---

# Ms. Poli (HR) & the COD quiz

- Second NPC follows the Huddles rule: OUTSIDE `players`, own events (`hrNpcState`, `hrInteract`, `hrAnswer`, `hrQuiz`). Stationary → one snapshot at approval + on `npcSync`; no move ticks needed.
- **Why stationary:** no pathing/dwell code, and a "librarian at her shelf" reads naturally; placement must be a CONFIRMED open-floor tile — check TMJ (`Floor`>0, no `Furniture`/`Wall`; layers are named `Floor`/`Furniture`/`Wall`, game tile = TMJ tile since 16px×3 = 48px). First guess near a furniture anchor was NOT walkable.
- Quiz design (HR-approved intent): one question/person/UTC day, deterministic pick from a hand-authored bank via hash(email+day). TYPED answers only — Vince rejected multiple choice AND any in-game COD text (boss confidentiality): players must physically ask HR. Options never leave the server (grading reference only); COD section ref revealed only after solving.
- AI semantic grading via the coach's OpenAI client (JSON {correct:boolean}, 9s timeout). Grading failure must NOT burn an attempt (checkFailed path). Spend bounded by a per-day tries cap (6) instead of a separate budget map.
- Panel textareas need keydown/keyup stopPropagation or Phaser eats typing (WASD moves the player mid-sentence).
- Payout: first-try 50 / after-research 15. `jpo_cod_quiz` (day,email PK) with `UPDATE ... SET solved=TRUE WHERE solved=FALSE RETURNING` as the single atomic claim → restart/replay can never double-pay.
- Session gate = same stamp pattern as coach (`p.hrTalkAt` set only after server-side distance check; answers require stamp < 2 min).
- Wrong answers deliberately nudge people to the in-panel condensed COD "shelf" or to ask HR (Junell/Claire/Klynn) in person — the social loop is the point.
- Headless test recipe: seed approved player (scrypt hash format `scrypt:<saltB64url>:<hashB64url>`), `clientBuild` handshake after `buildStamp` (else the stale-client F5 nag toast fires and confuses tests), `playerMove` next to NPC, then interact/answer. Clean up seeded rows after.
