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
  // Tiny jack-o'-lantern wall plaques: the uninterrupted solid wall under
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
  // Upper inside corners of the same rooms, plus the front-desk wall.
  // Cobwebs stay within the top 32px of wall/floor, away from door openings.
  const CORNERS = [
    { col: 33, row: 17 }, { col: 81, row: 17 },
    { col: 128, row: 17 }, { col: 35, row: 53 },
    { col: 80, row: 53 }
  ];

  function gid(layer, col, row) {
    return layer && layer.getTileAt(col, row)?.index || 0;
  }

  function pumpkin(scene, col, row, objects, tweens) {
    // On either a cabinet's upper tile or a solid wall-plaque tile,
    // never in the walkway or a seat below.
    const x = (col + 0.8) * CELL;
    const y = row * CELL + 28;
    const g = scene.add.graphics({ x, y }).setDepth(0);
    g.fillStyle(0x24182f, 0.5);
    g.fillEllipse(0, 3, 35, 11);
    g.fillStyle(0x345438);
    g.fillRect(-2, -19, 5, 7);
    g.fillStyle(0x703b1f);
    g.fillEllipse(-9, -5, 15, 24);
    g.fillEllipse(9, -5, 15, 24);
    g.fillStyle(0xb86a2b);
    g.fillEllipse(0, -5, 25, 27);
    g.lineStyle(1, 0xdd9341, 0.72);
    g.lineBetween(-5, -17, -7, 5);
    g.lineBetween(5, -17, 7, 5);
    g.fillStyle(0x412033);
    g.fillTriangle(-8, -8, -3, -8, -5, -3);
    g.fillTriangle(3, -8, 8, -8, 5, -3);
    g.fillRect(-5, 0, 10, 2);
    g.fillRect(-3, 2, 6, 2);
    objects.push(g);

    // Only the carved face breathes; no flashing room-sized light or particles.
    const ember = scene.add.graphics({ x, y }).setDepth(0);
    ember.fillStyle(0xffc66b, 0.67);
    ember.fillTriangle(-7, -7, -4, -7, -5, -5);
    ember.fillTriangle(4, -7, 7, -7, 5, -5);
    ember.fillRect(-3, 1, 6, 2);
    ember.setAlpha(0.56);
    objects.push(ember);
    tweens.push(scene.tweens.add({
      targets: ember, alpha: 0.84, duration: 1900 + col * 13,
      yoyo: true, repeat: -1, ease: 'Sine.easeInOut'
    }));
  }

  function web(scene, col, row, objects) {
    const x = col * CELL;
    const y = row * CELL;
    const g = scene.add.graphics({ x, y }).setDepth(0);
    // A 34px corner motif: it never reaches the middle of a tile.
    g.lineStyle(1, 0xcab6dd, 0.55);
    const tips = [[34, 0], [32, 13], [25, 25], [12, 32], [0, 34]];
    tips.forEach(([tx, ty]) => g.lineBetween(0, 0, tx, ty));
    for (const t of [0.36, 0.68, 0.94]) {
      for (let i = 0; i < tips.length - 1; i++) {
        g.lineBetween(tips[i][0] * t, tips[i][1] * t,
          tips[i + 1][0] * t, tips[i + 1][1] * t);
      }
    }
    g.fillStyle(0xa579b7, 0.62);
    g.fillCircle(10, 10, 1.4);
    objects.push(g);
  }

  function garland(scene, col, row, objects) {
    const g = scene.add.graphics({ x: col * CELL, y: row * CELL }).setDepth(0);
    const width = 5 * CELL;
    g.lineStyle(2, 0x62406d, 0.8);
    g.lineBetween(8, 8, width - 8, 8);
    // Small alternating pennants and warm bulbs, hung within the wall tile.
    for (let i = 0; i < 5; i++) {
      const x = i * CELL + CELL / 2;
      g.fillStyle(i % 2 ? 0x9c6136 : 0x644675, 0.86);
      g.fillTriangle(x - 8, 9, x + 8, 9, x, 27);
      g.fillStyle(0xe6ad61, 0.78);
      g.fillCircle(x - 14, 8, 2);
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
    CORNERS.forEach(({ col, row }) => {
      if (gid(scene.floorLayer, col, row) &&
          !gid(scene.furnitureLayer, col, row) &&
          !gid(scene.wallLayer, col, row) &&
          gid(scene.wallLayer, col - 1, row)) {
        web(scene, col, row, objects);
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