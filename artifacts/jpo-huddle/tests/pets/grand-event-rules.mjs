import assert from "node:assert/strict";
import {
  GRAND_EVENT_ALLOWED_COUNTS,
  grandEventBattleDecision,
  grandEventOpeningPlan,
} from "../../grand-event-rules.mjs";

const expected = {
  8:  { label: "Quarterfinals", byes: 0, matches: 4 },
  10: { label: "Play-In Round", byes: 6, matches: 2 },
  12: { label: "Play-In Round", byes: 4, matches: 4 },
  14: { label: "Play-In Round", byes: 2, matches: 6 },
  16: { label: "Round of 16", byes: 0, matches: 8 },
};

for (const count of GRAND_EVENT_ALLOWED_COUNTS) {
  const emails = Array.from({ length: count }, (_, i) => `seed-${i + 1}@test.local`);
  const plan = grandEventOpeningPlan(count, emails);
  assert.equal(plan.label, expected[count].label);
  assert.equal(plan.byes.length, expected[count].byes);
  assert.equal(plan.participants.length / 2, expected[count].matches);
  assert.deepEqual([...plan.byes, ...plan.participants], emails, `${count}: deterministic registration seeding`);
}
assert.throws(() => grandEventOpeningPlan(9, Array(9).fill("x")), /8, 10, 12, 14, or 16/);

const decide = (overrides) => grandEventBattleDecision({
  challengerHp: 20,
  opponentHp: 20,
  round: 1,
  maxRounds: 6,
  suddenDeath: false,
  ...overrides,
});
assert.deepEqual(decide({ challengerHp: 0, opponentHp: 0 }), {
  action: "overtime-reset", suddenDeath: true, winnerSide: null,
});
assert.deepEqual(decide({ challengerHp: 0, opponentHp: 7 }), {
  action: "finish", suddenDeath: false, winnerSide: "opponent",
});
assert.deepEqual(decide({ challengerHp: 12, opponentHp: 12, round: 6 }), {
  action: "continue", suddenDeath: true, winnerSide: null,
});
assert.deepEqual(decide({ challengerHp: 12, opponentHp: 10, round: 6 }), {
  action: "finish", suddenDeath: false, winnerSide: "challenger",
});
assert.deepEqual(decide({ challengerHp: 8, opponentHp: 7, suddenDeath: true }), {
  action: "finish", suddenDeath: true, winnerSide: "challenger",
});
assert.deepEqual(decide({ challengerHp: 8, opponentHp: 8, suddenDeath: true }), {
  action: "continue", suddenDeath: true, winnerSide: null,
});
assert.deepEqual(decide({
  challengerHp: 8,
  opponentHp: 8,
  suddenDeath: true,
  suddenDeathExchanges: 12,
}), {
  action: "seed-tiebreak", suddenDeath: true, winnerSide: null,
});

console.log("Grand Event bracket + sudden-death contract: PASS");