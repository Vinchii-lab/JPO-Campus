// Build-handshake contract: the server pushes its stamp on connect; a client
// that never emits clientBuild (pre-handshake tab) gets the refresh nag after
// ~5s; a handshaking client never sees the nag. Run: TEST_PORT=<port> node.
import { io } from "socket.io-client";
const URL = `http://localhost:${process.env.TEST_PORT}`;
const fails = [];
const ok = (c, l) => { console.log((c ? "  ✓ " : "  ✗ ") + l); if (!c) fails.push(l); };

const stale = io(URL, { transports: ["websocket"], reconnection: false });
let stamp = null, nag = null;
stale.on("buildStamp", (p) => { stamp = p && p.stamp; });
stale.on("interactError", (p) => { nag = p && p.message; });

const fresh = io(URL, { transports: ["websocket"], reconnection: false });
let freshNag = null;
fresh.on("buildStamp", (p) => fresh.emit("clientBuild", { b: String(p.stamp) }));
fresh.on("interactError", (p) => { freshNag = p && p.message; });

await new Promise((r) => setTimeout(r, 8000));
ok(!!stamp, `buildStamp arrives on connect (stamp=${stamp})`);
ok(!!nag && /refresh/i.test(nag), `stale client nagged after ~5s: "${nag}"`);
ok(freshNag === null, "handshaking client gets NO nag");
stale.disconnect(); fresh.disconnect();
console.log(fails.length ? `RESULT: FAIL (${fails.join(" | ")})` : "RESULT: PASS");
process.exit(fails.length ? 1 : 0);
