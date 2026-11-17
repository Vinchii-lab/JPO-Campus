// Serialize account entry and deletion so an in-flight login cannot restore a
// row after it has been deleted. Other accounts are never held up by this gate.
export function createAccountGate() {
  const tails = new Map();
  const deleting = new Set();
  const run = (email, action) => {
    const previous = tails.get(email) || Promise.resolve();
    const next = previous.catch(() => {}).then(action);
    tails.set(email, next);
    const cleanup = () => { if (tails.get(email) === next) tails.delete(email); };
    next.then(cleanup, cleanup);
    return next;
  };
  return {
    isDeleting: email => deleting.has(email),
    enter(email, action) {
      if (deleting.has(email)) return Promise.reject(new Error("This account is being deleted. Please wait."));
      return run(email, action);
    },
    async remove(email, action) {
      if (deleting.has(email)) throw new Error("Deletion is already in progress for this account.");
      deleting.add(email);
      try { return await run(email, action); }
      finally { deleting.delete(email); }
    },
  };
}

export function normalizeAccountEmail(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

export async function deleteRegisteredAccount({
  pool, gate, email, confirmEmail, actorEmail, authorized, busyReason, disconnect, rewardLiability,
}) {
  if (!authorized) throw new Error("Only the owner can permanently delete accounts.");
  const target = normalizeAccountEmail(email);
  if (!target || target.length > 80 || !target.includes("@")) throw new Error("Choose a valid registered email.");
  if (normalizeAccountEmail(confirmEmail) !== target) throw new Error("Type the account's email exactly to confirm deletion.");
  const actor = normalizeAccountEmail(actorEmail);
  if (!actor) throw new Error("Sign into your own account before deleting another account.");
  if (target === actor) throw new Error("You cannot delete your own account.");

  return gate.remove(target, async () => {
    const db = await pool.connect();
    try {
      await db.query("BEGIN");
      const { rows } = await db.query(
        "SELECT email, name FROM jpo_players WHERE email = $1 FOR UPDATE", [target]);
      if (!rows[0]) throw new Error("This account no longer exists. Refresh the registered list.");
      const { rows: market } = await db.query(
        `SELECT EXISTS(SELECT 1 FROM jpo_store_listings WHERE seller_email = $1)
             OR EXISTS(SELECT 1 FROM jpo_store_bids WHERE bidder_email = $1) AS busy`, [target]);
      if (market[0]?.busy) throw new Error("Resolve this user's shop listings and bids before deleting their account.");
      const rewardReason = await rewardLiability?.(db, target);
      if (rewardReason) throw new Error(rewardReason);
      const reason = busyReason(target);
      if (reason) throw new Error(reason);
      // Remove live/pending sessions before the DELETE is sent. The gate rejects
      // new login attempts until commit/rollback; no active games reach here.
      // On DB failure the account stays intact and can sign in again.
      disconnect(target);
      await db.query("DELETE FROM jpo_coach WHERE email = $1", [target]);
      const deleted = await db.query("DELETE FROM jpo_players WHERE email = $1 RETURNING email", [target]);
      if (deleted.rowCount !== 1) throw new Error("The account could not be deleted.");
      // Home/inventory FKs cascade; lots become unowned. Shared messages, audit
      // records, reward limits and settlement history are deliberately retained.
      await db.query("COMMIT");
      return rows[0];
    } catch (error) {
      await db.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      db.release();
    }
  });
}
