---
name: JPO Huddle proximity voice (WebRTC PTT)
description: Durable lessons from building the push-to-talk proximity voice mesh — transceiver gotcha, relay validation pattern, voice-test techniques.
---

## Answerer must ADOPT the offer's transceiver — never pre-add its own
The polite/answering peer must NOT `addTransceiver('audio')` before `setRemoteDescription(offer)`. In the browsers we target the pre-added transceiver is not reliably recycled: the offer's m-line spawns a second (recvonly) transceiver, the answer comes back recvonly, the dialer never fires `ontrack`, and `replaceTrack` lands on the orphan — **one-way silence while `pc.connectionState` still reads 'connected'**.
**How to apply:** only the dialer declares the m-line up-front; the answerer takes `getTransceivers()[0]` after `setRemoteDescription`, sets `direction='sendrecv'`, then attaches the mic. Mic attach is always `replaceTrack` on that transceiver — never `addTrack` (no renegotiation, ever).

## Server is a validating switchboard, not a media path
Relay validation re-runs per message (not per session): both ends in `players`, distance ≤ range+slack, `inTheDark(a)===inTheDark(b)`, size cap, bucket. Slack must cover the CLIENT's hang-up hysteresis (dial 480 / drop 620 / server 480+260) — shrink slack below the drop radius and edge-pacing pairs get their ICE restarts refused. Badge relays copy chat's dark-isolation branch exactly. The server cannot cut a live P2P stream: cross-split teardown when a round STARTS is done by the dark member's client (roster mirror), and either end closing kills audio both ways.

## Hostile peers: bound every pre-handshake buffer + deadline every pc
A withheld answer plus an ICE flood is a memory DoS on the *browser*: cap the pre-SDP `pendIce` buffer (~24; legit flows use <10) and drop+cooldown on overflow, give every pc a never-connected deadline (~15s → drop+cool — also unblocks redials after a dead dial), and cap ICE-kind relay messages far below offer-kind on the server (<4KB vs 40KB; one `data.k` read keeps the relay otherwise opaque).

## Mesh slots must follow the conversation, not raw distance
Nearest-N peer selection breaks in crowds: a silent bystander 50px away blocks the talker 300px away → "I can't hear them but she can" (position-dependent asymmetry that users read as turn-taking). Rank talkers first — the broadcast badge state is the shared talking signal every client already has — in ALL FOUR slot decisions: dial candidates, keep/evict ranking, inbound offers at cap, AND the dial loop itself (at cap, a talker candidate must evict-then-dial; `break`-ing at zero room means whichever side of a pair is full simply never dials and the pair silently never forms — eviction on only the offer path is HALF a fix). Evict farthest silent peer, short 3s cool to damp flap, never evict a talker. `?vmax=N` query hook forces a tiny cap so 3 browsers can e2e-test cap/eviction (see tests/voice/crowd-voice.cjs). One talker still only reaches cap-N listeners — bigger gatherings need an SFU.

## Presence badges: self-expiry + keepalive, never trust `off`
Any "X is doing Y" indicator relayed through a rate-limited channel needs client-side expiry (~6.5s) plus sender keepalive (~4s) — a throttled/dropped `off` event otherwise wedges the indicator on forever.

## Testing voice on this project
- Headless: fake `voiceSignal` payloads prove RELAY rules only (server never parses SDP). Seeded players all spawn at grass spawn → "near pair" is free; for a far player, first ACCEPTED move is the baseline but unpainted/void tiles are rejected — emit candidates and confirm via another socket's `playerMoved` echo instead of assuming (coords use TILE_PX=48, not the 16px asset size).
- Round section: `roundStart` + 2× `roundJoin`, then a real 30s `ROUND_JOIN_MS` wait — budget it; skip gracefully on `roundError` (a real round may be live on dev).
- Browser: ungoogled-chromium 114 honors `--use-fake-ui-for-media-stream --use-fake-device-for-media-stream`; use TWO incognito contexts or the second tab auto-resumes the first tab's login from shared localStorage. Expose a `window._voiceDebug()` snapshot (peer states, transceiver `currentDirection`s, badge ids) — closure state is unreachable from puppeteer otherwise.
