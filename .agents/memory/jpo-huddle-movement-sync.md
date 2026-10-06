---
name: Movement synchronization boundaries
description: Prevent stale movement replay and keep client input ordering separate from server position revisions.
---
Ordinary walking samples must not queue through disconnected or backpressured Socket.IO connections. Keep deliberate seat, furniture, and portal actions reliable.

**Why:** Socket.IO normally buffers emits while disconnected; replaying historical walking positions causes visible backward jumps and cascaded corrections.

Scope movement and corrections to their map. Keep inbound client ordering separate from server-owned movement revisions.

**Why:** A delayed correction can otherwise snap the player to coordinates from another map. Using client sequence numbers as outbound server revisions also lets an oversized client number suppress later legitimate server movement.

Treat reconnect as an authoritative scene synchronization, not only a socket restart.

**Why:** City/neighborhood positions survive a short disconnect through the server's in-memory grace snapshot; absent that snapshot (or if the neighborhood directory cannot be refreshed), restore falls back to HQ. A surviving scene can keep sending the wrong map ID forever unless the server explicitly synchronizes the scene and roster.

**How to apply:** Test stale packets, connection interruption outside HQ, a server teleport followed by honest client movement, and HQ roster reconciliation after waking its sleeping scene. Do not relax speed or collision checks to hide corrections.

An authenticated replacement can arrive before the server detects the old transport's disconnect.

**Why:** Deleting the old live player before disconnect cleanup means that cleanup cannot create a grace snapshot. Even a short browser network interruption can then lose its outdoor location without the grace timer ever starting.

**How to apply:** Preserve the live outdoor snapshot for the authenticated resume before removing the old player, then reuse the normal restore checks. Test both disconnect-first and replacement-first ordering. Do not fix this by blindly running disconnect first: game settlement, seat cleanup and one-session identity have separate invariants. Browser offline duration is not the server's disconnect-to-resume interval.

Treat a local position correction as a prediction-origin boundary, not just a coordinate assignment.

**Why:** With healthy rendering, one short TCP stall can initiate sustained backwards/forwards corrections: the server accepts pre-correction samples while its correction travels to the client, then rejects the client's corrected coordinates as a reverse-speed jump. A production-handler deterministic trace at 60Hz, 300ms RTT and one 150ms upstream stall reproduced 59 speed rejects and 22 visible resets in 12 seconds, long after the stall ended. This does not require a doorway or slow rendering.

**How to apply:** Fence old-origin walking samples until correction receipt is acknowledged; preserve server speed/collision checks and reliable action validation. Exercise both HQ and neighborhood with healthy and high-Hz frames, delayed/bunched delivery, old clients, map changes and reconnects. One successful door crossing or a server-only waypoint test does not establish sustained walking quality. Deterministic network/physics models prove the feedback defect, not that it explains every live report.

Arrival-time spacing is not movement-sampling spacing when TCP bundles delayed updates.

**Why:** Even with correction acknowledgement, the first old packet can consume a stall's entire time allowance; the next legitimate current packet is then falsely rejected. Preventing a repeating correction loop does not prevent that initial snap.

**How to apply:** Preserve unused server-earned time across bundled samples, with client sample intervals only allocating—not creating—that time. Keep the total capped, never bank fixed pixel or seat-snap allowances, and reset on correction or authoritative anchor changes. Verify repeated jitter and forged-clock traces, not only one stall.

An authoritative office arrival must reconcile seated/standing state as well as coordinates.

**Why:** A surviving seated OfficeScene has disabled Arcade physics. When session grace expires, the server can restore an idle lawn spawn; a coordinate-only reset leaves that body disabled and old seat state active.

**How to apply:** Clear old seat anchors and occluders, enable/reset physics for standing arrivals, and reapply seating only when the authoritative snapshot says seated. Do not reset a legitimate seated resume to standing.