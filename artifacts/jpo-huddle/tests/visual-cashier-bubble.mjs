#!/usr/bin/env node

/**
 * Auth-free visual fixture for the production cashier speech bubble.
 *
 * This page serves the checked-in Phaser/UI scripts and real Amelia sprite,
 * then drives the existing location/cashier UI with a tiny inert socket. It
 * never starts server.js and does not perform auth, database, or app journeys.
 *
 * Usage:
 *   node tests/visual-cashier-bubble.mjs
 *   node tests/visual-cashier-bubble.mjs --output-dir /tmp/cashier-visuals
 */

import { createServer } from "node:http";
import { mkdir, stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { FURNITURE_CATALOG } from "../neighborhood.mjs";
import puppeteer from "../node_modules/puppeteer-core/lib/esm/puppeteer/puppeteer-core.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PUBLIC = join(ROOT, "public");
const args = process.argv.slice(2);
const outputIndex = args.indexOf("--output-dir");
const outputDir = resolve(
  outputIndex >= 0 && args[outputIndex + 1] ? args[outputIndex + 1] : "/tmp/jpo-huddle-cashier-visuals",
);

const cases = [
  { id: "desktop-greeting", width: 1280, height: 720, zoom: 0.267, menu: false },
  { id: "desktop-catalog", width: 1280, height: 720, zoom: 0.267, menu: true },
  { id: "mobile-greeting", width: 390, height: 844, zoom: 1, menu: false },
  { id: "mobile-catalog", width: 390, height: 844, zoom: 1, menu: true },
];
const catalogIds = [
  "oak_chair", "fern", "reading_lamp", "coffee_table", "blue_sofa",
  "kitchen_counter", "kitchen_sink", "bed", "plush_bed", "bookcase",
  "living_lamp", "living_mirror",
];
const fixtureCatalog = Object.fromEntries(
  catalogIds.filter((id) => FURNITURE_CATALOG[id]).map((id) => [id, FURNITURE_CATALOG[id]]),
);
const menuItems = Object.entries(fixtureCatalog).map(([id, item], index) => ({
  id,
  name: item.name,
  category: item.category,
  price: 20 + index * 15,
}));
const cashier = {
  id: "cashier:furniture-shop",
  location: "furniture-shop",
  kind: "furniture",
  character: "amelia",
  name: "Mara",
  x: 0,
  y: 0,
  radius: 116,
  greeting: "Welcome to Willow Furnishings!",
  info: "Browse the showroom and make your space feel like home.",
};
const escapeInlineJson = (value) =>
  JSON.stringify(value).replace(/</g, "\\u003c").replace(/>/g, "\\u003e");

const MIME_TYPES = Object.freeze({
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
});

function localFileFor(pathname) {
  const decoded = decodeURIComponent(pathname.split("?")[0]);
  const relative = decoded.replace(/^\/+/, "");
  const candidate = resolve(PUBLIC, relative);
  if (candidate !== PUBLIC && !candidate.startsWith(PUBLIC + sep)) return null;
  return candidate;
}

function fixtureHtml() {
  const catalog = escapeInlineJson(fixtureCatalog);
  const items = escapeInlineJson(menuItems);
  const cashierData = escapeInlineJson(cashier);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <link rel="stylesheet" href="/neighborhood.css">
  <style>
    html, body, #game { width: 100%; height: 100%; margin: 0; overflow: hidden; }
    body { background: #1b2832; }
    #game { position: fixed; inset: 0; }
    #fixture-label {
      position: fixed; left: 12px; bottom: 10px; z-index: 120;
      color: #c6d7df; font: 11px monospace; opacity: .8; pointer-events: none;
    }
  </style>
</head>
<body class="playing">
  <div id="game"></div>
  <div id="fixture-label">REAL CASHIER SPRITE · CAMERA-ANCHORED DOM DIALOGUE</div>
  <script src="https://cdn.jsdelivr.net/npm/phaser@3.80.1/dist/phaser.min.js"></script>
  <script src="/focused-movement-helper.js"></script>
  <script src="/neighborhood-ui.js"></script>
  <script src="/neighborhood.js"></script>
  <script>
    (() => {
      const params = new URLSearchParams(location.search);
      const zoom = Number(params.get('zoom')) || 1;
      const showMenu = params.get('menu') === '1';
      const catalog = ${catalog};
      const menuItems = ${items};
      const cashier = ${cashierData};
      const listeners = new Map();
      const socket = {
        id: 'cashier-visual-fixture',
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
        showToast() {},
        DIR_START: { down: 0 },
        SPEED: 0,
        touchMove: {},
        touchAction: { queued: false },
        _playerChar: 'adam',
        _playerName: 'Cashier visual fixture',
        _playerEmail: 'cashier-visual@example.invalid',
      }));

      const NeighborhoodScene = window.NeighborhoodScene;
      if (typeof NeighborhoodScene !== 'function') {
        throw new Error('NeighborhoodScene was not exposed by neighborhood.js');
      }
      NeighborhoodScene.prototype.preload = function fixturePreload() {
        this.load.spritesheet('run_amelia', '/assets/Amelia_run_16x16.png', {
          frameWidth: 16, frameHeight: 32,
        });
      };
      NeighborhoodScene.prototype.create = function fixtureCreate(data) {
        const width = window.innerWidth;
        const height = window.innerHeight;
        this.location = data?.location || 'furniture-shop';
        this.mapWidth = Math.max(width / zoom, 1);
        this.mapHeight = Math.max(height / zoom, 1);
        this.info = {
          bounds: { width: this.mapWidth, height: this.mapHeight },
          cashiers: [{ ...cashier, x: this.mapWidth / 2, y: this.mapHeight / 2 }],
        };
        this.cashierNpcs = [];
        this._ambientTweens = [];
        this._neighborhoodReady = false;
        this.cameras.main.setBounds(0, 0, this.mapWidth, this.mapHeight);
        this.cameras.main.setZoom(zoom);
        this.cameras.main.centerOn(this.mapWidth / 2, this.mapHeight / 2);
        const art = this.add.graphics();
        art.fillStyle(0x243b3e, 1).fillRect(0, 0, this.mapWidth, this.mapHeight);
        art.lineStyle(2, 0x35565a, 0.65);
        for (let x = 0; x < this.mapWidth; x += 48) art.lineBetween(x, 0, x, this.mapHeight);
        for (let y = 0; y < this.mapHeight; y += 48) art.lineBetween(0, y, this.mapWidth, y);
        art.fillStyle(0x715044, 1).fillRoundedRect(
          this.mapWidth / 2 - 150, this.mapHeight / 2 + 74, 300, 54, 8,
        );
        art.lineStyle(3, 0xd1a55e, 1).strokeRoundedRect(
          this.mapWidth / 2 - 150, this.mapHeight / 2 + 74, 300, 54, 8,
        );
        art.setDepth(-100);

        const authored = this.info.cashiers[0];
        const sprite = this.add.sprite(authored.x, authored.y, 'run_amelia', 0)
          .setScale(3).setOrigin(0.5, 0.5);
        sprite.setDepth(authored.y);
        const nameTag = this.add.text(authored.x, authored.y - 57, authored.name, {
          fontFamily: 'monospace', fontSize: '13px', color: '#fff',
          backgroundColor: '#101b25dd', padding: { x: 5, y: 3 },
        }).setOrigin(0.5, 1).setDepth(authored.y + 2);
        this.cashierNpcs.push({ ...authored, sprite, nameTag });
        window._neighborhoodScene = this;
        window.__cashierFixtureScene = this;
        window.__cashierFixtureReady = true;
      };

      const game = new Phaser.Game({
        type: Phaser.CANVAS,
        parent: 'game',
        width: window.innerWidth,
        height: window.innerHeight,
        backgroundColor: '#243b3e',
        scene: [NeighborhoodScene],
        scale: { mode: Phaser.Scale.RESIZE, autoCenter: Phaser.Scale.CENTER_BOTH },
        render: { antialias: false, pixelArt: true, roundPixels: true },
        physics: {
          default: 'arcade',
          arcade: { gravity: { x: 0, y: 0 }, debug: false },
        },
      });
      window._phaserGame = game;
      setTimeout(() => {
        socket.push('locationTransitionResult', {
          ok: true,
          transitionSequence: 1,
          location: 'furniture-shop',
          map: { label: 'Furnishings' },
          catalog,
          self: {},
        });
        setTimeout(() => {
          window.jpoOpenCashier?.({
            ...cashier,
            x: window.__cashierFixtureScene?.mapWidth / 2,
            y: window.__cashierFixtureScene?.mapHeight / 2,
          });
          if (showMenu) {
            setTimeout(() => socket.push('cashierMenuResult', {
              ok: true,
              cashierId: cashier.id,
              location: 'furniture-shop',
              kind: 'furniture',
              title: 'Willow Furnishings catalog',
              items: menuItems,
            }), 160);
          }
        }, 220);
      }, 120);
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
    response.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    });
    response.end(fixtureHtml());
    return;
  }
  const filePath = localFileFor(pathname);
  if (!filePath) {
    response.writeHead(400);
    response.end("Bad path");
    return;
  }
  await sendFile(response, filePath);
});

async function main() {
  await mkdir(outputDir, { recursive: true });
  await new Promise((resolveServer) => server.listen(0, "127.0.0.1", resolveServer));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}/fixture.html`;
  const executablePath = process.env.PUPPETEER_EXECUTABLE_PATH || "/repl/tools/bin/chromium";
  const browser = await puppeteer.launch({
    executablePath,
    headless: "new",
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  const reports = [];
  try {
    for (const fixtureCase of cases) {
      const page = await browser.newPage();
      const viewport = {
        width: fixtureCase.width,
        height: fixtureCase.height,
        deviceScaleFactor: 1,
      };
      await page.setViewport(viewport);
      const pageErrors = [];
      const failedRequests = [];
      page.on("pageerror", (error) => pageErrors.push(String(error?.stack || error)));
      page.on("requestfailed", (request) => {
        failedRequests.push(`${request.url()} (${request.failure()?.errorText || "failed"})`);
      });
      const output = join(outputDir, `cashier-${fixtureCase.id}.png`);
      await page.goto(
        `${baseUrl}?zoom=${fixtureCase.zoom}&menu=${fixtureCase.menu ? "1" : "0"}`,
        { waitUntil: "domcontentloaded", timeout: 30000 },
      );
      await page.waitForFunction(
        () => window.__cashierFixtureReady === true &&
          !!document.querySelector('#shop-panel:not([hidden])'),
        { timeout: 30000 },
      );
      await page.waitForFunction(
        () => document.querySelector('#shop-panel')?.style.visibility === 'visible',
        { timeout: 30000 },
      );
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 350));
      const report = await page.evaluate(() => {
        const panel = document.querySelector('#shop-panel');
        const scene = window.__cashierFixtureScene;
        const sprite = scene?.cashierNpcs?.[0]?.sprite;
        const bubble = panel?.getBoundingClientRect();
        const canvas = window._phaserGame?.canvas?.getBoundingClientRect();
        return {
          bubble: bubble && {
            left: bubble.left, top: bubble.top, width: bubble.width, height: bubble.height,
          },
          tailX: panel?.style.getPropertyValue('--cashier-tail-x'),
          tailPlacement: panel?.dataset.tail,
          sprite: sprite && { x: sprite.x, y: sprite.y, displayHeight: sprite.displayHeight },
          camera: scene?.cameras?.main && {
            x: scene.cameras.main.x, y: scene.cameras.main.y,
            width: scene.cameras.main.width, height: scene.cameras.main.height,
            scrollX: scene.cameras.main.scrollX, scrollY: scene.cameras.main.scrollY,
            zoom: scene.cameras.main.zoom,
          },
          sceneScale: scene?.scale && { width: scene.scale.width, height: scene.scale.height },
          canvas: canvas && { left: canvas.left, top: canvas.top, width: canvas.width, height: canvas.height },
          menuVisible: !!panel?.querySelector('[data-buy]'),
        };
      });
      await page.screenshot({ path: output, type: "png" });
      reports.push({ ...fixtureCase, output, report: { ...report, pageErrors, failedRequests } });
      await page.close();
    }
    console.log(JSON.stringify({ outputDir, reports }, null, 2));
    if (reports.some((entry) => entry.report.pageErrors.length || entry.report.failedRequests.length)) {
      process.exitCode = 1;
    }
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