import {
  boolean,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { jpoPlayersTable } from "./jpoPlayers";

// Personal homes deliberately live outside jpo_players.  A home is created on
// first use, which lets existing approved accounts receive the starter home
// without a data backfill or application-startup DDL.
export const jpoHomesTable = pgTable("jpo_homes", {
  ownerEmail: text("owner_email").primaryKey().references(() => jpoPlayersTable.email, { onDelete: "cascade" }),
  accessMode: text("access_mode").notNull().default("public"),
  layoutRevision: integer("layout_revision").notNull().default(0),
  // Nullable for existing rows during the publish-managed migration; callers
  // display null as the native teal starter roof.
  exteriorColor: text("exterior_color").default("teal"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// Furniture is instance based rather than a count map.  Consequently two
// identical chairs can be independently placed, rotated, or returned to the
// inventory without a destructive decrement.
export const jpoHomeFurnitureTable = pgTable(
  "jpo_home_furniture",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerEmail: text("owner_email").notNull().references(() => jpoHomesTable.ownerEmail, { onDelete: "cascade" }),
    furnitureId: text("furniture_id").notNull(),
    acquiredAt: timestamp("acquired_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("jpo_home_furniture_owner_instance").on(t.ownerEmail, t.id)],
);

// Absence from this table means the owned furniture instance is in inventory.
// The owner column makes the ownership check in the server mutation atomic and
// avoids trusting a client supplied home id.
export const jpoHomeLayoutItemsTable = pgTable("jpo_home_layout_items", {
  furnitureInstanceId: uuid("furniture_instance_id").primaryKey().references(() => jpoHomeFurnitureTable.id, { onDelete: "cascade" }),
  homeOwnerEmail: text("home_owner_email").notNull().references(() => jpoHomesTable.ownerEmail, { onDelete: "cascade" }),
  gridX: integer("grid_x").notNull(),
  gridY: integer("grid_y").notNull(),
  rotation: integer("rotation").notNull().default(0),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const jpoHomeInvitationsTable = pgTable(
  "jpo_home_invitations",
  {
    ownerEmail: text("owner_email").notNull().references(() => jpoHomesTable.ownerEmail, { onDelete: "cascade" }),
    inviteeEmail: text("invitee_email").notNull().references(() => jpoPlayersTable.email, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    // Kept for forward compatible soft revocation/auditing while all current
    // revocations delete the row.
    active: boolean("active").notNull().default(true),
  },
  (t) => [primaryKey({ columns: [t.ownerEmail, t.inviteeEmail] })],
);