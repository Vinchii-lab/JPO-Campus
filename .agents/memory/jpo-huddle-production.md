---
name: JPO Huddle production ops
description: Production DB is separate & read-only; how fixes reach the live published app
---

- Production runs against a SEPARATE Postgres from dev (real players live there; dev holds only test rows). Query it read-only via `executeSql({ environment: "production" })` — INSERT/UPDATE/DDL are impossible from the agent.
- **Why:** a July 2026 incident — a map layout change went live via publish, and every prod player's previously-saved x/y restored into the unpainted void outside the new building. Prod rows could not be fixed directly.
- **How to apply:** any fix touching prod data must SELF-HEAL in server code (validate/correct on read, e.g. the `restorePlayer` void rescue) and then be REPUBLISHED — code changes do nothing for production until the user publishes again. Expect stale saved state in prod whenever the map or coordinate conventions change.

## Shipping fixes to tabs that are already open
Old tabs run old client JS until the PAGE reloads — new code can't retro-fix them, and socket reconnects alone don't reload the page. The build handshake (server emits its stamp on connect; new clients self-reload on mismatch, pre-handshake clients get a nag toast re-armed every reconnect) makes a workflow restart the "push fix to everyone" trigger. Restarting is safe for live users: resume tokens auto-rejoin everyone within seconds.

Build ids for this MUST be content-derived (hash of the served page), never boot-time timestamps: the published app can autoscale to several instances, and per-boot stamps make a reconnecting client see alternating "new builds" → reload churn. Client-side, keep exactly ONE reload authority: every trigger (page load, reconnect, server push) must funnel into the same guarded checker — two independent reload paths in one page is how reload fights start. Check for an EXISTING self-heal before adding one; this project already had `_checkStamp` when a second mechanism was almost shipped alongside it. A min-interval guard bounds residual churn; a stale-but-stable tab beats a refresh cycle.
