#!/usr/bin/env node

/**
 * Temporary, auth-free visual fixture for the real Huddle Plaza renderer.
 *
 * This serves a private fixture page, loads the checked-in Phaser-facing
 * scripts and assets, and asks the actual NeighborhoodScene._drawCity() to
 * compose the scene.  It intentionally does not start server.js, open a
 * socket, or add an entry point to public/.
 *
 * Usage:
 *   node tests/visual-city-render.mjs
 *   node tests/visual-city-render.mjs --output /tmp/plaza.png
 */

import { createServer } from "node:http";
import { stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { CITY_COMMERCIAL_LAYOUT } from "../neighborhood.mjs";
import puppeteer from "../node_modules/puppeteer-core/lib/esm/puppeteer/puppeteer-core.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PUBLIC = join(ROOT, "public");
const DEFAULT_OUTPUT = "/tmp/jpo-huddle-city-1024x576.png";
const VIEWPORT = { width: 1024, height: 576, deviceScaleFactor: 1 };
const CAMERA_ZOOM = 0.267;

const args = process.argv.slice(2);
const outputIndex = args.indexOf("--output");
const output = resolve(
  outputIndex >= 0 && args[outputIndex + 1] ? args[outputIndex + 1] : DEFAULT_OUTPUT,
);

const MIME_TYPES = Object.freeze({
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".tmj": "application/json; charset=utf-8",
});

const escapeInlineJson = (value) =>
  JSON.stringify(value).replace(/</g, "\\u003c").replace(/>/g, "\\u003e");

function localFileFor(pathname) {
  const decoded = decodeURIComponent(pathname.split("?")[0]);
  const relative = decoded.replace(/^\/+/, "");
  const candidate = resolve(PUBLIC, relative);
  if (candidate !== PUBLIC && !candidate.startsWith(PUBLIC + sep)) return null;
  return candidate;
}

function fixtureHtml() {
  const layout = escapeInlineJson(CITY_COMMERCIAL_LAYOUT);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=1024,height=576,initial-scale=1">
  <style>
    html, body, #game { width: 100%; height: 100%; margin: 0; overflow: hidden; }
    body { background: #263a34; }
    /* initNeighborhoodUI is required to expose the real scene class, but this
       fixture deliberately captures only the Phaser canvas. */
    #neighborhood-ui { display: none !important; }
  </style>
</head>
<body>
  <div id="game"></div>
  <script src="https://cdn.jsdelivr.net/npm/phaser@3.80.1/dist/phaser.min.js"></script>
  <script src="/house-colors.js"></script>
  <script src="/neighborhood-interiors.js"></script>
  <script src="/plaza-exteriors.js"></script>
  <script src="/focused-movement-helper.js"></script>
  <script src="/furniture-renderer.js"></script>
  <script src="/neighborhood.js"></script>
  <script>
    (() => {
      const layout = ${layout};
      const listeners = new Map();
      const socket = {
        id: 'visual-fixture',
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
      };

      // initNeighborhoodUI owns the closure in which the production
      // NeighborhoodScene class is declared. No app/auth/socket journey is
      // needed: this inert socket only satisfies its event registration API.
      window.initNeighborhoodUI(socket, () => ({
        _playerChar: 'adam',
        _playerName: 'Visual fixture',
        _playerEmail: 'visual-fixture@example.invalid',
      }));

      const NeighborhoodScene = window.NeighborhoodScene;
      if (typeof NeighborhoodScene !== 'function') {
        throw new Error('NeighborhoodScene was not exposed by neighborhood.js');
      }

      // Keep preload() and every renderer helper from the checked-in class.
      // Only create() is replaced in this temporary page so auth/player
      // presentation cannot obscure the static city composition.
      NeighborhoodScene.prototype.create = function fixtureCreate() {
        const bounds = layout.cityBounds;
        this.info = {
          bounds,
          geometry: {
            commercialExteriors: {
              gatheringSquare: layout.gatheringSquare,
              venues: layout.venues,
            },
          },
          blockers: [],
          portals: [],
        };
        this.location = 'city';
        this.mapWidth = Number(bounds.width);
        this.mapHeight = Number(bounds.height);
        this._cameraZoom = ${CAMERA_ZOOM};
        this._ambientTweens = [];
        this._setNeighborhoodTextureFilters();
        this.physics.world.setBounds(0, 0, this.mapWidth, this.mapHeight);
        this.cameras.main.setBounds(0, 0, this.mapWidth, this.mapHeight);
        this.cameras.main.setBackgroundColor('#263a34');
        this._fitNeighborhoodCamera();

        // This is the production city path, including _tileField, _path,
        // JpoPlazaExteriors.draw, signs, trees, lamps, benches, and decor.
        this._drawCity();

        // At this zoom the complete authored 3600x1920 world is visible. The
        // explicit sync follows the same helper used by the real scene after
        // camera movement, so the pooled ground tiles cover the centered view.
        this.cameras.main.centerOn(this.mapWidth / 2, this.mapHeight / 2);
        this._syncTileField();
        this._neighborhoodReady = true;
        window._neighborhoodScene = this;
        window.__fixtureScene = this;
        window.__fixtureReady = true;
      };

      const game = new Phaser.Game({
        type: Phaser.CANVAS,
        parent: 'game',
        width: ${VIEWPORT.width},
        height: ${VIEWPORT.height},
        backgroundColor: '#263a34',
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
  if (pathname === "/" || pathname === "/fixture.html") {
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    response.end(fixtureHtml());
    return;
  }

  // The source scripts/assets are served only by this process. This keeps the
  // fixture outside the application entry surface and makes all art identical
  // to the files used by the real browser renderer.
  const filePath = localFileFor(pathname);
  if (!filePath) {
    response.writeHead(400);
    response.end("Bad path");
    return;
  }
  await sendFile(response, filePath);
});

async function main() {
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

    const metrics = await page.evaluate(() => {
      const scene = window.__fixtureScene;
      const camera = scene?.cameras?.main;
      return {
        bounds: scene?.info?.bounds,
        venueCount: scene?.info?.geometry?.commercialExteriors?.venues?.length || 0,
        renderer: scene?.game?.renderer?.type === Phaser.WEBGL ? "WebGL" : "Canvas",
        zoom: camera?.zoom,
        worldView: camera?.worldView,
        objects: scene?.children?.length,
      };
    });
    await page.screenshot({ path: output, type: "png" });
    console.log(JSON.stringify({
      screenshot: output,
      viewport: VIEWPORT,
      cameraZoom: CAMERA_ZOOM,
      metrics,
      pageErrors,
      failedRequests,
    }, null, 2));
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