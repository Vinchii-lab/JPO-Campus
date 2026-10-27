/* Christmas HQ snow + ice: several naturally accumulated, irregular snow
   patches across clear indoor HQ floor. Visual-only: no tiles, bodies,
   colliders or map data are touched. Snow accumulates from the SERVER clock
   that main publishes on seasonState:
     window._christmasSnowStartedAt (ms timestamp), window._christmasServerOffsetMs
   progress = clamp((Date.now() + offset - start) / 120000, 0, 1); null/invalid -> 0.
   Each patch is a deterministic blob rasterised on a 12px cell grid. Snow
   grows from the centre outward; once progress >= 0.5 a translucent ice core
   forms and widens. isSlippery() uses EXACTLY the painted ice cells: the
   avatar's whole foot body must cover only ice cells of one patch. */
(function () {
  'use strict';

  const CELL = 48, SUB = 12, K = CELL / SUB;
  const FILL_MS = 120000;
  const SLIPPERY_AT = 0.5;
  const FOOT_OFFSET_Y = 27, HALF_W = 18, HALF_H = 15;
  const MARGIN = 1; // runtime audit ring around each envelope (authoring used 2 + doorway check)

  // Ten envelopes, one per distinct HQ room/area, each on a different side of
  // its room. The blob stays strictly inside its envelope; every envelope is
  // clear floor (no wall/furniture) with a 1-tile ring, >=2 tiles from
  // doorways, off the r43-51 main aisle and >=5 tiles from spawns/anchors.
  const PATCHES = Object.freeze([
    // Ops open office (north-west wing), drift on the room's east desk lane.
    Object.freeze({ id: 'ops_office', room: 'Ops open office', side: 'east', col: 44, row: 34, cols: 6, rows: 8, seed: 11 }),
    // CMA open office (north), tall run down its east aisle.
    Object.freeze({ id: 'cma_office', room: 'CMA open office', side: 'east', col: 92, row: 30, cols: 6, rows: 12, seed: 23 }),
    // Claims open office (north-east), wide drift across its south floor.
    Object.freeze({ id: 'claims_office', room: 'Claims open office', side: 'south', col: 158, row: 35, cols: 13, rows: 7, seed: 37 }),
    // Front Desk reception, east pocket by the recruiters wall.
    Object.freeze({ id: 'front_desk', room: 'Front Desk reception', side: 'east', col: 68, row: 55, cols: 10, rows: 8, seed: 41 }),
    // Cafeteria, single drift along its south lounge (no clustering).
    Object.freeze({ id: 'cafeteria', room: 'Cafeteria', side: 'south', col: 124, row: 72, cols: 23, rows: 7, seed: 53 }),
    // QA main floor (east wing), west-side run.
    Object.freeze({ id: 'qa_main', room: 'QA main', side: 'west', col: 151, row: 57, cols: 10, rows: 12, seed: 61 }),
    // HR west lounge (south-west), north edge of the lounge.
    Object.freeze({ id: 'hr_west_lounge', room: 'HR west lounge', side: 'north', col: 34, row: 86, cols: 7, rows: 6, seed: 67 }),
    // HR east office, west side.
    Object.freeze({ id: 'hr_east_office', room: 'HR east office', side: 'west', col: 65, row: 82, cols: 7, rows: 9, seed: 71 }),
    // South open hall outside HR / Dev: the long east-west glide.
    Object.freeze({ id: 'south_hall', room: 'South open hall', side: 'centre', col: 82, row: 86, cols: 32, rows: 6, seed: 79 }),
    // L&D classroom (south-east), long drift along its south wall.
    Object.freeze({ id: 'ld_classroom', room: 'L&D classroom', side: 'south', col: 162, row: 97, cols: 26, rows: 5, seed: 83 })
].map(p => Object.freeze({ ...p })));

  function hash(i, j, s) {
    let h = (i * 374761393 + j * 668265263 + s * 2246822519) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
  }

  // Precompute per-cell depth s (1 at centre, 0 at blob edge, <0 outside).
  function buildShape(p) {
    const w = p.cols * K, h = p.rows * K, s = new Float32Array(w * h), si = new Float32Array(w * h);
    const r = (k) => hash(k, 7, p.seed);
    const ph = [r(1) * 6.283, r(2) * 6.283, r(3) * 6.283];
    const cx = w / 2, cy = h / 2, ax = w / 2 - 1, ay = h / 2 - 1;
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
      const u = (i + 0.5 - cx) / ax, v = (j + 0.5 - cy) / ay;
      const th = Math.atan2(v, u);
      // Irregular rim: 1 at most, dented by low-frequency harmonics.
      const R = 0.86 + 0.06 * Math.sin(2 * th + ph[0]) + 0.05 * Math.sin(3 * th + ph[1]) + 0.03 * Math.sin(5 * th + ph[2]);
      const d = 1 - Math.hypot(u, v) / R;
      const n = hash(i, j, p.seed) - 0.5;
      s[j * w + i] = d + n * 0.12;      // feathered snow
      si[j * w + i] = d + n * 0.05;     // calmer ice edge
    }
    return { w, h, s, si };
  }
  const SHAPES = PATCHES.map(buildShape);

  const snowCut = (p) => 1 - Math.min(1, p / 0.85) * 0.97;          // s >= cut is snow
  const iceCut = (p) => p < SLIPPERY_AT ? Infinity : 1 - (0.32 + 0.43 * (p - SLIPPERY_AT) / (1 - SLIPPERY_AT));

  function isIceCell(k, i, j, p) {
    const sh = SHAPES[k];
    if (i < 0 || j < 0 || i >= sh.w || j >= sh.h) return false;
    return sh.si[j * sh.w + i] >= iceCut(p);
  }

  function gid(layer, c, r) { return Math.max(0, layer?.getTileAt?.(c, r)?.index || 0); }
  function patchClear(scene, p) {
    for (let c = p.col - MARGIN; c < p.col + p.cols + MARGIN; c++)
      for (let r = p.row - MARGIN; r < p.row + p.rows + MARGIN; r++)
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

  // Index of the patch whose ice fully contains the foot body at progress p, or -1.
  function iceContainsBody(x, y, p, enabled) {
    if (!Number.isFinite(x) || !Number.isFinite(y) || !(p >= SLIPPERY_AT)) return -1;
    const fy = y + FOOT_OFFSET_Y;
    const L = x - HALF_W, R = x + HALF_W, T = fy - HALF_H, B = fy + HALF_H;
    for (let k = 0; k < PATCHES.length; k++) {
      if (enabled && !enabled[k]) continue;
      const P = PATCHES[k], ox = P.col * CELL, oy = P.row * CELL;
      if (L < ox || T < oy || R > ox + P.cols * CELL || B > oy + P.rows * CELL) continue;
      const i0 = Math.floor((L - ox) / SUB), i1 = Math.ceil((R - ox) / SUB) - 1;
      const j0 = Math.floor((T - oy) / SUB), j1 = Math.ceil((B - oy) / SUB) - 1;
      let ok = true;
      for (let j = j0; j <= j1 && ok; j++) for (let i = i0; i <= i1; i++) if (!isIceCell(k, i, j, p)) { ok = false; break; }
      if (ok) return k;
    }
    return -1;
  }
  const containsBody = (x, y, p = 1) => iceContainsBody(x, y, p) >= 0;

  // Paint one patch. Pixel-art: 12px cells, 3px texel details.
  function paintPatch(g, k, p) {
    g.clear();
    const sh = SHAPES[k], seed = PATCHES[k].seed, sc = snowCut(p), ic = iceCut(p);
    if (p <= 0) return;
    for (let j = 0; j < sh.h; j++) for (let i = 0; i < sh.w; i++) {
      const v = sh.s[j * sh.w + i], x = i * SUB, y = j * SUB, hv = hash(i, j, seed + 99);
      if (sh.si[j * sh.w + i] >= ic) {
        const depth = sh.si[j * sh.w + i] - ic;
        if (depth < 0.05) { g.fillStyle(0xa8cfe6, 0.62); g.fillRect(x, y, SUB, SUB); continue; } // rim
        g.fillStyle(depth > 0.22 ? 0x9fcbe8 : 0xbcdff1, 0.5);
        g.fillRect(x, y, SUB, SUB);
        if ((i + j * 2 + seed) % 11 === 0) { g.fillStyle(0xf2f9ff, 0.55); g.fillRect(x + 3, y + 3, 6, 3); }
        else if (hv < 0.05) { g.fillStyle(0x86b6d6, 0.45); g.fillRect(x, y + 6, SUB, 3); }
        continue;
      }
      if (v < sc) continue;
      const t = v - sc;
      if (t < 0.08) {           // feathered edge: sparse dusting
        if (hv > 0.45 + t * 4) continue;
        g.fillStyle(0xf3f7fc, 0.55); g.fillRect(x + (hv < 0.2 ? 3 : 0), y + (hv > 0.3 ? 3 : 0), hv < 0.12 ? 6 : 9, hv < 0.12 ? 6 : 9);
        continue;
      }
      g.fillStyle(t < 0.2 ? 0xe9f1f8 : 0xf6f9fd, Math.min(0.95, 0.7 + t));
      g.fillRect(x, y, SUB, SUB);
      if (hv < 0.12) { g.fillStyle(0xd3e2ef, 0.8); g.fillRect(x + 3, y + 6, 6, 3); }
      else if (hv > 0.94) { g.fillStyle(0xffffff, 0.9); g.fillRect(x + 6, y + 3, 3, 3); }
    }
  }
  function paintSheen(g, k) {
    g.clear();
    const sh = SHAPES[k], seed = PATCHES[k].seed;
    g.fillStyle(0xffffff, 0.8);
    for (let j = 0; j < sh.h; j++) for (let i = 0; i < sh.w; i++)
      if (sh.si[j * sh.w + i] > 0.45 && hash(i, j, seed + 5) < 0.035) { g.fillRect(i * SUB + 3, j * SUB, 3, 9); g.fillRect(i * SUB, j * SUB + 3, 9, 3); }
  }

  const UNION = (() => {
    const l = Math.min(...PATCHES.map(p => p.col)) * CELL, t = Math.min(...PATCHES.map(p => p.row)) * CELL;
    const r = Math.max(...PATCHES.map(p => p.col + p.cols)) * CELL, b = Math.max(...PATCHES.map(p => p.row + p.rows)) * CELL;
    return Object.freeze({ x: l, y: t, w: r - l, h: b - t, left: l, top: t, right: r, bottom: b });
  })();

  const active = new WeakMap();
  function mount(scene, opts = {}) {
    if (!scene?.add || !scene?.events) throw new Error('ChristmasRink.mount requires a Phaser scene');
    active.get(scene)?.();
    const reduced = !!opts.reduced;
    const objects = [], tweens = [];
    let destroyed = false, lastStep = -1;
    const layersOk = !!(scene.floorLayer && scene.wallLayer && scene.furnitureLayer);
    const enabled = PATCHES.map(p => layersOk && patchClear(scene, p));
    const ok = enabled.some(Boolean);
    const api = {
      bounds: UNION, mounted: ok,
      patches: PATCHES.map((p, k) => ({ ...p, mounted: enabled[k] })),
      progress: liveProgress,
      contains: (x, y) => iceContainsBody(x, y, liveProgress(), enabled) >= 0,
      patchAt: (x, y) => { const k = iceContainsBody(x, y, liveProgress(), enabled); return k >= 0 ? PATCHES[k].id : null; },
      isSlippery(x, y) { return !destroyed && ok && iceContainsBody(x, y, liveProgress(), enabled) >= 0; },
      label: () => (liveProgress() >= SLIPPERY_AT ? 'Ice ready' : 'Snow collecting')
    };
    const surfaces = [], sheens = [];
    const refresh = () => {
      if (destroyed) return;
      const p = liveProgress(), step = Math.round(p * 48);
      if (step === lastStep) return;
      lastStep = step;
      surfaces.forEach(([g, k]) => paintPatch(g, k, p));
      sheens.forEach(s => s.setVisible(p >= 0.75));
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
    destroy.report = () => ({ destroyed, mounted: ok, reduced, objects: objects.length, tweens: tweens.length,
      patches: PATCHES.map((p, k) => ({ id: p.id, mounted: enabled[k] })) });
    active.set(scene, destroy);
    scene.events.once('shutdown', destroy);
    scene.events.once('destroy', destroy);

    const blocked = PATCHES.filter((_, k) => !enabled[k]).map(p => p.id);
    if (blocked.length) console.warn('Christmas snow patch map audit failed', { blocked });
    if (!ok) return destroy;
    scene._christmasRink = api;

    PATCHES.forEach((P, k) => {
      if (!enabled[k]) return;
      const g = scene.add.graphics({ x: P.col * CELL, y: P.row * CELL }).setDepth(0);
      const sheen = scene.add.graphics({ x: P.col * CELL, y: P.row * CELL }).setDepth(0).setVisible(false);
      paintSheen(sheen, k);
      surfaces.push([g, k]); sheens.push(sheen); objects.push(g, sheen);
    });
    refresh();
    scene.events.on('update', tick);
    if (!reduced && scene.tweens && sheens.length) {
      tweens.push(scene.tweens.add({ targets: sheens, alpha: 0.25, duration: 2200, yoyo: true, repeat: -1, ease: 'Sine.easeInOut' }));
    }
    if (scene.children?.moveAbove && scene.wallLayer) {
      for (let i = objects.length - 1; i >= 0; i--) scene.children.moveAbove(objects[i], scene.wallLayer);
    }
    return destroy;
  }

  window.ChristmasRink = { mount, PATCHES, BOUNDS: UNION, CELL, SUB, computeProgress, containsBody,
    iceContainsBody, isIceCell, snowCut, iceCut, shape: (k) => SHAPES[k], paintPatch,
    FILL_MS, SLIPPERY_AT, FOOT: Object.freeze({ FOOT_OFFSET_Y, HALF_W, HALF_H }),
    current: (scene) => active.get(scene) || null };
})();
