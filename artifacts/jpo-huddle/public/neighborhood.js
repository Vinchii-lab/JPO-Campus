// Shared city / home presentation. Server transitions, permissions, placement,
// and movement validation remain authoritative in server.js / neighborhood.mjs.
window.initNeighborhoodUI = function(socket, getGlobals) {
  if (document.getElementById('neighborhood-ui')) return;

  const ui = document.createElement('div');
  ui.id = 'neighborhood-ui';
  // This is a location plaque, deliberately not a travel menu.
  ui.innerHTML = '<div id="neighborhood-nav"><span id="neighborhood-title">JPO HQ</span></div><div id="home-panel" hidden></div>';
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
  let directory = [];
  let directoryRequestId = 0;
  let activeDirectoryRequestId = 0;
  // A socket result can arrive while the prior map's cosmetic fade is still
  // pending. Keep one presentation generation and timer: an old completion
  // must never stop/restart the scene selected by a newer completion.
  let sceneTransitionGeneration = 0;
  let sceneTransitionTimer = null;
  // Player sprites, interior tiles, and the verified furniture singles are
  // authored on the same 16px grid. Keep their one shared integer scale here;
  // exterior buildings intentionally use their separate, larger source art.
  const INTERIOR_ART_SCALE = 3;
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
    if (!scene || scene._portalFading) return;
    scene._portalFading = true;
    scene._portalFadeAt = performance.now();
    scene.cameras.main.fadeOut(220, 16, 22, 34);
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
    socket.emit('playerMove', { x: player.x, y: player.y, dir: dir || 'left', anim: 'idle' });
    window.jpoBeginMapFade?.();
    travel('neighborhood');
    return true;
  };
  const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[char]);
  const isHome = () => currentLocation.startsWith('home:');
  const isResidentialBlock = () => currentLocation === 'neighborhood';
  const travel = (destination, options = {}) => socket.emit('locationTransition', { destination, ...options });
  const requestDirectory = () => {
    activeDirectoryRequestId = ++directoryRequestId;
    socket.emit('homeDirectoryRequest', { requestId: activeDirectoryRequestId });
  };

  function renderHome() {
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
    let panel = document.getElementById('shop-panel');
    if (currentLocation !== 'furniture-shop') {
      if (panel) panel.hidden = true;
      return;
    }
    if (!panel) {
      panel = document.createElement('div');
      panel.id = 'shop-panel';
      ui.appendChild(panel);
    }
    panel.hidden = false;
    const rows = Object.values(furnitureCatalog).map((item) =>
      '<span class="home-item"><span>' + escapeHtml(item.name) + ' · ' +
      Number(item.price).toLocaleString() + ' coins</span><button type="button" data-buy="' +
      escapeHtml(item.id) + '">Buy</button></span>',
    ).join('') || '<small>The catalog is loading.</small>';
    panel.innerHTML = '<div class="home-panel-head"><b>Huddle Home · Furnishings</b><button type="button" data-close>Close</button></div>' +
        '<div class="home-section"><small>You reached the furnishings counter. Prices are coins; Buy adds the item to your home Inventory. Leave through the glowing PLAZA exit, walk to your permanent Willow Walk lot, then place it indoors or in your yard.</small>' + rows + '</div>';
    panel.querySelector('[data-close]').onclick = () => { panel.hidden = true; };
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
    if (isHome()) renderHome();
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

  class NeighborhoodScene extends Phaser.Scene {
    constructor() {
      super('NeighborhoodScene');
      this.remotes = {};
      this.furniture = [];
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
      this.sitting = false;
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
      // These names deliberately do not overlap the old generic `furn_*`
      // texture keys. The URL revision is equally deliberate: furniture files
      // were replaced in place and the server legitimately caches PNGs for a
      // day, which otherwise left an already-open browser decoding the former
      // oversized artwork under a new scene.
      ['oak_chair', 'fern', 'reading_lamp', 'coffee_table', 'blue_sofa', 'bookcase'].forEach((id) => {
        this.load.image(this._furnitureTextureKey(id), '/assets/neighborhood/furniture/' + id + '.png?v=' + FURNITURE_ASSET_REVISION);
      });
      ['home_floor', 'shop_floor', 'home_wall', 'shop_wall'].forEach((id) => {
        this.load.image('int_' + id, '/assets/neighborhood/' + id.replace('_', '-') + '-16.png');
      });
      ['house', 'shop', 'tree', 'bench', 'lamp'].forEach((id) => {
        this.load.image('ext_' + id, '/assets/neighborhood/exterior/' + id + '.png');
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
      ['oak_chair', 'fern', 'reading_lamp', 'coffee_table', 'blue_sofa', 'bookcase'].forEach((id) => {
        this.textures.get(this._furnitureTextureKey(id))?.setFilter(nearest);
      });
      ['home_floor', 'shop_floor', 'home_wall', 'shop_wall'].forEach((id) => {
        this.textures.get('int_' + id)?.setFilter(nearest);
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
      this.player = null;
      this.localNameTag = null;
      this.interactHint = null;
      this._geometryBlocks = this._yardBlocks = this._furnitureBlocks = null;
      this.keys = this.wasd = this.keyE = null;
      window._neighborhoodScene = this;
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
      // The shared street deliberately opens out enough to read several real
      // homes at once; rooms retain the office's normal close scale.
      this.cameras.main.setZoom(atHome ? 1 : (this.location === 'neighborhood' ? 0.7 : 1));

      // All maps are composed here from repeatable tile-sized ground, paths,
      // and separate transparent objects. None uses a baked screenshot/map PNG.
      if (atHome) this._drawHome();
      else if (this.location === 'furniture-shop') this._drawShop();
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
      this._drawPortalCues();
      this.keys = this.input.keyboard.createCursorKeys();
      this.wasd = this.input.keyboard.addKeys({ up: 'W', down: 'S', left: 'A', right: 'D' });
      this.keyE = this.input.keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.E);
      this.lastSend = 0;
      // Arrival points intentionally sit just inside an entry threshold. Do
      // not re-arm it until the player has walked clear, preventing bounce.
      this.portalRelease = !this._insidePortal(this.player.x, this.player.y);
      this.interactHint = this.add.text(0, 0, '', { fontFamily: 'monospace', fontSize: '11px', color: '#182331', backgroundColor: '#fff7d6', padding: { x: 5, y: 3 } }).setOrigin(0.5).setDepth(3000).setVisible(false);

      this._setLocalPresentation();
      this.renderFurniture(homeState);
      this.syncPlayers(data?.players || {});
      this._installPlacementInput(atHome);
      // This is intentionally in create rather than immediately after
      // SceneManager.start/restart. Phaser queues lifecycle operations, so
      // fading the old scene after a queued restart was one source of a frozen,
      // stopped NeighborhoodScene.
      if (data?._sceneTransitionGeneration === sceneTransitionGeneration) {
        this._portalFading = false;
        this._portalFadeAt = 0;
        this.cameras.main.fadeIn(220, 16, 22, 34);
      }
    }

    _tileField(base, alternate) {
      const art = this.add.graphics().setDepth(0);
      for (let y = 0; y < this.mapHeight; y += 48) for (let x = 0; x < this.mapWidth; x += 48) {
        const tone = ((x / 48 * 11 + y / 48 * 7) % 5 === 0) ? alternate : base;
        art.fillStyle(tone, 1).fillRect(x, y, 48, 48);
        art.lineStyle(1, 0x24313b, 0.09).strokeRect(x, y, 48, 48);
        // Break up the repeatable field without turning the authored maps into
        // a single baked ground image. Indoor palettes remain clean wood/tile.
        if (base === 0x77a45f || base === 0x83aa68) {
          const dx = 7 + ((x / 48 * 17 + y / 48 * 9) % 26);
          const dy = 9 + ((x / 48 * 7 + y / 48 * 13) % 25);
          art.fillStyle(0x436f42, 0.14).fillCircle(x + dx, y + dy, 1.2);
          art.fillStyle(0xd3df9c, 0.10).fillRect(x + 38 - dx / 5, y + 36 - dy / 7, 2, 1);
        }
      }
      return art;
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

    _roadDetails(horizontal, vertical, crosswalks = []) {
      const marks = this.add.graphics().setDepth(1.5);
      marks.lineStyle(3, 0xf5e7a8, 0.7);
      if (horizontal) for (let x = 24; x < this.mapWidth - 24; x += 56) marks.lineBetween(x, horizontal, x + 28, horizontal);
      if (vertical) for (let y = 24; y < this.mapHeight - 24; y += 56) marks.lineBetween(vertical, y, vertical, y + 28);
      marks.fillStyle(0xf8f2d1, 0.75);
      for (const { x, y, vertical: isVertical } of crosswalks) {
        for (let n = -3; n <= 3; n++) {
          if (isVertical) marks.fillRect(x + n * 10 - 3, y - 18, 6, 36);
          else marks.fillRect(x - 18, y + n * 10 - 3, 36, 6);
        }
      }
    }

    _path(rect, fill = 0xd8ccb3, border = 0x9b927e) {
      const art = this.add.graphics().setDepth(1);
      art.fillStyle(fill, 1).fillRect(rect.x, rect.y, rect.width, rect.height);
      art.lineStyle(2, border, 0.7).strokeRect(rect.x, rect.y, rect.width, rect.height);
      for (let x = rect.x + 24; x < rect.x + rect.width; x += 48)
        art.lineStyle(1, border, 0.26).lineBetween(x, rect.y, x, rect.y + rect.height);
      for (let y = rect.y + 24; y < rect.y + rect.height; y += 48)
        art.lineStyle(1, border, 0.26).lineBetween(rect.x, y, rect.x + rect.width, y);
    }

    _exterior(kind, x, y, scale = 2, _depth = 4, exteriorColor = null) {
      // Exterior art sorts by its ground contact point, allowing a player to
      // pass naturally behind a roof or tree and in front once below it.
      const sprite = this.add.image(x, y, 'ext_' + kind).setOrigin(0.5, 1).setScale(scale).setDepth(y);
      if (kind === 'house' && exteriorColor) window.jpoHouseColors?.applyHomeColor(sprite, exteriorColor);
      return sprite;
    }

    _sign(x, y, text) {
      return this.add.text(x, y, text, {
        fontFamily: 'monospace', fontSize: '12px', color: '#fff4cf',
        backgroundColor: '#35424acc', padding: { x: 5, y: 3 },
      }).setOrigin(0.5, 1).setDepth(2000);
    }

    _drawNeighborhood() {
      this._tileField(0x77a45f, 0x6f9b59);
      const lots = Array.isArray(this.info.streetLots) ? this.info.streetLots : [];
      const segments = Math.max(1, Math.ceil(lots.length / 8));
      for (let segment = 0; segment < segments; segment++) {
        const base = segment * 960;
        this._path({ x: 0, y: base + 432, width: this.mapWidth, height: 144 }, 0x55616a, 0x3f4950);
        this._path({ x: 0, y: base + 408, width: this.mapWidth, height: 24 }, 0xd8ccb3);
        this._path({ x: 0, y: base + 576, width: this.mapWidth, height: 24 }, 0xd8ccb3);
        this._path({ x: 552, y: base, width: 48, height: 432 });
        this._path({ x: 552, y: base + 576, width: 48, height: 384 });
        this._roadDetails(base + 504, 576, [{ x: 540, y: base + 420 }, { x: 612, y: base + 588 }]);
        [[90, base + 228], [1090, base + 228], [90, base + 760], [1090, base + 760]]
          .forEach(([x, y]) => this._exterior('tree', x, y));
        [[270, base + 420], [486, base + 420], [810, base + 420], [1110, base + 420],
          [270, base + 600], [486, base + 600], [810, base + 600], [1110, base + 600]]
          .forEach(([x, y]) => this._exterior('lamp', x, y, 2));
      }
      this.streetLotsVisual = [];
      lots.forEach((lot) => {
        this._path({ x: lot.x - 36, y: lot.northSide ? lot.bottom - 90 : lot.bottom - 236,
          width: 72, height: lot.northSide ? 198 : 246 });
        const house = this._exterior('house', lot.x, lot.bottom, 2, 4, lot.exteriorColor || 'teal');
        const sign = this._sign(lot.x, lot.bottom - 102, 'LOT ' + lot.lot + '\n' + String(lot.name || lot.ownerEmail).slice(0, 24));
        this.streetLotsVisual.push({ lot, house, sign, yard: this._drawStreetYard(lot) });
      });
      this._sign(720, 72, 'WILLOW WALK · ONE SHARED STREET');
    }

    _drawStreetYard(lot) {
      // Yard objects remain outdoors and are saved in the same owner snapshot
      // as the room. The fenced patch is intentionally behind the facade, so
      // its compact 4×3 grid never narrows the public pavement.
      const originX = lot.x - 96;
      const originY = lot.northSide ? lot.bottom - 330 : lot.bottom - 66;
      const objects = [];
      const art = this.add.graphics().setDepth(Math.max(2, originY - 1));
      objects.push(art);
      art.fillStyle(0x6d9855, 0.9).fillRect(originX, originY, 192, 144);
      art.lineStyle(3, 0xd7c18e, 0.95).strokeRect(originX, originY, 192, 144);
      for (const item of lot.yard || []) {
        const def = furnitureCatalog[item.furnitureId];
        if (!def) continue;
        const footprint = this._footprint(def, item.rotation);
        const baseY = originY + (item.gridY + footprint.height) * 48;
        objects.push(this.add.image(originX + item.gridX * 48 + footprint.width * 24, baseY, this._furnitureTextureKey(def.id))
          .setOrigin(0.5, 1).setScale(INTERIOR_ART_SCALE).setDepth(baseY));
      }
      return objects;
    }

    _drawCity() {
      this._tileField(0x83aa68, 0x789d60);
      this._path({ x: 0, y: 432, width: 1152, height: 144 }, 0x535e66, 0x3e4750);
      this._path({ x: 456, y: 0, width: 240, height: 912 }, 0x535e66, 0x3e4750);
      this._path({ x: 0, y: 408, width: 1152, height: 24 });
      this._path({ x: 0, y: 576, width: 1152, height: 24 });
      this._path({ x: 432, y: 0, width: 24, height: 912 });
      this._path({ x: 696, y: 0, width: 24, height: 912 });
      this._path({ x: 836, y: 328, width: 72, height: 104 });
      this._roadDetails(504, 576, [{ x: 444, y: 504 }, { x: 708, y: 504 }, { x: 576, y: 420, vertical: true }, { x: 576, y: 588, vertical: true }]);
      // City is commerce and transit. Its closed market is not a second home;
      // every residential address exists only on Willow Walk.
      this._exterior('shop', 290, 340);
      this._exterior('shop', 872, 328);
      [[120, 236], [445, 210], [705, 206], [1032, 224], [92, 728], [1048, 736]].forEach(([x, y]) => this._exterior('tree', x, y));
      [[398, 384], [744, 384], [402, 630], [746, 630]].forEach(([x, y]) => this._exterior('lamp', x, y, 2));
      [[520, 394], [630, 394], [520, 600], [630, 600]].forEach(([x, y]) => this._exterior('bench', x, y, 2));
      const plaza = this.add.graphics().setDepth(2);
      plaza.fillStyle(0xbfd3cb, 1).fillCircle(576, 500, 92).lineStyle(4, 0xe9dfb9, 0.8).strokeCircle(576, 500, 92);
      plaza.fillStyle(0x66a7c0, 1).fillCircle(576, 500, 34).lineStyle(3, 0xe9f8ff, 0.85).strokeCircle(576, 500, 34);
       this._sign(290, 80, 'PLAZA MARKET · CLOSED');
       this._sign(872, 88, 'HUDDLE HOME');
       this._sign(576, 302, 'HUDDLE PLAZA');
       this._sign(94, 420, '← WILLOW WALK');
    }

    setOwnHomeColor(color) {
      this.ownExteriorColor = color || 'teal';
    }

    updateResidenceDirectory(entries) {
      if (!this.streetLotsVisual) return;
      const homes = Array.isArray(entries) ? entries : [];
      this.streetLotsVisual.forEach((visual) => {
        const current = homes.find((home) => home.ownerEmail === visual.lot.ownerEmail);
        if (!current || current.ownerEmail !== visual.lot.ownerEmail) return;
        window.jpoHouseColors?.applyHomeColor(visual.house, current.exteriorColor || 'teal');
        visual.sign?.setText('LOT ' + visual.lot.lot + '\n' + String(current.name || current.ownerEmail).slice(0, 24));
        visual.yard?.forEach((object) => object.destroy());
        visual.lot = { ...visual.lot, ...current };
        visual.yard = this._drawStreetYard(visual.lot);
      });
      // Rebuild only from the updated authoritative lot data. This keeps
      // client Arcade collision aligned with the server's street snapshot
      // after an owner places or stores an outdoor item.
      if (this._yardBlocks && this.info.geometry) {
        const fixed = (this.info.geometry.blockers || []).filter((block) => !block.furnitureId);
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
        this._yardBlocks.clear(true, true);
        yardBlocks.forEach((block) => this._addBlock(this._yardBlocks, block));
      }
    }

    _drawShop() {
      this._interiorTileField('shop_floor', 'shop_wall', { x: 408, width: 144 });
      const art = this.add.graphics().setDepth(2);
      // Counter, display plinths, rugs, and a clear lower exit make this an
      // authored interior instead of a flattened shop design.
      art.fillStyle(0x80583f, 1).fillRect(144, 154, 672, 74).lineStyle(3, 0x533826, 1).strokeRect(144, 154, 672, 74);
      [140, 662].forEach((x) => art.fillStyle(0x9c7357, 1).fillRect(x, 378, 156, 80).lineStyle(2, 0x624431, 1).strokeRect(x, 378, 156, 80));
      art.fillStyle(0xb85f5c, 0.82).fillRoundedRect(344, 324, 272, 150, 16).lineStyle(3, 0xf0d8ab, 0.8).strokeRoundedRect(344, 324, 272, 150, 16);
      [[96, 350], [864, 350], [96, 640], [864, 640]].forEach(([x, y]) =>
        this.add.image(x, y, this._furnitureTextureKey('fern')).setOrigin(0.5, 1).setScale(INTERIOR_ART_SCALE).setDepth(y));
       this._sign(480, 112, 'HUDDLE HOME · FURNISHINGS');
       this.add.text(480, 190, 'FURNITURE PRICES IN COINS · crossing this door opens the catalog · purchases go to your home inventory.', {
        fontFamily: 'monospace', fontSize: '12px', color: '#fff7db', backgroundColor: '#493c36cc', padding: { x: 6, y: 4 }, align: 'center',
      }).setOrigin(0.5).setDepth(18);
    }

    _drawHome() {
      this._interiorTileField('home_floor', 'home_wall', { x: 240, width: 96 });
      const art = this.add.graphics().setDepth(2);
      art.fillStyle(0x9bb3c4, 1).fillRect(92, 52, 98, 18).fillRect(386, 52, 98, 18);
      art.lineStyle(3, 0x725542, 1).strokeRect(92, 52, 98, 18).strokeRect(386, 52, 98, 18);
      art.fillStyle(0xb96657, 0.8).fillRoundedRect(142, 145, 292, 128, 16);
      art.lineStyle(3, 0xf2dfba, 0.75).strokeRoundedRect(142, 145, 292, 128, 16);
      art.fillStyle(0x6e4d3b, 1).fillRect(48, 384, 192, 44).fillRect(336, 384, 192, 44);
       // The center is intentionally open from the arrival tile to the
       // threshold: a visible floor mat rather than an edge-only exit.
       art.fillStyle(0x9e7355, 1).fillRoundedRect(240, 360, 96, 66, 6);
       art.lineStyle(3, 0xe8d09b, 0.9).strokeRoundedRect(240, 360, 96, 66, 6);
      this.add.text(288, 91, 'A QUIET PLACE TO LAND', { fontFamily: 'monospace', fontSize: '13px', color: '#5c4636' }).setOrigin(0.5).setDepth(10);
       this.add.text(288, 390, 'WILLOW EXIT ↓', { fontFamily: 'monospace', fontSize: '10px', color: '#fff5d6', backgroundColor: '#604332cc', padding: { x: 4, y: 2 } }).setOrigin(0.5).setDepth(12);
    }

    _drawPortalCues() {
      for (const portal of this.doors) {
        const cue = this.add.graphics().setDepth(3);
        cue.fillStyle(0xf6df75, 0.32).fillRoundedRect(portal.x + 3, portal.y + 3, portal.width - 6, portal.height - 6, 7);
        cue.lineStyle(2, 0xfff1a8, 0.9).strokeRoundedRect(portal.x + 3, portal.y + 3, portal.width - 6, portal.height - 6, 7);
        const label = portal.destination === 'home' ? String(portal.label || (portal.residence ? ('Lot ' + portal.lot) : 'Home')).toUpperCase() :
          portal.destination === 'furniture-shop' ? 'FURNISHINGS' : portal.destination === 'city' ? 'PLAZA' :
          portal.destination === 'neighborhood' ? 'WILLOW WALK' : 'HQ GARDEN';
        this.add.text(portal.x + portal.width / 2, portal.y - 5, label, {
          fontFamily: 'monospace', fontSize: '11px', color: '#fff7c7', backgroundColor: '#35424acc', padding: { x: 4, y: 2 },
        }).setOrigin(0.5, 1).setDepth(2000);
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
      const width = Math.max(1, rect.width + 2 * (this.actorFootRadius - halfWidth));
      const height = Math.max(1, rect.height + 2 * (this.actorFootRadius - halfHeight));
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
      if (gridX < 0 || gridY < 0 || gridX + footprint.width > 12 || gridY + footprint.height > 9 ||
          (gridX < 7 && gridX + footprint.width > 5 && gridY < 9 && gridY + footprint.height > 6)) return false;
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
      this.furniture.forEach((object) => object.destroy());
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
        sprite.setData('isSeat', def.id === 'oak_chair'); // server currently validates chairs only
        sprite.setData('seatDir', 'down');
        this.furniture.push(sprite);
        this._addBlock(this._furnitureBlocks, {
          x: item.gridX * 48, y: item.gridY * 48, width: footprint.width * 48, height: footprint.height * 48,
        });
      }
    }

    _removeRemote(id) {
      const remote = this.remotes[id];
      if (!remote) return;
      for (const object of [remote.sprite, remote.nameTag, remote.cosmetic, remote.wings, remote.chatBubble]) {
        if (object) { this.tweens.killTweensOf(object); object.destroy(); }
      }
      for (const slot of Object.values(remote.slotObjs || {})) {
        if (slot?.obj) { this.tweens.killTweensOf(slot.obj); slot.obj.destroy(); }
      }
      if (remote.pet) this._destroyPet(remote.pet);
      delete this.remotes[id];
    }

    syncPlayers(players) {
      // Like furniture, the authoritative arrival snapshot is applied during
      // create before the scene status becomes ACTIVE.
      if (!this.player) return;
      Object.entries(players || {}).forEach(([id, player]) => {
        if (id !== socket.id && player?.email !== globals()._playerEmail) this.addRemote(id, player);
        if (id === socket.id) this.correctLocal(player);
      });
      Object.keys(this.remotes).forEach((id) => { if (!players?.[id]) this._removeRemote(id); });
    }

    correctLocal(serverPlayer) {
      if (!serverPlayer || !this.player || !Number.isFinite(serverPlayer.x) || !Number.isFinite(serverPlayer.y)) return;
      // currentPlayers is an authoritative snapshot (transition/ejection/reconnect).
      this.player.setPosition(serverPlayer.x, serverPlayer.y);
      this.player.body?.reset(serverPlayer.x, serverPlayer.y);
      this.playerDir = serverPlayer.dir || this.playerDir;
    }

    addRemote(id, player) {
      if (!id || !player || id === socket.id || player.email === globals()._playerEmail) return;
      let remote = this.remotes[id];
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
          lastDir: player.dir || 'down', seated: false,
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
      remote.sprite.setPosition(player.x, player.y).setTexture(remote.texture);
      remote.sprite.setDepth(player.y);
      remote.nameTag?.setPosition(player.x, player.y - 40).setDepth(player.y + 2);
      if (player.anim === 'walk') {
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
      const remote = this.remotes[player.id];
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
      if (!this.player) return;
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || '');
      const { SPEED, touchMove = {} } = globals();
      const left = !typing && (this.keys.left.isDown || this.wasd.left.isDown || touchMove.left);
      const right = !typing && (this.keys.right.isDown || this.wasd.right.isDown || touchMove.right);
      const up = !typing && (this.keys.up.isDown || this.wasd.up.isDown || touchMove.up);
      const down = !typing && (this.keys.down.isDown || this.wasd.down.isDown || touchMove.down);
      const body = this.player.body;
      let dir = this.playerDir || 'down';
      let anim = this.sitting ? 'sit' : 'idle';
      body.setVelocity(0, 0);
      if (!this.sitting && !this.transitionRequested) {
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
      if (!this.sitting) {
        this.player.x = Phaser.Math.Clamp(this.player.x, 16, this.mapWidth - 16);
        this.player.y = Phaser.Math.Clamp(this.player.y, 16, this.mapHeight - 16);
      }
      if (this.sitting) {
        this.player.setPosition(this.sitX, this.sitY);
        body.setVelocity(0, 0);
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
      if (this.localPet) {
        this._stepPet(this.localPet, this.player.x, this.player.y, delta, this.sitting);
        this.localPet.setDepth?.(this.localPet.y - 1);
      }
      for (const remote of Object.values(this.remotes)) {
        if (remote.pet) {
          this._stepPet(remote.pet, remote.sprite.x, remote.sprite.y, delta, remote.seated);
          remote.pet.setDepth?.(remote.pet.y - 1);
        }
        if (remote.chatBubble) remote.chatBubble.setPosition(remote.sprite.x, remote.sprite.y - 85);
      }
      if (this.localBubble) this.localBubble.setPosition(this.player.x, this.player.y - 78);

      let seat = null;
      if (!this.sitting && this.location.startsWith('home:')) {
        seat = this.furniture.find((item) => item.getData('isSeat') &&
          Phaser.Math.Distance.Between(this.player.x, this.player.y, item.x, item.y) <= 52);
      } else if (!this.sitting) {
        seat = this.seats.find((item) => Phaser.Math.Distance.Between(this.player.x, this.player.y, item.x, item.y) <= 52);
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
      if (door) this.interactHint.setText('Walking through…').setPosition(this.player.x, this.player.y - 65).setVisible(true);
      else if (this.sitting) this.interactHint.setText('[E] Stand').setPosition(this.player.x, this.player.y - 65).setVisible(true);
      else if (seat) this.interactHint.setText('[E] Sit').setPosition(this.player.x, this.player.y - 65).setVisible(true);
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
             socket.emit('playerMove', { ...portalPoint, anim: 'idle' });
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
        if (this.sitting) {
          this.sitting = false;
          body.enable = true;
          this.player.setPosition(this.preSitX, this.preSitY);
          body.reset(this.preSitX, this.preSitY);
        } else if (seat) {
          this.sitting = true;
          this.preSitX = this.player.x; this.preSitY = this.player.y;
          this.sitX = seat.x; this.sitY = seat.getData ? seat.y + 10 : seat.y;
          this.playerDir = seat.getData ? (seat.getData('seatDir') || 'down') : (seat.dir || 'down');
          body.enable = false; // server excludes the oak chair for the sit snap
          this.player.setPosition(this.sitX, this.sitY);
        }
      }
      this.lastSend += delta;
      if (this.lastSend >= 50) {
        this.lastSend = 0;
        socket.emit('playerMove', { x: this.player.x, y: this.player.y, dir: this.playerDir, anim });
      }
    }

    shutdown() {
      this._resetTransientTravel();
      this._removePlacementInput();
      this._clearGhost();
      this._clearLocalPresentation();
      Object.keys(this.remotes).forEach((id) => this._removeRemote(id));
      this.remotes = {};
      this.furniture = [];
      this.streetLotsVisual = null;
      this.localBubble = null;
      this.player = null;
      this.localNameTag = null;
      this.interactHint = null;
      this._geometryBlocks = this._yardBlocks = this._furnitureBlocks = null;
      this.keys = this.wasd = this.keyE = null;
      if (window._neighborhoodScene === this) window._neighborhoodScene = null;
    }
  }

  socket.on('locationTransitionResult', (result) => {
    const generation = ++sceneTransitionGeneration;
    clearTimeout(sceneTransitionTimer);
    sceneTransitionTimer = null;
    if (!result?.ok) {
      officePortalTransition = false;
      const active = window._phaserGame?.scene?.getScenes(true)?.find((scene) => scene._portalFading);
      if (active) {
        active._portalFading = false;
        active._portalFadeAt = 0;
        active.cameras.main.fadeIn(160, 16, 22, 34);
      }
      if (window._neighborhoodScene) window._neighborhoodScene.transitionRequested = false;
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
        // Stopping a scene that is already inactive is harmless; importantly,
        // this branch is generation-gated so an old home/street result cannot
        // stop the currently active shared scene.
        if (game.scene.isActive('NeighborhoodScene')) game.scene.stop('NeighborhoodScene');
        if (game.scene.isSleeping('OfficeScene')) game.scene.wake('OfficeScene');
        else if (!game.scene.isActive('OfficeScene')) game.scene.start('OfficeScene');
        const office = game.scene.getScene('OfficeScene');
        if (office.player) {
          office.player.setPosition(result.self.x, result.self.y);
          office.player.body?.reset(result.self.x, result.self.y);
        }
        office._portalFading = false;
        office.cameras.main.fadeIn(220, 16, 22, 34);
        officePortalRelease = false;
        officePortalTransition = false;
      } else {
         // OfficeScene was already asleep after the first outdoor transition;
         // Phaser warns (and some builds interrupt the next scene lifecycle)
         // when asked to sleep it again.
        if (game.scene.isActive('OfficeScene')) game.scene.sleep('OfficeScene');
        const sceneData = { ...result, _sceneTransitionGeneration: generation };
        // NeighborhoodScene is deliberately shared by city, street, shop and
        // homes. Starting an already-active key queues a stop/start pair; a
        // second delayed result could then leave its replacement stopped.
        // Restart has one ordered lifecycle and its create() owns fade-in.
        if (game.scene.isActive('NeighborhoodScene')) {
          game.scene.getScene('NeighborhoodScene').scene.restart(sceneData);
        } else {
          game.scene.start('NeighborhoodScene', sceneData);
        }
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

  socket.on('currentPlayers', (players) => window._neighborhoodScene?.syncPlayers(players || {}));
  socket.on('playerJoined', (player) => window._neighborhoodScene?.addRemote(player?.id, player));
  socket.on('playerMoved', (player) => window._neighborhoodScene?.moveRemote(player));
  socket.on('playerMoveCorrection', (player) => {
    if (window._neighborhoodScene) return window._neighborhoodScene.correctLocal(player);
    const office = window._phaserGame?.scene?.getScene('OfficeScene');
    if (office?.player && Number.isFinite(player?.x) && Number.isFinite(player?.y)) {
      office.player.setPosition(player.x, player.y);
      office.player.body?.reset(player.x, player.y);
    }
  });
  socket.on('playerLeft', (id) => window._neighborhoodScene?._removeRemote(id));
  socket.on('chatMessage', (payload) => {
    if (typeof payload?.message === 'string') window._neighborhoodScene?.showChat(payload.id, payload.message);
  });
  socket.on('chatImage', (payload) => window._neighborhoodScene?.showChat(payload?.id, '📷 shared a photo'));
  socket.on('shopSuccess', () => window._neighborhoodScene?._setLocalPresentation());
  socket.on('equipUpdate', () => window._neighborhoodScene?._setLocalPresentation());
  socket.on('outfitSuccess', () => window._neighborhoodScene?._setLocalPresentation());
  socket.on('avatarSuccess', () => window._neighborhoodScene?._setLocalPresentation());
  socket.on('petSuccess', () => window._neighborhoodScene?._setLocalPresentation());
  socket.on('petUpdate', () => window._neighborhoodScene?._setLocalPresentation());
  socket.on('petAccSuccess', () => window._neighborhoodScene?._setLocalPresentation());
  socket.on('petAccUpdate', () => window._neighborhoodScene?._setLocalPresentation());
  socket.on('petEvolved', (payload) => { if (payload?.id === socket.id) window._neighborhoodScene?._setLocalPresentation(); });
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