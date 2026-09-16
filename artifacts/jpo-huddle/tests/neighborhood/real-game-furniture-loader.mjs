// Test-only loader for real-game-furniture.mjs.
//
// This deliberately changes one exact source file (server.js), and only the
// exact, per-run QA owner/guest identities supplied by the harness. It is not
// a production feature and must never be enabled by the normal server start.
// The owner is placed in the showroom on their first restore and in their
// seeded home on later restores; the guest is placed in that same home.

import { fileURLToPath, pathToFileURL } from "node:url";
import { resolve } from "node:path";

const SERVER_URL = pathToFileURL(resolve(
  fileURLToPath(new URL("../../server.js", import.meta.url)),
)).href;

export async function load(url, context, nextLoad) {
  const loaded = await nextLoad(url, context);
  if (url !== SERVER_URL || loaded.format !== "module") return loaded;

  const owner = String(process.env.REAL_GAME_QA_OWNER_EMAIL || "").trim().toLowerCase();
  const guest = String(process.env.REAL_GAME_QA_GUEST_EMAIL || "").trim().toLowerCase();
  if (!owner || !guest) {
    throw new Error("real-game loader requires REAL_GAME_QA_OWNER_EMAIL and REAL_GAME_QA_GUEST_EMAIL");
  }

  // Keep this replacement narrow and fail closed if server.js changes shape.
  // The injected identities are generated for one run, never a wildcard.
  const marker = '  return {\n    // Location membership is deliberately live-session state.';
  if (!String(loaded.source).includes(marker)) {
    throw new Error("real-game loader could not find rowToPlayerState marker");
  }

  const ownerLiteral = JSON.stringify(owner);
  const guestLiteral = JSON.stringify(guest);
  const homeSpawn = String(process.env.REAL_GAME_QA_HOME_SPAWN || "").trim();
  let homeSpawnLiteral = "null";
  if (homeSpawn) {
    try {
      const parsed = JSON.parse(homeSpawn);
      if (![parsed?.x, parsed?.y].every(Number.isFinite)) throw new Error("invalid focus spawn");
      homeSpawnLiteral = JSON.stringify({
        x: Number(parsed.x), y: Number(parsed.y), dir: String(parsed.dir || "down"),
      });
    } catch {
      throw new Error("real-game loader received invalid REAL_GAME_QA_HOME_SPAWN");
    }
  }
  const injected = `  const qaOwnerEmail = ${ownerLiteral};
  const qaGuestEmail = ${guestLiteral};
  const qaHomeSpawn = ${homeSpawnLiteral};
  let qaSpawn = null;
  if (row.email === qaOwnerEmail) {
    // rowToPlayerState is called once per authenticated restore. The first
    // owner restore is the showroom pass; a fresh registration/reload then
    // gets the real seeded home. No other row is affected.
    const restoreNumber = (globalThis.__realGameQaOwnerRestores =
      (globalThis.__realGameQaOwnerRestores || 0) + 1);
    qaSpawn = restoreNumber === 1
      ? { locationId: "furniture-shop", x: 480, y: 576, dir: "up" }
      : { locationId: "home:" + qaOwnerEmail,
        x: qaHomeSpawn?.x ?? 576, y: qaHomeSpawn?.y ?? 720,
        dir: qaHomeSpawn?.dir || "down" };
  } else if (row.email === qaGuestEmail) {
    qaSpawn = { locationId: "home:" + qaOwnerEmail,
      x: qaHomeSpawn?.x ?? 576, y: qaHomeSpawn?.y ?? 720,
      dir: qaHomeSpawn?.dir || "down" };
  }
  return {
    // Location membership is deliberately live-session state.`;

  let source = String(loaded.source).replace(marker, injected);
  source = source.replace(
    '    locationId: "office",',
    '    locationId: qaSpawn?.locationId || "office",',
  );
  source = source.replace(
    '    x: officeSpawn.x, y: officeSpawn.y, dir: officeSpawn.dir, anim: "idle",',
    '    x: qaSpawn?.x ?? officeSpawn.x, y: qaSpawn?.y ?? officeSpawn.y, dir: qaSpawn?.dir || officeSpawn.dir, anim: "idle",',
  );

  // A normal restore intentionally sends a compact transition packet because
  // the previous client session has already loaded its map catalog. The first
  // QA owner restore is deliberately a cold direct Huddle Home entry, though,
  // so it needs the same real catalog/showroom payload that a portal
  // transition supplies. Without this narrow addition the client hides the
  // legacy shop props before it can render replacement catalog chairs.
  const resumeTransitionMarker = `  socket.emit("locationTransitionResult", {
    ok: true, reason: "resume", location: state.locationId,
    spawn: { x: state.x, y: state.y, dir: state.dir },
    map: locationInfo(state.locationId), self: movementPayload(socket.id, state),
    players: locationPlayers(socket.id),
  });`;
  if (!source.includes(resumeTransitionMarker)) {
    throw new Error("real-game loader could not find restore transition marker");
  }
  source = source.replace(resumeTransitionMarker, `  socket.emit("locationTransitionResult", {
    ok: true, reason: "resume", location: state.locationId,
    spawn: { x: state.x, y: state.y, dir: state.dir },
    map: locationInfo(state.locationId), self: movementPayload(socket.id, state),
    players: locationPlayers(socket.id),
    // This test-only seam applies only to its generated owner/guest accounts.
    // It preserves production's compact restore packets for every other user.
    catalog: (state.email === ${ownerLiteral} || state.email === ${guestLiteral}) &&
      state.locationId === "furniture-shop" ? FURNITURE_CATALOG : undefined,
    showroom: (state.email === ${ownerLiteral} || state.email === ${guestLiteral}) &&
      state.locationId === "furniture-shop" ? furnitureShowroomDemos() : undefined,
  });`);

  // Test-only canonical home bootstrap. A second owner restore can overlap
  // the production disconnect grace window from the showroom page; preserve
  // the loader's authored home spawn instead of restoring that old showroom
  // coordinate. The real homeSnapshotRequest bootstrap below then supplies
  // the same authoritative transition payload a normal portal sends.
  const graceMarker = '  if (g && Number.isFinite(g.x) && Number.isFinite(g.y)) {';
  if (!source.includes(graceMarker)) {
    throw new Error("real-game loader could not find restore grace marker");
  }
  source = source.replace(
    graceMarker,
    `  if (g && Number.isFinite(g.x) && Number.isFinite(g.y) &&
      !(state.email === ${ownerLiteral} && String(state.locationId || "").startsWith("home:"))) {`,
  );

  const snapshotEmitMarker =
    '      if (players[socket.id] === p && locationOf(p) === parsed.id && snapshot) socket.emit("homeSnapshot", snapshot);';
  if (!source.includes(snapshotEmitMarker)) {
    throw new Error("real-game loader could not find home snapshot emit marker");
  }
  const snapshotBootstrap = `      // Test-only canonical initialization for the exact QA accounts:
      // a direct resume has no catalog in its resume event, so the first
      // homeSnapshotRequest supplies the complete production transition seam.
      const qaHomeBootstrap = !socket.__realGameQaHomeBootstrapSent &&
        (p.email === ${ownerLiteral} || p.email === ${guestLiteral}) &&
        parsed?.kind === "home" && snapshot;
      if (qaHomeBootstrap) {
        socket.__realGameQaHomeBootstrapSent = true;
        const qaHomeInfo = locationInfo(parsed.id);
        socket.emit("locationTransitionResult", {
          ok: true, location: parsed.id, reason: "qa-home-bootstrap",
          spawn: { x: p.x, y: p.y, dir: p.dir },
          map: qaHomeInfo, self: movementPayload(socket.id, p),
          players: locationPlayers(socket.id), home: snapshot,
          homeColor: homeExteriorColor(snapshot.exteriorColor),
          catalog: FURNITURE_CATALOG,
        });
        socket.emit("currentPlayers", filterPlayersForLocation(
          phMaskedPlayers(socket.id), parsed.id,
        ));
      }
${snapshotEmitMarker}`;
  source = source.replace(snapshotEmitMarker, snapshotBootstrap);

  return { ...loaded, source };
}