---
name: JPO Huddle server integration testing
description: How to verify the jpo-huddle socket.io game server end-to-end without a browser
---

The jpo-huddle server (`artifacts/jpo-huddle/server.js`) is a socket.io server — you
cannot verify its real behaviour with `curl`. To integration-test it headlessly:

- Install `socket.io-client` in a throwaway dir **outside** the workspace (e.g.
  `/tmp/jpotest`, `npm init -y` + `npm install socket.io-client`) so you don't
  pollute workspace deps, then run a Node ESM script there.
- Connect directly to the server's assigned port (`http://localhost:$PORT` — read
  the actual port from the jpo-huddle workflow logs; it's stable across restarts
  for a given artifact). `io(URL, { transports:["websocket"] })`.
- The admin flow needs `ADMIN_PASSWORD`; the script inherits it from
  `process.env` when run via bash, so you can authenticate without ever printing
  the secret value.
- Full persistence loop worth re-running after server changes: admin `adminAuth` →
  player `register` → read admin `pendingList` for the target socket id →
  `approvePlayer` → `buyCosmetic` → `postAnnouncement`, then **restart the
  workflow** and reconnect with the same email to confirm the player is auto-restored
  (approved, coins, cosmetics, announcer status, announcements all survive).

**Why:** this loop is the only way to catch regressions in the DB-as-source-of-truth
wiring; unit-level checks miss the socket payload shapes the un-editable client depends on.
