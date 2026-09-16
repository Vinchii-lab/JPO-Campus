// Shared city / home presentation. Server transitions, permissions, placement,
// and movement validation remain authoritative in server.js / neighborhood.mjs.
window.initNeighborhoodUI = function(socket, getGlobals) {
  if (document.getElementById('neighborhood-ui')) return;

  const ui = document.createElement('div');
  ui.id = 'neighborhood-ui';
  // This is a location plaque, deliberately not a travel menu.
  ui.innerHTML = '<div id="neighborhood-nav"><span id="neighborhood-title">JPO HQ</span><button id="neighborhood-panel-toggle" type="button" aria-controls="home-panel shop-panel" hidden>Hide panel</button></div>' +
    '<div id="home-panel" hidden></div><div id="placement-controls" style="position:fixed; bottom:var(--neighborhood-hud-bottom, 60px); left:50%; transform:translateX(-50%); z-index:300;" hidden></div>';
  document.body.appendChild(ui);

  const title = ui.querySelector('#neighborhood-title');
  const homePanel = ui.querySelector('#home-panel');
  let homeState = null;
  let furnitureCatalog = {};
  let showroomDemos = [];
  let cashierOpen = false;
  let cashierMenu = null;
  let activeCashier = null;
  let nearbyCashier = null;
  let cashierBubbleFrame = 0;
  const cancelCashierBubbleFrame = () => {
    if (!cashierBubbleFrame) return;
    cancelAnimationFrame(cashierBubbleFrame);
    cashierBubbleFrame = 0;
  };
  const scheduleCashierBubblePosition = () => {
    if (cashierBubbleFrame) return;
    cashierBubbleFrame = requestAnimationFrame(() => {
      cashierBubbleFrame = 0;
      updateCashierBubblePosition();
    });
  };
  const updateCashierBubblePosition = () => {
    if (!cashierOpen || !activeCashier) return;
    const panel = document.getElementById('shop-panel');
    const game = window._phaserGame;
    const scene = window._neighborhoodScene;
    const canvas = game?.canvas;
    const camera = scene?.cameras?.main;
    const entry = scene?.cashierNpcs?.find((candidate) => candidate.id === activeCashier.id);
    const sprite = entry?.sprite;
    if (!panel || !canvas || !camera || !sprite) return;
    const bounds = sprite.getBounds?.();
    const displayHeight = Number(sprite.displayHeight) || Number(bounds?.height) || 72;
    // Cashier sprites are centered on their feet/body. The head anchor stays
    // tied to the authored sprite bounds as scale/zoom changes, rather than a
    // second hard-coded screen coordinate.
    const headY = Number.isFinite(Number(bounds?.top))
      ? Number(bounds.top) + displayHeight * 0.2
      : Number(sprite.y) - displayHeight * 0.3;
    const result = window.JpoCashierSpeechBubble?.position?.(panel, {
      anchor: { x: Number(sprite.x), y: headY },
      camera,
      canvas,
      canvasRect: canvas.getBoundingClientRect(),
      canvasWidth: scene.scale?.width || camera.width || canvas.width,
      canvasHeight: scene.scale?.height || camera.height || canvas.height,
      onOffscreen: closeCashier,
    });
    if (result?.offscreen) closeCashier();
  };
  window.jpoIsCashierOpen = () => cashierOpen;
  document.addEventListener('keydown', (event) => {
    if (!cashierOpen || event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    closeCashier();
  }, true);
  let selectedInstance = null;
  let selectedRotation = 0;
  let selectedZone = 'indoor';
  let editorOpen = false;
  // Bridge for bottom inventory hotbar
  window.JpoNeighborhood = window.JpoNeighborhood || {};
  window.JpoNeighborhood.canPlaceFurniture = () => {
    const email = typeof globals === 'function' ? globals()._playerEmail : (window.globals ? window.globals()._playerEmail : null);
    if (!email || !homeState?.canEdit) return false;
    if (String(homeState.ownerEmail).trim().toLowerCase() !== String(email).trim().toLowerCase()) return false;
    return currentLocation === 'neighborhood' || currentLocation === 'home:' + email;
  };
  window.JpoNeighborhood.placeFurniture = (id) => {
    if (!window.JpoNeighborhood.canPlaceFurniture()) {
      toast("You can only place furniture in your own home or yard.");
      return;
    }
    const inv = homeState?.inventory || [];
    if (!inv.some(i => String(i.id) === String(id))) {
      toast("That item is no longer in your unplaced inventory.");
      return;
    }
    teardownPlacement();
    selectedInstance = id;
    selectedRotation = 0;
    selectedZone = currentLocation === 'neighborhood' ? 'yard' : 'indoor';
    editorOpen = true;
    toast('Click a valid spot to place.');
    if (typeof renderHome === 'function') renderHome();
  };

  // Store is an instance operation, not a layout replacement. Keep a small
  // client-side in-flight set so a double-click cannot submit the same stale
  // row twice while the authoritative snapshot is on its way back.
  const pendingReturnIds = new Set();
  let currentLocation = 'office';
  // The inventory hotbar can initialize after a map payload during a
  // reconnect. Expose this read-only location context rather than duplicating
  // scene-key inference or mutating global inventory state.
  window.JpoNeighborhood.getCurrentLocation = () => currentLocation;
  let panelsCollapsed = false;
  try { panelsCollapsed = localStorage.getItem('jpo-neighborhood-panels-collapsed') === 'true'; } catch (_) {}
  const panelToggle = ui.querySelector('#neighborhood-panel-toggle');
  function syncPanelControls() {
    ui.classList.toggle('panels-collapsed', panelsCollapsed);
    panelToggle.hidden = !(currentLocation === 'neighborhood' || currentLocation.startsWith('home:'));
    panelToggle.textContent = panelsCollapsed ? 'Show panel' : 'Hide panel';
    panelToggle.setAttribute('aria-expanded', String(!panelsCollapsed));
  }
  function setPanelsCollapsed(collapsed) {
    panelsCollapsed = collapsed;
    try { localStorage.setItem('jpo-neighborhood-panels-collapsed', String(collapsed)); } catch (_) {}
    syncPanelControls();
  }
  panelToggle.onclick = () => setPanelsCollapsed(!panelsCollapsed);
  syncPanelControls();
  let directory = [];
  let nearbyConstructionLot = null;
  let directoryRequestId = 0;
  let activeDirectoryRequestId = 0;
  // The owner invite picker is backed by a narrow server query rather than
  // the admin/office roster cache. Keep its request generation separate from
  // the street-directory request so a delayed response cannot populate a
  // different home editor.
  let homePeople = [];
  let homePeopleLoaded = false;
  let homePeopleRequestId = 0;
  let activeHomePeopleRequestId = 0;
  // A socket result can arrive while the prior map's cosmetic fade is still
  // pending. Keep one presentation generation and timer: an old completion
  // must never stop/restart the scene selected by a newer completion.
  let sceneTransitionGeneration = 0;
  let lastServerTransitionSequence = 0;
  socket.on('disconnect', () => {
    lastServerTransitionSequence = 0;
    pendingReturnIds.clear();
  });
  let sceneTransitionTimer = null;
  let sceneReadinessWait = null;
  const sceneCreateEvent = Phaser.Scenes?.Events?.CREATE || 'create';
  const sceneWakeEvent = Phaser.Scenes?.Events?.WAKE || 'wake';
  const cancelSceneReadinessWait = () => {
    sceneReadinessWait?.cancel?.();
    sceneReadinessWait = null;
  };
  const sceneRuntimeReady = (scene, location) => {
    if (!scene?.cameras?.main || !scene.player) return false;
    if (location === 'office') {
      return !!scene.cursors && !!scene.wasd;
    }
    return !!scene.keys && !!scene.wasd && !!scene.keyE && !!scene.keyShift && !!scene.interactHint;
  };
  const waitForSceneReady = (scene, location, generation, eventName, waitForEvent, apply) => {
    if (!scene) throw new Error('Cannot transition without a target scene');
    const events = scene.events;
    if (waitForEvent && !events?.on) throw new Error('Target scene has no lifecycle event emitter');
    let eventSeen = !waitForEvent;
    let cancelled = false;
    const onLifecycle = () => {
      eventSeen = true;
      attempt();
    };
    const cleanup = () => {
      if (cancelled) return;
      cancelled = true;
      if (waitForEvent) events.off?.(eventName, onLifecycle);
      if (sceneReadinessWait?.cancel === cancel) sceneReadinessWait = null;
    };
    const cancel = () => cleanup();
    const attempt = () => {
      if (cancelled) return;
      if (generation !== sceneTransitionGeneration) {
        cleanup();
        return;
      }
      if (!eventSeen || !sceneRuntimeReady(scene, location)) return;
      cleanup();
      apply(scene);
    };
    // Keep one listener until the target has all runtime objects. A stale
    // queued restart can emit CREATE while its create() intentionally returns
    // unready; the next queued CREATE must still be observable. cleanup()
    // removes this single listener on apply or supersession.
    if (waitForEvent) events.on(eventName, onLifecycle);
    sceneReadinessWait = { cancel, tryApply: attempt };
    // An already-active target needs no queued lifecycle operation. Calling
    // this after installing the listener also closes the small race where a
    // mock/alternate SceneManager emits synchronously from start/restart.
    attempt();
    return sceneReadinessWait;
  };
  // Player sprites, interior tiles, and the verified furniture singles are
  // authored on the same 16px grid. Keep their one shared integer scale here;
  // exterior buildings intentionally use their separate, larger source art.
  const INTERIOR_ART_SCALE = 3;
  // Arcade resolves static-body contact after floating-point integration. A
  // half-pixel client-only margin prevents exact server contact from visually
  // penetrating for one frame; the server's ACTOR_FOOT_RADIUS is unchanged.
  const COLLISION_SAFETY_MARGIN = 0.5;
  // Keep browser placement and the home threshold in lockstep with
  // neighborhood.mjs (24x18 cells at 48px). Room art itself is supplied by
  // the interior design layer; these constants only govern interaction.
  const HOME_GRID_WIDTH = 24;
  const HOME_GRID_HEIGHT = 18;
  const HOME_EXIT = { x: 528, y: 768, width: 96, height: 96 };
  // Outdoor ground and construction foundations must remain behind every
  // actor (local, remote, and pet). Characters use their world y as depth,
  // while the map's playable bounds keep their foot centre above this plane.
  const LOT_GROUND_DEPTH = 2;
  // Interior presentation uses one depth contract for authored room art,
  // placed furniture, and actors. Floor/background graphics are deliberately
  // below the y-sorted plane; all objects on that plane use their actual
  // floor-contact anchor rather than bitmap centres. A tiny front bias is
  // enough to split an occluding furniture base without changing movement or
  // persisted geometry.
  const INTERIOR_DEPTH = Object.freeze({
    BACKGROUND: -10000,
    WALL_BACK: -9000,
    SEATED_ACTOR_BIAS: 0.005,
    FRONT_BIAS: 0.01,
  });
  const finiteDepth = (value, fallback = 0) =>
    Number.isFinite(Number(value)) ? Number(value) : fallback;
  // A city transition includes this server-authoritative value so the personal
  // house is colored before the owner has entered its interior this session.
  let ownExteriorColor = 'teal';

  const globals = () => getGlobals() || {};
  const toast = (message) => globals().showToast?.(message);
  // The economy HUD is created by the base page and can change width/height
  // when its controls are shown. Keep this map-only plaque physically below
  // its measured footprint rather than competing for the top-right corner.
  const syncHudReservation = () => {
    const hud = document.getElementById('coin-hud');
    const compact = window.matchMedia?.('(max-width: 600px)').matches;
    const gutter = compact ? 8 : 14;
    const rect = hud && getComputedStyle(hud).display !== 'none' ? hud.getBoundingClientRect() : null;
    const fallbackTop = compact ? 52 : 60;
    const top = rect?.height ? Math.ceil(rect.bottom) + 10 : fallbackTop;
    ui.style.setProperty('--neighborhood-hud-gutter', gutter + 'px');
    ui.style.setProperty('--neighborhood-hud-bottom', Math.max(gutter, top) + 'px');
  };
  const scheduleHudReservation = () => requestAnimationFrame(syncHudReservation);
  const coinHud = document.getElementById('coin-hud');
  if (coinHud) {
    new ResizeObserver(scheduleHudReservation).observe(coinHud);
    new MutationObserver(scheduleHudReservation).observe(coinHud, {
      attributes: true, attributeFilter: ['class', 'style'],
    });
  }
  window.addEventListener('resize', scheduleHudReservation);
  window.addEventListener('resize', scheduleCashierBubblePosition);
  scheduleHudReservation();
  let officePortalRelease = true;
  let officePortalTransition = false;
  window.jpoBeginMapFade = function() {
    const game = window._phaserGame;
    const scene = game?.scene?.getScenes(true)?.find((candidate) =>
      candidate.scene.key === 'OfficeScene' || candidate.scene.key === 'NeighborhoodScene');
    const camera = scene?.cameras?.main;
    if (!scene || !camera || scene._portalFading) return;
    scene._portalFading = true;
    scene._portalFadeAt = performance.now();
    camera.fadeOut(220, 16, 22, 34);
  };
  // The gate lies on an existing, walkable western garden tile in JPO_HQ.tmj
  // (columns 4–5, rows 46–48). It is deliberately proximity-only: no action
  // key and no travel button can bypass the walk through the garden.
  window.jpoTryOfficePortal = function(player, dir, gate) {
    if (currentLocation !== 'office' || !player || !gate) return false;
    const inGate = player.x >= gate.x && player.x <= gate.x + gate.width &&
      player.y >= gate.y && player.y <= gate.y + gate.height;
    if (!inGate) { officePortalRelease = true; return false; }
    // The direct move packet can trail one visual frame. Require an interior
    // point so that normal 50ms packet latency still lands inside the server's
    // authoritative larger portal rather than correcting the player back.
    const inside = player.x >= gate.x + 16 && player.x <= gate.x + gate.width - 16 &&
      player.y >= gate.y + 12 && player.y <= gate.y + gate.height - 12;
    if (!inside || !officePortalRelease || officePortalTransition) return false;
    officePortalTransition = true;
    movement?.sendReliable('office', { x: player.x, y: player.y, dir: dir || 'left', anim: 'idle' });
    window.jpoBeginMapFade?.();
    travel('neighborhood');
    return true;
  };
  const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[char]);
  const isHome = () => currentLocation.startsWith('home:');
  const isResidentialBlock = () => currentLocation === 'neighborhood';
  const ownHome = () => homeState?.canEdit && homeState.ownerEmail === globals()._playerEmail ? homeState : null;
  const travel = (destination, options = {}) =>
    movement?.sendReliableEvent('locationTransition', currentLocation, { destination, ...options });
  const movement = window.JpoFocusedMovement?.create(socket, {
    onPause: () => {
      window._neighborhoodScene?._clearMovementTransport();
      window._gameScene?._clearMovementTransport();
    },
  });
  window._jpoMovementTransport = movement;
  const requestDirectory = () => {
    activeDirectoryRequestId = ++directoryRequestId;
    socket.emit('homeDirectoryRequest', { requestId: activeDirectoryRequestId });
  };
  const requestHomePeople = () => {
    activeHomePeopleRequestId = ++homePeopleRequestId;
    homePeopleLoaded = false;
    socket.emit('homePeopleRequest', { requestId: activeHomePeopleRequestId });
  };
  const hidePlacementControls = () => {
    const container = document.getElementById('placement-controls');
    if (!container) return;
    if (typeof window.JpoUIBuilder?.renderPlacementControls === 'function') {
      window.JpoUIBuilder.renderPlacementControls(container, { active: false });
    } else {
      container.hidden = true;
      container.innerHTML = '';
    }
  };
  const teardownPlacement = () => {
    selectedInstance = null;
    selectedRotation = 0;
    selectedZone = 'indoor';
    window._neighborhoodScene?._teardownPlacement?.();
    hidePlacementControls();
  };
  const normalizeFurnitureInstanceId = (value) =>
    typeof value === 'string' ? value.trim() : '';
  const reconcilePendingReturns = (state) => {
    if (!state || typeof state !== 'object') return;
    const placed = new Set([
      ...(Array.isArray(state.layout) ? state.layout : []),
      ...(Array.isArray(state.yard) ? state.yard : []),
    ].map((item) => String(item?.id || '')));
    const inventory = new Set((Array.isArray(state.inventory) ? state.inventory : [])
      .map((item) => String(item?.id || '')));
    for (const id of pendingReturnIds) {
      // A successful store removes the layout row and leaves the owned
      // instance in inventory. An older snapshot still containing the row
      // must not unlock the button or be treated as a success.
      if (!placed.has(id) && inventory.has(id)) pendingReturnIds.delete(id);
    }
  };
  const requestStore = (value) => {
    const instanceId = normalizeFurnitureInstanceId(value);
    const zone = isHome() ? 'indoor' : isResidentialBlock() ? 'yard' : null;
    const placed = zone === 'indoor' ? homeState?.layout : zone === 'yard' ? homeState?.yard : null;
    const playerEmail = String(globals()._playerEmail || '').trim().toLowerCase();
    if (!instanceId || !zone || !homeState?.canEdit ||
        String(homeState.ownerEmail || '').trim().toLowerCase() !== playerEmail) {
      toast('That furniture selection is no longer current.');
      return;
    }
    if (!Array.isArray(placed) || !placed.some((item) => String(item?.id) === instanceId)) {
      toast('That furniture is no longer placed here.');
      return;
    }
    if (pendingReturnIds.has(instanceId)) return;
    pendingReturnIds.add(instanceId);
    teardownPlacement();
    renderHome();
    // Deliberately send only the immutable instance id and let the server
    // delete that one owned row atomically. Never send a client-owned layout.
    socket.emit('homeLayoutReturn', { instanceId });
  };
  // Every full home state carries the existing server layout_revision. Keep
  // all ingress paths behind this one owner/revision gate: Store, purchase,
  // construction, color, and transition responses can otherwise arrive after
  // a newer Store snapshot and replace its inventory/layout arrays wholesale.
  const applyHomeState = (state) => {
    if (!state || typeof state !== 'object') return false;
    const expectedOwner = isHome()
      ? currentLocation.slice(5).trim().toLowerCase()
      : String(globals()._playerEmail || '').trim().toLowerCase();
    const snapshotOwner = String(state.ownerEmail || '').trim().toLowerCase();
    if (expectedOwner && snapshotOwner !== expectedOwner) return false;

    const incomingRevision = Number(state.revision);
    const currentOwner = String(homeState?.ownerEmail || '').trim().toLowerCase();
    const currentRevision = Number(homeState?.revision);
    const hasIncomingRevision = Number.isSafeInteger(incomingRevision);
    const hasCurrentRevision = Number.isSafeInteger(currentRevision);
    // Equal revisions are not ordered: a delayed full snapshot with the same
    // revision can still carry an older inventory/layout projection. Only a
    // strictly newer revision may replace state for the same owner.
    if (currentOwner && snapshotOwner && currentOwner === snapshotOwner) {
      if (!hasIncomingRevision || (hasCurrentRevision && incomingRevision <= currentRevision)) return false;
    } else if (hasCurrentRevision && !hasIncomingRevision) {
      return false;
    }
    reconcilePendingReturns(state);
    teardownPlacement();
    if (state.catalog && typeof state.catalog === 'object') furnitureCatalog = state.catalog;
    homeState = state;
    if (state.canEdit && state.exteriorColor) {
      ownExteriorColor = state.exteriorColor;
      window._neighborhoodScene?.setOwnHomeColor(ownExteriorColor);
    }
    window._neighborhoodScene?.renderFurniture(state);
    renderHome();
    return true;
  };
  window.jpoSetConstructionLot = (lot) => {
    const ownerEmail = lot?.ownerEmail || null;
    if ((nearbyConstructionLot?.ownerEmail || null) === ownerEmail) return;
    nearbyConstructionLot = lot || null;
    if (isResidentialBlock()) renderHome();
  };

  function constructionMarkup() {
    const owned = ownHome();
    const listedLot = directory.find((home) => home.ownerEmail === globals()._playerEmail);
    const construction = owned?.construction || listedLot?.construction;
    if (!listedLot || !construction) return '';
    const components = Array.isArray(construction.components) ? construction.components : [];
    const states = {
      floor: !!construction.floorBuilt,
      walls: !!construction.wallsBuilt,
      roof: !!construction.roofBuilt,
    };
    const next = components.find((component) => !states[component.id])?.id || null;
    const nearLot = nearbyConstructionLot?.ownerEmail === listedLot.ownerEmail;
    const stageName = construction.stage === 'complete' ? 'Complete' :
      construction.stage === 'walls' ? 'Walls raised' :
      construction.stage === 'floor' ? 'Foundation laid' : 'Empty lot';
    const steps = components.map((component) => {
      const built = states[component.id];
      const canBuy = nearLot && component.id === next;
      const status = built ? 'Built' : component.id === next ? 'Next' : 'Locked';
      return '<span class="home-item construction-step ' + (built ? 'built' : '') + '">' +
        '<span>' + escapeHtml(component.label) + ' · ' + Number(component.price).toLocaleString() +
        ' coins <small>' + status + '</small></span>' +
        '<button type="button" data-build="' + escapeHtml(component.id) + '"' +
        (canBuy ? '' : ' disabled') + '>' + (built ? 'Built' : component.id === next ? 'Build' : 'In order') + '</button></span>';
    }).join('');
    const archive = Number(owned?.archivedFurnitureCount || 0);
    return '<div class="home-section construction-panel">' +
      '<small>YOUR LOT · ' + stageName + '</small>' +
      '<small class="construction-copy">' + (nearLot
        ? 'You are at your lot sign. Components use coins and must be built in order.'
        : 'Walk to your own lot sign to unlock the next build control.') + '</small>' +
      steps +
      (construction.complete
        ? '<small class="construction-complete">Roof complete — your home door is open and all saved furnishings are active.</small>'
        : '<small class="construction-archive">Archived furnishings: ' + archive +
          '. Existing indoor and yard items are kept, not deleted, and return when the roof is complete.</small>') +
      '</div>';
  }

  function renderHome() {
    syncPanelControls();
    if (typeof window.JpoUIBuilder?.renderHomePanel !== 'function') return;
    window.JpoUIBuilder.renderHomePanel(homePanel, {
      isHome: isHome(),
      homeState: homeState,
      isResidentialBlock: isResidentialBlock(),
      directory: directory,
      constructionMarkup: constructionMarkup(),
      catalog: furnitureCatalog,
      selectedInstance: selectedInstance,
      pendingReturns: pendingReturnIds,
      editorOpen: editorOpen,
      people: homePeople,
      peopleLoaded: homePeopleLoaded,
      scheduleHudReservation: scheduleHudReservation,
      toggleEditor: () => { editorOpen = !editorOpen; renderHome(); },
      onSelect: (id, zone) => {
        // Replacing a selected item must release the previous lock, ghost, and
        // controls before the new item captures placement coordinates.
        teardownPlacement();
        selectedInstance = id;
        selectedRotation = 0;
        selectedZone = zone;
        editorOpen = true;
        toast('Click a valid spot to place.');
        renderHome();
      },
      onReturn: (id) => {
        requestStore(id);
      },
      onAccessSet: (mode) => socket.emit('homeAccessSet', { mode }),
      onInvite: (email) => socket.emit('homeInvite', { email }),
      onRevoke: (email) => socket.emit('homeInviteRevoke', { email }),
      onPeopleRequest: requestHomePeople,
      onBuild: (componentId) => socket.emit('homeConstructionPurchase', { componentId })
    });
  }

  function renderShop() {
    syncPanelControls();
    let panel = document.getElementById('shop-panel');
    if (!panel && (typeof currentLocation === 'string' && (currentLocation.endsWith('-shop') || ['cafe', 'diner', 'bakery', 'sushi'].includes(currentLocation)))) {
      panel = document.createElement('div');
      panel.id = 'shop-panel';
      ui.appendChild(panel);
    }
    if (panel) {
      if (typeof window.JpoUIBuilder?.renderShopPanel !== 'function') return;
      window.JpoUIBuilder.renderShopPanel(panel, {
        isShop: typeof currentLocation === 'string' && (currentLocation.endsWith('-shop') || ['cafe', 'diner', 'bakery', 'sushi'].includes(currentLocation)),
        location: currentLocation,
        catalog: furnitureCatalog,
        showroom: showroomDemos,
        cashierOpen,
        cashier: activeCashier,
        cashierMenu,
         positionBubble: scheduleCashierBubblePosition,
        onOpenMenu: () => {
          if (activeCashier?.id) socket.emit('cashierMenuRequest', { cashierId: activeCashier.id });
        },
        onGoodbye: () => closeCashier(),
        onBuy: (id, kind) => {
          if (!activeCashier?.id) return;
          if (kind === 'food') socket.emit('buyFood', {
            cashierId: activeCashier.id, station: activeCashier.id, item: id,
          });
          else socket.emit('homePurchase', { cashierId: activeCashier.id, furnitureId: id });
        },
      });
    }
  }

  function closeCashier() {
    cancelCashierBubbleFrame();
    cashierOpen = false;
    cashierMenu = null;
    activeCashier = null;
    renderShop();
  }

  function openCashier(cashier) {
    if (!cashier?.id || cashier.location !== currentLocation) return;
    nearbyCashier = cashier;
    if (cashierOpen && activeCashier?.id === cashier.id) return;
    if (panelsCollapsed) setPanelsCollapsed(false);
    activeCashier = cashier;
    cashierOpen = true;
    cashierMenu = null;
    renderShop();
    scheduleCashierBubblePosition();
    scheduleHudReservation();
  }

  window.jpoOpenCashier = openCashier;
  window.jpoCloseCashier = closeCashier;
  window.jpoSetNearbyCashier = (cashier) => {
    nearbyCashier = cashier || null;
    if (cashierOpen && (!nearbyCashier || nearbyCashier.id !== activeCashier?.id)) closeCashier();
    else if (cashierOpen) scheduleCashierBubblePosition();
  };

  window.initHouseColors?.(socket, () => ({
    get homeState() { return homeState; },
    get currentLocation() { return currentLocation; },
    get scene() { return window._neighborhoodScene; },
    toast,
    setHomeState(state) {
      applyHomeState(state);
    },
    rerenderHome: renderHome,
  }));

  socket.on('furnitureShowroom', (result) => {
    if (currentLocation !== 'furniture-shop' || result?.locationId !== 'furniture-shop') return;
    if (!result?.ok) {
      showroomDemos = [];
      if (result?.message) toast(result.message);
    } else {
      showroomDemos = Array.isArray(result.demos) ? result.demos : [];
    }
    window._neighborhoodScene?.setFurnitureShowroomDemos?.(showroomDemos);
    renderShop();
  });
  socket.on('cashierMenuResult', (result) => {
    if (!result?.ok) {
      if (result?.message) toast(result.message);
      if (result?.code === 'distance' || result?.code === 'cashier' || result?.code === 'location') closeCashier();
      return;
    }
    if (!cashierOpen || !activeCashier || result.cashierId !== activeCashier.id ||
        currentLocation !== result.location) return;
    cashierMenu = {
      kind: result.kind, title: result.title,
      items: Array.isArray(result.items) ? result.items : [],
    };
    renderShop();
    scheduleHudReservation();
  });
  socket.on('foodError', (result) => {
    if (cashierOpen && ['distance', 'cashier', 'location'].includes(result?.code)) closeCashier();
  });

  requestDirectory();
  socket.on('homeDirectory', (payload) => {
    // Ignore delayed directory replies. Street lots are canonical account
    // addresses and never depend on a pagination page.
    if (Number.isInteger(payload?.requestId) && payload.requestId !== activeDirectoryRequestId) return;
    if (payload?.catalog && typeof payload.catalog === 'object') {
      furnitureCatalog = payload.catalog;
    }
    directory = Array.isArray(payload) ? payload : (Array.isArray(payload?.homes) ? payload.homes : []);
    if (payload?.error) toast(payload.error);
    window._neighborhoodScene?.updateResidenceDirectory(directory);
    if (isResidentialBlock()) socket.emit('homeSnapshotRequest');
    renderHome();
  });
  socket.on('homeSnapshot', (state) => {
    applyHomeState(state);
  });
  socket.on('homePeopleResult', (result) => {
    if (Number.isSafeInteger(result?.requestId) &&
        result.requestId !== activeHomePeopleRequestId) return;
    if (!result?.ok) {
      homePeople = [];
      homePeopleLoaded = false;
      if (result?.message) toast(result.message);
      return;
    }
    homePeople = Array.isArray(result.people) ? result.people : [];
    homePeopleLoaded = true;
    if (isHome() && homeState?.canEdit) renderHome();
  });
  socket.on('homePurchaseResult', (result) => {
    if (!result?.ok && ['distance', 'cashier', 'location'].includes(result?.code)) closeCashier();
    let refreshRequested = false;
    if (result?.home) {
      const applied = applyHomeState(result.home);
      const represented = result.item && [
        ...(Array.isArray(result.home.inventory) ? result.home.inventory : []),
        ...(Array.isArray(result.home.layout) ? result.home.layout : []),
        ...(Array.isArray(result.home.yard) ? result.home.yard : []),
      ].some((entry) => String(entry?.id) === String(result.item.id));
      if (result.ok && result.item && (!applied || !represented)) {
        if (isHome() || isResidentialBlock()) {
          socket.emit('homeSnapshotRequest');
          refreshRequested = true;
        }
      }
    } else if (result?.ok && result.item) {
      // A purchase response without a full snapshot is not allowed to mutate
      // the visible inventory optimistically. The server bumped revision in
      // the purchase transaction; request that authoritative newer snapshot.
      if (isHome() || isResidentialBlock()) {
        socket.emit('homeSnapshotRequest');
        refreshRequested = true;
      }
    }
    teardownPlacement();
    if (result?.message && !result?.ok) toast(result.message);
    else if (result?.ok) {
      const name = furnitureCatalog[result.item?.furnitureId]?.name || 'Furniture';
      toast(name + ' purchased — added to your home inventory.');
      if (result.refreshPending && !refreshRequested && (isHome() || isResidentialBlock())) {
        socket.emit('homeSnapshotRequest');
      }
    }
    if (isHome()) renderHome();
  });
  socket.on('homeConstructionResult', (result) => {
    if (result?.home) {
      const applied = applyHomeState(result.home);
      if (result.ok && !applied && (isHome() || isResidentialBlock())) {
        socket.emit('homeSnapshotRequest');
      }
    } else teardownPlacement();
    if (result?.message) toast(result.message);
    if (isResidentialBlock()) renderHome();
  });
  socket.on('homeActionResult', (result) => {
    // A mutation always ends its placement gesture. This prevents a stale
    // preview from being re-used after either a server rejection or a move.
    teardownPlacement();
    const resultId = normalizeFurnitureInstanceId(result?.instanceId);
    if (resultId) pendingReturnIds.delete(resultId);
    if (isHome() || isResidentialBlock()) renderHome();
    if (result?.message) toast(result.message);
    if (result?.ok && result?.refreshPending && (isHome() || isResidentialBlock())) {
      socket.emit('homeSnapshotRequest');
    }
  });
  socket.on('homeAccessResult', (result) => {
    teardownPlacement();
    if (result?.ok && homeState) {
      homeState.accessMode = result.mode;
      renderHome();
    }
    if (result?.message) toast(result.message);
  });
  socket.on('homeInviteResult', (result) => {
    teardownPlacement();
    toast(result?.ok ? (result.revoked ? 'Invitation revoked.' : 'Invitation saved.') : (result?.message || 'Could not update invitation.'));
    if (result?.ok && isHome()) socket.emit('homeSnapshotRequest');
  });
  // This deliberately carries no owner/color metadata. Refreshing through the
  // normal server-filtered directory keeps private homes private while still
  // updating visible street roofs in real time.
  socket.on('homeColorChanged', (payload) => {
    if (payload?.refreshDirectory && isResidentialBlock()) requestDirectory();
  });
  socket.on('homeStreetChanged', (payload) => {
    if (payload?.refreshDirectory && isResidentialBlock()) requestDirectory();
  });
  socket.on('homeEjected', (result) => {
    teardownPlacement();
    toast(result?.message || 'You left the home.');
  });
  socket.on('furnitureInteractionResult', (result) => {
    const scene = window._neighborhoodScene;
    if (!scene?.scene?.isActive?.() || !scene._neighborhoodReady) return;
    scene._activityPending = false;
    if (result?.ok && result.phase === 'start' && result.activity) {
      scene._setLocalActivity(result.activity, result);
    } else if (result?.ok && result.phase === 'stop') {
      scene._setLocalActivity(null, result);
    } else if (!result?.ok && result?.message) {
      toast(result.message);
    }
  });
  socket.on('furnitureDemoInteractionResult', (result) => {
    const scene = window._neighborhoodScene;
    if (!scene?.scene?.isActive?.() || !scene._neighborhoodReady) return;
    scene._activityPending = false;
    if (result?.ok && result.phase === 'start' && result.activity) {
      scene._setLocalActivity(result.activity, result);
    } else if (result?.ok && result.phase === 'stop') {
      scene._setLocalActivity(null, result);
    } else if (!result?.ok && result?.message) {
      toast(result.message);
    }
  });
  socket.on('parkSeatState', (payload) => {
    const scene = window._neighborhoodScene;
    if (scene?.scene?.isActive?.() && scene._neighborhoodReady) scene._setParkSeatState(payload);
  });
  socket.on('furnitureActivity', (payload) => {
    const scene = window._neighborhoodScene;
    if (!scene || !scene._neighborhoodReady || !payload?.id) return;
    if (payload.id === socket.id) {
      if (payload.phase === 'start' && payload.action) {
        scene._setLocalActivity({
          showroom: payload.showroom === true,
          instanceId: payload.instanceId, furnitureId: payload.furnitureId,
          action: payload.action, effect: payload.effect,
          effectState: payload.effectState, toggle: !!payload.toggle,
          orientation: payload.orientation, stand: payload.stand || null,
          x: payload.x, y: payload.y, dir: payload.dir,
        }, payload);
      } else if (payload.phase === 'stop') {
        scene._setLocalActivity(null, payload);
      }
      return;
    }
    const remote = scene.remotes[payload.id];
    if (!remote) return;
    if (payload.phase === 'start' && payload.action) {
      remote.lastDir = payload.dir || remote.lastDir || 'down';
      if (Number.isFinite(Number(payload.x)) && Number.isFinite(Number(payload.y))) {
        remote.sprite.setPosition(Number(payload.x), Number(payload.y));
        remote.nameTag?.setPosition(Number(payload.x), Number(payload.y) - 40);
      }
      remote.activity = {
        showroom: payload.showroom === true,
        instanceId: payload.instanceId, furnitureId: payload.furnitureId,
        action: payload.action, effect: payload.effect, orientation: payload.orientation,
        effectState: payload.effectState, toggle: !!payload.toggle,
        stand: payload.stand || null, x: payload.x, y: payload.y, dir: payload.dir,
      };
      scene._applyActivityPose(remote, remote.activity, remote.lastDir);
      scene._setActorDepth(
        remote.sprite,
        scene._activityDepthAnchor(remote, remote.sprite.y),
        scene._activityDepthBias(remote),
      );
      scene._positionPresentation(remote, remote.sprite.x, remote.sprite.y, remote.lastDir);
    } else if (payload.phase === 'stop') {
        if (Number.isFinite(Number(payload.x)) && Number.isFinite(Number(payload.y))) {
          remote.sprite.setPosition(Number(payload.x), Number(payload.y));
          remote.nameTag?.setPosition(Number(payload.x), Number(payload.y) - 40);
        }
      remote.activity = null;
        remote.lastDir = payload.dir || remote.lastDir || 'down';
        scene._applyActivityPose(remote, null, remote.lastDir);
        scene._setActorDepth(remote.sprite, remote.sprite.y);
        scene._positionPresentation(remote, remote.sprite.x, remote.sprite.y, remote.lastDir);
    }
  });

  class NeighborhoodScene extends Phaser.Scene {
    constructor() {
      super('NeighborhoodScene');
      this.remotes = {};
      this.furniture = [];
      this.showroomFurniture = [];
      // Keep showroom interaction records outside Phaser's DataManager. Phaser
      // destroys/recreates display objects during scene transitions and a
      // stale sprite can therefore lose the action metadata even while the
      // authoritative seven-demo payload is still current.
      this.showroomInteractions = new Map();
      this._showroomFurnitureLoadPending = false;
      this.cashierNpcs = [];
      this.nearbyCashier = null;
      this._lastCorrectionSeq = -1;
      this._neighborhoodReady = false;
    }

    _resetTransientTravel() {
      // Phaser reuses this Scene instance for Willow → Plaza. A transition
      // request belongs to the map we are leaving, never the next map: leaving
      // it true makes update() intentionally zero all movement forever.
      this._portalTravelGeneration = (this._portalTravelGeneration || 0) + 1;
      clearTimeout(this._portalMoveTimer);
      clearTimeout(this._portalTravelTimer);
      this._portalMoveTimer = this._portalTravelTimer = null;
      this.transitionRequested = false;
      this._portalFading = false;
      this._portalFadeAt = 0;
      this.portalRelease = true;
      this.lastSend = 0;
      movement?.clear();
      // Arcade shuts down before our scene listener; the sprite can still
      // exist after its body is destroyed. Do not call its body wrapper.
      this.player?.body?.setVelocity(0, 0);
      this.sitting = false;
      this.activity = null;
      this._activityPending = false;
      this.staticSeatState = null;
      this._parkSeatPending = null;
      this._parkSeatPendingAt = 0;
      this._parkSeatExitTarget = null;
      this._parkSeatSitTarget = null;
    }

    _clearMovementTransport() {
      movement?.clear();
      this.lastSend = 0;
      this.player?.body?.setVelocity(0, 0);
    }

    _removePlacementInput() {
      if (this._placementMoveHandler) this.input.off('pointermove', this._placementMoveHandler);
      if (this._placementDownHandler) this.input.off('pointerdown', this._placementDownHandler);
      this._placementMoveHandler = this._placementDownHandler = null;
    }

    _teardownPlacement() {
      this._placementLocked = false;
      this._lockedGridX = this._lockedGridY = null;
      this._clearGhost();
      const container = document.getElementById('placement-controls');
      if (!container) return;
      if (typeof window.JpoUIBuilder?.renderPlacementControls === 'function') {
        window.JpoUIBuilder.renderPlacementControls(container, { active: false });
      } else {
        container.hidden = true;
        container.innerHTML = '';
      }
    }

    // These bridge methods deliberately call the live OfficeScene implementation
    // with this scene as its receiver. The helper methods it calls are bridged too,
    // retaining the established avatar/wearable/pet formats and signatures.
    _office(method, ...args) {
      const source = window._gameScene;
      return typeof source?.[method] === 'function' ? source[method].call(this, ...args) : null;
    }
    _makeNameTag(...args) { return this._office('_makeNameTag', ...args); }
    _bakeWearOnCanvas(...args) { return this._office('_bakeWearOnCanvas', ...args); }
    _createDirAnims(...args) { return this._office('_createDirAnims', ...args); }
    _placeWearable(...args) { return this._office('_placeWearable', ...args); }
    _makeCosmetic(...args) { return this._office('_makeCosmetic', ...args); }
    _makePet(...args) { return this._office('_makePet', ...args); }
    _placePetAcc(...args) { return this._office('_placePetAcc', ...args); }
    _destroyPet(...args) { return this._office('_destroyPet', ...args); }
    _killPetFx(...args) { return this._office('_killPetFx', ...args); }
    _trackPetFx(...args) { return this._office('_trackPetFx', ...args); }
    _petTrick(...args) { return this._office('_petTrick', ...args); }
    _stepPet(...args) { return this._office('_stepPet', ...args); }

    preload() {
      window.JpoInteriors.preload(this);
      window.JpoPlazaExteriors.preload(this);
      // Furniture art is owned by the catalog renderer. Unlike the former
      // hand-maintained six-item list this covers every server catalog row and
      // uses the definition's real frame dimensions for animated sheets.
      window.HomeFurnitureRenderer?.preload?.(this, furnitureCatalog);
      ['home_floor', 'shop_floor', 'home_wall', 'shop_wall'].forEach((id) => {
        this.load.image('int_' + id, '/assets/neighborhood/' + id.replace('_', '-') + '-16.png');
      });
      ['kitchen_counter', 'kitchen_sink', 'kitchen_stove', 'kitchen_fridge', 'bathroom_toilet', 'bathroom_sink', 'bedroom_bed'].forEach((id) => {
        this.load.image('int_' + id, '/assets/neighborhood/interiors/' + id + '.png');
      });
      ['house', 'shop', 'tree', 'bench', 'lamp'].forEach((id) => {
        this.load.image('ext_' + id, '/assets/neighborhood/exterior/' + id + '.png');
      });
      ['bunting', 'balloons', 'flowers'].forEach((id) => {
        this.load.image('dec_' + id, '/assets/neighborhood/city/' + id + '.png');
      });
      // The base house remains the normal Phaser asset; this hook documents
      // that roof variants are prepared from it after image decode in create.
      window.jpoHouseColors?.preloadHouseColors(this);
    }

    _setNeighborhoodTextureFilters() {
      // Phaser can otherwise smooth standalone PNGs on some renderers. Limit
      // this to the supplied furniture/interior assets; house-color textures
      // keep their own preparation path and are intentionally untouched.
      const nearest = Phaser.Textures.FilterMode.NEAREST;
      ['pe_shop_window', 'pe_shop_door', 'pe_shop_awning', 'pe_jp_door',
        'pe_jp_roof', 'pe_neon_sign', 'pe_diner_window', 'pe_house_window'].forEach((key) => {
        this.textures.get(key)?.setFilter(nearest);
      });
      Object.values(furnitureCatalog || {}).forEach((definition) => {
        const key = window.HomeFurnitureRenderer?.textureKey?.(definition);
        if (key) this.textures.get(key)?.setFilter(nearest);
      });
      ['home_floor', 'shop_floor', 'home_wall', 'shop_wall'].forEach((id) => {
        this.textures.get('int_' + id)?.setFilter(nearest);
      });
      ['kitchen_counter', 'kitchen_sink', 'kitchen_stove', 'kitchen_fridge', 'bathroom_toilet', 'bathroom_sink', 'bedroom_bed'].forEach((id) => {
        this.textures.get('int_' + id)?.setFilter(nearest);
      });
      ['bunting', 'balloons', 'flowers'].forEach((id) => {
        this.textures.get('dec_' + id)?.setFilter(nearest);
      });
    }

    create(data) {
      // ScenePlugin.restart() reuses this JavaScript instance. Phaser clears its
      // display list, but it does not invoke an arbitrary `shutdown()` method
      // unless it is subscribed to the scene SHUTDOWN event. Subscribe on every
      // create (once per lifecycle), then also discard every presentation
      // reference before drawing this map. Otherwise a home create can run
      // updateResidenceDirectory against destroyed Willow Walk house/sign
      // objects from the previous scene and abort the new scene lifecycle.
      this.events.once(Phaser.Scenes.Events.SHUTDOWN, this.shutdown, this);
      this._neighborhoodReady = false;
      this._teardownPlacement();
      teardownPlacement();
      this._resetTransientTravel();
      this._removePlacementInput();
      this.remotes = {};
      this.furniture = [];
      this.cashierNpcs?.forEach((entry) => {
        entry.sprite?.destroy?.();
        entry.nameTag?.destroy?.();
      });
      this.cashierNpcs = [];
      this.nearbyCashier = null;
      this.showroomFurniture?.forEach((object) => object?.destroy?.());
      this.showroomFurniture = [];
      this.showroomInteractions?.clear?.();
      this._showroomFurnitureLoadPending = false;
      const transitionDemos = Array.isArray(data?.showroom) ? data.showroom : null;
      this.showroomDemos = transitionDemos?.length ? transitionDemos : showroomDemos;
      this.streetLotsVisual = null;
      this.localBubble = null;
      this.localCosmetic = this.localWings = this.localPet = null;
      this.localCosmeticDef = this.localWingsDef = null;
      this.localSlotObjs = {};
      this.ghost = null;
       this.ghostFootprint = null;
       this.ghostPlacementMarker = null;
      this.portalCues = [];
      this.player = null;
      this.localNameTag = null;
      this.interactHint = null;
      this._groundTiles = null;
      this._groundMask?.destroy?.();
      this._groundMaskGraphics?.destroy?.();
      this._groundMask = null;
      this._groundMaskGraphics = null;
      this._streetScenerySegments = null;
      this._groundSyncKey = this._streetVisibleKey = this._cameraFitKey = null;
      this._geometryBlocks = this._yardBlocks = this._furnitureBlocks = null;
      this._ambientTweens = [];
      this.keys = this.wasd = this.keyE = this.keyShift = null;
      this.activity = null;
      this._activityFx = null;
      this._activityEffectTween = null;
      window._neighborhoodScene = this;
      // A restart is queued, not immediate. If another server result won
      // before this create callback ran, do not apply the older result's spawn,
      // roster, or fade to the reused scene. Let the newer queued restart own
      // the next create lifecycle; update() remains inert in the meantime.
      if (Number.isSafeInteger(data?._sceneTransitionGeneration) &&
          data._sceneTransitionGeneration !== sceneTransitionGeneration) return;
      this.info = data?.map || {};
      this.location = data?.location || currentLocation;
      const bounds = this.info.bounds || {
        width: this.info.width || (this.location === 'city' ? 3600 : 1152),
        height: this.info.height || (this.location === 'city' ? 1920 : 816),
      };
      this.mapWidth = bounds.width;
      this.mapHeight = bounds.height;
      this.actorFootRadius = Number(this.info.actorFootRadius) || 16;
      const atHome = this.location.startsWith('home:');
      this.ownExteriorColor = data?.self?.homeColor || data?.homeColor || ownExteriorColor || 'teal';
      ownExteriorColor = this.ownExteriorColor;
      window.jpoHouseColors?.prepareHouseColors(this);
      this._setNeighborhoodTextureFilters();
      this.physics.world.setBounds(0, 0, this.mapWidth, this.mapHeight);
      this.cameras.main.setBounds(0, 0, this.mapWidth, this.mapHeight);
      this._fitNeighborhoodCamera();

      // All maps are composed here from repeatable tile-sized ground, paths,
      // and separate transparent objects. None uses a baked screenshot/map PNG.
      if (atHome) this._drawHome();
      else if (typeof this.location === 'string' && this.location.endsWith('-shop')) this._drawShop();
      else if (typeof this.location === 'string' && ['cafe', 'diner', 'bakery', 'sushi'].includes(this.location)) this._drawRestaurant();
      else if (this.location === 'museum' || this.location.startsWith('museum-room-')) this._drawCommercialInterior();
      else if (this.location === 'neighborhood') this._drawNeighborhood();
      else this._drawCity();

      const self = data?.self || data?.spawn || {};
      const g = globals();
      const char = g._playerChar || self.character || 'adam';
      const baked = g._bakedWearIds?.(char, g._equippedCosmetic, g._equippedWings, g._equippedSlots) || [];
      this.playerTexKey = this._office('_buildPlayerTex', char, g._playerHairIdx || 0, g._playerSkinIdx || 0,
        g._playerShirtIdx || 0, g._playerPantsIdx || 0, baked) || ('run_' + char);
      this.playerDir = self.dir || 'down';
      this.player = this.physics.add.sprite(
        finiteDepth(self.x, 24), finiteDepth(self.y, 24), this.playerTexKey,
        g.DIR_START?.[this.playerDir] || 0,
      ).setScale(3).setOrigin(0.5, 0.5);
      this._setActorDepth(this.player, this.player.y);
      this.player.body.setSize(12, 10).setOffset(2, 20);
      this.player.body.setCollideWorldBounds(true);
      this.localNameTag = this._makeNameTag(this.player.x, this.player.y, g._playerName || self.name || 'You') ||
        this.add.text(this.player.x, this.player.y - 40, g._playerName || 'You', { fontSize: '14px', fontFamily: 'monospace', color: '#fff', backgroundColor: '#000000bb', padding: { x: 5, y: 3 } }).setOrigin(0.5, 1);
      this._setActorDepth(this.localNameTag, this.player.y, 2);
      this.cameras.main.startFollow(this.player);

      this._geometryBlocks = this.physics.add.staticGroup();
      this._yardBlocks = this.physics.add.staticGroup();
      this._furnitureBlocks = this.physics.add.staticGroup();
      (this.info.geometry?.blockers || []).forEach((block) =>
        this._addBlock(block.furnitureId && !block.showroom ? this._yardBlocks : this._geometryBlocks, block));
      this.physics.add.collider(this.player, this._geometryBlocks);
      this.physics.add.collider(this.player, this._yardBlocks);
      this.physics.add.collider(this.player, this._furnitureBlocks);
      this.doors = this.info.portals || [];
      this.updateResidenceDirectory(directory);
      this.seats = this.info.geometry?.seats || [];
      // A durable reconnect may arrive already seated at a public bench. The
      // server's anim/coordinates remain authoritative; this only restores the
      // matching local presentation once the map has been created.
      if (self.anim === 'sit') {
        const seat = this.seats
          .map((candidate) => ({ candidate, distance: Math.hypot(this.player.x - candidate.x, this.player.y - candidate.y) }))
          .filter(({ distance }) => distance <= 24)
          .sort((a, b) => a.distance - b.distance)[0]?.candidate;
        if (seat) this._setParkSeatState({ seated: true, seatId: seat.id || null, x: self.x, y: self.y, dir: self.dir || seat.dir });
      }
      this._drawPortalCues();
      this.keys = this.input.keyboard.createCursorKeys();
      this.wasd = this.input.keyboard.addKeys({ up: 'W', down: 'S', left: 'A', right: 'D' });
      this.keyE = this.input.keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.E);
      this.keyShift = this.input.keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.SHIFT);
      this.lastSend = 0;
      // Arrival points intentionally sit just inside an entry threshold. Do
      // not re-arm it until the player has walked clear, preventing bounce.
      this.portalRelease = !this._insidePortal(this.player.x, this.player.y);
      this.interactHint = this.add.text(0, 0, '', { fontFamily: 'monospace', fontSize: '11px', color: '#182331', backgroundColor: '#fff7d6', padding: { x: 5, y: 3 } }).setOrigin(0.5).setDepth(3000).setVisible(false);

      this._setLocalPresentation();
      this.renderFurniture(homeState);
      this.syncPlayers(data?.players || {});
      this._installPlacementInput(atHome);
      this._outdoorWheelHandler = (event) => {
        event.preventDefault();
        this._setOutdoorZoom(this.cameras.main.zoom + (event.deltaY < 0 ? 0.1 : -0.1));
      };
      this.game.canvas.addEventListener('wheel', this._outdoorWheelHandler, { passive: false });
      this._neighborhoodReady = true;
      this._startPerformanceSample();
    }

    _startPerformanceSample() {
      this._performanceCleanup?.();
      // Three bounded, aggregate samples from the real browser. No identity,
      // coordinates, chat, inventory, or credentials are recorded.
      const events = this.game.events;
      const started = performance.now();
      let since = started, previous = started, stepStart = started, renderStart = started;
      let frames = [], updateMs = 0, renderMs = 0, maxUpdate = 0, maxRender = 0, movingFrames = 0;
      this._performanceCorrections = {};
      const preStep = () => {
        const now = performance.now();
        if (!document.hidden && this._neighborhoodReady) {
          frames.push(now - previous);
          if (this.player?.body?.velocity?.lengthSq() > 0) movingFrames++;
        }
        previous = stepStart = now;
      };
      const postStep = () => {
        const ms = performance.now() - stepStart;
        updateMs += ms; maxUpdate = Math.max(maxUpdate, ms);
      };
      const preRender = () => { renderStart = performance.now(); };
      const postRender = () => {
        const now = performance.now(), ms = now - renderStart;
        renderMs += ms; maxRender = Math.max(maxRender, ms);
        if (now - since < 10000) return;
        const sorted = frames.slice().sort((a, b) => a - b);
        const count = Math.max(1, frames.length);
        const round = value => Math.round(value * 100) / 100;
        const sample = {
          build: window.__BUILD__, location: this.location.startsWith('home:') ? 'home' : this.location,
          renderer: this.game.renderer?.type === Phaser.WEBGL ? 'WebGL' : 'Canvas',
          frames: frames.length, movingFrames, hidden: document.hidden,
          frameP50Ms: round(sorted[Math.floor(sorted.length * 0.5)] || 0),
          frameP95Ms: round(sorted[Math.floor(sorted.length * 0.95)] || 0),
          slowFrames: frames.filter(value => value > 50).length,
          updateAvgMs: round(updateMs / count), updateMaxMs: round(maxUpdate),
          renderAvgMs: round(renderMs / count), renderMaxMs: round(maxRender),
          objects: this.children.length, blockers: this.info.geometry?.blockers?.length || 0,
          visibleObjects: this.children.list.filter(object => object.visible).length,
          lots: this.info.streetLots?.length || 0, groundImages: this._groundTiles?.length || 0,
          remotes: Object.keys(this.remotes || {}).length, localPet: !!this.localPet,
          zoom: round(this.cameras.main.zoom),
          scenes: this.game.scene.getScenes(true).map(scene => scene.sys.settings.key),
          corrections: this._performanceCorrections,
        };
        console.log('[neighborhood-performance]', JSON.stringify(sample));
        if (socket.connected) socket.volatile.emit('clientPerformanceSample', sample);
        frames = []; updateMs = renderMs = maxUpdate = maxRender = movingFrames = 0;
        this._performanceCorrections = {};
        since = now;
        if (now - started >= 30000) this._performanceCleanup?.();
      };
      events.on('prestep', preStep);
      events.on('poststep', postStep);
      events.on('prerender', preRender);
      events.on('postrender', postRender);
      this._performanceCleanup = () => {
        events.off('prestep', preStep); events.off('poststep', postStep);
        events.off('prerender', preRender); events.off('postrender', postRender);
        this._performanceCleanup = null;
      };
    }

    _tileField(base, alternate) {
      // A street with many accounts can be several map segments tall. The old
      // implementation retained thousands of Graphics commands for its ground
      // (fill, outline, and grass details per 48px cell). Bake only the
      // repeatable five-cell palette cycle. Do not make a TileSprite as large
      // as the world: Canvas renderers allocate its backing canvas at display
      // size, and permanent sparse lot indices can make that world very tall.
      // Include the authoritative map dimensions in the field identity: this
      // scene is reused for Willow Walk and Huddle Plaza, and a retained field
      // must never paint a street-sized canvas into a plaza map.
      const mapWidth = Number(this.mapWidth) || 0;
      const mapHeight = Number(this.mapHeight) || 0;
      const key = 'neighborhood-ground:' + base.toString(16) + ':' + alternate.toString(16) +
        ':' + mapWidth + 'x' + mapHeight;
      if (!this.textures.exists(key)) {
        const art = this.make.graphics({ x: 0, y: 0, add: false });
        const period = 48 * 5;
        for (let y = 0; y < period; y += 48) for (let x = 0; x < period; x += 48) {
          const cellX = x / 48, cellY = y / 48;
          const tone = ((cellX * 11 + cellY * 7) % 5 === 0) ? alternate : base;
          art.fillStyle(tone, 1).fillRect(x, y, 48, 48);
          art.lineStyle(1, 0x24313b, 0.09).strokeRect(x, y, 48, 48);
          // Break up the repeatable field without turning the authored maps into
          // a single baked ground image. Indoor palettes remain clean wood/tile.
          if (base === 0x77a45f || base === 0x83aa68) {
            const dx = 7 + ((cellX * 17 + cellY * 9) % 26);
            const dy = 9 + ((cellX * 7 + cellY * 13) % 25);
            art.fillStyle(0x436f42, 0.14).fillCircle(x + dx, y + dy, 1.2);
            art.fillStyle(0xd3df9c, 0.10).fillRect(x + 38 - dx / 5, y + 36 - dy / 7, 2, 1);
          }
        }
        art.generateTexture(key, period, period);
        art.destroy();
      }
      // Shared immutable 240px images follow the normal world camera.
      // Canvas TileSprite setters invalidate their backing canvas on EVERY
      // camera-pan frame. A pooled image grid only moves on chunk crossings.
      this._groundTextureKey = key;
      this._groundTiles = [];
      this._groundSyncKey = null;
      // The final 240px tile can overhang a map edge. A world-space mask is
      // the last guard against showing that grass in the viewport when a
      // small map is zoomed out or a reused camera has a larger view.
      if (this.make?.graphics && mapWidth > 0 && mapHeight > 0) {
        this._groundMaskGraphics = this.make.graphics({ x: 0, y: 0, add: false });
        this._groundMaskGraphics.fillStyle(0xffffff, 1).fillRect(0, 0, mapWidth, mapHeight);
        this._groundMask = this._groundMaskGraphics.createGeometryMask?.() || null;
      }
      this._syncTileField();
      return this._groundTiles;
    }

    _syncTileField() {
      if (!this._groundTiles || !this._groundTextureKey) return;
      const camera = this.cameras.main;
      const zoom = camera.zoom || 1;
      const width = camera.width || this.scale.width;
      const height = camera.height || this.scale.height;
      const viewWidth = width / zoom;
      const viewHeight = height / zoom;
      const rawLeft = camera.scrollX + width * (camera.originX ?? 0.5) * (1 - 1 / zoom);
      const rawTop = camera.scrollY + height * (camera.originY ?? 0.5) * (1 - 1 / zoom);
      const mapWidth = Number(this.mapWidth);
      const mapHeight = Number(this.mapHeight);
      // Camera bounds can still expose a viewport wider than a compact map at
      // zoom-out. Quantize only the intersection with the authoritative map
      // rectangle; any overhang is left to the camera clear color, never grass.
      const left = Number.isFinite(mapWidth) && mapWidth > 0
        ? Math.max(0, Math.min(Math.max(0, mapWidth - viewWidth), rawLeft)) : rawLeft;
      const top = Number.isFinite(mapHeight) && mapHeight > 0
        ? Math.max(0, Math.min(Math.max(0, mapHeight - viewHeight), rawTop)) : rawTop;
      const size = 240;
      const right = Number.isFinite(mapWidth) && mapWidth > 0
        ? Math.min(mapWidth, left + viewWidth) : left + viewWidth;
      const bottom = Number.isFinite(mapHeight) && mapHeight > 0
        ? Math.min(mapHeight, top + viewHeight) : top + viewHeight;
      const firstX = Math.max(0, Math.floor(left / size) - 1);
      const firstY = Math.max(0, Math.floor(top / size) - 1);
      const lastX = Number.isFinite(mapWidth) && mapWidth > 0
        ? Math.min(Math.ceil(mapWidth / size), Math.ceil(right / size) + 1)
        : Math.ceil(right / size) + 1;
      const lastY = Number.isFinite(mapHeight) && mapHeight > 0
        ? Math.min(Math.ceil(mapHeight / size), Math.ceil(bottom / size) + 1)
        : Math.ceil(bottom / size) + 1;
      const cols = Math.max(1, lastX - firstX);
      const rows = Math.max(1, lastY - firstY);
      const syncKey = `${firstX}:${firstY}:${cols}:${rows}`;
      if (this._groundSyncKey === syncKey) return;
      this._groundSyncKey = syncKey;
      const count = cols * rows;
      while (this._groundTiles.length < count) {
        this._groundTiles.push(this.add.image(0, 0, this._groundTextureKey).setOrigin(0, 0).setDepth(0));
      }
      this._groundTiles.forEach((tile, index) => {
        tile.setVisible(index < count);
        if (index < count) tile.setPosition(
          (firstX + index % cols) * size,
          (firstY + Math.floor(index / cols)) * size);
        tile.setMask?.(this._groundMask || null);
      });
    }

    _floorDepth(anchor, bias = 0) {
      return finiteDepth(anchor) + finiteDepth(bias);
    }

    _setFloorDepth(object, anchor, bias = 0, role = 'floor-object') {
      if (!object) return object;
      const floorAnchor = finiteDepth(anchor);
      object.setDepth?.(this._floorDepth(floorAnchor, bias));
      object.setData?.('floorAnchor', floorAnchor);
      object.setData?.('layerRole', role);
      return object;
    }

    _setActorDepth(object, anchor, bias = 0) {
      return this._setFloorDepth(object, anchor, bias, 'actor');
    }

    _activityDepthAnchor(entry, fallback) {
      const furniture = entry?._activityFurnitureSprite;
      if (!furniture || !furniture.getData?.('occluderParts')?.length) return finiteDepth(fallback);
      return finiteDepth(
        furniture.getData?.('floorAnchor'),
        finiteDepth(furniture.depth, fallback),
      );
    }

    _activityDepthBias(entry) {
      return entry?._activityFurnitureSprite?.getData?.('occluderParts')?.length
        ? INTERIOR_DEPTH.SEATED_ACTOR_BIAS : 0;
    }

    _interiorObjectNeedsOccluder(asset) {
      // Commercial objects have no catalog row, but their authored names
      // identify the same front-row furniture contract used by home items.
      // Wall art and small props intentionally remain single sprites.
      return /(?:chair|booth|bench|sofa|table|counter|cushion|bed|display|plant_disp|tree)/i.test(
        String(asset || ''),
      );
    }

    _interiorOccluderOptions(asset) {
      // These are source-art rows, not a universal bitmap crop.  Commercial
      // layouts predate the furniture catalog, so their filenames are the
      // only stable definition key available here.  Keep each silhouette's
      // front edge explicit and leave wall props without an occluder.
      const key = String(asset || '');
      if (/(?:furn_bed|furniture_bed)/i.test(key)) return { fromRatio: 0.75, depthBias: INTERIOR_DEPTH.FRONT_BIAS };
      if (/(?:sofa|couch)/i.test(key)) return { fromRatio: 0.75, depthBias: INTERIOR_DEPTH.FRONT_BIAS };
      if (/(?:chair|booth|bench)/i.test(key)) return { fromRatio: 0.68, depthBias: INTERIOR_DEPTH.FRONT_BIAS };
      if (/(?:table|counter)/i.test(key)) return { fromRatio: 0.72, depthBias: INTERIOR_DEPTH.FRONT_BIAS };
      if (/(?:cushion|rug)/i.test(key)) return { fromRatio: 0.82, depthBias: INTERIOR_DEPTH.FRONT_BIAS };
      return null;
    }

    _normaliseInteriorLayers(beforeChildren = [], locationId = this.location) {
      const data = this.cache?.json?.get?.('commercial-layouts');
      const room = data?.rooms?.[locationId];
      if (!room) return;
      const before = new Set(beforeChildren);
      const added = (this.children?.list || []).filter((object) => !before.has(object));
      // The generated room surface is the complete floor/wall backdrop. Keep
      // it below all y-sorted content, including a player at y=0.
      added.forEach((object) => {
        const key = object?.texture?.key;
        if (typeof key === 'string' && key.startsWith('commercial-surface:')) {
          this._setFloorDepth(object, INTERIOR_DEPTH.BACKGROUND, 0, 'interior-background');
        } else if (key === 'commercial-wall-native') {
          this._setFloorDepth(object, INTERIOR_DEPTH.WALL_BACK, 0, 'interior-wall');
        }
      });
      const candidates = added.filter((object) => {
        const key = object?.texture?.key;
        return key && key !== 'commercial-wall-native' &&
          !String(key).startsWith('commercial-surface:');
      });
      const used = new Set();
      for (const authored of room.objects || []) {
        if (!authored?.asset || authored.asset.startsWith('floor_') || authored.asset === 'museum_door') continue;
        const object = candidates.find((candidate) => {
          if (used.has(candidate)) return false;
          return candidate?.texture?.key === authored.asset &&
            Math.abs(finiteDepth(candidate.x) - finiteDepth(authored.x)) < 0.01 &&
            Math.abs(finiteDepth(candidate.y) - finiteDepth(authored.y)) < 0.01;
        });
        if (!object) continue;
        used.add(object);
        // `depth` in the authored manifest is the floor-contact anchor. Keep
        // explicit negative values for wall art as a back-wall layer.
        const anchor = finiteDepth(authored.depth, authored.y);
        const role = anchor < 0 ? 'interior-wall-prop' : 'interior-furniture';
        this._setFloorDepth(object, anchor, 0, role);
        if (anchor >= 0 && this._interiorObjectNeedsOccluder(authored.asset)) {
          const occluder = this._interiorOccluderOptions?.(authored.asset);
          window.HomeFurnitureRenderer?.splitOccluder?.(this, object, occluder || {});
        }
      }
    }

    _streetYardKey(yard) {
      return (yard || []).map((item) => [
        item.id, item.furnitureId, item.gridX, item.gridY, item.rotation,
      ].join(':')).join('|');
    }

    _interiorTileField(floorKey, wallKey, exit) {
      // The home and shop remain tile-composed maps, but their room material is
      // now actual 16×16 art from the supplied Room Builder sheets. A source
      // tile occupies one 48px home cell only through integer 3× scaling.
      for (let y = 0; y < this.mapHeight; y += 48) {
        for (let x = 0; x < this.mapWidth; x += 48) {
          const floor = this.add.image(x + 24, y + 24, 'int_' + floorKey)
            .setScale(INTERIOR_ART_SCALE);
          this._setFloorDepth(floor, INTERIOR_DEPTH.BACKGROUND, 0, 'interior-floor');
        }
      }
      for (let x = 0; x < this.mapWidth; x += 48) {
        const topWall = this.add.image(x + 24, 24, 'int_' + wallKey)
          .setScale(INTERIOR_ART_SCALE);
        this._setFloorDepth(topWall, 48, 0, 'interior-wall');
        const overlapsExit = x < exit.x + exit.width && x + 48 > exit.x;
        if (!overlapsExit) {
          const bottomWall = this.add.image(x + 24, this.mapHeight - 24, 'int_' + wallKey)
            .setScale(INTERIOR_ART_SCALE);
          this._setFloorDepth(bottomWall, this.mapHeight, 0, 'interior-wall');
        }
      }
      for (let y = 48; y < this.mapHeight - 48; y += 48) {
        const leftWall = this.add.image(24, y + 24, 'int_' + wallKey)
          .setScale(INTERIOR_ART_SCALE);
        const rightWall = this.add.image(this.mapWidth - 24, y + 24, 'int_' + wallKey)
          .setScale(INTERIOR_ART_SCALE);
        this._setFloorDepth(leftWall, y + 48, 0, 'interior-wall');
        this._setFloorDepth(rightWall, y + 48, 0, 'interior-wall');
      }
    }

    _roadDetails(horizontal, vertical, crosswalks = [], rangeStart = 0, rangeEnd = this.mapHeight) {
      const marks = this.add.graphics().setDepth(1.5);
      marks.lineStyle(3, 0xf5e7a8, 0.7);
      if (horizontal) for (let x = 24; x < this.mapWidth - 24; x += 56) marks.lineBetween(x, horizontal, x + 28, horizontal);
      if (vertical) for (let y = rangeStart + 24; y < rangeEnd - 24; y += 56) marks.lineBetween(vertical, y, vertical, y + 28);
      marks.fillStyle(0xf8f2d1, 0.75);
      for (const { x, y, vertical: isVertical } of crosswalks) {
        for (let n = -3; n <= 3; n++) {
          if (isVertical) marks.fillRect(x + n * 10 - 3, y - 18, 6, 36);
          else marks.fillRect(x - 18, y + n * 10 - 3, 36, 6);
        }
      }
      return marks;
    }

    _path(rect, fill = 0xd8ccb3, border = 0x9b927e) {
      const art = this.add.graphics().setDepth(1);
      art.fillStyle(fill, 1).fillRect(rect.x, rect.y, rect.width, rect.height);
      art.lineStyle(2, border, 0.7).strokeRect(rect.x, rect.y, rect.width, rect.height);
      for (let x = rect.x + 24; x < rect.x + rect.width; x += 48)
        art.lineStyle(1, border, 0.26).lineBetween(x, rect.y, x, rect.y + rect.height);
      for (let y = rect.y + 24; y < rect.y + rect.height; y += 48)
        art.lineStyle(1, border, 0.26).lineBetween(rect.x, y, rect.x + rect.width, y);
      return art;
    }

    _exterior(kind, x, y, scale = 2, _depth = 4, exteriorColor = null) {
      // Exterior art sorts by its ground contact point, allowing a player to
      // pass naturally behind a roof or tree and in front once below it.
      const sprite = this.add.image(x, y, 'ext_' + kind).setOrigin(0.5, 1).setScale(scale).setDepth(y);
      if (kind === 'house' && exteriorColor) window.jpoHouseColors?.applyHomeColor(sprite, exteriorColor);
      if (kind === 'lamp' && this.location === 'city') {
        this._animateNeighborhoodObject(sprite, { alpha: { from: 0.72, to: 1 }, duration: 780, delay: (x + y) % 420 });
      }
      return sprite;
    }

    _animateNeighborhoodObject(target, config) {
      if (!target || !this.tweens) return null;
      const tween = this.tweens.add({
        targets: target, yoyo: true, repeat: -1, ease: 'Sine.easeInOut', ...config,
      });
      (this._ambientTweens ||= []).push(tween);
      return tween;
    }

    _animateFurnitureObject(target, furnitureId, phase = 0) {
      if (!target) return;
      if (furnitureId === 'fern') {
        this._animateNeighborhoodObject(target, {
          angle: { from: -1.7, to: 1.7 }, duration: 1650, delay: phase % 260,
        });
      } else if (furnitureId === 'reading_lamp') {
        this._animateNeighborhoodObject(target, {
          alpha: { from: 0.76, to: 1 }, duration: 940, delay: phase % 320,
        });
      }
    }

    _sign(x, y, text) {
      return this.add.text(x, y, text, {
        fontFamily: 'monospace', fontSize: '12px', color: '#fff4cf',
        backgroundColor: '#35424acc', padding: { x: 5, y: 3 },
      }).setOrigin(0.5, 1).setDepth(2000);
    }

    _fitNeighborhoodCamera() {
      const camera = this.cameras.main;
      const width = camera.width || this.scale.width;
      const height = camera.height || this.scale.height;
      const zoom = this._cameraZoom ?? 1;
      const fitKey = `${width}:${height}:${this.mapWidth}:${this.mapHeight}:${zoom}`;
      if (this._cameraFitKey === fitKey) return;
      this._cameraFitKey = fitKey;
      // Match HQ's wheel range on every map. Viewport fitting must not
      // override a user's zoom-out or lock interiors to 1x.
      if (camera.zoom !== zoom) camera.setZoom(zoom);
    }

    _setOutdoorZoom(zoom) {
      this._cameraZoom = Math.min(4, Math.max(0.5, zoom));
      this._fitNeighborhoodCamera();
    }

    _drawNeighborhood() {
      this._tileField(0x77a45f, 0x6f9b59);
      const lots = Array.isArray(this.info.streetLots) ? this.info.streetLots : [];
      // The server owns the compact landscape layout.  Lot numbers are
      // permanent addresses and may be sparse, so never derive a row/column
      // from the highest lot id (or from the number of directory entries).
      // Older snapshots have no streetBlocks; keep those maps renderable as a
      // single legacy block rather than inventing a second client layout.
      const suppliedBlocks = Array.isArray(this.info.streetBlocks) && this.info.streetBlocks.length
        ? this.info.streetBlocks : null;
      this.streetBlocks = suppliedBlocks
        ? suppliedBlocks.map((block, position) => ({
          ...block,
          index: Number.isFinite(Number(block.index)) ? Number(block.index) : position,
          row: Number.isFinite(Number(block.row)) ? Number(block.row) : 0,
          column: Number.isFinite(Number(block.column)) ? Number(block.column) : 0,
          x: Number.isFinite(Number(block.x)) ? Number(block.x) : 0,
          y: Number.isFinite(Number(block.y)) ? Number(block.y) : 0,
          width: Number.isFinite(Number(block.width)) ? Number(block.width) : 1440,
          height: Number.isFinite(Number(block.height)) ? Number(block.height) : 960,
        }))
        : [{ index: 0, row: 0, column: 0, x: 0, y: 0, width: 1440, height: 960 }];
      this._streetBlockByIndex = new Map(this.streetBlocks.map((block) => [block.index, block]));
      this.streetSegmentCount = this.streetBlocks.length;
      this._streetScenerySegments = new Map();
      this.streetLotsVisual = [];
      this._streetPortalVisuals = [];
      this._streetLotVisibleKey = null;
      this._streetVisibleKey = null;
      this._syncStreetScenery();
      lots.forEach((lot) => {
        const path = this._path({ x: lot.x - 36, y: lot.northSide ? lot.bottom - 90 : lot.bottom - 236,
          width: 72, height: lot.northSide ? 198 : 246 });
        const stage = lot.construction?.stage || 'empty';
        const structure = this._drawResidenceStage(lot);
        const sign = this._sign(lot.x, lot.bottom - 102, this._residenceSignText(lot));
        this.streetLotsVisual.push({
          lot, path, structure, sign, stage, color: lot.exteriorColor || 'teal',
          // The union includes the facade, path, sign, and the 4x3 yard.  It
          // is intentionally a little padded so a house cannot pop while its
          // label or yard is entering the camera.
          bounds: {
            left: Number(lot.x) - 192, right: Number(lot.x) + 192,
            top: Number(lot.bottom) - 480, bottom: Number(lot.bottom) + 192,
          },
          yardKey: this._streetYardKey(lot.yard), yard: this._drawStreetYard(lot),
        });
      });
      this._sign(720, 72, 'WILLOW WALK · ONE SHARED STREET');
      this._streetLotVisibleKey = null;
      this._syncStreetLotVisibility();
    }

    _drawStreetSegment(segment) {
      const block = this._streetBlockByIndex?.get(segment) ||
        this.streetBlocks?.find((candidate) => Number(candidate.index) === Number(segment)) ||
        this.streetBlocks?.[segment];
      if (!block) return [];
      const x = Number(block.x) || 0;
      const y = Number(block.y) || 0;
      const width = Number(block.width) || 1440;
      const objects = [
        this.add.image(x, y, this._streetSurfaceTexture(width)).setOrigin(0, 0).setScale(3).setDepth(1),
      ];
      [[90, 228], [1090, 228], [90, 760], [1090, 760]]
        .map(([localX, localY]) => [x + localX, y + localY])
        .forEach(([x, y]) => objects.push(this._exterior('tree', x, y)));
      [[270, 420], [486, 420], [810, 420], [1110, 420],
        [270, 600], [486, 600], [810, 600], [1110, 600]]
        .map(([localX, localY]) => [x + localX, y + localY])
        .forEach(([x, y]) => objects.push(this._exterior('lamp', x, y, 2)));
      return objects;
    }

    _streetSurfaceTexture(blockWidth = 1440) {
      // Immutable native-resolution road surface shared by every segment.
      // Trees, lamps, residents, signs and houses remain independently layered.
      const width = Number(blockWidth) || 1440;
      const key = `willow-road-surface:${width}`;
      if (this.textures.exists(key)) return key;
      // Keep this a single 480x320 native road tile even when Willow Walk is
      // a 7200px-wide 5x4 landscape.  A world-sized Canvas texture allocates a
      // huge backing surface and also makes every block's road discontinuous.
      const texture = this.textures.createCanvas(key, Math.ceil(width / 3), 320);
      const ctx = texture.getContext();
      ctx.imageSmoothingEnabled = false;
      const path = (x, y, width, height, fill = '#d8ccb3', border = '#9b927e') => {
        ctx.fillStyle = fill;
        ctx.fillRect(x / 3, y / 3, width / 3, height / 3);
        ctx.strokeStyle = border;
        ctx.globalAlpha = 0.7;
        ctx.lineWidth = 2 / 3;
        ctx.strokeRect(x / 3, y / 3, width / 3, height / 3);
        ctx.globalAlpha = 0.26;
        ctx.lineWidth = 1 / 3;
        ctx.beginPath();
        for (let px = x + 24; px < x + width; px += 48) {
          ctx.moveTo(px / 3, y / 3); ctx.lineTo(px / 3, (y + height) / 3);
        }
        for (let py = y + 24; py < y + height; py += 48) {
          ctx.moveTo(x / 3, py / 3); ctx.lineTo((x + width) / 3, py / 3);
        }
        ctx.stroke(); ctx.globalAlpha = 1;
      };
      path(0, 432, width, 144, '#55616a', '#3f4950');
      path(0, 408, width, 24);
      path(0, 576, width, 24);
      path(552, 0, 48, 432);
      path(552, 576, 48, 384);
      ctx.strokeStyle = '#f5e7a8';
      ctx.globalAlpha = 0.7;
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let x = 24; x < width - 24; x += 56) {
        ctx.moveTo(x / 3, 168); ctx.lineTo((x + 28) / 3, 168);
      }
      for (let y = 24; y < 960; y += 56) {
        ctx.moveTo(192, y / 3); ctx.lineTo(192, (y + 28) / 3);
      }
      ctx.stroke();
      ctx.fillStyle = '#f8f2d1';
      ctx.globalAlpha = 0.75;
      for (const [x, y] of [[540, 420], [612, 588]]) {
        for (let n = -3; n <= 3; n++) ctx.fillRect((x - 18) / 3, (y + n * 10 - 3) / 3, 12, 2);
      }
      ctx.globalAlpha = 1;
      texture.refresh();
      return key;
    }

    _syncStreetScenery() {
      if (!this._streetScenerySegments || !this.streetSegmentCount) return;
      this._syncStreetLotVisibility();
      const camera = this.cameras.main;
      const view = camera.worldView || {};
      const zoom = camera.zoom || 1;
      const viewportWidth = Number(view.width || camera.width || this.scale?.width || 1440);
      const viewportHeight = Number(view.height || camera.height || this.scale?.height || 768);
      const left = Number.isFinite(Number(view.left)) ? Number(view.left)
        : Number.isFinite(Number(view.x)) ? Number(view.x) : (camera.scrollX || 0);
      const top = Number.isFinite(Number(view.top)) ? Number(view.top)
        : Number.isFinite(Number(view.y)) ? Number(view.y) : (camera.scrollY || 0);
      const right = Number.isFinite(Number(view.right)) ? Number(view.right)
        : left + (view.width ? viewportWidth : viewportWidth / zoom);
      const bottom = Number.isFinite(Number(view.bottom)) ? Number(view.bottom)
        : top + (view.height ? viewportHeight : viewportHeight / zoom);
      // Prefetch one block around the 2D camera rectangle.  Quantizing both
      // axes avoids rebuilding scenery while the camera travels inside one
      // grid cell, while rectangle intersections prevent a far block in the
      // same row/column from staying alive.
      const paddingX = 1440, paddingY = 960;
      const firstColumn = Math.floor((left - paddingX) / 1440);
      const lastColumn = Math.floor((right + paddingX) / 1440);
      const firstRow = Math.floor((top - paddingY) / 960);
      const lastRow = Math.floor((bottom + paddingY) / 960);
      const visibleKey = `${firstColumn}:${lastColumn}:${firstRow}:${lastRow}`;
      if (this._streetVisibleKey === visibleKey) return;
      this._streetVisibleKey = visibleKey;
      const wanted = new Set();
      (this.streetBlocks || []).forEach((block, position) => {
        const index = Number.isFinite(Number(block.index)) ? Number(block.index) : position;
        const x = Number(block.x) || 0, y = Number(block.y) || 0;
        const width = Number(block.width) || 1440, height = Number(block.height) || 960;
        if (x < right + paddingX && x + width > left - paddingX &&
            y < bottom + paddingY && y + height > top - paddingY) wanted.add(index);
      });
      this._streetScenerySegments.forEach((objects, segment) => {
        if (wanted.has(segment)) return;
        objects.forEach((object) => object?.destroy?.());
        this._streetScenerySegments.delete(segment);
      });
      wanted.forEach((segment) => {
        if (!this._streetScenerySegments.has(segment)) {
          this._streetScenerySegments.set(segment, this._drawStreetSegment(segment));
        }
      });
    }

    _syncStreetLotVisibility() {
      if (this.location !== 'neighborhood' || !this.streetLotsVisual) return;
      const camera = this.cameras.main;
      const view = camera.worldView || {};
      const zoom = camera.zoom || 1;
      const viewportWidth = Number(view.width || camera.width || this.scale?.width || 1440);
      const viewportHeight = Number(view.height || camera.height || this.scale?.height || 768);
      const left = Number.isFinite(Number(view.left)) ? Number(view.left)
        : Number.isFinite(Number(view.x)) ? Number(view.x) : (camera.scrollX || 0);
      const top = Number.isFinite(Number(view.top)) ? Number(view.top)
        : Number.isFinite(Number(view.y)) ? Number(view.y) : (camera.scrollY || 0);
      const right = Number.isFinite(Number(view.right)) ? Number(view.right)
        : left + (view.width ? viewportWidth : viewportWidth / zoom);
      const bottom = Number.isFinite(Number(view.bottom)) ? Number(view.bottom)
        : top + (view.height ? viewportHeight : viewportHeight / zoom);
      // Graphics command buffers use absolute world coordinates. Unlike a
      // tilemap they are not automatically culled by the camera: submitting
      // every distant lot was costing the real WebGL client ~167ms per frame.
      // Quantized, padded x/y bounds avoid per-frame scans and edge pop-in.
      const firstX = Math.floor(left / 240) - 1;
      const lastX = Math.ceil(right / 240) + 1;
      const first = Math.floor(top / 240) - 1;
      const last = Math.ceil(bottom / 240) + 1;
      const key = `${firstX}:${lastX}:${first}:${last}`;
      if (key === this._streetLotVisibleKey) return;
      this._streetLotVisibleKey = key;
      const lowX = firstX * 240, highX = lastX * 240;
      const low = first * 240, high = last * 240;
      for (const visual of this.streetLotsVisual) {
        const bounds = visual.bounds || (Number.isFinite(Number(visual.lot.x)) ? {
          left: Number(visual.lot.x) - 192, right: Number(visual.lot.x) + 192,
          top: Number(visual.lot.bottom) - 480, bottom: Number(visual.lot.bottom) + 192,
        } : null);
        const xVisible = !bounds || (bounds.right >= lowX && bounds.left <= highX);
        const yVisible = !bounds
          ? visual.lot.bottom + 192 >= low && visual.lot.bottom - 480 <= high
          : bounds.bottom >= low && bounds.top <= high;
        const visible = xVisible && yVisible;
        if (visual.visible === visible) continue;
        visual.visible = visible;
        visual.path?.setVisible?.(visible);
        visual.sign?.setVisible?.(visible);
        visual.structure?.forEach(object => object?.setVisible?.(visible));
        visual.yard?.forEach(object => object?.setVisible?.(visible));
      }
      for (const visual of this._streetPortalVisuals || []) {
        const portalLeft = Number.isFinite(Number(visual.left)) ? Number(visual.left)
          : Number.isFinite(Number(visual.x)) ? Number(visual.x) : null;
        const portalRight = Number.isFinite(Number(visual.right)) ? Number(visual.right)
          : portalLeft != null && Number.isFinite(Number(visual.width)) ? portalLeft + Number(visual.width) : null;
        const xVisible = portalLeft == null || (portalRight >= lowX && portalLeft <= highX);
        const visible = xVisible && visual.bottom >= low && visual.top <= high;
        if (visual.visible === visible) continue;
        visual.visible = visible;
        visual.objects?.forEach(object => object?.setVisible?.(visible));
      }
    }

    _residenceSignText(lot) {
      const stage = lot.construction?.stage || 'empty';
      const label = stage === 'complete' ? 'HOME' : stage === 'walls' ? 'WALLS' :
        stage === 'floor' ? 'FOUNDATION' : 'EMPTY LOT';
      const owner = String(lot.name || lot.ownerEmail).trim().slice(0, 24);
      const ownerTitle = owner.includes('@') || /(?:'S|’S)\s+HOME$/i.test(owner) ? owner :
        /(?:'S|’S)$/i.test(owner) ? owner + ' HOME' : owner + "'S HOME";
      return 'LOT ' + lot.lot + ' · ' + label + '\n' + ownerTitle;
    }

    _drawResidenceStage(lot) {
      const stage = lot.construction?.stage || 'empty';
      const objects = [];
      const left = lot.x - 96;
      const top = lot.bottom - 192;
      // The lot marker makes the empty owned plot explicit without introducing
      // a flattened house image. Foundation and wall phases use the supplied
      // native 16×16 room tiles at the same integer scale as interiors.
      const marker = this.add.graphics().setDepth(LOT_GROUND_DEPTH);
      marker.lineStyle(2, stage === 'empty' ? 0xd7c18e : 0x725542, 0.9)
        .strokeRect(left, lot.bottom - 144, 192, 144);
      if (stage === 'empty') {
        marker.fillStyle(0x6d9855, 0.25).fillRect(left, lot.bottom - 144, 192, 144);
        objects.push(marker);
        return objects;
      }
      for (let row = 0; row < 3; row++) for (let col = 0; col < 4; col++) {
        objects.push(this.add.image(left + 24 + col * 48, lot.bottom - 120 + row * 48, 'int_home_floor')
          .setScale(INTERIOR_ART_SCALE).setDepth(LOT_GROUND_DEPTH));
      }
      objects.push(marker);
      if (stage === 'floor') return objects;
      for (let row = 0; row < 2; row++) for (let col = 0; col < 4; col++) {
        objects.push(this.add.image(left + 24 + col * 48, top + 24 + row * 48, 'int_home_wall')
          // Sort each wall tile by its actual bottom edge. Unlike the
          // foundation, walls should naturally pass behind/in front of actors
          // as they walk around the structure.
          .setScale(INTERIOR_ART_SCALE).setDepth(top + 48 * (row + 1)));
      }
      if (stage === 'walls') return objects;
      objects.forEach((object) => object.destroy());
      return [this._exterior('house', lot.x, lot.bottom, 2, 4, lot.exteriorColor || 'teal')];
    }

    _drawStreetYard(lot) {
      // Yard objects remain outdoors and are saved in the same owner snapshot
      // as the room. The fenced patch is intentionally behind the facade, so
      // its compact 4×3 grid never narrows the public pavement.
      const originX = lot.x - 96;
      const originY = lot.northSide ? lot.bottom - 330 : lot.bottom - 66;
      const objects = [];
      const art = this.add.graphics().setDepth(LOT_GROUND_DEPTH);
      objects.push(art);
      art.fillStyle(0x6d9855, 0.9).fillRect(originX, originY, 192, 144);
      art.lineStyle(3, 0xd7c18e, 0.95).strokeRect(originX, originY, 192, 144);
      for (const item of lot.yard || []) {
        const def = furnitureCatalog[item.furnitureId];
        if (!def) continue;
        const footprint = this._footprint(def, item.rotation);
        const baseY = originY + (item.gridY + footprint.height) * 48;
        const sprite = this._drawFurniture(def,
          originX + item.gridX * 48 + footprint.width * 24, baseY, {
            rotation: item.rotation, depth: baseY, instanceId: item.id,
          });
        if (!sprite) continue;
        this._animateFurnitureObject(sprite, def.id, Number(item.gridX || 0) * 80 + Number(item.gridY || 0) * 120);
        objects.push(sprite);
      }
      return objects;
    }

    _drawCity() {
      this._tileField(0x83aa68, 0x789d60);
      const square = this.info.geometry?.commercialExteriors?.gatheringSquare || {
        x: 192, y: 448, width: 3216, height: 640,
      };
      // One broad paved square is the plaza's organizing space. Short walks
      // connect all authored thresholds to it; the landscape uses explicit
      // paths and planted pockets rather than a stretched building or a bare
      // asphalt field.
      this._path(square, 0x535e66, 0x3e4750);
      this._path({ x: square.x, y: square.y - 24, width: square.width, height: 24 });
      this._path({ x: square.x, y: square.y + square.height, width: square.width, height: 24 });
      // The west arrival gate opens directly onto the square.
      this._path({ x: 96, y: square.y + square.height - 168, width: square.x - 96, height: 144 });
      const venues = this.info.geometry?.commercialExteriors?.venues || [
        { id: 'furniture-shop', footprint: { x: 368, y: 160, width: 224, height: 222 } },
        { id: 'garden-shop', footprint: { x: 1248, y: 160, width: 224, height: 222 } },
        { id: 'decor-shop', footprint: { x: 2128, y: 160, width: 224, height: 222 } },
        { id: 'cafe', footprint: { x: 3008, y: 160, width: 224, height: 222 } },
        { id: 'diner', footprint: { x: 368, y: 1120, width: 224, height: 222 } },
        { id: 'bakery', footprint: { x: 1248, y: 1120, width: 224, height: 222 } },
        { id: 'sushi', footprint: { x: 2128, y: 1120, width: 224, height: 222 } },
        { id: 'museum', footprint: { x: 3000, y: 1120, width: 240, height: 350 } },
      ];
      venues.forEach((venue) => {
        const rect = venue.footprint;
        if (!rect || venue.id === 'museum') return;
        // Existing verified facade renderer owns the venue art; this method
        // only supplies the synchronized world-space placement.
        window.JpoPlazaExteriors.draw(this, {
          id: venue.id, ...rect,
          doorX: rect.x + rect.width / 2,
          doorY: rect.y + rect.height,
        });
        const doorCenterX = rect.x + rect.width / 2;
        const topRow = rect.y < square.y;
        if (topRow) {
          this._path({
            x: doorCenterX - 36,
            y: rect.y + rect.height,
            width: 72,
            height: square.y - (rect.y + rect.height),
          });
        } else {
          // The verified facade art opens on its south edge. Bring the square
          // around one side of each lower-row venue, then across its door,
          // rather than drawing an impossible path through the solid facade.
          const leftSide = rect.x - 36;
          const rightSide = rect.x + rect.width + 36;
          const sideX = leftSide >= square.x && leftSide <= square.x + square.width
            ? leftSide : rightSide;
          this._path({
            x: sideX - 24,
            y: square.y + square.height,
            width: 48,
            height: rect.y + rect.height - (square.y + square.height),
          });
          this._path({
            x: Math.min(sideX, doorCenterX) - 24,
            y: rect.y + rect.height - 24,
            width: Math.abs(sideX - doorCenterX) + 48,
            height: 48,
          });
        }
      });
      const museum = venues.find((venue) => venue.id === 'museum') || {
        footprint: { x: 3000, y: 1120, width: 240, height: 350 },
      };
      const museumRect = museum.footprint;
      window.JpoPlazaExteriors.draw(this, {
        id: 'museum', ...museumRect,
        doorX: museumRect.x + museumRect.width / 2,
        doorY: museumRect.y + museumRect.height,
      });
      this._path({ x: museumRect.x, y: museumRect.y + museumRect.height, width: museumRect.width, height: 96 });
      // Trees, lamps, benches, and planted pockets make the long plaza
      // traversable and legible at the authored camera scale.
      [[144, 408], [960, 408], [1776, 408], [2592, 408], [3456, 408],
        [144, 1080], [960, 1080], [1776, 1080], [2592, 1080], [3456, 1080],
        [144, 1552], [960, 1552], [1776, 1552], [2592, 1552], [3456, 1552]]
        .forEach(([x, y]) => this._exterior('tree', x, y));
      [[256, 464], [1056, 464], [1856, 464], [2656, 464], [3360, 464],
        [256, 1072], [1056, 1072], [1856, 1072], [2656, 1072], [3360, 1072]]
        .forEach(([x, y]) => this._exterior('lamp', x, y, 2));
      // Keep the visual bench contacts in lockstep with the authoritative
      // public-seat coordinates in neighborhood.mjs.
      [[720, 640], [1520, 640], [2320, 640], [3120, 640],
        [720, 896], [1520, 896], [2320, 896], [3120, 896]]
        .forEach(([x, y]) => this._exterior('bench', x, y, 2));

      // Decorative cheerful animated details sit in planted pockets spread
      // across both sides of the square, breaking up the paving without
      // blocking the walkways.
      const pocketGraphics = this.add.graphics().setDepth(1);
      [[400, 536], [1200, 536], [2000, 536], [2800, 536],
        [400, 904], [1200, 904], [2000, 904], [2800, 904]].forEach(([x, y]) => {
        pocketGraphics.fillStyle(0x6d9855, 0.92).fillRoundedRect(x, y, 224, 96, 18);
        pocketGraphics.lineStyle(2, 0xa7b86b, 0.78).strokeRoundedRect(x, y, 224, 96, 18);
      });
      [[512, 584], [1312, 584], [2112, 584], [2912, 584],
        [512, 952], [1312, 952], [2112, 952], [2912, 952]].forEach(([x, y]) => {
        this.add.image(x, y - 60, 'dec_flowers').setScale(3).setOrigin(0.5, 1).setDepth(y - 60);
        const balloons = this.add.image(x - 60, y - 60, 'dec_balloons').setScale(3).setOrigin(0.5, 1).setDepth(y);
        this._animateNeighborhoodObject(balloons, { y: { from: y - 60, to: y - 75 }, duration: 2500, yoyo: true, repeat: -1 });
      });
      [288, 960, 1632, 2304, 2976, 3456].forEach(x => {
        const bunting = this.add.image(x, square.y, 'dec_bunting').setScale(3).setOrigin(0.5, 0).setDepth(300);
        this._animateNeighborhoodObject(bunting, { alpha: { from: 0.8, to: 1 }, duration: 1500, yoyo: true, repeat: -1 });
      });

      this._sign(square.x + square.width / 2, square.y + 28, 'HUDDLE PLAZA');
      this._sign(94, square.y + square.height - 168, '← WILLOW WALK');
      this._sign(square.x + 150, square.y + square.height - 18, 'GATHERING SQUARE');
    }

    _storefrontSign(x, y, text) {
      const sign = this.add.text(x, y, text, {
        fontFamily: 'monospace', fontSize: '11px', color: '#fff8d3',
        backgroundColor: '#396451dd', padding: { x: 6, y: 3 },
      }).setOrigin(0.5, 1).setDepth(2000);
      this._animateNeighborhoodObject(sign, { alpha: { from: 0.82, to: 1 }, duration: 1200, delay: (x + y) % 300 });
      return sign;
    }

    setOwnHomeColor(color) {
      this.ownExteriorColor = color || 'teal';
    }

    updateResidenceDirectory(entries) {
      if (!this.streetLotsVisual) return;
      const homes = Array.isArray(entries) ? entries : [];
      const homesByOwner = new Map(homes.map((home) => [home.ownerEmail, home]));
      let yardChanged = false;
      let stageChanged = false;
      this.streetLotsVisual.forEach((visual) => {
        const current = homesByOwner.get(visual.lot.ownerEmail);
        if (!current || current.ownerEmail !== visual.lot.ownerEmail) return;
        const color = current.exteriorColor || 'teal';
        const stage = current.construction?.stage || 'empty';
        if (visual.stage !== stage || (stage === 'complete' && visual.color !== color)) {
          visual.structure?.forEach((object) => object.destroy());
          visual.structure = this._drawResidenceStage({ ...visual.lot, ...current });
          stageChanged = stageChanged || visual.stage !== stage;
          visual.stage = stage;
          visual.color = color;
        }
        const signText = this._residenceSignText({ ...visual.lot, ...current });
        if (visual.sign?.text !== signText) visual.sign?.setText(signText);
        const yardKey = this._streetYardKey(current.yard);
        if (visual.yardKey !== yardKey) {
          visual.yard?.forEach((object) => {
            this.tweens.killTweensOf(object);
            object.destroy();
          });
          visual.yard = this._drawStreetYard({ ...visual.lot, ...current });
          visual.yardKey = yardKey;
          yardChanged = true;
        }
        visual.lot = { ...visual.lot, ...current };
        visual.visible = undefined;
      });
      this.info.streetLots = this.streetLotsVisual.map((visual) => visual.lot);
      // Rebuild only from the updated authoritative lot data. This keeps
      // client Arcade collision aligned with the server's street snapshot
      // after an owner places or stores an outdoor item.
      if ((yardChanged || stageChanged) && this._yardBlocks && this.info.geometry) {
        // This mirrors the compact authoritative facade geometry. Rebuilding is
        // limited to an actual yard or construction-stage update, never a move.
        const fixed = this.streetLotsVisual.filter((visual) => visual.stage === 'walls' || visual.stage === 'complete')
          .flatMap((visual) => {
            const { x, bottom } = visual.lot;
            return [
              { x: x - 112, y: bottom - 234, width: 224, height: 145 },
              { x: x - 112, y: bottom - 89, width: 76, height: 90 },
              { x: x + 36, y: bottom - 89, width: 76, height: 90 },
            ];
          });
        const yardBlocks = this.streetLotsVisual.flatMap((visual) => (visual.lot.yard || []).flatMap((placed) => {
          const def = furnitureCatalog[placed.furnitureId];
          if (!def) return [];
          const footprint = this._footprint(def, placed.rotation);
          const originY = visual.lot.northSide ? visual.lot.bottom - 330 : visual.lot.bottom - 66;
          const movementBlockerOffset = def.movementBlockerOffset || {};
          const movementOffsetX = Number.isFinite(Number(movementBlockerOffset.x))
            ? Number(movementBlockerOffset.x) : 0;
          const movementOffsetY = Number.isFinite(Number(movementBlockerOffset.y))
            ? Number(movementBlockerOffset.y) : 0;
          return [{
            x: visual.lot.x - 96 + placed.gridX * 48 + movementOffsetX,
            y: originY + placed.gridY * 48 + movementOffsetY,
            width: footprint.width * 48, height: footprint.height * 48, furnitureId: placed.furnitureId,
          }];
        }));
        this.info.geometry.blockers = [...fixed, ...yardBlocks];
        if (stageChanged && this._geometryBlocks) {
          this._geometryBlocks.clear(true, true);
          fixed.forEach((block) => this._addBlock(this._geometryBlocks, block));
          this.doors = this.streetLotsVisual
            .filter((visual) => visual.stage === 'complete')
            .map((visual) => visual.lot.door);
          this.portalCues?.forEach((object) => object.destroy());
          this.portalCues = [];
          this._drawPortalCues();
        }
        this._yardBlocks.clear(true, true);
        yardBlocks.forEach((block) => this._addBlock(this._yardBlocks, block));
      }
      this._streetLotVisibleKey = null;
      this._syncStreetLotVisibility();
    }


    _drawRestaurant() {
      this._drawCommercialInterior();
    }

    _drawShop() {
      this._drawCommercialInterior();
    }

    _drawCommercialInterior() {
      const beforeChildren = [...(this.children?.list || [])];
      window.JpoInteriors.draw(this, this.location);
      this._normaliseInteriorLayers(beforeChildren, this.location);
      if (this.location === 'furniture-shop') this._drawFurnitureShowroom();
      this._drawCashiers();
    }

    _drawCashiers() {
      this.cashierNpcs?.forEach((entry) => {
        entry.sprite?.destroy?.();
        entry.nameTag?.destroy?.();
      });
      this.cashierNpcs = [];
      const cashiers = Array.isArray(this.info?.cashiers) ? this.info.cashiers : [];
      for (const cashier of cashiers) {
        if (!cashier?.id || cashier.location !== this.location ||
            !Number.isFinite(Number(cashier.x)) || !Number.isFinite(Number(cashier.y))) continue;
        const texture = this._office('_buildPlayerTex', cashier.character || 'amelia', 0, 0, 0, 0, []) ||
          ('run_' + (cashier.character || 'amelia'));
        const sprite = this.add.sprite(Number(cashier.x), Number(cashier.y), texture,
          globals().DIR_START?.down || 0).setScale(3).setOrigin(0.5, 0.5);
        this._setActorDepth(sprite, Number(cashier.y));
        const nameTag = this._makeNameTag(Number(cashier.x), Number(cashier.y), cashier.name) ||
          this.add.text(Number(cashier.x), Number(cashier.y) - 40, cashier.name, {
            fontSize: '14px', fontFamily: 'monospace', color: '#fff',
            backgroundColor: '#000000bb', padding: { x: 5, y: 3 },
          }).setOrigin(0.5, 1);
        this._setActorDepth(nameTag, Number(cashier.y), 2);
        this.cashierNpcs.push({ ...cashier, sprite, nameTag });
      }
    }

    _hideLegacyFurnitureShopObjects() {
      // The catalog demos below replace only the former sale placeholders.
      // Bookcases, mirrors, plants, and lamps are authored showroom fixtures,
      // not products that happen to share an old commercial texture key.
      const legacyKeys = new Set([
        'native_blue_sofa', 'furn_armchair', 'furn_table', 'furn_bed',
        'furn_tv', 'native_oak_chair',
      ]);
      for (const object of [...(this.children?.list || [])]) {
        if (legacyKeys.has(object?.texture?.key)) {
          this.tweens.killTweensOf(object);
          object.destroy();
        }
      }
    }

    _normaliseShowroomDemo(demo) {
      if (!demo?.instanceId || !demo?.furnitureId) return null;
      const definition = furnitureCatalog[demo.furnitureId];
      if (!definition) return null;
      const catalogActions = Array.isArray(definition.actions)
        ? definition.actions.map((action) => typeof action === 'string' ? action : action?.id)
        : [];
      // The server's action descriptors are preferred because they include
      // authored radius/offset/facing values. A cached transition payload
      // from before an interaction was added can still bind to the current
      // catalog, but only for actions the catalog actually supports.
      const supported = new Set(catalogActions);
      const actionObjects = Array.isArray(demo.actions) && demo.actions.length
        ? demo.actions.filter((action) => supported.has(typeof action === 'string' ? action : action?.id))
        : [];
      const actions = actionObjects.length
        ? actionObjects
        : catalogActions.filter(Boolean);
      if (!actions.length) return { ...demo, definition, actions: [] };
      const footprint = demo.footprint || definition.footprint || {
        width: definition.width || 1, height: definition.height || 1,
      };
      const x = Number(demo.x), y = Number(demo.y);
      const stand = Number.isFinite(Number(demo.stand?.x)) &&
        Number.isFinite(Number(demo.stand?.y))
        ? {
          x: Number(demo.stand.x), y: Number(demo.stand.y),
          dir: demo.stand.dir || 'down',
        }
        // This fallback is only for old cached showroom payloads. Current
        // server demos always carry an explicit approach/exit point.
        : Number.isFinite(x) && Number.isFinite(y)
          ? { x, y: y + Number(footprint.height || 1) * 24 + 18, dir: 'up' }
          : null;
      return {
        ...demo, definition, footprint, actions,
        ...(stand ? { stand } : {}),
      };
    }

    _drawFurnitureShowroom() {
      const source = this.showroomDemos?.length ? this.showroomDemos : showroomDemos;
      // The first location after approval can be Huddle Home. At that point
      // Phaser has already completed NeighborhoodScene.preload before the
      // server transition supplied its catalog, so a direct showroom entry
      // previously created missing-texture display objects (and hid the
      // legacy chairs) instead of real demos. Load only the catalog art this
      // active showroom needs, then redraw through the normal renderer once
      // Phaser has it. Home and later showroom entries already have these
      // keys and continue synchronously below.
      const renderer = window.HomeFurnitureRenderer;
      const missingDefinitions = Object.fromEntries((source || []).flatMap((demo) => {
        const definition = furnitureCatalog[demo?.furnitureId];
        const key = renderer?.textureKey?.(definition);
        return definition && key && !this.textures?.exists?.(key)
          ? [[definition.id, definition]] : [];
      }));
      const missingKeys = Object.keys(missingDefinitions);
      if (missingKeys.length) {
        if (!this._showroomFurnitureLoadPending) {
          this._showroomFurnitureLoadPending = true;
          const queued = renderer?.preload?.(this, missingDefinitions) || [];
          const redraw = () => {
            this._showroomFurnitureLoadPending = false;
            if (this.scene?.isActive?.() && this.location === 'furniture-shop') {
              this._drawFurnitureShowroom();
            }
          };
          if (queued.length) {
            this.load.once(Phaser.Loader.Events.COMPLETE, redraw);
            if (!this.load.isLoading?.()) this.load.start();
          } else {
            redraw();
          }
        }
        return;
      }
      // A showroom refresh can arrive while a local or remote visitor is
      // using a demo. Clear the old renderer target before destroying its
      // sprite, then rebind the authoritative activity to the replacement
      // object below instead of leaving the pose/effect attached to a dead
      // display object.
      this._clearActivityEffect(this);
      Object.values(this.remotes || {}).forEach((entry) => this._clearActivityEffect(entry));
      this.showroomFurniture?.forEach((object) => {
        this.tweens.killTweensOf(object);
        object.destroy();
      });
      this.showroomFurniture = [];
      this.showroomInteractions?.clear?.();
      this._hideLegacyFurnitureShopObjects();
      for (const rawDemo of source || []) {
        const demo = this._normaliseShowroomDemo(rawDemo);
        const definition = demo?.definition;
        if (!definition || !demo?.instanceId ||
            !Number.isFinite(Number(demo.x)) || !Number.isFinite(Number(demo.y))) continue;
        const sprite = this._drawFurniture(definition, Number(demo.x), Number(demo.y), {
          depth: Number(demo.y), instanceId: demo.instanceId,
        });
        if (!sprite) continue;
        const actions = demo.actions || [];
        // Keep the exact catalog metadata on the rendered demo. Besides
        // renderer tooling, this lets the proximity anchor below use the
        // same bottom-centred footprint/action offsets as the server.
        sprite.setData('instanceId', String(demo.instanceId));
        sprite.setData('furnitureId', definition.id);
        sprite.setData('height', demo.footprint?.height || definition.height || 1);
        sprite.setData('anchor', definition.interaction?.anchor || 'center');
        sprite.setData('rotation', 0);
        sprite.setData('showroomDemo', demo);
        sprite.setData('showroomActions', actions);
        sprite.setData('actionRadius', Math.max(
          96, ...actions.map((action) => Number(action?.radius) || 0),
        ));
        sprite.setData('height', demo.footprint?.height || definition.height || 1);
        // This record is the interaction source of truth. Sprite data remains
        // useful for renderer tooling, but prompts must not depend on a
        // display object's lifecycle or a transition cleanup race.
        this.showroomInteractions?.set?.(String(demo.instanceId), {
          sprite, demo, actions, definition, instanceId: String(demo.instanceId),
        });
        this.showroomFurniture.push(sprite);
      }
      this._rebindFurnitureActivities();
    }

    setFurnitureShowroomDemos(demos) {
      this.showroomDemos = Array.isArray(demos) ? demos : [];
      if (this.location !== 'furniture-shop') return;
      if (this.location === 'furniture-shop' && this.player) this._drawFurnitureShowroom();
    }

    _drawFurniture(definition, x, y, options = {}) {
      const renderer = window.HomeFurnitureRenderer;
      if (!definition || typeof renderer?.draw !== 'function') return null;
      return renderer.draw(this, definition, x, y, options);
    }

    _drawHome() {
      this._interiorTileField('home_floor', 'home_wall', HOME_EXIT);
      this._drawHomeRoomDivisions();

      // The centered exit stays open from the arrival tile to the threshold.
      // This is the one non-tile cue in an otherwise unfurnished residence.
      const doorArt = this.add.graphics();
      doorArt.fillStyle(0x9e7355, 1).fillRoundedRect(HOME_EXIT.x, HOME_EXIT.y, HOME_EXIT.width, HOME_EXIT.height - 30, 6);
      doorArt.lineStyle(3, 0xe8d09b, 0.9).strokeRoundedRect(HOME_EXIT.x, HOME_EXIT.y, HOME_EXIT.width, HOME_EXIT.height - 30, 6);
      this._setFloorDepth(doorArt, HOME_EXIT.y + HOME_EXIT.height, INTERIOR_DEPTH.FRONT_BIAS, 'interior-exit');
      this.add.text(HOME_EXIT.x + HOME_EXIT.width / 2, HOME_EXIT.y + 30, 'WILLOW EXIT ↓', { fontFamily: 'monospace', fontSize: '10px', color: '#fff5d6', backgroundColor: '#604332cc', padding: { x: 4, y: 2 } }).setOrigin(0.5).setDepth(12);
    }

    _drawHomeRoomDivisions() {
      // Room walls arrive in the authoritative map geometry. Render the
      // verified uploaded 16px wall tile at the same integer 3x scale used by
      // the floor and furniture; the omitted doorway cells remain visibly
      // traversable floor.
      const walls = this.info.geometry?.roomDividers || [];
      walls.forEach((wall) => {
        for (let y = wall.y; y < wall.y + wall.height; y += 48) {
          for (let x = wall.x; x < wall.x + wall.width; x += 48) {
            const tile = this.add.image(x + 24, y + 24, 'int_home_wall')
              .setScale(INTERIOR_ART_SCALE);
            this._setFloorDepth(tile, y + 48, 0, 'interior-divider');
          }
        }
      });
    }

    _drawPortalCues() {
      this._streetPortalVisuals = [];
      for (const portal of this.doors) {
        const cue = this.add.graphics().setDepth(3);
        cue.fillStyle(0xf6df75, 0.32).fillRoundedRect(portal.x + 3, portal.y + 3, portal.width - 6, portal.height - 6, 7);
        cue.lineStyle(2, 0xfff1a8, 0.9).strokeRoundedRect(portal.x + 3, portal.y + 3, portal.width - 6, portal.height - 6, 7);
        // Each residence already has one lot/owner sign at its facade. Keep
        // the door highlight for orientation, but do not stack a second
        // "OWNER'S HOME" portal label over that sign.
        if (portal.residence) {
          this.portalCues?.push(cue);
          this._streetPortalVisuals.push({
            x: portal.x, width: portal.width, left: portal.x, right: portal.x + portal.width,
            top: portal.y - 64, bottom: portal.y + portal.height + 32, objects: [cue],
          });
          continue;
        }
                const label = portal.destination === 'home' ? String(portal.label || (portal.residence ? ('Lot ' + portal.lot) : 'Home')).toUpperCase() :
          portal.destination === 'furniture-shop' ? 'FURNISHINGS' :
          portal.destination === 'garden-shop' ? 'WILLOW & GREEN' :
          portal.destination === 'decor-shop' ? 'PLAZA DECOR' :
          portal.destination === 'cafe' ? 'THE DAILY GRIND' :
          portal.destination === 'diner' ? 'NEON DINER' :
          portal.destination === 'bakery' ? 'SWEET CRUST BAKERY' :
          portal.destination === 'sushi' ? 'SAKURA SUSHI' :
          portal.destination === 'museum' ? (this.location.startsWith('museum-room-') ? 'MUSEUM FOYER' : 'HUDDLE MUSEUM') :
          portal.destination?.startsWith('museum-room-') ? String(portal.label || portal.destination).toUpperCase() :
          portal.destination === 'city' ? 'PLAZA' :
          portal.destination === 'neighborhood' ? String(portal.label || 'WILLOW WALK').toUpperCase() :
          String(portal.label || 'HQ GARDEN').toUpperCase();
        const labelY = portal.y <= 0 ? portal.y + portal.height + 22 : portal.y - 5;
        const text = this.add.text(portal.x + portal.width / 2, labelY, label, {
          fontFamily: 'monospace', fontSize: '11px', color: '#fff7c7', backgroundColor: '#35424acc', padding: { x: 4, y: 2 },
        }).setOrigin(0.5, 1).setDepth(2000);
        this.portalCues?.push(cue, text);
        this._streetPortalVisuals.push({
          x: portal.x, width: portal.width, left: portal.x, right: portal.x + portal.width,
          top: portal.y - 64, bottom: portal.y + portal.height + 32, objects: [cue, text],
        });
      }
      this._streetLotVisibleKey = null;
      this._syncStreetLotVisibility();
    }

    _insidePortal(x, y) {
      return this.doors?.some((portal) => x >= portal.x && x <= portal.x + portal.width &&
        y >= portal.y && y <= portal.y + portal.height);
    }

    _portalInnerBounds(portal) {
      // A portal may touch facade blockers. Its trigger must therefore be
      // inset by the same foot radius used by the shared server geometry, plus
      // one pixel for pointHitsRect's strict overlap edge, not by a
      // presentation-only number. This makes every trigger point a
      // server-valid, collision-free avatar centre.
      const inset = Math.min(this.actorFootRadius + 1, (portal.width - 1) / 2, (portal.height - 1) / 2);
      return {
        left: portal.x + inset,
        right: portal.x + portal.width - inset,
        top: portal.y + inset,
        bottom: portal.y + portal.height - inset,
      };
    }

    _addBlock(group, rect) {
      // `player.x/y` are the exact foot-centre coordinates sent to the
      // server. Arcade's body is deliberately lower in the 16×32 sprite
      // (offset 2,20), so its centre is currently x+0, y+27 after 3× scale.
      // Shift the static zone by that *measured* body-centre offset and size
      // it from the measured half-extents. Collision then occurs precisely
      // when server pointHitsRect(player.x, player.y, rect, 16) would occur;
      // do not use the former hard-coded +20/+22 expansion.
      const body = this.player?.body;
      // create() runs before Arcade's first preUpdate. Refresh scale/origin
      // now, otherwise center/halfWidth still describe the unscaled sprite.
      body?.updateFromGameObject();
      const bodyCenterX = body?.center?.x ?? this.player.x;
      const bodyCenterY = body?.center?.y ?? this.player.y;
      const offsetX = bodyCenterX - this.player.x;
      const offsetY = bodyCenterY - this.player.y;
      const halfWidth = body?.halfWidth ?? 6;
      const halfHeight = body?.halfHeight ?? 5;
       const width = Math.max(1, rect.width + 2 * (this.actorFootRadius - halfWidth) + 2 * COLLISION_SAFETY_MARGIN);
       const height = Math.max(1, rect.height + 2 * (this.actorFootRadius - halfHeight) + 2 * COLLISION_SAFETY_MARGIN);
      const r = this.add.rectangle(rect.x + rect.width / 2 + offsetX, rect.y + rect.height / 2 + offsetY,
        width, height, 0, 0);
      this.physics.add.existing(r, true);
      group.add(r);
      return r;
    }

    _setLocalPresentation() {
      this._clearLocalPresentation();
      const g = globals();
      const char = g._playerChar || 'adam';
      const made = this._makeCosmetic(g._equippedCosmetic || '', this.player.x, this.player.y, this.playerDir, this.player, char);
      if (made) { this.localCosmetic = made.obj; this.localCosmeticDef = made.def; }
      const wings = this._makeCosmetic(g._equippedWings || '', this.player.x, this.player.y, this.playerDir, this.player, char);
      if (wings) { this.localWings = wings.obj; this.localWingsDef = wings.def; }
      this.localSlotObjs = {};
      for (const [slot, item] of Object.entries(g._equippedSlots || {})) {
        if (!item) continue;
        const slotMade = this._makeCosmetic(item, this.player.x, this.player.y, this.playerDir, this.player, char);
        if (slotMade) this.localSlotObjs[slot] = slotMade;
      }
      const localPet = g._equippedPet || '';
      this.localPet = this._makePet(localPet, this.player.x, this.player.y, g._equippedPetAcc || '',
        g._petStageFor?.(localPet, (g._myPetXp || {})[localPet] || 0) || 1, socket.id);
      if (this.localPet) this._setActorDepth(this.localPet, this.localPet.y, -1);
      const baked = g._bakedWearIds?.(char, g._equippedCosmetic, g._equippedWings, g._equippedSlots) || [];
      this.playerTexKey = this._office('_buildPlayerTex', char, g._playerHairIdx || 0, g._playerSkinIdx || 0,
        g._playerShirtIdx || 0, g._playerPantsIdx || 0, baked) || this.playerTexKey;
      // Sitting animation state owns the sprite texture. Outfit updates can
      // arrive while a home/public-seat pose is active; resetting to the run
      // sheet here would make the next pose tick render a standing frame.
      if (!this.activity && !this.staticSeatState) this.player.setTexture(this.playerTexKey);
      this._applyActivityPose(this, this.activity, this.playerDir || 'down');
    }

    _clearLocalPresentation() {
      for (const object of [this.localCosmetic, this.localWings]) {
        if (object) { this.tweens.killTweensOf(object); object.destroy(); }
      }
      for (const entry of Object.values(this.localSlotObjs || {})) {
        if (entry?.obj) { this.tweens.killTweensOf(entry.obj); entry.obj.destroy(); }
      }
      if (this.localPet) this._destroyPet(this.localPet);
      this.localCosmetic = this.localWings = this.localPet = null;
      this.localCosmeticDef = this.localWingsDef = null;
      this.localSlotObjs = {};
    }

    _activityIcon(activity) {
      return ({
        sit: '✦', lie: '💤', sleep: '💤', shower: '💧',
        bathe: '🛁', watch: '📺',
      })[activity?.action] || '';
    }

    _clearActivityEffect(entry = null) {
      const target = entry || this;
      const fx = target._activityFx;
      if (fx) {
        this.tweens?.killTweensOf(fx);
        fx.destroy?.();
        target._activityFx = null;
      }
      if (target._activityEffectTween) {
        this.tweens?.remove?.(target._activityEffectTween);
        target._activityEffectTween = null;
      }
      if (target._activityFurnitureSprite && target._activityFurnitureDef) {
        window.HomeFurnitureRenderer?.clearEffect?.(
          this, target._activityFurnitureSprite, target._activityFurnitureDef,
        );
      }
      target._activityFurnitureSprite = null;
      target._activityFurnitureDef = null;
      const actor = target.sprite || (target === this ? this.player : null);
      if (actor) this._setActorDepth(actor, actor.y);
    }

    _showActivityEffect(entry, activity) {
      this._clearActivityEffect(entry);
      if (!activity) return;
      const sprite = entry.sprite || (entry === this ? this.player : null);
      if (!sprite) return;

      // Furniture activity animation is owned by the renderer. It receives the
      // authoritative definition and activity packet, never a guessed effect
      // name or a UI-only timer.
      if (activity.instanceId) {
        const furnitureSprites = [...(this.furniture || []), ...(this.showroomFurniture || [])];
        const fSprite = furnitureSprites.find((candidate) =>
          String(candidate.getData?.('instanceId') || '') === String(activity.instanceId));
        const definition = furnitureCatalog[activity.furnitureId] ||
          furnitureCatalog[fSprite?.getData?.('furnitureId')];
        if (fSprite && definition && typeof window.HomeFurnitureRenderer?.updateActivity === 'function') {
          entry._activityFurnitureSprite = fSprite;
          entry._activityFurnitureDef = definition;
          window.HomeFurnitureRenderer.updateActivity(this, fSprite, definition, activity);
          this._setActorDepth(
            sprite,
            this._activityDepthAnchor(entry, sprite.y),
            this._activityDepthBias(entry),
          );
        }
      }
    }

    _applyActivityPose(entry, activity, dir = 'down') {
      const sprite = entry.sprite || (entry === this ? this.player : null);
      if (!sprite) return;
      const texKey = entry.playerTexKey || entry.texture || this.playerTexKey;
      const start = globals().DIR_START || { right: 0, up: 6, left: 12, down: 18 };
      const definition = furnitureCatalog[activity?.furnitureId] ||
        entry._activityFurnitureDef || null;
      // The HQ renderer has three real seated sheets: the right profile,
      // the face-visible profile used for its up slot, and the front-facing
      // sheet.  Left deliberately mirrors the right sheet because no authored
      // left seated sheet exists.  Keep this mapping here rather than using
      // the furniture's action orientation: public-seat packets carry the
      // server-authoritative facing in `dir`, while home actions do the same
      // through their activity result.
      const facing = ['right', 'up', 'left', 'down'].includes(dir) ? dir : 'down';
      const sitFacing = { right: 'right', left: 'right', up: 'up', down: 'down' }[facing];
      const action = activity?.action;
      if (!action) {
        entry._activityAction = null;
        sprite.setAngle(0).setScale(3).setFlipX(false);
        sprite.anims.stop();
        // setTexture is intentional even when the current animation key is
        // stale. Phaser leaves currentAnim attached after stop()/setTexture(),
        // and a later sit can otherwise be mistaken for an already-active
        // seated animation (leaving the sprite on a run-sheet frame).
        sprite.setTexture(texKey).setFrame(start[facing] ?? start.down);
        this._clearActivityEffect(entry);
        return;
      }
      if (action === 'sit') {
        // Do not reset the run texture on every park-seat update. Phaser's
        // animation state owns the seated frame texture; repeatedly calling
        // setTexture here makes a seated player flash/freeze on the standing
        // sheet between animation ticks. play() switches to the authored sit
        // sheet when entering the pose or when a stale animation is detected.
        sprite.setAngle(0).setScale(3).setFlipX(facing === 'left');
        const sitKey = `sit_${texKey}_${sitFacing}`;
        if (this.anims.exists(sitKey)) {
          if (sprite.anims.currentAnim?.key !== sitKey || !sprite.anims.isPlaying) sprite.play(sitKey);
        } else {
          // A missing optional seated sheet must never leave a previous sit
          // texture/frame visible. Fall back to the current directional run
          // frame, preserving the character and wearable texture key.
          sprite.setFlipX(false);
          sprite.anims.stop();
          sprite.setTexture(texKey).setFrame(start[facing] ?? start.down);
        }
      } else if (action === 'lie' || action === 'sleep') {
        // There is no separate lie sheet in the supplied avatar pack.  The
        // catalog supplies the art-aware angle/scale: wide furniture places
        // the head on its long pad, while the portrait bed stays lengthwise.
        const authored = definition?.activityPose?.[action] ||
          definition?.activityPose?.lie || {};
        const lengthwise = activity?.orientation === 'lengthwise';
        sprite.anims.stop();
        sprite.setTexture(texKey).setFrame(start.down)
          .setScale(Number.isFinite(Number(authored.scale)) ? Number(authored.scale) : 2.7)
          .setAngle(Number.isFinite(Number(authored.angle))
            ? Number(authored.angle) : (lengthwise ? 0 : -90))
          .setFlipX(false);
      } else {
        const authored = definition?.activityPose?.[action] || {};
        sprite.anims.stop();
        sprite.setTexture(texKey).setFrame(action === 'watch' ? (start[dir] ?? start.up) : start.down)
          .setScale(Number.isFinite(Number(authored.scale)) ? Number(authored.scale) : 3)
          .setAngle(Number.isFinite(Number(authored.angle)) ? Number(authored.angle) : 0)
          .setFlipX(false);
      }
      if (entry._activityAction !== action) {
        entry._activityAction = action;
        this._showActivityEffect(entry, activity);
      }
    }

    _setLocalActivity(activity, payload = {}) {
      this.activity = activity || null;
      this.sitting = this.activity?.action === 'sit';
      if (this.activity) {
        if (Number.isFinite(payload.x)) this.player.setPosition(payload.x, payload.y);
        else if (Number.isFinite(this.activity.x)) this.player.setPosition(this.activity.x, this.activity.y);
        this.playerDir = payload.dir || this.activity.dir || this.playerDir || 'down';
        this.player.body?.reset(this.player.x, this.player.y);
        this.player.body?.setVelocity?.(0, 0);
        this.player.body.enable = false;
      } else if (this.player.body) {
        // Stop packets carry the server's validated stand (which may be a
        // fallback when a home was edited or a showroom point changed). Do
        // not let the optimistic local exit hide that authoritative coordinate
        // from the next snapshot/live correction.
        if (Number.isFinite(payload.x) && Number.isFinite(payload.y)) {
          this.player.setPosition(payload.x, payload.y);
          this.playerDir = payload.dir || this.playerDir || 'down';
          this.player.body.reset(this.player.x, this.player.y);
        }
        this.player.body.enable = true;
      }
      this._applyActivityPose(this, this.activity, this.playerDir || 'down');
      if (this.localNameTag) this.localNameTag.setPosition(this.player.x, this.player.y - 40);
    }

    _nearbyFurnitureAction() {
      if (!this.player || !this.furniture.length) return null;
      let best = null;
      for (const sprite of this.furniture) {
        const actions = sprite.getData('actions') || [];
        if (!actions.length) continue;
        const first = actions[0];
        const interaction = this._furnitureActionAnchor(sprite, first);
        const radius = Number(interaction?.radius) ||
          Number(sprite.getData('actionRadius')) || 86;
        const distance = Math.hypot(
          this.player.x - interaction.x, this.player.y - interaction.y,
        );
        if (distance > radius || (best && distance >= best.distance)) continue;
        best = {
          sprite, actions, distance, anchor: interaction,
          // Keep the request identity on the nearby interaction record. The
          // sprite DataManager remains only a compatibility fallback because
          // Phaser can replace a display object after the prompt is rendered.
          instanceId: sprite.getData?.('instanceId'),
        };
      }
      return best;
    }

    _furnitureActionAnchor(sprite, action) {
      const id = typeof action === 'string' ? action : action?.id;
      const furnitureId = sprite?.getData?.('furnitureId');
      const definition = furnitureCatalog[furnitureId] || {};
      const itemInteraction = definition.actionInteractions?.[id] || definition.interaction || {};
      const interaction = typeof action === 'object' ? { ...itemInteraction, ...action } : itemInteraction;
      const footprintHeight = Number(sprite?.getData?.('height')) ||
        Number(definition.height) || 1;
      const rotation = Number(sprite?.getData?.('rotation')) || 0;
      const anchorKind = sprite.getData('anchor') === 'front'
        ? 'front' : interaction.anchor;
      const baseY = anchorKind === 'front'
        ? Number(sprite.y) + 18
        : Number(sprite.y) - footprintHeight * 24 +
          (id === 'sit' ? 10 : 6);
      const offset = interaction.actorOffset;
      const offsetX = Number(offset?.x) || 0;
      const offsetY = Number(offset?.y) || 0;
      const radians = rotation * Math.PI / 180;
      return {
        x: Number(sprite.x) + offsetX * Math.cos(radians) - offsetY * Math.sin(radians),
        y: baseY + offsetX * Math.sin(radians) + offsetY * Math.cos(radians),
        radius: Number(interaction.radius) || 86,
      };
    }

    _nearbyShowroomAction() {
      if (!this.player) return null;
      let best = null;
      const entries = this.showroomInteractions?.size
        ? [...this.showroomInteractions.values()]
        : (this.showroomFurniture || []).map((sprite) => ({
          sprite, demo: sprite.getData('showroomDemo'),
          actions: sprite.getData('showroomActions') || [],
        }));
      for (const entry of entries) {
        const sprite = entry?.sprite;
        if (!sprite || sprite.active === false) continue;
        const demo = entry.demo || sprite.getData?.('showroomDemo');
        const actions = entry.actions || sprite.getData?.('showroomActions') || [];
        if (!demo?.instanceId || !actions.length) continue;
        // Do not use the approach/exit stand as an interaction target. A bath,
        // chair, or bed can legitimately have a stand farther from its
        // catalog action pad than its action radius. Mirroring the selected
        // catalog anchor makes an [E] prompt an admission the server will
        // accept, including Shift's second action.
        const selectedAction = this.keyShift?.isDown && actions[1] ? actions[1] : actions[0];
        const interaction = this._furnitureActionAnchor(sprite, selectedAction);
        const radius = Number(interaction?.radius) ||
          Number(sprite.getData?.('actionRadius')) || 86;
        const distance = Math.hypot(this.player.x - Number(interaction.x), this.player.y - Number(interaction.y));
        if (distance > radius || (best && distance >= best.distance)) continue;
        best = {
          sprite, demo, actions, distance, radius, anchor: interaction,
          instanceId: entry.instanceId || demo.instanceId,
        };
      }
      return best;
    }

    _nearbyInteractiveAction() {
      return this.location === 'furniture-shop'
        ? this._nearbyShowroomAction() : this._nearbyFurnitureAction();
    }

    _requestFurnitureAction() {
      if (this.activity || this._activityPending) return;
      // Keep cashier interaction authoritative even when a caller invokes
      // this helper outside the normal update-order calculation. A showroom
      // E prompt must never win over a cashier at the same point.
      const cashier = this.nearbyCashier || this._nearbyCashier();
      if (cashier) {
        this._interactCashier();
        return;
      }
      const nearby = this._nearbyInteractiveAction();
      if (!nearby) return;
      const selectedAction = this.keyShift?.isDown && nearby.actions[1] ? nearby.actions[1] : nearby.actions[0];
      const action = typeof selectedAction === 'string' ? selectedAction : selectedAction?.id;
      // Stable interaction records own the UUID. A Phaser DataManager value
      // is retained only for older home sprites and tooling compatibility;
      // showroom prompts must still submit after a redraw replaced the sprite
      // or cleared its metadata.
      const instanceId = nearby.demo?.instanceId ||
        nearby.instanceId || nearby.sprite?.getData?.('instanceId');
      if (!instanceId || !action) return;
      this._activityPending = true;
      if (this.location === 'furniture-shop') {
        socket.emit('furnitureDemoInteract', { phase: 'start', instanceId, action });
      } else {
        movement?.sendReliableEvent('furnitureInteract', this.location, { phase: 'start', instanceId, action });
      }
    }

    _leaveFurnitureActivity(reason = 'exit') {
      if (!this.activity && !this._activityPending) return;
      this._activityPending = false;
      const activity = this.activity;
      const stand = activity?.stand;
      this.activity = null;
      this.sitting = false;
      this.player.body.enable = true;
      if (stand && Number.isFinite(stand.x) && Number.isFinite(stand.y)) {
        this.player.setPosition(stand.x, stand.y);
        this.player.body?.reset(stand.x, stand.y);
        this.playerDir = stand.dir || this.playerDir;
      }
      this._applyActivityPose(this, null, this.playerDir || 'down');
      if (activity?.showroom || this.location === 'furniture-shop') {
        socket.emit('furnitureDemoInteract', {
          phase: 'exit', instanceId: activity?.instanceId || null, reason,
        });
      } else {
        movement?.sendReliableEvent('furnitureInteract', this.location, { phase: 'exit', reason });
      }
    }

    _parkSeatForState(state = this.staticSeatState) {
      if (!state) return null;
      return this.seats?.find((seat) => state.seatId && seat.id === state.seatId) ||
        this.seats?.map((seat) => ({ seat, distance: Math.hypot(Number(state.x) - seat.x, Number(state.y) - seat.y) }))
          .filter(({ distance }) => distance <= 24)
          .sort((a, b) => a.distance - b.distance)[0]?.seat || null;
    }

    _parkSeatStand(seat) {
      if (!seat) return null;
      const authored = Array.isArray(seat.stands) ? seat.stands
        : Array.isArray(seat.stand) ? seat.stand : seat.stand ? [seat.stand] : [];
      const validAuthored = authored.find((candidate) =>
        Number.isFinite(Number(candidate?.x)) && Number.isFinite(Number(candidate?.y)));
      if (validAuthored) return validAuthored;
      const northPocket = Number(seat.y) < this.mapHeight / 2;
      return { x: Number(seat.x), y: Number(seat.y) + (northPocket ? -64 : 64), dir: northPocket ? 'down' : 'up' };
    }

    _setParkSeatState(payload) {
      if (!this.player || !payload) return;
      this._parkSeatPending = null;
      this._parkSeatPendingAt = 0;
      this._parkSeatExitTarget = null;
      this._parkSeatSitTarget = null;
      if (payload.seated) {
        const seat = this.seats?.find((candidate) => payload.seatId && candidate.id === payload.seatId) ||
          this.seats?.map((candidate) => ({ candidate, distance: Math.hypot(Number(payload.x) - candidate.x, Number(payload.y) - candidate.y) }))
            .filter(({ distance }) => distance <= 24)
            .sort((a, b) => a.distance - b.distance)[0]?.candidate;
        if (!seat) return;
        this.staticSeatState = {
          seated: true, seatId: seat.id || payload.seatId || null,
          x: Number.isFinite(payload.x) ? payload.x : seat.x,
          y: Number.isFinite(payload.y) ? payload.y : seat.y,
          dir: payload.dir || seat.dir || 'down',
          stand: payload.stand || this._parkSeatStand(seat),
        };
        this.player.setPosition(this.staticSeatState.x, this.staticSeatState.y);
        this.playerDir = this.staticSeatState.dir;
        this.player.body?.reset(this.player.x, this.player.y);
        this.player.body.enable = false;
        this._applyActivityPose(this, { action: 'sit' }, this.playerDir);
      } else {
        const target = payload.stand || this._parkSeatExitTarget;
        this.staticSeatState = null;
        if (Number.isFinite(payload.x) && Number.isFinite(payload.y)) this.player.setPosition(payload.x, payload.y);
        if (target?.dir) this.playerDir = target.dir;
        this.player.body.enable = true;
        this.player.body?.reset(this.player.x, this.player.y);
        this._applyActivityPose(this, null, this.playerDir || 'down');
      }
    }

    _nearbyParkSeat() {
      if (!this.player || this.location.startsWith('home:') ||
          this.staticSeatState || this._parkSeatPending) return null;
      let best = null;
      for (const seat of this.seats || []) {
        const distance = Math.hypot(this.player.x - Number(seat.x), this.player.y - Number(seat.y));
        const radius = Number(seat.interactionRadius) || 86;
        if (distance > radius || (best && distance >= best.distance)) continue;
        best = { seat, distance };
      }
      return best;
    }

    _requestParkSeat() {
      if (this.staticSeatState || this._parkSeatPending) return;
      const nearby = this._nearbyParkSeat();
      if (!nearby) return;
      const seat = nearby.seat;
      this._parkSeatPending = 'sit';
      this._parkSeatPendingAt = performance.now();
      this._parkSeatSitTarget = { x: Number(seat.x), y: Number(seat.y), dir: seat.dir || 'down' };
      movement?.sendReliable(this.location, {
        ...this._parkSeatSitTarget, seatId: seat.id || null, anim: 'sit',
      });
    }

    _leaveParkSeat(reason = 'exit') {
      if (!this.staticSeatState || this._parkSeatPending) return;
      const seat = this._parkSeatForState();
      const stand = this.staticSeatState.stand || this._parkSeatStand(seat);
      if (!stand || !Number.isFinite(Number(stand.x)) || !Number.isFinite(Number(stand.y))) return;
      this._parkSeatPending = 'stand';
      this._parkSeatPendingAt = performance.now();
      this._parkSeatExitTarget = { x: Number(stand.x), y: Number(stand.y), dir: stand.dir || 'down' };
      // Keep the local body frozen until the server accepts this exact authored
      // stand point. E is therefore a real server movement transition, not a
      // client-only pose toggle or teleport.
      movement?.sendReliable(this.location, { ...this._parkSeatExitTarget, seatId: seat?.id || null, anim: 'idle', reason });
    }

    _installPlacementInput(atHome) {
      this._removePlacementInput();
      this._placementLocked = false;
      const atStreet = this.location === 'neighborhood';
      const yardLot = atStreet && Array.isArray(this.info.streetLots)
        ? this.info.streetLots.find((lot) => lot.ownerEmail === globals()._playerEmail) : null;
      const yardOrigin = yardLot ? {
        x: yardLot.x - 96, y: yardLot.northSide ? yardLot.bottom - 330 : yardLot.bottom - 66,
      } : null;

      this._updateGhostPosition = (pointer) => {
        const usingYard = atStreet && selectedZone === 'yard';
        if (!(atHome || usingYard) || !homeState?.canEdit || !selectedInstance || (usingYard && !yardOrigin)) return this._clearGhost();
        const item = [...(homeState.inventory || []), ...(homeState.layout || []), ...(homeState.yard || [])]
          .find((candidate) => candidate.id === selectedInstance);
        const def = item && furnitureCatalog[item.furnitureId];
        if (!def) return this._clearGhost();

        let gridX, gridY;
        if (this._placementLocked) {
          gridX = this._lockedGridX;
          gridY = this._lockedGridY;
        } else {
          gridX = Math.floor((pointer.worldX - (usingYard ? yardOrigin.x : 0)) / 48);
          gridY = Math.floor((pointer.worldY - (usingYard ? yardOrigin.y : 0)) / 48);
          this._lockedGridX = gridX;
          this._lockedGridY = gridY;
        }

        const footprint = this._footprint(def, selectedRotation);
        const blocked = usingYard
          ? !this._validYardPlacement(def, gridX, gridY, selectedRotation)
          : !this._validPlacement(def, gridX, gridY, selectedRotation);

        const ghostX = (usingYard ? yardOrigin.x : 0) + gridX * 48 + footprint.width * 24;
        const ghostY = (usingYard ? yardOrigin.y : 0) + (gridY + footprint.height) * 48;
        const ghostFurnitureId = this.ghost?.getData?.('furnitureId');
        if (!this.ghost || ghostFurnitureId !== def.id) {
          this.ghost?.destroy?.();
          this.ghost = this._drawFurniture(def, ghostX, ghostY, {
            rotation: selectedRotation, depth: 25, applyDepthOffset: false,
            occluder: false, instanceId: 'placement-preview',
          });
          this.ghost?.setAlpha?.(0.6);
        } else {
          this.ghost.setPosition?.(ghostX, ghostY);
          this.ghost.setAngle?.(selectedRotation);
        }
        if (this.ghost) {
          this.ghost.setData?.('blocked', blocked);
          // A preview is the real authored product art, never a red-tinted
          // substitute. Validity is expressed by the tile outline and the
          // explicit locked-placement message below; collision validation
          // remains unchanged and the confirm button stays disabled.
          this.ghost.clearTint?.();
          this._drawGhostFootprint(
            (usingYard ? yardOrigin.x : 0) + gridX * 48,
            (usingYard ? yardOrigin.y : 0) + gridY * 48,
            footprint.width * 48, footprint.height * 48, blocked,
          );
        }
      };

      this._showPlacementControls = () => {
        const container = document.getElementById('placement-controls');
        if (!container) return;
        const usingYard = atStreet && selectedZone === 'yard';
        const isAlreadyPlaced = homeState.layout?.some(i => i.id === selectedInstance) || homeState.yard?.some(i => i.id === selectedInstance);
        const valid = !!this.ghost && this.ghost.getData?.('blocked') !== true;
        window.JpoUIBuilder.renderPlacementControls(container, {
          active: true,
          isValid: valid,
          canReturn: isAlreadyPlaced,
          onRotate: () => {
            const item = [...(homeState.inventory || []), ...(homeState.layout || []), ...(homeState.yard || [])]
              .find(candidate => candidate.id === selectedInstance);
            const def = item && furnitureCatalog[item.furnitureId];
            if (def && Array.isArray(def.rotations) && def.rotations.length > 0) {
               const idx = def.rotations.indexOf(selectedRotation);
               selectedRotation = def.rotations[(idx + 1) % def.rotations.length];
            } else {
               selectedRotation = (selectedRotation + 90) % 360;
            }
            this._updateGhostPosition({ worldX: 0, worldY: 0 }); // position uses locked grid
            this._showPlacementControls();
          },
          onConfirm: () => {
            if (!valid) return;
            const confirmBtn = container.querySelector('#ghost-confirm');
            if (confirmBtn) confirmBtn.disabled = true;
            const instanceId = selectedInstance;
            const layout = {
              instanceId,
              gridX: this._lockedGridX,
              gridY: this._lockedGridY,
              rotation: selectedRotation,
              zone: usingYard ? 'yard' : 'indoor',
            };
            teardownPlacement();
            socket.emit('homeLayoutSet', {
              ...layout,
            });
            // We wait for snapshot to clear, but can hide UI immediately
            renderHome();
          },
          onCancel: () => {
            teardownPlacement();
            renderHome();
          },
          onReturn: () => {
            const instanceId = selectedInstance;
            requestStore(instanceId);
          }
        });
        if (!valid) {
          const note = document.createElement('small');
          note.id = 'ghost-invalid-note';
          note.textContent = 'Cannot place here: blocked or outside the room.';
          note.style.cssText = 'display:block; margin-top:6px; color:#ffb3a7; text-align:center;';
          container.firstElementChild?.appendChild(note);
        }
      };

      this._placementMoveHandler = (pointer) => {
        if (this._placementLocked) return;
        this._updateGhostPosition(pointer);
      };

      this._placementDownHandler = (pointer) => {
        if (this._placementLocked) return;
        const usingYard = atStreet && selectedZone === 'yard';
        if (!(atHome || usingYard) || !homeState?.canEdit || !selectedInstance || !this.ghost) return;
        this._placementLocked = true;
        this._updateGhostPosition(pointer);

        // Lock the authored-color preview at the selected grid point.
        if (this.ghost) {
           if (this.ghost.setAlpha) this.ghost.setAlpha(0.9);
        }

        this._showPlacementControls();
      };

      this.input.on('pointermove', this._placementMoveHandler);
      this.input.on('pointerdown', this._placementDownHandler);
    }

    _clearGhost() {
      if (this.ghost) this.ghost.destroy();
      this.ghost = null;
      this.ghostFootprint?.destroy?.();
      this.ghostFootprint = null;
      this.ghostPlacementMarker?.destroy?.();
      this.ghostPlacementMarker = null;
    }

    _drawGhostFootprint(x, y, width, height, blocked) {
      if (!this.ghostFootprint) this.ghostFootprint = this.add.graphics().setDepth(2998);
      const color = blocked ? 0xff8a76 : 0x86d9bf;
      this.ghostFootprint.clear();
      this.ghostFootprint.lineStyle(2, color, 0.95);
      this.ghostFootprint.strokeRect(x + 1, y + 1, Math.max(1, width - 2), Math.max(1, height - 2));
      if (!this.ghostPlacementMarker) {
        this.ghostPlacementMarker = this.add.text(0, 0, '', {
          fontFamily: 'monospace', fontSize: '11px', color: '#fff4dc',
          backgroundColor: '#6f2924', padding: { x: 4, y: 2 },
        }).setOrigin(0.5, 1).setDepth(2999);
      }
      this.ghostPlacementMarker
        .setPosition(x + width / 2, y - 4)
        .setText('Cannot place here')
        .setVisible(blocked);
    }

    clearPlacementPreview() {
      this._teardownPlacement();
    }

    _footprint(def, rotation) {
      const width = def.width || def.footprint?.width || 1;
      const height = def.height || def.footprint?.height || 1;
      return rotation % 180 === 90 ? { width: height, height: width } : { width, height };
    }

    _validPlacement(def, gridX, gridY, rotation) {
      const footprint = this._footprint(def, rotation);
      if (gridX < 1 || gridY < 1 || gridX + footprint.width > HOME_GRID_WIDTH - 1 || gridY + footprint.height > HOME_GRID_HEIGHT - 1 ||
          (gridX < 13 && gridX + footprint.width > 11 && gridY < HOME_GRID_HEIGHT && gridY + footprint.height > 14) ||
          (this.info.geometry?.roomDividers || []).some((wall) =>
            gridX * 48 < wall.x + wall.width && (gridX + footprint.width) * 48 > wall.x &&
            gridY * 48 < wall.y + wall.height && (gridY + footprint.height) * 48 > wall.y) ||
          (this.info.geometry?.builtInFixtures || []).some((fixture) =>
            gridX < fixture.gridX + fixture.width && gridX + footprint.width > fixture.gridX &&
            gridY < fixture.gridY + fixture.height && gridY + footprint.height > fixture.gridY) ||
          (this.info.geometry?.doorways || []).some((doorway) =>
            gridX < doorway.x + doorway.width && gridX + footprint.width > doorway.x &&
            gridY < doorway.y + doorway.height && gridY + footprint.height > doorway.y)) return false;
      return !(homeState?.layout || []).some((placed) => {
        if (placed.id === selectedInstance) return false;
        const other = furnitureCatalog[placed.furnitureId];
        if (!other) return false;
        const otherFootprint = this._footprint(other, placed.rotation);
        return gridX < placed.gridX + otherFootprint.width && gridX + footprint.width > placed.gridX &&
          gridY < placed.gridY + otherFootprint.height && gridY + footprint.height > placed.gridY;
      });
    }

    _validYardPlacement(def, gridX, gridY, rotation) {
      const footprint = this._footprint(def, rotation);
      if (gridX < 0 || gridY < 0 || gridX + footprint.width > 4 || gridY + footprint.height > 3 ||
          (gridX < 2 && gridX + footprint.width > 1 && gridY === 2)) return false;
      return !(homeState?.yard || []).some((placed) => {
        if (placed.id === selectedInstance) return false;
        const other = furnitureCatalog[placed.furnitureId];
        if (!other) return false;
        const otherFootprint = this._footprint(other, placed.rotation);
        return gridX < placed.gridX + otherFootprint.width && gridX + footprint.width > placed.gridX &&
          gridY < placed.gridY + otherFootprint.height && gridY + footprint.height > placed.gridY;
      });
    }

    _rebindFurnitureActivities() {
      const activeEntries = [
        { entry: this, activity: this.activity, dir: this.playerDir || 'down' },
        ...Object.values(this.remotes || {}).map((entry) => ({
          entry, activity: entry.activity, dir: entry.lastDir || 'down',
        })),
      ];
      for (const { entry, activity, dir } of activeEntries) {
        if (!activity?.action) continue;
        // renderFurniture replaces the target sprite. Force the pose path to
        // resolve the activity against the new furniture instance instead of
        // treating the old action key as already applied.
        entry._activityAction = null;
        this._applyActivityPose(entry, activity, dir);
      }
    }

    renderFurniture(state) {
      // create() is still in Phaser's CREATING state, not ACTIVE. The incoming
      // home snapshot can already be complete at that point, and no second
      // snapshot is guaranteed, so do not suppress the initial furniture build.
      if (!this.location?.startsWith('home:') || !this._furnitureBlocks) return;
      this._clearActivityEffect(this);
      Object.values(this.remotes || {}).forEach((entry) => this._clearActivityEffect(entry));
      this.furniture.forEach((object) => {
        this.tweens.killTweensOf(object);
        object.destroy();
      });
      this.furniture = [];
      this._furnitureBlocks?.clear(true, true);
      for (const item of state?.layout || []) {
        const def = furnitureCatalog[item.furnitureId];
        if (!def) continue;
        const rotations = Array.isArray(def.rotations) && def.rotations.length ? def.rotations : [0];
        const uprightRotation = rotations.includes(item.rotation) ? item.rotation : 0;
        const footprint = this._footprint(def, uprightRotation);
        const floorCenterX = item.gridX * 48 + footprint.width * 24;
        const floorBaseY = (item.gridY + footprint.height) * 48;
        const sprite = this._drawFurniture(def, floorCenterX, floorBaseY, {
          rotation: uprightRotation, depth: floorBaseY, instanceId: item.id,
        });

        if (sprite) {
           sprite.setData('instanceId', String(item.id));
           sprite.setData('furnitureId', def.id);
           sprite.setData('actions', Array.isArray(def.actions) ? def.actions : []);
           sprite.setData('actionRadius', def.interaction?.radius || 86);
           sprite.setData('anchor', def.interaction?.anchor || 'center');
            sprite.setData('rotation', uprightRotation);
           sprite.setData('height', footprint.height);
           sprite.setData('isSeat', Array.isArray(def.actions) && def.actions.includes('sit'));
           sprite.setData('seatDir', 'down');
           this._animateFurnitureObject(sprite, def.id, item.gridX * 90 + item.gridY * 130);
           this.furniture.push(sprite);
        }
        const movementBlockerOffset = def.movementBlockerOffset || {};
        const movementOffsetX = Number.isFinite(Number(movementBlockerOffset.x))
          ? Number(movementBlockerOffset.x) : 0;
        const movementOffsetY = Number.isFinite(Number(movementBlockerOffset.y))
          ? Number(movementBlockerOffset.y) : 0;
        this._addBlock(this._furnitureBlocks, {
          x: item.gridX * 48 + movementOffsetX, y: item.gridY * 48 + movementOffsetY,
          width: footprint.width * 48, height: footprint.height * 48,
        });
      }
      this._rebindFurnitureActivities();
    }

    _removeRemote(id) {
      const remote = this.remotes[id];
      if (!remote) return;
      this._clearActivityEffect(remote);
      for (const object of [remote.sprite, remote.nameTag, remote.cosmetic, remote.wings, remote.chatBubble]) {
        if (object) { this.tweens.killTweensOf(object); object.destroy(); }
      }
      for (const slot of Object.values(remote.slotObjs || {})) {
        if (slot?.obj) { this.tweens.killTweensOf(slot.obj); slot.obj.destroy(); }
      }
      if (remote.pet) this._destroyPet(remote.pet);
      delete this.remotes[id];
    }

    _isCurrentLocation(payload) {
      const location = typeof payload?.location === 'string' ? payload.location
        : typeof payload?.locationId === 'string' ? payload.locationId : null;
      return !location || location === this.location;
    }

    syncPlayers(players) {
      // Like furniture, the authoritative arrival snapshot is applied during
      // create before the scene status becomes ACTIVE.
      if (!this.player) return;
      Object.entries(players || {}).forEach(([id, player]) => {
        if (!this._isCurrentLocation(player)) return;
        if (id !== socket.id && player?.email !== globals()._playerEmail) this.addRemote(id, player);
        if (id === socket.id) this.correctLocal(player);
      });
      Object.keys(this.remotes).forEach((id) => { if (!players?.[id]) this._removeRemote(id); });
    }

    correctLocal(serverPlayer) {
      if (serverPlayer?.reason && this._performanceCorrections && this._isCurrentLocation(serverPlayer)) {
        const reason = ['coordinates', 'bounds', 'collision', 'path', 'speed', 'seat', 'activity', 'validation']
          .includes(serverPlayer.reason) ? serverPlayer.reason : 'other';
        this._performanceCorrections[reason] = (this._performanceCorrections[reason] || 0) + 1;
      }
      if (!serverPlayer || !this.player || !Number.isFinite(serverPlayer.x) || !Number.isFinite(serverPlayer.y)) return;
      if (!this._isCurrentLocation(serverPlayer) ||
          !window.JpoFocusedMovement?.shouldApplyCorrection(serverPlayer, this.location, this._lastCorrectionSeq)) return;
      // A movement correction can be delayed behind the reliable furniture
      // result that established the local activity. Such a correction is
      // necessarily stale while an action owns the avatar: the authoritative
      // server exits an activity through furnitureActivity/InteractionResult,
      // not by sending a correction whose payload omits activity. Applying the
      // delayed correction would teleport the actor back to its old stand and
      // clear the accepted pose (notably the showroom's lounge sofa).
      if (this.activity && serverPlayer.reason && !serverPlayer.activity) return;
      if (Number.isSafeInteger(serverPlayer.seq)) this._lastCorrectionSeq = serverPlayer.seq;
      // currentPlayers is an authoritative snapshot (transition/ejection/reconnect).
      this.player.setPosition(serverPlayer.x, serverPlayer.y);
      this.player.body?.reset(serverPlayer.x, serverPlayer.y);
      this.playerDir = serverPlayer.dir || this.playerDir;
      if (serverPlayer.activity) this._setLocalActivity(serverPlayer.activity, serverPlayer);
      else if (this.activity) this._setLocalActivity(null, serverPlayer);
      else if (serverPlayer.anim === 'sit' && this.seats?.length) {
        const seat = this.seats
          .map((candidate) => ({ candidate, distance: Math.hypot(serverPlayer.x - candidate.x, serverPlayer.y - candidate.y) }))
          .filter(({ distance }) => distance <= 24)
          .sort((a, b) => a.distance - b.distance)[0]?.candidate;
        if (seat) this._setParkSeatState({
          seated: true, seatId: seat.id || null, x: serverPlayer.x, y: serverPlayer.y,
          dir: serverPlayer.dir || seat.dir,
        });
      } else if (this.staticSeatState) {
        this._setParkSeatState({ seated: false, x: serverPlayer.x, y: serverPlayer.y, dir: serverPlayer.dir });
      }
    }

    addRemote(id, player) {
      if (!id || !player || id === socket.id || player.email === globals()._playerEmail ||
          !this._isCurrentLocation(player)) return;
      let remote = this.remotes[id];
      if (remote && Number.isSafeInteger(player.seq) &&
          player.seq < (remote._movementSeq ?? -1)) return;
      const character = player.character || 'adam';
      const hairIdx = player.hairIdx || 0, skinIdx = player.skinIdx || 0;
      const shirtIdx = player.shirtIdx ?? player.clothesIdx ?? 0, pantsIdx = player.pantsIdx ?? player.clothesIdx ?? 0;
      const baked = globals()._bakedWearIds?.(character, player.equipped, player.wings, player.slots) || [];
      const texture = this._office('_buildPlayerTex', character, hairIdx, skinIdx, shirtIdx, pantsIdx, baked) || ('run_' + character);
      if (!remote) {
        const sprite = this.add.sprite(player.x, player.y, texture).setScale(3).setOrigin(0.5, 0.5);
        this._setActorDepth(sprite, player.y);
        const nameTag = this._makeNameTag(player.x, player.y, player.name || 'Coworker') ||
          this.add.text(player.x, player.y - 40, player.name || 'Coworker', { fontSize: '14px', fontFamily: 'monospace', color: '#fff', backgroundColor: '#000000bb', padding: { x: 5, y: 3 } }).setOrigin(0.5, 1);
        this._setActorDepth(nameTag, player.y, 2);
        remote = this.remotes[id] = {
          sprite, nameTag, slotObjs: {}, character, texture, name: player.name || 'Coworker',
          appear: { character, hairIdx, skinIdx, shirtIdx, pantsIdx },
          wear: { equipped: player.equipped || '', wings: player.wings || '', slots: { ...(player.slots || {}) } },
          petId: player.pet || '', petAcc: player.petAcc || '', petStage: player.petStage || 0,
          lastDir: player.dir || 'down', seated: false, activity: null, _activityFx: null,
           _movementSeq: Number.isSafeInteger(player.seq) ? player.seq : -1,
        };
        this._makeRemotePresentation(remote, player, id);
      } else if (remote.texture !== texture) {
        remote.texture = texture;
      }
      this._applyRemote(remote, player);
    }

    _makeRemotePresentation(remote, player, id) {
      const create = (item) => this._makeCosmetic(item || '', remote.sprite.x, remote.sprite.y, player.dir || 'down', remote.sprite, remote.character);
      const cosmetic = create(player.equipped);
      if (cosmetic) { remote.cosmetic = cosmetic.obj; remote.cosmeticDef = cosmetic.def; }
      const wings = create(player.wings);
      if (wings) { remote.wings = wings.obj; remote.wingsDef = wings.def; }
      for (const [slot, item] of Object.entries(player.slots || {})) {
        if (!item) continue;
        const made = create(item);
        if (made) remote.slotObjs[slot] = made;
      }
      const stage = player.petStage || globals()._petStageFor?.(player.pet, (player.petXp || {})[player.pet] || 0) || 1;
      remote.petId = player.pet || '';
      remote.petAcc = player.petAcc || '';
      remote.petStage = stage;
      remote.pet = this._makePet(player.pet || '', remote.sprite.x, remote.sprite.y, player.petAcc || '', stage, id);
      if (remote.pet) this._setActorDepth(remote.pet, remote.sprite.y, -1);
    }

    _applyRemote(remote, player) {
      const dir = player.dir || remote.lastDir || 'down';
      remote.lastDir = dir;
      remote.seated = player.anim === 'sit';
      remote.activity = player.activity || (player.anim === 'sit' ? { action: 'sit' } : null);
      if (!remote.activity) {
        this._clearActivityEffect(remote);
        remote._activityAction = null;
      }
      remote.sprite.setPosition(player.x, player.y);
      // An active sit animation owns the seated texture. Calling
      // setTexture(runSheet) for every movement packet resets the visual sheet
      // while leaving currentAnim/isPlaying intact, so remote sitters flash
      // or appear to stand. Activity/seat pose application below switches
      // textures only when entering or changing the animation.
      if (!remote.activity) remote.sprite.setTexture(remote.texture);
      this._setActorDepth(remote.sprite, player.y);
      remote.nameTag?.setPosition(player.x, player.y - 40);
      this._setActorDepth(remote.nameTag, player.y, 2);
      if (remote.activity) {
        remote.playerTexKey = remote.texture;
        this._applyActivityPose(remote, remote.activity, dir);
        this._setActorDepth(
          remote.sprite,
          this._activityDepthAnchor(remote, remote.sprite.y),
          this._activityDepthBias(remote),
        );
      } else if (player.anim === 'walk') {
        remote.sprite.setFlipX(false);
        const key = 'walk_' + remote.texture + '_' + dir;
        if (this.anims.exists(key) && remote.sprite.anims.currentAnim?.key !== key) remote.sprite.play(key);
      } else {
        // Standing up leaves Phaser's seated texture/currentAnim attached
        // until an explicit run texture is selected. Restore both the
        // canonical palette/wearable sheet and the real directional frame;
        // otherwise a remote left-facing sitter can remain mirrored or show
        // a stale seated frame until their next walk packet.
        remote.sprite.setFlipX(false);
        remote.sprite.anims.stop();
        remote.sprite.setTexture(remote.texture);
        const runStart = globals().DIR_START || { right: 0, up: 6, left: 12, down: 18 };
        remote.sprite.setFrame(runStart[dir] ?? runStart.down);
      }
      this._positionPresentation(remote, player.x, player.y, dir);
    }

    _positionPresentation(entry, x, y, dir) {
      const depthAnchor = this._activityDepthAnchor(entry, y);
      const depthBias = entry?._activityFurnitureSprite?.getData?.('occluderParts')?.length
        ? INTERIOR_DEPTH.SEATED_ACTOR_BIAS : 1;
      const actor = entry?.sprite || (entry === this ? this.player : null);
      const action = entry?.activity?.action;
      const reclining = action === 'lie' || action === 'sleep';
      const actorScale = Number(actor?.scaleX);
      const poseScale = Number.isFinite(actorScale) && actorScale > 0 ? actorScale / 3 : 1;
      const poseAngle = reclining ? finiteDepth(actor?.angle, 0) : 0;
      const radians = (poseAngle * Math.PI) / 180;
      const poseWearableOffset = action
        ? entry?._activityFurnitureDef?.activityPose?.[action]?.wearableOffset
        : null;
      const poseObject = (object, def) => {
        if (!object) return;
        const beforeX = finiteDepth(object.x, x);
        const beforeY = finiteDepth(object.y, y);
        if (def) this._placeWearable(object, def, x, y, dir);
        else object.setPosition(x, y - 68);
        // Wearables are authored in the standing body coordinate system.
        // Rotate and proportionally scale those offsets with a reclining or
        // bath pose so hats, wings, and slot cosmetics stay attached instead
        // of remaining upright at the old standing position.
        if (object._activityBaseScaleX == null) {
          object._activityBaseScaleX = Math.abs(Number(def?.scale)) ||
            Math.abs(Number(object.scaleX)) || 3;
          object._activityBaseScaleY = Math.abs(Number(def?.scale)) ||
            Math.abs(Number(object.scaleY)) || 3;
        }
        if (poseWearableOffset && (reclining || action === 'sit' ||
            action === 'bathe' || action === 'shower')) {
          object.setPosition(
            x + finiteDepth(poseWearableOffset.x, 0),
            y + finiteDepth(poseWearableOffset.y, 0),
          );
          object.setAngle?.(poseAngle);
          object.setScale?.(
            object._activityBaseScaleX * poseScale,
            object._activityBaseScaleY * poseScale,
          );
        } else if (reclining || action === 'bathe' || action === 'shower') {
          const dx = finiteDepth(object.x, beforeX) - x;
          const dy = finiteDepth(object.y, beforeY) - y;
          const rx = dx * Math.cos(radians) - dy * Math.sin(radians);
          const ry = dx * Math.sin(radians) + dy * Math.cos(radians);
          object.setPosition(x + rx, y + ry);
          object.setAngle?.(poseAngle);
          object.setScale?.(
            object._activityBaseScaleX * poseScale,
            object._activityBaseScaleY * poseScale,
          );
        } else {
          object.setAngle?.(0);
          // Standing/sitting presentation is still owned by _placeWearable;
          // restore the authored size after leaving an activity pose.
          object.setScale?.(object._activityBaseScaleX, object._activityBaseScaleY);
        }
      };
      for (const [object, def] of [[entry.cosmetic, entry.cosmeticDef], [entry.wings, entry.wingsDef]]) {
        if (!object) continue;
        this._setActorDepth(object, depthAnchor, depthBias);
        poseObject(object, def);
      }
      for (const slot of Object.values(entry.slotObjs || {})) {
        if (!slot?.obj) continue;
        this._setActorDepth(slot.obj, depthAnchor, depthBias);
        poseObject(slot.obj, slot.def);
      }
    }

    moveRemote(player) {
      if (!player?.id || player.id === socket.id) {
        if (player?.id === socket.id) this.correctLocal(player);
        return;
      }
      if (!this._isCurrentLocation(player)) return;
      const remote = this.remotes[player.id];
      if (remote && !window.JpoFocusedMovement?.shouldApplyRemote(player, this.location, remote._movementSeq ?? -1)) return;
      if (remote && Number.isSafeInteger(player.seq)) remote._movementSeq = player.seq;
      if (remote) this._applyRemote(remote, player);
      else this.addRemote(player.id, player);
    }

    _refreshRemoteWear(id, payload) {
      const remote = this.remotes[id];
      if (!remote) return;
      const next = {
        ...remote.appear, ...payload, name: remote.name, x: remote.sprite.x, y: remote.sprite.y, dir: remote.lastDir,
        equipped: payload.equipped ?? remote.wear.equipped, wings: payload.wings ?? remote.wear.wings,
        slots: payload.slots ?? remote.wear.slots,
        pet: payload.pet ?? remote.petId, petAcc: payload.petAcc ?? remote.petAcc, petStage: payload.petStage ?? remote.petStage,
      };
      this._removeRemote(id);
      this.addRemote(id, next);
    }

    _refreshRemotePet(id, payload) {
      const remote = this.remotes[id];
      if (!remote) return;
      if (remote.pet) this._destroyPet(remote.pet);
      const stage = payload.petStage || globals()._petStageFor?.(payload.pet, 0) || 1;
      remote.petId = payload.pet || '';
      remote.petAcc = payload.petAcc || '';
      remote.petStage = stage;
      remote.pet = this._makePet(payload.pet || '', remote.sprite.x, remote.sprite.y, payload.petAcc || '', stage, id);
      if (remote.pet) this._setActorDepth(remote.pet, remote.sprite.y, -1);
    }

    showChat(playerId, message) {
      const local = playerId === socket.id;
      const entry = local ? { sprite: this.player, local: true } : this.remotes[playerId];
      if (!entry?.sprite) return; // Never create a remote from chat payloads.
      if (local && this.localBubble) this.localBubble.destroy();
      if (!local && entry.chatBubble) entry.chatBubble.destroy();
      const bubble = this.add.text(entry.sprite.x, entry.sprite.y - 78, message, {
        fontSize: '14px', fontFamily: 'monospace', color: '#111', backgroundColor: '#ffffffee', padding: { x: 10, y: 7 }, wordWrap: { width: 220 }, resolution: 2,
      }).setOrigin(0.5, 1).setDepth(3001);
      this.tweens.add({ targets: bubble, alpha: 0, delay: 3800, duration: 500, onComplete: () => bubble.destroy() });
      if (local) this.localBubble = bubble; else entry.chatBubble = bubble;
    }

    _nearbyCashier() {
      if (!this.player || !Array.isArray(this.cashierNpcs)) return null;
      return this.cashierNpcs
        .map((cashier) => ({ cashier, distance: Math.hypot(this.player.x - cashier.x, this.player.y - cashier.y) }))
        .filter(({ cashier, distance }) => distance <= (Number(cashier.radius) || 116))
        .sort((left, right) => left.distance - right.distance)[0]?.cashier || null;
    }

    _interactCashier() {
      const cashier = this.nearbyCashier || this._nearbyCashier();
      if (!cashier || this.activity || this.staticSeatState) return false;
      window.jpoOpenCashier?.(cashier);
      return true;
    }

    update(_time, delta) {
      // SceneManager can leave a reused instance briefly active while its
      // restart/create queue is draining. Do not let a destroyed player or a
      // partially-created input/camera stack enter this frame.
      if (!this._neighborhoodReady || !this.cameras?.main || !this.player ||
          !this.keys || !this.wasd || !this.keyE || !this.keyShift || !this.interactHint) return;
      this._fitNeighborhoodCamera();
      this._syncTileField();
      this._syncStreetScenery();
      if (this.location === 'neighborhood') {
        const ownLot = (this.info.streetLots || []).find((lot) => lot.ownerEmail === globals()._playerEmail);
        const near = ownLot && Math.hypot(this.player.x - ownLot.returnSpawn.x, this.player.y - ownLot.returnSpawn.y) <= 180
          ? ownLot : null;
        if ((this._constructionLotOwner || null) !== (near?.ownerEmail || null)) {
          this._constructionLotOwner = near?.ownerEmail || null;
          window.jpoSetConstructionLot?.(near);
        }
      } else if (this._constructionLotOwner) {
        this._constructionLotOwner = null;
        window.jpoSetConstructionLot?.(null);
      }
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || '');
      const cashierDialogOpen = cashierOpen && !!activeCashier?.id;
      const g = globals();
      const { SPEED, touchMove = {}, touchAction = {} } = g;
      const spd = typeof g.effectiveMovementSpeed === 'function'
        ? g.effectiveMovementSpeed()
        : SPEED;
      // Walking remains available while speaking so leaving the authored
      // cashier radius still closes the dialogue through the normal proximity
      // lifecycle. The dialogue only consumes its own E/action interaction.
      const left = !typing && (this.keys.left.isDown || this.wasd.left.isDown || touchMove.left);
      const right = !typing && (this.keys.right.isDown || this.wasd.right.isDown || touchMove.right);
      const up = !typing && (this.keys.up.isDown || this.wasd.up.isDown || touchMove.up);
      const down = !typing && (this.keys.down.isDown || this.wasd.down.isDown || touchMove.down);
      const body = this.player.body;
      if (this.activity && !this.transitionRequested && (left || right || up || down)) {
        this._leaveFurnitureActivity('movement');
      }
      if (this.staticSeatState && !this._parkSeatPending && !this.transitionRequested && (left || right || up || down)) {
        this._leaveParkSeat('movement');
      }
      // A movement packet can be dropped by the server's cadence guard. Do
      // not leave the local E interaction permanently pending when no
      // correction/seat acknowledgement arrives; the authoritative seated
      // pose remains retryable.
      if (this._parkSeatPending && this._parkSeatPendingAt &&
          performance.now() - this._parkSeatPendingAt > 1500) {
        this._parkSeatPending = null;
        this._parkSeatPendingAt = 0;
        this._parkSeatExitTarget = null;
        this._parkSeatSitTarget = null;
      }
      let dir = this.playerDir || 'down';
      const parkSeated = !!this.staticSeatState;
      const parkPendingSit = this._parkSeatPending === 'sit';
      const parkStanding = this._parkSeatPending === 'stand';
      let anim = this.activity ? (this.activity.action === 'sit' ? 'sit' : this.activity.action)
        : ((parkSeated && !parkStanding) || parkPendingSit ? 'sit' : 'idle');
      body.setVelocity(0, 0);
      if (!this.activity && !parkSeated && !this._parkSeatPending && !this._activityPending && !this.transitionRequested) {
        // Independent axes, matching HQ; diagonals retain the same total speed.
        if (up) { body.setVelocityY(-spd); dir = 'up'; anim = 'walk'; }
        else if (down) { body.setVelocityY(spd); dir = 'down'; anim = 'walk'; }
        if (left) { body.setVelocityX(-spd); dir = 'left'; anim = 'walk'; }
        else if (right) { body.setVelocityX(spd); dir = 'right'; anim = 'walk'; }
        if ((left || right) && (up || down)) body.velocity.normalize().scale(spd);
      }
      ui.classList.toggle('neighborhood-walking', anim === 'walk');
      this.playerDir = dir;
      // Match validLocationMove's 16px radius at the map edge before emitting.
      if (!this.activity && !parkSeated && !this._parkSeatPending) {
        this.player.x = Phaser.Math.Clamp(this.player.x, 16, this.mapWidth - 16);
        this.player.y = Phaser.Math.Clamp(this.player.y, 16, this.mapHeight - 16);
      }
      if (this.activity) {
        this.player.setPosition(this.activity.x, this.activity.y);
        body.setVelocity(0, 0);
        // Keep the authoritative activity pose alive through every update.
        // Position/depth presentation is intentionally separate from the
        // avatar texture, but other live outfit/seat updates can touch the
        // sprite between socket packets. _applyActivityPose is idempotent for
        // the real seated animation key and therefore does not restart it.
        this._applyActivityPose(this, this.activity, this.playerDir || 'down');
      } else if (parkSeated) {
        this.player.setPosition(this.staticSeatState.x, this.staticSeatState.y);
        body.setVelocity(0, 0);
        this._applyActivityPose(this, { action: 'sit' }, this.staticSeatState.dir || dir);
      } else if (anim === 'walk') {
        const key = 'walk_' + this.playerTexKey + '_' + dir;
        if (this.anims.exists(key) && this.player.anims.currentAnim?.key !== key) this.player.play(key);
      } else {
        this.player.anims.stop();
        this.player.setTexture(this.playerTexKey).setFrame(globals().DIR_START?.[dir] || 0);
      }
      this.localNameTag?.setPosition(this.player.x, this.player.y - 40);
      const localDepthAnchor = this._activityDepthAnchor(this, this.player.y);
      const localDepthBias = this._activityDepthBias(this);
      this._setActorDepth(this.player, localDepthAnchor, localDepthBias);
      this._setActorDepth(this.localNameTag, localDepthAnchor, localDepthBias + 2);
      this._positionPresentation({
        cosmetic: this.localCosmetic, cosmeticDef: this.localCosmeticDef,
        wings: this.localWings, wingsDef: this.localWingsDef, slotObjs: this.localSlotObjs,
        _activityFurnitureSprite: this._activityFurnitureSprite,
        _activityFurnitureDef: this._activityFurnitureDef,
        activity: this.activity, sprite: this.player,
      }, this.player.x, this.player.y, dir);
      if (this._activityFx) this._activityFx.setPosition(this.player.x, this.player.y - 54);
      if (this.localPet) {
        this._stepPet(this.localPet, this.player.x, this.player.y, delta, !!this.activity);
        this._setActorDepth(this.localPet, this.localPet.y, -1);
      }
      for (const remote of Object.values(this.remotes)) {
        if (remote.activity) {
          this._applyActivityPose(remote, remote.activity, remote.lastDir || 'down');
        }
        if (remote._activityFx) remote._activityFx.setPosition(remote.sprite.x, remote.sprite.y - 54);
        if (remote.pet) {
          this._stepPet(remote.pet, remote.sprite.x, remote.sprite.y, delta, remote.seated);
          this._setActorDepth(remote.pet, remote.pet.y, -1);
        }
        if (remote.chatBubble) remote.chatBubble.setPosition(remote.sprite.x, remote.sprite.y - 85);
      }
      if (this.localBubble) this.localBubble.setPosition(this.player.x, this.player.y - 78);

      this.nearbyCashier = !this.activity && !this._activityPending && !parkSeated
        ? this._nearbyCashier() : null;
      window.jpoSetNearbyCashier?.(this.nearbyCashier);
      if (cashierOpen) scheduleCashierBubblePosition();
      const nearbyParkSeat = !this.nearbyCashier && !this.activity && !this._activityPending
        ? this._nearbyParkSeat() : null;
      const nearbyAction = !this.activity && !this._activityPending && !nearbyParkSeat &&
        (this.location.startsWith('home:') || this.location === 'furniture-shop')
        ? this._nearbyInteractiveAction() : null;
      const touchButton = document.getElementById('touch-action');
      if (touchButton) {
        const touchAvailable = !!(this.nearbyCashier || nearbyParkSeat || nearbyAction ||
          this.activity || parkSeated);
        touchButton.classList.toggle('disabled', !touchAvailable);
        touchButton.textContent = this.nearbyCashier ? 'Talk' : 'E';
      }
      if (!this.portalRelease && !this._insidePortal(this.player.x, this.player.y)) this.portalRelease = true;
      // Use an inner doorway that is derived from the authoritative foot
      // radius. The former fixed 12px inset included facade-overlap strips in
      // 72px doors, so a client could request travel from a point the server
      // correctly rejected as inside the adjacent wall.
      const door = this.doors.find((item) => {
        const inner = this._portalInnerBounds(item);
        return this.player.x >= inner.left && this.player.x <= inner.right &&
          this.player.y >= inner.top && this.player.y <= inner.bottom;
      });
      const unfinishedLot = this.location === 'neighborhood' && (this.info.streetLots || []).find((lot) =>
        !lot.construction?.complete &&
        Math.hypot(this.player.x - lot.returnSpawn.x, this.player.y - lot.returnSpawn.y) <= 105,
      );
      if (door) this.interactHint.setText('Walking through…').setPosition(this.player.x, this.player.y - 65).setVisible(true);
      else if (unfinishedLot) this.interactHint.setText(unfinishedLot.ownerEmail === globals()._playerEmail
        ? 'Your lot · use Construction panel' : 'Home under construction · roof needed')
        .setPosition(this.player.x, this.player.y - 65).setVisible(true);
      else if (this.activity) this.interactHint.setText('[E] Stand').setPosition(this.player.x, this.player.y - 65).setVisible(true);
      else if (this._parkSeatPending === 'stand') this.interactHint.setText('Standing…').setPosition(this.player.x, this.player.y - 65).setVisible(true);
      else if (parkSeated) this.interactHint.setText('[E] Stand').setPosition(this.player.x, this.player.y - 65).setVisible(true);
      else if (this.nearbyCashier) this.interactHint.setText('[E] Talk to ' + this.nearbyCashier.name).setPosition(this.player.x, this.player.y - 65).setVisible(true);
      else if (nearbyParkSeat) this.interactHint.setText('[E] Sit').setPosition(this.player.x, this.player.y - 65).setVisible(true);
      else if (nearbyAction) {
        const actions = nearbyAction.actions;
        const actionId = (action) => typeof action === 'string' ? action : action?.id;
        const actionLabel = (action) => typeof action === 'object' && action?.label
          ? action.label
          : ({
            sit: 'Sit', lie: 'Lie down', sleep: 'Sleep', shower: 'Shower',
            bathe: 'Bathe', watch: 'Watch TV', toggle_water: 'Turn on water',
          })[actionId(action)] || 'Use';
        const primary = actionLabel(actions[0]);
        const secondaryAction = actions[1];
        const secondary = secondaryAction
          ? ' · [Shift+E] ' + actionLabel(secondaryAction)
          : '';
        this.interactHint.setText('[E] ' + primary + secondary).setPosition(this.player.x, this.player.y - 65).setVisible(true);
      }
      else this.interactHint.setVisible(false);
      if (door && this.portalRelease && !this.transitionRequested) {
        // Each door carries the visible lot's canonical account address. No
        // page number or client-selected directory entry can form a target.
        const resident = door.residence ? directory.find((home) => Number(home.lotIndex) === Number(door.lot)) : null;
        const destination = door.destination === 'home'
          ? ('home:' + (door.residence
            ? (door.ownerEmail || resident?.ownerEmail || '')
            : (globals()._playerEmail || '')))
          : door.destination;
        if (destination !== 'home:') {
          this.transitionRequested = true;
           // The movement stream is rate-limited on the server. Previously a
           // fresh portal packet could arrive inside that short throttle window
           // and be dropped, so transition validation saw the last point just
           // outside the door (most noticeable at the home exit). Hold still,
           // then send a guaranteed newer authoritative foot position before
           // asking for the map change.
           body.setVelocity(0, 0);
           const portalPoint = { x: this.player.x, y: this.player.y, dir: this.playerDir };
           const generation = this._portalTravelGeneration;
           this._portalMoveTimer = setTimeout(() => {
             this._portalMoveTimer = null;
             if (!this.scene.isActive() || !this.transitionRequested || generation !== this._portalTravelGeneration) return;
              movement?.sendReliable(this.location, { ...portalPoint, anim: 'idle' });
             this._portalTravelTimer = setTimeout(() => {
               this._portalTravelTimer = null;
               if (!this.scene.isActive() || !this.transitionRequested || generation !== this._portalTravelGeneration) return;
               window.jpoBeginMapFade?.();
                 travel(destination);
             }, 38);
           }, 42);
        }
      }
      // Consume E even while the speech bubble is open. Otherwise a key press
      // made during dialogue can remain "just down" and trigger an unrelated
      // world interaction on the first frame after closing it.
      const actionKeyDown = Phaser.Input.Keyboard.JustDown(this.keyE);
      const doAction = !cashierDialogOpen && (actionKeyDown || touchAction.queued);
      touchAction.queued = false;
      if (doAction) {
        if (this.activity || this._activityPending) this._leaveFurnitureActivity('exit');
        else if (this.staticSeatState) this._leaveParkSeat('exit');
        else if (this.nearbyCashier) this._interactCashier();
        else if (nearbyParkSeat) this._requestParkSeat();
        else this._requestFurnitureAction();
      }
      const parkTarget = this._parkSeatPending === 'stand' ? this._parkSeatExitTarget
        : this._parkSeatPending === 'sit' ? this._parkSeatSitTarget : null;
      // Furniture activity owns an authoritative server anchor. Do not send
      // periodic playerMove packets while an interaction is pending or while
      // seated/lying in a showroom or home:
      // commercial collision blockers do not exclude a showroom demo body, so
      // echoing the action anchor would produce a correction without
      // `activity`, and correctLocal() would immediately clear the accepted
      // local activity. Explicit E/movement exits still send their reliable
      // stand packet through _leaveFurnitureActivity().
      if (!this.activity && !this._activityPending) {
        movement?.tick(delta, this.location, {
          x: parkTarget?.x ?? this.player.x, y: parkTarget?.y ?? this.player.y,
          dir: parkTarget?.dir || this.playerDir, anim,
        });
      }
    }

    shutdown() {
      this._neighborhoodReady = false;
      if (window._neighborhoodScene === this) window.jpoCloseCashier?.();
      this._performanceCleanup?.();
      if (this._outdoorWheelHandler) this.game.canvas.removeEventListener('wheel', this._outdoorWheelHandler);
      this._outdoorWheelHandler = null;
      this._clearActivityEffect(this);
      Object.values(this.remotes || {}).forEach((entry) => this._clearActivityEffect(entry));
      this._resetTransientTravel();
      this._removePlacementInput();
      this._teardownPlacement();
      teardownPlacement();
      (this._ambientTweens || []).forEach((tween) => tween?.remove?.());
      this._ambientTweens = [];
      this.portalCues?.forEach((object) => object.destroy());
      this.portalCues = [];
      window.jpoSetConstructionLot?.(null);
      this._clearLocalPresentation();
      Object.keys(this.remotes).forEach((id) => this._removeRemote(id));
      this.remotes = {};
      this.furniture = [];
      this.cashierNpcs?.forEach((entry) => {
        entry.sprite?.destroy?.();
        entry.nameTag?.destroy?.();
      });
      this.cashierNpcs = [];
      this.nearbyCashier = null;
      this.showroomFurniture?.forEach((object) => object?.destroy?.());
      this.showroomFurniture = [];
      this.showroomInteractions?.clear?.();
      this.streetLotsVisual = null;
      this._streetPortalVisuals = null;
      this.localBubble = null;
      this.player = null;
      this.localNameTag = null;
      this.interactHint = null;
      this._groundTiles = null;
      this._groundMask?.destroy?.();
      this._groundMaskGraphics?.destroy?.();
      this._groundMask = null;
      this._groundMaskGraphics = null;
      this._streetScenerySegments?.forEach((objects) => objects.forEach((object) => object?.destroy?.()));
      this._streetScenerySegments = null;
      this._geometryBlocks = this._yardBlocks = this._furnitureBlocks = null;
      this.keys = this.wasd = this.keyE = this.keyShift = null;
      if (window._neighborhoodScene === this) window._neighborhoodScene = null;
    }
  }

  socket.on('locationTransitionResult', (result) => {
    if (Number.isSafeInteger(result?.transitionSequence)) {
      if (result.transitionSequence <= lastServerTransitionSequence) return;
      lastServerTransitionSequence = result.transitionSequence;
    }
    const generation = ++sceneTransitionGeneration;
    cancelSceneReadinessWait();
    clearTimeout(sceneTransitionTimer);
    sceneTransitionTimer = null;
    if (!result?.ok) {
      officePortalTransition = false;
      const active = window._phaserGame?.scene?.getScenes(true)?.find((scene) =>
        scene.scene.key === 'NeighborhoodScene' || scene.scene.key === 'OfficeScene');
      const camera = active?.cameras?.main;
      if (active && camera) {
        active._portalFading = false;
        active._portalFadeAt = 0;
        camera.fadeIn(160, 16, 22, 34);
      }
      if (window._neighborhoodScene) {
        window._neighborhoodScene.transitionRequested = false;
        // A denied doorway must be left before it can trigger another fade.
        window._neighborhoodScene.portalRelease = false;
        window._neighborhoodScene.interactHint?.setVisible(false);
      }
      if (result?.message) toast(result.message);
      return;
    }
    const game = window._phaserGame;
    if (!game) return;
    const outgoing = game.scene.getScenes(true).find((scene) => scene.scene.key === 'OfficeScene' || scene.scene.key === 'NeighborhoodScene');
    const finish = () => {
      // A delayed fade completion belongs to an older server result. In
      // particular, it must not stop a newly restarted shared scene.
      if (generation !== sceneTransitionGeneration) return;
      teardownPlacement();
      closeCashier();
      nearbyCashier = null;
      currentLocation = result.location;
      title.textContent = result.map?.label || result.location;
      furnitureCatalog = result.catalog || furnitureCatalog;
      showroomDemos = currentLocation === 'furniture-shop' && Array.isArray(result.showroom)
        ? result.showroom : [];
      if (currentLocation === 'furniture-shop' && !showroomDemos.length) {
        socket.emit('furnitureShowroomRequest');
      }
      // A home owner may switch accounts/addresses during one browser
      // session. Never reuse the previous owner's people list.
      homePeople = [];
      homePeopleLoaded = false;
      activeHomePeopleRequestId = ++homePeopleRequestId;
      // A transition changes the owner context. Never carry the previous
      // home's full inventory/layout into a new address while its snapshot is
      // still in flight.
      homeState = null;
      pendingReturnIds.clear();
      if (typeof result.self?.homeColor === 'string' || typeof result.homeColor === 'string') {
        ownExteriorColor = result.self?.homeColor || result.homeColor;
      }
      if (isHome()) {
        if (result.home) applyHomeState(result.home);
        editorOpen = !!homeState?.canEdit;
        requestDirectory();
        renderHome();
      } else {
        selectedInstance = null;
        if (isResidentialBlock()) {
          requestDirectory();
          renderHome();
        } else homePanel.hidden = true;
      }
      renderShop();
      if (result.location === 'office') {
        const office = game.scene.getScene('OfficeScene');
        const officeSleeping = game.scene.isSleeping('OfficeScene');
        const officeActive = game.scene.isActive('OfficeScene');
        const needsOfficeLifecycle = officeSleeping || !officeActive ||
          !sceneRuntimeReady(office, 'office');
        // Register before queueing wake/start. Phaser SceneManager operations
        // are deferred, and a cold OfficeScene has no camera/player/keyboard
        // objects until CREATE has fully returned.
        const wait = waitForSceneReady(
          office, 'office', generation,
          officeSleeping ? sceneWakeEvent : sceneCreateEvent,
          needsOfficeLifecycle,
          (target) => {
            if (generation !== sceneTransitionGeneration) return;
            const spawn = result.self || result.spawn;
            if (Number.isFinite(spawn?.x) && Number.isFinite(spawn?.y)) {
              target.player.setPosition(spawn.x, spawn.y);
              target.player.body?.reset(spawn.x, spawn.y);
            }
            target._syncOfficePlayers?.(result.players || {});
            target._portalFading = false;
            target._portalFadeAt = 0;
            target.cameras.main.fadeIn(220, 16, 22, 34);
            officePortalRelease = false;
            officePortalTransition = false;
          },
        );
        // Stopping a scene that is already inactive is harmless; importantly,
        // this branch is generation-gated so an old home/street result cannot
        // stop the currently active shared scene.
        if (game.scene.isActive('NeighborhoodScene')) game.scene.stop('NeighborhoodScene');
        if (officeSleeping) game.scene.wake('OfficeScene');
        else if (!officeActive) game.scene.start('OfficeScene');
        wait?.tryApply?.();
      } else {
        // OfficeScene was already asleep after the first outdoor transition;
        // Phaser warns (and some builds interrupt the next scene lifecycle)
        // when asked to sleep it again.
        if (game.scene.isActive('OfficeScene')) game.scene.sleep('OfficeScene');
        const sceneData = { ...result, _sceneTransitionGeneration: generation };
        const neighborhood = game.scene.getScene('NeighborhoodScene');
        const neighborhoodActive = game.scene.isActive('NeighborhoodScene');
        // NeighborhoodScene is deliberately shared by city, street, shop and
        // homes. Starting an already-active key queues a stop/start pair; a
        // second delayed result could then leave its replacement stopped.
        // Register before restart/start, and let CREATE own all spawn/roster/
        // fade application after the queued lifecycle has actually completed.
        const wait = waitForSceneReady(
          neighborhood, result.location, generation, sceneCreateEvent,
          true,
          (target) => {
            if (generation !== sceneTransitionGeneration) return;
            const spawn = result.self || result.spawn;
            if (Number.isFinite(spawn?.x) && Number.isFinite(spawn?.y)) {
              target.player.setPosition(spawn.x, spawn.y);
              target.player.body?.reset(spawn.x, spawn.y);
              target.playerDir = spawn.dir || target.playerDir;
            }
            target.syncPlayers(result.players || {});
            target._portalFading = false;
            target._portalFadeAt = 0;
            target.cameras.main.fadeIn(220, 16, 22, 34);
          },
        );
        if (neighborhoodActive) neighborhood.scene.restart(sceneData);
        else game.scene.start('NeighborhoodScene', sceneData);
        wait?.tryApply?.();
      }
    };
    const elapsed = outgoing?._portalFading ? performance.now() - (outgoing._portalFadeAt || performance.now()) : 0;
    if (outgoing?._portalFading && elapsed < 220) {
      sceneTransitionTimer = setTimeout(() => {
        sceneTransitionTimer = null;
        finish();
      }, 220 - elapsed);
    }
    else finish();
  });

  // OfficeScene creates the local player from the approved payload. If a
  // transition result wins the same tick as a cold approval/create lifecycle,
  // CREATE can be observed before that payload has built the player. Re-check
  // the single pending waiter on approval; this is event-driven and bounded,
  // not a retry loop or a growing scene-listener chain.
  socket.on('approved', () => sceneReadinessWait?.tryApply?.());

  const activeNeighborhood = () => {
    const scene = window._neighborhoodScene;
    return scene?.scene?.isActive?.() && scene._neighborhoodReady ? scene : null;
  };
  socket.on('currentPlayers', (players) => activeNeighborhood()?.syncPlayers(players || {}));
  socket.on('playerJoined', (player) => activeNeighborhood()?.addRemote(player?.id, player));
  socket.on('playerMoved', (player) => activeNeighborhood()?.moveRemote(player));
  socket.on('playerMoveCorrection', (player) => {
    const neighborhood = activeNeighborhood();
    if (neighborhood) return neighborhood.correctLocal(player);
    const office = window._phaserGame?.scene?.getScene('OfficeScene');
    if (office?.player && (!player?.location || player.location === 'office') &&
        window.JpoFocusedMovement?.shouldApplyCorrection(player, 'office', office._lastCorrectionSeq ?? -1)) {
      if (Number.isSafeInteger(player.seq)) office._lastCorrectionSeq = player.seq;
      office.player.setPosition(player.x, player.y);
      office.player.body?.reset(player.x, player.y);
    }
  });
  socket.on('playerLeft', (id) => activeNeighborhood()?._removeRemote(id));
  socket.on('chatMessage', (payload) => {
    if (typeof payload?.message === 'string') window._neighborhoodScene?.showChat(payload.id, payload.message);
  });
  socket.on('chatImage', (payload) => window._neighborhoodScene?.showChat(payload?.id, '📷 shared a photo'));
  socket.on('shopSuccess', () => activeNeighborhood()?._setLocalPresentation());
  socket.on('equipUpdate', () => activeNeighborhood()?._setLocalPresentation());
  socket.on('outfitSuccess', () => activeNeighborhood()?._setLocalPresentation());
  socket.on('avatarSuccess', () => activeNeighborhood()?._setLocalPresentation());
  socket.on('petSuccess', () => activeNeighborhood()?._setLocalPresentation());
  socket.on('petUpdate', () => activeNeighborhood()?._setLocalPresentation());
  socket.on('petAccSuccess', () => activeNeighborhood()?._setLocalPresentation());
  socket.on('petAccUpdate', () => activeNeighborhood()?._setLocalPresentation());
  socket.on('petEvolved', (payload) => { if (payload?.id === socket.id) activeNeighborhood()?._setLocalPresentation(); });
  socket.on('playerOutfitUpdate', (payload) => {
    if (payload?.id && payload.id !== socket.id) window._neighborhoodScene?._refreshRemoteWear(payload.id, payload);
  });
  socket.on('playerCosmeticUpdate', (payload) => {
    if (payload?.id && payload.id !== socket.id) window._neighborhoodScene?._refreshRemoteWear(payload.id, payload);
  });
  socket.on('playerPetUpdate', (payload) => {
    if (payload?.id && payload.id !== socket.id) window._neighborhoodScene?._refreshRemotePet(payload.id, payload);
  });

  window.NeighborhoodScene = NeighborhoodScene;
};