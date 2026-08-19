const fs = require('fs');
let html = fs.readFileSync('artifacts/jpo-huddle/public/index.html', 'utf8');
const css = fs.readFileSync('test.css', 'utf8');

// Inject CSS
html = html.replace('</style>', css + '\n  </style>');

// Inject RPS menu button
html = html.replace('<button id="rps-menu-challenge" type="button">⚔️ Challenge</button>', 
  '<button id="rps-menu-challenge" type="button">⚔️ Challenge</button>\n    <button id="rps-menu-petbattle" type="button">💥 Pet Battle</button>');

// Inject Coin HUD button
html = html.replace('<button id="voice-btn"', 
  '<button id="pet-bot-btn" onclick="openPetTraining()" title="Pet Battle Training">🐾 Train</button>\n    <button id="voice-btn"');

// Inject HTML UI
const uiHtml = `
  <!-- ── Pet Training Modal ── -->
  <div id="pt-train-modal">
    <div class="pt-rpg-card">
      <div class="pt-header">
        <h3 id="pt-title">Pet Training</h3>
        <button class="pt-close" id="pt-close" type="button">X</button>
      </div>
      <div id="pt-content">
        <div class="pt-pet-col">
          <div class="pt-img-box">
            <img id="pt-pet-img" src="" alt="Pet" />
          </div>
          <div id="pt-pet-name"></div>
          <div id="pt-pet-stage"></div>
        </div>
        <div class="pt-stats-col">
          <div class="pt-budget-row">
            <span>Points Available:</span>
            <span id="pt-points-avail">0</span>
          </div>
          <div id="pt-attr-list">
             <!-- JS injected -->
          </div>
        </div>
      </div>
      <div class="pt-footer">
         <div id="pt-error"></div>
         <button id="pt-save" class="pt-btn" type="button">Save Build</button>
         <button id="pt-challenge-bot" class="pt-btn pt-btn-primary" type="button">Challenge Bot</button>
      </div>
    </div>
  </div>

  <!-- ── Pet Battle Overlay ── -->
  <div id="pb-overlay">
    <div class="pb-arena">
      <div class="pb-bg-grid"></div>
      <div class="pb-top-bar">
         <span id="pb-round-text">Round 1</span>
         <button id="pb-forfeit-btn">Forfeit</button>
      </div>
      
      <div class="pb-stage">
        <!-- Opponent -->
        <div class="pb-combatant pb-opponent" id="pb-opp-box">
           <div class="pb-hud">
              <div class="pb-hud-name" id="pb-opp-name">Bot</div>
              <div class="pb-hud-form" id="pb-opp-form">Form</div>
              <div class="pb-bar-bg"><div class="pb-hp-bar" id="pb-opp-hp-bar"></div><div class="pb-hp-text" id="pb-opp-hp-text">50/50</div></div>
              <div class="pb-charge-bg" id="pb-opp-charge-bg">
                <div class="pb-charge-pip"></div>
                <div class="pb-charge-pip"></div>
                <div class="pb-charge-pip"></div>
              </div>
           </div>
           <div class="pb-sprite-container">
             <img class="pb-sprite" id="pb-opp-sprite" src="" />
             <div class="pb-fx-layer" id="pb-opp-fx"></div>
           </div>
        </div>
        
        <!-- Challenger -->
        <div class="pb-combatant pb-challenger" id="pb-cha-box">
           <div class="pb-sprite-container">
             <img class="pb-sprite" id="pb-cha-sprite" src="" />
             <div class="pb-fx-layer" id="pb-cha-fx"></div>
           </div>
           <div class="pb-hud">
              <div class="pb-hud-name" id="pb-cha-name">You</div>
              <div class="pb-hud-form" id="pb-cha-form">Form</div>
              <div class="pb-bar-bg"><div class="pb-hp-bar" id="pb-cha-hp-bar"></div><div class="pb-hp-text" id="pb-cha-hp-text">50/50</div></div>
              <div class="pb-charge-bg" id="pb-cha-charge-bg">
                <div class="pb-charge-pip"></div>
                <div class="pb-charge-pip"></div>
                <div class="pb-charge-pip"></div>
              </div>
           </div>
        </div>
      </div>
      
      <div class="pb-bottom-panel">
         <div class="pb-msg-box" id="pb-status-text">Waiting for opponent...</div>
         <div class="pb-controls" id="pb-controls">
            <button class="pb-move-btn" id="pb-btn-attack">ATTACK</button>
            <button class="pb-move-btn" id="pb-btn-guard">GUARD</button>
            <button class="pb-move-btn" id="pb-btn-special">SPECIAL<br><small id="pb-cd-special"></small></button>
            <button class="pb-move-btn" id="pb-btn-ultimate">ULTIMATE<br><small id="pb-cd-ultimate"></small></button>
         </div>
      </div>

      <div id="pb-result-screen">
         <h2 id="pb-result-title">Victory!</h2>
         <p id="pb-result-xp">+3 XP</p>
         <div class="pb-result-btn-row">
            <button class="pt-btn" id="pb-result-close">Close</button>
            <button class="pt-btn pt-btn-primary" id="pb-result-rematch" style="display:none">Rematch Bot</button>
         </div>
      </div>
    </div>
  </div>
`;
html = html.replace('<!-- ── Rock-Paper-Scissors challenges ── -->', uiHtml + '\n  <!-- ── Rock-Paper-Scissors challenges ── -->');

fs.writeFileSync('artifacts/jpo-huddle/public/index.html', html);
