const fs = require('fs');
let code = fs.readFileSync('artifacts/jpo-huddle/public/neighborhood.js', 'utf8');

// Update remote sit logic
const oldRemoteSit = `      const isSit = p.anim === 'sit';
      if (isSit) {
         r.sprite.setTexture(texKey);
         r.sprite.setFrame(globals.DIR_START[p.dir] || 0); // Simplified seated mapping fallback
      } else {`;
      
const newRemoteSit = `      const isSit = p.anim === 'sit';
      if (isSit) {
         const d = p.dir || 'down';
         const sitAnim = \`sit_\${texKey}_\${d}\`;
         if (r.sprite.anims && r.sprite.scene.anims.exists(sitAnim)) {
             r.sprite.play(sitAnim);
         } else {
             r.sprite.setTexture(texKey);
             r.sprite.setFrame(globals.DIR_START[d] || 0);
         }
      } else {`;
      
code = code.replace(oldRemoteSit, newRemoteSit);

// Update local sit logic
const oldLocalSit = `      if (this.sitting) {
         anim = 'sit';
         this.player.setTexture(this.playerTexKey);
         this.player.setFrame(globals.DIR_START[dir] || 0);
         this.player.setY(this.sitY);
         this.player.setX(this.sitX);
      } else {`;

const newLocalSit = `      if (this.sitting) {
         anim = 'sit';
         const sitAnim = \`sit_\${this.playerTexKey}_\${dir}\`;
         if (this.player.scene.anims.exists(sitAnim)) {
             if (this.player.anims.currentAnim?.key !== sitAnim) this.player.play(sitAnim);
         } else {
             this.player.setTexture(this.playerTexKey);
             this.player.setFrame(globals.DIR_START[dir] || 0);
         }
         this.player.setY(this.sitY);
         this.player.setX(this.sitX);
      } else {`;

code = code.replace(oldLocalSit, newLocalSit);

fs.writeFileSync('artifacts/jpo-huddle/public/neighborhood.js', code);
