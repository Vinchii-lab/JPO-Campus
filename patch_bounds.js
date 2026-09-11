const fs = require('fs');
let code = fs.readFileSync('artifacts/jpo-huddle/public/neighborhood.js', 'utf8');

// Match bounds and blockers from server's geometry payload
const boundsPatch = `
      this.info = data?.map || {}; 
      this.location = data?.location || currentLocation;
      const bounds = this.info.bounds || { width: 1152, height: 816 };
      const width = bounds.width;
      const height = bounds.height;
      this.physics.world.setBounds(0, 0, width, height);
`;
code = code.replace(/      this\.info = data\?\.map \|\| \{\}; [\s\S]*?this\.physics\.world\.setBounds\(0, 0, width, height\);/, boundsPatch);

const shellDrawPatch = `      if (isHome) {
        this.add.rectangle(width/2, height/2, width, height, 0xdfd3b8).setDepth(1);
        g.lineStyle(8, 0x8a7258, 1).strokeRect(4, 4, width-8, height-8);
        for(let x=0; x<=width; x+=48) g.lineStyle(1, 0x000000, 0.15).lineBetween(x, 0, x, height);
        for(let y=0; y<=height; y+=48) g.lineStyle(1, 0x000000, 0.15).lineBetween(0, y, width, y);
      } else if (this.location === 'furniture-shop') {`;
code = code.replace(/      if \(isHome\) \{[\s\S]*?\} else if \(this\.location === 'furniture-shop'\) \{/, shellDrawPatch);

const geomPatch = `      this.tag.setDepth(12);
      
      // Parse geometry
      const geom = this.info.geometry || {};
      this._geomBlocks = this.physics.add.staticGroup();
      if (geom.blockers) {
         geom.blockers.forEach(b => {
             const r = this.add.rectangle(b.x + b.width/2, b.y + b.height/2, b.width, b.height, 0xff0000, 0);
             this.physics.add.existing(r, true);
             this._geomBlocks.add(r);
         });
         this.physics.add.collider(this.player, this._geomBlocks);
      }
      this._doors = geom.doors || [];
      
`;
code = code.replace(/      this\.tag\.setDepth\(12\);/, geomPatch);

const updateDoorPatch = `      if (this.location.startsWith('home:')) {
         // Fallback door check if no geom doors provided
         if (this._doors.length === 0) {
            const isAtDoor = this.player.y > this.physics.world.bounds.height - 70 && this.player.x > 5*48 && this.player.x < 7*48;
            if (isAtDoor) canExit = true;
         }
         
         if (!this.sitting && this.furniture) {
            for (const f of this.furniture) {
               if (f.getData('isSeat')) {
                  const dist = Phaser.Math.Distance.Between(this.player.x, this.player.y, f.x, f.y);
                  if (dist < 40) { canSit = f; break; }
               }
            }
         }
      }
      
      // Dynamic door check from geometry payload
      if (this._doors && this._doors.length > 0) {
          for (const d of this._doors) {
              if (this.player.x >= d.x && this.player.x <= d.x + d.width &&
                  this.player.y >= d.y && this.player.y <= d.y + d.height) {
                  canExit = true;
                  this._doorDest = d.destination;
                  break;
              }
          }
      }
      
      if (canExit) {`;

code = code.replace(/      if \(this\.location\.startsWith\('home:'\)\) \{[\s\S]*?if \(canExit\) \{/, updateDoorPatch);

const doorClickPatch = `      if (Phaser.Input.Keyboard.JustDown(this.keyE)) {
         if (canExit) {
            window.jpoTravel(this._doorDest || 'city');`;
code = code.replace(/      if \(Phaser\.Input\.Keyboard\.JustDown\(this\.keyE\)\) \{\n         if \(canExit\) \{\n            window\.jpoTravel\('city'\);/, doorClickPatch);

fs.writeFileSync('artifacts/jpo-huddle/public/neighborhood.js', code);
