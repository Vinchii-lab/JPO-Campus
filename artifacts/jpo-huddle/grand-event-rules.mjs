export const GRAND_EVENT_ALLOWED_COUNTS = Object.freeze([8, 10, 12, 14, 16]);

export function grandEventOpeningPlan(count, seededEmails) {
  if (!GRAND_EVENT_ALLOWED_COUNTS.includes(count) || seededEmails.length !== count) {
    throw new Error("Grand Event requires a seeded roster of 8, 10, 12, 14, or 16 entrants.");
  }
  if (count === 8) {
    return { byes: [], key: "quarterfinal", label: "Quarterfinals", participants: [...seededEmails] };
  }
  if (count === 16) {
    return { byes: [], key: "opening", label: "Round of 16", participants: [...seededEmails] };
  }
  const byeCount = 16 - count;
  return {
    byes: seededEmails.slice(0, byeCount),
    key: "opening",
    label: "Play-In Round",
    participants: seededEmails.slice(byeCount),
  };
}

export function grandEventBattleDecision({
  challengerHp,
  opponentHp,
  round,
  maxRounds,
  suddenDeath,
  suddenDeathExchanges = 0,
}) {
  const a = Number(challengerHp);
  const d = Number(opponentHp);
  // Identical builds and mirrored RNG can theoretically remain level forever.
  // After twelve actual overtime exchanges, advance by the pre-established
  // tournament seed rather than permit an unbounded match.
  if (suddenDeath && suddenDeathExchanges >= 12 && a === d) {
    return { action: "seed-tiebreak", suddenDeath: true, winnerSide: null };
  }
  if (a <= 0 && d <= 0) {
    return { action: "overtime-reset", suddenDeath: true, winnerSide: null };
  }
  if (a <= 0 || d <= 0) {
    return { action: "finish", suddenDeath: !!suddenDeath, winnerSide: a > d ? "challenger" : "opponent" };
  }
  if (suddenDeath) {
    if (a !== d) {
      return { action: "finish", suddenDeath: true, winnerSide: a > d ? "challenger" : "opponent" };
    }
    return { action: "continue", suddenDeath: true, winnerSide: null };
  }
  if (round >= maxRounds) {
    if (a === d) return { action: "continue", suddenDeath: true, winnerSide: null };
    return { action: "finish", suddenDeath: false, winnerSide: a > d ? "challenger" : "opponent" };
  }
  return { action: "continue", suddenDeath: false, winnerSide: null };
}