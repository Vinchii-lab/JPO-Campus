// Authoritative neighborhood definitions.  These maps are intentionally
// compact, deterministic, and editable source data rather than flattened
// screenshots or a client-provided tilemap.
export const HOME_GRID = { width: 12, height: 9, cell: 48 };
export const LOCATIONS = Object.freeze({
  office: { id: "office", label: "JPO HQ", spawn: { x: 1272, y: 2253, dir: "down" }, bounds: null },
  city: { id: "city", label: "Huddle Plaza", spawn: { x: 480, y: 720, dir: "down" }, bounds: { width: 1152, height: 912 } },
  "furniture-shop": { id: "furniture-shop", label: "Huddle Home", spawn: { x: 528, y: 672, dir: "down" }, bounds: { width: 1056, height: 816 } },
});
// This is the shared world contract for the client map and server validator.
// Coordinates are world pixels and blockers are intentionally generous around
// building art so an avatar cannot clip through a facade/checkout counter.
export const LOCATION_GEOMETRY = Object.freeze({
  city: {
    blockers: [
      { x: 48, y: 48, width: 300, height: 250 }, { x: 804, y: 48, width: 300, height: 250 },
      { x: 48, y: 610, width: 300, height: 250 }, { x: 804, y: 610, width: 300, height: 250 },
      { x: 422, y: 320, width: 308, height: 190 },
    ],
    doors: [
      { destination: "office", x: 486, y: 96, width: 180, height: 54 },
      { destination: "furniture-shop", x: 852, y: 560, width: 150, height: 54 },
    ],
  },
  "furniture-shop": {
    blockers: [
      { x: 0, y: 0, width: 1056, height: 92 }, { x: 0, y: 740, width: 1056, height: 76 },
      { x: 0, y: 0, width: 72, height: 816 }, { x: 984, y: 0, width: 72, height: 816 },
      { x: 180, y: 190, width: 670, height: 105 },
    ],
    doors: [{ destination: "city", x: 468, y: 735, width: 120, height: 81 }],
  },
  home: { blockers: [], doors: [{ destination: "city", x: 240, y: 384, width: 96, height: 48 }] },
});

export const FURNITURE_CATALOG = Object.freeze({
  oak_chair:   { id: "oak_chair",   name: "Oak chair",       price: 90,  width: 1, height: 1, color: "#a96d43", rotations: [0, 90, 180, 270] },
  fern:        { id: "fern",        name: "Plaza fern",      price: 130, width: 1, height: 1, color: "#4f9253", rotations: [0] },
  reading_lamp:{ id: "reading_lamp",name: "Reading lamp",    price: 160, width: 1, height: 1, color: "#e6bd57", rotations: [0, 90, 180, 270] },
  coffee_table:{ id: "coffee_table",name: "Coffee table",    price: 280, width: 2, height: 1, color: "#805b42", rotations: [0, 90, 180, 270] },
  blue_sofa:   { id: "blue_sofa",   name: "Blue sofa",       price: 460, width: 2, height: 1, color: "#537ca5", rotations: [0, 180] },
  bookcase:    { id: "bookcase",    name: "Bookcase",        price: 520, width: 1, height: 2, color: "#79513d", rotations: [0, 90, 180, 270] },
});

export function parseLocation(value) {
  if (value === "office" || value === "city" || value === "furniture-shop") return { id: value, kind: value };
  if (typeof value === "string" && value.startsWith("home:")) {
    const ownerEmail = value.slice(5).trim().toLowerCase();
    // Canonicalize BOTH the owner and room id.  A case-variant client must not
    // be able to join a second room that permission revocation cannot find.
    if (/^[^\s@]{1,64}@[^\s@]{1,64}\.[^\s@]{2,63}$/.test(ownerEmail) && ownerEmail.length <= 80)
      return { id: `home:${ownerEmail}`, kind: "home", ownerEmail };
  }
  return null;
}

export function locationSpawn(location) {
  if (location.kind === "home") return { x: 6 * HOME_GRID.cell + 24, y: 7 * HOME_GRID.cell + 24, dir: "up" };
  return { ...LOCATIONS[location.id].spawn };
}

export function locationBounds(location) {
  if (location.kind === "home") return { width: HOME_GRID.width * HOME_GRID.cell, height: HOME_GRID.height * HOME_GRID.cell };
  return LOCATIONS[location.id].bounds;
}

export function pointHitsRect(x, y, rect, radius = 16) {
  return x + radius > rect.x && x - radius < rect.x + rect.width &&
    y + radius > rect.y && y - radius < rect.y + rect.height;
}

export function validLocationMove(location, x, y, dynamicBlockers = []) {
  const b = locationBounds(location);
  if (b && (x < 16 || y < 16 || x > b.width - 16 || y > b.height - 16)) return false;
  const geometry = LOCATION_GEOMETRY[location.kind === "home" ? "home" : location.id];
  return ![...(geometry?.blockers || []), ...dynamicBlockers].some((rect) => pointHitsRect(x, y, rect));
}

export function furnitureFootprint(item, rotation) {
  const quarter = Number(rotation) % 180;
  return quarter === 90 ? { width: item.height, height: item.width } : { width: item.width, height: item.height };
}

export function validPlacement(item, x, y, rotation, otherItems) {
  if (!item || !item.rotations.includes(rotation) || !Number.isInteger(x) || !Number.isInteger(y)) return false;
  const f = furnitureFootprint(item, rotation);
  // The bottom-centre entry strip is permanently clear, so furniture can never
  // block the door and strand visitors.
  if (x < 0 || y < 0 || x + f.width > HOME_GRID.width || y + f.height > HOME_GRID.height ||
      (y + f.height > HOME_GRID.height - 1 && x <= 6 && x + f.width > 5)) return false;
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
  const { rows } = await pool.query(`SELECT owner_email, access_mode, layout_revision FROM jpo_homes WHERE owner_email=$1`, [email]);
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

export async function homeSnapshot(pool, ownerEmail, viewerEmail) {
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
    else layout.push({ ...view, gridX: row.grid_x, gridY: row.grid_y, rotation: row.rotation });
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
    canEdit: ownerEmail === viewerEmail, inventory, layout, invitations,
  };
}

// Safe directory projection: homes are discoverable only when public, owned
// by the requester, or explicitly invited. It deliberately omits layout,
// inventory, and any account data beyond the displayed name/email.
export async function homeDirectory(pool, viewerEmail) {
  const { rows } = await pool.query(
    `SELECT h.owner_email, h.access_mode,
            coalesce(nullif(p.nickname,''), p.first_name, p.name, h.owner_email) AS name
       FROM jpo_homes h JOIN jpo_players p ON p.email=h.owner_email
      WHERE h.access_mode='public' OR h.owner_email=$1 OR EXISTS (
        SELECT 1 FROM jpo_home_invitations i
         WHERE i.owner_email=h.owner_email AND i.invitee_email=$1 AND i.active=true
      )
      ORDER BY lower(coalesce(nullif(p.nickname,''), p.first_name, p.name, h.owner_email)), h.owner_email`,
    [viewerEmail],
  );
  return rows.map((row) => ({ ownerEmail: row.owner_email, name: row.name, accessMode: row.access_mode }));
}