window.JpoPlazaExteriors = {
  preload(scene) {
    const load = (key, path) => scene.load.image(key, path);
    load('pe_shop_window', 'assets/neighborhood/facades/shop_window.png');
    load('pe_shop_door', 'assets/neighborhood/facades/shop_door.png');
    load('pe_shop_awning', 'assets/neighborhood/facades/shop_awning.png');
    load('pe_jp_door', 'assets/neighborhood/facades/jp_door.png');
    load('pe_jp_roof', 'assets/neighborhood/facades/jp_roof.png');
    load('pe_neon_sign', 'assets/neighborhood/facades/neon_sign.png');
    load('pe_diner_window', 'assets/neighborhood/facades/diner_window.png');
    load('pe_house_window', 'assets/neighborhood/facades/house_window.png');
    load('pe_museum_column', 'assets/neighborhood/facades/museum_column.png');
    load('pe_museum_door', 'assets/neighborhood/facades/museum_door.png');
    load('pe_museum_pediment', 'assets/neighborhood/facades/museum_pediment.png');
  },

  draw(scene, { id, x, y, width, height, doorX, doorY }) {
    const depth = doorY;
    const scale = 3;

    const g = scene.add.graphics();
    g.setDepth(depth - 0.1);

    let mainColor = 0xffffff;
    let trimColor = 0xdddddd;
    let roofColor = 0x444444;

    switch (id) {
      case 'furniture-shop': mainColor = 0xe4b67b; trimColor = 0xa47b4d; roofColor = 0x3d352b; break;
      case 'garden-shop': mainColor = 0x8eb977; trimColor = 0x5a8346; roofColor = 0x2b3d2b; break;
      case 'decor-shop': mainColor = 0x937bb1; trimColor = 0x614f77; roofColor = 0x272033; break;
      case 'cafe': mainColor = 0xc27a69; trimColor = 0x8a4b3d; roofColor = 0x3b231c; break;
      case 'diner': mainColor = 0x7da4c6; trimColor = 0x486b8c; roofColor = 0x263342; break;
      case 'bakery': mainColor = 0xdbcc8c; trimColor = 0xa5975b; roofColor = 0x443a1c; break;
      case 'sushi': mainColor = 0xc95858; trimColor = 0x822a2a; roofColor = 0x301818; break;
      case 'museum': mainColor = 0xe6e3d8; trimColor = 0xbab6a7; roofColor = 0x757268; break;
    }

    if (id !== 'museum') {
      if (!scene.textures.exists('pe_facade_base')) {
        const canvas = scene.textures.createCanvas('pe_facade_base', 16, 16);
        const ctx = canvas.context;
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, 16, 16);
        ctx.fillStyle = 'rgba(0, 0, 0, 0.08)';
        ctx.fillRect(0, 7, 16, 1);
        ctx.fillRect(0, 15, 16, 1);
        ctx.fillRect(7, 0, 1, 7);
        ctx.fillRect(15, 8, 1, 7);
        canvas.refresh();
        scene.textures.get('pe_facade_base').setFilter(Phaser.Textures.FilterMode.NEAREST);
      }

      const tileScale = 3;
      scene.add.tileSprite(x, y, width / tileScale, height / tileScale, 'pe_facade_base')
        .setOrigin(0, 0)
        .setScale(tileScale)
        .setTint(mainColor)
        .setDepth(depth - 0.3);

      g.fillStyle(trimColor);
      g.fillRect(x, y + height - 8, width, 8);
      g.fillRect(x - 4, y, width + 8, 16);

      g.fillStyle(roofColor);
      if (id === 'garden-shop') {
        g.fillTriangle(x - 8, y + 30, x + width / 2, y - 54, x + width + 8, y + 30);
        g.fillStyle(0xb8ded4);
        g.fillTriangle(x + 12, y + 18, x + width / 2, y - 36, x + width - 12, y + 18);
        g.lineStyle(6, trimColor);
        g.lineBetween(x + width / 2, y - 36, x + width / 2, y + 30);
      } else if (id === 'diner') {
        g.fillStyle(0xd6e4e8);
        g.fillRoundedRect(x - 12, y - 18, width + 24, 48, 18);
        g.fillStyle(0xba394b);
        g.fillRect(x - 8, y + 15, width + 16, 9);
        g.fillStyle(0x7e969e);
        g.fillRect(x + 16, y - 10, width - 32, 6);
      } else if (id === 'bakery') {
        g.fillTriangle(x - 12, y + 21, x + width / 2, y - 60, x + width + 12, y + 21);
        g.fillStyle(0xb87950);
        for (let row = 0; row < 4; row++) {
          const inset = row * 24;
          g.fillRect(x + inset, y + 9 - row * 18, width - inset * 2, 6);
        }
        g.fillStyle(0x724331);
        g.fillRect(x + width - 42, y - 63, 24, 54);
      } else if (id === 'sushi') {
        g.beginPath();
        g.moveTo(x - 18, y + 24);
        g.lineTo(x + 18, y + 3);
        g.lineTo(x + 54, y - 36);
        g.lineTo(x + width - 54, y - 36);
        g.lineTo(x + width - 18, y + 3);
        g.lineTo(x + width + 18, y + 24);
        g.closePath(); g.fillPath();
        g.fillStyle(0x976455);
        g.fillRect(x - 18, y + 18, width + 36, 6);
      } else if (id === 'furniture-shop') {
        g.fillRect(x - 8, y - 18, width + 16, 18);
        g.fillStyle(0xc0b7a5);
        g.fillRect(x + 16, y - 42, width - 32, 24);
        g.fillStyle(roofColor);
        g.fillRect(x + 12, y - 48, width - 24, 9);
      } else if (id === 'decor-shop') {
        g.fillRect(x - 12, y - 24, width + 24, 12);
        g.fillStyle(0xdbcee7);
        g.fillRect(x - 6, y - 12, width + 12, 12);
        g.fillRect(x + 18, y - 39, 24, 15);
        g.fillRect(x + width - 42, y - 39, 24, 15);
        g.fillRect(x + width / 2 - 27, y - 48, 54, 24);
      } else {
        g.fillRect(x - 8, y - 24, width + 16, 24);
      }
    }

    const addProp = (key, px, py, originX = 0.5, originY = 1, zOffset = 0, customScale = scale) => {
      return scene.add.image(px, py, key)
        .setOrigin(originX, originY)
        .setScale(customScale)
        .setDepth(depth + zOffset);
    };

    const cx = x + width / 2;

    if (id === 'furniture-shop') {
      g.fillStyle(0x769b9e, 0.8);
      g.fillRect(x + 16, y + 48, width / 2 - 64, height - 64);
      g.fillRect(x + width / 2 + 48, y + 48, width / 2 - 64, height - 64);
      g.lineStyle(4, 0x4a5d5f);
      g.strokeRect(x + 16, y + 48, width / 2 - 64, height - 64);
      g.strokeRect(x + width / 2 + 48, y + 48, width / 2 - 64, height - 64);
      addProp('pe_shop_door', doorX, doorY);
    }
    else if (id === 'garden-shop') {
      g.fillStyle(0xa1c4c8, 0.6);
      g.fillRect(x + 16, y + 32, width - 32, height - 48);
      g.lineStyle(4, 0x5a8346, 1);
      g.strokeRect(x + 16, y + 32, width - 32, height - 48);
      for (let i = 1; i < 4; i++) {
        g.beginPath();
        g.moveTo(x + 16 + (width - 32) * (i/4), y + 32);
        g.lineTo(x + 16 + (width - 32) * (i/4), y + height - 16);
        g.strokePath();
      }
      for (let i = 1; i < 3; i++) {
        g.beginPath();
        g.moveTo(x + 16, y + 32 + (height - 48) * (i/3));
        g.lineTo(x + width - 16, y + 32 + (height - 48) * (i/3));
        g.strokePath();
      }
      addProp('pe_shop_door', doorX, doorY);
      addProp('pe_shop_awning', doorX, doorY - 72, 0.5, 1, 1);
    }
    else if (id === 'decor-shop') {
      addProp('pe_house_window', x + width * 0.25, doorY - 32);
      addProp('pe_house_window', x + width * 0.75, doorY - 32);
      addProp('pe_shop_door', doorX, doorY);
      addProp('pe_shop_awning', x + width * 0.25, doorY - 80, 0.5, 1, 1, 1.5);
      addProp('pe_shop_awning', x + width * 0.75, doorY - 80, 0.5, 1, 1, 1.5);
    }
    else if (id === 'cafe') {
      addProp('pe_shop_window', x + width * 0.25, doorY - 24);
      addProp('pe_shop_window', x + width * 0.75, doorY - 24);
      addProp('pe_shop_door', doorX, doorY);
      addProp('pe_shop_awning', cx, doorY - 72, 0.5, 1, 100, 3.5);

      const t = scene.add.graphics();
      t.setDepth(2);
      t.fillStyle(0xa39d91);
      t.fillRect(x, doorY, width, 48);

      const drawTable = (tx, ty) => {
        t.fillStyle(0xdddddd);
        t.fillRect(tx - 12, ty - 16, 24, 4);
        t.fillStyle(0x666666);
        t.fillRect(tx - 2, ty - 12, 4, 16);
        t.fillRect(tx - 8, ty, 16, 4);
      };
      drawTable(x + 48, doorY + 24);
      drawTable(x + width - 48, doorY + 24);
    }
    else if (id === 'diner') {
      addProp('pe_diner_window', x + width * 0.25, doorY - 16, 0.5, 1, 0, 3);
      addProp('pe_diner_window', x + width * 0.75, doorY - 16, 0.5, 1, 0, 3);
      addProp('pe_neon_sign', cx, y + 48, 0.5, 1, 2, 2.5);
      addProp('pe_shop_door', doorX, doorY);
    }
    else if (id === 'bakery') {
      addProp('pe_shop_window', x + width * 0.25, doorY - 24);
      addProp('pe_shop_window', x + width * 0.75, doorY - 24);
      addProp('pe_shop_door', doorX, doorY);
      addProp('pe_shop_awning', x + width * 0.25, doorY - 72, 0.5, 1, 1, 2);
      addProp('pe_shop_awning', x + width * 0.75, doorY - 72, 0.5, 1, 1, 2);
    }
    else if (id === 'sushi') {
      addProp('pe_jp_door', doorX, doorY);
      for(let rx = x + 48; rx < x + width; rx += 96) {
        addProp('pe_jp_roof', rx, y + 24, 0.5, 1, 1, 2);
      }
      addProp('pe_house_window', x + width * 0.2, doorY - 32);
      addProp('pe_house_window', x + width * 0.8, doorY - 32);
    }
    else if (id === 'museum') {
      const colScale = 2.5;
      const pedimentY = doorY - (128 * colScale);
      const bodyHeight = doorY - pedimentY;

      if (!scene.textures.exists('pe_facade_base')) {
        const canvas = scene.textures.createCanvas('pe_facade_base', 16, 16);
        const ctx = canvas.context;
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, 16, 16);
        ctx.fillStyle = 'rgba(0, 0, 0, 0.08)';
        ctx.fillRect(0, 7, 16, 1);
        ctx.fillRect(0, 15, 16, 1);
        ctx.fillRect(7, 0, 1, 7);
        ctx.fillRect(15, 8, 1, 7);
        canvas.refresh();
        scene.textures.get('pe_facade_base').setFilter(Phaser.Textures.FilterMode.NEAREST);
      }
      scene.add.tileSprite(x, pedimentY, width / 3, bodyHeight / 3, 'pe_facade_base')
        .setOrigin(0, 0)
        .setScale(3)
        .setTint(0xcbc7b9)
        .setDepth(depth - 0.3);

      addProp('pe_museum_pediment', cx, pedimentY + 4, 0.5, 1, 1, colScale);

      [x + 64, cx - 72, cx + 72, x + width - 64].forEach(cxPos => {
        addProp('pe_museum_column', cxPos, doorY, 0.5, 1, 0.5, colScale);
      });

      addProp('pe_museum_door', cx, doorY, 0.5, 1, 0, colScale);
    }
  }
};
