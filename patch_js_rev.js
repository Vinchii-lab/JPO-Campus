const fs = require('fs');
let html = fs.readFileSync('artifacts/jpo-huddle/public/index.html', 'utf8');

// I'll replace the full_js block starting from `// ═════════════` up to `    new Phaser.Game({`
const newJs = `
    // ══════════════════════════════════════════════════════════════════════════
    // ── Pet Battle RPG Client ─────────────────────────────────────────────────
    // ══════════════════════════════════════════════════════════════════════════
    let pbMatchId = null;
    let pbState = null;
    let pbMySide = null;
    let pbBuild = null;
    let pbBudget = 0;
    let pbAttrs = ["power", "vitality", "speed", "critical", "focus"];
    let pbAnimQueue = [];
    let pbIsAnimating = false;
    let pbGen = 0;
    let pbTimer = null;
    
    // Per-species visual theme mapping for Special and Ultimate moves
    const PB_THEME_BY_PET = {
      'pet_duck':            { color: '#f1c40f', shape: '50%', fx: 'splash', special: 'Water Gun', ultimate: 'Hydro Blast' },
      'pet_duck_snow':       { color: '#ecf0f1', shape: '50%', fx: 'frost', special: 'Snowball', ultimate: 'Blizzard' },
      'pet_cat':             { color: '#e67e22', shape: '2px', fx: 'scratch', special: 'Claw Swipe', ultimate: 'Feral Frenzy' },
      'pet_cat_black':       { color: '#8e44ad', shape: '2px', fx: 'shadow', special: 'Night Slash', ultimate: 'Phantom Strike' },
      'pet_cat_snow':        { color: '#bdc3c7', shape: '2px', fx: 'frost', special: 'Chill Claw', ultimate: 'Avalanche' },
      'pet_dog':             { color: '#f39c12', shape: '4px', fx: 'impact', special: 'Bite', ultimate: 'Earth Shaker' },
      'pet_dog_choco':       { color: '#d35400', shape: '4px', fx: 'earth', special: 'Mud Slap', ultimate: 'Quake' },
      'pet_dog_husky':       { color: '#3498db', shape: '4px', fx: 'frost', special: 'Ice Fang', ultimate: 'Tundra Howl' },
      'pet_bunny':           { color: '#ffb8b8', shape: '50%', fx: 'wind', special: 'Quick Kick', ultimate: 'Tornado Spin' },
      'pet_bunny_cocoa':     { color: '#a0522d', shape: '50%', fx: 'earth', special: 'Burrow Strike', ultimate: 'Meteor Bound' },
      'pet_turtle':          { color: '#2ecc71', shape: '0%', fx: 'leaf', special: 'Razor Leaf', ultimate: 'Nature Wrath' },
      'pet_turtle_sapphire': { color: '#0984e3', shape: '0%', fx: 'splash', special: 'Aqua Jet', ultimate: 'Tsunami' },
      'pet_dragon':          { color: '#9b59b6', shape: '50%', fx: 'magic', special: 'Arcane Flame', ultimate: 'Dragon Nova' },
      'pet_dragon_crimson':  { color: '#e74c3c', shape: '50%', fx: 'fire', special: 'Ember Spit', ultimate: 'Inferno' },
      'pet_dragon_obsidian': { color: '#2c3e50', shape: '50%', fx: 'shadow', special: 'Dark Pulse', ultimate: 'Void Eruption' },
      'pet_frog':            { color: '#1abc9c', shape: '50%', fx: 'splash', special: 'Bubble', ultimate: 'Swamp Bomb' },
      'pet_unicorn':         { color: '#fd79a8', shape: '50%', fx: 'holy', special: 'Prism Beam', ultimate: 'Starlight' },
      'pet_phoenix':         { color: '#ff7675', shape: '50%', fx: 'fire', special: 'Searing Wing', ultimate: 'Supernova' },
      'default':             { color: '#ffffff', shape: '0%', fx: 'impact', special: 'Special', ultimate: 'Ultimate' }
    };
    function getPbTheme(petId) {
      let baseId = petId;
      if (!PB_THEME_BY_PET[baseId] && baseId.startsWith('pet_')) {
        const parts = baseId.split('_');
        baseId = parts[0] + '_' + parts[1]; // e.g. pet_dog_choco -> pet_dog if choco wasn't there
      }
      return PB_THEME_BY_PET[baseId] || PB_THEME_BY_PET['default'];
    }

    const pbEl = (id) => document.getElementById(id);

    function pbClearTimers() {
      if (pbTimer) { clearInterval(pbTimer); pbTimer = null; }
      pbEl('pb-timer').textContent = '';
    }
    
    function pbStartTimer(ms) {
       pbClearTimers();
       let end = Date.now() + ms;
       const update = () => {
          let left = Math.max(0, Math.ceil((end - Date.now()) / 1000));
          pbEl('pb-timer').textContent = '0:' + (left < 10 ? '0' : '') + left;
          if (left <= 0) pbClearTimers();
       };
       update();
       pbTimer = setInterval(update, 1000);
    }

    // Capture arrow/space inputs so moving player is disabled
    pbEl('pb-overlay').addEventListener('keydown', (e) => {
       if (['ArrowUp','ArrowDown','ArrowLeft','ArrowRight',' '].includes(e.key)) { e.preventDefault(); e.stopPropagation(); }
    });
    pbEl('pb-overlay').tabIndex = -1; // make focusable to trap keys

    function pbCloseAll() {
      pbGen++; 
      pbAnimQueue = []; pbIsAnimating = false;
      pbMatchId = null; pbState = null; pbMySide = null;
      pbClearTimers();
      pbEl('pb-cha-fx').replaceChildren(); pbEl('pb-opp-fx').replaceChildren();
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

    function renderPbBuild(spent, stats) {
      const list = pbEl('pt-attr-list');
      list.replaceChildren();
      pbEl('pt-points-avail').textContent = Math.max(0, pbBudget - spent);
      
      const descs = {
         power: "Boosts physical damage",
         vitality: "Increases max HP and block mitigation",
         speed: "Attacks hit first (breaks ties)",
         critical: "Increases critical hit chance and multiplier",
         focus: "Boosts Special/Ultimate power and block efficiency"
      };

      pbAttrs.forEach(a => {
         const row = document.createElement('div'); row.className = 'pt-attr-row';
         
         const left = document.createElement('div');
         const lbl = document.createElement('div'); lbl.className = 'pt-attr-label'; lbl.textContent = a;
         const desc = document.createElement('div'); desc.className = 'pt-attr-desc'; desc.textContent = descs[a];
         left.append(lbl, desc);
         
         const ctrl = document.createElement('div'); ctrl.className = 'pt-attr-ctrl';
         const bMinus = document.createElement('button'); bMinus.className = 'pt-btn-calc'; bMinus.textContent = '-';
         bMinus.onclick = () => updatePbAttr(a, -1);
         const v = document.createElement('div'); v.className = 'pt-attr-val'; v.textContent = pbBuild[a] || 0;
         const bPlus = document.createElement('button'); bPlus.className = 'pt-btn-calc'; bPlus.textContent = '+';
         bPlus.onclick = () => updatePbAttr(a, 1);
         
         ctrl.append(bMinus, v, bPlus);
         row.append(left, ctrl);
         list.appendChild(row);
      });
      
      if (stats) {
         let div = document.createElement('div'); div.className = 'pt-derived-stats';
         div.innerHTML = \`
           <div>HP: <span>\${stats.maxHp}</span></div>
           <div>ATK: <span>\${stats.attack}</span></div>
           <div>GUARD: <span>\${Math.round(stats.guardCut*100)}% DMG cut</span></div>
           <div>CRIT: <span>\${Math.round(stats.critChance*100)}% (\${stats.critMult}x)</span></div>
         \`;
         list.appendChild(div);
      }
    }

    function updatePbAttr(attr, delta) {
       const cur = pbBuild[attr] || 0;
       const spent = pbAttrs.reduce((s, a) => s + (pbBuild[a] || 0), 0);
       if (delta < 0 && cur > 0) pbBuild[attr] = cur - 1;
       else if (delta > 0 && spent < pbBudget) pbBuild[attr] = cur + 1;
       renderPbBuild(pbAttrs.reduce((s, a) => s + (pbBuild[a] || 0), 0));
       pbEl('pt-error').textContent = "Unsaved changes...";
       pbEl('pt-error').style.color = '#FFC046';
    }

    pbEl('pt-save').addEventListener('pointerdown', () => {
       pbEl('pt-error').textContent = "Saving...";
       pbEl('pt-error').style.color = '#ccc';
       socket.emit('petBattleSetBuild', { pet: _equippedPet, build: pbBuild });
    });

    pbEl('pt-challenge-bot').addEventListener('pointerdown', () => {
       pbEl('pt-train-modal').classList.remove('open');
       pbState = 'pending';
       socket.emit('petBattleBotChallenge');
    });

    socket.on('petBattleBuild', (payload) => {
      const { pet, build, budget, spent, stage, attrs, stats } = payload;
      pbBudget = budget; pbBuild = { ...build }; pbAttrs = attrs;
      const img = pbEl('pt-pet-img');
      img.src = stage >= 2 ? 'assets/pets/' + pet + '_s' + stage + '.png' : 'assets/pets/' + pet + '.png';
      img.onerror = function() { this.onerror=null; this.src = 'assets/pets/' + pet + '.png'; };
      const cPet = typeof PETS !== 'undefined' ? PETS.find(p => p.id === pet) : null;
      pbEl('pt-pet-name').textContent = cPet ? cPet.species + ' — ' + cPet.name : pet;
      pbEl('pt-pet-stage').textContent = stage >= 3 ? 'FINAL FORM' : stage === 2 ? 'EVOLVED' : 'BABY';
      renderPbBuild(spent, stats);
      pbEl('pt-error').textContent = "Saved!";
      pbEl('pt-error').style.color = '#2ecc71';
    });

    socket.on('petBattleChallengeSent', (payload) => {
       pbMatchId = payload.matchId;
       pbEl('pb-waiting-text').textContent = 'Challenging ' + payload.toName + '...';
       pbEl('pb-waiting').classList.add('open');
    });

    socket.on('petBattleChallengeIncoming', (payload) => {
       pbMatchId = payload.matchId;
       pbState = 'incoming';
       pbEl('pb-incoming-text').textContent = payload.fromName + ' challenges you to a Pet Battle!';
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

    function pbRenderSide(prefix, data) {
       pbEl(prefix + '-name').textContent = data.name;
       pbEl(prefix + '-form').textContent = data.stage >= 3 ? 'FINAL FORM' : data.stage === 2 ? 'EVOLVED' : 'BABY';
       pbEl(prefix + '-hp-bar').style.width = Math.max(0, (data.hp / data.maxHp) * 100) + '%';
       pbEl(prefix + '-hp-text').textContent = Math.max(0, data.hp) + '/' + data.maxHp;
       
       const pips = pbEl(prefix + '-charge-bg').children;
       for (let i = 0; i < 3; i++) {
          pips[i].className = 'pb-charge-pip' + (i < data.charge ? ' filled' : '');
          if (data.charge >= 3) pips[i].classList.add('ult-ready');
       }

       const img = pbEl(prefix + '-sprite');
       img.src = data.stage >= 2 ? 'assets/pets/' + data.petId + '_s' + data.stage + '.png' : 'assets/pets/' + data.petId + '.png';
       img.onerror = function() { this.onerror=null; this.src = 'assets/pets/' + data.petId + '.png'; };
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
       pbEl('pb-result-xp').textContent = 'Pending XP...';
       pbEl('pb-overlay').focus();
       
       const myData = payload.combatants[pbMySide];
       const oppData = payload.combatants[pbMySide === 'challenger' ? 'opponent' : 'challenger'];
       
       pbRenderSide('pb-cha', myData);
       pbRenderSide('pb-opp', oppData);
       
       const myTheme = getPbTheme(myData.petId);
       pbEl('pb-btn-special').innerHTML = myTheme.special + '<br><small id="pb-cd-special"></small>';
       pbEl('pb-btn-ultimate').innerHTML = myTheme.ultimate + '<br><small id="pb-cd-ultimate"></small>';
       
       pbEl('pb-round-text').innerHTML = 'Round 1 / ' + payload.maxRounds + ' <span id="pb-timer"></span>';
       pbEl('pb-status-text').textContent = "Get ready!";
       pbEl('pb-controls').style.opacity = '0.5';
       pbEl('pb-controls').style.pointerEvents = 'none';
       
       pbEl('pb-forfeit-btn').onclick = () => { socket.emit('petBattleForfeit', { matchId: pbMatchId }); };
    });

    function pbProcessQueue() {
       if (pbIsAnimating || pbAnimQueue.length === 0) return;
       pbIsAnimating = true;
       const task = pbAnimQueue.shift();
       task().then(() => {
          pbIsAnimating = false;
          pbProcessQueue();
       });
    }

    function pbPlayHit(prefix, dmg, crit, dodged, guarded, theme, isUlt, oppPrefix) {
       const fxBox = pbEl(prefix + '-fx');
       const spriteBox = pbEl(prefix + '-sprite');
       const oppBox = pbEl(oppPrefix + '-fx');
       
       if (dodged) {
          spriteBox.classList.add(prefix === 'pb-cha' ? 'pb-anim-dodge-cha' : 'pb-anim-dodge-opp');
          setTimeout(() => spriteBox.classList.remove('pb-anim-dodge-cha', 'pb-anim-dodge-opp'), 600);
          const g = document.createElement('div');
          g.className = 'pb-big-label pb-lbl-dodge';
          g.textContent = 'DODGE';
          fxBox.appendChild(g);
          setTimeout(() => g.remove(), 1000);
          return;
       }
       
       if (theme) {
          // Play themed projectile
          const p = document.createElement('div');
          p.className = 'pb-particle pb-anim-proj-' + (oppPrefix === 'pb-cha' ? 'cha' : 'opp');
          p.style.backgroundColor = theme.color;
          p.style.borderRadius = theme.shape;
          p.style.boxShadow = '0 0 10px ' + theme.color;
          if (isUlt) { p.style.width = '20px'; p.style.height = '20px'; p.style.transform = 'scale(3)'; }
          oppBox.appendChild(p);
          setTimeout(() => p.remove(), 500);
       }
       
       setTimeout(() => {
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
             c.className = 'pb-big-label pb-lbl-crit';
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
       }, theme ? 400 : 0);
    }

    socket.on('petBattlePickStatus', (payload) => {
       if (payload.matchId !== pbMatchId) return;
       pbClearTimers();
       let myGen = pbGen;
       pbAnimQueue.push(async () => {
          if (myGen !== pbGen) return;
          pbState = 'picking';
          if (payload.foePicked) {
             pbEl('pb-status-text').textContent = "Opponent has locked their move!";
             return;
          }
          
          pbEl('pb-round-text').innerHTML = 'Round ' + payload.round + ' / ' + payload.maxRounds + ' <span id="pb-timer"></span>';
          if (payload.pickMs) pbStartTimer(payload.pickMs);
          
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
                pbClearTimers();
                pbEl('pb-controls').style.opacity = '0.5';
                pbEl('pb-controls').style.pointerEvents = 'none';
                pbEl('pb-status-text').textContent = "Waiting for opponent...";
                socket.emit('petBattlePick', { matchId: pbMatchId, move: m });
             };
          });
          
          pbEl('pb-cd-special').textContent = payload.specialCd > 0 ? '[CD: ' + payload.specialCd + ']' : '';
          pbEl('pb-cd-ultimate').textContent = payload.charge < payload.ultCharge ? '[' + payload.charge + '/' + payload.ultCharge + ']' : '[READY]';
          
          pbRenderSide('pb-cha', payload.you);
          pbRenderSide('pb-opp', payload.foe);
       });
       pbProcessQueue();
    });

    socket.on('petBattleRound', (payload) => {
       if (payload.matchId !== pbMatchId) return;
       pbState = 'resolving';
       pbClearTimers();
       
       let myGen = pbGen;
       pbAnimQueue.push(async () => {
          if (myGen !== pbGen) return;
          pbEl('pb-status-text').textContent = "Clash!";
          const myData = payload.combatants[pbMySide];
          const oppData = payload.combatants[pbMySide === 'challenger' ? 'opponent' : 'challenger'];
          const myRes = payload.result[pbMySide];
          const oppRes = payload.result[pbMySide === 'challenger' ? 'opponent' : 'challenger'];
          
          const chaSprite = pbEl('pb-cha-sprite');
          const oppSprite = pbEl('pb-opp-sprite');
          const myTheme = getPbTheme(myData.petId);
          const oppTheme = getPbTheme(oppData.petId);
          
          // Animate Guard Poses
          if (myRes.move === 'guard') chaSprite.classList.add('pb-anim-guard');
          if (oppRes.move === 'guard') oppSprite.classList.add('pb-anim-guard');
          
          // Animate Attacks (speed informed)
          const myFirst = myData.speed >= oppData.speed;
          
          async function doHit(attacker, attRes, defRes, attSprite, attTheme, oppPrefix, myPrefix, oppDodged) {
             if (attRes.move === 'guard') return;
             if (attRes.move === 'attack') {
                 attSprite.classList.add(myPrefix === 'pb-cha' ? 'pb-anim-atk-cha' : 'pb-anim-atk-opp');
                 await new Promise(r => setTimeout(r, 200));
                 pbPlayHit(oppPrefix, attRes.damageDealt, attRes.crit, oppDodged, attRes.guarded, null, false, myPrefix);
                 await new Promise(r => setTimeout(r, 300));
                 attSprite.classList.remove('pb-anim-atk-cha', 'pb-anim-atk-opp');
             } else {
                 const isUlt = attRes.move === 'ultimate';
                 pbPlayHit(oppPrefix, attRes.damageDealt, attRes.crit, oppDodged, attRes.guarded, attTheme, isUlt, myPrefix);
                 await new Promise(r => setTimeout(r, isUlt ? 800 : 500));
             }
          }
          
          if (myFirst) {
             await doHit(myData, myRes, oppRes, chaSprite, myTheme, 'pb-opp', 'pb-cha', oppRes.dodged);
             await doHit(oppData, oppRes, myRes, oppSprite, oppTheme, 'pb-cha', 'pb-opp', myRes.dodged);
          } else {
             await doHit(oppData, oppRes, myRes, oppSprite, oppTheme, 'pb-cha', 'pb-opp', myRes.dodged);
             await doHit(myData, myRes, oppRes, chaSprite, myTheme, 'pb-opp', 'pb-cha', oppRes.dodged);
          }
          
          pbEl('pb-cha-hp-bar').style.width = Math.max(0, (myRes.hp / myData.maxHp) * 100) + '%';
          pbEl('pb-cha-hp-text').textContent = Math.max(0, myRes.hp) + '/' + myData.maxHp;
          pbEl('pb-opp-hp-bar').style.width = Math.max(0, (oppRes.hp / oppData.maxHp) * 100) + '%';
          pbEl('pb-opp-hp-text').textContent = Math.max(0, oppRes.hp) + '/' + oppData.maxHp;
          
          // Re-render pips
          pbRenderSide('pb-cha', {...myData, hp: myRes.hp, charge: myRes.charge});
          pbRenderSide('pb-opp', {...oppData, hp: oppRes.hp, charge: oppRes.charge});
          
          await new Promise(r => setTimeout(r, 400));
          chaSprite.classList.remove('pb-anim-guard');
          oppSprite.classList.remove('pb-anim-guard');
       });
       pbProcessQueue();
    });

    socket.on('petBattleResult', (payload) => {
       if (payload.matchId !== pbMatchId) return;
       pbClearTimers();
       let myGen = pbGen;
       
       pbAnimQueue.push(async () => {
          if (myGen !== pbGen) return;
          pbState = 'done';
          pbEl('pb-status-text').textContent = payload.draw ? "It's a draw!" : payload.youWon ? "You won!" : "You lost!";
          
          await new Promise(r => setTimeout(r, 1000));
          
          pbEl('pb-result-title').textContent = payload.draw ? "DRAW" : payload.youWon ? "VICTORY!" : "DEFEAT";
          pbEl('pb-result-title').style.color = payload.youWon ? "#FFC046" : (payload.draw ? "#bdc3c7" : "#e74c3c");
          pbEl('pb-result-screen').classList.add('open');
          
          pbEl('pb-result-close').onclick = () => pbCloseAll();
          
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
          pbEl('pb-result-xp').textContent = '+' + payload.delta + ' XP';
       } else {
          pbEl('pb-result-xp').innerHTML = "No XP earned<br><small style='color:#aaa'>(Daily cap reached or Rematch CD)</small>";
       }
    });
`;

html = html.replace(/\/\/ ══════════════════════════════════════════════════════════════════════════\n    \/\/ ── Pet Battle RPG Client[\s\S]*?new Phaser\.Game\(\{/, newJs + '\n    new Phaser.Game({');
fs.writeFileSync('artifacts/jpo-huddle/public/index.html', html);
