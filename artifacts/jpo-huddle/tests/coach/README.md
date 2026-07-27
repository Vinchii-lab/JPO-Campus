# Huddles coach / NPC regression tests

Headless socket.io + real-browser checks for the Huddles AI coach NPC and daily
connection missions. They run against the LIVE dev server and the dev database,
seed their own throwaway players (fresh random `coach-*`/`coachx-*`/`brow-*`
emails each run), and clean up after themselves.

## Prereqs

- The `artifacts/jpo-huddle: web` workflow running; note its port from the boot
  log ("running on port NNNNN").
- `DATABASE_URL` in the environment (already set in the workspace).
- One-time deps in the runner dir: `npm install socket.io-client puppeteer-core@20`
  (these scripts resolve `socket.io-client`/`puppeteer-core` from their own dir,
  and `pg` from the artifact's node_modules).

## Run

```bash
cd artifacts/jpo-huddle/tests/coach   # or copy the scripts next to their deps
TEST_PORT=<port> node coach-flow.mjs      # intake → mission → re-roll → gates
TEST_PORT=<port> node coach-complete.mjs  # RPS win / QD forfeit / whisper / coffee completions
TEST_PORT=<port> node browser-npc.cjs     # puppeteer: client parses, NPC renders, chip shows
```

Each script prints `RESULT: PASS` (exit 0) or `RESULT: FAIL (…)` (exit 1) —
assert on that line, not just the exit code.

## Caveats

- Real players may be online on the same dev server: never assert global world
  state (rosters, chat), only state scoped to the seeded test emails.
- Space runs ≥12s apart (or rely on the fresh-email-per-run behavior) to dodge
  the disconnect-grace window.
- `browser-npc.cjs` pins a Nix chromium path; if it vanishes after an env
  rebuild, `ls /nix/store | grep ungoogled-chromium` and update `CHROME`.
- The AI mission generator is live in dev — mission #1 content varies (it may
  target real coworkers by first name; that is the feature working). Assertions
  only check template/allowlist shape, never flavor text.
