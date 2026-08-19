const fs = require('fs');
let html = fs.readFileSync('artifacts/jpo-huddle/public/index.html', 'utf8');

const injection2 = `
    function pbRenderSide(prefix, data) {
       pbEl(prefix + '-name').textContent = data.name;
       pbEl(prefix + '-form').textContent = data.stage >= 3 ? 'FINAL FORM' : data.stage === 2 ? 'EVOLVED' : 'BABY';
       pbEl(prefix + '-hp-bar').style.width = Math.max(0, (data.hp / data.maxHp) * 100) + '%';
       pbEl(prefix + '-hp-text').textContent = \`\${Math.max(0, data.hp)}/\${data.maxHp}\`;
       
       const pips = pbEl(prefix + '-charge-bg').children;
       for (let i = 0; i < 3; i++) {
          pips[i].className = 'pb-charge-pip' + (i < data.charge ? ' filled' : '');
          if (data.charge >= 3) pips[i].classList.add('ult-ready');
       }

       const img = pbEl(prefix + '-sprite');
       img.src = data.stage >= 2 ? \`/assets/pets/\${data.petId}_s\${data.stage}.png\` : \`/assets/pets/\${data.petId}.png\`;
       img.onerror = function() { this.onerror=null; this.src=\`/assets/pets/\${data.petId}.png\`; };
    }

    socket.on('petBattleStart', (payload) => {
       if (payload.matchId !== pbMatchId && pbMatchId) return;
       pbMatchId = payload.matchId;
       pbState = 'starting';
       pbMySide = payload.you;
       
       pbEl('pb-waiting').classList.remove('open');
       pbEl('pb-incoming').classList.remove('open');
       pbEl('pb-overlay').classList.add('open');
       pbEl('pb-result-screen').classList.remove('open');
       
       const myData = payload.combatants[pbMySide];
       const oppData = payload.combatants[pbMySide === 'challenger' ? 'opponent' : 'challenger'];
       
       pbRenderSide('pb-cha', myData);
       pbRenderSide('pb-opp', oppData);
       
       pbEl('pb-round-text').textContent = \`Round 1 / \${payload.maxRounds}\`;
       pbEl('pb-status-text').textContent = "Get ready!";
       pbEl('pb-controls').style.opacity = '0.5';
       pbEl('pb-controls').style.pointerEvents = 'none';
       
       pbEl('pb-forfeit-btn').onclick = () => { socket.emit('petBattleCancel', { matchId: pbMatchId }); pbCloseAll(); };
    });

    socket.on('petBattlePickStatus', (payload) => {
       if (payload.matchId !== pbMatchId) return;
       pbState = 'picking';
       if (payload.foePicked) {
          pbEl('pb-status-text').textContent = "Opponent has locked their move!";
          return;
       }
       
       pbEl('pb-round-text').textContent = \`Round \${payload.round} / \${payload.maxRounds}\`;
       pbEl('pb-status-text').textContent = "Choose your move!";
       pbEl('pb-controls').style.opacity = '1';
       pbEl('pb-controls').style.pointerEvents = 'auto';
       
       const moves = ['attack', 'guard', 'special', 'ultimate'];
       moves.forEach(m => {
          const btn = pbEl('pb-btn-' + m);
          if (payload.legal.includes(m)) {
             btn.disabled = false;
          } else {
             btn.disabled = true;
          }
          btn.onclick = () => {
             pbEl('pb-controls').style.opacity = '0.5';
             pbEl('pb-controls').style.pointerEvents = 'none';
             pbEl('pb-status-text').textContent = "Waiting for opponent...";
             socket.emit('petBattlePick', { matchId: pbMatchId, move: m });
          };
       });
       
       pbEl('pb-cd-special').textContent = payload.specialCd > 0 ? \`[CD: \${payload.specialCd}]\` : '';
       pbEl('pb-cd-ultimate').textContent = payload.charge < payload.ultCharge ? \`[\${payload.charge}/\${payload.ultCharge}]\` : '[READY]';
       
       pbRenderSide('pb-cha', payload.you);
       pbRenderSide('pb-opp', payload.foe);
    });
`;

html = html.replace('// Match Lifecycle', injection2 + '\n    // Match Lifecycle');
fs.writeFileSync('artifacts/jpo-huddle/public/index.html', html);
