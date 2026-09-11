const fs = require('fs');
let content = fs.readFileSync('artifacts/jpo-huddle/public/neighborhood-interiors.js', 'utf8');

const restaurantCode = `
  drawRestaurantVignettes: function(scene, INTERIOR_ART_SCALE, locationId) {
    const art = scene.add.graphics().setDepth(2);
    
    if (locationId === 'cafe') {
      // The Daily Grind
      art.fillStyle(0x3e2723, 1).fillRect(200, 150, 560, 80).lineStyle(3, 0x1b0000, 1).strokeRect(200, 150, 560, 80);
      art.fillStyle(0x4e342e, 1).fillRect(200, 350, 100, 150).lineStyle(3, 0x1b0000, 1).strokeRect(200, 350, 100, 150);
      art.fillStyle(0x4e342e, 1).fillRect(660, 350, 100, 150).lineStyle(3, 0x1b0000, 1).strokeRect(660, 350, 100, 150);
      
      [250, 350, 450, 550].forEach(x => {
        scene.add.image(x, 250, scene._furnitureTextureKey('oak_chair')).setScale(INTERIOR_ART_SCALE).setOrigin(0.5, 1).setDepth(250);
      });

      if (scene._sign) scene._sign(480, 112, 'THE DAILY GRIND');
      
      scene.add.text(480, 180, 'MENU\\nEspresso - 40\\nLatte - 50\\nMatcha - 55\\nCroissant - 35', {
        fontFamily: 'monospace', fontSize: '14px', color: '#ffecb3', backgroundColor: '#212121aa', padding: { x: 8, y: 8 }, align: 'center'
      }).setOrigin(0.5, 0).setDepth(200);
      
      [250, 350, 500, 600].forEach(x => {
        art.fillStyle(0xffffff, 1).fillCircle(x, 190, 6);
        art.fillStyle(0x3e2723, 1).fillCircle(x, 190, 4);
      });
    } 
    else if (locationId === 'diner') {
      // Neon Diner
      art.lineStyle(2, 0x000000, 0.05);
      for (let x=0; x<960; x+=48) art.lineBetween(x, 0, x, 720);
      for (let y=0; y<720; y+=48) art.lineBetween(0, y, 960, y);

      art.fillStyle(0xb71c1c, 1).fillRect(100, 150, 760, 60).lineStyle(4, 0xe53935, 1).strokeRect(100, 150, 760, 60);
      
      const booths = [[100, 350], [660, 350], [100, 500], [660, 500]];
      booths.forEach(([x, y]) => {
        art.fillStyle(0xe0e0e0, 1).fillRoundedRect(x, y, 200, 100, 8).lineStyle(3, 0x9e9e9e, 1).strokeRoundedRect(x, y, 200, 100, 8);
        art.fillStyle(0xb71c1c, 1).fillRect(x, y-15, 200, 20).fillRect(x, y+95, 200, 20);
      });

      if (scene._sign) scene._sign(480, 112, 'NEON DINER');
      
      scene.add.text(480, 180, 'DINER MENU\\nClassic Burger - 80\\nVanilla Shake - 40\\nCherry Pie - 45', {
        fontFamily: 'monospace', fontSize: '14px', color: '#ffffff', backgroundColor: '#b71c1caa', padding: { x: 8, y: 8 }, align: 'center'
      }).setOrigin(0.5, 0).setDepth(200);
      
    }
    else if (locationId === 'bakery') {
      // Sweet Crust Bakery
      art.fillStyle(0xf57f17, 1).fillRect(250, 200, 460, 100).lineStyle(3, 0xe65100, 1).strokeRect(250, 200, 460, 100);
      art.fillStyle(0x81d4fa, 0.4).fillRect(260, 210, 200, 80).fillRect(490, 210, 200, 80);
      art.fillStyle(0xffb300, 1).fillRect(250, 400, 150, 60).fillRect(560, 400, 150, 60);
      
      if (scene._sign) scene._sign(480, 140, 'SWEET CRUST BAKERY');
      
      scene.add.text(480, 220, 'BAKES OF THE DAY\\nSourdough - 50\\nCroissant - 35\\nMacaron Box - 120', {
        fontFamily: 'monospace', fontSize: '13px', color: '#3e2723', backgroundColor: '#fff9c4aa', padding: { x: 8, y: 8 }, align: 'center'
      }).setOrigin(0.5, 0).setDepth(250);
      
      [280, 310, 340, 520, 560, 600, 640].forEach(x => {
        art.fillStyle(0xd7ccc8, 1).fillCircle(x, 250, 12);
        art.fillStyle(0xec407a, 1).fillCircle(x, 250, 8);
      });
    }
    else if (locationId === 'sushi') {
      // Sakura Sushi
      art.fillStyle(0x263238, 1).fillRect(200, 200, 560, 120).lineStyle(3, 0x111111, 1).strokeRect(200, 200, 560, 120);
      art.fillStyle(0x37474f, 1).fillRect(210, 210, 540, 40);
      
      for(let x = 230; x < 730; x += 60) {
        art.fillStyle(0xffffff, 1).fillCircle(x, 230, 14); 
        art.fillStyle(0xff5252, 1).fillRect(x-6, 225, 12, 10); 
        art.fillStyle(0x4caf50, 1).fillCircle(x+4, 225, 4); 
      }

      art.fillStyle(0x4e342e, 1).fillRect(200, 450, 120, 120).fillRect(640, 450, 120, 120);
      art.fillStyle(0xffcc80, 1).fillRoundedRect(210, 460, 100, 100, 4).fillRoundedRect(650, 460, 100, 100, 4);

      if (scene._sign) scene._sign(480, 140, 'SAKURA SUSHI');
      
      scene.add.text(480, 250, 'FRESH ROLLS\\nSalmon Nigiri - 60\\nDragon Roll - 110\\nEdamame - 30', {
        fontFamily: 'monospace', fontSize: '13px', color: '#eceff1', backgroundColor: '#263238aa', padding: { x: 8, y: 8 }, align: 'center'
      }).setOrigin(0.5, 0).setDepth(250);

      [250, 350, 480, 710].forEach(x => {
        scene.add.image(x, 350, scene._furnitureTextureKey('oak_chair')).setScale(INTERIOR_ART_SCALE).setOrigin(0.5, 1).setDepth(350);
      });
    }

    [[96, 350], [864, 350], [96, 640], [864, 640]].forEach(([x, y], index) => {
      const fern = scene.add.image(x, y, scene._furnitureTextureKey('fern'))
        .setOrigin(0.5, 1).setScale(INTERIOR_ART_SCALE).setDepth(y);
      if (scene._animateFurnitureObject) scene._animateFurnitureObject(fern, 'fern', index * 120);
    });
  }
`;

content = content.replace(
  /}\s*;\s*$/,
  `},\n${restaurantCode}\n};\n`
);

fs.writeFileSync('artifacts/jpo-huddle/public/neighborhood-interiors.js', content);
