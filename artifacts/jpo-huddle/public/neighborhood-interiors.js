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
        if (!scene.textures.exists(id)) {
          // Rebuilt venue art can keep its logical key; bypass yesterday's
          // browser-cached PNG when the application build changes.
          const separator = path.includes('?') ? '&' : '?';
          scene.load.image(id, path + separator + 'v=' + encodeURIComponent(window.__BUILD__ || 'current'));
        }
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
    // Batch only the static native floor/wall tiles at their source resolution.
    // Furniture stays independent for depth, seating and interaction. A room
    // needs one 320x240 cached surface, not ~370 active tile objects per frame.
    const surfaceKey = 'commercial-surface:' + locationId + ':' + (window.__BUILD__ || 'current');
    if (!scene.textures.exists(surfaceKey)) {
      const surface = scene.textures.createCanvas(surfaceKey, room.width / 3, room.height / 3);
      const ctx = surface.context;
      ctx.imageSmoothingEnabled = false;
      const floor = scene.textures.get(floorKey).getSourceImage();
      const wall = scene.textures.get('commercial-wall-native').getSourceImage();
      for (let y = 0; y < room.height / 3; y += 16) {
        for (let x = 0; x < room.width / 3; x += 16) ctx.drawImage(floor, x, y);
      }
      for (const rect of scene.info.geometry?.blockers || []) {
        if (rect.x !== 0 && rect.y !== 0 &&
            rect.x + rect.width !== room.width && rect.y + rect.height !== room.height) continue;
        for (let y = rect.y; y < rect.y + rect.height; y += 48) {
          for (let x = rect.x; x < rect.x + rect.width; x += 48) {
            const w = Math.min(48, rect.x + rect.width - x) / 3;
            const h = Math.min(48, rect.y + rect.height - y) / 3;
            ctx.drawImage(wall, 0, 0, w, h, x / 3, y / 3, w, h);
          }
        }
      }
      surface.refresh();
      surface.setFilter(Phaser.Textures.FilterMode.NEAREST);
    }
    // Interior floor/wall art is a backdrop. Furniture and actors share the
    // authored floor-contact y sort below; keeping the backdrop in a distinct
    // band prevents tall room surfaces from covering a character.
    scene.add.image(0, 0, surfaceKey).setOrigin(0, 0).setScale(3)
      .setDepth(-10000).setData('layerRole', 'interior-background');

    if (room.wall) {
      scene.textures.get(room.wall.asset).setFilter(Phaser.Textures.FilterMode.NEAREST);
      const wallTex = scene.textures.get(room.wall.asset).getSourceImage();
      const wallW = (wallTex?.width || 48) * 3;
      for (let wx = wallW / 2; wx < room.width; wx += wallW) {
        scene.add.image(wx, 48, room.wall.asset)
          .setOrigin(0.5, 1)
          .setScale(3)
          .setDepth(-9000)
          .setData('floorAnchor', 48)
          .setData('layerRole', 'interior-wall');
      }
    }

    if (room.objects) {
      room.objects.forEach(obj => {
        // Perimeter walls come from shared collision geometry, including the
        // four actual foyer openings. The source ticket-office composite is
        // not a single gallery door and must not overlap adjacent entrances.
        if (obj.asset.startsWith('floor_') || obj.asset === 'museum_door') return;
        if (!scene.textures.exists(obj.asset)) throw new Error('Missing interior sprite: ' + obj.asset);
        scene.textures.get(obj.asset).setFilter(Phaser.Textures.FilterMode.NEAREST);
        const depth = typeof obj.depth === 'number' ? obj.depth : obj.y;
        const img = scene.add.image(obj.x, obj.y, obj.asset)
          .setOrigin(0.5, obj.asset.startsWith('floor_') ? 0.5 : 1)
          .setScale(obj.scale || 1)
          .setDepth(depth)
          .setData('floorAnchor', depth)
          .setData('layerRole', depth < 0 ? 'interior-wall-prop' : 'interior-furniture');
        if (obj.flipX) img.setFlipX(true);
      });
    }

    for (const portal of scene.info.portals || []) {
      if (portal.y !== 0) continue;
      const doorKey = scene.textures.exists('pe_shop_door') ? 'pe_shop_door' : 'museum_door';
      scene.add.image(portal.x + portal.width / 2, portal.y + portal.height, doorKey)
        .setOrigin(0.5, 1).setScale(3).setDepth(portal.y + portal.height)
        .setData('floorAnchor', portal.y + portal.height)
        .setData('layerRole', 'interior-portal');
    }

    for (const label of room.labels || []) {
      scene.add.text(label.x, label.y, label.text, {
        fontFamily: 'monospace', fontSize: '11px', color: '#f5ebd5',
        backgroundColor: '#292d30dd', padding: { x: 5, y: 3 }, align: 'center',
      }).setOrigin(0.5, 0).setDepth(-1).setData('layerRole', 'exhibit-label');
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
