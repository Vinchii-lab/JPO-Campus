---
name: Movement synchronization boundaries
description: Prevent stale movement replay and keep client input ordering separate from server position revisions.
---
Ordinary walking samples must not queue through disconnected or backpressured Socket.IO connections. Keep deliberate seat, furniture, and portal actions reliable.

**Why:** Socket.IO normally buffers emits while disconnected; replaying historical walking positions causes visible backward jumps and cascaded corrections.

Scope movement and corrections to their map. Keep inbound client ordering separate from server-owned movement revisions.

**Why:** A delayed correction can otherwise snap the player to coordinates from another map. Using client sequence numbers as outbound server revisions also lets an oversized client number suppress later legitimate server movement.

Treat reconnect as an authoritative scene synchronization, not only a socket restart.

**Why:** The server's existing restore policy returns players to HQ. A surviving neighborhood scene can keep sending a different map ID forever unless the server explicitly synchronizes the scene and roster.

**How to apply:** Test stale packets, connection interruption outside HQ, a server teleport followed by honest client movement, and HQ roster reconciliation after waking its sleeping scene. Do not relax speed or collision checks to hide corrections.