window.JpoInteriors = {
  preload: function(scene) {
    for (const [key, path] of [
      ['commercial-floor-home', 'assets/neighborhood/home-floor-16.png'],
      ['commercial-floor-shop', 'assets/neighborhood/shop-floor-16.png'],
      ['commercial-wall-native', 'assets/neighborhood/shop-wall-16.png'],
    ]) if (!scene.textures.exists(key)) scene.load.image(key, path);
    const queueAssets = (data) => {
      if (!data?.assets || !data?.rooms) throw new Error('Commercial interior manifest is missing or invalid');
      for (const [id, path] of Object.entries(data.assets)) {
        if (!scene.textures.exists(id)) scene.load.image(id, path);
      }
    };
    const cached = scene.cache.json.get('commercial-layouts');
    if (cached) {
      queueAssets(cached);
    } else {
      scene.load.once('filecomplete-json-commercial-layouts', (_key, _type, data) => queueAssets(data));
      scene.load.json('commercial-layouts', 'commercial-layouts.json?v=' + encodeURIComponent(window.__BUILD__ || 'current'));
    }
  },

  draw: function(scene, locationId) {
    const data = scene.cache.json.get('commercial-layouts');
    if (!data?.rooms?.[locationId]) throw new Error('Missing commercial interior: ' + locationId);

    const room = data.rooms[locationId];
    const floorKey = ['furniture-shop', 'decor-shop', 'cafe', 'bakery', 'sushi'].includes(locationId)
      ? 'commercial-floor-home' : 'commercial-floor-shop';
    scene.textures.get(floorKey).setFilter(Phaser.Textures.FilterMode.NEAREST);
    for (let y = 0; y < room.height; y += 48) {
      for (let x = 0; x < room.width; x += 48) {
        scene.add.image(x, y, floorKey).setOrigin(0, 0).setScale(3).setDepth(-10);
      }
    }
    if (room.objects) {
      room.objects.forEach(obj => {
        // Perimeter walls come from shared collision geometry, including the
        // four actual foyer openings. The source ticket-office composite is
        // not a single gallery door and must not overlap adjacent entrances.
        if (obj.asset.startsWith('floor_') || obj.asset.startsWith('wall_') || obj.asset === 'museum_door') return;
        if (!scene.textures.exists(obj.asset)) throw new Error('Missing interior sprite: ' + obj.asset);
        scene.textures.get(obj.asset).setFilter(Phaser.Textures.FilterMode.NEAREST);
        const depth = typeof obj.depth === 'number' ? obj.depth : obj.y;
        scene.add.image(obj.x, obj.y, obj.asset)
          .setOrigin(0.5, obj.asset.startsWith('floor_') ? 0.5 : 1)
          .setScale(obj.scale || 1)
          .setDepth(depth);
      });
    }

    // Ordinary native tile images avoid TileSprite render-texture allocation
    // on every room restart and preserve exact authored door openings.
    const wallKey = 'commercial-wall-native';
    scene.textures.get(wallKey).setFilter(Phaser.Textures.FilterMode.NEAREST);
    for (const rect of scene.info.geometry?.blockers || []) {
      if (rect.x !== 0 && rect.y !== 0 &&
          rect.x + rect.width !== room.width && rect.y + rect.height !== room.height) continue;
      for (let y = rect.y; y < rect.y + rect.height; y += 48) {
        for (let x = rect.x; x < rect.x + rect.width; x += 48) {
          scene.add.image(x, y, wallKey).setOrigin(0, 0).setScale(3)
            .setCrop(0, 0, Math.min(48, rect.x + rect.width - x) / 3,
              Math.min(48, rect.y + rect.height - y) / 3).setDepth(0);
        }
      }
    }
    for (const portal of scene.info.portals || []) {
      if (portal.y !== 0) continue;
      scene.add.image(portal.x + portal.width / 2, portal.y + portal.height, 'pe_shop_door')
        .setOrigin(0.5, 1).setScale(3).setDepth(1);
    }

    if (room.label && scene._sign) {
      scene.add.text(480, locationId === 'museum' ? 614 : 48, room.label.toUpperCase(), {
        fontFamily: 'monospace', fontSize: '14px', color: '#ffffff',
        backgroundColor: '#000000aa', padding: { x: 8, y: 4 }, align: 'center'
      }).setOrigin(0.5, 0).setDepth(2000);
    }
  },

  // Legacy wrappers for backward compatibility with existing scenes
  drawShopVignettes: function(scene, INTERIOR_ART_SCALE, theme, catalog) {
    this.draw(scene, theme.id);
  },

  drawRestaurantVignettes: function(scene, INTERIOR_ART_SCALE, locationId) {
    this.draw(scene, locationId);
  }
};
