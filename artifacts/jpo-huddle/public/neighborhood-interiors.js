window.JpoInteriors = {
  drawShopVignettes: function(scene, INTERIOR_ART_SCALE, theme, catalog) {
    const art = scene.add.graphics().setDepth(2);
    
    // Authored interior base
    art.fillStyle(0x80583f, 1).fillRect(144, 154, 672, 74).lineStyle(3, 0x533826, 1).strokeRect(144, 154, 672, 74);
    [140, 662].forEach((x) => art.fillStyle(0x9c7357, 1).fillRect(x, 378, 156, 80).lineStyle(2, 0x624431, 1).strokeRect(x, 378, 156, 80));
    art.fillStyle(theme.accent, 0.82).fillRoundedRect(344, 324, 272, 150, 16).lineStyle(3, 0xf0d8ab, 0.8).strokeRoundedRect(344, 324, 272, 150, 16);
    
    // Clear display vignettes (instead of small plinths)
    const displays = [[240, 450], [380, 450], [520, 450], [660, 450]];
    
    theme.display.forEach((id, index) => {
      const pos = displays[index];
      if (!pos) return;
      const x = pos[0];
      const y = pos[1];
      
      // Draw a display rug for the item vignette
      art.fillStyle(0xffffff, 0.15).fillRoundedRect(x - 48, y - 48, 96, 72, 8);
      art.lineStyle(2, 0xffffff, 0.3).strokeRoundedRect(x - 48, y - 48, 96, 72, 8);

      const item = scene.add.image(x, y, scene._furnitureTextureKey(id))
        .setOrigin(0.5, 1).setScale(INTERIOR_ART_SCALE).setDepth(y);
      scene._animateFurnitureObject(item, id, index * 90);
      
      // Look up price in catalog
      const catItem = catalog[id];
      const name = catItem ? catItem.name : id;
      const price = catItem ? catItem.price + ' coins' : 'For Sale';
      
      scene.add.text(x, y + 10, name.toUpperCase(), {
        fontFamily: 'monospace', fontSize: '10px', color: '#ffffff',
        backgroundColor: '#000000aa', padding: { x: 4, y: 2 }
      }).setOrigin(0.5, 0).setDepth(y + 10);
      
      scene.add.text(x, y + 26, price, {
        fontFamily: 'monospace', fontSize: '9px', color: '#ffd700',
        backgroundColor: '#000000aa', padding: { x: 4, y: 2 }
      }).setOrigin(0.5, 0).setDepth(y + 11);
    });
    
    [[96, 350], [864, 350], [96, 640], [864, 640]].forEach(([x, y], index) => {
      const fern = scene.add.image(x, y, scene._furnitureTextureKey('fern'))
        .setOrigin(0.5, 1).setScale(INTERIOR_ART_SCALE).setDepth(y);
      scene._animateFurnitureObject(fern, 'fern', index * 120);
    });
    
    scene._sign(480, 112, theme.title);
    scene.add.text(480, 190, theme.intro + ' · click Buy in panel to purchase · items go to your home inventory.', {
      fontFamily: 'monospace', fontSize: '12px', color: '#fff7db', backgroundColor: '#493c36cc', padding: { x: 6, y: 4 }, align: 'center',
    }).setOrigin(0.5).setDepth(18);
  }
};
