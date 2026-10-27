import { seasonNow } from "./season.mjs";

export const CHRISTMAS_REWARDS = Object.freeze({ daily: 100, delivery: 150 });
export async function migrateChristmas(pool) {
  await pool.query(`CREATE TABLE IF NOT EXISTS jpo_christmas_days (
    email text NOT NULL, day text NOT NULL, season_year integer NOT NULL,
    daily_claimed boolean NOT NULL DEFAULT false,
    delivery_stage text NOT NULL DEFAULT 'ready',
    contributed boolean NOT NULL DEFAULT false,
    PRIMARY KEY(email, day)
  )`);
  await pool.query(`CREATE INDEX IF NOT EXISTS jpo_christmas_tree_year ON jpo_christmas_days(season_year) WHERE contributed`);
}

export function christmasGate(player, action, locations, date = new Date()) {
  if (seasonNow(date) !== "christmas") return "Christmas activities are available during the active Christmas season.";
  if (!player?.email) return "Sign in to join Christmas activities.";
  if (player.locationId !== "office") return "Return to HQ for Christmas activities.";
  const target = action === "pickup" ? locations.pickup : action === "deliver" ? locations.destination
    : action === "contribute" ? locations.tree : null;
  if (target && (!Number.isFinite(player.x) || !Number.isFinite(player.y) ||
      Math.hypot(player.x - target.x, player.y - target.y) > 160)) return `Walk closer to ${target.label}.`;
  return null;
}

export function registerChristmas({ socket, pool, io, getPlayer, locations, isBusy = () => false, clock = () => new Date() }) {
  let running = false, requestedAt = 0;
  const state = async () => {
    const player = getPlayer();
    if (!player?.email) return;
    const now = clock(), day = now.toISOString().slice(0, 10), year = now.getUTCFullYear();
    if (seasonNow(now) !== "christmas") {
      socket.emit("christmasState", { active: false, seasonYear: year, date: day });
      return;
    }
    const { rows } = await pool.query(`SELECT * FROM jpo_christmas_days WHERE email=$1 AND day=$2`, [player.email, day]);
    const total = await pool.query(`SELECT count(*)::integer AS n FROM jpo_christmas_days WHERE season_year=$1 AND contributed`, [year]);
    if (getPlayer() !== player) return;
    const row = rows[0];
    socket.emit("christmasState", {
      active: true, seasonYear: year, date: day, dailyClaimed: !!row?.daily_claimed,
      delivery: { stage: row?.delivery_stage || "ready", pickup: locations.pickup, destination: locations.destination },
      tree: { contributions: total.rows[0].n, goal: 100, ...locations.tree },
      contributed: !!row?.contributed, rewards: CHRISTMAS_REWARDS,
    });
  };
  socket.on("christmasRequest", async () => {
    if (!getPlayer()?.email) return;
    if (Date.now() - requestedAt < 1000) return;
    requestedAt = Date.now();
    try { await state(); } catch (error) {
      console.error("Christmas state failed:", error);
      socket.emit("christmasError", { message: "Christmas activities are temporarily unavailable." });
    }
  });
  for (const [event, action] of Object.entries({
    christmasClaimDaily: "daily", christmasPickup: "pickup",
    christmasDeliver: "deliver", christmasContribute: "contribute",
  })) socket.on(event, async () => {
    if (running) return;
    running = true;
    let db, committed = false;
    try {
      const player = getPlayer(), now = clock();
      const error = christmasGate(player, action, locations, now);
      if (error) throw new Error(error);
      if (isBusy(player)) throw new Error("Finish your current game before joining Christmas activities.");
      const day = now.toISOString().slice(0, 10), year = now.getUTCFullYear();
      db = await pool.connect();
      await db.query("BEGIN");
      await db.query(`INSERT INTO jpo_christmas_days(email,day,season_year) VALUES($1,$2,$3) ON CONFLICT DO NOTHING`, [player.email, day, year]);
      const { rows } = await db.query(`SELECT * FROM jpo_christmas_days WHERE email=$1 AND day=$2 FOR UPDATE`, [player.email, day]);
      // Revalidate after database waits: a portal/game/disconnect may have won.
      if (getPlayer() !== player) throw new Error("Your session changed. Please try again.");
      const stale = christmasGate(player, action, locations, clock());
      if (stale || isBusy(player)) throw new Error(stale || "Finish your current game first.");
      if (clock().toISOString().slice(0, 10) !== day) throw new Error("A new day has started. Please try again.");
      const row = rows[0];
      let award = 0;
      if (action === "daily") {
        if (row.daily_claimed) throw new Error("Today's gift has already been claimed.");
        await db.query(`UPDATE jpo_christmas_days SET daily_claimed=true WHERE email=$1 AND day=$2`, [player.email, day]);
        award = CHRISTMAS_REWARDS.daily;
      } else if (action === "pickup") {
        if (row.delivery_stage !== "ready") throw new Error("You already picked up today's present.");
        await db.query(`UPDATE jpo_christmas_days SET delivery_stage='carrying' WHERE email=$1 AND day=$2`, [player.email, day]);
      } else if (action === "deliver") {
        if (row.delivery_stage !== "carrying") throw new Error("Pick up today's present first, or return tomorrow if finished.");
        await db.query(`UPDATE jpo_christmas_days SET delivery_stage='done' WHERE email=$1 AND day=$2`, [player.email, day]);
        award = CHRISTMAS_REWARDS.delivery;
      } else {
        if (row.contributed) throw new Error("You already added today's ornament.");
        await db.query(`UPDATE jpo_christmas_days SET contributed=true WHERE email=$1 AND day=$2`, [player.email, day]);
      }
      let coins;
      if (award) {
        const updated = await db.query(`UPDATE jpo_players SET coins=coins+$2 WHERE email=$1 RETURNING coins`, [player.email, award]);
        if (!updated.rows[0]) throw new Error("Your account is unavailable.");
        coins = updated.rows[0].coins;
      }
      await db.query("COMMIT");
      committed = true;
      if (coins !== undefined && getPlayer() === player) {
        player.coins = coins;
        socket.emit("coinUpdate", { coins });
      }
      if (action === "contribute") io.emit("christmasTreeChanged");
      await state();
    } catch (error) {
      if (db && !committed) await db.query("ROLLBACK").catch(() => {});
      console.error("Christmas action failed:", error.message);
      const expected = /^(Christmas activities|Sign in|Return to HQ|Walk closer|Finish your|Your session|A new day|Today's gift|You already|Pick up|Your account)/.test(error.message || "");
      socket.emit("christmasError", { message: committed
        ? "Your action was saved, but the display could not refresh. Reopen the Holiday Desk."
        : expected ? error.message : "Christmas activities are temporarily unavailable." });
    } finally {
      db?.release();
      running = false;
    }
  });
}
