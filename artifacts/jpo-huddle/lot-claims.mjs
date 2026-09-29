// Home records hold possessions, not land ownership. Only this additive table
// assigns land. Never delete a home, inventory item, or placement to free a lot.
export async function migrateLotClaims(pool) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(73194621)");
    await client.query(`CREATE TABLE IF NOT EXISTS jpo_neighborhood_lots (
      lot_index integer PRIMARY KEY,
      display_index integer NOT NULL UNIQUE,
      owner_email text UNIQUE REFERENCES jpo_homes(owner_email) ON DELETE SET NULL,
      claimed_at timestamptz
    )`);
    // Empty table is the one-time migration marker. The transaction makes the
    // complete frozen street and retained claims visible together.
    const { rows } = await client.query("SELECT 1 FROM jpo_neighborhood_lots LIMIT 1");
    if (!rows.length) {
      await client.query(`INSERT INTO jpo_neighborhood_lots (lot_index, display_index, owner_email, claimed_at)
        SELECT h.lot_index, row_number() OVER (ORDER BY h.lot_index),
          CASE WHEN h.floor_built OR h.walls_built OR h.roof_built
            OR coalesce(h.exterior_color, 'teal') <> 'teal'
            OR EXISTS (SELECT 1 FROM jpo_home_layout_items l WHERE l.home_owner_email=h.owner_email)
          THEN h.owner_email END,
          CASE WHEN h.floor_built OR h.walls_built OR h.roof_built
            OR coalesce(h.exterior_color, 'teal') <> 'teal'
            OR EXISTS (SELECT 1 FROM jpo_home_layout_items l WHERE l.home_owner_email=h.owner_email)
          THEN now() END
        FROM jpo_homes h JOIN jpo_players p ON p.email=h.owner_email
        WHERE p.approved=true
          AND lower(p.email) !~ '^huddle-[ab](-[a-z0-9]+)?@justpressone[.]com$'
        ORDER BY h.lot_index`);
      // Four blocks across, five rows minimum. Existing dense positions and
      // permanent addresses are retained, including holes released above.
      await client.query(`INSERT INTO jpo_neighborhood_lots (lot_index, display_index)
        SELECT b.max_lot + n, b.count + n
        FROM (SELECT coalesce(max(lot_index),0) AS max_lot, count(*)::integer AS count
              FROM jpo_neighborhood_lots) b
        CROSS JOIN LATERAL generate_series(1, greatest(160-b.count,0)) n`);
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

// Caller validates live server position. Account row lock serializes two tabs
// choosing different lots; conditional UPDATE serializes competing owners.
export async function claimNeighborhoodLot(pool, email, lotIndex) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const player = await client.query("SELECT email FROM jpo_players WHERE email=$1 AND approved=true FOR UPDATE", [email]);
    if (!player.rows.length) return await finish({ ok: false, code: "unauthorized", message: "An approved account is required." });
    const owned = await client.query("SELECT lot_index FROM jpo_neighborhood_lots WHERE owner_email=$1", [email]);
    if (owned.rows.length) return await finish(Number(owned.rows[0].lot_index) === lotIndex
      ? { ok: true, lotIndex, alreadyClaimed: true, message: "This is your lot." }
      : { ok: false, code: "already_owned", message: "You already own a lot." });
    await client.query(`INSERT INTO jpo_homes (owner_email)
      SELECT $1 WHERE NOT EXISTS (SELECT 1 FROM jpo_homes WHERE owner_email=$1)
      ON CONFLICT (owner_email) DO NOTHING`, [email]);
    const claim = await client.query(`UPDATE jpo_neighborhood_lots
      SET owner_email=$1, claimed_at=now()
      WHERE lot_index=$2 AND owner_email IS NULL RETURNING lot_index`, [email, lotIndex]);
    if (!claim.rows.length) {
      const free = await client.query("SELECT 1 FROM jpo_neighborhood_lots WHERE owner_email IS NULL LIMIT 1");
      return await finish({ ok: false, code: free.rows.length ? "claimed" : "sold_out",
        message: free.rows.length ? "Someone claimed this lot first. Choose another available lot." : "All lots are claimed." });
    }
    return await finish({ ok: true, lotIndex, message: "Lot claimed! You can now build your home." });
    async function finish(result) {
      await client.query(result.ok ? "COMMIT" : "ROLLBACK");
      return result;
    }
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}