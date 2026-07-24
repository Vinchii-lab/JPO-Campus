# Load test results

Stepped runs on the 2-vCPU workspace, 60s measurement window each, spawn mode
(harness spawns its own server on port 21999 with `LOADTEST_METRICS=1`).
Full JSON reports in `results/`.

## 2026-07-24 — 200-player probe

**FAIL at 200 players on this 2-vCPU box** (report:
`2026-07-24T13-14-19-083Z-n200.json`): echo p95 259 ms, server lag p99
393 ms, teleport rejects 0.644 %. CPU was pegged (97 % avg / 103 % max,
harness + server sharing the same 2 vCPUs), so as at n=150 part of the
failure is harness scheduling noise — but unlike n=150 the SERVER-side lag
signal also blew the threshold, so this is a real ceiling, not purely a rig
artifact. Healthy signals even at 200: all 200 approved, zero disconnects,
delivery of accepted moves 100 %, RSS 227 MB, coin tick 5 ms.

The dominant cost is the O(n²) movement fan-out: every accepted move
broadcasts to all 200 clients → ~132 k `playerMoved` messages/s observed.
Path to 200+: (1) deploy on a bigger Reserved VM (single socket.io process —
autoscale would split the office), and/or (2) interest-area filtering so
moves only go to players near you (~10× fan-out cut at this map size).

## 2026-07-09 verdict (100-player target)

**PASS at the 100-player target — no server changes needed.** The server
stayed healthy at every step; the only degradation up to 100 players is
client-observed latency growth caused by harness scheduling noise on the
shared 2-vCPU box. 150 players is the saturation point of this test machine,
not of the server.

| n | mode | echo p95 | server lag p99 | delivery (accepted) | CPU avg/max | RSS max | verdict |
|---|------|----------|----------------|---------------------|-------------|---------|---------|
| 25 | session | 4 ms | 17.8 ms | 99.99 % | — | — | PASS |
| 50 | session | 9 ms | 6.5 ms | 100 % | 21 / 33 % | 115 MB | PASS |
| 100 | session | 68 ms | 99.6 ms | 99.74 % | 69 / 79 % | 153 MB | PASS |
| 150 | session | 158 ms | 192.2 ms | 99.9 % | 78 / 90 % | 223 MB | FAIL* |
| 100 | email-backed | 43 ms | 66.2 ms | 99.97 % | 65 / 75 % | 238 MB | PASS |

\* 150 failed only the teleport-reject check (0.917 % of moves): at that load
the workers' own send ticks get delayed enough to produce oversized steps the
server correctly drops (the documented anti-teleport guard — the same thing
happens to a lagging real browser). Server-side signals stayed within bounds:
lag p99 192 ms, accepted-move delivery 99.9 %, zero disconnects. Treat 150 as
"this 2-vCPU box can't generate clean load beyond ~100–150", not as a server
limit.

## Notable observations

- **Raw delivery ratio is misleading under load** (85 % at n=100): most of the
  gap is the server's by-design 33 ms move throttle dropping TCP-bunched
  sends, not lost broadcasts. Delivery judged against *accepted* moves
  (using the `mv_ok`/`mv_thr`/`mv_rej` metrics counters) was ≥ 99.7 % at every
  step. Zero unexpected disconnects in any run.
- **Coin tick with 100 DB-backed players took 1.26 s wall time** (sequential
  per-player UPDATEs), but it is async and did NOT block the event loop (lag
  p99 stayed 66 ms during the tick, coin-tick was 1 ms with session-only
  players). If the team ever grows well past 100 concurrent email-backed
  players, batching the coin-tick UPDATEs is the first optimization to reach
  for — deliberately NOT done now (task: minimal fixes only if 100 fails).
- Memory is flat and small: 238 MB RSS worst case at 100 DB-backed players.
- The email-backed run also verified row cleanup: 0 `loadtest.*@lt.local`
  rows left after the run.
