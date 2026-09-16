#!/usr/bin/env node

/**
 * Isolated browser-DOM proof for the inventory scope correction.
 *
 * This never starts JPO Huddle or connects to Socket.IO. It loads the actual
 * scope/hotbar browser scripts in Chromium with a clearly labelled, local
 * fixture socket and fixture-owned items, then replays the server's approved,
 * locationTransitionResult, and currentPlayers event shapes.
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "../../node_modules/puppeteer-core/lib/esm/puppeteer/puppeteer-core.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ARTIFACT_ROOT = resolve(HERE, "../..");
const EVIDENCE_DIR = join(ARTIFACT_ROOT, "tests/evidence");
const WILLOW_PROOF = join(EVIDENCE_DIR, "inventory-scope-willow-fixture.png");
const PLAZA_PROOF = join(EVIDENCE_DIR, "inventory-scope-plaza-fixture.png");
const REPORT = join(EVIDENCE_DIR, "inventory-scope-dom-fixture-report.json");
const SOCKET_ID = "fixture-socket-qa";
const OWNER_EMAIL = "inventory-scope-fixture@justpressone.test";

function chromiumPath() {
  const candidates = [
    process.env.CHROMIUM_PATH,
    process.env.PUPPETEER_EXECUTABLE_PATH,
    "/repl/tools/bin/chromium",
  ].filter(Boolean);
  const executablePath = candidates.find(existsSync);
  if (!executablePath) throw new Error("Chromium is required for the isolated DOM fixture.");
  return executablePath;
}

function assertInventory(view, expectedCategories, expectedItems, label) {
  assert.deepEqual(view.categories, expectedCategories, `${label}: visible tabs`);
  assert.deepEqual(view.items.sort(), [...expectedItems].sort(), `${label}: visible inventory items`);
}

async function fixturePage(browser, { authoritativeLocation = null } = {}) {
  const [scopeSource, hotbarSource, cssSource] = await Promise.all([
    readFile(join(ARTIFACT_ROOT, "public/inventory-scope.js"), "utf8"),
    readFile(join(ARTIFACT_ROOT, "public/inventory-hotbar.js"), "utf8"),
    readFile(join(ARTIFACT_ROOT, "public/inventory-hotbar.css"), "utf8"),
  ]);
  const page = await browser.newPage();
  await page.setViewport({ width: 430, height: 540, deviceScaleFactor: 1 });
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  await page.setContent(`<!doctype html>
    <html><head><style>${cssSource}
      html, body { min-height: 100%; margin: 0; overflow: hidden; }
      body { background: repeating-linear-gradient(90deg, #6f9d62 0 47px, #84ad72 48px 95px); }
      #fixture-map-label { position: fixed; top: 18px; left: 18px; z-index: 1; padding: 9px 12px;
        background: rgba(255,255,255,.9); border: 2px solid #1f3d24; border-radius: 7px;
        color: #17301b; font: 700 14px monospace; }
      #fixture-note { position: fixed; top: 64px; left: 18px; z-index: 1; color: #18321c;
        background: rgba(255,255,255,.72); padding: 6px 9px; border-radius: 5px; font: 11px monospace; }
    </style></head><body class="playing">
      <div id="fixture-map-label">TEST FIXTURE — JPO HQ</div>
      <div id="fixture-note">Isolated browser DOM fixture; never connected to live JPO Huddle.</div>
      <canvas tabindex="0"></canvas>
    </body></html>`, { waitUntil: "domcontentloaded" });
  await page.evaluate(({ socketId, ownerEmail, location }) => {
    class FixtureSocket {
      constructor() {
        this.id = socketId;
        this.handlers = new Map();
        this.emitted = [];
      }
      on(event, handler) {
        const list = this.handlers.get(event) || [];
        list.push(handler);
        this.handlers.set(event, list);
      }
      emit(event, payload) {
        this.emitted.push({ event, payload });
      }
      dispatch(event, payload) {
        for (const handler of this.handlers.get(event) || []) handler(payload);
      }
    }
    window.__fixtureSocket = new FixtureSocket();
    window.__fixtureGlobals = {
      _playerEmail: ownerEmail,
      _ownedItems: ["fixture_beanie", "fixture_bunny"],
      _playerItems: { fixture_coffee: 2 },
      _equippedCosmetic: "",
      _equippedWings: "",
      _equippedSlots: {},
      _equippedPet: "",
      _equippedPetAcc: "",
      COSMETICS: [{ id: "fixture_beanie", name: "Fixture Beanie", emoji: "🎩", desc: "HQ wearable" }],
      PETS: [{ id: "fixture_bunny", name: "Fixture Bunny", emoji: "🐰", desc: "HQ pet" }],
      PET_ACCESSORIES: [],
      USABLES: [{ id: "fixture_coffee", name: "Fixture Coffee", emoji: "☕", verb: "Drink", desc: "HQ usable" }],
      WEAR_SLOT: {},
      equipItem() {},
      equipPet() {},
      equipPetAcc() {},
      useItem() {},
    };
    window.JpoNeighborhood = { canPlaceFurniture: () => true, getCurrentLocation: () => "office" };
    if (location) window._jpoAuthoritativeLocation = location;
  }, { socketId: SOCKET_ID, ownerEmail: OWNER_EMAIL, location: authoritativeLocation });
  await page.addScriptTag({ content: scopeSource });
  await page.addScriptTag({ content: hotbarSource });
  await page.evaluate(() => {
    window.initInventoryHotbar(window.__fixtureSocket, () => window.__fixtureGlobals);
  });
  return { page, errors };
}

async function openAndResolveFurniture(page) {
  const isOpen = await page.$eval("#inventory-hotbar", (element) => element.classList.contains("open"));
  if (!isOpen) await page.click("#inventory-toggle-btn");
  const request = await page.evaluate(() => [...window.__fixtureSocket.emitted]
    .reverse().find((entry) => entry.event === "playerFurnitureInventoryRequest"));
  assert.ok(request?.payload && Number.isSafeInteger(request.payload.requestId),
    "fixture hotbar emits the real playerFurnitureInventoryRequest payload");
  await page.evaluate(({ requestId, ownerEmail }) => {
    // This mirrors playerFurnitureInventoryResult from server.js. It includes
    // one grouped furniture item with count 2 and deliberately excludes no
    // item types server-side; presentation scoping is what is under test.
    window.__fixtureSocket.dispatch("playerFurnitureInventoryResult", {
      ok: true,
      requestId,
      ownerEmail,
      revision: 7,
      catalog: { oak_chair: { name: "Fixture Oak Chair", emoji: "🪑", desc: "Neighborhood furniture" } },
      inventory: [
        { id: "fixture-chair-a", furnitureId: "oak_chair" },
        { id: "fixture-chair-b", furnitureId: "oak_chair" },
      ],
      layout: [],
      yard: [],
    });
  }, { requestId: request.payload.requestId, ownerEmail: OWNER_EMAIL });
}

async function inventoryView(page) {
  return page.evaluate(() => ({
    categories: [...document.querySelectorAll(".hotbar-cat-btn")].map((button) => button.title),
    items: [...document.querySelectorAll(".hotbar-item")].map((item) => item.getAttribute("aria-label")),
    count: document.querySelector(".hotbar-item[data-id='oak_chair'] .hotbar-item-count")?.textContent || null,
    scope: window.JpoInventoryScope.scopeForLocation(window._jpoAuthoritativeLocation || "office"),
  }));
}

async function transition(page, location, sequence) {
  await page.evaluate(({ socketId, nextLocation, transitionSequence }) => {
    // Exact server event order on restore/transition: approved carries
    // location/locationId, then locationTransitionResult, then currentPlayers.
    if (transitionSequence === 1) {
      window.__fixtureSocket.dispatch("approved", {
        email: "inventory-scope-fixture@justpressone.test",
        location: "office",
        locationId: "office",
      });
    }
    window._jpoAuthoritativeLocation = nextLocation;
    window.__fixtureSocket.dispatch("locationTransitionResult", {
      ok: true,
      location: nextLocation,
      transitionSequence,
      map: { label: nextLocation },
    });
    // `currentPlayers` is an object keyed by socket id; server movementPayload
    // supplies `id` and `location` (not necessarily locationId).
    window.__fixtureSocket.dispatch("currentPlayers", {
      [socketId]: { id: socketId, location: nextLocation, x: 144, y: 504, seq: transitionSequence },
    });
  }, { socketId: SOCKET_ID, nextLocation: location, transitionSequence: sequence });
}

async function main() {
  const serverSource = await readFile(join(ARTIFACT_ROOT, "server.js"), "utf8");
  assert.match(serverSource,
    /function movementPayload\(id, player, overrides = \{\}\)[\s\S]*?id,[\s\S]*?location: locationId,/,
    "server currentPlayers entries are keyed/made with player id and location");
  assert.match(serverSource,
    /socket\.emit\("locationTransitionResult", \{\s*ok: true, reason: "resume", location: state\.locationId,/s,
    "server resume payload includes the authoritative location");
  assert.match(serverSource,
    /socket\.emit\("currentPlayers", filterPlayersForLocation\(phMaskedPlayers\(socket\.id\), state\.locationId\)\);/,
    "server sends the location-filtered currentPlayers snapshot after resume");

  await mkdir(EVIDENCE_DIR, { recursive: true });
  const browser = await puppeteer.launch({
    executablePath: chromiumPath(),
    headless: "new",
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
  });
  const report = {
    fixtureOnly: true,
    ownerEmail: OWNER_EMAIL,
    checkedServerPayloads: ["approved.location/locationId", "locationTransitionResult.location", "currentPlayers[socket.id].id/location"],
    screenshots: [WILLOW_PROOF, PLAZA_PROOF],
    assertions: [],
  };
  let primary;
  let late;
  try {
    primary = await fixturePage(browser);
    await transition(primary.page, "office", 1);
    await openAndResolveFurniture(primary.page);
    let view = await inventoryView(primary.page);
    assertInventory(view, ["All", "Wearables", "Pets", "Usables", "Furniture"],
      ["Fixture Beanie", "Fixture Bunny", "Fixture Coffee", "Fixture Oak Chair"], "HQ");
    assert.equal(view.count, "2", "HQ: furniture grouping count remains functional");
    report.assertions.push("HQ renders wearable, pet, usable, and grouped furniture.");

    await transition(primary.page, "neighborhood", 2);
    view = await inventoryView(primary.page);
    assertInventory(view, ["Furniture"], ["Fixture Oak Chair"], "Willow Walk");
    assert.equal(view.count, "2", "Willow Walk: furniture count remains functional");
    await primary.page.$eval("#fixture-map-label", (element) => { element.textContent = "TEST FIXTURE — Willow Walk"; });
    await primary.page.$eval("#fixture-note", (element) => {
      element.textContent = "Expected: Furniture only · 2 stored fixture chairs · HQ tabs/items absent.";
    });
    await primary.page.screenshot({ path: WILLOW_PROOF });
    report.assertions.push("Willow Walk shows only Furniture tab/item after HQ selection.");

    await transition(primary.page, "city", 3);
    view = await inventoryView(primary.page);
    assertInventory(view, ["Furniture"], ["Fixture Oak Chair"], "Huddle Plaza");
    await primary.page.$eval("#fixture-map-label", (element) => { element.textContent = "TEST FIXTURE — Huddle Plaza"; });
    await primary.page.$eval("#fixture-note", (element) => {
      element.textContent = "Expected: Furniture only · 2 stored fixture chairs · HQ tabs/items absent.";
    });
    await primary.page.screenshot({ path: PLAZA_PROOF });
    report.assertions.push("Huddle Plaza shows only Furniture tab/item.");

    await primary.page.click("#inventory-toggle-btn");
    await primary.page.evaluate(({ socketId }) => {
      window.__fixtureSocket.dispatch("disconnect");
      window.__fixtureSocket.dispatch("approved", {
        email: "inventory-scope-fixture@justpressone.test",
        location: "city",
        locationId: "city",
      });
      window.__fixtureSocket.dispatch("locationTransitionResult", {
        ok: true, reason: "resume", location: "city", map: { label: "Huddle Plaza" },
      });
      window.__fixtureSocket.dispatch("currentPlayers", {
        [socketId]: { id: socketId, location: "city", x: 172, y: 504, seq: 4 },
      });
    }, { socketId: SOCKET_ID });
    await openAndResolveFurniture(primary.page);
    view = await inventoryView(primary.page);
    assertInventory(view, ["Furniture"], ["Fixture Oak Chair"], "Plaza reconnect/reopen");
    report.assertions.push("Reconnect/reopen replays actual server payload order and retains Plaza furniture scope.");

    await transition(primary.page, "office", 5);
    view = await inventoryView(primary.page);
    assertInventory(view, ["All", "Wearables", "Pets", "Usables", "Furniture"],
      ["Fixture Beanie", "Fixture Bunny", "Fixture Coffee", "Fixture Oak Chair"], "return to HQ");
    report.assertions.push("Returning HQ exposes the unchanged fixture collection.");

    // Explicit late-initialization case: no socket event is replayed after
    // init; the hotbar must still use the existing server-derived marker.
    late = await fixturePage(browser, { authoritativeLocation: "city" });
    await openAndResolveFurniture(late.page);
    view = await inventoryView(late.page);
    assertInventory(view, ["Furniture"], ["Fixture Oak Chair"], "late-initialized Plaza hotbar");
    report.assertions.push("Late hotbar initialization adopts _jpoAuthoritativeLocation without missing the current map.");

    assert.deepEqual(primary.errors, [], "primary fixture has no browser errors");
    assert.deepEqual(late.errors, [], "late-init fixture has no browser errors");
    await writeFile(REPORT, JSON.stringify(report, null, 2) + "\n");
    console.log(`PASS isolated DOM fixture: ${report.assertions.length} assertions`);
    console.log(`Willow proof: ${WILLOW_PROOF}`);
    console.log(`Plaza proof: ${PLAZA_PROOF}`);
    console.log(`Fixture report: ${REPORT}`);
  } finally {
    await primary?.page?.close().catch(() => {});
    await late?.page?.close().catch(() => {});
    await browser.close();
  }
}

await main();