# Proximity voice regression tests

Headless socket.io + real-browser checks for push-to-talk proximity voice.
They run against the LIVE dev server and dev database, seed throwaway players
(fresh random `voice-*` / `voicebrow-*` emails each run), and clean up after
themselves.

## Prereqs

Same runner setup as `tests/coach/README.md` (socket.io-client +
puppeteer-core@20 in the runner dir, `pg` from the artifact's node_modules,
`DATABASE_URL` in the env, workflow running — note its port).

## Run

```bash
TEST_PORT=<port> node voice-signal.mjs   # server relay rules (~75s: includes a real 30s round join window)
TEST_PORT=<port> node browser-voice.cjs  # two chromiums with fake mics: real WebRTC call + badges
```

Each prints `RESULT: PASS` / `RESULT: FAIL (…)` — assert on that line.

## What they cover

- `voice-signal.mjs` — the server is a validating switchboard: near-pair
  relay (opaque, both directions), distance drop, 40KB payload cap + 4KB
  ICE cap, npc/self/junk targets, badge broadcast, token-bucket rate limit,
  and the After Dark split (dark↔dark ok, lit↔dark refused, badge isolation
  = chat's rules). Fake SDP payloads on purpose: relay rules only.
- `browser-voice.cjs` — the client actually connects: auto-dial by
  proximity, pc `connected` both ends, audio path wired (the
  transceiver-adoption regression), V-hold goes live, 🎙️ badge appears on
  the other client and clears on release, zero page errors.

## Caveats

- Real players may be online: assertions are scoped to seeded ids only.
  The round section starts a REAL After Dark round (they'll see the invite
  toast); it skips gracefully on `roundError` if a real round is running.
- A far-away player is parked by emitting candidate coords and confirming
  via another socket's `playerMoved` echo — unpainted tiles reject moves,
  so never assume a coordinate landed (TILE_PX = 48).
- `browser-voice.cjs` needs the fake-media chromium flags and TWO incognito
  contexts (shared localStorage would auto-resume the first login).

## crowd-voice.cjs — three-browser crowd behavior
Proves simultaneous talkers both come through (badges + full-duplex pc) and
that a client at its peer cap bumps a silent peer the moment an outsider
starts talking — covering both the dial-side and offer-side eviction paths.
Uses the `?vmax=1` query hook to force a one-slot cap so three browsers are
enough to bind cap behavior. Same run recipe as browser-voice.cjs.

## Rebuilding the /tmp throwaway env
`/tmp/jpotest` gets wiped on container restarts. Recreate: copy these files
there, `npm i socket.io-client puppeteer-core@20.7.2` — the puppeteer pin
MUST stay at 20.7.2 to match the nix chromium 114 binary; a modern
puppeteer-core silently hangs on goto (protocol mismatch).
