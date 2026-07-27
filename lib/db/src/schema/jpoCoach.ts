import { pgTable, text, integer, boolean, timestamp, jsonb, date, primaryKey } from "drizzle-orm/pg-core";

// ── Huddles, the AI connection coach ─────────────────────────────────────────
// One row per player (lowercased email, same identity as jpo_players): their
// one-time intake answers plus TODAY's mission. Missions are one-per-UTC-day —
// mission_date + the conditional UPDATEs in server.js are the farm-proof gate
// (same pattern as last_daily_bonus). Mission payloads are small JSON objects
// {type, dept?, target_email?, target_name?, n?, flavor, reward, by} built
// server-side from a validated template allowlist — never raw AI output.
// NOTE: whisper CONTENT is never stored anywhere; whisper-mission progress is
// counted in memory only (the fact of an exchange, reset on restart).
export const jpoCoachTable = pgTable("jpo_coach", {
  email: text("email").primaryKey(),
  // Intake: what the player wants more of + departments they're curious about.
  // Structured multi-choice only ({goal, depts[]}) — no free text reaches the AI.
  intake: jsonb("intake").$type<{ goal?: string; depts?: string[] }>(),
  intakeAt: timestamp("intake_at", { withTimezone: true }),
  missionDate: date("mission_date"),
  mission: jsonb("mission").$type<Record<string, unknown>>(),
  missionDoneAt: timestamp("mission_done_at", { withTimezone: true }),
  // One re-roll per day; flips true on use (reset by the next day's generation).
  rerolled: boolean("rerolled").notNull().default(false),
});

export type JpoCoach = typeof jpoCoachTable.$inferSelect;

// Lifetime "who has played with whom" pair history — the memory behind
// "play with someone NEW" missions. One row per unordered pair: email_a is
// always the lexicographically smaller email (enforced by the server before
// upsert). Counts only FINISHED duels (draws included, forfeits excluded).
export const jpoPairPlaysTable = pgTable(
  "jpo_pair_plays",
  {
    emailA: text("email_a").notNull(),
    emailB: text("email_b").notNull(),
    games: integer("games").notNull().default(0),
    firstPlayedAt: timestamp("first_played_at", { withTimezone: true }).notNull().defaultNow(),
    lastPlayedAt: timestamp("last_played_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.emailA, t.emailB] })],
);

export type JpoPairPlay = typeof jpoPairPlaysTable.$inferSelect;
