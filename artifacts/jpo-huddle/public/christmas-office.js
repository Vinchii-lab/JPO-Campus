/* Christmas HQ: season-scoped, removable, NON-COLLIDING decoration + the
   shared holiday desk UI. The authored JPO_HQ.tmj stays the source of truth:
   no tiles, bodies, seats, doors or spawns are touched. Every anchor is
   re-verified against the live map at mount time and omitted if a future map
   edit puts furniture/wall under it (fail closed, like HalloweenOffice).
   Activation is decided ONLY by the server's authoritative seasonState. */
(function () {
  'use strict';

  const CELL = 48;
  const active = new WeakMap();

  // Activity anchors (world px). Each is the centre of a checked, empty 2x3
  // floor pocket that is also mounted by the Halloween vignette audit, i.e.
  // known-clear authored floor off the main walking lines. The server uses
  // the same x/y for its <=160px proximity check.
  const ANCHORS = Object.freeze({
    // Reception lobby pocket below the front-desk wall (c53-54, r59-61).
    pickup: Object.freeze({ id: 'frontdesk_parcels', label: 'Front Desk parcel shelf', x: 2592, y: 2904, col: 53, row: 59 }),
    // L&D classroom pocket (c154-155, r90-92).
    destination: Object.freeze({ id: 'ld_classroom', label: 'L&D classroom', x: 7440, y: 4392, col: 154, row: 90 }),
    // Cafeteria north-west corner beside the authored planter (c94-95, r52-54).
    tree: Object.freeze({ id: 'cafeteria_tree', label: 'Cafeteria community tree', x: 4560, y: 2568, col: 94, row: 52 })
  });

  // Reused verified wall runs (plain 692 wall, no furniture) — the same
  // authored cells Halloween uses, so no new wall-run assumptions.
  const GARLANDS = [
    { col: 39, row: 52 }, { col: 49, row: 52 },
    { col: 41, row: 65 }, { col: 62, row: 65 }
  ];
  const WREATHS = [{ col: 34, row: 52 }, { col: 69, row: 52 }, { col: 54, row: 65 }];
  // Cabinet tops at the north edges of the three office wings (2966/2967).
  const SHELVES = [{ col: 46, row: 17 }, { col: 96, row: 17 }, { col: 143, row: 17 }];

  function gid(layer, col, row) {
    return Math.max(0, layer?.getTileAt(col, row)?.index || 0);
  }
  function pocketClear(scene, col, row, w = 2, h = 3) {
    for (let c = col; c < col + w; c++) for (let r = row; r < row + h; r++) {
      if (!(gid(scene.floorLayer, c, r) > 0) || gid(scene.furnitureLayer, c, r) || gid(scene.wallLayer, c, r)) return false;
    }
    return true;
  }
  function reducedEffects() {
    try {
      if (localStorage.getItem('jpo_reduce_fx') === '1') return true;
    } catch (e) { /* storage blocked */ }
    try { return !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches; } catch (e) { return false; }
  }

  const R = (g, color, x, y, w, h, a = 1) => { g.fillStyle(color, a); g.fillRect(x * 3, y * 3, w * 3, h * 3); };

  function drawGarland(scene, col, row, objects, lights) {
    const g = scene.add.graphics({ x: col * CELL, y: row * CELL }).setDepth(0);
    const glow = scene.add.graphics({ x: col * CELL, y: row * CELL }).setDepth(0);
    // Sagging fir rope across five wall cells, 3px texels.
    for (let i = 0; i < 80; i++) {
      const sag = Math.round(Math.sin((i % 16) / 16 * Math.PI) * 3);
      R(g, 0x1f5a3d, i, 3 + sag, 1, 3);
      if (i % 2) R(g, 0x2f7d52, i, 3 + sag, 1, 1);
    }
    const bulbs = [0xe64553, 0xf2c14e, 0x6fc3df, 0xf6efe0];
    for (let i = 0; i < 10; i++) {
      const x = 4 + i * 8, sag = Math.round(Math.sin(((x) % 16) / 16 * Math.PI) * 3);
      R(glow, bulbs[i % 4], x, 6 + sag, 2, 2);
      if (i % 5 === 2) { R(g, 0xb8283a, x - 2, 2 + sag, 5, 3); R(g, 0x8a1c2c, x, 5 + sag, 1, 3); }
    }
    objects.push(g, glow); lights.push(glow);
  }

  function drawWreath(scene, col, row, objects) {
    const g = scene.add.graphics({ x: (col + 0.5) * CELL, y: row * CELL + 24 }).setDepth(0);
    for (let a = 0; a < 16; a++) {
      const t = a / 16 * Math.PI * 2;
      const x = Math.round(Math.cos(t) * 4), y = Math.round(Math.sin(t) * 4);
      R(g, a % 2 ? 0x2f7d52 : 0x1f5a3d, x - 1, y - 1, 3, 3);
      if (a % 4 === 1) R(g, 0xe64553, x, y, 1, 1);
    }
    R(g, 0xc8283a, -2, 3, 5, 2); R(g, 0xc8283a, -3, 5, 2, 3); R(g, 0xc8283a, 2, 5, 2, 3);
    objects.push(g);
  }

  function drawMiniTree(scene, col, row, objects) {
    const g = scene.add.graphics({ x: (col + 1) * CELL, y: (row + 1) * CELL - 6 }).setDepth(0);
    R(g, 0x6b4630, -1, -2, 3, 2);
    for (let i = 0; i < 4; i++) R(g, i % 2 ? 0x2f7d52 : 0x1f5a3d, -4 + i, -5 - i * 2, 9 - i * 2, 3);
    R(g, 0xf2c14e, 0, -13, 1, 2); R(g, 0xe64553, -2, -6, 1, 1); R(g, 0x6fc3df, 2, -8, 1, 1);
    objects.push(g);
  }

  // Community tree: ~90x132px in a 96x144 pocket; ornaments are redrawn from
  // the authoritative contribution count (never invented).
  const ORN_SLOTS = (() => {
    const s = [];
    for (let tier = 0; tier < 6; tier++) {
      const half = 3 + tier * 2.2, y = -38 + tier * 6;
      for (let k = 0; k < 2 + tier; k++) s.push([Math.round(-half + (2 * half) * (k + 0.5) / (2 + tier)), y]);
    }
    return s; // 27 slots
  })();
  function drawTree(scene, objects) {
    const { x, y } = ANCHORS.tree;
    const base = scene.add.graphics({ x, y: y + 66 }).setDepth(0);
    R(base, 0x2a2238, -12, -1, 24, 2, 0.22);              // floor shadow
    R(base, 0x6b4630, -2, -6, 5, 5);
    R(base, 0xb8283a, -6, -4, 12, 4); R(base, 0xf2c14e, -6, -3, 12, 1);  // skirt band
    for (let tier = 0; tier < 7; tier++) {
      const half = 3 + tier * 2.3, ty = -42 + tier * 5.5;
      R(base, 0x16472f, Math.round(-half - 1), Math.round(ty), Math.round(half * 2 + 2), 6);
      R(base, tier % 2 ? 0x2f7d52 : 0x24684a, Math.round(-half), Math.round(ty), Math.round(half * 2), 5);
      R(base, 0x3f9a64, Math.round(-half), Math.round(ty), Math.max(1, Math.round(half * 0.6)), 1);
    }
    // Wrapped presents under the tree (decorative only).
    R(base, 0x6fc3df, -11, -6, 5, 5); R(base, 0xf6efe0, -9, -6, 1, 5);
    R(base, 0xe64553, 7, -5, 5, 4); R(base, 0xf2c14e, 9, -5, 1, 4);
    const star = scene.add.graphics({ x, y: y + 66 }).setDepth(0);
    R(star, 0xf2c14e, -1, -47, 3, 5); R(star, 0xf2c14e, -3, -45, 7, 1); R(star, 0xfff3c4, 0, -46, 1, 1);
    const orn = scene.add.graphics({ x, y: y + 66 }).setDepth(0);
    objects.push(base, orn, star);
    return { star, orn };
  }
  function paintOrnaments(orn, contributions, goal) {
    orn.clear();
    const n = Math.max(0, Math.min(ORN_SLOTS.length,
      Math.round(ORN_SLOTS.length * Math.min(1, (contributions || 0) / Math.max(1, goal || 1)))));
    const cols = [0xe64553, 0xf2c14e, 0x6fc3df, 0xf6efe0, 0xc77dde];
    for (let i = 0; i < n; i++) {
      const [ox, oy] = ORN_SLOTS[(i * 7) % ORN_SLOTS.length];
      R(orn, cols[i % cols.length], ox, oy, 2, 2);
      R(orn, 0xffffff, ox, oy, 1, 1, 0.55);
    }
    return n;
  }

  function drawParcels(scene, objects) {
    const { x, y } = ANCHORS.pickup;
    const g = scene.add.graphics({ x, y: y + 66 }).setDepth(0);
    R(g, 0x2a2238, -12, -1, 24, 2, 0.2);
    R(g, 0xb8283a, -10, -9, 9, 9); R(g, 0xf2c14e, -6, -9, 1, 9); R(g, 0xf2c14e, -10, -5, 9, 1);
    R(g, 0x2f7d52, 1, -7, 8, 7); R(g, 0xf6efe0, 4, -7, 1, 7);
    R(g, 0x6fc3df, -5, -15, 8, 6); R(g, 0xe64553, -2, -15, 1, 6); R(g, 0xe64553, -4, -17, 2, 2); R(g, 0xe64553, 0, -17, 2, 2);
    objects.push(g);
  }
  function drawSack(scene, objects) {
    const { x, y } = ANCHORS.destination;
    const g = scene.add.graphics({ x, y: y + 66 }).setDepth(0);
    R(g, 0x2a2238, -9, -1, 18, 2, 0.2);
    R(g, 0x8a1c2c, -7, -12, 14, 12); R(g, 0xb8283a, -6, -13, 12, 12);
    R(g, 0x8a1c2c, -3, -16, 6, 3); R(g, 0xf2c14e, -3, -14, 6, 1);
    R(g, 0xf6efe0, -6, -3, 12, 2);
    objects.push(g);
  }

  function makeSnow(scene, objects, cleanups) {
    if (!scene.textures.exists('xmasSnowTex')) {
      const c = scene.textures.createCanvas('xmasSnowTex', 192, 192);
      const ctx = c.context; let s = 1225;
      const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647;
      for (let i = 0; i < 34; i++) {
        const big = rnd() < 0.3, sz = big ? 3 : 2;
        ctx.fillStyle = big ? 'rgba(255,255,255,0.9)' : 'rgba(232,242,255,0.75)';
        ctx.fillRect(Math.round(4 + rnd() * 182), Math.round(4 + rnd() * 182), sz, sz);
      }
      c.refresh();
    }
    const W = scene.scale.width, H = scene.scale.height;
    const tint = scene.add.rectangle(W / 2, H / 2, W * 2, H * 2, 0xdfe9ff).setScrollFactor(0).setDepth(99988).setAlpha(0.06);
    const far = scene.add.tileSprite(W / 2, H / 2, W * 2, H * 2, 'xmasSnowTex').setScrollFactor(0).setDepth(99989).setAlpha(0.55);
    const near = scene.add.tileSprite(W / 2, H / 2, W * 2, H * 2, 'xmasSnowTex').setScrollFactor(0).setDepth(99990).setAlpha(0.8).setTileScale(1.7);
    objects.push(tint, far, near);
    const tick = (time, delta) => {
      const d = Math.min(delta || 16, 50);
      far.tilePositionY -= d * 0.028; far.tilePositionX += Math.sin(time / 2400) * d * 0.01;
      near.tilePositionY -= d * 0.05; near.tilePositionX += Math.sin(time / 1700 + 1) * d * 0.016;
    };
    scene.events.on('update', tick);
    cleanups.push(() => scene.events.off('update', tick));
  }

  function mount(scene, opts = {}) {
    if (!scene?.add || !scene?.tweens || !scene?.events ||
        !scene.furnitureLayer || !scene.wallLayer || !scene.floorLayer) {
      throw new Error('ChristmasOffice.mount requires the loaded HQ Phaser scene');
    }
    active.get(scene)?.();
    const reduced = opts.reduced ?? reducedEffects();
    const objects = [], tweens = [], cleanups = [], props = [], lights = [];
    let destroyed = false, tree = null, pointer = null, ornaments = 0;
    function destroy() {
      if (destroyed) return;
      destroyed = true;
      scene.events.off('shutdown', destroy);
      scene.events.off('destroy', destroy);
      cleanups.forEach(f => f());
      tweens.forEach(t => t.remove());
      objects.forEach(o => o.destroy());
      if (active.get(scene) === destroy) active.delete(scene);
    }
    destroy.destroy = destroy;
    destroy.report = () => ({ destroyed, reduced, props: props.map(p => ({ ...p })),
      objects: objects.length, tweens: tweens.length, ornaments });
    // Reflect authoritative state: ornaments + the "go here" pointer.
    destroy.setState = (st) => {
      if (destroyed) return;
      if (tree && st?.tree) ornaments = paintOrnaments(tree.orn, st.tree.contributions, st.tree.goal);
      if (!pointer) return;
      const stage = st?.active ? st.delivery?.stage : null;
      const target = stage === 'ready' ? ANCHORS.pickup : stage === 'carrying' ? ANCHORS.destination : null;
      pointer.setVisible(!!target);
      if (target) { pointer.x = target.x; pointer.y = target.y - 30; pointer._baseY = pointer.y; }
    };
    active.set(scene, destroy);
    scene.events.once('shutdown', destroy);
    scene.events.once('destroy', destroy);

    GARLANDS.forEach(({ col, row }) => {
      const ok = Array.from({ length: 5 }, (_, i) => col + i).every(c =>
        gid(scene.wallLayer, c, row) === 692 && !gid(scene.furnitureLayer, c, row));
      props.push({ kind: 'garland', col, row, mounted: ok });
      if (ok) drawGarland(scene, col, row, objects, lights);
    });
    WREATHS.forEach(({ col, row }) => {
      const ok = gid(scene.wallLayer, col, row) === 692 && !gid(scene.furnitureLayer, col, row);
      props.push({ kind: 'wreath', col, row, mounted: ok });
      if (ok) drawWreath(scene, col, row, objects);
    });
    SHELVES.forEach(({ col, row }) => {
      const ok = gid(scene.furnitureLayer, col, row) === 2966 && gid(scene.furnitureLayer, col + 1, row) === 2967;
      props.push({ kind: 'minitree', col, row, mounted: ok });
      if (ok) drawMiniTree(scene, col, row, objects);
    });
    for (const [kind, a] of Object.entries(ANCHORS)) {
      const ok = pocketClear(scene, a.col, a.row);
      props.push({ kind, col: a.col, row: a.row, x: a.x, y: a.y, mounted: ok });
      if (!ok) continue;
      if (kind === 'tree') tree = drawTree(scene, objects);
      else if (kind === 'pickup') drawParcels(scene, objects);
      else drawSack(scene, objects);
    }
    // Skating area (separate module; its cleanup rides on ours).
    if (window.ChristmasRink?.mount && opts.rink !== false) {
      try {
        const rinkCleanup = window.ChristmasRink.mount(scene, { reduced });
        if (typeof rinkCleanup === 'function') cleanups.push(rinkCleanup);
      } catch (e) { console.warn('Christmas rink mount failed', e); }
    }
    // Floating chevron over the current delivery target (hidden until state).
    pointer = scene.add.graphics({ x: 0, y: 0 }).setDepth(0).setVisible(false);
    R(pointer, 0x8a1c2c, -4, -4, 9, 3); R(pointer, 0xf2c14e, -3, -4, 7, 2);
    R(pointer, 0x8a1c2c, -2, -1, 5, 2); R(pointer, 0xf2c14e, -1, -1, 3, 1); R(pointer, 0x8a1c2c, 0, 1, 1, 1);
    objects.push(pointer);

    if (!reduced) {
      if (lights.length) tweens.push(scene.tweens.add({ targets: lights, alpha: 0.55, duration: 1300, yoyo: true, repeat: -1, ease: 'Sine.easeInOut' }));
      if (tree) tweens.push(scene.tweens.add({ targets: tree.star, alpha: 0.6, duration: 1700, yoyo: true, repeat: -1, ease: 'Sine.easeInOut' }));
      tweens.push(scene.tweens.add({ targets: pointer, y: '-=8', duration: 650, yoyo: true, repeat: -1, ease: 'Sine.easeInOut' }));
      if (scene.textures && scene.scale && opts.snow !== false) makeSnow(scene, objects, cleanups);
    }
    const blocked = props.filter(p => !p.mounted).map(p => `${p.kind}@${p.col},${p.row}`);
    if (blocked.length) console.warn('Christmas HQ map-anchor audit failed', { blocked });
    // Above authored furniture/walls, below avatars (same rule as Halloween).
    for (let i = objects.length - 1; i >= 0; i--) {
      if (objects[i].scrollFactorX === 0) continue;
      scene.children.moveAbove(objects[i], scene.wallLayer);
    }
    if (opts.state) destroy.setState(opts.state);
    return destroy;
  }

  // ── Holiday desk UI (DOM) ───────────────────────────────────────────────
  let ui = null;
  function fmtDate(iso) {
    const d = new Date(iso + 'T00:00:00Z');
    if (isNaN(d)) return iso || '';
    return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' }) + ' UTC';
  }
  function esc(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]); }

  function initUI({ socket, getScene, getPlayerPos, isInOffice }) {
    if (ui || !socket) return ui;
    const btn = document.createElement('button');
    btn.id = 'xmas-btn'; btn.type = 'button'; btn.textContent = 'Holiday Desk'; btn.hidden = true;
    const panel = document.createElement('div');
    panel.id = 'xmas-panel'; panel.hidden = true;
    panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-label', 'HQ Holiday Desk');
    document.body.append(btn, panel);
    ui = { state: null, error: '', busy: '', open: false };

    const request = () => socket.emit('christmasRequest');
    const render = () => {
      const st = ui.state;
      const live = !!st?.active;
      btn.hidden = !live;
      if (!live) { panel.hidden = true; ui.open = false; return; }
      panel.hidden = !ui.open;
      if (!ui.open) return;
      const pos = getPlayerPos?.();
      const inHQ = isInOffice?.() !== false;
      const far = (a) => !pos || !inHQ || Math.hypot(pos.x - a.x, pos.y - a.y) > 160;
      const d = st.delivery || {}, t = st.tree || {}, rw = st.rewards || {};
      const goal = Math.max(1, t.goal || 1), pct = Math.min(100, (t.contributions || 0) / goal * 100);
      const stageTxt = d.stage === 'done' ? 'Delivered today' : d.stage === 'carrying'
        ? `Carrying a parcel to ${esc(d.destination?.label)}` : `Parcel waiting at ${esc(d.pickup?.label)}`;
      const deliverBtn = d.stage === 'ready'
        ? `<button data-act="christmasPickup" ${far(d.pickup || ANCHORS.pickup) ? 'disabled' : ''}>Pick up</button>`
        : d.stage === 'carrying'
          ? `<button data-act="christmasDeliver" ${far(d.destination || ANCHORS.destination) ? 'disabled' : ''}>Deliver</button>`
          : '<span class="xm-done">Done</span>';
      const hint = d.stage === 'ready' ? `Walk to the ${esc(d.pickup?.label)}.` : d.stage === 'carrying' ? `Walk to the ${esc(d.destination?.label)}.` : 'A new parcel arrives tomorrow (UTC).';
      panel.innerHTML = `
        <header><div><h3>HQ Holiday Desk</h3><p>${esc(fmtDate(st.date))} · Season ${esc(st.seasonYear)} · ends Dec 26 UTC</p></div>
          <button class="xm-x" data-close aria-label="Close">×</button></header>
        <section><div class="xm-row"><div><b>Daily gift</b><small>+${esc(rw.daily)} coins, once per UTC day</small></div>
          ${st.dailyClaimed ? '<span class="xm-done">Claimed today</span>' : '<button data-act="christmasClaimDaily">Claim</button>'}</div></section>
        <section><div class="xm-row"><div><b>Parcel run</b><small>${stageTxt} · +${esc(rw.delivery)} coins</small></div>${deliverBtn}</div>
          ${d.stage !== 'done' ? `<p class="xm-hint">${hint}</p>` : ''}</section>
        <section><div class="xm-row"><div><b>Community tree</b><small>${esc(t.label || ANCHORS.tree.label)} · one free ornament each day</small></div>
          ${st.contributed ? '<span class="xm-done">Hung today</span>'
            : `<button data-act="christmasContribute" ${far(t.x != null ? t : ANCHORS.tree) ? 'disabled' : ''}>Hang ornament</button>`}</div>
          <div class="xm-bar" role="progressbar" aria-valuemin="0" aria-valuemax="${goal}" aria-valuenow="${t.contributions || 0}"><i style="width:${pct.toFixed(1)}%"></i></div>
          <p class="xm-hint">${esc(t.contributions ?? 0)} of ${esc(t.goal ?? 0)} ornaments hung by the office this season</p></section>
        <p class="xm-err" aria-live="polite">${esc(ui.error)}</p>`;
    };
    ui.render = render;
    btn.addEventListener('click', () => { ui.open = !ui.open; ui.error = ''; if (ui.open) request(); render(); });
    panel.addEventListener('click', (e) => {
      if (e.target.closest('[data-close]')) { ui.open = false; render(); return; }
      const b = e.target.closest('button[data-act]');
      if (!b || b.disabled) return;
      ui.error = ''; b.disabled = true;
      socket.emit(b.dataset.act); // no client inputs: server derives everything
    });
    socket.on('christmasState', (st) => {
      ui.state = st || null; ui.error = '';
      try { getScene?.()?._christmasCleanup?.setState?.(st); } catch (e) { /* scene gone */ }
      render();
    });
    socket.on('christmasError', ({ message } = {}) => { ui.error = message || 'Something went wrong.'; render(); });
    socket.on('christmasTreeChanged', request);
    socket.on('connect', request);
    socket.on('approved', request);
    socket.on('disconnect', () => { ui.state = null; render(); });
    window.addEventListener('seasonChanged', request);
    // Reconcile day rollover and invalidations dropped by server throttling.
    setInterval(() => { if (socket.connected && ui.state?.active) request(); }, 30000);
    // Re-evaluate proximity-enabled buttons while open (cheap DOM refresh).
    setInterval(() => { if (ui.open) render(); }, 700);
    if (socket.connected) request();
    return ui;
  }

  // TEST/DEV ONLY: render the overlay on a scene without touching the real
  // season, server state, rewards or UI. Requires an explicit opt-in global
  // so it cannot be triggered by players.
  function applyPreviewForTest(scene, state) {
    if (globalThis.__JPO_CHRISTMAS_PREVIEW_TEST__ !== true) throw new Error('Christmas preview is test-only');
    return mount(scene, { state, reduced: false });
  }

  window.ChristmasOffice = { ANCHORS, mount, initUI, applyPreviewForTest, current: (scene) => active.get(scene) || null };
})();
