/* HQ-only, removable decoration. The authored JPO_HQ.tmj remains the source of truth:
   16px Tiled cells render at 3x; these anchors are checked against the live map. */
(function () {
  'use strict';

  const CELL = 48;
  const active = new WeakMap();
  // The two-cell-wide cabinet/shelf tops at the north edges of the three
  // office wings. None are chair GIDs or interactive stations.
  const SHELVES = [
    { col: 46, row: 17 }, { col: 96, row: 17 }, { col: 143, row: 17 }
  ];
   // Jack-o'-lantern wall clusters: the uninterrupted solid wall under
  // reception and inside the recruiters' gathering room, never the desks.
  const WALL_PUMPKINS = [
    { col: 34, row: 52 }, { col: 69, row: 52 },
    { col: 54, row: 65 }
  ];
  // Five wall cells per swag. Short, shallow strings leave noticeboards and
  // front-desk signs completely clear (these run only through plain 692 wall).
  const GARLANDS = [
    { col: 39, row: 52 }, { col: 49, row: 52 },
    { col: 41, row: 65 }, { col: 62, row: 65 }
  ];
   // Authored empty corner pockets, checked against BOTH furniture and wall.
   // Radii are in tiles, not pixels: these are room-scale webs, not icons.
   // The upper nap room, middle office, reception, gathering room and south rooms
   // have no seats/stations inside these quarter circles.
  const CORNERS = [
     { col: 183, row: 17, size: 4 }, { col: 81, row: 36, size: 4 },
     { col: 35, row: 53, size: 3 }, { col: 78, row: 53, size: 6, dir: -1 },
     { col: 69, row: 66, size: 6 }, { col: 33, row: 84, size: 5 },
     { col: 50, row: 98, size: 4 }, { col: 147, row: 108, size: 6, dir: -1 }
  ];

  function gid(layer, col, row) {
     return Math.max(0, layer?.getTileAt(col, row)?.index || 0);
  }

  function pumpkin(scene, col, row, objects, tweens) {
    // On either a cabinet's upper tile or a solid wall-plaque tile,
    // never in the walkway or a seat below.
     const x = (col + 0.9) * CELL;
     const y = row * CELL + 41;
    const g = scene.add.graphics({ x, y }).setDepth(0);
    const ember = scene.add.graphics({ x, y }).setDepth(0);
     // Three hand-pixelled gourds form a deliberate shelf vignette.
     // Largest is 42px tall, companions 26/31px, within the two-tile top.
     for (const [dx, dy, p] of [[-29, 0, 2], [25, 0, 2.4], [-3, 0, 3]]) {
       const rect = (target, color, a, b, w, h) => {
         target.fillStyle(color);
         target.fillRect(dx + a * p, dy + b * p, w * p, h * p);
       };
       rect(g, 0x362039, -7, -9, 14, 8);
       rect(g, 0x362039, -5, -11, 10, 12);
       rect(g, 0x536244, -1, -14, 2, 4);
       rect(g, 0xa84425, -6, -9, 12, 8);
       rect(g, 0xe77830, -4, -10, 8, 10);
       rect(g, 0xffa447, -3, -9, 2, 7);
       rect(g, 0xbf5428, 2, -9, 2, 8);
       rect(g, 0x42203a, -4, -7, 3, 3);
       rect(g, 0x42203a, 1, -7, 3, 3);
       rect(g, 0x42203a, -3, -3, 6, 2);
       rect(ember, 0xffe69b, -4, -6, 2, 1);
       rect(ember, 0xffe69b, 2, -6, 2, 1);
       rect(ember, 0xffc45f, -2, -2, 4, 1);
     }
     // Small violet votive, not room lighting.
     g.fillStyle(0x65467d); g.fillRect(40, -20, 6, 18);
     ember.fillStyle(0xe7beff); ember.fillRect(40, -27, 6, 6);
     ember.fillStyle(0xffedbd); ember.fillRect(42, -30, 3, 6);
     objects.push(g, ember);
     ember.setAlpha(0.7);
    tweens.push(scene.tweens.add({
      targets: ember, alpha: 0.84, duration: 1900 + col * 13,
      yoyo: true, repeat: -1, ease: 'Sine.easeInOut'
    }));
  }

   function web(scene, col, row, size, dir, objects, tweens) {
     const x = (col + (dir < 0 ? 1 : 0)) * CELL;
    const y = row * CELL;
     const g = scene.add.graphics({ x, y }).setDepth(0).setScale(dir, 1);
     // Silk is authored on the same 3px grid as the tiles. Dark under-thread
     // + ivory core stays legible on both pale flooring and dark walls.
     const radius = size * CELL - 9;
     function strand(ax, ay, bx, by) {
       const n = Math.ceil(Math.max(Math.abs(bx - ax), Math.abs(by - ay)) / 3);
       for (let i = 0; i <= n; i++) {
         const px = Math.round((ax + (bx - ax) * i / (n || 1)) / 3) * 3;
         const py = Math.round((ay + (by - ay) * i / (n || 1)) / 3) * 3;
         g.fillStyle(0x5d4b77, 0.8); g.fillRect(px, py, 6, 6);
         g.fillStyle(0xf1e6ff, 0.95); g.fillRect(px, py, 3, 3);
       }
     }
     const tips = Array.from({ length: 9 }, (_, i) =>
       [Math.cos(i * Math.PI / 16) * radius, Math.sin(i * Math.PI / 16) * radius]);
     tips.forEach(([tx, ty]) => strand(0, 0, tx, ty));
     for (const t of [0.17, 0.33, 0.5, 0.68, 0.84, 1]) {
       for (let i = 0; i < tips.length - 1; i++) {
         const [ax, ay] = tips[i].map(v => v * t);
         const [bx, by] = tips[i + 1].map(v => v * t);
         // Inward scallops give the silk a stretched, layered shape.
         const mx = (ax + bx) * 0.46, my = (ay + by) * 0.46;
         strand(ax, ay, mx, my); strand(mx, my, bx, by);
       }
     }
    objects.push(g);
     const sx = Math.round(radius * 0.63 / 3) * 3;
     const sy = Math.round(radius * 0.43 / 3) * 3;
     strand(sx, sy - 33, sx, sy);
     const spider = scene.add.graphics({ x: x + sx * dir, y: y + sy }).setDepth(0);
     spider.fillStyle(0x382342);
     spider.fillRect(-6, -3, 15, 15);
     for (const side of [-1, 1]) for (let leg = 0; leg < 3; leg++) {
       spider.fillRect(side < 0 ? -12 : 9, leg * 6 - 6, 6, 3);
       spider.fillRect(side < 0 ? -15 : 15, leg * 6 - 9, 3, 6);
     }
     spider.fillStyle(0xdf8bed); spider.fillRect(-3, 0, 3, 3); spider.fillRect(3, 0, 3, 3);
     objects.push(spider);
     tweens.push(scene.tweens.add({ targets: spider, y: spider.y + 6,
       duration: 2300 + col * 9, yoyo: true, repeat: -1, ease: 'Sine.easeInOut' }));
  }

  function garland(scene, col, row, objects) {
    const g = scene.add.graphics({ x: col * CELL, y: row * CELL }).setDepth(0);
    const width = 5 * CELL;
    g.lineStyle(2, 0x62406d, 0.8);
    g.lineBetween(8, 8, width - 8, 8);
     // Torn velvet pennants and amber bulbs, entirely within the wall tile.
    for (let i = 0; i < 5; i++) {
      const x = i * CELL + CELL / 2;
       g.fillStyle(i % 2 ? 0xb56533 : 0x644675);
       g.fillRect(x - 9, 9, 18, 12);
       g.fillRect(x - 9, 21, 6, 9);
       g.fillRect(x, 21, 6, 6);
       g.fillStyle(0xe6ad61, 0.9);
       g.fillRect(x - 15, 6, 3, 6);
    }
    objects.push(g);
  }

  function mount(scene) {
    if (!scene?.add || !scene?.tweens || !scene?.events ||
        !scene.furnitureLayer || !scene.wallLayer || !scene.floorLayer) {
      throw new Error('HalloweenOffice.mount requires the loaded HQ Phaser scene');
    }
    active.get(scene)?.();
    const objects = [];
    const tweens = [];
    let destroyed = false;
    function destroy() {
      if (destroyed) return;
      destroyed = true;
      scene.events.off('shutdown', destroy);
      scene.events.off('destroy', destroy);
      tweens.forEach(t => t.remove());
      objects.forEach(o => o.destroy());
      if (active.get(scene) === destroy) active.delete(scene);
    }
    destroy.destroy = destroy;
    active.set(scene, destroy);
    scene.events.once('shutdown', destroy);
    scene.events.once('destroy', destroy);

    // Check both halves of the actual cabinet top: a future Tiled re-import
    // simply omits a misplaced decoration instead of painting a walkway.
    SHELVES.forEach(({ col, row }) => {
      if (gid(scene.furnitureLayer, col, row) === 2966 &&
          gid(scene.furnitureLayer, col + 1, row) === 2967) {
        pumpkin(scene, col, row, objects, tweens);
      }
    });
    WALL_PUMPKINS.forEach(({ col, row }) => {
      if (gid(scene.wallLayer, col, row) === 692 &&
          !gid(scene.furnitureLayer, col, row)) {
        pumpkin(scene, col, row, objects, tweens);
      }
    });
    GARLANDS.forEach(({ col, row }) => {
      if (Array.from({ length: 5 }, (_, i) => col + i).every(c =>
        gid(scene.wallLayer, c, row) === 692 &&
        !gid(scene.furnitureLayer, c, row))) {
        garland(scene, col, row, objects);
      }
    });
     CORNERS.forEach(({ col, row, size, dir = 1 }) => {
       // Fail closed if map edits introduce a desk, sign, door or station.
       const clear = Array.from({ length: size * size }, (_, i) => {
         const c = i % size, r = Math.floor(i / size);
         return c * c + r * r >= size * size ||
           (gid(scene.floorLayer, col + c * dir, row + r) > 0 &&
            gid(scene.furnitureLayer, col + c * dir, row + r) <= 0 &&
            gid(scene.wallLayer, col + c * dir, row + r) <= 0);
       }).every(Boolean);
      if (gid(scene.floorLayer, col, row) &&
           clear && gid(scene.wallLayer, col - dir, row) > 0 &&
           gid(scene.wallLayer, col, row - 1) > 0) {
         web(scene, col, row, size, dir, objects, tweens);
      }
    });
    // Tilemap layers and players both use depth 0 here. Inserting immediately
    // after Wall explicitly puts decor above the authored furniture/wall
    // layers but BELOW the local/remote avatars, regardless of when mount ran.
    // Reverse iteration preserves the pumpkin's face-glow-above-shell order.
    for (let i = objects.length - 1; i >= 0; i--) {
      scene.children.moveAbove(objects[i], scene.wallLayer);
    }
    return destroy;
  }

  window.HalloweenOffice = { mount };
})();