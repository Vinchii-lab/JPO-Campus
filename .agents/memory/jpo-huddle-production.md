---
name: JPO Huddle production ops
description: Production DB is separate & read-only; how fixes reach the live published app
---

- Production runs against a SEPARATE Postgres from dev (real players live there; dev holds only test rows). Query it read-only via `executeSql({ environment: "production" })` — INSERT/UPDATE/DDL are impossible from the agent.
- **Why:** a July 2026 incident — a map layout change went live via publish, and every prod player's previously-saved x/y restored into the unpainted void outside the new building. Prod rows could not be fixed directly.
- **How to apply:** any fix touching prod data must SELF-HEAL in server code (validate/correct on read, e.g. the `restorePlayer` void rescue) and then be REPUBLISHED — code changes do nothing for production until the user publishes again. Expect stale saved state in prod whenever the map or coordinate conventions change.
