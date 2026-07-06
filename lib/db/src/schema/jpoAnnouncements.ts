import { pgTable, text, serial, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

// Office announcement board posts. `board` names the individual board cluster a
// post was made at; the client filters posts per board.
export const jpoAnnouncementsTable = pgTable("jpo_announcements", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  text: text("text").notNull(),
  board: text("board").notNull().default("office"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertJpoAnnouncementSchema = createInsertSchema(jpoAnnouncementsTable).omit({
  id: true,
  createdAt: true,
});
export type InsertJpoAnnouncement = z.infer<typeof insertJpoAnnouncementSchema>;
export type JpoAnnouncement = typeof jpoAnnouncementsTable.$inferSelect;
