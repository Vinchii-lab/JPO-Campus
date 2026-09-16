#!/usr/bin/env node

/**
 * Auth-free visual fixture for catalog furniture activities.
 *
 * This is intentionally a separate fixture from visual-city-render.mjs.  It
 * loads the checked-in Phaser renderer, real furniture PNGs, the real avatar
 * sheets, and the production NeighborhoodScene pose/depth methods.  No server,
 * socket connection, auth journey, workflow, or database is involved.
 *
 * Usage:
 *   node tests/visual-furniture-poses.mjs
 *   node tests/visual-furniture-poses.mjs --output /tmp/furniture.png
 */

import { createServer } from "node:http";
import { stat } from "node:fs/promises";
import { createReadStream, readFileSync } from "node:fs";
import { dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { FURNITURE_CATALOG } from "../neighborhood.mjs";
import {
  furnitureActionAnchor,
  furnitureActionStandCandidates,
} from "../furniture-actions.mjs";
import puppeteer from "../node_modules/puppeteer-core/lib/esm/puppeteer/puppeteer-core.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PUBLIC = join(ROOT, "public");
const ROOM_FURNITURE = resolve(ROOT, "../api-server/spritesheets");
const DEFAULT_OUTPUT = "/tmp/jpo-huddle-furniture-poses.png";
const VIEWPORT = { width: 1024, height: 576, deviceScaleFactor: 1 };
const PHASER_CDN_URL = "https://cdn.jsdelivr.net/npm/phaser@3.80.1/dist/phaser.min.js";
const PHASER_FIXTURE_PATH = "/_fixture/phaser-3.80.1.min.js";
let phaserSource = null;

const args = process.argv.slice(2);
const outputIndex = args.indexOf("--output");
const output = resolve(
  outputIndex >= 0 && args[outputIndex + 1] ? args[outputIndex + 1] : DEFAULT_OUTPUT,
);
const resetOutput = output.replace(/\.png$/i, "-reset.png");
const chairOffsetIndex = args.indexOf("--chair-offset");
const chairOffset = chairOffsetIndex >= 0 ? Number(args[chairOffsetIndex + 1]) : null;
if (chairOffsetIndex >= 0 && !Number.isFinite(chairOffset)) {
  throw new Error("--chair-offset must be a finite world-pixel offset");
}
const chairScaleIndex = args.indexOf("--chair-scale");
const chairScale = chairScaleIndex >= 0 ? Number(args[chairScaleIndex + 1]) : null;
if (chairScaleIndex >= 0 && (!Number.isInteger(chairScale) || chairScale <= 0)) {
  throw new Error("--chair-scale must be a positive integer");
}

const fixtureIds = ["plush_bed", "lounge_sofa", "oak_chair", "bathtub"];
const fixtureCatalog = Object.fromEntries(
  fixtureIds.map((id) => {
    const definition = FURNITURE_CATALOG[id];
    // Comparison-only override for HQ stool pose calibration. It deliberately
    // preserves the real art, renderer, and pose method while making the
    // evaluated native scale and exact seat anchor explicit in the image.
    if (id !== "oak_chair" || (chairOffset == null && chairScale == null)) return [id, definition];
    return [id, {
      ...definition,
      ...(chairScale == null ? {} : { scale: chairScale }),
      actionInteractions: {
        ...definition.actionInteractions,
        sit: {
          ...definition.actionInteractions?.sit,
          ...(chairOffset == null ? {} : {
            actorOffset: {
              ...definition.actionInteractions?.sit?.actorOffset,
              y: chairOffset,
            },
          }),
        },
      },
    }];
  }),
);
const fixturePlacements = [
  { id: "fixture-bed", furnitureId: "plush_bed", gridX: 2, gridY: 3, action: "lie", label: "BED / LIE" },
  { id: "fixture-sofa", furnitureId: "lounge_sofa", gridX: 8, gridY: 4, action: "sit", label: "SOFA / SIT" },
  { id: "fixture-chair", furnitureId: "oak_chair", gridX: 13, gridY: 4, action: "sit", label: "HQ STOOL / SIT" },
  { id: "fixture-bath", furnitureId: "bathtub", gridX: 17, gridY: 4, action: "bathe", label: "BATH / BATHE" },
].map((placement) => ({
  ...placement,
  anchor: furnitureActionAnchor(
    fixtureCatalog[placement.furnitureId], placement.gridX, placement.gridY, 48, placement.action,
  ),
  stand: furnitureActionStandCandidates(
    fixtureCatalog[placement.furnitureId], placement.gridX, placement.gridY, 48, placement.action,
  )[0],
  floor: {
    x: (placement.gridX + (
      Number(fixtureCatalog[placement.furnitureId].width) || 1
    ) / 2) * 48,
    y: (placement.gridY + (
      Number(fixtureCatalog[placement.furnitureId].height) || 1
    )) * 48,
  },
}));
// Keep the fixture's cap placement sourced from the production wearable
// manifest. The manifest is currently scoped to index.html, so parse the
// checked-in definition rather than inventing a second dy/side contract here.
const publicIndexSource = readFileSync(join(PUBLIC, "index.html"), "utf8");
const capMatch = publicIndexSource.match(
  /cap:\s*\{\s*tex:\s*'wear_cap',\s*dy:\s*(-?\d+),\s*side:\s*(-?\d+),\s*sideDy:\s*(-?\d+)/,
);
if (!capMatch) throw new Error("Could not resolve production cap wearable metadata");
const capWearable = Object.freeze({
  tex: "wear_cap",
  dy: Number(capMatch[1]),
  side: Number(capMatch[2]),
  sideDy: Number(capMatch[3]),
  scale: 3,
});
const escapeInlineJson = (value) =>
  JSON.stringify(value).replace(/</g, "\\u003c").replace(/>/g, "\\u003e");

const MIME_TYPES = Object.freeze({
  ".css": "text/css; charset=utf-8",
  ".gif": "image/gif",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".png": "image/png",
});

function localFileFor(pathname) {
  const decoded = decodeURIComponent(pathname.split("?")[0]);
  const relative = decoded.replace(/^\/+/, "");
  const candidate = resolve(PUBLIC, relative);
  if (candidate !== PUBLIC && !candidate.startsWith(PUBLIC + sep)) return null;
  return candidate;
}

function roomFurnitureFileFor(pathname) {
  const prefix = "/assets/room-furniture/";
  if (!pathname.startsWith(prefix)) return null;
  const relative = decodeURIComponent(pathname.slice(prefix.length));
  const candidate = resolve(ROOM_FURNITURE, relative);
  if (candidate !== ROOM_FURNITURE && !candidate.startsWith(ROOM_FURNITURE + sep)) return null;
  return candidate;
}

function fixtureHtml() {
  const catalog = escapeInlineJson(fixtureCatalog);
  const placements = escapeInlineJson(fixturePlacements);
  const cap = escapeInlineJson(capWearable);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=1024,height=576,initial-scale=1">
  <style>
    html, body, #game { width: 100%; height: 100%; margin: 0; overflow: hidden; }
    body { background: #1b2832; }
    #neighborhood-ui { display: none !important; }
  </style>
</head>
<body>
  <div id="game"></div>
  <script src="${PHASER_FIXTURE_PATH}"></script>
  <script src="/house-colors.js"></script>
  <script src="/neighborhood-interiors.js"></script>
  <script src="/plaza-exteriors.js"></script>
  <script src="/focused-movement-helper.js"></script>
  <script src="/furniture-renderer.js"></script>
  <script src="/neighborhood.js"></script>
  <script>
    (() => {
      const catalog = ${catalog};
      const placements = ${placements};
      const capWearable = ${cap};
      const listeners = new Map();
      const socket = {
        id: 'visual-furniture-fixture',
        connected: false,
        volatile: { emit() {} },
        on(name, handler) {
          const handlers = listeners.get(name) || [];
          handlers.push(handler);
          listeners.set(name, handlers);
          return this;
        },
        off(name, handler) {
          const handlers = listeners.get(name) || [];
          listeners.set(name, handlers.filter((candidate) => candidate !== handler));
          return this;
        },
        emit() { return this; },
        push(name, payload) {
          for (const handler of listeners.get(name) || []) handler(payload);
          return this;
        },
      };

      window.initNeighborhoodUI(socket, () => ({
        _playerChar: 'adam',
        _playerName: 'Furniture pose fixture',
        _playerEmail: 'visual-furniture@example.invalid',
        _equippedCosmetic: 'cap',
      }));
      // This uses the production homeDirectory consumer to seed the exact
      // serialized catalog shape that a real home/showroom receives.
      socket.push('homeDirectory', { catalog, homes: [] });

      const NeighborhoodScene = window.NeighborhoodScene;
      if (typeof NeighborhoodScene !== 'function') {
        throw new Error('NeighborhoodScene was not exposed by neighborhood.js');
      }

      NeighborhoodScene.prototype.preload = function fixturePreload() {
        window.HomeFurnitureRenderer.preload(this, catalog);
        this.load.spritesheet('run_adam', '/assets/Adam_run_16x16.png', {
          frameWidth: 16, frameHeight: 32,
        });
        this.load.spritesheet('adam_sit3', '/assets/Adam_sit3_16x16.png', {
          frameWidth: 16, frameHeight: 32,
        });
        this.load.spritesheet('wear_cap', '/assets/wear_cap.png', {
          frameWidth: 10, frameHeight: 6,
        });
      };

      NeighborhoodScene.prototype.create = function fixtureCreate() {
        this.location = 'furniture-shop';
        this.mapWidth = ${VIEWPORT.width};
        this.mapHeight = ${VIEWPORT.height};
        this.info = { bounds: { width: this.mapWidth, height: this.mapHeight } };
        this.actorFootRadius = 16;
        this.remotes = {};
        this.furniture = [];
        this.showroomFurniture = [];
        this._ambientTweens = [];
        this._activityFx = null;
        this._activityEffectTween = null;
        this._neighborhoodReady = false;
        this.cameras.main.setBounds(0, 0, this.mapWidth, this.mapHeight);
        this.cameras.main.setBackgroundColor('#1b2832');
        this.add.rectangle(512, 288, 1024, 576, 0x1b2832).setDepth(-10000);
        this.add.text(512, 22, 'REAL FURNITURE ACTIVITY POSES', {
          fontFamily: 'monospace', fontSize: '18px', color: '#f3dfb4',
        }).setOrigin(0.5).setDepth(9000);
        this.add.text(512, 47, 'catalog art  •  real avatar sheets  •  production pose/depth methods', {
          fontFamily: 'monospace', fontSize: '11px', color: '#b8ccd2',
        }).setOrigin(0.5).setDepth(9000);

        // The production bridge normally points at OfficeScene.  This fixture
        // supplies only the same real wearable placement seam, allowing the
        // actual NeighborhoodScene._positionPresentation method to move a
        // loaded cap with each avatar pose.
        this._office = (method, ...args) => {
          if (method !== '_placeWearable') return null;
          const [object, definition, x, y, dir] = args;
          object.setVisible?.(dir !== 'up' || definition?.showUp);
          object.setPosition(x, y + (Number(definition?.dy) || -68));
          object.setFlipX?.(dir === 'left');
          object.setFrame?.(dir === 'left' || dir === 'right' ? 1 : 0);
          return object;
        };

        this.anims.create({
          key: 'sit_run_adam_down',
          frames: [{ key: 'adam_sit3', frame: 0 }],
          frameRate: 1, repeat: -1,
        });

        this.__fixtureEntries = [];
        for (const placement of placements) {
          const definition = catalog[placement.furnitureId];
          const furniture = window.HomeFurnitureRenderer.draw(
            this, definition, placement.floor.x, placement.floor.y, {
              depth: placement.floor.y, instanceId: placement.id,
            },
          );
          this.furniture.push(furniture);
          this.add.text(placement.floor.x, 530, placement.label, {
            fontFamily: 'monospace', fontSize: '13px', color: '#f3dfb4',
            backgroundColor: '#172129', padding: { x: 6, y: 4 },
          }).setOrigin(0.5, 1).setDepth(9000);

          const avatar = this.add.sprite(
            placement.anchor.x, placement.anchor.y, 'run_adam', 18,
          ).setOrigin(0.5, 0.5).setScale(3);
          const cap = this.add.sprite(
            placement.anchor.x, placement.anchor.y + capWearable.dy, capWearable.tex, 0,
          ).setOrigin(0.5, 0.5).setScale(3);
          const entry = {
            role: placement.id === 'fixture-bath' ? 'remote' : 'local',
            sprite: avatar,
            playerTexKey: 'run_adam',
            activity: {
              instanceId: placement.id,
              furnitureId: placement.furnitureId,
              action: placement.action,
              effect: placement.action === 'bathe' ? 'water' :
                placement.action === 'sit' ? 'comfort' : 'sleep',
              effectState: 'on',
            },
            stand: placement.stand,
            cosmetic: cap,
            cosmeticDef: capWearable,
            slotObjs: {},
            _activityAction: null,
          };
          this.__fixtureEntries.push(entry);
          this._applyActivityPose(entry, entry.activity, 'down');
          this._positionPresentation(entry, placement.anchor.x, placement.anchor.y, 'down');
        }
        const remoteEntry = this.__fixtureEntries.find((entry) => entry.role === 'remote');
        if (remoteEntry) this.remotes['fixture-remote'] = remoteEntry;

        this.__fixtureActive = this.__fixtureEntries.map((entry) => ({
          action: entry.activity.action,
          furnitureId: entry.activity.furnitureId,
          angle: entry.sprite.angle,
          scale: entry.sprite.scaleX,
          frame: entry.sprite.frame?.name ?? entry.sprite.frame?.index,
          visible: entry.sprite.visible,
          x: entry.sprite.x,
          y: entry.sprite.y,
          texture: entry.sprite.texture?.key,
          occluderCount: entry._activityFurnitureSprite?.getData?.('occluderParts')?.length || 0,
          actorDepth: entry.sprite.depth,
          frontDepth: entry._activityFurnitureSprite?.getData?.('occluderParts')?.[0]?.depth ?? null,
          effectActive: entry._activityFurnitureSprite?.getData?.('effectActive') === true,
          furnitureFrame: entry._activityFurnitureSprite?.frame?.index ?? null,
          furniturePlaying: entry._activityFurnitureSprite?.anims?.isPlaying === true,
          role: entry.role,
        }));
        window.__fixtureReady = true;
        window.__fixtureScene = this;
        window._neighborhoodScene = this;
        this._neighborhoodReady = true;
      };

      const game = new Phaser.Game({
        type: Phaser.CANVAS,
        parent: 'game',
        width: ${VIEWPORT.width},
        height: ${VIEWPORT.height},
        backgroundColor: '#1b2832',
        scene: [NeighborhoodScene],
        scale: { mode: Phaser.Scale.NONE },
        render: { antialias: false, pixelArt: true, roundPixels: true },
        physics: {
          default: 'arcade',
          arcade: { gravity: { x: 0, y: 0 }, debug: false },
        },
      });
      window._phaserGame = game;
    })();
  </script>
</body>
</html>`;
}

async function sendFile(response, filePath) {
  try {
    const fileStat = await stat(filePath);
    if (!fileStat.isFile()) {
      response.writeHead(404);
      response.end("Not found");
      return;
    }
  } catch {
    response.writeHead(404);
    response.end("Not found");
    return;
  }
  response.writeHead(200, {
    "Content-Type": MIME_TYPES[extname(filePath).toLowerCase()] || "application/octet-stream",
    "Cache-Control": "no-store",
  });
  createReadStream(filePath).pipe(response);
}

const server = createServer(async (request, response) => {
  const pathname = new URL(request.url || "/", "http://127.0.0.1").pathname;
  if (pathname === PHASER_FIXTURE_PATH) {
    if (!phaserSource) {
      response.writeHead(503, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("Fixture Phaser source is unavailable");
      return;
    }
    response.writeHead(200, {
      "Content-Type": "text/javascript; charset=utf-8",
      "Cache-Control": "no-store",
    });
    response.end(phaserSource);
    return;
  }
  if (pathname === "/" || pathname === "/fixture.html") {
    response.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    });
    response.end(fixtureHtml());
    return;
  }
  const filePath = roomFurnitureFileFor(pathname) || localFileFor(pathname);
  if (!filePath) {
    response.writeHead(400);
    response.end("Bad path");
    return;
  }
  await sendFile(response, filePath);
});

async function main() {
  // Chromium in the fixture sandbox cannot always reach the public CDN even
  // when the test runner can. Fetch the immutable script once in Node and
  // serve it from the same local origin as the production renderer.
  const phaserResponse = await fetch(PHASER_CDN_URL);
  if (!phaserResponse.ok) {
    throw new Error(`Could not fetch Phaser fixture source (${phaserResponse.status})`);
  }
  phaserSource = await phaserResponse.text();
  await new Promise((resolveServer) => server.listen(0, "127.0.0.1", resolveServer));
  const address = server.address();
  const url = `http://127.0.0.1:${address.port}/fixture.html`;
  const executablePath =
    process.env.PUPPETEER_EXECUTABLE_PATH || "/repl/tools/bin/chromium";
  const browser = await puppeteer.launch({
    executablePath,
    headless: "new",
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  const page = await browser.newPage();
  await page.setViewport(VIEWPORT);
  const pageErrors = [];
  const failedRequests = [];
  page.on("pageerror", (error) => pageErrors.push(String(error?.stack || error)));
  page.on("requestfailed", (request) => {
    failedRequests.push(`${request.url()} (${request.failure()?.errorText || "failed"})`);
  });

  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForFunction(() => window.__fixtureReady === true, { timeout: 30000 });
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
    const activeReport = await page.evaluate(() => {
      const scene = window.__fixtureScene;
      const active = scene.__fixtureActive;
      const activeChecks = active.map((item) => {
        const expectsFrontOccluder = item.furnitureId !== 'oak_chair';
        if (expectsFrontOccluder && !(item.occluderCount > 0)) throw new Error(
          `${item.furnitureId} did not create its explicit front occluder`,
        );
        if (!expectsFrontOccluder && item.occluderCount !== 0) throw new Error(
          'HQ gold stool incorrectly created an armchair-style front occluder',
        );
        if (expectsFrontOccluder && !(item.actorDepth < item.frontDepth)) throw new Error(
          `${item.furnitureId} actor is not between the furniture base and front row`,
        );
        if (!item.effectActive) throw new Error(
          `${item.furnitureId} effect did not remain active`,
        );
        if (item.action === "bathe" && !item.furniturePlaying) throw new Error(
          "bathtub water did not use its authoritative animation state",
        );
        return item;
      });
      return activeChecks;
    });
    // Capture the actual active poses before exercising cleanup.  Keeping the
    // reset capture separate makes both artifacts useful to visual review.
    await page.screenshot({ path: output, type: "png" });

    const resetReport = await page.evaluate(() => {
      const scene = window.__fixtureScene;
      const entries = scene.__fixtureEntries;

      // Exercise the same local/remote reset method used by map transitions,
      // movement exits, and furniture rebuilds.  The furniture remains drawn,
      // but the actor pose/effect target must be fully released.
      for (const entry of entries) {
        entry.__fixtureLastAction = entry.activity?.action;
        entry.__fixtureInstanceId = entry.activity?.instanceId;
        entry.activity = null;
        // A real stop packet includes the authoritative stand coordinate. Use
        // the shared stand candidate rather than inventing a fixture y value.
        entry.sprite.setPosition(entry.stand.x, entry.stand.y);
        scene._applyActivityPose(entry, null, "down");
        scene._positionPresentation(entry, entry.sprite.x, entry.sprite.y, "down");
      }
      const reset = entries.map((entry) => ({
        role: entry.role,
        action: entry.__fixtureLastAction,
        angle: entry.sprite.angle,
        scale: entry.sprite.scaleX,
        furnitureTarget: entry._activityFurnitureSprite,
        effectActive: entry._activityFurnitureSprite?.getData?.("effectActive") || false,
        furnitureFrame: (() => {
          const object = scene.furniture.find((candidate) =>
            String(candidate.getData?.("instanceId") || "") === String(entry.__fixtureInstanceId),
          );
          return object?.frame?.name ?? object?.frame?.index ?? null;
        })(),
        furniturePlaying: scene.furniture.find((object) =>
          String(object.getData?.("instanceId") || "") === String(entry.__fixtureInstanceId),
        )?.anims?.isPlaying === true,
        texture: entry.sprite.texture?.key,
      }));
      for (const item of reset) {
        if (item.angle !== 0 || item.scale !== 3) throw new Error(
          `${item.action} pose did not reset angle/scale`,
        );
        if (item.furnitureTarget !== null) throw new Error(
          `${item.action} pose retained a furniture activity target`,
        );
        if (item.effectActive) throw new Error(
          `${item.action} furniture effect remained active`,
        );
        if (item.furniturePlaying) throw new Error(
          `${item.action} furniture animation remained active`,
        );
        if (item.action === "bathe" && String(item.furnitureFrame) !== "0") throw new Error(
          `bathtub did not reset its authoritative water frame (${item.furnitureFrame})`,
        );
        if (item.texture !== "run_adam") throw new Error(
          `${item.action} pose did not restore the dressed run sheet`,
        );
      }
      if (!reset.some((item) => item.role === "local") ||
          !reset.some((item) => item.role === "remote")) {
        throw new Error("cleanup fixture did not cover both local and remote entries");
      }
      return reset;
    });
    await page.screenshot({ path: resetOutput, type: "png" });
    console.log(JSON.stringify({
      screenshot: output,
      resetScreenshot: resetOutput,
      viewport: VIEWPORT,
      report: { active: activeReport, reset: resetReport },
      pageErrors,
      failedRequests,
    }, null, 2));
    if (pageErrors.length || failedRequests.length) process.exitCode = 1;
  } finally {
    await browser.close();
    await new Promise((resolveServer) => server.close(resolveServer));
  }
}

main().catch((error) => {
  console.error(error?.stack || error);
  server.close();
  process.exitCode = 1;
});