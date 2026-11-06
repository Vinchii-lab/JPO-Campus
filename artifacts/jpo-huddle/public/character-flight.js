// Character wing flight (client). Purely visual elevation: the arcade body,
// sprite origin and every collider stay on the ground. At PRERENDER each
// flying actor (sprite + wearables + name/bubble/voice badge) is shifted up by
// its lift and restored at RENDER, so physics, movement packets and server
// validation never see the offset. A ground shadow stays at the feet.
(function () {
  'use strict';
  const MULT = Object.freeze({
    fairywings: 1.15, beewings: 1.25, batwings: 1.35, butterflywings: 1.45,
    snowflakewings: 1.55, angelwings: 1.65, devilwings: 1.65, jetpackwings: 1.85,
    goldenwings: 2, phoenixwings: 2.1,
  });
  const LIFT = 36;          // px of visual elevation at cruise
  const EASE_MS = 140;      // takeoff / landing time constant
  const STEER_MS = 130;     // flight acceleration / braking time constant
  const REASONS = {
    noWings: 'Equip wings to fly.', game: 'Flight is off during games.',
    seated: 'Stand up to fly.', activity: 'Finish what you are doing first.',
    travel: 'Landed for travel.', disabled: 'Flight is unavailable here.',
  };

  let socket = null, opts = {};
  const flying = Object.create(null);      // id -> boolean (authoritative)
  const multOf = Object.create(null);      // id -> server multiplier
  let pendingUntil = 0, pendingWant = null, btn = null;

  const selfId = () => socket && socket.id;
  const wingsMult = (w) => MULT[String(w || '')] || 0;
  const selfWings = () => { try { return opts.getWings ? opts.getWings() : ''; } catch (e) { return ''; } };
  const isSelfFlying = () => !!flying[selfId()];
  const toast = (m) => { try { opts.toast && opts.toast(m); } catch (e) {} };

  function setFlying(id, value, mult) {
    if (!id) return;
    if (value) flying[id] = true; else delete flying[id];
    if (Number.isFinite(mult) && mult > 0) multOf[id] = mult; else if (!value) delete multOf[id];
    if (id === selfId()) refreshButton();
  }
  function absorb(p) {
    if (p && p.id && typeof p.flying === 'boolean') setFlying(p.id, p.flying, Number(p.multiplier));
  }

  function selfMultiplier() {
    if (!isSelfFlying()) return 1;
    const m = Number(multOf[selfId()]);
    return Number.isFinite(m) && m > 0 ? m : (wingsMult(selfWings()) || 1);
  }

  function typing() {
    const a = document.activeElement;
    return !!a && (/^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName) || a.isContentEditable);
  }
  function blockReason() {
    try { if (opts.gameLock && opts.gameLock()) return 'game'; } catch (e) {}
    try { const r = opts.blocked && opts.blocked(); if (r) return typeof r === 'string' ? r : 'disabled'; } catch (e) {}
    return null;
  }

  function request(want) {
    if (!socket || !socket.connected) return false;
    pendingWant = want; pendingUntil = performance.now() + 2500;
    socket.emit('flightToggle', { flying: want });
    refreshButton();
    return true;
  }
  function toggle() {
    if (performance.now() < pendingUntil) return;
    if (isSelfFlying()) { land('manual'); return; }
    if (!wingsMult(selfWings())) { toast(REASONS.noWings); return; }
    const r = blockReason();
    if (r) { toast(REASONS[r] || REASONS.disabled); return; }
    request(true);
  }
  // Proactive landing: drop the local multiplier immediately so a reliable
  // seat/travel packet is never sent at flight speed; the server agrees.
  function land(reason) {
    if (!isSelfFlying()) return false;
    setFlying(selfId(), false);
    request(false);
    pendingUntil = 0;  // landing never blocks re-toggle once acknowledged
    void reason;
    return true;
  }

  function refreshButton() {
    if (!btn) btn = document.getElementById('touch-fly');
    if (!btn) return;
    const has = !!wingsMult(selfWings());
    btn.classList.toggle('has-wings', has || isSelfFlying());
    const pend = performance.now() < pendingUntil;
    btn.classList.toggle('pending', pend);
    btn.classList.toggle('active', isSelfFlying());
    const label = isSelfFlying() ? 'Land' : 'Fly';
    if (btn.textContent !== label) btn.textContent = label;
    btn.setAttribute('aria-pressed', isSelfFlying() ? 'true' : 'false');
  }

  function init(sock, options) {
    if (socket) return;
    socket = sock; opts = options || {};
    socket.on('flightState', (s) => {
      if (!s || !s.id) return;
      const mine = s.id === selfId();
      setFlying(s.id, !!s.flying, Number(s.multiplier));
      if (mine) {
        const denied = pendingWant === true && !s.flying;
        pendingUntil = 0; pendingWant = null;
        if (s.reason && (denied || !s.flying)) toast(REASONS[s.reason] || String(s.reason));
        refreshButton();
      }
    });
    socket.on('currentPlayers', (all) => {
      if (!all || typeof all !== 'object') return;
      for (const id in all) { const p = all[id]; if (p && typeof p.flying === 'boolean') setFlying(id, p.flying, Number(p.multiplier)); }
      for (const id in flying) if (!all[id] && id !== selfId()) setFlying(id, false);
    });
    socket.on('playerJoined', absorb);
    socket.on('playerMoved', absorb);
    socket.on('approved', (p) => {
      // A fresh authenticated session always starts grounded, even when the
      // page/socket survived a sign-out/sign-in without a transport drop.
      setFlying(selfId(), p?.flying === true, Number(p?.multiplier));
      pendingUntil = 0; pendingWant = null;
    });
    socket.on('playerMoveCorrection', (p) => { if (p && typeof p.flying === 'boolean') setFlying(selfId(), p.flying, Number(p.multiplier)); });
    socket.on('playerLeft', (id) => setFlying(id, false));
    socket.on('disconnect', () => {
      for (const id in flying) delete flying[id];
      for (const id in multOf) delete multOf[id];
      pendingUntil = 0; pendingWant = null; refreshButton();
    });
    document.addEventListener('keydown', (e) => {
      if (e.code !== 'Space' && e.key !== ' ') return;
      if (e.repeat || typing()) return;
      // Games (QuickDraw/Pool/rounds) and open menus keep Space for themselves.
      if (blockReason()) return;
      if (!opts.ready || !opts.ready()) return;
      e.preventDefault();
      toggle();
    });
    const b = document.getElementById('touch-fly');
    if (b) b.addEventListener('pointerdown', (e) => { e.preventDefault(); e.stopPropagation(); toggle(); });
    setInterval(refreshButton, 400);
    refreshButton();
  }

  // Exponential approach from previous to target velocity (same magnitude
  // cap as the target, so the server's per-tick budget is never exceeded).
  function steer(prev, target, delta) {
    if (!isSelfFlying() || !prev) return target;
    const k = 1 - Math.exp(-Math.max(0, delta) / STEER_MS);
    let x = prev.x + (target.x - prev.x) * k, y = prev.y + (target.y - prev.y) * k;
    const cap = Math.hypot(target.x, target.y) || Math.hypot(prev.x, prev.y);
    const m = Math.hypot(x, y);
    if (m > cap && m > 0) { x *= cap / m; y *= cap / m; }
    if (!target.x && !target.y && m < 4) { x = 0; y = 0; }
    return { x, y };
  }

  // ── Scene presentation ────────────────────────────────────────────────
  function attachScene(scene, getActors, cfg) {
    if (!scene || scene._jpoFlight) return;
    const conf = Object.assign({ bodyDy: 27, dirStart: { down: 0 } }, cfg || {});
    const states = new Map();
    const applied = [];
    let clock = 0;

    const drop = (st) => {
      if (st.shadow) st.shadow.destroy();
      if (st.thrust) st.thrust.destroy();
      if (st.wings && st.wings.active) setFlap(scene, st.wings, 1);
      st.shadow = st.thrust = null;
    };
    const pre = () => {
      if (!scene.sys || !scene.sys.isActive()) return;
      const dt = Math.min(100, (scene.game && scene.game.loop && scene.game.loop.delta) || 16);
      clock += dt;
      let actors = [];
      try { actors = getActors() || []; } catch (e) { actors = []; }
      // Self safety nets: wings removed or a game lock started.
      if (isSelfFlying() && (!wingsMult(selfWings()) || (opts.gameLock && opts.gameLock()))) land('lock');
      const seen = new Set();
      for (const a of actors) {
        if (!a || !a.id || !a.sprite || !a.sprite.active) continue;
        seen.add(a.id);
        let st = states.get(a.id);
        if (!st) { st = { lift: 0, shadow: null, thrust: null, wings: null, phase: Math.random() * 6 }; states.set(a.id, st); }
        const on = !!flying[a.id] && !a.seated;
        st.lift += ((on ? LIFT : 0) - st.lift) * (1 - Math.exp(-dt / EASE_MS));
        if (!on && st.lift < 0.4) { st.lift = 0; if (st.shadow) drop(st); continue; }
        const sp = a.sprite;
        const off = st.lift + Math.sin(clock / 260 + st.phase) * 2.2 * (st.lift / LIFT);
        // Dangling feet: hold the standing frame (no run cycle) while airborne.
        if (on && a.texKey && scene.textures.exists(a.texKey)) {
          if (sp.anims && sp.anims.isPlaying) sp.anims.stop();
          if (sp.anims) sp.anims.currentAnim = null;   // lets walk replay cleanly after landing
          const fr = conf.dirStart[a.dir] ?? 0;
          if (sp.texture.key !== a.texKey || Number(sp.frame.name) !== fr) sp.setTexture(a.texKey, fr);
          sp.setFlipX(false);
        }
        // Ground shadow (unshifted, at the collision feet).
        if (!st.shadow) st.shadow = scene.add.ellipse(sp.x, sp.y, 36, 12, 0x101217, 0.55);
        const r = st.lift / LIFT;
        st.shadow.setPosition(sp.x, sp.y + conf.bodyDy + 4)
          .setScale(1 - 0.3 * r, 1 - 0.25 * r).setAlpha(0.55 + 0.10 * (1 - r))
          .setVisible(sp.visible).setDepth(sp.depth);
        const wings = a.wings && a.wings.active ? a.wings : null;
        scene.children.moveBelow(st.shadow, wings || sp);
        if (wings !== st.wings) { if (st.wings && st.wings.active) setFlap(scene, st.wings, 1); st.wings = wings; }
        if (wings) setFlap(scene, wings, a.wingsId === 'jetpackwings' ? 0.6 : (on ? 2.6 : 1.4));
        // Jetpack thrust.
        if (a.wingsId === 'jetpackwings' && wings && wings.visible && sp.visible) {
          if (!st.thrust) st.thrust = scene.add.graphics();
          const g = st.thrust.clear();
          const side = a.dir === 'left' || a.dir === 'right';
          const nozzles = side ? [wings.x] : [wings.x - 9, wings.x + 9];
          const flick = 0.75 + 0.25 * Math.sin(clock / 35 + st.phase);
          const len = (8 + 10 * r) * flick, y0 = wings.y - off + 9;
          for (const nx of nozzles) {
            g.fillStyle(0xff8a3d, 0.85).fillTriangle(nx - 3, y0, nx + 3, y0, nx, y0 + len);
            g.fillStyle(0xfff1b8, 0.95).fillTriangle(nx - 1.5, y0, nx + 1.5, y0, nx, y0 + len * 0.55);
          }
          g.setDepth(sp.depth);
          scene.children.moveBelow(g, wings);
        } else if (st.thrust) { st.thrust.destroy(); st.thrust = null; }
        // Elevate the body and everything that rides on it.
        const objs = [sp].concat(a.parts || []);
        for (const o of objs) {
          if (!o || !o.active || typeof o.y !== 'number') continue;
          applied.push(o, o.y); o.y -= off;
        }
      }
      for (const [id, st] of states) if (!seen.has(id)) { drop(st); states.delete(id); }
    };
    const post = () => {
      for (let i = 0; i < applied.length; i += 2) {
        const o = applied[i];
        if (o && typeof o.y === 'number') o.y = applied[i + 1];
      }
      applied.length = 0;
    };
    const detach = () => {
      post();
      scene.events.off('prerender', pre); scene.events.off('render', post);
      for (const st of states.values()) drop(st);
      states.clear();
      scene._jpoFlight = null;
    };
    scene.events.on('prerender', pre);
    scene.events.on('render', post);
    scene.events.once('shutdown', detach);
    scene.events.once('destroy', detach);
    scene._jpoFlight = { detach };
  }

  function setFlap(scene, img, ts) {
    const tw = scene.tweens.getTweensOf(img);
    for (const t of tw) if (t.timeScale !== ts) t.timeScale = ts;
  }

  window.JpoCharacterFlight = {
    MULT, init, attachScene, toggle, land, steer, selfMultiplier,
    isFlying: (id) => !!flying[id], isSelfFlying, wingsMultiplier: wingsMult,
  };
})();
