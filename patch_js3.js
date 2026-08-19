const fs = require('fs');
let html = fs.readFileSync('artifacts/jpo-huddle/public/index.html', 'utf8');

const injection3 = `
    let pbAnimQueue = [];
    let pbIsAnimating = false;
    
    function pbProcessQueue() {
       if (pbIsAnimating || pbAnimQueue.length === 0) return;
       pbIsAnimating = true;
       const task = pbAnimQueue.shift();
       task().then(() => {
          pbIsAnimating = false;
          pbProcessQueue();
       });
    }

    function pbPlayHit(prefix, dmg, crit, guarded) {
       const fxBox = pbEl(prefix + '-fx');
       const spriteBox = pbEl(prefix + '-sprite');
       spriteBox.classList.add('pb-shake', 'pb-flash');
       setTimeout(() => spriteBox.classList.remove('pb-shake', 'pb-flash'), 400);
       
       if (dmg > 0) {
          const txt = document.createElement('div');
          txt.className = 'pb-dmg-text' + (crit ? ' crit' : '');
          txt.textContent = '-' + dmg;
          txt.style.left = (Math.random() * 40 + 20) + 'px';
          txt.style.top = (Math.random() * 20 + 20) + 'px';
          fxBox.appendChild(txt);
          setTimeout(() => txt.remove(), 1000);
       }
       
       if (crit) {
          const c = document.createElement('div');
          c.className = 'pb-crit-label';
          c.textContent = 'CRITICAL';
          fxBox.appendChild(c);
          setTimeout(() => c.remove(), 1000);
       }
       if (guarded) {
          const g = document.createElement('div');
          g.className = 'pb-dmg-text';
          g.style.color = '#bdc3c7';
          g.textContent = 'GUARDED';
          g.style.left = '10px';
          g.style.top = '60px';
          fxBox.appendChild(g);
          setTimeout(() => g.remove(), 1000);
       }
    }

    socket.on('petBattleRound', (payload) => {
       if (payload.matchId !== pbMatchId) return;
       pbState = 'resolving';
       
       pbAnimQueue.push(async () => {
          pbEl('pb-status-text').textContent = "Clash!";
          const myData = payload.combatants[pbMySide];
          const oppData = payload.combatants[pbMySide === 'challenger' ? 'opponent' : 'challenger'];
          const myRes = payload.result[pbMySide];
          const oppRes = payload.result[pbMySide === 'challenger' ? 'opponent' : 'challenger'];
          
          const chaSprite = pbEl('pb-cha-sprite');
          const oppSprite = pbEl('pb-opp-sprite');
          
          if (myRes.move !== 'guard') chaSprite.classList.add('pb-anim-atk-cha');
          if (oppRes.move !== 'guard') oppSprite.classList.add('pb-anim-atk-opp');
          
          await new Promise(r => setTimeout(r, 200));
          
          if (myRes.move !== 'guard') pbPlayHit('pb-opp', myRes.damageDealt, myRes.crit, myRes.guarded);
          if (oppRes.move !== 'guard') pbPlayHit('pb-cha', oppRes.damageDealt, oppRes.crit, oppRes.guarded);
          
          pbEl('pb-cha-hp-bar').style.width = Math.max(0, (myRes.hp / myData.maxHp) * 100) + '%';
          pbEl('pb-cha-hp-text').textContent = \`\${Math.max(0, myRes.hp)}/\${myData.maxHp}\`;
          pbEl('pb-opp-hp-bar').style.width = Math.max(0, (oppRes.hp / oppData.maxHp) * 100) + '%';
          pbEl('pb-opp-hp-text').textContent = \`\${Math.max(0, oppRes.hp)}/\${oppData.maxHp}\`;
          
          await new Promise(r => setTimeout(r, 600));
          
          chaSprite.classList.remove('pb-anim-atk-cha');
          oppSprite.classList.remove('pb-anim-atk-opp');
       });
       pbProcessQueue();
    });

    socket.on('petBattleResult', (payload) => {
       if (payload.matchId !== pbMatchId) return;
       
       pbAnimQueue.push(async () => {
          pbState = 'done';
          pbEl('pb-status-text').textContent = payload.draw ? "It's a draw!" : payload.youWon ? "You won!" : "You lost!";
          
          await new Promise(r => setTimeout(r, 1000));
          
          pbEl('pb-result-title').textContent = payload.draw ? "DRAW" : payload.youWon ? "VICTORY!" : "DEFEAT";
          pbEl('pb-result-title').style.color = payload.youWon ? "#FFC046" : (payload.draw ? "#bdc3c7" : "#e74c3c");
          pbEl('pb-result-screen').classList.add('open');
          
          // Result close button
          pbEl('pb-result-close').onclick = () => pbCloseAll();
          
          // Optional Rematch button for Bot
          const oppData = payload.combatants[pbMySide === 'challenger' ? 'opponent' : 'challenger'];
          if (oppData.isBot) {
             pbEl('pb-result-rematch').style.display = 'block';
             pbEl('pb-result-rematch').onclick = () => {
                pbCloseAll();
                pbState = 'pending';
                socket.emit('petBattleBotChallenge');
             };
          } else {
             pbEl('pb-result-rematch').style.display = 'none';
          }
       });
       pbProcessQueue();
    });

    socket.on('petBattleXp', (payload) => {
       if (payload.delta > 0) {
          pbEl('pb-result-xp').textContent = \`+\${payload.delta} XP\`;
       } else {
          pbEl('pb-result-xp').textContent = "No XP (Daily cap reached or Rematch CD)";
       }
    });
`;

html = html.replace('// Match Lifecycle', injection3 + '\n    // Match Lifecycle');
fs.writeFileSync('artifacts/jpo-huddle/public/index.html', html);
