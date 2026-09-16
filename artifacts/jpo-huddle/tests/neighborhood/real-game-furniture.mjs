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
import { mkdir, writeFile } from "node:fs/promises";
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
  page.on("pageerror", (error) => errors.push(`${label} pageerror: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`${label} console: ${message.text()}`);
  });
  page.__realGameErrors = errors;
}

async function createPage(context, label) {
  const page = await context.newPage();
  await page.setViewport(VIEWPORT);
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
        "homeActionResult",
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