import { pgTable, text, integer, boolean, timestamp, jsonb } from "drizzle-orm/pg-core";
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
  // Usable/consumable items: itemId → remaining uses (e.g. {"cigarette": 4,
  // "coffee": 1}). Unlike cosmetics (permanent, worn), these deplete on use.
  items: jsonb("items").$type<Record<string, number>>().notNull().default(sql`'{}'::jsonb`),
  approved: boolean("approved").notNull().default(false),
  isAnnouncer: boolean("is_announcer").notNull().default(false),
  x: integer("x").notNull().default(1080),
  y: integer("y").notNull().default(840),
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
