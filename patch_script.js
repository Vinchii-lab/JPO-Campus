const fs = require('fs');
let code = fs.readFileSync('artifacts/jpo-huddle/public/neighborhood.js', 'utf8');

code = code.replace(/class NeighborhoodScene extends Phaser\.Scene \{[\s\S]*\}\s+socket\.on\('locationTransitionResult'/m, `class NeighborhoodScene extends Phaser.Scene {
    constructor() { super('NeighborhoodScene'); this.remotes = {}; }
    
    preload() {
      ['oak_chair', 'fern', 'reading_lamp', 'coffee_table', 'blue_sofa', 'bookcase'].forEach(id => {
        this.load.image('furn_' + id, '/assets/neighborhood/furniture/' + id + '.png');
      });
      this.load.image('home_shell_floor', '/assets/neighborhood/Japanese_Home_1_Layer_1_48x48.png');
      this.load.image('home_shell_wall', '/assets/neighborhood/Japanese_Home_1_Layer_2_48x48.png');
      
      // Fix missing shop textures
      this.load.image('neighborhood_shop_floor', '/assets/neighborhood/Ice_Cream_Shop_Design_layer_1_48x48.png');
      this.load.image('neighborhood_shop_decor', '/assets/neighborhood/Ice_Cream_Shop_Design_layer_2_48x48.png');
    }
    
    create(data) {
      window._neighborhoodScene = this; 
      this.info = data?.map || {}; 
      this.location = data?.location || currentLocation;
      const width = this.info.width || 1152;
      const height = this.info.height || 816;
      this.physics.world.setBounds(0, 0, width, height);
      this.cameras.main.setBounds(0, 0, width, height).setZoom(1);
      
      const g = this.add.graphics();
      const isHome = this.location.startsWith('home:');
      const globals = getGlobals();
      const office = window._gameScene;
      
      g.fillStyle(isHome ? 0x222222 : 0x4a6b52, 1).fillRect(0, 0, width, height);
      
      if (isHome) {
        this.add.image(width/2, height/2, 'home_shell_floor').setDisplaySize(width, height).setDepth(1);
        this.add.image(width/2, height/2, 'home_shell_wall').setDisplaySize(width, height).setDepth(15); 
        for(let x=0; x<=width; x+=48) g.lineStyle(1, 0x000000, 0.2).lineBetween(x, 0, x, height);
        for(let y=0; y<=height; y+=48) g.lineStyle(1, 0x000000, 0.2).lineBetween(0, y, width, y);
      } else if (this.location === 'furniture-shop') {
        this.add.image(width/2, height/2, 'neighborhood_shop_floor').setDisplaySize(width, height).setDepth(1);
        this.add.image(width/2, height/2, 'neighborhood_shop_decor').setDisplaySize(width, height).setDepth(15);
      } else {
        g.fillStyle(0x8a9e88, 1).fillRect(width*0.35, 0, width*0.3, height); 
        g.fillStyle(0x3e5e46, 1).fillCircle(width/2, height/2, 150);
        
        // Draw pixel art exterior rooftops instead of interior floorplans
        const drawBldg = (x, y, w, h, c, rc, lbl) => {
           g.fillStyle(c, 1).fillRect(x-w/2, y-h/2, w, h);
           g.lineStyle(2, 0x111, 0.4).strokeRect(x-w/2, y-h/2, w, h);
           g.fillStyle(rc, 1).fillRect(x-w/2-10, y-h/2-20, w+20, h/2);
           g.lineStyle(2, 0x111, 0.5).strokeRect(x-w/2-10, y-h/2-20, w+20, h/2);
           g.fillStyle(0x87CEEB, 1).fillRect(x-20, y, 40, 20); // Window
           this.add.text(x, y-h/2+10, lbl, { fontFamily:'monospace', fontSize:'14px', color:'#fff', backgroundColor:'#172534dd', padding:{x:8,y:4}, borderRadius:4 }).setOrigin(0.5).setDepth(6);
        };
        drawBldg(220, 220, 160, 140, 0xb89f81, 0x6e4e3b, 'Homes');
        drawBldg(width-220, 220, 160, 140, 0x6e90a6, 0x3d5363, 'City');
        drawBldg(220, height-220, 160, 140, 0xb89f81, 0x6e4e3b, 'Homes');
        drawBldg(width-220, height-220, 160, 140, 0xc4625b, 0x63312e, 'Shop');
        this.add.text(width/2, 90, 'JPO HQ', { fontFamily: 'monospace', fontSize: '15px', color: '#fff', backgroundColor: '#172534dd', padding: { x: 8, y: 5 }, borderRadius: 4 }).setOrigin(0.5).setDepth(6);
      }
      
      const label = isHome ? 'Starter Home · Click grid to place items' : (this.location === 'furniture-shop' ? 'Huddle Home Shop' : 'Huddle Plaza');
      this.add.text(20, 20, label, { fontFamily: 'monospace', fontSize: '16px', color: '#fff', backgroundColor: '#172534cc', padding: { x: 8, y: 6 } }).setScrollFactor(0).setDepth(50);
      
      const startDir = globals.DIR_START[data.self.dir] || 0;
      const char = globals._playerChar || 'adam';
      const bakedIds = globals._bakedWearIds ? globals._bakedWearIds(char, globals._equippedCosmetic, globals._equippedWings, globals._equippedSlots) : [];
      const texKey = office ? office._buildPlayerTex.call(office, char, globals._playerHairIdx||0, globals._playerSkinIdx||0, globals._playerShirtIdx||0, globals._playerPantsIdx||0, bakedIds) : ('run_' + char);
      
      this.playerTexKey = texKey;
      this.player = this.add.sprite(data.self.x, data.self.y, texKey, startDir).setScale(3).setDepth(10);
      this.physics.add.existing(this.player);
      this.player.body.setCollideWorldBounds(true);
      this.player.body.setSize(12, 10).setOffset(2, 20); // enforce tight collision matching office
      
      this.tag = office && office._makeNameTag ? office._makeNameTag.call(this, data.self.x, data.self.y, globals._playerName || 'You') : 
         this.add.text(this.player.x, this.player.y - 45, globals._playerName || 'You', { fontFamily: 'monospace', fontSize: '11px', color: '#fff', backgroundColor: '#172534cc', padding: { x: 4, y: 2 } }).setOrigin(0.5);
      this.tag.setDepth(12);
      
      if (office && office._makeCosmetic) {
         if (globals._equippedCosmetic) {
            const m = office._makeCosmetic.call(this, globals._equippedCosmetic, data.self.x, data.self.y, data.self.dir||'down', this.player, char);
            if (m) { this.localCosmetic = m.obj; this.localCosmeticDef = m.def; }
         }
         if (globals._equippedWings) {
            const m = office._makeCosmetic.call(this, globals._equippedWings, data.self.x, data.self.y, data.self.dir||'down', this.player);
            if (m) { this.localWings = m.obj; this.localWingsDef = m.def; }
         }
      }
      if (office && office._makePet && globals._equippedPet) {
         this.localPet = office._makePet.call(this, globals._equippedPet, data.self.x, data.self.y, globals._equippedPetAcc, globals._myPetStage?globals._myPetStage(globals._equippedPet):1, globals.socket?.id || 'local');
      }
      
      this.keys = this.input.keyboard.createCursorKeys();
      this.last = 0;
      
      this.ghostObj = null;
      this.input.on('pointermove', (pointer) => {
        if (!homeState?.canEdit || !selectedInstance || !isHome) {
          if (this.ghostObj) { this.ghostObj.destroy(); this.ghostObj = null; }
          return;
        }
        const item = homeState.inventory.find(i => i.id === selectedInstance);
        if (!item) return;
        const def = furnitureCatalog[item.furnitureId];
        if (!def) return;
        
        const isRotated = selectedRotation % 180 === 90;
        const bw = (isRotated ? (def.height||1) : (def.width||1)) * 48;
        const bh = (isRotated ? (def.width||1) : (def.height||1)) * 48;
        const iw = (def.width||1) * 48;
        const ih = (def.height||1) * 48;
        
        const gx = Math.floor(pointer.worldX / 48);
        const gy = Math.floor(pointer.worldY / 48);
        
        if (!this.ghostObj) {
           this.ghostObj = this.add.image(0, 0, 'furn_' + def.id).setAlpha(0.6).setDepth(20);
        } else {
           if (this.ghostObj.texture.key !== 'furn_' + def.id) {
             this.ghostObj.setTexture('furn_' + def.id);
           }
        }
        this.ghostObj.setDisplaySize(iw, ih);
        this.ghostObj.setAngle(selectedRotation);
        this.ghostObj.setPosition(gx * 48 + bw/2, gy * 48 + bh/2);
        
        let blocked = false;
        if (gx < 0 || gy < 0 || gx * 48 + bw > width || gy * 48 + bh > height) blocked = true;
        if (gy * 48 + bh > height - 48 && gx <= 6 && gx * 48 + bw > 5 * 48) blocked = true;
        for (const placed of homeState.layout || []) {
           if (placed.id === selectedInstance) continue;
           const pdef = furnitureCatalog[placed.furnitureId];
           if (!pdef) continue;
           const pw = (placed.rotation%180 === 90 ? (pdef.height||1) : (pdef.width||1));
           const ph = (placed.rotation%180 === 90 ? (pdef.width||1) : (pdef.height||1));
           const sw = (selectedRotation%180 === 90 ? (def.height||1) : (def.width||1));
           const sh = (selectedRotation%180 === 90 ? (def.width||1) : (def.height||1));
           
           if (gx < placed.gridX + pw && gx + sw > placed.gridX &&
               gy < placed.gridY + ph && gy + sh > placed.gridY) {
               blocked = true;
               break;
           }
        }
        
        if (blocked) this.ghostObj.setTint(0xff0000);
        else this.ghostObj.clearTint();
      });

      this.input.on('pointerdown', (pointer) => {
        if (!homeState?.canEdit || !selectedInstance || !isHome) return;
        const gx = Math.floor(pointer.worldX / 48);
        const gy = Math.floor(pointer.worldY / 48);
        if (this.ghostObj && this.ghostObj.isTinted) {
          getGlobals().showToast("Cannot place there.");
          return;
        }
        socket.emit('homeLayoutSet', { instanceId: selectedInstance, gridX: gx, gridY: gy, rotation: selectedRotation });
        selectedInstance = null;
        if (this.ghostObj) { this.ghostObj.destroy(); this.ghostObj = null; }
        renderHome();
      });
      
      this.renderFurniture(homeState);
      this.syncPlayers(data.players || {});
      
      this.keyE = this.input.keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.E);
      this.interactHint = this.add.text(0, 0, '[E] Exit', { fontFamily: 'monospace', fontSize: '11px', color: '#000', backgroundColor: '#fff', padding: { x: 3, y: 2 }, borderRadius: 2 }).setOrigin(0.5).setDepth(15).setVisible(false);
      this.sitting = false;
    }
    
    renderFurniture(state) {
      if (!this.scene.isActive() || !this.location.startsWith('home:')) return;
      this.furniture?.forEach(x => x.destroy());
      this.furniture = [];
      for (const item of state?.layout || []) {
        const def = furnitureCatalog[item.furnitureId] || {};
        const isRotated = item.rotation % 180 === 90;
        
        const bw = (isRotated ? (def.height||1) : (def.width||1)) * 48;
        const bh = (isRotated ? (def.width||1) : (def.height||1)) * 48;
        const iw = (def.width||1) * 48;
        const ih = (def.height||1) * 48;
        
        const spr = this.add.image(item.gridX * 48 + bw/2, item.gridY * 48 + bh/2, 'furn_' + def.id)
            .setDisplaySize(iw, ih)
            .setAngle(item.rotation)
            .setDepth(5 + item.gridY); 
            
        if (def.id.includes('chair') || def.id.includes('sofa')) {
           spr.setData('isSeat', true);
           const dirs = ['down', 'left', 'up', 'right'];
           const d = dirs[(item.rotation / 90) % 4];
           spr.setData('seatDir', d);
        }
        this.furniture.push(spr);
      }
    }
    
    syncPlayers(all) {
      if (!this.scene.isActive()) return;
      Object.entries(all).forEach(([id, p]) => { if (id !== socket.id) this.addRemote(id, p); });
      Object.keys(this.remotes).forEach(id => {
        if (!all[id]) { 
           const r = this.remotes[id];
           if (r.sprite) r.sprite.destroy();
           if (r.nameTag) r.nameTag.destroy();
           if (r.cosmetic) r.cosmetic.destroy();
           if (r.wings) r.wings.destroy();
           if (r.pet) window._gameScene?._destroyPet?.call(this, r.pet);
           delete this.remotes[id]; 
        }
      });
    }
    
    addRemote(id, p) {
      const office = window._gameScene;
      const globals = getGlobals();
      const char = p.character || 'adam';
      const startDir = globals.DIR_START[p.dir] || 0;
      
      const bakedIds = globals._bakedWearIds ? globals._bakedWearIds(char, p.wear?.equipped, p.wear?.wings, p.wear?.slots) : [];
      const texKey = office ? office._buildPlayerTex.call(office, char, p.appear?.hairIdx||0, p.appear?.skinIdx||0, p.appear?.shirtIdx||0, p.appear?.pantsIdx||0, bakedIds) : ('run_'+char);
      
      let r = this.remotes[id];
      if (!r) {
        r = {};
        r.sprite = this.add.sprite(p.x, p.y, texKey, startDir).setScale(3).setDepth(10);
        r.nameTag = office && office._makeNameTag ? office._makeNameTag.call(this, p.x, p.y, p.name || 'Coworker', p.roleInfo) : 
            this.add.text(p.x, p.y - 45, p.name || 'Coworker', { fontFamily: 'monospace', fontSize: '11px', color: '#fff', backgroundColor: '#172534cc', padding: { x: 4, y: 2 } }).setOrigin(0.5);
        if (r.nameTag.setDepth) r.nameTag.setDepth(12);
        
        if (office && office._makeCosmetic) {
          if (p.wear?.equipped) {
             const m = office._makeCosmetic.call(this, p.wear.equipped, p.x, p.y, p.dir||'down', r.sprite, char);
             if (m) { r.cosmetic = m.obj; r.cosmeticDef = m.def; }
          }
          if (p.wear?.wings) {
             const m = office._makeCosmetic.call(this, p.wear.wings, p.x, p.y, p.dir||'down', r.sprite);
             if (m) { r.wings = m.obj; r.wingsDef = m.def; }
          }
        }
        if (office && office._makePet && p.pet) {
           r.pet = office._makePet.call(this, p.pet, p.x, p.y, p.petAcc, p.petStage || 1, id);
        }
        this.remotes[id] = r;
      }
      
      r.sprite.setPosition(p.x, p.y);
      if (r.nameTag && r.nameTag.setPosition) r.nameTag.setPosition(p.x, p.y - 45);
      
      const isSit = p.anim === 'sit';
      if (isSit) {
         r.sprite.setTexture(texKey);
         r.sprite.setFrame(globals.DIR_START[p.dir] || 0); // Simplified seated mapping fallback
      } else {
         r.sprite.setFlipX(false);
         if (r.sprite.anims) r.sprite.anims.stop();
         r.sprite.setTexture(texKey);
         r.sprite.setFrame(startDir);
      }
      
      if (office && office._placeWearable) {
         if (r.cosmetic) {
             if (r.cosmeticDef) office._placeWearable.call(this, r.cosmetic, r.cosmeticDef, p.x, p.y, p.dir||'down');
             else r.cosmetic.setPosition(p.x, p.y - 68);
         }
         if (r.wings && r.wingsDef) office._placeWearable.call(this, r.wings, r.wingsDef, p.x, p.y, p.dir||'down');
      }
      if (office && office._stepPet && r.pet) {
         office._stepPet.call(this, r.pet, p.x, p.y, p.dir||'down', isSit, false);
      }
    }
    
    update(_time, delta) {
      const globals = getGlobals();
      const office = window._gameScene;
      const s = 170;
      const b = this.player.body;
      
      let intentDir = null;
      if (!this.sitting) {
        if (this.keys.left.isDown) intentDir = 'left';
        else if (this.keys.right.isDown) intentDir = 'right';
        else if (this.keys.up.isDown) intentDir = 'up';
        else if (this.keys.down.isDown) intentDir = 'down';
      }
      
      b.setVelocity(0);
      let dir = this.playerDir || 'down';
      let anim = 'idle';

      if (intentDir) {
        dir = intentDir;
        anim = 'walk';
        if (dir === 'left') b.setVelocityX(-s);
        else if (dir === 'right') b.setVelocityX(s);
        else if (dir === 'up') b.setVelocityY(-s);
        else if (dir === 'down') b.setVelocityY(s);
      }
      
      this.playerDir = dir;
      
      if (this.sitting) {
         anim = 'sit';
         this.player.setTexture(this.playerTexKey);
         this.player.setFrame(globals.DIR_START[dir] || 0);
         this.player.setY(this.sitY);
         this.player.setX(this.sitX);
      } else {
         this.player.setTexture(this.playerTexKey);
         if (anim === 'walk') {
            const wk = \`walk_\${this.playerTexKey}_\${dir}\`;
            if (this.player.anims.currentAnim?.key !== wk && this.anims.exists(wk)) this.player.play(wk);
         } else {
            this.player.anims.stop();
            this.player.setFrame(globals.DIR_START[dir] || 0);
         }
      }
      
      if (this.tag && this.tag.setPosition) this.tag.setPosition(this.player.x, this.player.y - 45);
      this.player.setDepth(10 + this.player.y/1000); 
      
      if (office && office._placeWearable) {
         if (this.localCosmetic) {
             if (this.localCosmeticDef) office._placeWearable.call(this, this.localCosmetic, this.localCosmeticDef, this.player.x, this.player.y, dir);
             else this.localCosmetic.setPosition(this.player.x, this.player.y - 68);
         }
         if (this.localWings && this.localWingsDef) office._placeWearable.call(this, this.localWings, this.localWingsDef, this.player.x, this.player.y, dir);
      }
      if (office && office._stepPet && this.localPet) {
         office._stepPet.call(this, this.localPet, this.player.x, this.player.y, dir, this.sitting, false);
      }
      
      let canExit = false;
      let canSit = null; 

      if (this.location.startsWith('home:')) {
         const isAtDoor = this.player.y > this.physics.world.bounds.height - 70 && this.player.x > 5*48 && this.player.x < 7*48;
         if (isAtDoor) canExit = true;
         
         if (!this.sitting && this.furniture) {
            for (const f of this.furniture) {
               if (f.getData('isSeat')) {
                  const dist = Phaser.Math.Distance.Between(this.player.x, this.player.y, f.x, f.y);
                  if (dist < 40) { canSit = f; break; }
               }
            }
         }
      }
      
      if (canExit) {
         this.interactHint.setText('[E] Exit').setPosition(this.player.x, this.player.y - 65).setVisible(true);
      } else if (canSit) {
         this.interactHint.setText('[E] Sit').setPosition(this.player.x, this.player.y - 65).setVisible(true);
      } else if (this.sitting) {
         this.interactHint.setText('[E] Stand').setPosition(this.player.x, this.player.y - 65).setVisible(true);
      } else {
         this.interactHint.setVisible(false);
      }
      
      if (Phaser.Input.Keyboard.JustDown(this.keyE)) {
         if (canExit) {
            window.jpoTravel('city');
         } else if (this.sitting) {
            this.sitting = false;
            this.player.y -= 10; 
            this.playerDir = 'down';
         } else if (canSit) {
            this.sitting = true;
            this.sitX = canSit.x;
            this.sitY = canSit.y + 10;
            this.playerDir = canSit.getData('seatDir') || 'down';
         }
      }
      
      this.last += delta;
      if (this.last > 50) {
        this.last = 0;
        socket.emit('playerMove', { x: this.player.x, y: this.player.y, dir, anim });
      }
    }
  }
  socket.on('locationTransitionResult'`);

fs.writeFileSync('artifacts/jpo-huddle/public/neighborhood.js', code);
