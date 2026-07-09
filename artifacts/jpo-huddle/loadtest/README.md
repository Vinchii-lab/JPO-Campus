# JPO Huddle load-test harness

Simulates N headless players (walking at the real client cadence, chatting,
emoting, and running RPS duels) against the game server and reports move-echo
latency percentiles, delivery ratio, server event-loop lag, RSS, CPU, and
coin-tick duration.

## Run

```bash
pnpm --filter @workspace/jpo-huddle run loadtest -- --n 100 --duration 60
```

> **Running from the Replit agent?** The agent's bash sessions cannot keep a
> ~90s foreground run alive reliably. Instead: write the desired flags into
> `loadtest/run-params` (one line), configure a temporary console workflow
> running `bash artifacts/jpo-huddle/loadtest/run-workflow.sh`, restart it per
> run, and read `loadtest/results/run.log`. Remove the workflow when done so
> it doesn't re-run a load test on every repl boot.

By default it spawns its **own** server instance on port 21999 with
`LOADTEST_METRICS=1` (the dev workflow / preview is untouched) and kills it
afterwards. Needs `ADMIN_PASSWORD` and `DATABASE_URL` in the env (both are
already set in this workspace).

Common variants:

```bash
# DB-backed accounts (exercises the coin-tick DB write path); rows are cleaned up after
pnpm --filter @workspace/jpo-huddle run loadtest -- --n 100 --email-backed

# Against an already-running server (no server-side metrics in this mode)
pnpm --filter @workspace/jpo-huddle run loadtest -- --n 50 --attach http://127.0.0.1:20158
```

All flags are documented at the top of `loadtest.mjs`. Each run also writes a
JSON report into `loadtest/results/`.

## Pass criteria

- every player registered + approved, zero unexpected disconnects
- move-echo p95 < 250 ms
- delivery of **accepted** moves > 98 % — the raw send count is discounted by
  the server's `mv_ok/mv_thr` counters, because the 33 ms move throttle drops
  TCP-bunched 50 ms-cadence sends by design (cosmetic, next move corrects)
- teleport rejects < 0.1 % of moves (catches systematic harness bugs; a tiny
  fraction is expected CPU-jitter fallout, same as a lagging real browser)
- server event-loop lag p99 < 200 ms (spawn mode only)

## Caveats

- The workspace has 2 vCPUs and the harness runs on the same machine as the
  server, so client-observed latency at high N includes harness scheduling
  noise. The server's own `[metrics]` event-loop lag is the authoritative
  server-health signal.
- Latency is measured within each worker process (sender and watcher share a
  clock), one watcher per player, so there is no cross-process clock skew.
