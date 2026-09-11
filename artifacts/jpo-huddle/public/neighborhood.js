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
  let editorOpen = false;
  let currentLocation = 'office';
  let directory = [];
  let directoryPage = 0;
  let directoryMeta = { page: 0, pageCount: 1, total: 0 };
  // This only selects which permitted residence the plaza doorway will open.
  // It never emits a transition; travel still requires walking through that
  // visible map doorway.
  let selectedVisitEmail = '';

  const globals = () => getGlobals() || {};
  const toast = (message) => globals().showToast?.(message);
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
  const isResidentialBlock = () => ['city', 'maple-row', 'juniper-square'].includes(currentLocation);
  const travel = (destination) => socket.emit('locationTransition', { destination });
  const requestDirectory = (page = directoryPage) => {
    directoryPage = Math.max(0, Number(page) || 0);
    socket.emit('homeDirectoryRequest', { page: directoryPage });
  };

  function renderHome() {
    if (!isHome() || !homeState) {
      if (!isResidentialBlock()) {
        homePanel.hidden = true;
        return;
      }
      homePanel.hidden = false;
      const ownEmail = globals()._playerEmail || '';
      const homes = directory;
      const selected = selectedVisitEmail || ownEmail;
      homePanel.innerHTML =
        '<div class="home-panel-head"><b>Homes directory</b><button type="button" data-collapse>Hide</button></div>' +
        '<div class="home-section home-directory"><small>Approved homes · directory block ' + (directoryMeta.page + 1) + ' of ' + directoryMeta.pageCount +
        '. Choose a resident, then walk through any glowing RESIDENCE doorway. Choosing a name never travels you.</small>' +
        (homes.length ? homes.map((home) => '<button type="button" class="home-directory-item ' +
          (home.ownerEmail === selected ? 'selected' : '') + '" data-home-target="' + escapeHtml(home.ownerEmail) + '">' +
          escapeHtml(home.name || home.ownerEmail) + ' <small>(' + escapeHtml(home.accessMode) + ')</small></button>').join('') :
          '<small>No homes available yet.</small>') +
        (directoryMeta.pageCount > 1 ? '<div class="home-pager"><button type="button" data-page="prev" ' +
          (directoryMeta.page <= 0 ? 'disabled' : '') + '>Previous block</button><button type="button" data-page="next" ' +
          (directoryMeta.page >= directoryMeta.pageCount - 1 ? 'disabled' : '') + '>Next block</button></div>' : '') +
        '</div><small class="home-panel-note">Selected residence: ' + escapeHtml(selected || 'your home') + '</small>';
      homePanel.querySelector('[data-collapse]').onclick = () => { homePanel.hidden = true; };
      homePanel.querySelectorAll('[data-page]').forEach((button) => {
        button.onclick = () => requestDirectory(button.dataset.page === 'next' ? directoryMeta.page + 1 : directoryMeta.page - 1);
      });
      homePanel.querySelectorAll('[data-home-target]').forEach((button) => {
        button.onclick = () => {
          selectedVisitEmail = button.dataset.homeTarget || '';
          renderHome();
        };
      });
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
       '<div class="home-section home-directory"><small>Neighbors — select one at a residential street, then use a glowing RESIDENCE doorway.</small>' +
      directoryMarkup + '</div>' +
      (editorOpen ? editor : (canEdit ? '<small class="home-panel-note">Open panel to place, store, or manage your home.</small>' : ''));

    homePanel.querySelector('[data-collapse]').onclick = () => { editorOpen = !editorOpen; renderHome(); };
    homePanel.querySelectorAll('[data-select]').forEach((button) => {
      button.onclick = () => {
        selectedInstance = button.dataset.select;
        selectedRotation = 0;
        editorOpen = true;
        renderHome();
      };
    });
    homePanel.querySelectorAll('[data-return]').forEach((button) => {
      button.onclick = () => socket.emit('homeLayoutReturn', { instanceId: button.dataset.return });
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
      '<div class="home-section"><small>You reached the furnishings counter. Prices are coins; Buy adds the item to your home Inventory. Leave through the glowing PLAZA exit, then enter your home to place it.</small>' + rows + '</div>';
    panel.querySelector('[data-close]').onclick = () => { panel.hidden = true; };
    panel.querySelectorAll('[data-buy]').forEach((button) => {
      button.onclick = () => socket.emit('homePurchase', { furnitureId: button.dataset.buy });
    });
  }

  requestDirectory();
  socket.on('homeDirectory', (payload) => {
    directory = Array.isArray(payload) ? payload : (Array.isArray(payload?.homes) ? payload.homes : []);
    directoryMeta = {
      page: Number.isInteger(payload?.page) ? payload.page : directoryPage,
      pageCount: Math.max(1, Number(payload?.pageCount) || 1),
      total: Number(payload?.total) || directory.length,
    };
    directoryPage = directoryMeta.page;
    if (payload?.error) toast(payload.error);
    renderHome();
  });
  socket.on('homeSnapshot', (state) => {
    if (!state || typeof state !== 'object') return;
    homeState = state;
    window._neighborhoodScene?.renderFurniture(state);
    renderHome();
  });
  socket.on('homePurchaseResult', (result) => {
    if (result?.home) homeState = result.home;
    if (result?.message) toast(result.message);
    if (isHome()) renderHome();
  });
  socket.on('homeActionResult', (result) => {
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
      ['oak_chair', 'fern', 'reading_lamp', 'coffee_table', 'blue_sofa', 'bookcase'].forEach((id) => {
        this.load.image('furn_' + id, '/assets/neighborhood/furniture/' + id + '.png');
      });
      ['house', 'townhouse', 'shop', 'tree', 'bench', 'lamp'].forEach((id) => {
        this.load.image('ext_' + id, '/assets/neighborhood/exterior/' + id + '.png');
      });
    }

    create(data) {
      this._resetTransientTravel();
      this._removePlacementInput();
      window._neighborhoodScene = this;
      this.info = data?.map || {};
      this.location = data?.location || currentLocation;
      const bounds = this.info.bounds || { width: this.info.width || 1152, height: this.info.height || 816 };
      this.mapWidth = bounds.width;
      this.mapHeight = bounds.height;
      this.actorFootRadius = Number(this.info.actorFootRadius) || 16;
      const atHome = this.location.startsWith('home:');
      this.physics.world.setBounds(0, 0, this.mapWidth, this.mapHeight);
      this.cameras.main.setBounds(0, 0, this.mapWidth, this.mapHeight);

      // All maps are composed here from repeatable tile-sized ground, paths,
      // and separate transparent objects. None uses a baked screenshot/map PNG.
      if (atHome) this._drawHome();
      else if (this.location === 'furniture-shop') this._drawShop();
      else if (this.location === 'neighborhood') this._drawNeighborhood();
      else if (this.location === 'maple-row' || this.location === 'juniper-square') this._drawResidentialBlock(this.location);
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
      this._furnitureBlocks = this.physics.add.staticGroup();
      (this.info.geometry?.blockers || []).forEach((block) => this._addBlock(this._geometryBlocks, block));
      this.physics.add.collider(this.player, this._geometryBlocks);
      this.physics.add.collider(this.player, this._furnitureBlocks);
      this.doors = this.info.portals || [];
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

    _exterior(kind, x, y, scale = 2, _depth = 4) {
      // Exterior art sorts by its ground contact point, allowing a player to
      // pass naturally behind a roof or tree and in front once below it.
      return this.add.image(x, y, 'ext_' + kind).setOrigin(0.5, 1).setScale(scale).setDepth(y);
    }

    _sign(x, y, text) {
      return this.add.text(x, y, text, {
        fontFamily: 'monospace', fontSize: '12px', color: '#fff4cf',
        backgroundColor: '#35424acc', padding: { x: 5, y: 3 },
      }).setOrigin(0.5, 1).setDepth(2000);
    }

    _drawNeighborhood() {
      this._tileField(0x77a45f, 0x6f9b59);
      this._path({ x: 0, y: 432, width: 1440, height: 192 }, 0x55616a, 0x3f4950);
      this._path({ x: 0, y: 408, width: 1440, height: 24 }, 0xd8ccb3);
      this._path({ x: 0, y: 624, width: 1440, height: 24 }, 0xd8ccb3);
      this._path({ x: 576, y: 0, width: 144, height: 432 });
      this._path({ x: 576, y: 624, width: 144, height: 432 });
      this._path({ x: 1200, y: 432, width: 144, height: 192 });
      this._roadDetails(528, 648, [{ x: 636, y: 420 }, { x: 636, y: 636 }]);
      this._exterior('townhouse', 636, 330);
      [[430, 260], [480, 728], [960, 748], [116, 790], [1294, 214], [330, 770]].forEach(([x, y]) => this._exterior('tree', x, y));
      [[500, 420], [816, 420], [1160, 420], [278, 420]].forEach(([x, y]) => this._exterior('lamp', x, y, 2));
      [[420, 604], [900, 420], [1100, 420]].forEach(([x, y]) => this._exterior('bench', x, y, 2));
      this._sign(636, 82, 'WILLOW WALK');
      this._sign(636, 234, 'Your townhouse');
    }

    _drawCity() {
      this._tileField(0x83aa68, 0x789d60);
      this._path({ x: 0, y: 432, width: 1152, height: 144 }, 0x535e66, 0x3e4750);
      this._path({ x: 456, y: 0, width: 240, height: 912 }, 0x535e66, 0x3e4750);
      this._path({ x: 0, y: 408, width: 1152, height: 24 });
      this._path({ x: 0, y: 576, width: 1152, height: 24 });
      this._path({ x: 432, y: 0, width: 24, height: 912 });
      this._path({ x: 696, y: 0, width: 24, height: 912 });
      this._path({ x: 254, y: 340, width: 72, height: 92 });
      this._path({ x: 836, y: 328, width: 72, height: 104 });
      this._roadDetails(504, 576, [{ x: 444, y: 504 }, { x: 708, y: 504 }, { x: 576, y: 420, vertical: true }, { x: 576, y: 588, vertical: true }]);
      this._exterior('house', 290, 340);
      this._exterior('shop', 872, 328);
      [[120, 236], [445, 210], [705, 206], [1032, 224], [92, 728], [1048, 736]].forEach(([x, y]) => this._exterior('tree', x, y));
      [[398, 384], [744, 384], [402, 630], [746, 630]].forEach(([x, y]) => this._exterior('lamp', x, y, 2));
      [[520, 394], [630, 394], [520, 600], [630, 600]].forEach(([x, y]) => this._exterior('bench', x, y, 2));
      const plaza = this.add.graphics().setDepth(2);
      plaza.fillStyle(0xbfd3cb, 1).fillCircle(576, 500, 92).lineStyle(4, 0xe9dfb9, 0.8).strokeCircle(576, 500, 92);
      plaza.fillStyle(0x66a7c0, 1).fillCircle(576, 500, 34).lineStyle(3, 0xe9f8ff, 0.85).strokeCircle(576, 500, 34);
       this._sign(290, 80, 'YOUR HOME');
      this._sign(872, 88, 'HUDDLE HOME');
      this._sign(576, 302, 'HUDDLE PLAZA');
       this._sign(1084, 420, 'MAPLE ROW →');
       this._sign(576, 800, '↓ JUNIPER SQUARE');
    }

    _drawResidentialBlock(kind) {
      const maple = kind === 'maple-row';
      this._tileField(maple ? 0x78a762 : 0x74a06a, maple ? 0x709b59 : 0x6a965f);
      this._path({ x: 0, y: 432, width: 1152, height: 144 }, 0x535e66, 0x3e4750);
      this._path({ x: 552, y: 0, width: 48, height: 912 }, 0x535e66, 0x3e4750);
      this._path({ x: 0, y: 408, width: 1152, height: 24 });
      this._path({ x: 0, y: 576, width: 1152, height: 24 });
      this._path({ x: 528, y: 0, width: 24, height: 912 });
      this._path({ x: 600, y: 0, width: 24, height: 912 });
      const homes = [[180, 340], [420, 340], [732, 340], [972, 340], [180, 812], [420, 812], [732, 812], [972, 812]];
      homes.forEach(([x, bottom], index) => {
        // This is the same 72px clear door path represented in the shared
        // geometry; every shown home has one of the real residence portals.
        this._path({ x: x - 36, y: bottom < 500 ? bottom - 90 : 576, width: 72,
          height: bottom < 500 ? 198 : bottom - 566 });
        this._exterior('house', x, bottom);
        this._sign(x, bottom - 102, 'RESIDENCE ' + (index + 1));
      });
      const trees = maple
        ? [[87, 234], [559, 234], [1115, 252], [99, 756], [561, 780], [1107, 756]]
        : [[87, 242], [559, 250], [1115, 242], [103, 756], [561, 768], [1107, 766]];
      trees.forEach(([x, y]) => this._exterior('tree', x, y));
      [[576, 410], [576, 600]].forEach(([x, y]) => this._exterior('bench', x, y, 2));
      this._roadDetails(504, 576, [{ x: 540, y: 420 }, { x: 612, y: 588 }]);
      this._sign(576, 72, maple ? 'MAPLE ROW · 8 RESIDENCES' : 'JUNIPER SQUARE · 8 RESIDENCES');
      this._sign(576, 128, 'Select an approved home in the directory, then walk through a glowing residence door.');
    }

    _drawShop() {
      this._tileField(0xe0cda6, 0xd5bd91);
      const art = this.add.graphics().setDepth(2);
      art.lineStyle(8, 0x8e6b50, 1).strokeRect(4, 4, this.mapWidth - 8, this.mapHeight - 8);
      // Counter, display plinths, rugs, and a clear lower exit make this an
      // authored interior instead of a flattened shop design.
      art.fillStyle(0x80583f, 1).fillRect(144, 154, 672, 74).lineStyle(3, 0x533826, 1).strokeRect(144, 154, 672, 74);
      [140, 662].forEach((x) => art.fillStyle(0x9c7357, 1).fillRect(x, 378, 156, 80).lineStyle(2, 0x624431, 1).strokeRect(x, 378, 156, 80));
      art.fillStyle(0xb85f5c, 0.82).fillRoundedRect(344, 324, 272, 150, 16).lineStyle(3, 0xf0d8ab, 0.8).strokeRoundedRect(344, 324, 272, 150, 16);
      [[112, 108], [848, 108], [100, 560], [860, 560]].forEach(([x, y]) =>
        this.add.image(x, y, 'furn_fern').setDisplaySize(48, 48).setDepth(4));
       this._sign(480, 112, 'HUDDLE HOME · FURNISHINGS');
       this.add.text(480, 190, 'FURNITURE PRICES IN COINS · crossing this door opens the catalog · purchases go to your home inventory.', {
        fontFamily: 'monospace', fontSize: '12px', color: '#fff7db', backgroundColor: '#493c36cc', padding: { x: 6, y: 4 }, align: 'center',
      }).setOrigin(0.5).setDepth(18);
    }

    _drawHome() {
      this._tileField(0xe3d2b1, 0xd9c39e);
      const art = this.add.graphics().setDepth(2);
      art.lineStyle(8, 0x8b6d52, 1).strokeRect(4, 4, this.mapWidth - 8, this.mapHeight - 8);
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
       this.add.text(288, 390, 'PLAZA EXIT ↓', { fontFamily: 'monospace', fontSize: '10px', color: '#fff5d6', backgroundColor: '#604332cc', padding: { x: 4, y: 2 } }).setOrigin(0.5).setDepth(12);
    }

    _drawPortalCues() {
      for (const portal of this.doors) {
        const cue = this.add.graphics().setDepth(3);
        cue.fillStyle(0xf6df75, 0.32).fillRoundedRect(portal.x + 3, portal.y + 3, portal.width - 6, portal.height - 6, 7);
        cue.lineStyle(2, 0xfff1a8, 0.9).strokeRoundedRect(portal.x + 3, portal.y + 3, portal.width - 6, portal.height - 6, 7);
        const label = portal.destination === 'home' ? (portal.residence ? 'RESIDENCE' : 'YOUR HOME') :
          portal.destination === 'furniture-shop' ? 'FURNISHINGS' : portal.destination === 'city' ? 'PLAZA' :
          portal.destination === 'maple-row' ? 'MAPLE ROW' : portal.destination === 'juniper-square' ? 'JUNIPER SQ' :
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
      this._placementMoveHandler = (pointer) => {
        if (!atHome || !homeState?.canEdit || !selectedInstance) return this._clearGhost();
        const item = homeState.inventory?.find((candidate) => candidate.id === selectedInstance);
        const def = item && furnitureCatalog[item.furnitureId];
        if (!def) return this._clearGhost();
        const gridX = Math.floor(pointer.worldX / 48), gridY = Math.floor(pointer.worldY / 48);
        const footprint = this._footprint(def, selectedRotation);
        const blocked = !this._validPlacement(def, gridX, gridY, selectedRotation);
        if (!this.ghost) this.ghost = this.add.image(0, 0, 'furn_' + def.id).setAlpha(0.6).setDepth(25);
        this.ghost.setTexture('furn_' + def.id).setDisplaySize(def.width * 48, def.height * 48).setAngle(selectedRotation)
          .setPosition(gridX * 48 + footprint.width * 24, gridY * 48 + footprint.height * 24);
        if (blocked) this.ghost.setTint(0xff5555); else this.ghost.clearTint();
      };
      this._placementDownHandler = (pointer) => {
        if (!atHome || !homeState?.canEdit || !selectedInstance || !this.ghost || this.ghost.isTinted) {
          if (atHome && selectedInstance && this.ghost?.isTinted) toast('That furniture does not fit there.');
          return;
        }
        socket.emit('homeLayoutSet', {
          instanceId: selectedInstance, gridX: Math.floor(pointer.worldX / 48), gridY: Math.floor(pointer.worldY / 48), rotation: selectedRotation,
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

    _footprint(def, rotation) {
      return rotation % 180 === 90 ? { width: def.height || 1, height: def.width || 1 } : { width: def.width || 1, height: def.height || 1 };
    }

    _validPlacement(def, gridX, gridY, rotation) {
      const footprint = this._footprint(def, rotation);
      if (gridX < 0 || gridY < 0 || gridX + footprint.width > 12 || gridY + footprint.height > 9 ||
          (gridX < 7 && gridX + footprint.width > 5 && gridY < 9 && gridY + footprint.height > 6)) return false;
      return !(homeState?.layout || []).some((placed) => {
        const other = furnitureCatalog[placed.furnitureId];
        if (!other) return false;
        const otherFootprint = this._footprint(other, placed.rotation);
        return gridX < placed.gridX + otherFootprint.width && gridX + footprint.width > placed.gridX &&
          gridY < placed.gridY + otherFootprint.height && gridY + footprint.height > placed.gridY;
      });
    }

    renderFurniture(state) {
      if (!this.scene.isActive() || !this.location?.startsWith('home:')) return;
      this.furniture.forEach((object) => object.destroy());
      this.furniture = [];
      this._furnitureBlocks?.clear(true, true);
      for (const item of state?.layout || []) {
        const def = furnitureCatalog[item.furnitureId];
        if (!def) continue;
        const uprightRotation = def.rotations.includes(item.rotation) ? item.rotation : 0;
        const footprint = this._footprint(def, uprightRotation);
        const sprite = this.add.image(item.gridX * 48 + footprint.width * 24, item.gridY * 48 + footprint.height * 24, 'furn_' + def.id)
          .setDisplaySize(def.width * 48, def.height * 48).setAngle(uprightRotation).setDepth(5 + item.gridY);
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
      if (!this.scene.isActive()) return;
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
      const left = !typing && (this.keys.left.isDown || this.wasd.left.isDown);
      const right = !typing && (this.keys.right.isDown || this.wasd.right.isDown);
      const up = !typing && (this.keys.up.isDown || this.wasd.up.isDown);
      const down = !typing && (this.keys.down.isDown || this.wasd.down.isDown);
      const body = this.player.body;
      let dir = this.playerDir || 'down';
      let anim = this.sitting ? 'sit' : 'idle';
      body.setVelocity(0, 0);
      if (!this.sitting && !this.transitionRequested) {
        if (left) { body.setVelocityX(-170); dir = 'left'; anim = 'walk'; }
        else if (right) { body.setVelocityX(170); dir = 'right'; anim = 'walk'; }
        else if (up) { body.setVelocityY(-170); dir = 'up'; anim = 'walk'; }
        else if (down) { body.setVelocityY(170); dir = 'down'; anim = 'walk'; }
      }
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
      // Use the inner doorway rather than the painted edge so the server's
      // most recent 50ms movement sample cannot fall just outside a portal.
      const door = this.doors.find((item) => this.player.x >= item.x + 12 && this.player.x <= item.x + item.width - 12 &&
        this.player.y >= item.y + 12 && this.player.y <= item.y + item.height - 12);
      if (door) this.interactHint.setText('Walking through…').setPosition(this.player.x, this.player.y - 65).setVisible(true);
      else if (this.sitting) this.interactHint.setText('[E] Stand').setPosition(this.player.x, this.player.y - 65).setVisible(true);
      else if (seat) this.interactHint.setText('[E] Sit').setPosition(this.player.x, this.player.y - 65).setVisible(true);
      else this.interactHint.setVisible(false);
      if (door && this.portalRelease && !this.transitionRequested) {
        const destination = door.destination === 'home'
          ? ('home:' + (door.residence
            ? (selectedVisitEmail || globals()._playerEmail || '')
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
      if (window._neighborhoodScene === this) window._neighborhoodScene = null;
    }
  }

  socket.on('locationTransitionResult', (result) => {
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
      currentLocation = result.location;
      title.textContent = result.map?.label || result.location;
      furnitureCatalog = result.catalog || furnitureCatalog;
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
        game.scene.stop('NeighborhoodScene');
        game.scene.wake('OfficeScene');
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
        game.scene.start('NeighborhoodScene', result);
        const next = game.scene.getScene('NeighborhoodScene');
        next._portalFading = false;
        next.cameras.main.fadeIn(220, 16, 22, 34);
      }
    };
    const elapsed = outgoing?._portalFading ? performance.now() - (outgoing._portalFadeAt || performance.now()) : 0;
    if (outgoing?._portalFading && elapsed < 220) setTimeout(finish, 220 - elapsed);
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