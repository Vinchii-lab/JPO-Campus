// Shared city / home presentation. Server transitions, permissions, placement,
// and movement validation remain authoritative in server.js / neighborhood.mjs.
window.initNeighborhoodUI = function(socket, getGlobals) {
  if (document.getElementById('neighborhood-ui')) return;

  const ui = document.createElement('div');
  ui.id = 'neighborhood-ui';
  // This is a location plaque, deliberately not a travel menu.
  ui.innerHTML = '<div id="neighborhood-nav"><span id="neighborhood-title">JPO HQ</span><button id="neighborhood-panel-toggle" type="button" aria-controls="home-panel shop-panel" hidden>Hide panel</button></div>' +
    '<div id="home-panel" hidden></div>';
  document.body.appendChild(ui);

  const title = ui.querySelector('#neighborhood-title');
  const homePanel = ui.querySelector('#home-panel');
  let homeState = null;
  let furnitureCatalog = {};
  let selectedInstance = null;
  let selectedRotation = 0;
  let selectedZone = 'indoor';
  let editorOpen = false;
  let currentLocation = 'office';
  let panelsCollapsed = false;
  try { panelsCollapsed = localStorage.getItem('jpo-neighborhood-panels-collapsed') === 'true'; } catch (_) {}
  const panelToggle = ui.querySelector('#neighborhood-panel-toggle');
  function syncPanelControls() {
    ui.classList.toggle('panels-collapsed', panelsCollapsed);
    panelToggle.hidden = !(currentLocation === 'neighborhood' || currentLocation.startsWith('home:') || currentLocation.endsWith('-shop') || ['cafe', 'diner', 'bakery', 'sushi'].includes(currentLocation));
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
  // A socket result can arrive while the prior map's cosmetic fade is still
  // pending. Keep one presentation generation and timer: an old completion
  // must never stop/restart the scene selected by a newer completion.
  let sceneTransitionGeneration = 0;
  let lastServerTransitionSequence = 0;
  socket.on('disconnect', () => { lastServerTransitionSequence = 0; });
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
  const FURNITURE_ASSET_REVISION = 'native-3x-living-room-20260827';
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
  // (columns 2–3, rows 74–76). It is deliberately proximity-only: no action
  // key and no travel button can bypass the walk through the garden.
  window.jpoTryOfficePortal = function(player, dir) {
    if (currentLocation !== 'office' || !player) return false;
    const inGate = player.x >= 96 && player.x <= 192 && player.y >= 3552 && player.y <= 3696;
    if (!inGate) { officePortalRelease = true; return false; }
    // The direct move packet can trail one visual frame. Require an interior
    // point so that normal 50ms packet latency still lands inside the server's
    // authoritative larger portal rather than correcting the player back.
    const inside = player.x >= 112 && player.x <= 176 && player.y >= 3564 && player.y <= 3684;
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
    if (!isHome() || !homeState) {
      if (!isResidentialBlock()) {
        homePanel.hidden = true;
        window.jpoHouseColors?.render(homePanel);
        return;
      }
      homePanel.hidden = false;
      const homes = directory;
      homePanel.innerHTML =
        '<div class="home-panel-head"><b>Willow Walk</b><button type="button" data-collapse>Hide</button></div>' +
        '<div class="home-section home-directory"><small>' + homes.length +
        ' approved homes · every address is a persistent account lot on this one street.</small>' +
        (homes.length ? homes.map((home) => '<span class="home-directory-item"><small>Lot ' + home.lotIndex + ' · </small>' +
          escapeHtml(home.name || home.ownerEmail) + ' <small>(' + escapeHtml(home.accessMode) + ')</small></span>').join('') :
          '<small>No homes available yet.</small>') +
        '</div>' +
        constructionMarkup() +
        (homeState?.canEdit
          ? '<div class="home-section"><small>Your fenced yard · choose an owned item, then click a clear square in your yard.</small>' +
            (Array.isArray(homeState.inventory) && homeState.inventory.length
              ? homeState.inventory.map((item) => '<span class="home-item ' + (selectedInstance === item.id ? 'selected' : '') + '">' +
                escapeHtml(furnitureCatalog[item.furnitureId]?.name || item.furnitureId) +
                '<button type="button" data-yard-select="' + escapeHtml(item.id) + '">Place outside</button></span>').join('')
              : '<small>No unplaced furniture. Visit Huddle Home for furnishings or store an item from your room.</small>') +
            (Array.isArray(homeState.yard) && homeState.yard.length
              ? '<small>Yard items</small>' + homeState.yard.map((item) => '<span class="home-item">' +
                escapeHtml(furnitureCatalog[item.furnitureId]?.name || item.furnitureId) +
                '<button type="button" data-yard-move="' + escapeHtml(item.id) + '">Move</button>' +
                '<button type="button" data-return="' + escapeHtml(item.id) + '">Store</button></span>').join('')
              : '') + '</div>' : '') +
        '<small class="home-panel-note">Walk to a lit front door to visit. Visitors can look, but only the owner can decorate.</small>';
      homePanel.querySelector('[data-collapse]').onclick = () => { homePanel.hidden = true; };
      const directoryBody = homePanel.querySelector('.home-directory');
      const directoryNote = homePanel.querySelector('.home-panel-note');
      const toggleDirectory = homePanel.querySelector('[data-collapse]');
      directoryBody.hidden = true;
      directoryNote.hidden = true;
      toggleDirectory.textContent = 'Open';
      toggleDirectory.onclick = () => {
        directoryBody.hidden = !directoryBody.hidden;
        directoryNote.hidden = directoryBody.hidden;
        toggleDirectory.textContent = directoryBody.hidden ? 'Open' : 'Close';
        scheduleHudReservation();
      };
      homePanel.querySelectorAll('[data-yard-select]').forEach((button) => {
        button.onclick = () => {
          selectedInstance = button.dataset.yardSelect;
          selectedRotation = 0;
          selectedZone = 'yard';
          toast('Click an open square in your fenced yard.');
          renderHome();
        };
      });
      homePanel.querySelectorAll('[data-build]').forEach((button) => {
        button.onclick = () => {
          const componentId = button.dataset.build;
          if (componentId && window.confirm('Build this component with coins? This is a one-time purchase.')) {
            socket.emit('homeConstructionPurchase', { componentId });
          }
        };
      });
      homePanel.querySelectorAll('[data-return]').forEach((button) => {
        button.onclick = () => socket.emit('homeLayoutReturn', { instanceId: button.dataset.return });
      });
      homePanel.querySelectorAll('[data-yard-move]').forEach((button) => {
        button.onclick = () => {
          selectedInstance = button.dataset.yardMove;
          selectedRotation = 0;
          selectedZone = 'yard';
          toast('Click a new open square in your fenced yard.');
          renderHome();
        };
      });
      window.jpoHouseColors?.render(homePanel);
      return;
    }
    homePanel.hidden = false;
    const canEdit = homeState.canEdit === true;
    const inventory = Array.isArray(homeState.inventory) ? homeState.inventory : [];
    const layout = Array.isArray(homeState.layout) ? homeState.layout : [];
    const itemName = (item) => furnitureCatalog[item.furnitureId]?.name || item.furnitureId;
    const inventoryMarkup = inventory.map((item) =>
      '<span class="home-item ' + (selectedInstance === item.id ? 'selected' : '') + '">' +
        '<span>' + escapeHtml(itemName(item)) + '</span>' +
        '<button type="button" data-select="' + escapeHtml(item.id) + '">Place</button></span>',
    ).join('') || '<small>No unplaced furniture yet.</small>';
    const layoutMarkup = layout.map((item) =>
      '<span class="home-item"><span>' + escapeHtml(itemName(item)) + ' (' + item.gridX + ',' + item.gridY + ')</span>' +
        '<button type="button" data-move="' + escapeHtml(item.id) + '">Move</button>' +
        '<button type="button" data-return="' + escapeHtml(item.id) + '">Store</button></span>',
    ).join('') || '<small>Your room is ready to furnish.</small>';
    const directoryMarkup = directory.length
      ? directory.map((home) => '<span class="home-directory-item">' + escapeHtml(home.name || home.ownerEmail) +
          ' <small>(' + escapeHtml(home.accessMode) + ')</small></span>').join('')
      : '<small>No homes available to visit.</small>';

    const editor = canEdit ? (
      '<div class="home-section home-editor-controls">' +
        '<label>Access <select id="home-access"><option value="public">Public</option><option value="invite_only">Invite only</option><option value="private">Private</option></select></label>' +
        '<button type="button" data-access>Save</button>' +
        '<div class="home-invite"><input id="home-invite-email" type="email" maxlength="80" placeholder="coworker@email.com"><button type="button" data-invite>Invite</button></div>' +
        (Array.isArray(homeState.invitations) && homeState.invitations.length
          ? '<small>Invited</small>' + homeState.invitations.map((invite) =>
              '<span class="home-item">' + escapeHtml(invite.name || invite.email) +
              '<button type="button" data-revoke="' + escapeHtml(invite.email) + '">Revoke</button></span>',
            ).join('')
          : '') +
        '<small>How furnishing works: buy at Huddle Home, return here, choose “Place” from Inventory, then click a clear floor tile. The front mat and exit path stay clear. Furniture uses supplied upright artwork, so rotation is unavailable.</small>' +
        '<small>Inventory — bought items waiting to place</small>' + inventoryMarkup +
        '<small>Placed items</small>' + layoutMarkup +
      '</div>'
    ) : '<div class="home-section"><small>The owner controls this room. Furniture updates live.</small></div>';

    homePanel.innerHTML =
      '<div class="home-panel-head"><b>' + (canEdit ? 'Your starter home' : 'Visiting a home') +
      '</b><button type="button" data-collapse>' + (editorOpen ? 'Collapse' : 'Open panel') + '</button></div>' +
        '<div class="home-section home-directory"><small>Willow Walk neighbors — each glowing home door belongs to this permanent lot.</small>' +
      directoryMarkup + '</div>' +
      (editorOpen ? editor : (canEdit ? '<small class="home-panel-note">Open panel to place, store, or manage your home.</small>' : ''));

    homePanel.querySelector('[data-collapse]').onclick = () => { editorOpen = !editorOpen; renderHome(); };
    homePanel.querySelectorAll('[data-select]').forEach((button) => {
      button.onclick = () => {
        selectedInstance = button.dataset.select;
        selectedRotation = 0;
        selectedZone = 'indoor';
        editorOpen = true;
        renderHome();
      };
    });
    homePanel.querySelectorAll('[data-return]').forEach((button) => {
      button.onclick = () => socket.emit('homeLayoutReturn', { instanceId: button.dataset.return });
    });
    homePanel.querySelectorAll('[data-move]').forEach((button) => {
      button.onclick = () => {
        selectedInstance = button.dataset.move;
        selectedRotation = 0;
        selectedZone = 'indoor';
        editorOpen = true;
        renderHome();
      };
    });
    const access = homePanel.querySelector('#home-access');
    if (access) access.value = homeState.accessMode || 'public';
    homePanel.querySelector('[data-access]')?.addEventListener('click', () => {
      socket.emit('homeAccessSet', { mode: homePanel.querySelector('#home-access').value });
    });
    homePanel.querySelector('[data-invite]')?.addEventListener('click', () => {
      socket.emit('homeInvite', { email: homePanel.querySelector('#home-invite-email').value });
    });
    homePanel.querySelectorAll('[data-revoke]').forEach((button) => {
      button.onclick = () => socket.emit('homeInviteRevoke', { email: button.dataset.revoke });
    });
    // The color module uses safe DOM APIs and adds its owner-only controls only
    // after this renderer has rebuilt the panel.
    window.jpoHouseColors?.render(homePanel);
  }

  function renderShop() {
    syncPanelControls();
    let panel = document.getElementById('shop-panel');
    if (typeof currentLocation !== 'string' || (!currentLocation.endsWith('-shop') && !['cafe', 'diner', 'bakery', 'sushi'].includes(currentLocation))) {
      if (panel) panel.hidden = true;
      return;
    }
    if (!panel) {
      panel = document.createElement('div');
      panel.id = 'shop-panel';
      ui.appendChild(panel);
    }
    panel.hidden = false;

    const isRestaurant = ['cafe', 'diner', 'bakery', 'sushi'].includes(currentLocation);
    const shopCopy = {
      'furniture-shop': { title: 'Huddle Home', category: 'Furnishings', copy: 'Comfort pieces for your Willow Walk home.' },
      'garden-shop': { title: 'Willow & Green', category: 'Garden goods', copy: 'Leafy accents and a sunny seat for your home or yard.' },
      'decor-shop': { title: 'Plaza Decor', category: 'Living-room accents', copy: 'Statement pieces for a warm, lived-in room.' },
      'cafe': { title: 'The Daily Grind', category: 'Cafe', copy: 'Fresh coffee and pastries. Have a seat and enjoy the vibe!', isMenu: true },
      'diner': { title: 'Neon Diner', category: 'American Diner', copy: 'Classic burgers and milkshakes.', isMenu: true },
      'bakery': { title: 'Sweet Crust', category: 'Bakery', copy: 'Artisan bread and delicious cakes baked daily.', isMenu: true },
      'sushi': { title: 'Sakura Sushi', category: 'Sushi Restaurant', copy: 'Fresh rolls directly from the conveyor.', isMenu: true },
    }[currentLocation] || { title: 'Huddle shop', category: 'Home goods', copy: 'Furniture for your Willow Walk home.' };

    const menuItems = {
      cafe: ['Espresso', 'Latte', 'Matcha', 'Croissant', 'Muffin'],
      diner: ['Classic Burger', 'Cheeseburger', 'Fries', 'Vanilla Shake', 'Cherry Pie'],
      bakery: ['Sourdough', 'Baguette', 'Cupcake', 'Chocolate Cake', 'Macaron'],
      sushi: ['Salmon Nigiri', 'Tuna Sashimi', 'Dragon Roll', 'Edamame', 'Green Tea']
    };

    let rows = '';
    if (isRestaurant) {
       rows = (menuItems[currentLocation] || []).map(item =>
         '<span class="home-item"><span>' + escapeHtml(item) + '</span><small class="menu-only-label">Menu Only</small></span>'
       ).join('');
    } else {
       rows = Object.values(furnitureCatalog).map((item) =>
         '<span class="home-item"><span>' + escapeHtml(item.name) + ' · ' +
         Number(item.price).toLocaleString() + ' coins</span><button type="button" data-buy="' +
         escapeHtml(item.id) + '">Buy</button></span>',
       ).join('') || '<small>The catalog is loading.</small>';
    }

    const tipCopy = isRestaurant ? 'This is a reference menu. Food purchasing is not yet supported, but please enjoy the ambiance.' : 'Prices are coins; Buy adds the item to your home Inventory. Leave through the glowing PLAZA exit, walk to your permanent Willow Walk lot, then place it indoors or in your yard.';
panel.innerHTML = '<div class="home-panel-head"><b>' + escapeHtml(shopCopy.title) + ' · ' + escapeHtml(shopCopy.category) + '</b><button type="button" data-close>Close</button></div>' +
        '<div class="home-section"><small>' + escapeHtml(shopCopy.copy) + ' ' + tipCopy + '</small>' + rows + '</div>';
    panel.querySelector('[data-close]').onclick = () => { setPanelsCollapsed(true); };
    panel.querySelectorAll('[data-buy]').forEach((button) => {
      button.onclick = () => socket.emit('homePurchase', { furnitureId: button.dataset.buy });
    });
  }

  window.initHouseColors?.(socket, () => ({
    get homeState() { return homeState; },
    get currentLocation() { return currentLocation; },
    get scene() { return window._neighborhoodScene; },
    toast,
    setHomeState(state) {
      homeState = state;
      if (state?.canEdit && state.exteriorColor) {
        ownExteriorColor = state.exteriorColor;
        window._neighborhoodScene?.setOwnHomeColor(ownExteriorColor);
      }
      window._neighborhoodScene?.renderFurniture(state);
    },
    rerenderHome: renderHome,
  }));

  requestDirectory();
  socket.on('homeDirectory', (payload) => {
    // Ignore delayed directory replies. Street lots are canonical account
    // addresses and never depend on a pagination page.
    if (Number.isInteger(payload?.requestId) && payload.requestId !== activeDirectoryRequestId) return;
    directory = Array.isArray(payload) ? payload : (Array.isArray(payload?.homes) ? payload.homes : []);
    if (payload?.error) toast(payload.error);
    window._neighborhoodScene?.updateResidenceDirectory(directory);
    if (isResidentialBlock()) socket.emit('homeSnapshotRequest');
    renderHome();
  });
  socket.on('homeSnapshot', (state) => {
    if (!state || typeof state !== 'object') return;
    homeState = state;
    if (state.canEdit && state.exteriorColor) {
      ownExteriorColor = state.exteriorColor;
      window._neighborhoodScene?.setOwnHomeColor(ownExteriorColor);
    }
    window._neighborhoodScene?.renderFurniture(state);
    renderHome();
  });
  socket.on('homePurchaseResult', (result) => {
    if (result?.home) homeState = result.home;
    if (result?.message) toast(result.message);
    else if (result?.ok) {
      const name = furnitureCatalog[result.item?.furnitureId]?.name || 'Furniture';
      toast(name + ' purchased — added to your home inventory.');
    }
    if (isHome()) renderHome();
  });
  socket.on('homeConstructionResult', (result) => {
    if (result?.home) homeState = result.home;
    if (result?.message) toast(result.message);
    if (isResidentialBlock()) renderHome();
  });
  socket.on('homeActionResult', (result) => {
    // A mutation always ends its placement gesture. This prevents a stale
    // preview from being re-used after either a server rejection or a move.
    selectedInstance = null;
    selectedRotation = 0;
    selectedZone = 'indoor';
    window._neighborhoodScene?.clearPlacementPreview?.();
    if (isHome() || isResidentialBlock()) renderHome();
    if (result?.message) toast(result.message);
  });
  socket.on('homeAccessResult', (result) => {
    if (result?.ok && homeState) {
      homeState.accessMode = result.mode;
      renderHome();
    }
    if (result?.message) toast(result.message);
  });
  socket.on('homeInviteResult', (result) => {
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
  socket.on('homeEjected', (result) => toast(result?.message || 'You left the home.'));
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
          instanceId: payload.instanceId, furnitureId: payload.furnitureId,
          action: payload.action, effect: payload.effect, orientation: payload.orientation,
          x: payload.x, y: payload.y,
        }, payload);
      } else if (payload.phase === 'stop') {
        scene._setLocalActivity(null, payload);
      }
      return;
    }
    const remote = scene.remotes[payload.id];
    if (!remote) return;
    if (payload.phase === 'start' && payload.action) {
      remote.activity = {
        instanceId: payload.instanceId, furnitureId: payload.furnitureId,
        action: payload.action, effect: payload.effect, orientation: payload.orientation,
        x: payload.x, y: payload.y,
      };
      scene._applyActivityPose(remote, remote.activity, payload.dir || remote.lastDir || 'down');
    } else if (payload.phase === 'stop') {
      remote.activity = null;
      scene._applyActivityPose(remote, null, payload.dir || remote.lastDir || 'down');
    }
  });

  class NeighborhoodScene extends Phaser.Scene {
    constructor() {
      super('NeighborhoodScene');
      this.remotes = {};
      this.furniture = [];
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
      // These names deliberately do not overlap the old generic `furn_*`
      // texture keys. The URL revision is equally deliberate: furniture files
      // were replaced in place and the server legitimately caches PNGs for a
      // day, which otherwise left an already-open browser decoding the former
      // oversized artwork under a new scene.
      const furnitureAssets = {
        oak_chair: '/assets/neighborhood/furniture/oak_chair.png',
        fern: '/assets/neighborhood/furniture/fern.png',
        reading_lamp: '/assets/neighborhood/furniture/reading_lamp.png',
        coffee_table: '/assets/neighborhood/furniture/coffee_table.png',
        blue_sofa: '/assets/neighborhood/furniture/blue_sofa.png',
        bookcase: '/assets/neighborhood/furniture/bookcase.png',
        bed: '/assets/neighborhood/interiors/bedroom_bed.png',
        bathtub: '/assets/room-furniture/animated_bathtub_with_duck.png',
        television: '/assets/TV_Studio_16x16.png',
      };
      Object.entries(furnitureAssets).forEach(([id, path]) => {
        this.load.image(this._furnitureTextureKey(id), path + (path.includes('?') ? '&' : '?') + 'v=' + FURNITURE_ASSET_REVISION);
      });
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
      ['oak_chair', 'fern', 'reading_lamp', 'coffee_table', 'blue_sofa', 'bookcase', 'bed', 'bathtub', 'television'].forEach((id) => {
        this.textures.get(this._furnitureTextureKey(id))?.setFilter(nearest);
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

    _furnitureTextureKey(id) {
      return 'home-furniture-v2:' + id;
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
      this._resetTransientTravel();
      this._removePlacementInput();
      this.remotes = {};
      this.furniture = [];
      this.streetLotsVisual = null;
      this.localBubble = null;
      this.localCosmetic = this.localWings = this.localPet = null;
      this.localCosmeticDef = this.localWingsDef = null;
      this.localSlotObjs = {};
      this.ghost = null;
      this.portalCues = [];
      this.player = null;
      this.localNameTag = null;
      this.interactHint = null;
      this._groundTiles = null;
      this._streetScenerySegments = null;
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
      const bounds = this.info.bounds || { width: this.info.width || 1152, height: this.info.height || 816 };
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
      this.player = this.physics.add.sprite(self.x || 24, self.y || 24, this.playerTexKey, g.DIR_START?.[this.playerDir] || 0)
        .setScale(3).setOrigin(0.5, 0.5).setDepth(self.y || 24);
      this.player.body.setSize(12, 10).setOffset(2, 20);
      this.player.body.setCollideWorldBounds(true);
      this.localNameTag = this._makeNameTag(this.player.x, this.player.y, g._playerName || self.name || 'You') ||
        this.add.text(this.player.x, this.player.y - 40, g._playerName || 'You', { fontSize: '14px', fontFamily: 'monospace', color: '#fff', backgroundColor: '#000000bb', padding: { x: 5, y: 3 } }).setOrigin(0.5, 1);
      this.localNameTag.setDepth((self.y || 24) + 2);
      this.cameras.main.startFollow(this.player);

      this._geometryBlocks = this.physics.add.staticGroup();
      this._yardBlocks = this.physics.add.staticGroup();
      this._furnitureBlocks = this.physics.add.staticGroup();
      (this.info.geometry?.blockers || []).forEach((block) =>
        this._addBlock(block.furnitureId ? this._yardBlocks : this._geometryBlocks, block));
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
        if (this.location !== 'neighborhood' && this.location !== 'city') return;
        event.preventDefault();
        this._setOutdoorZoom((this._outdoorZoomFactor || 1.15) *
          (event.deltaY < 0 ? 1.1 : 1 / 1.1));
      };
      this.game.canvas.addEventListener('wheel', this._outdoorWheelHandler, { passive: false });
      this._neighborhoodReady = true;
    }

    _tileField(base, alternate) {
      // A street with many accounts can be several map segments tall. The old
      // implementation retained thousands of Graphics commands for its ground
      // (fill, outline, and grass details per 48px cell). Bake only the
      // repeatable five-cell palette cycle. Do not make a TileSprite as large
      // as the world: Canvas renderers allocate its backing canvas at display
      // size, and permanent sparse lot indices can make that world very tall.
      const key = 'neighborhood-ground:' + base.toString(16) + ':' + alternate.toString(16);
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
      // Cover only the screen with fixed-camera pieces. Each backing canvas is
      // capped at 1024px in either dimension, regardless of world height; the
      // tile offset is synchronized to camera travel in update().
      const maxCanvasSide = 1024;
      const viewportWidth = Math.max(1, this.scale?.width || maxCanvasSide);
      const viewportHeight = Math.max(1, this.scale?.height || 768);
      this._groundViewport = { width: viewportWidth, height: viewportHeight, base, alternate };
      const tiles = [];
      for (let y = 0; y < viewportHeight; y += maxCanvasSide) {
        for (let x = 0; x < viewportWidth; x += maxCanvasSide) {
          const width = Math.min(maxCanvasSide, viewportWidth - x);
          const height = Math.min(maxCanvasSide, viewportHeight - y);
          const tile = this.add.tileSprite(x + width / 2, y + height / 2, width, height, key)
            .setScrollFactor(0).setDepth(0);
          tile._groundScreenX = x;
          tile._groundScreenY = y;
          tile._groundWidth = width;
          tile._groundHeight = height;
          tiles.push(tile);
        }
      }
      this._groundTiles = tiles;
      return tiles;
    }

    _syncTileField() {
      if (!this._groundTiles?.length) return;
      const camera = this.cameras.main;
      const viewport = this._groundViewport;
      if (viewport && (viewport.width !== this.scale.width || viewport.height !== this.scale.height)) {
        this._groundTiles.forEach(tile => tile.destroy());
        this._tileField(viewport.base, viewport.alternate);
      }
      const zoom = camera.zoom || 1;
      const originX = (camera.width || this.scale.width) * (camera.originX ?? 0.5);
      const originY = (camera.height || this.scale.height) * (camera.originY ?? 0.5);
      this._groundTiles.forEach((tile) => {
        // ScrollFactor(0) ignores scroll, not camera zoom. Invert that zoom
        // around its origin so the bounded canvases cover the entire screen.
        tile.setScale(1 / zoom);
        tile.setPosition(
          originX + (tile._groundScreenX + tile._groundWidth / 2 - originX) / zoom,
          originY + (tile._groundScreenY + tile._groundHeight / 2 - originY) / zoom);
        tile.tileScaleX = tile.tileScaleY = zoom;
        tile.tilePositionX = (camera.scrollX + originX) * zoom + tile._groundScreenX - originX;
        tile.tilePositionY = (camera.scrollY + originY) * zoom + tile._groundScreenY - originY;
      });
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
          this.add.image(x + 24, y + 24, 'int_' + floorKey).setScale(INTERIOR_ART_SCALE).setDepth(0);
        }
      }
      for (let x = 0; x < this.mapWidth; x += 48) {
        this.add.image(x + 24, 24, 'int_' + wallKey).setScale(INTERIOR_ART_SCALE).setDepth(1);
        const overlapsExit = x < exit.x + exit.width && x + 48 > exit.x;
        if (!overlapsExit) this.add.image(x + 24, this.mapHeight - 24, 'int_' + wallKey).setScale(INTERIOR_ART_SCALE).setDepth(1);
      }
      for (let y = 48; y < this.mapHeight - 48; y += 48) {
        this.add.image(24, y + 24, 'int_' + wallKey).setScale(INTERIOR_ART_SCALE).setDepth(1);
        this.add.image(this.mapWidth - 24, y + 24, 'int_' + wallKey).setScale(INTERIOR_ART_SCALE).setDepth(1);
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
      const outdoors = this.location === 'neighborhood' || this.location === 'city';
      const fitKey = `${width}:${height}:${this.mapWidth}:${this.mapHeight}:${outdoors}:${this._outdoorZoomFactor || 1.15}`;
      if (this._cameraFitKey === fitKey) return;
      this._cameraFitKey = fitKey;
      // Never show beyond the authored road/world edges. Keep the desired
      // outdoor scale on smaller screens, but fill wide displays rather than
      // exposing a large unplayable grass area to the right of the street.
      this._outdoorZoomFactor = this._outdoorZoomFactor || 1.15;
      const zoom = outdoors
        ? Math.max(0.7, width / this.mapWidth, height / this.mapHeight) * this._outdoorZoomFactor
        : 1;
      if (camera.zoom !== zoom) camera.setZoom(zoom);
    }

    _setOutdoorZoom(factor) {
      if (this.location !== 'neighborhood' && this.location !== 'city') return;
      this._outdoorZoomFactor = Math.min(2.8, Math.max(1, factor));
      this._fitNeighborhoodCamera();
    }

    _drawNeighborhood() {
      this._tileField(0x77a45f, 0x6f9b59);
      const lots = Array.isArray(this.info.streetLots) ? this.info.streetLots : [];
      // `lot` values are durable and therefore sparse after deleted test or
      // former accounts. Bounds come from the server's highest canonical lot,
      // not the number of directory entries.
      this.streetSegmentCount = Math.max(1, Math.ceil(Math.max(0, this.mapHeight - 96) / 960));
      this._streetScenerySegments = new Map();
      this._syncStreetScenery();
      this.streetLotsVisual = [];
      lots.forEach((lot) => {
        this._path({ x: lot.x - 36, y: lot.northSide ? lot.bottom - 90 : lot.bottom - 236,
          width: 72, height: lot.northSide ? 198 : 246 });
        const stage = lot.construction?.stage || 'empty';
        const structure = this._drawResidenceStage(lot);
        const sign = this._sign(lot.x, lot.bottom - 102, this._residenceSignText(lot));
        this.streetLotsVisual.push({
          lot, structure, sign, stage, color: lot.exteriorColor || 'teal',
          yardKey: this._streetYardKey(lot.yard), yard: this._drawStreetYard(lot),
        });
      });
      this._sign(720, 72, 'WILLOW WALK · ONE SHARED STREET');
    }

    _drawStreetSegment(segment) {
      const base = segment * 960;
      const objects = [
        this._path({ x: 0, y: base + 432, width: this.mapWidth, height: 144 }, 0x55616a, 0x3f4950),
        this._path({ x: 0, y: base + 408, width: this.mapWidth, height: 24 }, 0xd8ccb3),
        this._path({ x: 0, y: base + 576, width: this.mapWidth, height: 24 }, 0xd8ccb3),
        this._path({ x: 552, y: base, width: 48, height: 432 }),
        this._path({ x: 552, y: base + 576, width: 48, height: 384 }),
        this._roadDetails(base + 504, 576, [{ x: 540, y: base + 420 }, { x: 612, y: base + 588 }], base, base + 960),
      ];
      [[90, base + 228], [1090, base + 228], [90, base + 760], [1090, base + 760]]
        .forEach(([x, y]) => objects.push(this._exterior('tree', x, y)));
      [[270, base + 420], [486, base + 420], [810, base + 420], [1110, base + 420],
        [270, base + 600], [486, base + 600], [810, base + 600], [1110, base + 600]]
        .forEach(([x, y]) => objects.push(this._exterior('lamp', x, y, 2)));
      return objects;
    }

    _syncStreetScenery() {
      if (!this._streetScenerySegments || !this.streetSegmentCount) return;
      const camera = this.cameras.main;
      const top = camera.worldView?.top ?? camera.scrollY ?? 0;
      const bottom = camera.worldView?.bottom ?? (top + (this.scale?.height || 768) / (camera.zoom || 1));
      // One segment of prefetch on either side avoids an exposed road edge
      // during camera motion, while bounding scenery objects as the street
      // grows from sparse, permanent lot indices.
      const first = Math.max(0, Math.floor(top / 960) - 1);
      const last = Math.min(this.streetSegmentCount - 1, Math.floor(bottom / 960) + 1);
      const wanted = new Set();
      for (let segment = first; segment <= last; segment++) wanted.add(segment);
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
        const sprite = this.add.image(originX + item.gridX * 48 + footprint.width * 24, baseY, this._furnitureTextureKey(def.id))
          .setOrigin(0.5, 1).setScale(INTERIOR_ART_SCALE).setDepth(baseY);
        this._animateFurnitureObject(sprite, def.id, Number(item.gridX || 0) * 80 + Number(item.gridY || 0) * 120);
        objects.push(sprite);
      }
      return objects;
    }

    _drawCity() {
      this._tileField(0x83aa68, 0x789d60);
      this._path({ x: 0, y: 432, width: 1152, height: 144 }, 0x535e66, 0x3e4750);
      this._path({ x: 456, y: 0, width: 240, height: this.mapHeight }, 0x535e66, 0x3e4750);
      this._path({ x: 0, y: 408, width: 1152, height: 24 });
      this._path({ x: 0, y: 576, width: 1152, height: 24 });
      this._path({ x: 432, y: 0, width: 24, height: this.mapHeight });
      this._path({ x: 696, y: 0, width: 24, height: this.mapHeight });
      // Short garden walks lead to the two south-lane shop thresholds without
      // widening the road or making a new collision shortcut.
      this._path({ x: 836, y: 328, width: 72, height: 104 });
      this._path({ x: 254, y: 852, width: 72, height: 36 });
      this._path({ x: 836, y: 852, width: 72, height: 36 });
      this._path({ x: 254, y: 1180, width: 72, height: 36 });
      this._path({ x: 836, y: 1180, width: 72, height: 36 });
      this._path({ x: 254, y: 1480, width: 72, height: 36 });
      this._path({ x: 836, y: 1480, width: 72, height: 36 });
      this._roadDetails(504, 576, [{ x: 444, y: 504 }, { x: 708, y: 504 }, { x: 576, y: 420, vertical: true }, { x: 576, y: 588, vertical: true }]);
      // Every open venue has its own silhouette and native-pixel detailing.
      // Rectangles and door centres match the authoritative facade colliders.
      this._exterior('shop', 290, 340);
      [
        { id: 'furniture-shop', x: 760, y: 106 },
        { id: 'garden-shop', x: 178, y: 622 },
        { id: 'decor-shop', x: 760, y: 622 },
        { id: 'cafe', x: 178, y: 950 },
        { id: 'diner', x: 760, y: 950 },
        { id: 'bakery', x: 178, y: 1250 },
        { id: 'sushi', x: 760, y: 1250 },
      ].forEach((building) => window.JpoPlazaExteriors.draw(this, {
        ...building, width: 224, height: 222,
        doorX: building.x + 112, doorY: building.y + 222,
      }));
      const museum = this.info.geometry?.commercialExteriors?.museum || {
        footprint: { x: 336, y: 1560, width: 480, height: 230 },
      };
      const museumRect = museum.footprint;
      window.JpoPlazaExteriors.draw(this, {
        id: 'museum', ...museumRect,
        doorX: museumRect.x + museumRect.width / 2,
        doorY: museumRect.y + museumRect.height,
      });
      this._path({ x: 336, y: 1790, width: 480, height: 96 });
      [[120, 236], [445, 210], [705, 206], [1032, 224], [92, 300], [1048, 300]].forEach(([x, y]) => this._exterior('tree', x, y));
      [[398, 384], [744, 384], [90, 580], [1062, 580]].forEach(([x, y]) => this._exterior('lamp', x, y, 2));
      // The seating pockets sit fully outside the crossing roads. Keep the
      // player seat coordinates in neighborhood.mjs in lockstep with these
      // visual ground contacts.
      [[372, 416], [780, 416], [88, 696], [1064, 696]].forEach(([x, y]) => this._exterior('bench', x, y, 2));

      // Decorative cheerful animated details
      [[290, 480], [872, 480], [290, 960], [872, 960]].forEach(([x, y]) => {
        this.add.image(x, y - 60, 'dec_flowers').setScale(3).setOrigin(0.5, 1).setDepth(y - 60);
        const balloons = this.add.image(x - 60, y - 60, 'dec_balloons').setScale(3).setOrigin(0.5, 1).setDepth(y);
        this._animateNeighborhoodObject(balloons, { y: { from: y - 60, to: y - 75 }, duration: 2500, yoyo: true, repeat: -1 });
      });
      [240, 340, 820, 920].forEach(x => {
        const bunting = this.add.image(x, 150, 'dec_bunting').setScale(3).setOrigin(0.5, 0).setDepth(300);
        this._animateNeighborhoodObject(bunting, { alpha: { from: 0.8, to: 1 }, duration: 1500, yoyo: true, repeat: -1 });
      });

      // Keep the intersection open: no fountain disk or invisible core
      // collider in the roadway. Animated accents belong to the storefronts.
      this._sign(290, 80, 'PLAZA MARKET · CLOSED');
      this._sign(576, 302, 'HUDDLE PLAZA');
      this._sign(94, 420, '← WILLOW WALK');
      this._sign(290, 900, 'GARDEN LANE');
      this._sign(872, 900, 'GARDEN LANE');
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
          return [{
            x: visual.lot.x - 96 + placed.gridX * 48, y: originY + placed.gridY * 48,
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
    }


    _drawRestaurant() {
      this._drawCommercialInterior();
    }

    _drawShop() {
      this._drawCommercialInterior();
    }

    _drawCommercialInterior() {
      window.JpoInteriors.draw(this, this.location);
    }

    _drawHome() {
      this._interiorTileField('home_floor', 'home_wall', HOME_EXIT);
      this._drawHomeRoomDivisions();

      // The centered exit stays open from the arrival tile to the threshold.
      // This is the one non-tile cue in an otherwise unfurnished residence.
      const doorArt = this.add.graphics().setDepth(2);
      doorArt.fillStyle(0x9e7355, 1).fillRoundedRect(HOME_EXIT.x, HOME_EXIT.y, HOME_EXIT.width, HOME_EXIT.height - 30, 6);
      doorArt.lineStyle(3, 0xe8d09b, 0.9).strokeRoundedRect(HOME_EXIT.x, HOME_EXIT.y, HOME_EXIT.width, HOME_EXIT.height - 30, 6);
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
            this.add.image(x + 24, y + 24, 'int_home_wall')
              .setScale(INTERIOR_ART_SCALE).setDepth(4);
          }
        }
      });
    }

    _drawPortalCues() {
      for (const portal of this.doors) {
        const cue = this.add.graphics().setDepth(3);
        cue.fillStyle(0xf6df75, 0.32).fillRoundedRect(portal.x + 3, portal.y + 3, portal.width - 6, portal.height - 6, 7);
        cue.lineStyle(2, 0xfff1a8, 0.9).strokeRoundedRect(portal.x + 3, portal.y + 3, portal.width - 6, portal.height - 6, 7);
        // Each residence already has one lot/owner sign at its facade. Keep
        // the door highlight for orientation, but do not stack a second
        // "OWNER'S HOME" portal label over that sign.
        if (portal.residence) {
          this.portalCues?.push(cue);
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
      }
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
       this.localPet?.setDepth?.(19);
      const baked = g._bakedWearIds?.(char, g._equippedCosmetic, g._equippedWings, g._equippedSlots) || [];
      this.playerTexKey = this._office('_buildPlayerTex', char, g._playerHairIdx || 0, g._playerSkinIdx || 0,
        g._playerShirtIdx || 0, g._playerPantsIdx || 0, baked) || this.playerTexKey;
      this.player.setTexture(this.playerTexKey);
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
    }

    _showActivityEffect(entry, activity) {
      this._clearActivityEffect(entry);
      const sprite = entry.sprite || (entry === this ? this.player : null);
      const icon = this._activityIcon(activity);
      if (!sprite || !icon) return;
      const fx = this.add.text(sprite.x, sprite.y - 54, icon, {
        fontFamily: 'sans-serif', fontSize: '18px', color: '#fff7d6',
        stroke: '#273247', strokeThickness: 3,
      }).setOrigin(0.5).setDepth(3002);
      entry._activityFx = fx;
      entry._activityEffectTween = this.tweens.add({
        targets: fx, y: sprite.y - 63, alpha: { from: 0.72, to: 1 },
        duration: 820, yoyo: true, repeat: -1, ease: 'Sine.easeInOut',
      });
    }

    _applyActivityPose(entry, activity, dir = 'down') {
      const sprite = entry.sprite || (entry === this ? this.player : null);
      if (!sprite) return;
      const texKey = entry.playerTexKey || entry.texture || this.playerTexKey;
      const start = globals().DIR_START || { right: 0, up: 6, left: 12, down: 18 };
      const action = activity?.action;
      if (!action) {
        entry._activityAction = null;
        sprite.setAngle(0).setScale(3).setFlipX(false);
        sprite.setTexture(texKey).setFrame(start[dir] ?? start.down);
        sprite.anims.stop();
        this._clearActivityEffect(entry);
        return;
      }
      if (action === 'sit') {
        sprite.setAngle(0).setScale(3).setFlipX(false).setTexture(texKey);
        const sitDir = dir === 'left' ? 'right' : (dir === 'right' ? 'right' : 'down');
        const sitKey = `sit_${texKey}_${sitDir}`;
        if (this.anims.exists(sitKey) &&
            (sprite.anims.currentAnim?.key !== sitKey || !sprite.anims.isPlaying)) sprite.play(sitKey);
        else { sprite.anims.stop(); sprite.setFrame(start[dir] ?? start.down); }
      } else if (action === 'lie' || action === 'sleep') {
        // There is no separate lie sheet in the supplied avatar pack. Wide
        // sofas get a horizontal idle-down pose, while the supplied portrait
        // 16x48 bed keeps the avatar lengthwise instead of turning it 90°
        // across its one-cell width.
        const lengthwise = activity?.orientation === 'lengthwise';
        sprite.anims.stop();
        sprite.setTexture(texKey).setFrame(start.down)
          .setScale(2.7).setAngle(lengthwise ? 0 : -90).setFlipX(false);
      } else {
        sprite.anims.stop();
        sprite.setTexture(texKey).setFrame(action === 'watch' ? (start[dir] ?? start.up) : start.down)
          .setScale(3).setAngle(0).setFlipX(false);
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
        this.player.body.enable = false;
      } else if (this.player.body) {
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
        const radius = Number(sprite.getData('actionRadius')) || 86;
        const anchorY = sprite.getData('anchor') === 'front'
          ? sprite.y + 18
          : sprite.y - (sprite.getData('height') || 1) * 24 + 10;
        const distance = Math.hypot(this.player.x - sprite.x, this.player.y - anchorY);
        if (distance > radius || (best && distance >= best.distance)) continue;
        best = { sprite, actions, distance };
      }
      return best;
    }

    _requestFurnitureAction() {
      if (this.activity || this._activityPending) return;
      const nearby = this._nearbyFurnitureAction();
      if (!nearby) return;
      const action = this.keyShift?.isDown && nearby.actions[1] ? nearby.actions[1] : nearby.actions[0];
      const instanceId = nearby.sprite.getData('instanceId');
      if (!instanceId || !action) return;
      this._activityPending = true;
      movement?.sendReliableEvent('furnitureInteract', this.location, { phase: 'start', instanceId, action });
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
      movement?.sendReliableEvent('furnitureInteract', this.location, { phase: 'exit', reason });
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
      const northPocket = Number(seat.y) < (this.location === 'city' ? 576 : this.mapHeight / 2);
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
      const atStreet = this.location === 'neighborhood';
      const yardLot = atStreet && Array.isArray(this.info.streetLots)
        ? this.info.streetLots.find((lot) => lot.ownerEmail === globals()._playerEmail) : null;
      const yardOrigin = yardLot ? {
        x: yardLot.x - 96, y: yardLot.northSide ? yardLot.bottom - 330 : yardLot.bottom - 66,
      } : null;
      this._placementMoveHandler = (pointer) => {
        const usingYard = atStreet && selectedZone === 'yard';
        if (!(atHome || usingYard) || !homeState?.canEdit || !selectedInstance || (usingYard && !yardOrigin)) return this._clearGhost();
        const item = [...(homeState.inventory || []), ...(homeState.layout || []), ...(homeState.yard || [])]
          .find((candidate) => candidate.id === selectedInstance);
        const def = item && furnitureCatalog[item.furnitureId];
        if (!def) return this._clearGhost();
        const gridX = Math.floor((pointer.worldX - (usingYard ? yardOrigin.x : 0)) / 48);
        const gridY = Math.floor((pointer.worldY - (usingYard ? yardOrigin.y : 0)) / 48);
        const footprint = this._footprint(def, selectedRotation);
        const blocked = usingYard
          ? !this._validYardPlacement(def, gridX, gridY, selectedRotation)
          : !this._validPlacement(def, gridX, gridY, selectedRotation);
        if (!this.ghost) this.ghost = this.add.image(0, 0, this._furnitureTextureKey(def.id)).setAlpha(0.6).setDepth(25);
        this.ghost.setTexture(this._furnitureTextureKey(def.id)).setOrigin(0.5, 1).setScale(INTERIOR_ART_SCALE).setAngle(selectedRotation)
          .setPosition((usingYard ? yardOrigin.x : 0) + gridX * 48 + footprint.width * 24,
            (usingYard ? yardOrigin.y : 0) + (gridY + footprint.height) * 48);
        if (blocked) this.ghost.setTint(0xff5555); else this.ghost.clearTint();
      };
      this._placementDownHandler = (pointer) => {
        const usingYard = atStreet && selectedZone === 'yard';
        if (!(atHome || usingYard) || !homeState?.canEdit || !selectedInstance || !this.ghost || this.ghost.isTinted) {
          if ((atHome || usingYard) && selectedInstance && this.ghost?.isTinted) toast('That furniture does not fit there.');
          return;
        }
        socket.emit('homeLayoutSet', {
          instanceId: selectedInstance,
          gridX: Math.floor((pointer.worldX - (usingYard ? yardOrigin.x : 0)) / 48),
          gridY: Math.floor((pointer.worldY - (usingYard ? yardOrigin.y : 0)) / 48),
          rotation: selectedRotation, zone: usingYard ? 'yard' : 'indoor',
        });
        selectedInstance = null;
        this._clearGhost();
        renderHome();
      };
      this.input.on('pointermove', this._placementMoveHandler);
      this.input.on('pointerdown', this._placementDownHandler);
    }

    _clearGhost() {
      if (this.ghost) this.ghost.destroy();
      this.ghost = null;
    }

    clearPlacementPreview() {
      this._clearGhost();
    }

    _footprint(def, rotation) {
      return rotation % 180 === 90 ? { width: def.height || 1, height: def.width || 1 } : { width: def.width || 1, height: def.height || 1 };
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

    renderFurniture(state) {
      // create() is still in Phaser's CREATING state, not ACTIVE. The incoming
      // home snapshot can already be complete at that point, and no second
      // snapshot is guaranteed, so do not suppress the initial furniture build.
      if (!this.location?.startsWith('home:') || !this._furnitureBlocks) return;
      this.furniture.forEach((object) => {
        this.tweens.killTweensOf(object);
        object.destroy();
      });
      this.furniture = [];
      this._furnitureBlocks?.clear(true, true);
      for (const item of state?.layout || []) {
        const def = furnitureCatalog[item.furnitureId];
        if (!def) continue;
        const uprightRotation = def.rotations.includes(item.rotation) ? item.rotation : 0;
        const footprint = this._footprint(def, uprightRotation);
        const floorCenterX = item.gridX * 48 + footprint.width * 24;
        const floorBaseY = (item.gridY + footprint.height) * 48;
        const sprite = this.add.image(floorCenterX, floorBaseY, this._furnitureTextureKey(def.id))
          .setOrigin(0.5, 1).setScale(INTERIOR_ART_SCALE).setAngle(uprightRotation).setDepth(floorBaseY);
        // The supplied bath/TV files are native tileset sheets. Display one
        // authored tile at the furniture's footprint rather than the whole
        // sheet as an accidental oversized decoration.
        if (def.id === 'bathtub') sprite.setCrop(0, 0, 16, 64);
        if (def.id === 'television') sprite.setCrop(0, 0, 16, 16);
        sprite.setData('instanceId', String(item.id));
        sprite.setData('furnitureId', def.id);
        sprite.setData('actions', Array.isArray(def.actions) ? def.actions : []);
        sprite.setData('actionRadius', def.interaction?.radius || 86);
        sprite.setData('anchor', def.interaction?.anchor || 'center');
        sprite.setData('height', footprint.height);
        sprite.setData('isSeat', Array.isArray(def.actions) && def.actions.includes('sit'));
        sprite.setData('seatDir', 'down');
        this._animateFurnitureObject(sprite, def.id, item.gridX * 90 + item.gridY * 130);
        this.furniture.push(sprite);
        this._addBlock(this._furnitureBlocks, {
          x: item.gridX * 48, y: item.gridY * 48, width: footprint.width * 48, height: footprint.height * 48,
        });
      }
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
      if (!serverPlayer || !this.player || !Number.isFinite(serverPlayer.x) || !Number.isFinite(serverPlayer.y)) return;
      if (!this._isCurrentLocation(serverPlayer) ||
          !window.JpoFocusedMovement?.shouldApplyCorrection(serverPlayer, this.location, this._lastCorrectionSeq)) return;
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
        const sprite = this.add.sprite(player.x, player.y, texture).setScale(3).setOrigin(0.5, 0.5).setDepth(player.y);
        const nameTag = this._makeNameTag(player.x, player.y, player.name || 'Coworker') ||
          this.add.text(player.x, player.y - 40, player.name || 'Coworker', { fontSize: '14px', fontFamily: 'monospace', color: '#fff', backgroundColor: '#000000bb', padding: { x: 5, y: 3 } }).setOrigin(0.5, 1).setDepth(player.y + 2);
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
      remote.pet?.setDepth?.(player.y - 1);
    }

    _applyRemote(remote, player) {
      const dir = player.dir || remote.lastDir || 'down';
      remote.lastDir = dir;
      remote.seated = player.anim === 'sit';
      remote.activity = player.activity || (player.anim === 'sit' ? { action: 'sit' } : null);
      remote.sprite.setPosition(player.x, player.y).setTexture(remote.texture);
      remote.sprite.setDepth(player.y);
      remote.nameTag?.setPosition(player.x, player.y - 40).setDepth(player.y + 2);
      if (remote.activity) {
        remote.playerTexKey = remote.texture;
        this._applyActivityPose(remote, remote.activity, dir);
      } else if (player.anim === 'walk') {
        const key = 'walk_' + remote.texture + '_' + dir;
        if (this.anims.exists(key) && remote.sprite.anims.currentAnim?.key !== key) remote.sprite.play(key);
      } else {
        remote.sprite.anims.stop();
        remote.sprite.setFrame(globals().DIR_START?.[dir] || 0);
      }
      this._positionPresentation(remote, player.x, player.y, dir);
    }

    _positionPresentation(entry, x, y, dir) {
      for (const [object, def] of [[entry.cosmetic, entry.cosmeticDef], [entry.wings, entry.wingsDef]]) {
        if (!object) continue;
        object.setDepth?.(y + 1);
        if (def) this._placeWearable(object, def, x, y, dir);
        else object.setPosition(x, y - 68);
      }
      for (const slot of Object.values(entry.slotObjs || {})) {
        if (!slot?.obj) continue;
        slot.obj.setDepth?.(y + 1);
        if (slot.def) this._placeWearable(slot.obj, slot.def, x, y, dir);
        else slot.obj.setPosition(x, y - 68);
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
      remote.pet?.setDepth?.(remote.sprite.y - 1);
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
      const { SPEED, touchMove = {} } = globals();
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
        if (up) { body.setVelocityY(-SPEED); dir = 'up'; anim = 'walk'; }
        else if (down) { body.setVelocityY(SPEED); dir = 'down'; anim = 'walk'; }
        if (left) { body.setVelocityX(-SPEED); dir = 'left'; anim = 'walk'; }
        else if (right) { body.setVelocityX(SPEED); dir = 'right'; anim = 'walk'; }
        if ((left || right) && (up || down)) body.velocity.normalize().scale(SPEED);
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
      this.player.setDepth(this.player.y);
      this.localNameTag?.setDepth(this.player.y + 2);
      this._positionPresentation({ cosmetic: this.localCosmetic, cosmeticDef: this.localCosmeticDef, wings: this.localWings, wingsDef: this.localWingsDef, slotObjs: this.localSlotObjs }, this.player.x, this.player.y, dir);
      if (this._activityFx) this._activityFx.setPosition(this.player.x, this.player.y - 54);
      if (this.localPet) {
        this._stepPet(this.localPet, this.player.x, this.player.y, delta, !!this.activity);
        this.localPet.setDepth?.(this.localPet.y - 1);
      }
      for (const remote of Object.values(this.remotes)) {
        if (remote._activityFx) remote._activityFx.setPosition(remote.sprite.x, remote.sprite.y - 54);
        if (remote.pet) {
          this._stepPet(remote.pet, remote.sprite.x, remote.sprite.y, delta, remote.seated);
          remote.pet.setDepth?.(remote.pet.y - 1);
        }
        if (remote.chatBubble) remote.chatBubble.setPosition(remote.sprite.x, remote.sprite.y - 85);
      }
      if (this.localBubble) this.localBubble.setPosition(this.player.x, this.player.y - 78);

      const nearbyParkSeat = !this.activity && !this._activityPending ? this._nearbyParkSeat() : null;
      const nearbyAction = !this.activity && !this._activityPending && !nearbyParkSeat && this.location.startsWith('home:')
        ? this._nearbyFurnitureAction() : null;
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
      else if (parkSeated || this._parkSeatPending === 'stand') this.interactHint.setText('Standing…').setPosition(this.player.x, this.player.y - 65).setVisible(true);
      else if (nearbyParkSeat) this.interactHint.setText('[E] Sit').setPosition(this.player.x, this.player.y - 65).setVisible(true);
      else if (nearbyAction) {
        const actions = nearbyAction.actions;
        const primary = ({ sit: 'Sit', lie: 'Lie down', sleep: 'Sleep', shower: 'Shower', bathe: 'Bathe', watch: 'Watch TV' })[actions[0]] || 'Use';
        const secondaryAction = actions[1];
        const secondary = secondaryAction
          ? ' · [Shift+E] ' + (({ lie: 'Lie down', bathe: 'Bathe', shower: 'Shower', sleep: 'Sleep', watch: 'Watch TV', sit: 'Sit' })[secondaryAction] || 'Use')
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
      if (Phaser.Input.Keyboard.JustDown(this.keyE)) {
        if (this.activity || this._activityPending) this._leaveFurnitureActivity('exit');
        else if (this.staticSeatState) this._leaveParkSeat('exit');
        else if (nearbyParkSeat) this._requestParkSeat();
        else this._requestFurnitureAction();
      }
      const parkTarget = this._parkSeatPending === 'stand' ? this._parkSeatExitTarget
        : this._parkSeatPending === 'sit' ? this._parkSeatSitTarget : null;
      movement?.tick(delta, this.location, {
        x: parkTarget?.x ?? this.player.x, y: parkTarget?.y ?? this.player.y,
        dir: parkTarget?.dir || this.playerDir, anim,
      });
    }

    shutdown() {
      this._neighborhoodReady = false;
      if (this._outdoorWheelHandler) this.game.canvas.removeEventListener('wheel', this._outdoorWheelHandler);
      this._outdoorWheelHandler = null;
      this._resetTransientTravel();
      this._removePlacementInput();
      this._clearGhost();
      (this._ambientTweens || []).forEach((tween) => tween?.remove?.());
      this._ambientTweens = [];
      this.portalCues?.forEach((object) => object.destroy());
      this.portalCues = [];
      window.jpoSetConstructionLot?.(null);
      this._clearLocalPresentation();
      Object.keys(this.remotes).forEach((id) => this._removeRemote(id));
      this.remotes = {};
      this.furniture = [];
      this.streetLotsVisual = null;
      this.localBubble = null;
      this.player = null;
      this.localNameTag = null;
      this.interactHint = null;
      this._groundTiles = null;
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
      currentLocation = result.location;
      title.textContent = result.map?.label || result.location;
      furnitureCatalog = result.catalog || furnitureCatalog;
      if (typeof result.self?.homeColor === 'string' || typeof result.homeColor === 'string') {
        ownExteriorColor = result.self?.homeColor || result.homeColor;
      }
      if (isHome()) {
        homeState = result.home || homeState;
        editorOpen = false;
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