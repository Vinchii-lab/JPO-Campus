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
   // Coverage is by physical spaces in JPO_HQ.tmj, NOT the announcement ROOMS
   // rectangles (which omit the two utility offices and merge several rooms).
   // The three north wings each contain an enclosed supervisor office; nap
   // rooms split at c182; HR splits at c48; QA/L&D split at c162/r73/r82;
   // utility offices split at r113; Accounting splits at c170/r116.
   // Ceiling anchors next to plants/shelves have a short silk lead back to the
   // actual corner. The open cafeteria has no walls: silk attaches to its
   // north-west planter instead. No automatic scattering / map edits.
  const CORNERS = [
      { room: 'Ops supervisor', col: 33, row: 21, size: 2, vertical: -1 },
      { room: 'Ops open office', col: 33, row: 38, size: 3 },
      { room: 'CMA supervisor', col: 81, row: 21, size: 2, vertical: -1 },
      { room: 'CMA open office', col: 81, row: 36, size: 4 },
      { room: 'Claims supervisor', col: 128, row: 21, size: 2, vertical: -1 },
      { room: 'Claims open office', col: 128, row: 36, size: 3 },
      { room: 'Nap west', col: 181, row: 17, size: 4, dir: -1 },
      { room: 'Nap east', col: 183, row: 17, size: 4 },
      { room: 'Gym', col: 208, row: 17, size: 3, dir: -1 },
      { room: 'Front Desk', col: 35, row: 53, size: 3 },
      { room: 'Front Desk east', col: 78, row: 53, size: 6, dir: -1 },
      { room: 'Recruiters Room', col: 69, row: 66, size: 6 },
      { room: 'HR west meeting', col: 33, row: 81, size: 4, vertical: -1 },
      { room: 'HR west lounge', col: 33, row: 84, size: 5 },
      { room: 'HR east kitchenette', col: 49, row: 78, size: 2 },
      { room: 'HR east meeting', col: 49, row: 82, size: 3 },
      { room: 'HR east office', col: 65, row: 94, size: 5, dir: -1, vertical: -1 },
      { room: 'Cafeteria', col: 93, row: 51, size: 4, planter: true },
      { room: 'QA main', col: 152, row: 53, size: 5, cornerCol: 149 },
      { room: 'QA meeting', col: 190, row: 71, size: 5, dir: -1, vertical: -1 },
      { room: 'Game Room', col: 208, row: 53, size: 6, dir: -1 },
      { room: 'L&D meeting', col: 181, row: 74, size: 4, dir: -1 },
      { room: 'L&D classroom', col: 164, row: 83, size: 3, cornerCol: 162 },
      { room: 'Dev Room', col: 50, row: 98, size: 4 },
      { room: 'Dev utility office', col: 71, row: 104, size: 4, dir: -1 },
      { room: 'IT Office', col: 49, row: 113, size: 4 },
      { room: 'IT utility office', col: 71, row: 115, size: 4, dir: -1 },
      { room: 'Executive east meeting', col: 147, row: 108, size: 6, dir: -1 },
      { room: 'Conference Hall', col: 89, row: 115, size: 5, vertical: -1 },
      { room: "COO's Office", col: 89, row: 118, size: 3 },
      { room: "CEO's Office", col: 106, row: 118, size: 5 },
      { room: "CFO's Office", col: 139, row: 118, size: 5, dir: -1, cornerCol: 149 },
      { room: 'Accounting main', col: 158, row: 126, size: 5, dir: -1, vertical: -1 },
      { room: 'Accounting meeting', col: 171, row: 117, size: 5 }
  ];
   // Each floor vignette occupies a checked 2x3 empty pocket, away from the
   // quarter-circle silk footprints. Ghosts hang from checked ceiling tiles.
   const VIGNETTES = [
     { kind: 'ghost', col: 73, row: 17 },
     { kind: 'ghost', col: 120, row: 17 },
     { kind: 'ghost', col: 166, row: 17 },
     { kind: 'ghost', col: 197, row: 53 },
     { kind: 'candles', col: 53, row: 59 },
     { kind: 'cauldron', col: 51, row: 70 },
     { kind: 'cauldron', col: 135, row: 89 },
     { kind: 'grave', col: 75, row: 91 },
     { kind: 'candles', col: 154, row: 90 },
     { kind: 'grave', col: 59, row: 124 },
     { kind: 'candles', col: 98, row: 112 },
     { kind: 'candles', col: 182, row: 121 }
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

   function web(scene, col, row, size, dir, objects, tweens, vertical = 1, cornerCol, planter) {
     const x = (col + (dir < 0 ? 1 : 0)) * CELL;
     const y = (row + (vertical < 0 ? 1 : 0)) * CELL;
      const g = scene.add.graphics({ x, y }).setDepth(0).setScale(dir, vertical);
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
      if (planter) strand(0, 0, -24, 18);
      if (cornerCol !== undefined) {
        strand(0, 0, ((cornerCol + 1) * CELL - x) / dir, 0);
      }
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
      const spider = scene.add.graphics({ x: x + sx * dir, y: y + sy * vertical }).setDepth(0);
     spider.fillStyle(0x382342);
     spider.fillRect(-6, -3, 15, 15);
     for (const side of [-1, 1]) for (let leg = 0; leg < 3; leg++) {
       spider.fillRect(side < 0 ? -12 : 9, leg * 6 - 6, 6, 3);
       spider.fillRect(side < 0 ? -15 : 15, leg * 6 - 9, 3, 6);
     }
     spider.fillStyle(0xdf8bed); spider.fillRect(-3, 0, 3, 3); spider.fillRect(3, 0, 3, 3);
     objects.push(spider);
      // Only room-scale focal spiders move; small-room silk stays static.
      if (size >= 5) tweens.push(scene.tweens.add({ targets: spider, y: spider.y + 6,
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
       if (i % 2 === 0) {
         // Stepped bat wings, pointed ears and tiny amber eyes.
         g.fillStyle(0x382342);
         g.fillRect(x - 21, 15, 42, 6);
         g.fillRect(x - 18, 21, 36, 6);
         g.fillRect(x - 12, 27, 6, 3); g.fillRect(x + 6, 27, 6, 3);
         g.fillRect(x - 6, 12, 12, 21);
         g.fillRect(x - 6, 9, 3, 6); g.fillRect(x + 3, 9, 3, 6);
         g.fillStyle(0xffce7e);
         g.fillRect(x - 3, 18, 3, 3); g.fillRect(x + 3, 18, 3, 3);
       } else {
       g.fillStyle(0xb56533);
       g.fillRect(x - 9, 9, 18, 12);
       g.fillRect(x - 9, 21, 6, 9);
       g.fillRect(x, 21, 6, 6);
       }
       g.fillStyle(0xe6ad61, 0.9);
       g.fillRect(x - 15, 6, 3, 6);
    }
    objects.push(g);
  }

   function vignette(scene, kind, col, row, objects, effects) {
     const x = (col + 1) * CELL, y = (row + (kind === 'ghost' ? 2 : 2.75)) * CELL;
     const g = scene.add.graphics({ x, y }).setDepth(0);
     const glow = scene.add.graphics({ x, y }).setDepth(0);
     const rect = (target, color, a, b, w, h, alpha = 1) => {
       target.fillStyle(color, alpha); target.fillRect(a * 3, b * 3, w * 3, h * 3);
     };
     if (kind === 'ghost') {
       // Visible ceiling string; sheet body ends above the floor, deliberately.
       rect(g, 0x79677e, 0, -44, 1, 15);
       rect(g, 0x6b547b, -8, -29, 16, 19);
       rect(g, 0xbba7d0, -10, -24, 20, 12);
       rect(g, 0xfff1df, -6, -30, 12, 21);
       rect(g, 0xfff1df, -8, -27, 16, 15);
       for (const a of [-7, -1, 5]) rect(g, 0xfff1df, a, -12, 3, 5);
       rect(g, 0x45334f, -5, -24, 3, 4); rect(g, 0x45334f, 3, -24, 3, 4);
       rect(g, 0xe799ad, -7, -19, 3, 2); rect(g, 0xe799ad, 5, -19, 3, 2);
       rect(g, 0x45334f, 0, -18, 2, 3);
     } else {
       rect(g, 0x342536, -12, -1, 24, 3, 0.25);
       if (kind === 'cauldron') {
         rect(g, 0x302a40, -10, -14, 20, 13);
         rect(g, 0x302a40, -13, -12, 26, 7);
         rect(g, 0x625472, -8, -12, 16, 9);
         rect(g, 0x42354f, -3, -12, 12, 10);
         rect(g, 0x302a40, -12, -16, 24, 4);
         rect(g, 0xa3d464, -9, -16, 18, 2);
         rect(g, 0x302a40, -9, -2, 4, 3); rect(g, 0x302a40, 5, -2, 4, 3);
         rect(g, 0xd7efa1, -6, -15, 4, 1);
         for (const [a, b] of [[-6, -21], [3, -25], [-2, -30]]) {
           rect(glow, 0x97df9a, a, b, 5, 4, 0.45);
           rect(glow, 0xdcffc0, a + 1, b, 2, 2, 0.9);
         }
       } else if (kind === 'grave') {
         rect(g, 0x4d425b, -10, -19, 16, 20);
         rect(g, 0x4d425b, -7, -22, 10, 3);
         rect(g, 0xa49aa9, -8, -18, 12, 17);
         rect(g, 0xbfb4c1, -6, -20, 8, 3);
         rect(g, 0x645770, -3, -16, 2, 8);
         rect(g, 0x645770, -6, -14, 8, 2);
         rect(g, 0x645770, -6, -5, 8, 1);
         // A little skeleton hand emerging beside the stone, on a soil base.
         rect(g, 0x57424c, 6, -1, 8, 2);
         rect(g, 0xe8dfcf, 8, -7, 3, 7);
         rect(g, 0xe8dfcf, 6, -10, 7, 4);
         for (const a of [6, 9, 12]) rect(g, 0xe8dfcf, a, -14, 1, 5);
       } else {
         rect(g, 0x55405f, -12, -2, 24, 3);
         for (const [a, height] of [[-9, 12], [-2, 19], [6, 9]]) {
           rect(g, 0xb393bd, a, -height, 5, height - 2);
           rect(g, 0xead5ca, a, -height, 2, height - 3);
           rect(g, 0xffe4b2, a + 3, -height, 2, 4);
           rect(glow, 0xe99247, a, -height - 5, 5, 5);
           rect(glow, 0xffedb9, a + 1, -height - 7, 2, 6);
         }
       }
     }
     objects.push(g, glow);
     if (kind === 'cauldron') effects.vapor.push(glow);
     if (kind === 'candles') effects.flames.push(glow);
   }

  function mount(scene) {
    if (!scene?.add || !scene?.tweens || !scene?.events ||
        !scene.furnitureLayer || !scene.wallLayer || !scene.floorLayer) {
      throw new Error('HalloweenOffice.mount requires the loaded HQ Phaser scene');
    }
    active.get(scene)?.();
    const objects = [];
    const tweens = [];
     const coverage = [];
     const props = [];
     const effects = { vapor: [], flames: [], eyes: [] };
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
     // Read-only snapshots for native-scene inspection; no globals or player data.
     destroy.report = () => ({
       destroyed, rooms: coverage.map(r => ({ ...r })),
       props: props.map(p => ({ ...p })), objects: objects.length, tweens: tweens.length
     });
    active.set(scene, destroy);
    scene.events.once('shutdown', destroy);
    scene.events.once('destroy', destroy);

    // Check both halves of the actual cabinet top: a future Tiled re-import
    // simply omits a misplaced decoration instead of painting a walkway.
    SHELVES.forEach(({ col, row }) => {
      if (gid(scene.furnitureLayer, col, row) === 2966 &&
          gid(scene.furnitureLayer, col + 1, row) === 2967) {
        pumpkin(scene, col, row, objects, tweens);
         const eyes = scene.add.graphics({ x: col * CELL, y: (row + 1) * CELL }).setDepth(0);
         eyes.fillStyle(0x32263b); eyes.fillRect(15, 9, 63, 18);
         eyes.fillStyle(0xceef96);
         for (const dx of [24, 51]) {
           eyes.fillRect(dx, 15, 12, 6);
           eyes.fillStyle(0x32263b); eyes.fillRect(dx + 6, 15, 3, 6);
           eyes.fillStyle(0xceef96);
         }
         objects.push(eyes); effects.eyes.push(eyes);
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
      CORNERS.forEach(({ room, col, row, size, dir = 1, vertical = 1, cornerCol, planter }) => {
       // Fail closed if map edits introduce a desk, sign, door or station.
       const clear = Array.from({ length: size * size }, (_, i) => {
         const c = i % size, r = Math.floor(i / size);
         return c * c + r * r >= size * size ||
            (gid(scene.floorLayer, col + c * dir, row + r * vertical) > 0 &&
             gid(scene.furnitureLayer, col + c * dir, row + r * vertical) <= 0 &&
             gid(scene.wallLayer, col + c * dir, row + r * vertical) <= 0);
       }).every(Boolean);
       const anchored = planter
         ? gid(scene.furnitureLayer, col - 1, row) === 2732
         : gid(scene.wallLayer, col, row - vertical) > 0 &&
           (cornerCol !== undefined
             ? gid(scene.wallLayer, cornerCol, row - vertical) > 0
             : gid(scene.wallLayer, col - dir, row) > 0);
       const mounted = !!(gid(scene.floorLayer, col, row) && clear && anchored);
       coverage.push({ room, col, row, size, dir, vertical, mounted });
       if (mounted) {
          web(scene, col, row, size, dir, objects, tweens, vertical, cornerCol, planter);
      }
    });
     VIGNETTES.forEach(({ kind, col, row }) => {
       const height = kind === 'ghost' ? 2 : 3;
       const clear = Array.from({ length: height * 2 }, (_, i) => {
         const c = col + i % 2, r = row + Math.floor(i / 2);
         return gid(scene.floorLayer, c, r) > 0 &&
           !gid(scene.furnitureLayer, c, r) && !gid(scene.wallLayer, c, r);
       }).every(Boolean);
       const mounted = clear && (kind !== 'ghost' || gid(scene.wallLayer, col, row - 1) > 0);
       props.push({ kind, col, row, mounted });
       if (mounted) vignette(scene, kind, col, row, objects, effects);
     });
     // Three batched tweens total for all new animated details: no update
     // callback, particles, timers or per-frame drawing. Cleanup owns all three.
     if (effects.flames.length) tweens.push(scene.tweens.add({
       targets: effects.flames, alpha: 0.6, duration: 680, yoyo: true, repeat: -1
     }));
     if (effects.vapor.length) tweens.push(scene.tweens.add({
       targets: effects.vapor, y: '-=9', alpha: 0.35,
       duration: 1700, yoyo: true, repeat: -1, ease: 'Sine.easeInOut'
     }));
     if (effects.eyes.length) tweens.push(scene.tweens.add({
       targets: effects.eyes, alpha: 0.45, duration: 2200,
       yoyo: true, repeat: -1, ease: 'Sine.easeInOut'
     }));
     const missing = coverage.filter(r => !r.mounted).map(r => r.room);
     const blocked = props.filter(p => !p.mounted).map(p => `${p.kind}@${p.col},${p.row}`);
     if (missing.length || blocked.length) {
       console.warn('Halloween HQ map-anchor audit failed', { missing, blocked });
     }
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