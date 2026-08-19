const fs = require('fs');
let html = fs.readFileSync('artifacts/jpo-huddle/public/index.html', 'utf8');

const injection = `
    // ══════════════════════════════════════════════════════════════════════════
    // ── Pet Battle RPG Client ─────────────────────────────────────────────────
    // ══════════════════════════════════════════════════════════════════════════
    let pbMatchId = null;
    let pbState = null;
    let pbMySide = null;
    let pbBuild = null;
    let pbBudget = 0;
    let pbAttrs = ["power", "vitality", "speed", "critical", "focus"];

    const pbEl = (id) => document.getElementById(id);

    function pbCloseAll() {
      pbMatchId = null; pbState = null; pbMySide = null;
      pbEl('pb-overlay').classList.remove('open');
      pbEl('pb-waiting').classList.remove('open');
      pbEl('pb-incoming').classList.remove('open');
      pbEl('pb-result-screen').classList.remove('open');
    }

    pbEl('rps-menu-petbattle').addEventListener('pointerdown', (e) => {
      e.preventDefault(); e.stopPropagation();
      const targetId = _rpsMenuTargetId;
      _rpsHideMenu();
      if (targetId) {
         if (!_equippedPet) { _rpsToast("You need a pet equipped to battle!"); return; }
         pbState = 'pending';
         socket.emit('petBattleChallenge', { targetId });
      }
    });

    window.openPetTraining = function() {
      if (!_equippedPet) { _rpsToast("Equip a pet first!"); return; }
      pbEl('pt-train-modal').classList.add('open');
      pbEl('pt-error').textContent = "";
      socket.emit('petBattleGetBuild', { pet: _equippedPet });
    };

    pbEl('pt-close').addEventListener('pointerdown', () => pbEl('pt-train-modal').classList.remove('open'));

    function renderPbBuild(spent) {
      const list = pbEl('pt-attr-list');
      list.innerHTML = '';
      pbEl('pt-points-avail').textContent = Math.max(0, pbBudget - spent);
      
      pbAttrs.forEach(a => {
         const row = document.createElement('div'); row.className = 'pt-attr-row';
         const lbl = document.createElement('div'); lbl.className = 'pt-attr-label'; lbl.textContent = a.toUpperCase();
         const ctrl = document.createElement('div'); ctrl.className = 'pt-attr-ctrl';
         
         const bMinus = document.createElement('button'); bMinus.className = 'pt-btn-calc'; bMinus.textContent = '-';
         bMinus.onclick = () => updatePbAttr(a, -1);
         
         const v = document.createElement('div'); v.className = 'pt-attr-val'; v.textContent = pbBuild[a] || 0;
         
         const bPlus = document.createElement('button'); bPlus.className = 'pt-btn-calc'; bPlus.textContent = '+';
         bPlus.onclick = () => updatePbAttr(a, 1);
         
         ctrl.append(bMinus, v, bPlus);
         row.append(lbl, ctrl);
         list.appendChild(row);
      });
    }

    function updatePbAttr(attr, delta) {
       const cur = pbBuild[attr] || 0;
       const spent = pbAttrs.reduce((s, a) => s + (pbBuild[a] || 0), 0);
       if (delta < 0 && cur > 0) pbBuild[attr] = cur - 1;
       else if (delta > 0 && spent < pbBudget) pbBuild[attr] = cur + 1;
       renderPbBuild(pbAttrs.reduce((s, a) => s + (pbBuild[a] || 0), 0));
    }

    pbEl('pt-save').addEventListener('pointerdown', () => {
       pbEl('pt-error').textContent = "Saved!";
       socket.emit('petBattleSetBuild', { pet: _equippedPet, build: pbBuild });
    });

    pbEl('pt-challenge-bot').addEventListener('pointerdown', () => {
       pbEl('pt-train-modal').classList.remove('open');
       pbState = 'pending';
       socket.emit('petBattleBotChallenge');
    });

    socket.on('petBattleBuild', (payload) => {
      const { pet, build, budget, spent, stage, attrs } = payload;
      pbBudget = budget; pbBuild = { ...build }; pbAttrs = attrs;
      const img = pbEl('pt-pet-img');
      img.src = stage >= 2 ? \`/assets/pets/\${pet}_s\${stage}.png\` : \`/assets/pets/\${pet}.png\`;
      img.onerror = function() { this.onerror=null; this.src=\`/assets/pets/\${pet}.png\`; };
      pbEl('pt-pet-name').textContent = _petLabel(pet);
      pbEl('pt-pet-stage').textContent = stage >= 3 ? 'FINAL FORM' : stage === 2 ? 'EVOLVED' : 'BABY';
      renderPbBuild(spent);
    });

    // Match Lifecycle
    socket.on('petBattleChallengeSent', (payload) => {
       pbMatchId = payload.matchId;
       pbEl('pb-waiting-text').textContent = \`Challenging \${payload.toName}...\`;
       pbEl('pb-waiting').classList.add('open');
    });

    socket.on('petBattleChallengeIncoming', (payload) => {
       pbMatchId = payload.matchId;
       pbState = 'incoming';
       pbEl('pb-incoming-text').textContent = \`\${payload.fromName} challenges you to a Pet Battle!\`;
       pbEl('pb-incoming').classList.add('open');
    });

    pbEl('pb-waiting-cancel').addEventListener('pointerdown', () => {
       socket.emit('petBattleCancel', { matchId: pbMatchId });
       pbCloseAll();
    });
    pbEl('pb-incoming-accept').addEventListener('pointerdown', () => {
       socket.emit('petBattleRespond', { matchId: pbMatchId, accept: true });
       pbEl('pb-incoming').classList.remove('open');
    });
    pbEl('pb-incoming-decline').addEventListener('pointerdown', () => {
       socket.emit('petBattleRespond', { matchId: pbMatchId, accept: false });
       pbCloseAll();
    });

    socket.on('petBattleCancelled', (payload) => {
       if (payload.matchId === pbMatchId) {
          _rpsToast(payload.reason || "Battle cancelled.");
          pbCloseAll();
       }
    });

    socket.on('petBattleFail', (payload) => { _rpsToast(payload.message); pbCloseAll(); });
`;

html = html.replace('const game = new Phaser.Game(', injection + '\n    const game = new Phaser.Game(');
fs.writeFileSync('artifacts/jpo-huddle/public/index.html', html);
