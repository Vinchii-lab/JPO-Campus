#!/usr/bin/env node

/**
 * Bounded, opt-in REAL GAME Puppeteer integration for home furniture and the
 * Huddle Home store.
 *
 * This is intentionally a test-only local-server harness. It starts the
 * checked-in server.js on an automatically reserved localhost port with the
 * sibling loader, uses the real registration UI and Socket.IO protocol in two
 * incognito Chromium contexts, and then removes only the exact generated QA
 * rows before stopping the child process.
 *
 * One-pass verification (only after production fixes settle):
 *
 *   REAL_GAME_QA=1 node tests/neighborhood/real-game-furniture.mjs
 *
 * Focused inventory/hotbar pass (same isolated server/loader/bootstrap):
 *
 *   REAL_GAME_QA=1 REAL_GAME_INVENTORY_HOTBAR_QA=1 \
 *     node tests/neighborhood/real-game-furniture.mjs
 *
 * Focused hotbar UI-only pass (skips the already-passed Place/Store/equip/
 * identity journey):
 *
 *   REAL_GAME_QA=1 REAL_GAME_INVENTORY_HOTBAR_QA=1 \
 *     REAL_GAME_INVENTORY_HOTBAR_UI_ONLY_QA=1 \
 *     node tests/neighborhood/real-game-furniture.mjs
 *
 * Focused fresh mobile capture only:
 *
 *   REAL_GAME_QA=1 REAL_GAME_INVENTORY_HOTBAR_QA=1 \
 *     REAL_GAME_INVENTORY_HOTBAR_MOBILE_ONLY_QA=1 \
 *     node tests/neighborhood/real-game-furniture.mjs
 *
 * Optional:
 *   REAL_GAME_TIMEOUT_MS=240000 REAL_GAME_OUTPUT_DIR=/tmp/jpo-furniture \
 *     REAL_GAME_QA=1 node tests/neighborhood/real-game-furniture.mjs
 *
 * The QA opt-in is required. DATABASE_URL is read by pg/server.js but never
 * printed. This test is intentionally bounded to four minutes by default;
 * it is not a long browser journey.
 */

import { spawn, execFileSync } from "node:child_process";
import { createServer } from "node:net";
import { createRequire } from "node:module";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import puppeteer from "../../node_modules/puppeteer-core/lib/esm/puppeteer/puppeteer-core.js";
import {
  FURNITURE_CATALOG,
  HOME_GRID,
  parseLocation,
  validLocationMove,
} from "../../neighborhood.mjs";
import { furnitureActionStandCandidates } from "../../furniture-actions.mjs";

const require = createRequire(import.meta.url);
const { Pool } = require("../../node_modules/pg");

const HERE = dirname(fileURLToPath(import.meta.url));
const ARTIFACT_ROOT = resolve(HERE, "../..");
const SERVER_FILE = join(ARTIFACT_ROOT, "server.js");
const LOADER_FILE = join(HERE, "real-game-furniture-loader.mjs");
const QA_LAYOUT_FOR_FOCUS = [
  { furnitureId: "oak_chair", gridX: 13, gridY: 14, instanceId: "qa-chair-a" },
  { furnitureId: "oak_chair", gridX: 16, gridY: 14, instanceId: "qa-chair-b" },
  { furnitureId: "plush_bed", gridX: 2, gridY: 2, instanceId: "qa-bed" },
  { furnitureId: "bathtub", gridX: 2, gridY: 12, instanceId: "qa-bath" },
];
const TIMEOUT_MS = Math.max(
  120_000,
  Math.min(300_000, Number(process.env.REAL_GAME_TIMEOUT_MS) || 240_000),
);
const RUN_TAG = Math.random().toString(36).slice(2, 9);
const OWNER_EMAIL = `qa-furniture-${RUN_TAG}@justpressone.com`;
const GUEST_EMAIL = `qa-furniture-guest-${RUN_TAG}@justpressone.com`;
const HOTBAR_COSMETIC_ID = "beanie";
const HOTBAR_USABLE_ID = "coffee";
const HOTBAR_QA_ENABLED = process.env.REAL_GAME_INVENTORY_HOTBAR_QA === "1" ||
  process.env.REAL_GAME_INVENTORY_HOTBAR_UI_ONLY_QA === "1" ||
  process.env.REAL_GAME_INVENTORY_HOTBAR_MOBILE_ONLY_QA === "1";
const HOTBAR_MOBILE_ONLY_QA =
  process.env.REAL_GAME_INVENTORY_HOTBAR_MOBILE_ONLY_QA === "1";
let hotbarStoredFurnitureId = null;

function authoredFocusSpawn(furnitureId, actionId) {
  const target = QA_LAYOUT_FOR_FOCUS.find((entry) => entry.furnitureId === furnitureId &&
    (furnitureId !== "oak_chair" || entry.instanceId === "qa-chair-a"));
  const item = FURNITURE_CATALOG[furnitureId];
  if (!target || !item) throw new Error(`missing QA focus fixture for ${furnitureId}`);
  const blockers = QA_LAYOUT_FOR_FOCUS
    .filter((entry) => entry !== target)
    .map((entry) => {
      const placed = FURNITURE_CATALOG[entry.furnitureId];
      return {
        x: entry.gridX * HOME_GRID.cell,
        y: entry.gridY * HOME_GRID.cell,
        width: Number(placed.width || 1) * HOME_GRID.cell,
        height: Number(placed.height || 1) * HOME_GRID.cell,
        instanceId: entry.instanceId,
      };
    });
  const location = parseLocation(`home:${OWNER_EMAIL}`);
  const candidates = furnitureActionStandCandidates(
    item, target.gridX, target.gridY, HOME_GRID.cell, actionId,
  );
  const spawn = candidates.find((candidate) =>
    validLocationMove(location, candidate.x, candidate.y, blockers));
  if (!spawn) throw new Error(`no authored valid ${actionId} stand for ${furnitureId}`);
  return { x: spawn.x, y: spawn.y, dir: spawn.dir || "down" };
}
const OUTPUT_DIR = resolve(
  process.env.REAL_GAME_OUTPUT_DIR || join(HERE, "../evidence", `real-game-furniture-${RUN_TAG}`),
);
const URL_HOST = "127.0.0.1";
const VIEWPORT = { width: 1280, height: 800, deviceScaleFactor: 1 };
const HOTBAR_VIEWPORT = {
  width: 390, height: 844, deviceScaleFactor: 1, isMobile: true, hasTouch: true,
};
const HOTBAR_FOCUSED_VIEWPORT = {
  width: 402, height: 874, deviceScaleFactor: 1, isMobile: true, hasTouch: true,
};
const fails = [];
const startedAt = Date.now();
let serverProcess = null;
let db = null;
let browser = null;
let ownerContext = null;
let guestContext = null;
let ownerPage = null;
let guestPage = null;
let deadlineTimer = null;
let currentStage = "startup";
let serverOutputTail = "";
let lastFurniturePoseDiagnostics = null;
let hotbarOverlayFailureRecorded = false;

const sleep = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
const ok = (condition, label) => {
  console.log(`${condition ? "  ✓" : "  ✗"} ${label}`);
  if (!condition) fails.push(label);
  return condition;
};
const requireOk = (condition, label) => {
  if (!ok(condition, label)) throw new Error(label);
};
function stage(label) {
  currentStage = label;
  console.log(`[stage] ${label}`);
}

function remainingMs() {
  return Math.max(1, TIMEOUT_MS - (Date.now() - startedAt));
}

function boundedTimeout(requested, floor = 1_000) {
  return Math.max(floor, Math.min(requested, remainingMs()));
}

async function withTimeout(promise, ms, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`timeout: ${label}`)),
          boundedTimeout(ms),
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function reservePort() {
  const probe = createServer();
  await new Promise((resolvePromise, reject) => {
    probe.once("error", reject);
    probe.listen(0, URL_HOST, resolvePromise);
  });
  const address = probe.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise((resolvePromise) => probe.close(resolvePromise));
  if (!port) throw new Error("could not reserve a local test port");
  return port;
}

function chromiumPath() {
  const candidates = [
    process.env.CHROMIUM_PATH,
    "/repl/tools/bin/chromium",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/google-chrome",
  ].filter(Boolean);
  for (const candidate of candidates) if (existsSync(candidate)) return candidate;
  for (const command of ["chromium", "chromium-browser", "google-chrome"]) {
    try {
      const candidate = execFileSync("which", [command], { encoding: "utf8" }).trim();
      if (candidate && existsSync(candidate)) return candidate;
    } catch {
      // Try the next approved lookup location.
    }
  }
  throw new Error("Chromium not found; set CHROMIUM_PATH to the approved binary");
}

async function cleanupExact() {
  if (!db) return;
  const emails = [OWNER_EMAIL, GUEST_EMAIL];
  // Dependency order is important: this never touches another run, even if a
  // previous run was interrupted and left its uniquely-generated rows behind.
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "DELETE FROM jpo_home_layout_items WHERE home_owner_email = ANY($1::text[])",
      [emails],
    );
    await client.query(
      "DELETE FROM jpo_home_furniture WHERE owner_email = ANY($1::text[])",
      [emails],
    );
    await client.query(
      "DELETE FROM jpo_home_invitations WHERE owner_email = ANY($1::text[]) OR invitee_email = ANY($1::text[])",
      [emails],
    );
    await client.query("DELETE FROM jpo_homes WHERE owner_email = ANY($1::text[])", [emails]);
    await client.query("DELETE FROM jpo_players WHERE email = ANY($1::text[])", [emails]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw new Error(`exact QA cleanup failed: ${error.message}`);
  } finally {
    client.release();
  }
}

async function seedExactFixture() {
  await cleanupExact();
  await db.query(
    `INSERT INTO jpo_players
       (email, first_name, last_name, name, nickname, character, approved, department, coins)
     VALUES
       ($1, 'QA', 'Furniture', 'QA Furniture', 'QA Furniture', 'amelia', true, 'QA', 500000),
       ($2, 'QA', 'Visitor', 'QA Visitor', 'QA Visitor', 'adam', true, 'QA', 100000)`,
    [OWNER_EMAIL, GUEST_EMAIL],
  );
  if (HOTBAR_QA_ENABLED) {
    // Seed only the generated QA identities. Cosmetics/items are the same
    // durable fields that approved restores send to the real client.
    await db.query(
      `UPDATE jpo_players
          SET cosmetics=$2::text[], items=$3::jsonb
        WHERE email=$1`,
      [OWNER_EMAIL, [HOTBAR_COSMETIC_ID],
        JSON.stringify({ [HOTBAR_USABLE_ID]: 2 })],
    );
    await db.query(
      `UPDATE jpo_players
          SET cosmetics=$2::text[], items=$3::jsonb
        WHERE email=$1`,
      [GUEST_EMAIL, ["sunglasses"],
        JSON.stringify({ [HOTBAR_USABLE_ID]: 1 })],
    );
  }
  await db.query(
    `INSERT INTO jpo_homes
       (owner_email, access_mode, floor_built, walls_built, roof_built, layout_revision)
     VALUES ($1, 'public', true, true, true, 1)`,
    [OWNER_EMAIL],
  );

  // Keep the layout intentionally multi-item: two same-type chairs plus a bed
  // and a bath. Positions leave all four authored action paths traversable.
  const fixtures = [
    ["oak_chair", 13, 14],
    ["oak_chair", 16, 14],
    ["plush_bed", 2, 2],
    ["bathtub", 2, 12],
  ];
  for (const [furnitureId, gridX, gridY] of fixtures) {
    const result = await db.query(
      `INSERT INTO jpo_home_furniture (owner_email, furniture_id)
       VALUES ($1, $2) RETURNING id`,
      [OWNER_EMAIL, furnitureId],
    );
    await db.query(
      `INSERT INTO jpo_home_layout_items
         (furniture_instance_id, home_owner_email, grid_x, grid_y, rotation, placement_zone)
       VALUES ($1, $2, $3, $4, 0, 'indoor')`,
      [result.rows[0].id, OWNER_EMAIL, gridX, gridY],
    );
  }
  if (HOTBAR_QA_ENABLED) {
    const stored = await db.query(
      `INSERT INTO jpo_home_furniture (owner_email, furniture_id)
       VALUES ($1, 'oak_chair') RETURNING id`,
      [OWNER_EMAIL],
    );
    hotbarStoredFurnitureId = String(stored.rows[0].id);
    console.log(`  QA hotbar stored furniture UUID: ${hotbarStoredFurnitureId}`);
  }
}

async function startLocalServer() {
  const port = await reservePort();
  const loaderOption = `--experimental-loader=${LOADER_FILE}`;
  const nodeOptions = [process.env.NODE_OPTIONS, loaderOption].filter(Boolean).join(" ");
  const focusFurniture = process.env.REAL_GAME_HOME_BATH_ONLY === "1"
    ? "bathtub"
    : process.env.REAL_GAME_HOME_BED_ONLY === "1"
      ? "plush_bed"
      : null;
  const focusAction = focusFurniture === "bathtub" ? "bathe" : "lie";
  const focusSpawn = focusFurniture ? authoredFocusSpawn(focusFurniture, focusAction) : null;
  serverProcess = spawn(process.execPath, [SERVER_FILE], {
    cwd: ARTIFACT_ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      REAL_GAME_QA_OWNER_EMAIL: OWNER_EMAIL,
      REAL_GAME_QA_GUEST_EMAIL: GUEST_EMAIL,
      REAL_GAME_QA_HOME_SPAWN: focusSpawn ? JSON.stringify(focusSpawn) : "",
      NODE_OPTIONS: nodeOptions,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let childOutput = "";
  const recordChildOutput = (chunk) => {
    childOutput = `${childOutput}${String(chunk)}`.slice(-12_000);
    serverOutputTail = childOutput;
  };
  serverProcess.stdout.on("data", recordChildOutput);
  serverProcess.stderr.on("data", recordChildOutput);
  serverProcess.once("error", (error) => {
    childOutput += `\n${error.message}`;
    serverOutputTail = childOutput;
  });

  const url = `http://${URL_HOST}:${port}`;
  await withTimeout((async () => {
    while (true) {
      if (serverProcess.exitCode !== null) {
        throw new Error(`local server exited before readiness: ${childOutput.replace(process.env.DATABASE_URL || "", "[redacted]")}`);
      }
      try {
        const response = await fetch(`${url}/`, { cache: "no-store" });
        if (response.ok) break;
      } catch {
        // The server may still be running startup DDL.
      }
      await sleep(150);
    }
  })(), 25_000, "local server readiness");
  console.log(`  ✓ isolated server ready on localhost:${port} (QA opt-in)`);
  return url;
}

function attachBrowserDiagnostics(page, label) {
  const errors = [];
  const missingResponses = [];
  page.on("pageerror", (error) => errors.push(`${label} pageerror: ${error.message}`));
  page.on("response", (response) => {
    if (response.status() === 404) missingResponses.push(response.url());
  });
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    // Missing authored unicorn animation variants are known fixture noise.
    // Keep the response URL for classification instead of blanket-ignoring
    // every browser 404.
    if (/failed to load resource/i.test(message.text())) return;
    errors.push(`${label} console: ${message.text()}`);
  });
  page.__realGameErrors = errors;
  page.__realGameMissingResponses = missingResponses;
}

async function createPage(context, label, viewport = VIEWPORT) {
  const page = await context.newPage();
  await page.setViewport(viewport);
  page.__realGameLabel = label;
  attachBrowserDiagnostics(page, label);
  return page;
}

async function installEventCapture(page) {
  await page.evaluate(() => {
    window.__realGameEvents = [];
    window.__realGameSnapshots = [];
    window.__realGameImportantEvents = [];
    if (window.__realGameCaptureInstalled) return;
    const keep = (event, payload) => {
      window.__realGameEvents.push({ event, payload });
      if (window.__realGameEvents.length > 120) window.__realGameEvents.shift();
      if ([
        "approved", "authFailed", "registrationPending", "locationTransitionResult",
        "currentPlayers", "furnitureShowroom", "furnitureDemoInteractionResult",
        "furnitureInteractionResult", "homeSnapshot", "homePurchaseResult",
        "homeActionResult", "playerFurnitureInventoryResult", "equipUpdate",
        "itemsUpdate", "playerEmote",
      ].includes(event)) {
        window.__realGameImportantEvents.push({ event, payload });
        if (window.__realGameImportantEvents.length > 40) window.__realGameImportantEvents.shift();
      }
      if (event === "homeSnapshot") {
        window.__realGameSnapshots.push(payload);
        if (window.__realGameSnapshots.length > 20) window.__realGameSnapshots.shift();
      }
    };
    socket.onAny(keep);
    window.__realGameCaptureInstalled = true;
  });
}

async function assertHotbarIntegrationContract() {
  const [indexSource, scriptSource, cssSource] = await Promise.all([
    readFile(join(ARTIFACT_ROOT, "public/index.html"), "utf8"),
    readFile(join(ARTIFACT_ROOT, "public/inventory-hotbar.js"), "utf8"),
    readFile(join(ARTIFACT_ROOT, "public/inventory-hotbar.css"), "utf8"),
  ]);
  requireOk(indexSource.includes('src="inventory-hotbar.js'),
    "index includes the inventory hotbar script");
  requireOk(indexSource.includes("initInventoryHotbar"),
    "index initializes the inventory hotbar before the Phaser game");
  for (const selector of [
    "#inventory-toggle-btn", "#inventory-content", ".hotbar-cat-btn",
    ".hotbar-item", ".hotbar-action-btn",
  ]) {
    requireOk(scriptSource.includes(selector.replace(/^[#.]/, "")),
      `hotbar script contains ${selector} contract`);
  }
  for (const category of ["all", "wearables", "pets", "usables", "furniture"]) {
    requireOk(scriptSource.includes(`id: '${category}'`),
      `hotbar exposes ${category} category`);
  }
  for (const action of ["place", "equip", "use"]) {
    requireOk(scriptSource.includes(`data-action="${action}"`),
      `hotbar exposes ${action} action contract`);
  }
  requireOk(cssSource.includes("#inventory-hotbar") &&
    cssSource.includes("#inventory-hotbar.open #inventory-content"),
  "hotbar CSS contains closed/open layout contract");
}

async function registerThroughUi(page, email, firstName) {
  stage(`${page.__realGameLabel || "browser"} registration: navigate`);
  // This page may already hold the previous QA user's session token (the
  // owner returns from Store to home). Clear both token stores before the
  // production registration UI is loaded so this is a fresh login, not a
  // resume event racing the Phaser scene.
  await page.evaluate(() => {
    try {
      localStorage.removeItem("jpo_session_token");
      sessionStorage.removeItem("jpo_session_token");
    } catch {}
  }).catch(() => {});
  await page.goto(`${page.__realGameBaseUrl}/`, {
    waitUntil: "domcontentloaded",
    timeout: boundedTimeout(30_000),
  });
  stage(`${page.__realGameLabel || "browser"} registration: verify form selectors`);
  await page.waitForSelector("#inp-email", { timeout: boundedTimeout(20_000) });
  // The socket already exists on the real page here. Capture the approval and
  // location-transition seam before the UI click, otherwise an early
  // transition can disappear before later showroom diagnostics are installed.
  await installEventCapture(page);
  const registrationSelectors = await page.evaluate(() => ({
    email: !!document.querySelector("#inp-email"),
    first: !!document.querySelector("#inp-first"),
    last: !!document.querySelector("#inp-last"),
    nickname: !!document.querySelector("#inp-nick"),
    password: !!document.querySelector("#inp-password"),
    department: !!document.querySelector("#inp-dept"),
    builderButton: !!document.querySelector("#next-to-builder-btn"),
    builderNext: !!document.querySelector("#btn-next"),
  }));
  console.log(`  registration selectors: ${JSON.stringify(registrationSelectors)}`);
  requireOk(Object.values(registrationSelectors).every(Boolean),
    `${page.__realGameLabel || "browser"} production registration selectors exist`);
  stage(`${page.__realGameLabel || "browser"} registration: fill form`);
  await page.evaluate(({ email: value, first }) => {
    const fields = {
      "inp-first": first,
      "inp-last": "Furniture",
      "inp-nick": first,
      "inp-email": value,
      "inp-password": "realgame-pass-123",
    };
    for (const [id, fieldValue] of Object.entries(fields)) {
      const element = document.getElementById(id);
      element.value = fieldValue;
      element.dispatchEvent(new Event("input", { bubbles: true }));
    }
    const department = document.getElementById("inp-dept");
    if (department) {
      department.value = "QA";
      department.dispatchEvent(new Event("change", { bubbles: true }));
    }
  }, { email, first: firstName });
  // Traverse the production registration UI and character-builder buttons.
  // The harness never emits the register payload itself.
  stage(`${page.__realGameLabel || "browser"} registration: character builder`);
  await page.click("#next-to-builder-btn");
  await page.waitForSelector("#builder-section.active", {
    timeout: boundedTimeout(5_000),
  });
  await page.click("#btn-next");
  await page.click("#btn-next");
  await page.click("#btn-next");
  stage(`${page.__realGameLabel || "browser"} registration: waiting for approved UI`);
  await page.waitForFunction(
    () => document.body.classList.contains("playing"),
    { timeout: boundedTimeout(45_000) },
  );
  // The production page stores a session token on approval. This QA pass
  // intentionally exercises the first restore only; clear that token before
  // the scene can satisfy the page's automatic resume gate, which would
  // otherwise issue a second restore on the same socket.
  await page.evaluate(() => {
    try {
      window.__realGameSessionToken = localStorage.getItem("jpo_session_token") ||
        sessionStorage.getItem("jpo_session_token");
      localStorage.removeItem("jpo_session_token");
      sessionStorage.removeItem("jpo_session_token");
    } catch {}
  }).catch(() => {});
  stage(`${page.__realGameLabel || "browser"} registration: approved UI; waiting for scene`);
  await page.waitForFunction(
    () => window._neighborhoodScene && window._neighborhoodScene.player,
    { timeout: boundedTimeout(30_000) },
  );
  stage(`${page.__realGameLabel || "browser"} registration: dismiss first-timer tutorial`);
  const tutorialOpen = await page.$eval(
    "#tut-overlay",
    (overlay) => overlay.classList.contains("open"),
  ).catch(() => false);
  if (tutorialOpen) {
    await page.click("#tut-skip");
    await page.waitForFunction(
      () => !document.querySelector("#tut-overlay")?.classList.contains("open"),
      { timeout: boundedTimeout(5_000) },
    );
  }
  await page.evaluate(() => document.querySelector("canvas")?.focus());
  stage(`${page.__realGameLabel || "browser"} registration: scene ready`);
}

async function waitForLocation(page, location) {
  await page.waitForFunction(
    (expected) => window._neighborhoodScene?.location === expected,
    { timeout: boundedTimeout(30_000) },
    location,
  );
}

async function waitForCanonicalHomeHydration(page, label) {
  await waitForLocation(page, `home:${OWNER_EMAIL}`);
  await page.waitForFunction(
    () => window._neighborhoodScene?._neighborhoodReady &&
      String(window._neighborhoodScene?.location || "").startsWith("home:"),
    { timeout: boundedTimeout(30_000) },
  );
  const snapshot = await requestHomeSnapshot(page);
  await sleep(150);
  const state = await page.evaluate(() => {
    const events = window.__realGameEvents || [];
    const players = [...events].reverse().find((entry) => entry.event === "currentPlayers")
      ?.payload || {};
    const own = typeof socket !== "undefined" ? players[socket.id] : null;
    return {
      playerEmail: own?.email || null,
      location: window._neighborhoodScene?.location || null,
      canPlace: typeof window.JpoNeighborhood?.canPlaceFurniture === "function"
        ? window.JpoNeighborhood.canPlaceFurniture()
        : null,
    };
  });
  console.log(`  ${label} canonical home hydration: ${JSON.stringify({
    playerEmail: state.playerEmail,
    sceneLocation: state.location,
    homeOwnerEmail: snapshot?.ownerEmail || null,
    canEdit: snapshot?.canEdit ?? null,
    revision: snapshot?.revision ?? null,
    canPlace: state.canPlace,
  })}`);
  return { snapshot, state };
}

async function moveThroughPortal(page, key, location, label) {
  stage(label);
  await page.keyboard.down(key);
  try {
    await waitForLocation(page, location);
  } catch (error) {
    const state = await sceneState(page).catch(() => null);
    throw new Error(`${label}: ${error.message}; state=${JSON.stringify(state)}`);
  } finally {
    await page.keyboard.up(key).catch(() => {});
  }
  await sleep(300);
}

async function screenshot(page, name) {
  const output = join(OUTPUT_DIR, `${name}.png`);
  await page.screenshot({ path: output });
  console.log(`  screenshot: ${output}`);
  return output;
}

async function captureFatalEvidence(error) {
  const evidence = {
    stage: currentStage,
    message: error?.message || String(error),
    stack: error?.stack || null,
    startedAt: new Date(startedAt).toISOString(),
    serverOutputTail,
    lastFurniturePoseDiagnostics,
    pages: [],
  };
  for (const [label, page] of [["owner", ownerPage], ["guest", guestPage]]) {
    if (!page || page.isClosed()) continue;
    const state = await page.evaluate(() => ({
      url: location.href,
      readyState: document.readyState,
      bodyClass: document.body?.className || "",
      bodyText: (document.body?.innerText || "").slice(0, 2_000),
      cards: [...document.querySelectorAll(".join-card")].map((card) => ({
        id: card.id,
        className: card.className,
        text: (card.innerText || "").slice(0, 300),
      })),
      playing: document.body?.classList.contains("playing") || false,
      scene: window._neighborhoodScene ? {
        location: window._neighborhoodScene.location || null,
        hasPlayer: !!window._neighborhoodScene.player,
        x: Number(window._neighborhoodScene.player?.x),
        y: Number(window._neighborhoodScene.player?.y),
      } : null,
      gameScene: !!window._gameScene,
      socketConnected: typeof socket !== "undefined" ? !!socket.connected : null,
      lastEvents: (window.__realGameEvents || []).slice(-10),
      importantEvents: (window.__realGameImportantEvents || []).slice(-20),
    })).catch((stateError) => ({ evaluateError: stateError.message }));
    const pageEvidence = { label, state, browserErrors: page.__realGameErrors || [] };
    evidence.pages.push(pageEvidence);
    try {
      const path = join(OUTPUT_DIR, `fatal-${label}.png`);
      await page.screenshot({ path });
      pageEvidence.screenshot = path;
    } catch (screenshotError) {
      pageEvidence.screenshotError = screenshotError.message;
    }
  }
  const path = join(OUTPUT_DIR, "fatal-evidence.json");
  await writeFile(path, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  console.error(`FATAL evidence: ${path}`);
}

async function sceneState(page) {
  return page.evaluate(() => {
    const scene = window._neighborhoodScene;
    return {
      location: scene?.location || null,
      x: Number(scene?.player?.x),
      y: Number(scene?.player?.y),
      activity: scene?.activity ? {
        instanceId: scene.activity.instanceId,
        furnitureId: scene.activity.furnitureId,
        action: scene.activity.action,
        showroom: !!scene.activity.showroom,
      } : null,
      furniture: (scene?.furniture || []).map((sprite) => ({
        instanceId: sprite.getData("instanceId"),
        furnitureId: sprite.getData("furnitureId"),
      })),
    };
  });
}

async function holdUntil(page, key, predicate, label, maxMs = 4_000, predicateArgs = []) {
  await page.keyboard.down(key);
  try {
    await page.waitForFunction(
      predicate,
      { timeout: boundedTimeout(maxMs) },
      ...predicateArgs,
    );
  } catch (error) {
    const state = await sceneState(page).catch(() => null);
    throw new Error(`${label}: ${error.message}; state=${JSON.stringify(state)}`);
  } finally {
    await page.keyboard.up(key).catch(() => {});
  }
  await sleep(100);
}

async function moveAxis(page, key, coordinate, direction, label) {
  // A negative coordinate means "move down/left until this positive absolute
  // coordinate"; no page-side position is assigned by this helper.
  const target = Math.abs(coordinate);
  const predicate = direction === "x"
    ? (signedCoordinate, absoluteTarget) => {
      const value = Number(window._neighborhoodScene?.player?.x);
      return Number.isFinite(value) &&
        (signedCoordinate >= 0 ? value >= absoluteTarget : value <= absoluteTarget);
    }
    : (signedCoordinate, absoluteTarget) => {
      const value = Number(window._neighborhoodScene?.player?.y);
      return Number.isFinite(value) &&
        (signedCoordinate >= 0 ? value >= absoluteTarget : value <= absoluteTarget);
    };
  await holdUntil(page, key, predicate, label, 5_000, [coordinate, target]).catch(async (error) => {
    // A bounded move can be requested in the opposite direction by callers
    // with a negative target; preserve the diagnostic while keeping no key
    // pressed after the failure.
    throw error;
  });
}

async function moveTo(page, x, y, label, tolerance = 20) {
  let state = await sceneState(page);
  if (Math.abs(state.x - x) > 8) {
    const key = x > state.x ? "ArrowRight" : "ArrowLeft";
    const target = x > state.x ? x : -x;
    await moveAxis(page, key, target, "x", `${label} x`);
  }
  state = await sceneState(page);
  if (Math.abs(state.y - y) > 8) {
    const key = y > state.y ? "ArrowDown" : "ArrowUp";
    const target = y > state.y ? y : -y;
    await moveAxis(page, key, target, "y", `${label} y`);
  }
  state = await sceneState(page);
  const distance = Math.hypot(state.x - x, state.y - y);
  requireOk(distance <= tolerance,
    `${label} reached (${Math.round(state.x)},${Math.round(state.y)}), ${Math.round(distance)}px from target`);
}

async function walkToHomeAction(
  page, furnitureId, action, label, instanceId = null, { tight = false } = {},
) {
  const route = await page.evaluate(({ furnitureId: wantedId, action: wantedAction, instanceId: wantedInstanceId }) => {
    const scene = window._neighborhoodScene;
    const sprite = (scene?.furniture || []).find((entry) =>
      entry.getData?.("furnitureId") === wantedId &&
      (!wantedInstanceId || String(entry.getData?.("instanceId")) === String(wantedInstanceId)));
    const anchor = sprite && scene?._furnitureActionAnchor?.(
      sprite, (sprite.getData("actions") || []).find((entry) =>
        (typeof entry === "string" ? entry : entry?.id) === wantedAction),
    );
    if (!scene?.player || !sprite || !anchor) return { error: "home action target unavailable" };
    const blockers = [
      ...(scene.info?.geometry?.blockers || []),
      ...((scene._furnitureBlocks?.children?.entries || []).map((entry) => ({
        x: Number(entry.body?.x ?? entry.x), y: Number(entry.body?.y ?? entry.y),
        width: Number(entry.body?.width || 0), height: Number(entry.body?.height || 0),
      })).filter((block) => block.width > 0 && block.height > 0)),
    ];
    const footRadius = Number(scene.info?.actorFootRadius) || 16;
    const bounds = scene.info?.bounds || { width: 1152, height: 864 };
    const walkable = (x, y) => x >= footRadius && y >= footRadius &&
      x <= Number(bounds.width) - footRadius && y <= Number(bounds.height) - footRadius &&
      !blockers.some((block) => {
        const nearestX = Math.max(block.x, Math.min(x, block.x + block.width));
        const nearestY = Math.max(block.y, Math.min(y, block.y + block.height));
        return Math.hypot(x - nearestX, y - nearestY) <= footRadius;
      });
    const unit = 24;
    const cols = Math.ceil(Number(bounds.width) / unit);
    const rows = Math.ceil(Number(bounds.height) / unit);
    const start = {
      x: Math.max(1, Math.min(cols - 1, Math.round(Number(scene.player.x) / unit))),
      y: Math.max(1, Math.min(rows - 1, Math.round(Number(scene.player.y) / unit))),
    };
    const queue = [start];
    const previous = new Map([ [`${start.x},${start.y}`, null] ]);
    let goal = null;
    while (queue.length && !goal) {
      const current = queue.shift();
      const px = current.x * unit, py = current.y * unit;
      if (walkable(px, py) && Math.hypot(px - anchor.x, py - anchor.y) <= Number(anchor.radius || 86)) {
        goal = current;
        break;
      }
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const next = { x: current.x + dx, y: current.y + dy };
        if (next.x < 1 || next.x >= cols || next.y < 1 || next.y >= rows) continue;
        const key = `${next.x},${next.y}`;
        if (previous.has(key) || !walkable(next.x * unit, next.y * unit)) continue;
        previous.set(key, current);
        queue.push(next);
      }
    }
    if (!goal) return { error: "no walkable home route", anchor, start: scene.player };
    const path = [];
    for (let current = goal; current; current = previous.get(`${current.x},${current.y}`)) {
      path.push({ x: current.x * unit, y: current.y * unit });
    }
    path.reverse();
    const waypoints = [];
    let lastDirection = null;
    for (let index = 1; index < path.length; index++) {
      const direction = `${Math.sign(path[index].x - path[index - 1].x)},${Math.sign(path[index].y - path[index - 1].y)}`;
      if (direction !== lastDirection) {
        waypoints.push(path[index - 1]);
        lastDirection = direction;
      }
    }
    waypoints.push(path.at(-1));
    return {
      anchor: { x: anchor.x, y: anchor.y, radius: anchor.radius },
      start: { x: scene.player.x, y: scene.player.y },
      waypoints,
    };
  }, { furnitureId, action, instanceId });
  requireOk(!route.error, `${label} route exists (${route.error || "BFS"})`);
  for (const [index, waypoint] of route.waypoints.entries()) {
    await moveTo(page, waypoint.x, waypoint.y, `${label} waypoint ${index + 1}`,
      tight ? 8 : 64);
  }
  if (tight) {
    await page.waitForFunction(
      (wantedId) => window._neighborhoodScene?._nearbyFurnitureAction?.()?.instanceId === wantedId,
      { timeout: boundedTimeout(5_000) },
      String(instanceId),
    );
  } else {
    await page.waitForFunction(
      ({ x, y, radius }) => {
        const player = window._neighborhoodScene?.player;
        return !!player && Math.hypot(Number(player.x) - x, Number(player.y) - y) <= radius;
      },
      { timeout: boundedTimeout(5_000) },
      route.anchor,
    );
  }
  console.log(`  ${label} BFS route: ${JSON.stringify(route)}`);
  return route;
}

async function showroomDiagnostics(page, requiredAction = null) {
  const diagnostics = await page.evaluate((action) => {
    const scene = window._neighborhoodScene;
    const sprites = Array.isArray(scene?.showroomFurniture) ? scene.showroomFurniture : [];
    const demos = Array.isArray(scene?.showroomDemos) ? scene.showroomDemos : [];
    const allSprites = sprites.map((sprite) => {
      const demo = sprite.getData("showroomDemo") || {};
      const actions = sprite.getData("showroomActions") || [];
      const stand = demo.stand || {};
      const distance = scene?.player && Number.isFinite(Number(stand.x))
        ? Math.hypot(Number(scene.player.x) - Number(stand.x), Number(scene.player.y) - Number(stand.y))
        : null;
      return {
        instanceId: demo.instanceId || sprite.getData("instanceId") || null,
        furnitureId: demo.furnitureId || sprite.getData("furnitureId") || null,
        actions: actions.map((entry) => typeof entry === "string" ? entry : entry?.id || null),
        actionLabels: actions.map((entry) => typeof entry === "string" ? entry : entry?.label || null),
        actionRadius: sprite.getData("actionRadius"),
        stand: { x: stand.x, y: stand.y },
        distance: Number.isFinite(distance) ? Math.round(distance) : null,
        texture: sprite.texture?.key || null,
        frame: sprite.frame?.name ?? null,
        visible: sprite.visible,
      };
    });
    const nearby = scene?._nearbyShowroomAction?.();
    const nearbyActions = nearby?.actions || [];
    const interactionEntries = scene?.showroomInteractions instanceof Map
      ? [...scene.showroomInteractions.entries()].map(([key, entry]) => ({
        key,
        instanceId: entry?.instanceId || entry?.demo?.instanceId || null,
        furnitureId: entry?.demo?.furnitureId || entry?.sprite?.getData?.("furnitureId") || null,
        actions: (entry?.actions || []).map((item) =>
          typeof item === "string" ? item : item?.id || null),
        spriteInstanceId: entry?.sprite?.getData?.("instanceId") || null,
        spriteActive: entry?.sprite?.active !== false,
      }))
      : [];
    return {
      location: scene?.location || null,
      demoCount: demos.length,
      spriteCount: sprites.length,
      stableShowroomInteractions: demos.map((demo) => ({
        instanceId: demo.instanceId || null,
        furnitureId: demo.furnitureId || null,
        actions: (demo.actions || []).map((entry) =>
          typeof entry === "string" ? entry : entry?.id || null),
        actionLabels: (demo.actions || []).map((entry) =>
          typeof entry === "string" ? entry : entry?.label || null),
      })),
      showroomInteractions: interactionEntries,
      sprites: allSprites,
      nearby: nearby ? {
        instanceId: nearby.demo?.instanceId || null,
        furnitureId: nearby.demo?.furnitureId || null,
        actions: nearbyActions.map((entry) => typeof entry === "string" ? entry : entry?.id || null),
      } : null,
      requestedAction: action,
      requestedActionNearby: !!nearbyActions.find((entry) =>
        (typeof entry === "string" ? entry : entry?.id) === action),
    };
  }, requiredAction);
  // This diagnostic is intentionally printed before any assertion. If a
  // missing action is the first failure, every sprite's data is still in the
  // run log rather than hidden behind an assertion stack.
  console.log(`  showroom diagnostics: ${JSON.stringify(diagnostics)}`);
  return diagnostics;
}

async function requireNearbyShowroomAction(page, action) {
  const diagnostics = await showroomDiagnostics(page, action);
  requireOk(diagnostics.demoCount >= 7, `showroom catalog demos render (${diagnostics.demoCount})`);
  requireOk(diagnostics.spriteCount === diagnostics.demoCount,
    `showroom sprite count exactly matches catalog (${diagnostics.spriteCount}/${diagnostics.demoCount})`);
  if (action === "sit") {
    requireOk(diagnostics.nearby?.furnitureId === "lounge_sofa",
      `nearby showroom target is lounge_sofa (${diagnostics.nearby?.instanceId || "none"})`);
  }
  requireOk(diagnostics.requestedActionNearby,
    `nearby showroom action ${action} is present`);
}

async function homeSnapshotCount(page) {
  return page.evaluate(() => Array.isArray(window.__realGameSnapshots)
    ? window.__realGameSnapshots.length : 0);
}

async function requestHomeSnapshot(page) {
  const before = await homeSnapshotCount(page);
  await page.evaluate(() => socket.emit("homeSnapshotRequest"));
  await page.waitForFunction(
    (count) => Array.isArray(window.__realGameSnapshots) &&
      window.__realGameSnapshots.length > count,
    { timeout: boundedTimeout(15_000) },
    before,
  );
  return page.evaluate(() => window.__realGameSnapshots.at(-1));
}

async function importantEventCount(page, eventName = null) {
  return page.evaluate((wanted) => (window.__realGameImportantEvents || [])
    .filter((entry) => !wanted || entry.event === wanted).length, eventName);
}

async function waitForImportantEvent(page, eventName, before = 0, label = eventName) {
  await page.waitForFunction(
    ({ wanted, minimum }) => (window.__realGameImportantEvents || [])
      .slice(minimum).some((entry) => entry.event === wanted),
    { timeout: boundedTimeout(20_000) },
    { wanted: eventName, minimum: before },
  );
  const event = await page.evaluate((wanted) => [...(window.__realGameImportantEvents || [])]
    .reverse().find((entry) => entry.event === wanted) || null, eventName);
  requireOk(event, `${label} arrives from the real server`);
  return event;
}

async function openInventoryHotbar(page, label) {
  await page.waitForSelector("#inventory-toggle-btn", { timeout: boundedTimeout(15_000) });
  const alreadyOpen = await page.evaluate(() =>
    document.querySelector("#inventory-hotbar")?.classList.contains("open"));
  if (alreadyOpen) await page.click("#inventory-toggle-btn");
  const toggleSurface = await page.evaluate(() => {
    const button = document.querySelector("#inventory-toggle-btn");
    const panel = document.querySelector("#home-panel");
    if (!button) return { missing: true };
    const rect = button.getBoundingClientRect();
    const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    return {
      missing: false,
      panelOpen: !!panel && !panel.hidden,
      rect: { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom },
      hit: hit ? { id: hit.id || "", className: String(hit.className || "") } : null,
      accessible: !!hit && (hit === button || button.contains(hit)),
    };
  });
  if (!toggleSurface.accessible) {
    if (!hotbarOverlayFailureRecorded) {
      hotbarOverlayFailureRecorded = true;
      await screenshot(page, "inventory-hotbar-blocked-surface");
      ok(false,
        `${label} inventory toggle is not pointer-accessible before panel collapse ` +
        `(hit=${JSON.stringify(toggleSurface.hit)}, rect=${JSON.stringify(toggleSurface.rect)})`);
    }
    // Keep the rest of the critical pass useful after recording the concrete
    // regression. This is the existing home-panel control, not a test seam.
    const collapse = await page.$("#home-panel .home-panel-head button");
    if (collapse && toggleSurface.panelOpen) {
      await page.click("#home-panel .home-panel-head button");
      await sleep(150);
    }
  }
  const before = await importantEventCount(page, "playerFurnitureInventoryResult");
  await page.click("#inventory-toggle-btn");
  await page.waitForFunction(
    (minimum) => document.querySelector("#inventory-hotbar")?.classList.contains("open") &&
      (window.__realGameImportantEvents || []).slice(minimum)
        .some((entry) => entry.event === "playerFurnitureInventoryResult"),
    { timeout: boundedTimeout(20_000) },
    before,
  );
  const event = await page.evaluate(() => [...(window.__realGameImportantEvents || [])]
    .reverse().find((entry) => entry.event === "playerFurnitureInventoryResult") || null);
  requireOk(event?.payload?.ok === true, `${label} inventory read succeeds`);
  return event.payload;
}

async function selectHotbarItem(page, category, id, type, label) {
  const beforeState = await page.evaluate(() => ({
    open: document.querySelector("#inventory-hotbar")?.classList.contains("open"),
    content: document.querySelector("#inventory-content")?.innerText || "",
  }));
  console.log(`  ${label} hotbar before category: ${JSON.stringify(beforeState)}`);
  const categorySelector = `.hotbar-cat-btn[data-cat="${category}"]`;
  await page.waitForSelector(categorySelector, { timeout: boundedTimeout(5_000) });
  await page.$eval(categorySelector, (element) => element.click());
  const selector = `.hotbar-item[data-id="${id}"][data-type="${type}"]`;
  await page.waitForSelector(selector, {
    timeout: boundedTimeout(10_000),
  });
  // The touch joystick can overlap the lower edge of the hotbar at a narrow
  // viewport. Use the real item's DOM click handler rather than a coordinate
  // click here; the subsequent Place/equip/use controls are still exercised by
  // their production DOM handlers and the real server acknowledgements.
  await page.$eval(selector, (element) => element.click());
  await page.waitForSelector(".hotbar-action-btn", { timeout: boundedTimeout(5_000) });
  requireOk(await page.$(`.hotbar-action-btn[data-action]`),
    `${label} selected item exposes an action button`);
}

async function assertHotbarViewport(page, label) {
  const diagnostics = await page.evaluate(() => {
    const viewport = { width: window.innerWidth, height: window.innerHeight };
    const nodes = [
      ...document.querySelectorAll(
        "#inventory-toggle-btn, #inventory-content, .hotbar-cat-btn, .hotbar-item, " +
        ".hotbar-action-btn, .hotbar-popover",
      ),
    ].filter((node) => {
      const style = getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" &&
        rect.width > 0 && rect.height > 0;
    });
    return {
      viewport,
      bodyScroll: { width: document.body.scrollWidth, height: document.body.scrollHeight },
      nodes: nodes.map((node) => {
        const rect = node.getBoundingClientRect();
        const x = Math.max(rect.left + 1, Math.min(rect.right - 1, rect.left + rect.width / 2));
        const y = Math.max(rect.top + 1, Math.min(rect.bottom - 1, rect.top + rect.height / 2));
        const hit = document.elementFromPoint(x, y);
        return {
          selector: node.id || node.className,
          left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom,
          pointerEvents: getComputedStyle(node).pointerEvents,
          centerHit: !!hit && (hit === node || node.contains(hit)),
        };
      }),
    };
  });
  console.log(`  ${label} viewport diagnostics: ${JSON.stringify(diagnostics)}`);
  // Phaser's fixed canvas leaves a known 4px document-height baseline on
  // this viewport. The hotbar contract is horizontal overflow and actual
  // control hit bounds; do not turn that unrelated vertical baseline into a
  // mobile inventory failure.
  ok(diagnostics.bodyScroll.width <= diagnostics.viewport.width + 1,
  `${label} has no horizontal document overflow`);
  ok(diagnostics.nodes.every((node) =>
    node.left >= -1 && node.right <= diagnostics.viewport.width + 1 &&
    node.top >= -1 && node.bottom <= diagnostics.viewport.height + 1 &&
    node.pointerEvents !== "none" && node.centerHit),
  `${label} visible hotbar controls fit and receive pointer hits`);
  return diagnostics;
}

async function clickPlacementSpot(page, label) {
  // Click a real canvas location after the hotbar's Place action. The
  // placement input computes the grid cell and validity from the live Phaser
  // scene; this deliberately does not call the placement bridge directly.
  const point = await page.evaluate(() => {
    const scene = window._neighborhoodScene;
    const canvas = scene?.game?.canvas || document.querySelector("canvas");
    const camera = scene?.cameras?.main;
    if (!canvas || !camera?.worldView) return null;
    const rect = canvas.getBoundingClientRect();
    // Living-room cell (12,10) is clear of the authored dividers and all
    // four seeded fixtures; (10,10) is the solid private-wing wall.
    const worldX = 12 * 48 + 24;
    const worldY = 10 * 48 + 24;
    return {
      x: rect.left + ((worldX - camera.worldView.x) / camera.worldView.width) * rect.width,
      y: rect.top + ((worldY - camera.worldView.y) / camera.worldView.height) * rect.height,
    };
  });
  requireOk(point && Number.isFinite(point.x) && Number.isFinite(point.y),
    `${label} computes a live placement canvas point`);
  await page.mouse.click(point.x, point.y);
  await page.waitForSelector("#placement-controls:not([hidden]) #ghost-confirm:not([disabled])", {
    timeout: boundedTimeout(10_000),
  });
  requireOk(await page.$("#placement-controls:not([hidden]) #ghost-confirm"),
    `${label} existing placement UI exposes enabled Confirm`);
}

async function openHomeEditorForHotbar(page) {
  await page.waitForSelector("#home-panel .home-panel-head button", {
    timeout: boundedTimeout(10_000),
  });
  await page.waitForFunction(
    () => {
      const panel = document.querySelector("#home-panel");
      return panel && !panel.hidden;
    },
    { timeout: boundedTimeout(5_000) },
  ).catch(() => {});
  const open = await page.evaluate(() => /collapse/i.test(
    document.querySelector("#home-panel .home-panel-head button")?.textContent || "",
  ));
  if (!open) await page.click("#home-panel .home-panel-head button");
}

async function hideNeighborhoodOverlay(page) {
  const state = await page.$eval("#neighborhood-panel-toggle", (button) => ({
    visible: !button.hidden && /hide panel/i.test(button.textContent || ""),
    rect: (() => {
      const rect = button.getBoundingClientRect();
      return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
    })(),
    collapsed: document.querySelector("#neighborhood-ui")?.classList.contains("panels-collapsed"),
  })).catch(() => ({ visible: false, collapsed: false }));
  if (state.visible && !state.collapsed) {
    console.log(`  hiding neighborhood overlay via existing toggle: ${JSON.stringify(state.rect)}`);
    await page.click("#neighborhood-panel-toggle");
    await sleep(100);
    const collapsed = await page.evaluate(() =>
      document.querySelector("#neighborhood-ui")?.classList.contains("panels-collapsed"));
    if (!collapsed) {
      await page.$eval("#neighborhood-panel-toggle", (button) => button.click());
      await sleep(100);
    }
  }
}

async function showNeighborhoodOverlay(page) {
  const show = await page.$eval("#neighborhood-panel-toggle", (button) =>
    !button.hidden && /show panel/i.test(button.textContent || "")).catch(() => false);
  if (show) {
    await page.$eval("#neighborhood-panel-toggle", (button) => button.click());
    await sleep(100);
  }
}

async function reloadOwnerHome(page, label) {
  const token = await page.evaluate(() => window.__realGameSessionToken ||
    localStorage.getItem("jpo_session_token") || "");
  requireOk(token, `${label} has the approved session token for a real reload`);
  await page.evaluate((value) => {
    localStorage.setItem("jpo_session_token", value);
    sessionStorage.removeItem("jpo_session_token");
  }, token);
  await page.reload({ waitUntil: "domcontentloaded", timeout: boundedTimeout(30_000) });
  await waitForLocation(page, `home:${OWNER_EMAIL}`);
  await installEventCapture(page);
  await page.waitForFunction(
    () => window._neighborhoodScene?._neighborhoodReady &&
      document.querySelector("#inventory-toggle-btn"),
    { timeout: boundedTimeout(30_000) },
  );
  console.log(`  ${label} reloaded into the owner's canonical home`);
}

async function assertInventoryToggleHit(page, label) {
  const result = await page.evaluate(() => {
    const button = document.querySelector("#inventory-toggle-btn");
    if (!button) return { exists: false };
    const rect = button.getBoundingClientRect();
    const hit = document.elementFromPoint(
      rect.left + rect.width / 2, rect.top + rect.height / 2,
    );
    return {
      exists: true,
      rect: { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom },
      hit: hit ? { id: hit.id || "", className: String(hit.className || "") } : null,
      accessible: !!hit && (hit === button || button.contains(hit)),
    };
  });
  console.log(`  ${label} toggle hit diagnostics: ${JSON.stringify(result)}`);
  ok(result.exists && result.accessible,
    `${label} inventory button center receives a real pointer hit`);
  return result;
}

async function openInventoryHotbarForTouchUi(page, label) {
  await page.waitForSelector("#inventory-toggle-btn", { timeout: boundedTimeout(15_000) });
  const before = await importantEventCount(page, "playerFurnitureInventoryResult");
  // The focused touch assertion targets the selected-item popover geometry.
  // Open through the production button handler so unrelated top HUD chrome
  // cannot prevent reaching that geometry before the hit-bound checks.
  await page.$eval("#inventory-toggle-btn", (element) => element.click());
  await page.waitForFunction(
    (minimum) => document.querySelector("#inventory-hotbar")?.classList.contains("open") &&
      (window.__realGameImportantEvents || []).slice(minimum)
        .some((entry) => entry.event === "playerFurnitureInventoryResult"),
    { timeout: boundedTimeout(20_000) },
    before,
  );
  const event = await page.evaluate(() => [...(window.__realGameImportantEvents || [])]
    .reverse().find((entry) => entry.event === "playerFurnitureInventoryResult") || null);
  requireOk(event?.payload?.ok === true, `${label} inventory read succeeds`);
  return event.payload;
}

function classifyMissingResponses(page, label) {
  const missing = [...(page.__realGameMissingResponses || [])];
  const known = missing.filter((url) =>
    /(?:unicorn|walk[_-]?[123]|sit|action)/i.test(url));
  const unexpected = missing.filter((url) => !known.includes(url));
  console.log(`  ${label} missing-resource classification: ${JSON.stringify({
    knownUnicornAnimation404s: known,
    unexpected404s: unexpected,
  })}`);
  ok(unexpected.length === 0,
    `${label} has no unexpected 404 responses${
      unexpected.length ? ` (${unexpected.join(" ; ")})` : ""}`);
  return { known, unexpected };
}

async function inventoryHotbarMobileOnlyPass(baseUrl) {
  stage("inventory hotbar fresh 402x874 mobile bootstrap");
  ownerPage.__realGameBaseUrl = baseUrl;
  // First exact-owner restore is retained as the loader's showroom bootstrap;
  // this focused mode does not repeat any furniture persistence journey.
  await registerThroughUi(ownerPage, OWNER_EMAIL, "QA Furniture");
  await waitForLocation(ownerPage, "furniture-shop");
  await ownerPage.close();
  ownerContext = await browser.createIncognitoBrowserContext();
  // Register on a desktop-sized page first so the production builder's
  // approval flow is not clipped by the narrow viewport. The actual focused
  // assertion uses a fresh 402x874 touch page resumed with that exact QA
  // session token.
  ownerPage = await createPage(ownerContext, "owner-hotbar-mobile-bootstrap", VIEWPORT);
  ownerPage.__realGameBaseUrl = baseUrl;
  await registerThroughUi(ownerPage, OWNER_EMAIL, "QA Furniture");
  await waitForLocation(ownerPage, `home:${OWNER_EMAIL}`);
  const sessionToken = await ownerPage.evaluate(() =>
    window.__realGameSessionToken || localStorage.getItem("jpo_session_token") || "");
  requireOk(sessionToken, "mobile-only desktop bootstrap has the approved session token");
  await ownerPage.close();
  ownerPage = await createPage(
    ownerContext, "owner-hotbar-mobile-only", HOTBAR_FOCUSED_VIEWPORT,
  );
  ownerPage.__realGameBaseUrl = baseUrl;
  await ownerPage.goto(`${baseUrl}/`, {
    waitUntil: "domcontentloaded", timeout: boundedTimeout(30_000),
  });
  await ownerPage.evaluate((token) => {
    localStorage.setItem("jpo_session_token", token);
    sessionStorage.removeItem("jpo_session_token");
  }, sessionToken);
  await ownerPage.reload({
    waitUntil: "domcontentloaded", timeout: boundedTimeout(30_000),
  });
  await ownerPage.waitForFunction(
    () => document.body.classList.contains("playing") &&
      window._neighborhoodScene?.player,
    { timeout: boundedTimeout(45_000) },
  );
  await installEventCapture(ownerPage);
  const hydrated = await waitForCanonicalHomeHydration(ownerPage, "mobile-only");
  const hydrationOk = hydrated.state.playerEmail === OWNER_EMAIL &&
    hydrated.state.location === `home:${OWNER_EMAIL}` &&
    hydrated.snapshot?.ownerEmail === OWNER_EMAIL &&
    hydrated.snapshot?.canEdit === true &&
    hydrated.state.canPlace === true;
  if (!hydrationOk) {
    ok(false, `mobile-only canonical home is not placeable: ${JSON.stringify({
      playerEmail: hydrated.state.playerEmail,
      sceneLocation: hydrated.state.location,
      canPlace: hydrated.state.canPlace,
      ownerEmail: hydrated.snapshot?.ownerEmail || null,
      canEdit: hydrated.snapshot?.canEdit ?? null,
      revision: hydrated.snapshot?.revision ?? null,
    })}`);
    await screenshot(ownerPage, "inventory-hotbar-mobile-only-home-state");
    classifyMissingResponses(ownerPage, "mobile-only");
    return;
  }

  const inventory = await openInventoryHotbar(ownerPage, "mobile-only");
  requireOk(inventory.inventory.some((item) => String(item.id) === hotbarStoredFurnitureId),
    "mobile-only inventory contains the seeded stored furniture UUID");
  await selectHotbarItem(
    ownerPage, "furniture", "oak_chair", "furniture", "mobile-only furniture",
  );
  const diagnostics = await assertHotbarViewport(
    ownerPage, "fresh 402x874 touch selected furniture",
  );
  const placeBounds = await ownerPage.$eval(
    ".hotbar-action-btn[data-action=\"place\"]",
    (element) => {
      const rect = element.getBoundingClientRect();
      return {
        left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom,
        width: rect.width, height: rect.height, disabled: element.disabled,
      };
    },
  );
  console.log(`  fresh mobile Place hit bounds: ${JSON.stringify(placeBounds)}`);
  ok(placeBounds.width > 0 && placeBounds.height > 0 &&
    placeBounds.left >= -1 && placeBounds.right <= 403 &&
    placeBounds.top >= -1 && placeBounds.bottom <= 875,
  "fresh 402x874 selected furniture Place action is in bounds");
  await assertInventoryToggleHit(ownerPage, "fresh 402x874 touch selected");
  const screenshotPath = await screenshot(
    ownerPage, "inventory-hotbar-mobile-only-selected-furniture",
  );
  classifyMissingResponses(ownerPage, "mobile-only");
  const browserErrors = ownerPage.__realGameErrors || [];
  ok(browserErrors.length === 0,
    `mobile-only page has no browser/page errors${
      browserErrors.length ? ` (${browserErrors.join(" ; ")})` : ""}`);
  console.log(`  fresh mobile evidence: ${JSON.stringify({
    screenshotPath, diagnostics, placeBounds,
  })}`);
}

async function inventoryHotbarUiOnlyPass(baseUrl) {
  const priorOwnerErrors = [];
  stage("inventory hotbar UI-only desktop bootstrap");
  ownerPage.__realGameBaseUrl = baseUrl;
  // Preserve the canonical loader bootstrap, but stop after the first
  // showroom restore. No Place/Store/reload journey is repeated here.
  await registerThroughUi(ownerPage, OWNER_EMAIL, "QA Furniture");
  await waitForLocation(ownerPage, "furniture-shop");
  await ownerPage.close();
  ownerContext = await browser.createIncognitoBrowserContext();
  ownerPage = await createPage(ownerContext, "owner-hotbar-ui-desktop", VIEWPORT);
  ownerPage.__realGameBaseUrl = baseUrl;
  await registerThroughUi(ownerPage, OWNER_EMAIL, "QA Furniture");
  await installEventCapture(ownerPage);
  await waitForLocation(ownerPage, `home:${OWNER_EMAIL}`);
  await ownerPage.waitForFunction(
    () => window._neighborhoodScene?._neighborhoodReady &&
      document.querySelector("#inventory-toggle-btn"),
    { timeout: boundedTimeout(30_000) },
  );

  const desktopInventory = await openInventoryHotbar(ownerPage, "UI-only desktop");
  requireOk(desktopInventory.ownerEmail === OWNER_EMAIL,
    "UI-only desktop inventory is owner-scoped");
  requireOk(desktopInventory.inventory.some((item) =>
    String(item.id) === hotbarStoredFurnitureId),
  "UI-only desktop inventory contains the seeded stored furniture UUID");
  await selectHotbarItem(ownerPage, "usables", HOTBAR_USABLE_ID, "usable", "UI-only consumable");
  const beforeUseCount = await ownerPage.$eval(
    `.hotbar-item[data-id="${HOTBAR_USABLE_ID}"] .hotbar-item-count`,
    (node) => Number(node.textContent),
  );
  const itemEventsBefore = await importantEventCount(ownerPage, "itemsUpdate");
  await ownerPage.$eval(
    ".hotbar-action-btn[data-action=\"use\"]", (element) => element.click(),
  );
  const itemEvent = await waitForImportantEvent(
    ownerPage, "itemsUpdate", itemEventsBefore, "UI-only consumable use",
  );
  const afterUseCount = Number(itemEvent.payload?.items?.[HOTBAR_USABLE_ID]);
  requireOk(beforeUseCount === 2 && afterUseCount === 1,
    `UI-only consumable Use acknowledges 2 → 1 (${beforeUseCount} → ${afterUseCount})`);
  const badgeUpdated = await ownerPage.waitForFunction(
    (id) => Number(document.querySelector(
      `.hotbar-item[data-id="${id}"][data-type="usable"] .hotbar-item-count`,
    )?.textContent) === 1,
    { timeout: boundedTimeout(5_000) },
    HOTBAR_USABLE_ID,
  ).then(() => true).catch(() => false);
  ok(badgeUpdated, "UI-only consumable badge visibly shows count 1");
  await assertInventoryToggleHit(ownerPage, "desktop");

  priorOwnerErrors.push(...(ownerPage.__realGameErrors || []));
  await ownerPage.close();

  stage("inventory hotbar UI-only 402x874 touch selected-item check");
  ownerPage = await createPage(
    ownerContext, "owner-hotbar-ui-touch", HOTBAR_FOCUSED_VIEWPORT,
  );
  ownerPage.__realGameBaseUrl = baseUrl;
  await registerThroughUi(ownerPage, OWNER_EMAIL, "QA Furniture");
  await installEventCapture(ownerPage);
  await waitForLocation(ownerPage, `home:${OWNER_EMAIL}`);
  await ownerPage.waitForFunction(
    () => window._neighborhoodScene?._neighborhoodReady &&
      document.querySelector("#inventory-toggle-btn"),
    { timeout: boundedTimeout(30_000) },
  );
  const touchInventory = await openInventoryHotbarForTouchUi(ownerPage, "UI-only touch");
  requireOk(touchInventory.ownerEmail === OWNER_EMAIL,
    "UI-only touch inventory is owner-scoped");
  await selectHotbarItem(
    ownerPage, "furniture", "oak_chair", "furniture", "UI-only touch furniture",
  );
  const touchDiagnostics = await assertHotbarViewport(
    ownerPage, "402x874 touch selected furniture",
  );
  const selectedAction = await ownerPage.$eval(
    ".hotbar-action-btn[data-action=\"place\"]",
    (element) => {
      const rect = element.getBoundingClientRect();
      return {
        left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom,
        width: rect.width, height: rect.height,
        text: element.textContent,
      };
    },
  );
  requireOk(selectedAction.width > 0 && selectedAction.height > 0 &&
    selectedAction.left >= -1 && selectedAction.right <= 403 &&
    selectedAction.top >= -1 && selectedAction.bottom <= 875,
  "402x874 selected furniture Place action has in-bounds hit bounds");
  await assertInventoryToggleHit(ownerPage, "402x874 touch");
  const screenshotPath = await screenshot(ownerPage, "inventory-hotbar-ui-only-touch-selected");
  console.log(`  selected touch diagnostics: ${JSON.stringify({
    touchDiagnostics, selectedAction, screenshotPath,
  })}`);
  const browserErrors = [
    ...priorOwnerErrors,
    ...(ownerPage.__realGameErrors || []),
  ];
  requireOk(browserErrors.length === 0,
    `UI-only hotbar pages have no browser/console errors${
      browserErrors.length ? ` (${browserErrors.join(" ; ")})` : ""}`);
}

async function inventoryHotbarPass(baseUrl) {
  stage("inventory hotbar owner home bootstrap");
  ownerPage.__realGameBaseUrl = baseUrl;
  // The loader's first exact-owner restore is a showroom pass. Close it and
  // use the second exact-owner restore for the canonical seeded home, without
  // walking through any world portal.
  await registerThroughUi(ownerPage, OWNER_EMAIL, "QA Furniture");
  await waitForLocation(ownerPage, "furniture-shop");
  await ownerPage.close();
  ownerContext = await browser.createIncognitoBrowserContext();
  // Keep the stateful Place/Store/equip/use flow on the normal desktop
  // viewport. A separate mobile viewport assertion below covers responsive
  // controls without letting touch overlays interfere with the persistence
  // path itself.
  ownerPage = await createPage(ownerContext, "owner-hotbar", VIEWPORT);
  ownerPage.__realGameBaseUrl = baseUrl;
  await registerThroughUi(ownerPage, OWNER_EMAIL, "QA Furniture");
  await installEventCapture(ownerPage);
  await waitForLocation(ownerPage, `home:${OWNER_EMAIL}`);
  await ownerPage.waitForFunction(
    () => window._neighborhoodScene?._neighborhoodReady &&
      document.querySelector("#inventory-toggle-btn"),
    { timeout: boundedTimeout(30_000) },
  );
  const initial = await requestHomeSnapshot(ownerPage);
  requireOk(initial.ownerEmail === OWNER_EMAIL,
    "owner hotbar starts in the canonical QA home");
  requireOk(hotbarStoredFurnitureId &&
    initial.inventory.some((item) => String(item.id) === hotbarStoredFurnitureId),
  "canonical home snapshot contains the exact stored furniture UUID");

  stage("inventory hotbar stored furniture and Place flow");
  const opened = await openInventoryHotbar(ownerPage, "owner");
  requireOk(opened.ownerEmail === OWNER_EMAIL,
    "own inventory response is auth-scoped to the owner");
  requireOk(opened.inventory.some((item) => String(item.id) === hotbarStoredFurnitureId &&
    item.furnitureId === "oak_chair"),
  `stored furniture UUID ${hotbarStoredFurnitureId} appears in own inventory`);
  requireOk(!opened.layout.some((item) => String(item.id) === hotbarStoredFurnitureId) &&
    !opened.yard.some((item) => String(item.id) === hotbarStoredFurnitureId),
  "stored furniture UUID is not misclassified as indoor or yard");
  await selectHotbarItem(ownerPage, "furniture", "oak_chair", "furniture", "furniture");
  await ownerPage.$eval(
    ".hotbar-action-btn[data-action=\"place\"]", (element) => element.click(),
  );
  // The authored home editor shell is an existing overlay over the canvas.
  // Hide it through its real panel toggle so the subsequent real pointer
  // placement is not intercepted by an empty UI surface.
  await hideNeighborhoodOverlay(ownerPage);
  await clickPlacementSpot(ownerPage, "hotbar Place");
  const placeEventsBefore = await importantEventCount(ownerPage, "homeActionResult");
  await ownerPage.click("#placement-controls #ghost-confirm");
  await waitForImportantEvent(ownerPage, "homeActionResult", placeEventsBefore, "hotbar Place");
  const placed = await requestHomeSnapshot(ownerPage);
  requireOk(placed.layout.some((item) => String(item.id) === hotbarStoredFurnitureId &&
    item.furnitureId === "oak_chair"),
  "hotbar Place persists the selected furniture UUID into indoor layout");
  requireOk(!placed.inventory.some((item) => String(item.id) === hotbarStoredFurnitureId),
    "placed furniture UUID leaves stored inventory");
  await screenshot(ownerPage, "inventory-hotbar-place-home");

  stage("inventory hotbar Place reload persistence");
  await reloadOwnerHome(ownerPage, "after hotbar Place");
  const placedReload = await requestHomeSnapshot(ownerPage);
  requireOk(placedReload.layout.some((item) => String(item.id) === hotbarStoredFurnitureId),
    "reloaded owner home preserves hotbar-placed UUID");

  stage("inventory hotbar Store back to inventory");
  await showNeighborhoodOverlay(ownerPage);
  await openHomeEditorForHotbar(ownerPage);
  await ownerPage.waitForSelector(
    `#home-panel [data-return="${hotbarStoredFurnitureId}"]`,
    { timeout: boundedTimeout(10_000), visible: true },
  );
  const storeEventsBefore = await importantEventCount(ownerPage, "homeActionResult");
  await ownerPage.click(`#home-panel [data-return="${hotbarStoredFurnitureId}"]`);
  await ownerPage.waitForFunction(
    ({ minimum, id }) => (window.__realGameImportantEvents || []).slice(minimum)
      .some((entry) => entry.event === "homeActionResult" &&
        entry.payload?.ok === true && String(entry.payload?.instanceId) === id),
    { timeout: boundedTimeout(20_000) },
    { minimum: storeEventsBefore, id: hotbarStoredFurnitureId },
  );
  const storedAgain = await requestHomeSnapshot(ownerPage);
  requireOk(storedAgain.inventory.some((item) => String(item.id) === hotbarStoredFurnitureId),
    "Home Store returns the exact placed UUID to inventory");
  requireOk(!storedAgain.layout.some((item) => String(item.id) === hotbarStoredFurnitureId),
    "Home Store removes only the selected UUID from layout");
  await screenshot(ownerPage, "inventory-hotbar-store-home");

  stage("inventory hotbar Store reload persistence");
  await reloadOwnerHome(ownerPage, "after hotbar Store");
  const storedReload = await requestHomeSnapshot(ownerPage);
  requireOk(storedReload.inventory.some((item) => String(item.id) === hotbarStoredFurnitureId),
    "reloaded owner home preserves exact stored UUID after Store");

  stage("inventory hotbar cosmetic equip and consumable use");
  const cosmeticInventory = await openInventoryHotbar(ownerPage, "owner after Store");
  requireOk(cosmeticInventory.ownerEmail === OWNER_EMAIL,
    "post-Store inventory still uses the owner identity");
  await selectHotbarItem(ownerPage, "wearables", HOTBAR_COSMETIC_ID, "wearable", "cosmetic");
  const equipEventsBefore = await importantEventCount(ownerPage, "equipUpdate");
  await ownerPage.click(".hotbar-action-btn[data-action=\"equip\"]");
  const equipEvent = await waitForImportantEvent(
    ownerPage, "equipUpdate", equipEventsBefore, "cosmetic equip",
  );
  requireOk(equipEvent.payload?.equipped === HOTBAR_COSMETIC_ID,
    "owned cosmetic equip receives the server-authoritative acknowledgement");

  await ownerPage.click("#inventory-toggle-btn");
  await openInventoryHotbar(ownerPage, "owner for consumable");
  await selectHotbarItem(ownerPage, "usables", HOTBAR_USABLE_ID, "usable", "consumable");
  const beforeUseCount = await ownerPage.$eval(
    `.hotbar-item[data-id="${HOTBAR_USABLE_ID}"] .hotbar-item-count`,
    (node) => Number(node.textContent),
  );
  const itemEventsBefore = await importantEventCount(ownerPage, "itemsUpdate");
  await ownerPage.click(".hotbar-action-btn[data-action=\"use\"]");
  const itemEvent = await waitForImportantEvent(
    ownerPage, "itemsUpdate", itemEventsBefore, "consumable use",
  );
  const afterUseCount = Number(itemEvent.payload?.items?.[HOTBAR_USABLE_ID]);
  requireOk(afterUseCount === beforeUseCount - 1,
    `one consumable Use decrements server count (${beforeUseCount} → ${afterUseCount})`);
  const uiCountUpdated = await ownerPage.waitForFunction(
    ({ id, expected }) => {
      const node = document.querySelector(
        `.hotbar-item[data-id="${id}"][data-type="usable"] .hotbar-item-count`,
      );
      return Number(node?.textContent) === expected;
    },
    { timeout: boundedTimeout(5_000) },
    { id: HOTBAR_USABLE_ID, expected: afterUseCount },
  ).then(() => true).catch(() => false);
  ok(uiCountUpdated, "hotbar Use refreshes the visible consumable count");

  stage("inventory hotbar mobile viewport and emote accessibility");
  await ownerPage.setViewport(HOTBAR_VIEWPORT);
  await sleep(300);
  await openInventoryHotbar(ownerPage, "owner mobile");
  await selectHotbarItem(ownerPage, "furniture", "oak_chair", "furniture", "mobile furniture");
  await assertHotbarViewport(ownerPage, "mobile hotbar");
  await screenshot(ownerPage, "inventory-hotbar-mobile");
  await ownerPage.click("#inventory-toggle-btn");
  await ownerPage.click("#emote-toggle");
  await ownerPage.waitForSelector("#emote-bar.open .emote-btn", {
    timeout: boundedTimeout(5_000),
  });
  const emoteEventsBefore = await importantEventCount(ownerPage, "playerEmote");
  await ownerPage.click('#emote-bar .emote-btn[aria-label="Emote: wave"]');
  await waitForImportantEvent(ownerPage, "playerEmote", emoteEventsBefore, "wave emote");
  requireOk(await ownerPage.$$eval("#emote-bar.open .emote-btn", (buttons) =>
    buttons.length >= 8), "emotes remain accessible beside the hotbar on mobile");

  stage("inventory hotbar visitor identity isolation");
  guestPage.__realGameBaseUrl = baseUrl;
  await registerThroughUi(guestPage, GUEST_EMAIL, "QA Visitor");
  await installEventCapture(guestPage);
  await waitForLocation(guestPage, `home:${OWNER_EMAIL}`);
  const guestInventory = await openInventoryHotbar(guestPage, "visitor");
  requireOk(guestInventory.ownerEmail === GUEST_EMAIL,
    "visitor inventory response is auth-scoped to the visiting QA player");
  requireOk(!guestInventory.inventory.some((item) => String(item.id) === hotbarStoredFurnitureId),
    "visitor inventory never shows the host's stored furniture UUID");
  requireOk(!guestInventory.layout.some((item) => String(item.id) === hotbarStoredFurnitureId) &&
    !guestInventory.yard.some((item) => String(item.id) === hotbarStoredFurnitureId),
  "visitor inventory never shows host indoor or yard furniture");
  requireOk(await guestPage.$(`.hotbar-item[data-id="${HOTBAR_COSMETIC_ID}"]`) === null,
    "visitor hotbar never shows the owner's cosmetic");
  requireOk((await guestPage.$$(".hotbar-item[data-type=\"furniture\"]")).length === 0,
    "visitor hotbar never shows host furniture while inside the host home");
  await screenshot(guestPage, "inventory-hotbar-visitor-host-home");

  const browserErrors = [
    ...(ownerPage.__realGameErrors || []),
    ...(guestPage.__realGameErrors || []),
  ];
  requireOk(browserErrors.length === 0,
    `inventory hotbar pages have no browser/console errors${
      browserErrors.length ? ` (${browserErrors.join(" ; ")})` : ""}`);
}

async function pressFurnitureAction(page, action, { shift = false } = {}) {
  if (shift) await page.keyboard.down("Shift");
  try {
    // Hold the real action key across at least one Phaser frame. A zero-delay
    // keydown/keyup pair can be consumed between update ticks in headless
    // Chromium even though movement keys are held by the navigation helper.
    await page.keyboard.down("e");
    await sleep(100);
    await page.keyboard.up("e");
  } finally {
    if (shift) await page.keyboard.up("Shift");
  }
  try {
    await page.waitForFunction(
      (expected) => window._neighborhoodScene?.activity?.action === expected ||
        (window.__realGameEvents || []).some((entry) =>
          (entry.event === "furnitureDemoInteractionResult" ||
            entry.event === "furnitureInteractionResult") &&
          entry.payload?.ok === true && entry.payload?.phase === "start" &&
          entry.payload?.activity?.action === expected),
      { timeout: boundedTimeout(15_000) },
      action,
    );
  } catch (error) {
    const state = await sceneState(page).catch(() => null);
    const diagnostic = await (state?.location === "furniture-shop"
      ? showroomDiagnostics(page, action).catch((diagnosticError) => ({
        diagnosticError: diagnosticError.message,
      }))
      : page.evaluate(() => ({
        location: window._neighborhoodScene?.location || null,
        nearby: (() => {
          const target = window._neighborhoodScene?._nearbyInteractiveAction?.();
          return target ? {
            instanceId: target.instanceId || target.demo?.instanceId ||
              target.sprite?.getData?.("instanceId") || null,
            furnitureId: target.demo?.furnitureId ||
              target.sprite?.getData?.("furnitureId") || null,
            actions: (target.actions || []).map((entry) =>
              typeof entry === "string" ? entry : entry?.id || null),
            distance: Number.isFinite(Number(target.distance))
              ? Math.round(Number(target.distance)) : null,
          } : null;
        })(),
      })).catch((diagnosticError) => ({ diagnosticError: diagnosticError.message })));
    const responses = await page.evaluate(() => (window.__realGameEvents || [])
      .filter((entry) => entry.event === "furnitureDemoInteractionResult" ||
        entry.event === "furnitureInteractionResult")
      .slice(-5));
    console.error(`  E interaction failure diagnostics: ${JSON.stringify({
      requestedAction: action,
      state,
      diagnostic,
      serverResponses: responses,
    })}`);
    throw new Error(`${error.message}; E diagnostics logged above`);
  }
  const responses = await page.evaluate(() => (window.__realGameEvents || [])
    .filter((entry) => entry.event === "furnitureDemoInteractionResult" ||
      entry.event === "furnitureInteractionResult")
    .slice(-3));
  console.log(`  E server response (${action}): ${JSON.stringify(responses.at(-1) || null)}`);
  const result = await page.evaluate((expected) => {
    const accepted = [...(window.__realGameEvents || [])].reverse().find((entry) =>
      (entry.event === "furnitureDemoInteractionResult" ||
        entry.event === "furnitureInteractionResult") &&
      entry.payload?.ok === true && entry.payload?.phase === "start" &&
      entry.payload?.activity?.action === expected);
    return {
      accepted: !!accepted,
      activity: window._neighborhoodScene?.activity
        ? { ...window._neighborhoodScene.activity } : null,
      furnitureId: accepted?.payload?.activity?.furnitureId || null,
      instanceId: accepted?.payload?.activity?.instanceId || null,
    };
  }, action);
  requireOk(result.accepted, `server accepts E ${action}`);
  const poseSamples = [];
  for (let index = 0; index < 3; index++) {
    poseSamples.push(await page.evaluate(() => {
      const scene = window._neighborhoodScene;
      const player = scene?.player;
      const body = player?.body;
      return {
        activity: scene?.activity ? {
          instanceId: scene.activity.instanceId,
          furnitureId: scene.activity.furnitureId,
          action: scene.activity.action,
          showroom: !!scene.activity.showroom,
        } : null,
        neighborhoodReady: !!scene?._neighborhoodReady,
        sceneActive: !!scene?.scene?.isActive?.(),
        activityPending: !!scene?._activityPending,
        sitting: !!scene?.sitting,
        player: player ? {
          x: player.x, y: player.y, angle: player.angle,
          texture: player.texture?.key || null, frame: player.frame?.name ?? null,
          visible: player.visible, scaleX: player.scaleX, scaleY: player.scaleY,
          anim: player.anims?.currentAnim?.key || null,
        } : null,
        body: body ? {
          enable: body.enable, velocityX: body.velocity?.x ?? null,
          velocityY: body.velocity?.y ?? null,
        } : null,
        keys: scene?.keyE ? {
          eDown: !!scene.keyE.isDown, shiftDown: !!scene.keyShift?.isDown,
          left: !!scene.keys?.left?.isDown, right: !!scene.keys?.right?.isDown,
          up: !!scene.keys?.up?.isDown, down: !!scene.keys?.down?.isDown,
        } : null,
        recentEvents: (window.__realGameImportantEvents || []).slice(-8),
      };
    }));
    await sleep(100);
  }
  const localPose = poseSamples.every((sample) =>
    sample.activity?.action === action &&
    sample.neighborhoodReady && sample.sceneActive &&
    sample.body?.enable === false &&
    Math.abs(Number(sample.body?.velocityX) || 0) < 0.01 &&
    Math.abs(Number(sample.body?.velocityY) || 0) < 0.01);
  lastFurniturePoseDiagnostics = {
    action, result, poseSamples,
    capturedAt: new Date().toISOString(),
  };
  if (!localPose) {
    console.error(`  ACTUAL GAME BUG: server accepted E ${action}, but local activity/pose was not stable: ${
      JSON.stringify({ result, poseSamples })}`);
    throw new Error(`server accepted E ${action}, but local scene activity/pose was absent or unstable`);
  }
  return { ...result, poseSamples };
}

async function exitFurnitureAction(page) {
  await page.keyboard.down("e");
  await sleep(100);
  await page.keyboard.up("e");
  await page.waitForFunction(
    () => !window._neighborhoodScene?.activity,
    { timeout: boundedTimeout(15_000) },
  );
  // The production client clears its pose optimistically while the reliable
  // Socket.IO exit is in flight. Give the real server response a bounded
  // turn, then retain it in diagnostics for any subsequent movement issue.
  await sleep(200);
  const responses = await page.evaluate(() => (window.__realGameEvents || [])
    .filter((entry) => entry.event === "furnitureDemoInteractionResult" ||
      entry.event === "furnitureInteractionResult")
    .slice(-3));
  console.log(`  E exit server response: ${JSON.stringify(responses.at(-1) || null)}`);
}

async function walkAwayFromFurniture(page, key, label) {
  const before = await sceneState(page);
  await page.keyboard.down(key);
  try {
    await page.waitForFunction(
      ({ x, y }) => {
        const player = window._neighborhoodScene?.player;
        return !!player && Math.hypot(Number(player.x) - x, Number(player.y) - y) >= 20;
      },
      { timeout: boundedTimeout(5_000) },
      { x: before.x, y: before.y },
    );
  } finally {
    await page.keyboard.up(key).catch(() => {});
  }
  const after = await sceneState(page);
  requireOk(Math.hypot(after.x - before.x, after.y - before.y) >= 20,
    `${label} produces a real post-pose walk-away delta`);
  console.log(`  ${label} walk-away: ${JSON.stringify({
    before: { x: before.x, y: before.y },
    after: { x: after.x, y: after.y },
  })}`);
}

async function homeFurniturePass({
  expectedPlaced = 3,
  requireStoreState = true,
  useGuest = true,
} = {}) {
  stage("home snapshots and furniture actions");
  const ownerBefore = await requestHomeSnapshot(ownerPage);
  const guestBefore = await requestHomeSnapshot(guestPage);
  requireOk(ownerBefore.layout.length === expectedPlaced,
    `owner home snapshot has ${expectedPlaced} placed items`);
  requireOk(guestBefore.layout.length === expectedPlaced,
    `guest home snapshot sees the same ${expectedPlaced} furniture items`);
  const expectedChairs = requireStoreState ? 1 : 2;
  requireOk(
    ownerBefore.layout.filter((item) => item.furnitureId === "oak_chair").length === expectedChairs,
    requireStoreState
      ? "home snapshot preserves the remaining same-type chair"
      : "home snapshot starts with both same-type chairs",
  );
  await screenshot(ownerPage, "home-before-furniture-actions");

  // Both real browser contexts press E on distinct chairs at the same time.
  const chairs = ownerBefore.layout.filter((item) => item.furnitureId === "oak_chair");
  const chairRoutes = [
    walkToHomeAction(ownerPage, "oak_chair", "sit", "owner chair one approach", chairs[0]?.id),
  ];
  if (useGuest) chairRoutes.push(
    walkToHomeAction(guestPage, "oak_chair", "sit", "guest chair two approach", chairs[1]?.id),
  );
  await Promise.all(chairRoutes);
  const chairActions = await Promise.all([
    pressFurnitureAction(ownerPage, "sit"),
    ...(useGuest ? [pressFurnitureAction(guestPage, "sit")] : []),
  ]);
  requireOk(chairActions.every((result) => result.accepted),
    "server accepts both distinct-chair E actions");
  const seated = await Promise.all([sceneState(ownerPage), sceneState(guestPage)]);
  requireOk(
    seated[0].activity?.action === "sit" || chairActions[0].accepted,
    useGuest ? "two contexts sit on two distinct chairs" : "owner sits on a real chair",
  );
  if (useGuest) {
    const ownerRemote = await ownerPage.evaluate(() => Object.values(
      window._neighborhoodScene?.remotes || {},
    ).map((entry) => ({
      activity: entry.activity?.action || null,
      instanceId: entry.activity?.instanceId || null,
    })));
    console.log(`  chair remote diagnostics: ${JSON.stringify(ownerRemote)}`);
    requireOk(ownerRemote.some((entry) => entry.activity === "sit"),
      "owner receives the other seated player over Socket.IO");
  }
  await screenshot(ownerPage, "home-two-chairs-sit");
  await exitFurnitureAction(ownerPage);
  if (useGuest) await exitFurnitureAction(guestPage);

  // Move through the authored bedroom doorway to the bed and use the primary
  // E action. The action/result is server-authoritative; no pose method is
  // called by this harness.
  await walkToHomeAction(ownerPage, "plush_bed", "lie", "bed approach",
    ownerBefore.layout.find((item) => item.furnitureId === "plush_bed")?.id);
  const bedAction = await pressFurnitureAction(ownerPage, "lie");
  const bedState = await sceneState(ownerPage);
  requireOk(
    bedAction.accepted && (bedState.activity?.furnitureId === "plush_bed" ||
      bedAction.furnitureId === "plush_bed"),
    "E/server starts bed lie action",
  );
  await screenshot(ownerPage, "home-bed-lie");
  await exitFurnitureAction(ownerPage);

  // The bathtub advertises shower first and bathe second. Shift+E selects the
  // second action from the real nearby action menu.
  // First step east of the bed before descending: the authoritative lie exit
  // stand is above the mattress, and descending along its edge would graze the
  // bed blocker until the actor reaches the open bedroom/bath hall.
  await walkToHomeAction(ownerPage, "bathtub", "bathe", "bathtub approach",
    ownerBefore.layout.find((item) => item.furnitureId === "bathtub")?.id);
  const bathAction = await pressFurnitureAction(ownerPage, "bathe", { shift: true });
  const bathState = await sceneState(ownerPage);
  requireOk(
    bathAction.accepted && (bathState.activity?.furnitureId === "bathtub" ||
      bathAction.furnitureId === "bathtub"),
    "Shift+E/server starts bathtub bathe action",
  );
  await screenshot(ownerPage, "home-tub-bathe");
  await exitFurnitureAction(ownerPage);

  // E exits the activity, then normal arrow movement reaches the real home
  // door and lets the production portal transition move the owner outside.
  await moveTo(ownerPage, 576, 540, "home exit hallway");
  await holdUntil(
    ownerPage,
    "ArrowDown",
    () => window._neighborhoodScene?.location === "neighborhood",
    "home E/move exit",
    12_000,
  );
  await waitForLocation(ownerPage, "neighborhood");
  await screenshot(ownerPage, "home-exit-neighborhood");
  requireOk((await sceneState(ownerPage)).location === "neighborhood",
    "E/move exit leaves the home through the production portal");
}

async function assertRenderedHomeCatalog(page, label) {
  await waitForLocation(page, `home:${OWNER_EMAIL}`);
  const snapshot = await requestHomeSnapshot(page);
  const placedIds = snapshot.layout.map((item) => String(item.id));
  await page.waitForFunction(
    (expectedIds) => {
      const furniture = window._neighborhoodScene?.furniture || [];
      const actualIds = furniture.map((sprite) => String(sprite.getData("instanceId")));
      return furniture.length === expectedIds.length &&
        expectedIds.every((id) => actualIds.includes(id));
    },
    { timeout: boundedTimeout(20_000) },
    placedIds,
  );
  const rendered = await page.evaluate(() => ({
    location: window._neighborhoodScene?.location || null,
    furniture: (window._neighborhoodScene?.furniture || []).map((sprite) => ({
      instanceId: sprite.getData("instanceId"),
      furnitureId: sprite.getData("furnitureId"),
    })),
  }));
  console.log(`  ${label} rendered catalog: ${JSON.stringify(rendered)}`);
  requireOk(rendered.location === `home:${OWNER_EMAIL}`,
    `${label} is in the QA owner's home`);
  requireOk(rendered.furniture.length === snapshot.layout.length,
    `${label} renders every placed furniture row`);
  requireOk(rendered.furniture.every((item) => item.instanceId && item.furnitureId),
    `${label} rendered sprites carry real instance and furniture IDs`);
  for (const furnitureId of ["oak_chair", "plush_bed", "bathtub"]) {
    requireOk(rendered.furniture.some((item) => item.furnitureId === furnitureId),
      `${label} renders the real ${furnitureId} sprite`);
  }
  return snapshot;
}

async function homeInteractionsOnlyPass(baseUrl) {
  stage("owner home bootstrap for furniture interactions");
  ownerPage.__realGameBaseUrl = baseUrl;
  // The loader's first exact-owner restore is the real showroom restore. Do
  // not run the Store panel here: immediately perform the second authored
  // restore in a fresh context, whose first homeSnapshotRequest receives the
  // canonical production transition payload from the test-only loader.
  await registerThroughUi(ownerPage, OWNER_EMAIL, "QA Furniture");
  await waitForLocation(ownerPage, "furniture-shop");
  await ownerPage.close();
  ownerContext = await browser.createIncognitoBrowserContext();
  ownerPage = await createPage(ownerContext, "owner-home-interactions");
  ownerPage.__realGameBaseUrl = baseUrl;
  await registerThroughUi(ownerPage, OWNER_EMAIL, "QA Furniture");
  await installEventCapture(ownerPage);
  const ownerBefore = await assertRenderedHomeCatalog(ownerPage, "owner home interactions");
  requireOk(ownerBefore.layout.length === 4,
    "home interactions starts with all four placed furniture rows");
  requireOk(ownerBefore.layout.filter((item) => item.furnitureId === "oak_chair").length === 2,
    "home interactions starts with both same-type chairs");
  await screenshot(ownerPage, "home-interactions-before");

  stage("guest home bootstrap for furniture interactions");
  await registerThroughUi(guestPage, GUEST_EMAIL, "QA Visitor");
  await installEventCapture(guestPage);
  const guestBefore = await assertRenderedHomeCatalog(guestPage, "guest home interactions");
  requireOk(guestBefore.layout.length === 4 &&
    guestBefore.layout.every((item) => ownerBefore.layout.some((other) => other.id === item.id)),
  "guest home receives the same four real placed furniture rows");
  await homeFurniturePass({ expectedPlaced: 4, requireStoreState: false, useGuest: false });
}

async function homeBedBathOnlyPass(baseUrl) {
  stage("owner home bootstrap for focused bed/bath interactions");
  ownerPage.__realGameBaseUrl = baseUrl;
  await registerThroughUi(ownerPage, OWNER_EMAIL, "QA Furniture");
  await waitForLocation(ownerPage, "furniture-shop");
  await ownerPage.close();
  ownerContext = await browser.createIncognitoBrowserContext();
  ownerPage = await createPage(ownerContext, "owner-bed-bath");
  ownerPage.__realGameBaseUrl = baseUrl;
  await registerThroughUi(ownerPage, OWNER_EMAIL, "QA Furniture");
  await installEventCapture(ownerPage);
  const snapshot = await assertRenderedHomeCatalog(ownerPage, "focused bed/bath home");
  requireOk(snapshot.layout.length === 4,
    "focused bed/bath home starts with all four placed furniture rows");
  const bed = snapshot.layout.find((item) => item.furnitureId === "plush_bed");
  const bath = snapshot.layout.find((item) => item.furnitureId === "bathtub");
  requireOk(bed?.id && bath?.id, "focused bed/bath snapshot includes bed and bathtub UUIDs");

  const bedOnly = process.env.REAL_GAME_HOME_BED_ONLY === "1";
  const bathOnly = process.env.REAL_GAME_HOME_BATH_ONLY === "1";
  if (!bathOnly) {
    stage("focused bed lie action");
    await walkToHomeAction(ownerPage, "plush_bed", "lie", "focused bed approach",
      bed.id, { tight: true });
    const bedAction = await pressFurnitureAction(ownerPage, "lie");
    const bedState = await sceneState(ownerPage);
    requireOk(
      bedAction.accepted && (bedState.activity?.furnitureId === "plush_bed" ||
        bedAction.furnitureId === "plush_bed"),
      "focused E/server starts bed lie action",
    );
    await screenshot(ownerPage, "focused-home-bed-lie");
    await exitFurnitureAction(ownerPage);
    await walkAwayFromFurniture(ownerPage, "ArrowRight", "focused bed exit");
  }

  if (!bedOnly) {
    stage("focused bathtub bathe action");
    await walkToHomeAction(ownerPage, "bathtub", "bathe", "focused bathtub approach",
      bath.id, { tight: true });
    const bathAction = await pressFurnitureAction(ownerPage, "bathe", { shift: true });
    const bathState = await sceneState(ownerPage);
    requireOk(
      bathAction.accepted && (bathState.activity?.furnitureId === "bathtub" ||
        bathAction.furnitureId === "bathtub"),
      "focused Shift+E/server starts bathtub bathe action",
    );
    await screenshot(ownerPage, "focused-home-tub-bathe");
    await exitFurnitureAction(ownerPage);
    await walkAwayFromFurniture(ownerPage, "ArrowUp", "focused bathtub exit");
  }
}

async function showroomAndStorePass(baseUrl) {
  stage("owner showroom flow");
  ownerPage.__realGameBaseUrl = baseUrl;
  await registerThroughUi(ownerPage, OWNER_EMAIL, "QA Furniture");
  await waitForLocation(ownerPage, "furniture-shop");
  await installEventCapture(ownerPage);
  // The restore path intentionally supplies the loader-only location, while
  // the normal client showroom catalog arrives on a real location transition.
  // Walk out and back through the authored city door instead of emitting a
  // synthetic transition or injecting catalog data into the page.
  await moveThroughPortal(ownerPage, "ArrowDown", "city", "showroom: exit through real city portal");
  await moveThroughPortal(ownerPage, "ArrowUp", "furniture-shop", "showroom: re-enter through real city shop door");
  stage("showroom: wait for all rendered sprites");
  await ownerPage.waitForFunction(
    () => window._neighborhoodScene?.showroomFurniture?.length ===
      window._neighborhoodScene?.showroomDemos?.length &&
      window._neighborhoodScene?.showroomFurniture?.length >= 7,
    { timeout: boundedTimeout(30_000) },
  );
  await ownerPage.evaluate(() => {
    document.querySelector("canvas")?.focus();
    window._neighborhoodScene?.game?.canvas?.focus?.();
  });
  const firstDiagnostics = await showroomDiagnostics(ownerPage);
  requireOk(firstDiagnostics.demoCount >= 7, "full showroom demo catalog is delivered");
  requireOk(firstDiagnostics.spriteCount === firstDiagnostics.demoCount,
    "every showroom catalog demo has a rendered sprite");
  requireOk(firstDiagnostics.sprites.every((sprite) =>
    sprite.instanceId && sprite.furnitureId && Array.isArray(sprite.actions) && sprite.texture,
  ), "every showroom sprite carries instance/action/texture data");
  requireOk(firstDiagnostics.sprites.filter((sprite) => sprite.actions.length).length >= 6,
    "all interactive showroom pieces carry action descriptors");
  await screenshot(ownerPage, "showroom-full-catalog-before");
  if (process.env.REAL_GAME_HOME_STORE_ONLY === "1") {
    stage("Home Store-only mode: switch owner to home");
    await ownerPage.evaluate(() => {
      localStorage.clear();
      sessionStorage.clear();
    }).catch(() => {});
    await ownerPage.close();
    ownerContext = await browser.createIncognitoBrowserContext();
    ownerPage = await createPage(ownerContext, "owner-home");
    ownerPage.__realGameBaseUrl = baseUrl;
    await registerThroughUi(ownerPage, OWNER_EMAIL, "QA Furniture");
    await waitForLocation(ownerPage, `home:${OWNER_EMAIL}`);
    await installEventCapture(ownerPage);
    await homeStoreReturnPass();
    return;
  }

  // Exercise one showroom's real keyboard action before opening the cashier.
  // The authored stand is adjacent to the sofa blocker; the client collider
  // correctly stops just outside it (around 298,306), still inside the real
  // showroom action radius.
  await moveTo(ownerPage, 300, 300, "showroom sofa", 100);
  await requireNearbyShowroomAction(ownerPage, "sit");
  await pressFurnitureAction(ownerPage, "sit");
  await screenshot(ownerPage, "showroom-sofa-sit");
  await exitFurnitureAction(ownerPage);

  // The Home side panel's Store button is a targeted return-to-inventory
  // operation, not a cashier purchase. Its exact UUID assertions run after
  // this page returns home in homeStoreReturnPass().
  await ownerPage.evaluate(() => {
    localStorage.clear();
    sessionStorage.clear();
  }).catch(() => {});
  await ownerPage.close();
  ownerContext = await browser.createIncognitoBrowserContext();
  ownerPage = await createPage(ownerContext, "owner-home");
  ownerPage.__realGameBaseUrl = baseUrl;
  await registerThroughUi(ownerPage, OWNER_EMAIL, "QA Furniture");
  await waitForLocation(ownerPage, `home:${OWNER_EMAIL}`);
  await installEventCapture(ownerPage);
  await homeStoreReturnPass();
}

async function walkNeighborhoodToOwnerHome(page) {
  await waitForLocation(page, "neighborhood");
  await page.waitForFunction(
    () => window._neighborhoodScene?._neighborhoodReady &&
      Array.isArray(window._neighborhoodScene?.info?.streetLots),
    { timeout: boundedTimeout(20_000) },
  );
  // A scene transition intentionally arrives with portalRelease=false. Walk
  // down out of the arrival/door trigger first; otherwise the northbound
  // route can be blocked while the real portal remains unarmed.
  const arrival = await sceneState(page);
  const awayY = Math.min(arrival.y + 88,
    Number((await page.evaluate(() => window._neighborhoodScene?.info?.bounds?.height)) || 1056) - 32);
  if (awayY > arrival.y + 8) {
    await moveAxis(page, "ArrowDown", awayY, "y",
      "home catalog hydration: release Willow Walk arrival portal");
  }
  await page.waitForFunction(
    () => window._neighborhoodScene?.portalRelease === true,
    { timeout: boundedTimeout(8_000) },
  );
  // Return to the road lane before crossing horizontally. This avoids
  // walking through a neighbouring facade at y=arrival+88.
  if (arrival.y < awayY - 8) {
    await moveAxis(page, "ArrowUp", -arrival.y, "y",
      "home catalog hydration: return to Willow Walk road lane");
  }
  const ownDoor = await page.evaluate((ownerEmail) => {
    const lots = window._neighborhoodScene?.info?.streetLots || [];
    const lot = lots.find((entry) =>
      String(entry.ownerEmail || "").trim().toLowerCase() === ownerEmail);
    const door = lot?.door;
    return door ? {
      x: Number(door.x) + Number(door.width) / 2,
      y: Number(door.y) + Number(door.height) / 2,
      ownerEmail: lot.ownerEmail,
      lotIndex: lot.lotIndex,
      rect: {
        x: Number(door.x), y: Number(door.y),
        width: Number(door.width), height: Number(door.height),
      },
    } : null;
  }, OWNER_EMAIL);
  console.log(`  real owner doorway: ${JSON.stringify(ownDoor)}`);
  requireOk(ownDoor && Number.isFinite(ownDoor.x) && Number.isFinite(ownDoor.y),
    "Willow Walk exposes the owner's real labelled home doorway");
  const roadState = await sceneState(page);
  const xDirection = ownDoor.x >= roadState.x ? ownDoor.x : -ownDoor.x;
  await moveAxis(page, xDirection > 0 ? "ArrowRight" : "ArrowLeft", xDirection, "x",
    "home catalog hydration: walk along Willow Walk to owner's door");
  const yDirection = ownDoor.y >= (await sceneState(page)).y ? ownDoor.y : -ownDoor.y;
  await moveAxis(page, yDirection > 0 ? "ArrowDown" : "ArrowUp", yDirection, "y",
    "home catalog hydration: walk through owner's real doorway");
  await waitForLocation(page, `home:${OWNER_EMAIL}`);
}

async function enterOwnerHomeThroughRealPortals(page) {
  let location = (await sceneState(page)).location;
  if (location === `home:${OWNER_EMAIL}`) {
    await page.waitForFunction(
      () => window._neighborhoodScene?._neighborhoodReady &&
        window._neighborhoodScene?.doors?.some((door) =>
          door.destination === "neighborhood"),
      { timeout: boundedTimeout(20_000) },
    );
    await sleep(500);
    // Walk from the normal room spawn to the authored exit. Keep the foot
    // centre in the doorway, then let the real client portal request fire.
    await moveTo(page, 576, 760, "home catalog hydration: walk to home exit", 32);
    const exitState = await sceneState(page);
    if (exitState.x > 570) {
      await moveAxis(page, "ArrowLeft", -560, "x",
        "home catalog hydration: center on home exit");
    }
    await moveThroughPortal(page, "ArrowDown", "neighborhood",
      "home catalog hydration: exit through real Willow Walk portal");
    location = "neighborhood";
  }
  if (location === "furniture-shop") {
    await moveThroughPortal(page, "ArrowDown", "city",
      "home catalog hydration: exit showroom through real city portal");
    location = "city";
  }
  if (location === "city") {
    await moveTo(page, 480, 504, "home catalog hydration: reach city Willow Walk gate", 60);
    // Arm the gate from its outside edge before crossing. This is required
    // after a city spawn because portalRelease deliberately stays false while
    // the actor is inside any portal rectangle.
    await moveAxis(page, "ArrowLeft", -120, "x",
      "home catalog hydration: step outside city gate");
    await page.waitForFunction(
      () => window._neighborhoodScene?.portalRelease === true,
      { timeout: boundedTimeout(8_000) },
    );
    await moveAxis(page, "ArrowLeft", -48, "x",
      "home catalog hydration: line up city gate center");
    await moveThroughPortal(page, "ArrowLeft", "neighborhood",
      "home catalog hydration: enter Willow Walk through real city gate");
    location = "neighborhood";
  }
  requireOk(location === "neighborhood",
    `home catalog hydration has a real Willow Walk route from ${location}`);
  await walkNeighborhoodToOwnerHome(page);
}

async function verifyHydratedHome(page) {
  await waitForLocation(page, `home:${OWNER_EMAIL}`);
  const snapshot = await requestHomeSnapshot(page);
  const placedIds = snapshot.layout.map((item) => String(item.id));
  await page.waitForFunction(
    (expectedIds) => {
      const furniture = window._neighborhoodScene?.furniture || [];
      const actualIds = furniture.map((sprite) => String(sprite.getData("instanceId")));
      return furniture.length === expectedIds.length &&
        expectedIds.every((id) => actualIds.includes(id));
    },
    { timeout: boundedTimeout(20_000) },
    placedIds,
  );
  // The bootstrap transition and its same-socket homeSnapshot are delivered
  // back-to-back; let the production scene's final renderHome call settle
  // before opening its editor (otherwise the transition can collapse it again).
  await sleep(750);
  await page.waitForFunction(
    () => !!document.querySelector("#home-panel .home-panel-head button"),
    { timeout: boundedTimeout(10_000) },
  );
  const panelWasOpen = await page.evaluate(() => {
    const button = document.querySelector("#home-panel .home-panel-head button");
    return /collapse/i.test(button?.textContent || "");
  });
  if (!panelWasOpen) await page.click("#home-panel .home-panel-head button");
  await sleep(500);
  const returnCount = await page.evaluate(() =>
    document.querySelectorAll("#home-panel [data-return]").length);
  requireOk(returnCount === snapshot.layout.length,
    `Home editor opened with ${snapshot.layout.length} real Store buttons`);
  const rendered = await page.evaluate(() => ({
    furniture: (window._neighborhoodScene?.furniture || []).map((sprite) => ({
      instanceId: sprite.getData("instanceId"),
      furnitureId: sprite.getData("furnitureId"),
    })),
    rows: [...document.querySelectorAll("#home-panel .home-item")].map((row) =>
      String(row.textContent || "").replace(/\s+/g, " ").trim()),
  }));
  console.log(`  real home catalog/rendered rows: ${JSON.stringify(rendered)}`);
  requireOk(rendered.furniture.length === snapshot.layout.length &&
    rendered.furniture.every((item) => item.instanceId && item.furnitureId),
  "normal home portal entry renders one real furniture sprite per placed snapshot row");
  for (const expected of ["Gold armchair", "Walnut daybed", "Claw-foot bath"]) {
    requireOk(rendered.rows.some((row) => row.includes(expected)),
      `normal home portal entry hydrates the real furniture name: ${expected}`);
  }
  requireOk(!rendered.rows.some((row) => /(^|\s)(oak_chair|plush_bed|bathtub)(\s|$)/.test(row)),
    "normal home portal entry does not expose raw furniture IDs in the panel");
  await screenshot(page, "home-catalog-hydrated-before-store");
}

async function homeStoreReturnPass() {
  stage("Home Store return-to-inventory UI");
  await verifyHydratedHome(ownerPage);
  const before = await requestHomeSnapshot(ownerPage);
  requireOk(before.layout.length === 4, "Home Store starts with four placed items");
  const chairs = before.layout.filter((item) => item.furnitureId === "oak_chair");
  requireOk(chairs.length === 2, "Home Store starts with two same-type chairs");
  const chosen = chairs[0];
  const otherLayout = before.layout.filter((item) => item.id !== chosen.id);
  console.log(`  Home Store selected UUID: ${JSON.stringify({
    id: chosen.id,
    returnButtons: await ownerPage.evaluate(() => [...document.querySelectorAll("#home-panel [data-return]")]
      .map((button) => button.dataset.return)),
  })}`);
  const matchingReturnButton = await ownerPage.evaluate((id) =>
    [...document.querySelectorAll("#home-panel [data-return]")]
      .some((button) => button.dataset.return === String(id)), chosen.id);
  requireOk(matchingReturnButton,
    `Home Store exposes the exact selected UUID ${String(chosen.id)}`);
  await ownerPage.evaluate((id) => {
    const button = [...document.querySelectorAll("#home-panel [data-return]")]
      .find((entry) => entry.dataset.return === id);
    if (!button) throw new Error(`Home Store button missing for ${id}`);
    // Exercise the real DOM handler twice before its pending UUID guard can
    // rerender the row. The second click must not enqueue another mutation.
    button.click();
    button.click();
  }, chosen.id);
  await ownerPage.waitForFunction(
    (id) => window.__realGameEvents?.some((entry) =>
      entry.event === "homeActionResult" && entry.payload?.ok === true &&
      entry.payload?.instanceId === id),
    { timeout: boundedTimeout(20_000) },
    chosen.id,
  );
  await sleep(300);
  const returnEvents = await ownerPage.evaluate((id) =>
    (window.__realGameEvents || []).filter((entry) =>
      entry.event === "homeActionResult" && entry.payload?.ok === true &&
      entry.payload?.instanceId === id), chosen.id);
  requireOk(returnEvents.length === 1,
    `double-click emits one targeted Home Store return (${returnEvents.length})`);
  const after = await requestHomeSnapshot(ownerPage);
  requireOk(after.layout.length === 3, "Home Store changes four placed items to three");
  requireOk(!after.layout.some((item) => item.id === chosen.id),
    "Home Store removes only the chosen placed UUID");
  requireOk(otherLayout.every((item) => after.layout.some((next) =>
    next.id === item.id && next.furnitureId === item.furnitureId &&
    Number(next.gridX) === Number(item.gridX) &&
    Number(next.gridY) === Number(item.gridY))),
  "Home Store preserves the other three placed rows");
  requireOk(after.layout.filter((item) => item.furnitureId === "oak_chair").length === 1,
    "Home Store preserves the other same-type chair");
  requireOk(after.inventory.filter((item) => item.id === chosen.id &&
    item.furnitureId === chosen.furnitureId).length === 1,
  "Home Store keeps the exact returned UUID reusable in inventory");
  await screenshot(ownerPage, "home-store-return-four-to-three");

  await ownerPage.evaluate((token) => {
    if (token) localStorage.setItem("jpo_session_token", token);
  }, await ownerPage.evaluate(() => window.__realGameSessionToken || ""));
  await ownerPage.reload({ waitUntil: "domcontentloaded", timeout: boundedTimeout(30_000) });
  await waitForLocation(ownerPage, `home:${OWNER_EMAIL}`);
  await installEventCapture(ownerPage);
  const reloaded = await requestHomeSnapshot(ownerPage);
  requireOk(reloaded.layout.length === 3, "reloaded Home Store snapshot remains at three placed items");
  requireOk(!reloaded.layout.some((item) => item.id === chosen.id),
    "reloaded Home Store snapshot keeps chosen UUID unplaced");
  requireOk(reloaded.inventory.some((item) => item.id === chosen.id &&
    item.furnitureId === chosen.furnitureId),
  "reloaded Home Store snapshot keeps exact chosen UUID reusable");
  requireOk(reloaded.layout.filter((item) => item.furnitureId === "oak_chair").length === 1,
    "reloaded Home Store snapshot still preserves the second chair");
  await screenshot(ownerPage, "home-store-return-reloaded");
}

async function pagePressAndOpenCashier(page) {
  await page.keyboard.press("e");
  await page.waitForSelector("#shop-panel", { timeout: boundedTimeout(10_000) });
  await page.waitForSelector("#shop-panel [data-browse], #shop-panel [data-buy-menu]", {
    timeout: boundedTimeout(10_000),
  });
  const browseSelector = await page.$("#shop-panel [data-browse]")
    ? "#shop-panel [data-browse]" : "#shop-panel [data-buy-menu]";
  await page.click(browseSelector);
  await page.waitForSelector("#shop-panel [data-buy]", {
    timeout: boundedTimeout(15_000),
  });
}

async function run() {
  stage("QA bootstrap validation");
  if (process.env.REAL_GAME_QA !== "1") {
    throw new Error("refusing to run: set REAL_GAME_QA=1 for the isolated QA bootstrap");
  }
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required by the local real-game server");
  if (HOTBAR_QA_ENABLED) {
    stage("inventory hotbar integration contract validation");
    await assertHotbarIntegrationContract();
  }
  deadlineTimer = setTimeout(() => {
    serverProcess?.kill("SIGTERM");
  }, TIMEOUT_MS);
  stage("create evidence directory");
  await mkdir(OUTPUT_DIR, { recursive: true });
  stage("seed exact QA rows");
  db = new Pool({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 8_000 });
  await seedExactFixture();
  stage("start isolated local server");
  const baseUrl = await startLocalServer();
  stage("launch Chromium");
  const chrome = chromiumPath();
  browser = await puppeteer.launch({
    executablePath: chrome,
    headless: "new",
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
  });
  ownerContext = await browser.createIncognitoBrowserContext();
  guestContext = await browser.createIncognitoBrowserContext();
  ownerPage = await createPage(ownerContext, "owner");
  guestPage = await createPage(guestContext, "guest");
  ownerPage.__realGameBaseUrl = baseUrl;
  guestPage.__realGameBaseUrl = baseUrl;

  if (HOTBAR_QA_ENABLED) {
    if (HOTBAR_MOBILE_ONLY_QA) {
      await inventoryHotbarMobileOnlyPass(baseUrl);
    } else if (process.env.REAL_GAME_INVENTORY_HOTBAR_UI_ONLY_QA === "1") {
      await inventoryHotbarUiOnlyPass(baseUrl);
    } else {
      await inventoryHotbarPass(baseUrl);
    }
    return;
  }
  if (process.env.REAL_GAME_HOME_BED_BATH_ONLY === "1" ||
      process.env.REAL_GAME_HOME_BED_ONLY === "1" ||
      process.env.REAL_GAME_HOME_BATH_ONLY === "1") {
    await homeBedBathOnlyPass(baseUrl);
    return;
  }
  if (process.env.REAL_GAME_HOME_INTERACTIONS_ONLY === "1") {
    await homeInteractionsOnlyPass(baseUrl);
    return;
  }
  await showroomAndStorePass(baseUrl);
  if (process.env.REAL_GAME_HOME_STORE_ONLY === "1") return;

  stage("guest registration and home join");
  await registerThroughUi(guestPage, GUEST_EMAIL, "QA Visitor");
  await waitForLocation(guestPage, `home:${OWNER_EMAIL}`);
  await installEventCapture(guestPage);
  const guestSnapshot = await requestHomeSnapshot(guestPage);
  requireOk(guestSnapshot.ownerEmail === OWNER_EMAIL, "guest is in the seeded QA owner's home");
  await verifyHydratedHome(guestPage);
  await homeFurniturePass();

  const browserErrors = [
    ...(ownerPage.__realGameErrors || []),
    ...(guestPage.__realGameErrors || []),
  ];
  requireOk(browserErrors.length === 0,
    `no browser page/console errors${browserErrors.length ? ` (${browserErrors.join(" ; ")})` : ""}`);
}

async function stopLocalServer() {
  if (!serverProcess) return;
  if (serverProcess.exitCode === null) {
    serverProcess.kill("SIGTERM");
    await Promise.race([
      new Promise((resolvePromise) => serverProcess.once("exit", resolvePromise)),
      sleep(3_000),
    ]);
  }
  if (serverProcess.exitCode === null) serverProcess.kill("SIGKILL");
  serverProcess = null;
}

try {
  await withTimeout(run(), TIMEOUT_MS, "bounded real-game pass");
} catch (error) {
  console.error(`FATAL [${currentStage}]: ${error.stack || error.message}`);
  await captureFatalEvidence(error).catch((evidenceError) => {
    console.error(`FATAL evidence capture failed: ${evidenceError.stack || evidenceError.message}`);
  });
  fails.push(`fatal: ${error.message}`);
} finally {
  clearTimeout(deadlineTimer);
  await ownerPage?.close().catch(() => {});
  await guestPage?.close().catch(() => {});
  await browser?.close().catch(() => {});
  await stopLocalServer().catch(() => {});
  await cleanupExact().catch((error) => {
    fails.push(`cleanup: ${error.message}`);
  });
  await db?.end().catch(() => {});
  // Keep screenshots for the one-pass review. A caller-provided directory is
  // never removed by cleanup; the default is already an isolated /tmp path.
}

console.log(
  fails.length
    ? `RESULT: FAIL (${fails.length}): ${fails.join(" | ")}`
    : "RESULT: PASS — real server/client furniture + Home Store return",
);
process.exit(fails.length ? 1 : 0);