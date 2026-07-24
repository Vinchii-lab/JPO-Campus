import { pgTable, text, integer, boolean, timestamp, jsonb, date } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

// One row per person, keyed by their (lowercased) email — the stable identity
// across reconnects and server restarts. Coins, cosmetics, approval and
// announcer status all survive here so the JPO Huddle office is durable.
export const jpoPlayersTable = pgTable("jpo_players", {
  email: text("email").primaryKey(),
  firstName: text("first_name").notNull().default(""),
  lastName: text("last_name").notNull().default(""),
  name: text("name").notNull(),
  // In-game display name (shown on nametags/chat/announcements). Falls back to
  // firstName when empty; `name` stays the real full name for admins.
  nickname: text("nickname").notNull().default(""),
  // scrypt:<saltB64>:<hashB64>. NULL = legacy passwordless account: the first
  // register with this email claims it by setting a password (TOFU).
  passwordHash: text("password_hash"),
  // When the password was (re)set. Resume tokens issued BEFORE this moment are
  // rejected, so pre-password tokens can't bypass the new password gate.
  passwordSetAt: timestamp("password_set_at", { withTimezone: true }),
  character: text("character").notNull().default("adam"),
  hairIdx: integer("hair_idx").notNull().default(0),
  skinIdx: integer("skin_idx").notNull().default(0),
  shirtIdx: integer("shirt_idx").notNull().default(0),
  pantsIdx: integer("pants_idx").notNull().default(0),
  coins: integer("coins").notNull().default(50),
  cosmetics: text("cosmetics").array().notNull().default(sql`'{}'::text[]`),
  // Which owned cosmetic is currently worn/displayed ('' = none). Players own
  // many cosmetics but wear exactly one at a time.
  equippedCosmetic: text("equipped_cosmetic").notNull().default(""),
  // Usable/consumable items: itemId → remaining uses (e.g. {"cigarette": 4,
  // "coffee": 1}). Unlike cosmetics (permanent, worn), these deplete on use.
  items: jsonb("items").$type<Record<string, number>>().notNull().default(sql`'{}'::jsonb`),
  // Which owned pet currently follows this player around ('' = none). Pet
  // OWNERSHIP lives in the cosmetics array (ids prefixed 'pet_' so they can
  // never collide with wearable ids); this column is only the active choice,
  // exactly like equipped_cosmetic is for wearables.
  equippedPet: text("equipped_pet").notNull().default(""),
  // Which JustPressOne department this person belongs to ('' = not set yet —
  // legacy accounts pick one from their own profile card, once). Validated
  // server-side against a fixed allowlist shared with the client.
  department: text("department").notNull().default(""),
  // Lifetime win counts per game, e.g. {"rps": 3, "trivia": 1, "dark": 2}.
  // Keys are the server's game ids (duels) plus 'dark' for Office After Dark.
  // Incremented atomically at settlement time; draws move nothing.
  wins: jsonb("wins").$type<Record<string, number>>().notNull().default(sql`'{}'::jsonb`),
  // Free-text hobby shown on the profile card ('' = not set). Editable any
  // time from your own card; server-side length-capped and control-stripped.
  hobby: text("hobby").notNull().default(""),
  // Last calendar day (server/DB date, UTC) this player received the once-daily
  // login bonus. NULL = never granted. The grant is an atomic conditional UPDATE
  // (WHERE last_daily_bonus IS NULL OR < CURRENT_DATE) so re-logging can't farm it.
  lastDailyBonus: date("last_daily_bonus"),
  approved: boolean("approved").notNull().default(false),
  // Admin acted on this UNAPPROVED account (rejected the registration, or
  // kicked/revoked the player): keeps them out of the DB-backed pending queue
  // until they actively come back (register/sign-in/resume clears the flag).
  // Without this, the pending list — which survives the registrant closing
  // their tab — would show every rejected person forever.
  dismissed: boolean("dismissed").notNull().default(false),
  isAnnouncer: boolean("is_announcer").notNull().default(false),
  // New-registrant spawn: the lawn by the west entrance (tile 26,47 — same
  // spot as the server's GRASS_SPAWN void-rescue point). Keep in lockstep
  // with server.js GRASS_SPAWN and the client's SPAWN_X/SPAWN_Y fallback.
  x: integer("x").notNull().default(1272),
  y: integer("y").notNull().default(2253),
  dir: text("dir").notNull().default("down"),
  // 'sit' | 'idle' — persisted so a player who was sitting is restored SEATED
  // (not standing on their chair) after a refresh / server restart.
  anim: text("anim").notNull().default("idle"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export const insertJpoPlayerSchema = createInsertSchema(jpoPlayersTable).omit({
  createdAt: true,
  updatedAt: true,
});
export type InsertJpoPlayer = z.infer<typeof insertJpoPlayerSchema>;
export type JpoPlayer = typeof jpoPlayersTable.$inferSelect;
