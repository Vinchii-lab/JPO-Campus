// Authoritative neighborhood definitions.  These maps are intentionally
// compact, deterministic, and editable source data rather than flattened
// screenshots or a client-provided tilemap.
export const HOME_GRID = { width: 12, height: 9, cell: 48 };
// Exterior colors are identifiers rather than browser-provided hex values.
// They are persisted and projected to public home listings, so this small
// allowlist is the single safe contract for both the server and house art.
export const HOME_EXTERIOR_COLORS = Object.freeze({
  teal: { id: "teal", label: "Teal", hex: "#237c86" },
  terracotta: { id: "terracotta", label: "Terracotta", hex: "#b65b45" },
  plum: { id: "plum", label: "Plum", hex: "#76506f" },
  navy: { id: "navy", label: "Navy", hex: "#2f4f78" },
  sage: { id: "sage", label: "Sage", hex: "#70885f" },
});
export const DEFAULT_HOME_EXTERIOR_COLOR = "teal";

export function homeExteriorColor(value) {
  return typeof value === "string" && HOME_EXTERIOR_COLORS[value]
    ? value
    : DEFAULT_HOME_EXTERIOR_COLOR;
}
// Player positions are foot-centre coordinates. Both movement validation and
// the client Arcade collider use this radius, rather than separate magic
// margins that drift at facades and door thresholds.
export const ACTOR_FOOT_RADIUS = 16;
// These are physical residential streets, not destination-menu aliases.  The
// plaza is commerce and transit only; Willow Walk is the one personal-home
// address, while Maple Row and Juniper Square hold the directory residences.
export const RESIDENTIAL_BLOCK_IDS = Object.freeze(["maple-row", "juniper-square"]);
export const LOCATIONS = Object.freeze({
  office: { id: "office", label: "JPO HQ", spawn: { x: 1272, y: 2253, dir: "down" }, bounds: null },
  neighborhood: { id: "neighborhood", label: "Willow Walk", spawn: { x: 720, y: 912, dir: "up" }, bounds: { width: 1440, height: 1056 } },
  city: { id: "city", label: "Huddle Plaza", spawn: { x: 144, y: 480, dir: "right" }, bounds: { width: 1152, height: 912 } },
  "maple-row": { id: "maple-row", label: "Maple Row", spawn: { x: 96, y: 504, dir: "right" }, bounds: { width: 1152, height: 912 } },
  "juniper-square": { id: "juniper-square", label: "Juniper Square", spawn: { x: 576, y: 96, dir: "down" }, bounds: { width: 1152, height: 912 } },
  "furniture-shop": { id: "furniture-shop", label: "Huddle Home", spawn: { x: 480, y: 576, dir: "up" }, bounds: { width: 960, height: 720 } },
});
const RESIDENCE_CENTERS = Object.freeze([
  [180, 340], [420, 340], [732, 340], [972, 340],
  [180, 812], [420, 812], [732, 812], [972, 812],
]);
// The supplied house sprite's facade is 224px wide with a 72px centered
// doorway.  Keep this one source for every residential street: the visible
// footprint, server blocker, and walkable front path agree exactly.
const residenceBlockers = () => RESIDENCE_CENTERS.flatMap(([centerX, bottomY]) => [
  { x: centerX - 112, y: bottomY - 234, width: 224, height: 145 },
  { x: centerX - 112, y: bottomY - 89, width: 76, height: 90 },
  { x: centerX + 36, y: bottomY - 89, width: 76, height: 90 },
]);
const residenceDoors = () => RESIDENCE_CENTERS.map(([centerX, bottomY], lot) => ({
  destination: "home", residence: true, lot: lot + 1,
  x: centerX - 36, y: bottomY - 90, width: 72, height: 100,
  label: `Residence ${lot + 1}`,
}));
// This is the shared world contract for the client map and server validator.
// Every facade below has a matching explicit collider.  The narrow gaps are
// intentional paved doorways, never visual-only entrances.
export const LOCATION_GEOMETRY = Object.freeze({
  office: { blockers: [], doors: [] },
  neighborhood: {
    blockers: [
      // the townhouse leaves its centered front path open
      { x: 540, y: 92, width: 192, height: 150 }, { x: 540, y: 242, width: 62, height: 86 }, { x: 670, y: 242, width: 62, height: 86 },
      // tree colliders are trunk-sized (the canopy remains walk-behind art)
      { x: 405, y: 210, width: 50, height: 50 }, { x: 455, y: 678, width: 50, height: 50 },
      { x: 935, y: 698, width: 50, height: 50 }, { x: 91, y: 740, width: 50, height: 50 },
      { x: 1269, y: 164, width: 50, height: 50 }, { x: 305, y: 720, width: 50, height: 50 },
      { x: 486, y: 390, width: 28, height: 30 }, { x: 802, y: 390, width: 28, height: 30 },
      { x: 1146, y: 390, width: 28, height: 30 }, { x: 264, y: 390, width: 28, height: 30 },
      { x: 372, y: 574, width: 96, height: 30 }, { x: 852, y: 390, width: 96, height: 30 }, { x: 1052, y: 390, width: 96, height: 30 },
    ],
    doors: [
      { destination: "home", x: 602, y: 246, width: 68, height: 94, label: "Your townhouse" },
    ],
    seats: [
      { x: 420, y: 620, dir: "down" }, { x: 900, y: 436, dir: "down" }, { x: 1100, y: 436, dir: "down" },
    ],
  },
  city: {
    blockers: [
      // Closed Plaza Market facade. This used to be a second, color-mirrored
      // entrance to the authenticated player's Willow Walk home.
      { x: 178, y: 106, width: 224, height: 235 },
      { x: 760, y: 106, width: 224, height: 122 }, { x: 760, y: 228, width: 76, height: 100 }, { x: 908, y: 228, width: 76, height: 100 },
      // Only the fountain core blocks; the surrounding circular plaza and its
      // benches are deliberately walkable/sittable.
      { x: 542, y: 466, width: 68, height: 68 },
      { x: 95, y: 186, width: 50, height: 50 }, { x: 420, y: 160, width: 50, height: 50 },
      { x: 680, y: 156, width: 50, height: 50 }, { x: 1007, y: 174, width: 50, height: 50 },
      { x: 67, y: 678, width: 50, height: 50 }, { x: 1023, y: 686, width: 50, height: 50 },
      { x: 384, y: 354, width: 28, height: 30 }, { x: 730, y: 354, width: 28, height: 30 },
      { x: 388, y: 600, width: 28, height: 30 }, { x: 732, y: 600, width: 28, height: 30 },
      { x: 472, y: 364, width: 96, height: 30 }, { x: 582, y: 364, width: 96, height: 30 },
      { x: 472, y: 570, width: 96, height: 30 }, { x: 582, y: 570, width: 96, height: 30 },
    ],
    doors: [
      { destination: "furniture-shop", x: 836, y: 236, width: 72, height: 100, label: "Huddle Home" },
    ],
    seats: [
      { x: 520, y: 410, dir: "down" }, { x: 630, y: 410, dir: "down" },
      { x: 520, y: 616, dir: "down" }, { x: 630, y: 616, dir: "down" },
    ],
  },
  "maple-row": {
    blockers: [
      ...residenceBlockers(),
      { x: 62, y: 184, width: 50, height: 50 }, { x: 534, y: 184, width: 50, height: 50 },
      { x: 1090, y: 202, width: 50, height: 50 }, { x: 74, y: 706, width: 50, height: 50 },
      { x: 536, y: 730, width: 50, height: 50 }, { x: 1082, y: 706, width: 50, height: 50 },
    ],
    doors: residenceDoors(),
    seats: [{ x: 576, y: 410, dir: "down" }, { x: 576, y: 600, dir: "down" }],
  },
  "juniper-square": {
    blockers: [
      ...residenceBlockers(),
      { x: 62, y: 192, width: 50, height: 50 }, { x: 534, y: 200, width: 50, height: 50 },
      { x: 1090, y: 192, width: 50, height: 50 }, { x: 78, y: 706, width: 50, height: 50 },
      { x: 536, y: 718, width: 50, height: 50 }, { x: 1082, y: 716, width: 50, height: 50 },
    ],
    doors: residenceDoors(),
    seats: [{ x: 500, y: 500, dir: "down" }, { x: 652, y: 500, dir: "down" }],
  },
  "furniture-shop": {
    blockers: [
      { x: 0, y: 0, width: 960, height: 48 }, { x: 0, y: 0, width: 48, height: 720 }, { x: 912, y: 0, width: 48, height: 720 },
      { x: 0, y: 672, width: 408, height: 48 }, { x: 552, y: 672, width: 408, height: 48 },
      { x: 144, y: 154, width: 672, height: 74 }, { x: 140, y: 378, width: 156, height: 80 }, { x: 662, y: 378, width: 156, height: 80 },
    ],
    doors: [{ destination: "city", x: 408, y: 648, width: 144, height: 72, label: "Plaza exit" }],
  },
  home: {
    blockers: [
      { x: 0, y: 0, width: 576, height: 48 }, { x: 0, y: 0, width: 48, height: 432 }, { x: 528, y: 0, width: 48, height: 432 },
      { x: 0, y: 384, width: 240, height: 48 }, { x: 336, y: 384, width: 240, height: 48 },
    ],
    // Starts above the threshold, leaving a full floor-mat depth before the
    // map edge. This makes the automatic walking exit reachable without
    // pressing into an invisible boundary.
    doors: [{ destination: "neighborhood", x: 240, y: 360, width: 96, height: 72, label: "Willow Walk exit" }],
  },
});

// The only allowed map links. `spawn` is selected by the server based on the
// source portal, not supplied by a browser.
export const LOCATION_PORTALS = Object.freeze({
  office: [{ destination: "neighborhood", x: 96, y: 3552, width: 96, height: 144, spawn: { x: 720, y: 912, dir: "up" } }],
  neighborhood: [
    { destination: "office", x: 672, y: 912, width: 96, height: 144, spawn: { x: 216, y: 3624, dir: "right" } },
    { destination: "city", x: 1344, y: 432, width: 96, height: 144, spawn: { x: 144, y: 480, dir: "right" } },
    { destination: "home", x: 602, y: 246, width: 68, height: 94, spawn: { x: 288, y: 312, dir: "down" } },
  ],
  city: [
    { destination: "neighborhood", x: 0, y: 432, width: 96, height: 144, spawn: { x: 1248, y: 504, dir: "left" } },
    { destination: "furniture-shop", x: 836, y: 236, width: 72, height: 100, spawn: { x: 480, y: 576, dir: "up" } },
    { destination: "maple-row", x: 1056, y: 432, width: 96, height: 144, spawn: { x: 96, y: 504, dir: "right" } },
    { destination: "juniper-square", x: 528, y: 816, width: 96, height: 96, spawn: { x: 576, y: 96, dir: "down" } },
  ],
  "maple-row": [
    { destination: "city", x: 0, y: 432, width: 96, height: 144, spawn: { x: 1056, y: 504, dir: "left" } },
    ...residenceDoors().map((door) => ({ ...door, spawn: { x: 288, y: 312, dir: "down" } })),
  ],
  "juniper-square": [
    { destination: "city", x: 528, y: 0, width: 96, height: 96, spawn: { x: 576, y: 816, dir: "up" } },
    ...residenceDoors().map((door) => ({ ...door, spawn: { x: 288, y: 312, dir: "down" } })),
  ],
  "furniture-shop": [{ destination: "city", x: 408, y: 648, width: 144, height: 72, spawn: { x: 852, y: 360, dir: "down" } }],
  home: [{ destination: "neighborhood", x: 240, y: 360, width: 96, height: 72, spawn: { x: 636, y: 372, dir: "down" } }],
});

export const FURNITURE_CATALOG = Object.freeze({
  // Each image is an unmodified individual 16px-grid PNG from the uploaded
  // pack. Art is rendered at native 3× and bottom-anchored. Occupancy remains
  // the original catalog contract: an upper frame (plant leaves, lamp shade)
  // is presentation, never extra blocked floor or changed saved layouts.
  // IDs/prices deliberately remain stable for existing inventory instances.
  oak_chair:   { id: "oak_chair",   name: "Gold armchair",    price: 90,  width: 1, height: 1, color: "#b98743", rotations: [0] },
  fern:        { id: "fern",        name: "Potted fern",      price: 130, width: 1, height: 1, color: "#4f9253", rotations: [0] },
  reading_lamp:{ id: "reading_lamp",name: "Coral floor lamp", price: 160, width: 1, height: 1, color: "#d7634b", rotations: [0] },
  coffee_table:{ id: "coffee_table",name: "Plum low table",   price: 280, width: 2, height: 1, color: "#74637e", rotations: [0] },
  blue_sofa:   { id: "blue_sofa",   name: "Tan lounge sofa", price: 460, width: 2, height: 1, color: "#b77f45", rotations: [0] },
  bookcase:    { id: "bookcase",    name: "Gold bookcase",   price: 520, width: 1, height: 2, color: "#a87542", rotations: [0] },
});

export function parseLocation(value) {
  if (value === "office" || value === "neighborhood" || value === "city" || value === "maple-row" || value === "juniper-square" || value === "furniture-shop") return { id: value, kind: value };
  if (typeof value === "string" && value.startsWith("home:")) {
    const ownerEmail = value.slice(5).trim().toLowerCase();
    // Canonicalize BOTH the owner and room id.  A case-variant client must not
    // be able to join a second room that permission revocation cannot find.
    if (/^[^\s@]{1,64}@[^\s@]{1,64}\.[^\s@]{2,63}$/.test(ownerEmail) && ownerEmail.length <= 80)
      return { id: `home:${ownerEmail}`, kind: "home", ownerEmail };
  }
  return null;
}

export function locationSpawn(location, fromLocation = null) {
  if (fromLocation) {
    const from = parseLocation(fromLocation);
    const fromKind = from?.kind === "home" ? "home" : from?.id;
    const destination = location.kind === "home" ? "home" : location.id;
    const link = (LOCATION_PORTALS[fromKind] || []).find((portal) => portal.destination === destination);
    if (link?.spawn) return { ...link.spawn };
  }
  if (location.kind === "home") return { x: 6 * HOME_GRID.cell, y: 312, dir: "down" };
  return { ...LOCATIONS[location.id].spawn };
}

export function portalForTransition(fromLocation, destination, x, y, actorEmail = "") {
  const from = parseLocation(fromLocation), target = parseLocation(destination);
  if (!from || !target || !Number.isFinite(x) || !Number.isFinite(y)) return null;
  const fromKind = from.kind === "home" ? "home" : from.id;
  const targetKind = target.kind === "home" ? "home" : target.id;
  // Coworker visits are permission-gated by homeAccess in server.js and may
  // only be entered through a marked directory-residence door. A resident's
  // own Willow Walk townhouse remains the one direct personal-home door.
  if (targetKind === "home" && target.ownerEmail !== String(actorEmail).trim().toLowerCase() && !RESIDENTIAL_BLOCK_IDS.includes(fromKind)) return null;
  return (LOCATION_PORTALS[fromKind] || []).find((portal) =>
    portal.destination === targetKind && pointHitsRect(x, y, portal, 0)) || null;
}

export function locationBounds(location) {
  if (location.kind === "home") return { width: HOME_GRID.width * HOME_GRID.cell, height: HOME_GRID.height * HOME_GRID.cell };
  return LOCATIONS[location.id].bounds;
}

export function pointHitsRect(x, y, rect, radius = ACTOR_FOOT_RADIUS) {
  return x + radius > rect.x && x - radius < rect.x + rect.width &&
    y + radius > rect.y && y - radius < rect.y + rect.height;
}

export function validLocationMove(location, x, y, dynamicBlockers = []) {
  const b = locationBounds(location);
  if (b && (x < ACTOR_FOOT_RADIUS || y < ACTOR_FOOT_RADIUS || x > b.width - ACTOR_FOOT_RADIUS || y > b.height - ACTOR_FOOT_RADIUS)) return false;
  const geometry = LOCATION_GEOMETRY[location.kind === "home" ? "home" : location.id];
  return ![...(geometry?.blockers || []), ...dynamicBlockers].some((rect) => pointHitsRect(x, y, rect));
}

// Persisted layouts predate the upright-art policy. This is the one canonical
// interpretation used by snapshots, collision, and placement validation.
export function effectiveRotation(item, rotation) {
  const value = Number(rotation);
  return item?.rotations?.includes(value) ? value : 0;
}

export function furnitureFootprint(item, rotation) {
  const quarter = effectiveRotation(item, rotation) % 180;
  return quarter === 90 ? { width: item.height, height: item.width } : { width: item.width, height: item.height };
}

export function validPlacement(item, x, y, rotation, otherItems) {
  if (!item || !item.rotations.includes(rotation) || !Number.isInteger(x) || !Number.isInteger(y)) return false;
  const f = furnitureFootprint(item, rotation);
  // The spawn-to-door entry strip is permanently clear, so furniture can never
  // trap a visitor at arrival or block the front door.
  if (x < 0 || y < 0 || x + f.width > HOME_GRID.width || y + f.height > HOME_GRID.height ||
      // Preserve the spawn and a two-tile route from it to the front door.
      (x < 7 && x + f.width > 5 && y < 9 && y + f.height > 6)) return false;
  return !otherItems.some((placed) => {
    const of = furnitureFootprint(placed.item, placed.rotation);
    return x < placed.gridX + of.width && x + f.width > placed.gridX &&
      y < placed.gridY + of.height && y + f.height > placed.gridY;
  });
}

export function layoutBlockers(layout) {
  return (layout || []).flatMap((placed) => {
    const item = FURNITURE_CATALOG[placed.furnitureId];
    if (!item) return [];
    const footprint = furnitureFootprint(item, placed.rotation);
    return [{ x: placed.gridX * HOME_GRID.cell, y: placed.gridY * HOME_GRID.cell,
      width: footprint.width * HOME_GRID.cell, height: footprint.height * HOME_GRID.cell, furnitureId: placed.furnitureId }];
  });
}

export async function ensureHome(pool, email) {
  await pool.query(
    `INSERT INTO jpo_homes (owner_email) VALUES ($1) ON CONFLICT (owner_email) DO NOTHING`,
    [email],
  );
  const { rows } = await pool.query(
    `SELECT owner_email, access_mode, layout_revision, exterior_color FROM jpo_homes WHERE owner_email=$1`,
    [email],
  );
  return rows[0] || null;
}

export async function homeAccess(pool, ownerEmail, visitorEmail) {
  const home = await ensureHome(pool, ownerEmail);
  if (!home) return { ok: false, code: "not_found" };
  if (ownerEmail === visitorEmail || home.access_mode === "public") return { ok: true, home };
  if (home.access_mode !== "invite_only") return { ok: false, code: "denied", home };
  const { rows } = await pool.query(
    `SELECT 1 FROM jpo_home_invitations WHERE owner_email=$1 AND invitee_email=$2 AND active=true`,
    [ownerEmail, visitorEmail],
  );
  return { ok: !!rows[0], code: rows[0] ? null : "denied", home };
}

// A legacy 90°/270° record was made when the UI rotated a bitmap even though
// no matching directional art existed. Normalize it under the home row lock.
// If its upright footprint now conflicts, remove only the layout row: the
// furniture row remains in inventory, so no purchased item is lost.
export async function repairLegacyLayout(pool, ownerEmail) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await ensureHome(client, ownerEmail);
    await client.query(`SELECT owner_email FROM jpo_homes WHERE owner_email=$1 FOR UPDATE`, [ownerEmail]);
    const { rows } = await client.query(
      `SELECT l.furniture_instance_id, l.grid_x, l.grid_y, l.rotation, f.furniture_id
         FROM jpo_home_layout_items l
         JOIN jpo_home_furniture f ON f.id=l.furniture_instance_id
        WHERE l.home_owner_email=$1
        ORDER BY l.updated_at, l.furniture_instance_id
        FOR UPDATE OF l`,
      [ownerEmail],
    );
    const canonical = rows.filter((row) => {
      const item = FURNITURE_CATALOG[row.furniture_id];
      return item && effectiveRotation(item, row.rotation) === Number(row.rotation);
    }).map((row) => ({
      gridX: row.grid_x, gridY: row.grid_y, rotation: row.rotation, item: FURNITURE_CATALOG[row.furniture_id],
    }));
    let changed = false;
    for (const row of rows) {
      const item = FURNITURE_CATALOG[row.furniture_id];
      if (!item || effectiveRotation(item, row.rotation) === Number(row.rotation)) continue;
      // Treat already canonical entries as fixed occupants; legacy entries are
      // considered in stable update order so only the conflicting legacy item
      // is returned to inventory.
      if (validPlacement(item, row.grid_x, row.grid_y, 0, canonical)) {
        await client.query(`UPDATE jpo_home_layout_items SET rotation=0, updated_at=now() WHERE furniture_instance_id=$1`, [row.furniture_instance_id]);
        canonical.push({ gridX: row.grid_x, gridY: row.grid_y, rotation: 0, item });
      } else {
        await client.query(`DELETE FROM jpo_home_layout_items WHERE furniture_instance_id=$1`, [row.furniture_instance_id]);
      }
      changed = true;
    }
    if (changed) await client.query(`UPDATE jpo_homes SET layout_revision=layout_revision+1, updated_at=now() WHERE owner_email=$1`, [ownerEmail]);
    await client.query("COMMIT");
    return changed;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export async function homeSnapshot(pool, ownerEmail, viewerEmail) {
  await repairLegacyLayout(pool, ownerEmail);
  const home = await ensureHome(pool, ownerEmail);
  const { rows } = await pool.query(
    `SELECT f.id, f.furniture_id, l.grid_x, l.grid_y, l.rotation
       FROM jpo_home_furniture f
       LEFT JOIN jpo_home_layout_items l ON l.furniture_instance_id=f.id
      WHERE f.owner_email=$1 ORDER BY f.acquired_at, f.id`,
    [ownerEmail],
  );
  const inventory = [], layout = [];
  for (const row of rows) {
    const catalog = FURNITURE_CATALOG[row.furniture_id];
    if (!catalog) continue;
    const view = { id: row.id, furnitureId: row.furniture_id };
    if (row.grid_x == null) inventory.push(view);
    else layout.push({ ...view, gridX: row.grid_x, gridY: row.grid_y, rotation: effectiveRotation(catalog, row.rotation) });
  }
  const invitations = ownerEmail === viewerEmail
    ? (await pool.query(
      `SELECT i.invitee_email, coalesce(nullif(p.nickname,''), p.first_name, p.name, i.invitee_email) AS name
         FROM jpo_home_invitations i LEFT JOIN jpo_players p ON p.email=i.invitee_email
        WHERE i.owner_email=$1 AND i.active=true ORDER BY name, i.invitee_email`,
      [ownerEmail],
    )).rows.map((row) => ({ email: row.invitee_email, name: row.name }))
    : undefined;
  return {
    ownerEmail, accessMode: home.access_mode, revision: home.layout_revision,
    // Old home rows created before this optional column's default is applied
    // remain visually teal without needing a backfill.
    exteriorColor: homeExteriorColor(home.exterior_color),
    canEdit: ownerEmail === viewerEmail, inventory, layout, invitations,
  };
}

// Safe directory projection: homes are discoverable only when public, owned
// by the requester, or explicitly invited. It deliberately omits layout,
// inventory, and any account data beyond the displayed name/email.
export async function homeDirectory(pool, viewerEmail, requestedPage = 0, pageSize = 8) {
  // Page by a bounded, immutable account order. The selected residence remains
  // its owner email on the client/server transition, never this transient page
  // index or a visual lot, so another account joining cannot redirect a visit.
  const limit = Math.max(1, Math.min(8, Number.isInteger(requestedPage) ? pageSize : 8));
  const page = Math.max(0, Number.isInteger(requestedPage) ? requestedPage : 0);
  const { rows } = await pool.query(
    `SELECT h.owner_email, h.access_mode, h.exterior_color, count(*) OVER() AS total,
            coalesce(nullif(p.nickname,''), p.first_name, p.name, h.owner_email) AS name
       FROM jpo_homes h JOIN jpo_players p ON p.email=h.owner_email
       WHERE p.approved=true AND (h.access_mode='public' OR h.owner_email=$1 OR EXISTS (
        SELECT 1 FROM jpo_home_invitations i
         WHERE i.owner_email=h.owner_email AND i.invitee_email=$1 AND i.active=true
       ))
       ORDER BY p.created_at ASC, h.owner_email ASC
       LIMIT $2 OFFSET $3`,
    [viewerEmail, limit, page * limit],
  );
  const total = Number(rows[0]?.total || 0);
  return {
    homes: rows.map((row) => ({
      ownerEmail: row.owner_email, name: row.name, accessMode: row.access_mode,
      exteriorColor: homeExteriorColor(row.exterior_color),
    })),
    page, pageSize: limit, total, pageCount: Math.max(1, Math.ceil(total / limit)),
  };
}
