import { pgTable, text, integer, boolean, timestamp } from "drizzle-orm/pg-core";
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
  character: text("character").notNull().default("adam"),
  hairIdx: integer("hair_idx").notNull().default(0),
  skinIdx: integer("skin_idx").notNull().default(0),
  shirtIdx: integer("shirt_idx").notNull().default(0),
  pantsIdx: integer("pants_idx").notNull().default(0),
  coins: integer("coins").notNull().default(50),
  cosmetics: text("cosmetics").array().notNull().default(sql`'{}'::text[]`),
  approved: boolean("approved").notNull().default(false),
  isAnnouncer: boolean("is_announcer").notNull().default(false),
  x: integer("x").notNull().default(1080),
  y: integer("y").notNull().default(840),
  dir: text("dir").notNull().default("down"),
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
