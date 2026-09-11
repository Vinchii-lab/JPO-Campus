// Shared city / home presentation. Server transitions, permissions, placement,
// and movement validation remain authoritative in server.js / neighborhood.mjs.
window.initNeighborhoodUI = function(socket, getGlobals) {
  if (document.getElementById('neighborhood-ui')) return;

  const ui = document.createElement('div');
  ui.id = 'neighborhood-ui';
  // Travel belongs to authored map doors, not a screen-covering button bar.
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

  const globals = () => getGlobals() || {};
  const toast = (message) => globals().showToast?.(message);
  const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[char]);
  const isHome = () => currentLocation.startsWith('home:');
  const travel = (destination) => socket.emit('locationTransition', { destination });
  window.jpoTravel = travel;

  function renderHome() {
    if (!isHome() || !homeState) {
      homePanel.hidden = true;
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
      ? directory.map((home) => '<button type="button" class="home-directory-item" data-visit="' +
          escapeHtml(home.ownerEmail) + '">' + escapeHtml(home.name || home.ownerEmail) +
          ' <small>(' + escapeHtml(home.accessMode) + ')</small></button>').join('')
      : '<small>No homes available to visit.</small>';

    const editor = canEdit ? (
      '<div class="home-section home-editor-controls">' +
        '<button type="button" data-rotate ' + (!selectedInstance ? 'disabled' : '') + '>Rotate ' + selectedRotation + '°</button>' +
        '<label>Access <select id="home-access"><option value="public">Public</option><option value="invite_only">Invite only</option><option value="private">Private</option></select></label>' +
        '<button type="button" data-access>Save</button>' +
        '<div class="home-invite"><input id="home-invite-email" type="email" maxlength="80" placeholder="coworker@email.com"><button type="button" data-invite>Invite</button></div>' +
        (Array.isArray(homeState.invitations) && homeState.invitations.length
          ? '<small>Invited</small>' + homeState.invitations.map((invite) =>
              '<span class="home-item">' + escapeHtml(invite.name || invite.email) +
              '<button type="button" data-revoke="' + escapeHtml(invite.email) + '">Revoke</button></span>',
            ).join('')
          : '') +
        '<small>Inventory — choose an item, then click a valid grid position.</small>' + inventoryMarkup +
        '<small>Placed items</small>' + layoutMarkup +
      '</div>'
    ) : '<div class="home-section"><small>The owner controls this room. Furniture updates live.</small></div>';

    homePanel.innerHTML =
      '<div class="home-panel-head"><b>' + (canEdit ? 'Your starter home' : 'Visiting a home') +
      '</b><button type="button" data-collapse>' + (editorOpen ? 'Collapse' : 'Open panel') + '</button></div>' +
      '<div class="home-section home-directory"><small>Visit coworkers <button type="button" data-refresh-dir>Refresh</button></small>' +
      directoryMarkup + '</div>' +
      (editorOpen ? editor : (canEdit ? '<small class="home-panel-note">Open panel to place, store, or manage your home.</small>' : ''));

    homePanel.querySelector('[data-collapse]').onclick = () => { editorOpen = !editorOpen; renderHome(); };
    homePanel.querySelector('[data-refresh-dir]').onclick = () => socket.emit('homeDirectoryRequest');
    homePanel.querySelectorAll('[data-visit]').forEach((button) => {
      button.onclick = () => travel('home:' + button.dataset.visit);
    });
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
    homePanel.querySelector('[data-rotate]')?.addEventListener('click', () => {
      selectedRotation = (selectedRotation + 90) % 360;
      renderHome();
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
    panel.innerHTML = '<div class="home-panel-head"><b>Huddle Home shop</b><button type="button" data-close>Close</button></div>' +
      '<div class="home-section"><small>Furniture catalog</small>' + rows + '</div>';
    panel.querySelector('[data-close]').onclick = () => { panel.hidden = true; };
    panel.querySelectorAll('[data-buy]').forEach((button) => {
      button.onclick = () => socket.emit('homePurchase', { furnitureId: button.dataset.buy });
    });
  }

  socket.emit('homeDirectoryRequest');
  socket.on('homeDirectory', (payload) => {
    directory = Array.isArray(payload) ? payload : (Array.isArray(payload?.homes) ? payload.homes : []);
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
      this.load.image('neighborhood_shop_floor', '/assets/neighborhood/Ice_Cream_Shop_Design_layer_1_48x48.png');
      this.load.image('neighborhood_shop_decor', '/assets/neighborhood/Ice_Cream_Shop_Design_layer_2_48x48.png');
    }

    create(data) {
      window._neighborhoodScene = this;
      this.info = data?.map || {};
      this.location = data?.location || currentLocation;
      const bounds = this.info.bounds || { width: this.info.width || 1152, height: this.info.height || 816 };
      this.mapWidth = bounds.width;
      this.mapHeight = bounds.height;
      const atHome = this.location.startsWith('home:');
      this.physics.world.setBounds(0, 0, this.mapWidth, this.mapHeight);
      this.cameras.main.setBounds(0, 0, this.mapWidth, this.mapHeight);

      const art = this.add.graphics();
      if (atHome) {
        art.fillStyle(0xdfd3b8, 1).fillRect(0, 0, this.mapWidth, this.mapHeight);
        art.lineStyle(8, 0x8a7258, 1).strokeRect(4, 4, this.mapWidth - 8, this.mapHeight - 8);
        for (let x = 0; x <= this.mapWidth; x += 48) art.lineStyle(1, 0x000000, 0.15).lineBetween(x, 0, x, this.mapHeight);
        for (let y = 0; y <= this.mapHeight; y += 48) art.lineStyle(1, 0x000000, 0.15).lineBetween(0, y, this.mapWidth, y);
      } else if (this.location === 'furniture-shop') {
        this.add.image(this.mapWidth / 2, this.mapHeight / 2, 'neighborhood_shop_floor').setDisplaySize(this.mapWidth, this.mapHeight);
        this.add.image(this.mapWidth / 2, this.mapHeight / 2, 'neighborhood_shop_decor').setDisplaySize(this.mapWidth, this.mapHeight).setDepth(5);
      } else {
        art.fillStyle(0x8a9e88, 1).fillRect(0, 0, this.mapWidth, this.mapHeight);
      }

      const self = data?.self || data?.spawn || {};
      const g = globals();
      const char = g._playerChar || self.character || 'adam';
      const baked = g._bakedWearIds?.(char, g._equippedCosmetic, g._equippedWings, g._equippedSlots) || [];
      this.playerTexKey = this._office('_buildPlayerTex', char, g._playerHairIdx || 0, g._playerSkinIdx || 0,
        g._playerShirtIdx || 0, g._playerPantsIdx || 0, baked) || ('run_' + char);
      this.playerDir = self.dir || 'down';
      this.player = this.physics.add.sprite(self.x || 24, self.y || 24, this.playerTexKey, g.DIR_START?.[this.playerDir] || 0)
        .setScale(3).setOrigin(0.5, 0.5);
      this.player.body.setSize(12, 10).setOffset(2, 20);
      this.player.body.setCollideWorldBounds(true);
      this.localNameTag = this._makeNameTag(this.player.x, this.player.y, g._playerName || self.name || 'You') ||
        this.add.text(this.player.x, this.player.y - 40, g._playerName || 'You', { fontSize: '14px', fontFamily: 'monospace', color: '#fff', backgroundColor: '#000000bb', padding: { x: 5, y: 3 } }).setOrigin(0.5, 1);
      this.localNameTag.setDepth(12);
      this.cameras.main.startFollow(this.player);

      this._geometryBlocks = this.physics.add.staticGroup();
      this._furnitureBlocks = this.physics.add.staticGroup();
      (this.info.geometry?.blockers || []).forEach((block) => this._addBlock(this._geometryBlocks, block));
      this.physics.add.collider(this.player, this._geometryBlocks);
      this.physics.add.collider(this.player, this._furnitureBlocks);
      this.doors = this.info.geometry?.doors || [];
      this.keys = this.input.keyboard.createCursorKeys();
      this.wasd = this.input.keyboard.addKeys({ up: 'W', down: 'S', left: 'A', right: 'D' });
      this.keyE = this.input.keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.E);
      this.lastSend = 0;
      this.interactHint = this.add.text(0, 0, '', { fontFamily: 'monospace', fontSize: '11px', color: '#000', backgroundColor: '#fff', padding: { x: 3, y: 2 } }).setOrigin(0.5).setDepth(30).setVisible(false);

      this._setLocalPresentation();
      this.renderFurniture(homeState);
      this.syncPlayers(data?.players || {});
      this._installPlacementInput(atHome);
    }

    _addBlock(group, rect) {
      // Server pointHitsRect uses a 16px radius. With the Office foot body
      // (12×10), inflating by 10/11px makes client collision stop at the same
      // center position rather than allowing a packet the server will reject.
      const r = this.add.rectangle(rect.x + rect.width / 2, rect.y + rect.height / 2,
        rect.width + 20, rect.height + 22, 0, 0);
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
      this.input.on('pointermove', (pointer) => {
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
      });
      this.input.on('pointerdown', (pointer) => {
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
      });
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
          (gridY + footprint.height > 8 && gridX <= 6 && gridX + footprint.width > 5)) return false;
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
        const footprint = this._footprint(def, item.rotation);
        const sprite = this.add.image(item.gridX * 48 + footprint.width * 24, item.gridY * 48 + footprint.height * 24, 'furn_' + def.id)
          .setDisplaySize(def.width * 48, def.height * 48).setAngle(item.rotation).setDepth(5 + item.gridY);
        sprite.setData('isSeat', def.id === 'oak_chair'); // server currently validates chairs only
        sprite.setData('seatDir', ['down', 'left', 'up', 'right'][(item.rotation / 90) % 4] || 'down');
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
        const sprite = this.add.sprite(player.x, player.y, texture).setScale(3).setOrigin(0.5, 0.5);
        const nameTag = this._makeNameTag(player.x, player.y, player.name || 'Coworker') ||
          this.add.text(player.x, player.y - 40, player.name || 'Coworker', { fontSize: '14px', fontFamily: 'monospace', color: '#fff', backgroundColor: '#000000bb', padding: { x: 5, y: 3 } }).setOrigin(0.5, 1);
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
    }

    _applyRemote(remote, player) {
      const dir = player.dir || remote.lastDir || 'down';
      remote.lastDir = dir;
      remote.seated = player.anim === 'sit';
      remote.sprite.setPosition(player.x, player.y).setTexture(remote.texture);
      remote.nameTag?.setPosition(player.x, player.y - 40);
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
        if (def) this._placeWearable(object, def, x, y, dir);
        else object.setPosition(x, y - 68);
      }
      for (const slot of Object.values(entry.slotObjs || {})) {
        if (!slot?.obj) continue;
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
    }

    showChat(playerId, message) {
      const local = playerId === socket.id;
      const entry = local ? { sprite: this.player, local: true } : this.remotes[playerId];
      if (!entry?.sprite) return; // Never create a remote from chat payloads.
      if (local && this.localBubble) this.localBubble.destroy();
      if (!local && entry.chatBubble) entry.chatBubble.destroy();
      const bubble = this.add.text(entry.sprite.x, entry.sprite.y - 78, message, {
        fontSize: '14px', fontFamily: 'monospace', color: '#111', backgroundColor: '#ffffffee', padding: { x: 10, y: 7 }, wordWrap: { width: 220 }, resolution: 2,
      }).setOrigin(0.5, 1).setDepth(1002);
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
      if (!this.sitting) {
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
      this._positionPresentation({ cosmetic: this.localCosmetic, cosmeticDef: this.localCosmeticDef, wings: this.localWings, wingsDef: this.localWingsDef, slotObjs: this.localSlotObjs }, this.player.x, this.player.y, dir);
      if (this.localPet) this._stepPet(this.localPet, this.player.x, this.player.y, delta, this.sitting);
      for (const remote of Object.values(this.remotes)) {
        if (remote.pet) this._stepPet(remote.pet, remote.sprite.x, remote.sprite.y, delta, remote.seated);
        if (remote.chatBubble) remote.chatBubble.setPosition(remote.sprite.x, remote.sprite.y - 85);
      }
      if (this.localBubble) this.localBubble.setPosition(this.player.x, this.player.y - 78);

      let seat = null;
      if (this.location.startsWith('home:') && !this.sitting) {
        seat = this.furniture.find((item) => item.getData('isSeat') &&
          Phaser.Math.Distance.Between(this.player.x, this.player.y, item.x, item.y) <= 52);
      }
      const door = this.doors.find((item) => this.player.x >= item.x && this.player.x <= item.x + item.width &&
        this.player.y >= item.y && this.player.y <= item.y + item.height);
      if (door) this.interactHint.setText('[E] Exit').setPosition(this.player.x, this.player.y - 65).setVisible(true);
      else if (this.sitting) this.interactHint.setText('[E] Stand').setPosition(this.player.x, this.player.y - 65).setVisible(true);
      else if (seat) this.interactHint.setText('[E] Sit').setPosition(this.player.x, this.player.y - 65).setVisible(true);
      else this.interactHint.setVisible(false);
      if (Phaser.Input.Keyboard.JustDown(this.keyE)) {
        if (door) travel(door.destination);
        else if (this.sitting) {
          this.sitting = false;
          body.enable = true;
          this.player.setPosition(this.preSitX, this.preSitY);
          body.reset(this.preSitX, this.preSitY);
        } else if (seat) {
          this.sitting = true;
          this.preSitX = this.player.x; this.preSitY = this.player.y;
          this.sitX = seat.x; this.sitY = seat.y + 10;
          this.playerDir = seat.getData('seatDir') || 'down';
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
      this._clearGhost();
      this._clearLocalPresentation();
      Object.keys(this.remotes).forEach((id) => this._removeRemote(id));
      if (window._neighborhoodScene === this) window._neighborhoodScene = null;
    }
  }

  socket.on('locationTransitionResult', (result) => {
    if (!result?.ok) {
      if (result?.message) toast(result.message);
      return;
    }
    currentLocation = result.location;
    title.textContent = result.map?.label || result.location;
    furnitureCatalog = result.catalog || furnitureCatalog;
    if (isHome()) {
      homeState = result.home || homeState;
      editorOpen = false;
      socket.emit('homeDirectoryRequest');
      renderHome();
    } else {
      selectedInstance = null;
      homePanel.hidden = true;
    }
    renderShop();
    const game = window._phaserGame;
    if (!game) return;
    if (result.location === 'office') {
      game.scene.stop('NeighborhoodScene');
      game.scene.wake('OfficeScene');
      const office = game.scene.getScene('OfficeScene');
      if (office.player) {
        office.player.setPosition(result.self.x, result.self.y);
        office.player.body?.reset(result.self.x, result.self.y);
      }
    } else {
      game.scene.sleep('OfficeScene');
      game.scene.start('NeighborhoodScene', result);
    }
  });

  socket.on('currentPlayers', (players) => window._neighborhoodScene?.syncPlayers(players || {}));
  socket.on('playerJoined', (player) => window._neighborhoodScene?.addRemote(player?.id, player));
  socket.on('playerMoved', (player) => window._neighborhoodScene?.moveRemote(player));
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