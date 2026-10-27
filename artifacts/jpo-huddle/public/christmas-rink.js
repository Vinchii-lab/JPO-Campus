/* Christmas HQ skating area: ONE authored, visual-only rink in the east end of
   the cafeteria lounge. No tiles, bodies, colliders or map data are touched.
   Snow accumulates from the SERVER clock that main publishes on seasonState:
     window._christmasSnowStartedAt (ms timestamp), window._christmasServerOffsetMs
   progress = clamp((Date.now() + offset - start) / 120000, 0, 1); null/invalid -> 0.
   Slippery once progress >= 0.5 and the avatar's whole foot body is inside. */
(function () {
  'use strict';

  const CELL = 48;
  const FILL_MS = 120000;
  const SLIPPERY_AT = 0.5;
  const FOOT_OFFSET_Y = 27, HALF_W = 18, HALF_H = 15;
  // Cafeteria east lounge, between the last table column (c135-138) and the
  // east wall (c149); north of the c149 doorway (r69-71), south of the main
  // r44-50 aisle. Tiles c141..147 x r56..65 inclusive (7 x 10 tiles).
  const RECT = Object.freeze({ col: 141, row: 56, cols: 7, rows: 10 });
  const MARGIN = 1;
  const BOUNDS = Object.freeze({
    x: RECT.col * CELL, y: RECT.row * CELL, w: RECT.cols * CELL, h: RECT.rows * CELL,
    left: RECT.col * CELL, top: RECT.row * CELL,
    right: (RECT.col + RECT.cols) * CELL, bottom: (RECT.row + RECT.rows) * CELL
  });
  const active = new WeakMap();

  function gid(layer, c, r) { return Math.max(0, layer?.getTileAt?.(c, r)?.index || 0); }
  function areaClear(scene) {
    for (let c = RECT.col - MARGIN; c < RECT.col + RECT.cols + MARGIN; c++)
      for (let r = RECT.row - MARGIN; r < RECT.row + RECT.rows + MARGIN; r++)
        if (!(gid(scene.floorLayer, c, r) > 0) || gid(scene.wallLayer, c, r) || gid(scene.furnitureLayer, c, r)) return false;
    return true;
  }

  function computeProgress(now, start, offset) {
    const s = typeof start === 'string' ? Date.parse(start) : start;
    if (s == null || typeof s !== 'number' || !Number.isFinite(s) || s <= 0) return 0;
    const off = Number.isFinite(offset) ? offset : 0;
    const p = (now + off - s) / FILL_MS;
    return Number.isFinite(p) ? Math.max(0, Math.min(1, p)) : 0;
  }
  function liveProgress() {
    return computeProgress(Date.now(), window._christmasSnowStartedAt, window._christmasServerOffsetMs);
  }
  function containsBody(x, y) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
    const fy = y + FOOT_OFFSET_Y;
    return x - HALF_W >= BOUNDS.left && x + HALF_W <= BOUNDS.right &&
      fy - HALF_H >= BOUNDS.top && fy + HALF_H <= BOUNDS.bottom;
  }

  // Deterministic snow speck layout (texel grid, 3px).
  const SPECKS = (() => {
    const out = []; let s = 4421;
    const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647;
    for (let i = 0; i < 260; i++) out.push([Math.floor(rnd() * (BOUNDS.w / 3 - 2)) + 1, Math.floor(rnd() * (BOUNDS.h / 3 - 2)) + 1, rnd()]);
    return out;
  })();

  function paintSurface(g, p) {
    g.clear();
    const W = BOUNDS.w, H = BOUNDS.h;
    const ice = p >= SLIPPERY_AT;
    // Base: pale frost tint that deepens with accumulation.
    g.fillStyle(ice ? 0xcfe6f5 : 0xe8f0f7, Math.min(0.85, 0.12 + p * 0.9));
    g.fillRect(0, 0, W, H);
    // Specks: count grows linearly with progress (gradual fill).
    const n = Math.round(SPECKS.length * Math.min(1, p * 1.6));
    for (let i = 0; i < n; i++) {
      const [tx, ty, k] = SPECKS[i];
      g.fillStyle(k < 0.5 ? 0xffffff : 0xdbe9f6, ice ? 0.5 : 0.85);
      g.fillRect(tx * 3, ty * 3, k < 0.2 ? 6 : 3, 3);
    }
    if (ice) {
      // Static skate scratches + glossy diagonal bands.
      g.fillStyle(0xa9cde6, 0.55);
      for (let i = 0; i < 6; i++) g.fillRect(30 + i * 45, 60 + (i % 3) * 140, 60, 3);
      g.fillStyle(0xffffff, 0.35);
      for (let i = 0; i < 4; i++) g.fillRect(24 + i * 72, 24, 9, H - 48);
    }
  }
  function paintBorder(g) {
    const W = BOUNDS.w, H = BOUNDS.h;
    g.clear();
    for (let x = 0; x < W; x += 12) {
      const col = (x / 12) % 2 ? 0xf4f8fc : 0x3f7fb5;
      g.fillStyle(col, 1); g.fillRect(x, -3, 12, 6); g.fillRect(x, H - 3, 12, 6);
    }
    for (let y = 0; y < H; y += 12) {
      const col = (y / 12) % 2 ? 0xf4f8fc : 0x3f7fb5;
      g.fillStyle(col, 1); g.fillRect(-3, y, 6, 12); g.fillRect(W - 3, y, 6, 12);
    }
  }

  function mount(scene, opts = {}) {
    if (!scene?.add || !scene?.events) throw new Error('ChristmasRink.mount requires a Phaser scene');
    active.get(scene)?.();
    const reduced = !!opts.reduced;
    const objects = [], tweens = [];
    let destroyed = false, lastStep = -1, lastIce = null;
    const ok = !!(scene.floorLayer && scene.wallLayer && scene.furnitureLayer) && areaClear(scene);
    const api = {
      bounds: BOUNDS, rect: RECT, mounted: ok,
      progress: liveProgress,
      contains: containsBody,
      isSlippery(x, y) { return !destroyed && ok && liveProgress() >= SLIPPERY_AT && containsBody(x, y); },
      label: () => (liveProgress() >= SLIPPERY_AT ? 'Ice ready' : 'Snow collecting')
    };
    let surface = null, border = null, sheen = null, label = null;
    const refresh = () => {
      if (destroyed || !surface) return;
      const p = liveProgress(), step = Math.round(p * 40), ice = p >= SLIPPERY_AT;
      if (step !== lastStep) { lastStep = step; paintSurface(surface, p); }
      if (ice !== lastIce) {
        lastIce = ice;
        label?.setText?.(ice ? 'Ice ready' : 'Snow collecting · ' + Math.round(p / SLIPPERY_AT * 100) + '%');
        if (sheen) sheen.setVisible(ice);
      } else if (!ice) label?.setText?.('Snow collecting · ' + Math.round(p / SLIPPERY_AT * 100) + '%');
    };
    let acc = 0;
    const tick = (_t, delta) => { acc += Math.min(delta || 16, 100); if (acc >= 400) { acc = 0; refresh(); } };

    function destroy() {
      if (destroyed) return;
      destroyed = true;
      scene.events.off('update', tick);
      scene.events.off('shutdown', destroy);
      scene.events.off('destroy', destroy);
      tweens.forEach(t => t.remove());
      objects.forEach(o => o.destroy());
      if (scene._christmasRink === api) delete scene._christmasRink;
      if (active.get(scene) === destroy) active.delete(scene);
    }
    destroy.destroy = destroy;
    destroy.api = api;
    destroy.report = () => ({ destroyed, mounted: ok, reduced, objects: objects.length, tweens: tweens.length });
    active.set(scene, destroy);
    scene.events.once('shutdown', destroy);
    scene.events.once('destroy', destroy);

    if (!ok) {
      console.warn('Christmas rink map audit failed', { rect: RECT });
      return destroy;
    }
    scene._christmasRink = api;

    surface = scene.add.graphics({ x: BOUNDS.x, y: BOUNDS.y }).setDepth(0);
    border = scene.add.graphics({ x: BOUNDS.x, y: BOUNDS.y }).setDepth(0);
    paintBorder(border);
    sheen = scene.add.graphics({ x: BOUNDS.x, y: BOUNDS.y }).setDepth(0).setVisible(false);
    sheen.fillStyle(0xffffff, 0.18); sheen.fillRect(6, 6, BOUNDS.w - 12, BOUNDS.h / 3);
    // Sign: small navy board on two posts at the rink's north edge.
    const sign = scene.add.graphics({ x: BOUNDS.x + BOUNDS.w / 2, y: BOUNDS.y + 6 }).setDepth(0);
    sign.fillStyle(0x2a2f4a, 1); sign.fillRect(-60, 0, 120, 30);
    sign.fillStyle(0xf4f8fc, 1); sign.fillRect(-57, 3, 114, 2);
    sign.fillStyle(0x3f7fb5, 1); sign.fillRect(-57, 25, 114, 2);
    objects.push(surface, border, sheen, sign);
    const textStyle = (sz, col) => ({ fontFamily: 'monospace', fontSize: sz + 'px', color: col, fontStyle: 'bold' });
    if (scene.add.text) {
      const title = scene.add.text(BOUNDS.x + BOUNDS.w / 2, BOUNDS.y + 13, 'SKATING AREA', textStyle(11, '#f4f8fc')).setDepth(0);
      title.setOrigin?.(0.5, 0.5);
      label = scene.add.text(BOUNDS.x + BOUNDS.w / 2, BOUNDS.y + 48, '', textStyle(10, '#2a4f73')).setDepth(0);
      label.setOrigin?.(0.5, 0.5);
      objects.push(title, label);
    }
    refresh();
    scene.events.on('update', tick);
    if (!reduced && scene.tweens) {
      tweens.push(scene.tweens.add({ targets: sheen, alpha: 0.35, duration: 1800, yoyo: true, repeat: -1, ease: 'Sine.easeInOut' }));
    }
    if (scene.children?.moveAbove && scene.wallLayer) {
      for (let i = objects.length - 1; i >= 0; i--) scene.children.moveAbove(objects[i], scene.wallLayer);
    }
    return destroy;
  }

  window.ChristmasRink = { mount, RECT, BOUNDS, computeProgress, containsBody, FILL_MS, SLIPPERY_AT,
    current: (scene) => active.get(scene) || null };
})();
