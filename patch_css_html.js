const fs = require('fs');
let html = fs.readFileSync('artifacts/jpo-huddle/public/index.html', 'utf8');

// I'll make the new pb-overlay more responsive, use better paths for assets, and setup pb-timer, fx etc.
const cssUpdates = `
/* ── Pet Battle RPG Interface ── */
#pt-train-modal, #pb-overlay {
  position: fixed; inset: 0; z-index: 11000; display: none;
  align-items: center; justify-content: center; background: rgba(0,0,0,0.85);
  font-family: 'Press Start 2P', monospace; user-select: none;
}
#pt-train-modal.open, #pb-overlay.open { display: flex; }

.pt-rpg-card {
  background: #1e1e30; border: 4px solid #5C4BE1; border-radius: 12px;
  box-shadow: 0 12px 0 #3a3a5e, 0 16px 40px rgba(0,0,0,0.8);
  width: 540px; max-width: 95vw; color: #fff; text-shadow: 2px 2px 0 #000;
  position: relative; overflow: hidden; display: flex; flex-direction: column;
}
.pt-header {
  background: #5C4BE1; padding: 16px; display: flex; justify-content: space-between;
  border-bottom: 4px solid #3a3a5e; align-items: center;
}
.pt-header h3 { margin: 0; font-size: 16px; color: #FFC046; }
.pt-close { background: none; border: none; color: #fff; font-size: 16px; cursor: pointer; }
.pt-close:hover { color: #FFC046; }

#pt-content { padding: 24px; display: flex; gap: 24px; flex-wrap: wrap; }
.pt-pet-col { flex: 0 0 140px; text-align: center; }
.pt-img-box {
  width: 140px; height: 140px; background: #111; border: 2px solid #5C4BE1;
  border-radius: 8px; display: flex; align-items: center; justify-content: center;
  margin-bottom: 12px; position: relative;
}
#pt-pet-img { width: 96px; height: 96px; object-fit: contain; image-rendering: pixelated; }
#pt-pet-name { font-size: 12px; color: #fff; margin-bottom: 6px; }
#pt-pet-stage { font-size: 10px; color: #FFC046; }

.pt-stats-col { flex: 1; min-width: 200px; display: flex; flex-direction: column; }
.pt-budget-row { font-size: 12px; margin-bottom: 16px; color: #ccc; }
#pt-points-avail { color: #FFC046; font-size: 16px; margin-left: 8px; }
.pt-attr-row { display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; }
.pt-attr-label { font-size: 10px; color: #fff; width: 75px; text-transform: uppercase; }
.pt-attr-desc { font-size: 8px; color: #888; margin-bottom: 8px; text-shadow: none; min-height: 10px; }
.pt-attr-ctrl { display: flex; align-items: center; gap: 6px; }
.pt-btn-calc {
  width: 24px; height: 24px; background: #3a3a5e; border: 2px solid #5C4BE1;
  color: #fff; font-family: inherit; font-size: 12px; cursor: pointer; border-radius: 4px;
}
.pt-btn-calc:hover { background: #5C4BE1; color: #FFC046; }
.pt-btn-calc:active { transform: translateY(2px); }
.pt-attr-val { width: 20px; text-align: center; font-size: 12px; color: #FFC046; }

.pt-derived-stats {
  margin-top: 12px; padding: 12px; background: #111; border: 2px solid #3a3a5e; border-radius: 8px;
  display: grid; grid-template-columns: 1fr 1fr; gap: 8px; font-size: 9px; color: #ccc;
}
.pt-derived-stats span { color: #FFC046; }

.pt-footer {
  padding: 16px 24px; background: #111; border-top: 4px solid #3a3a5e;
  display: flex; justify-content: space-between; align-items: center; gap: 12px;
}
#pt-error { color: #2ecc71; font-size: 10px; flex: 1; text-align: left; }
.pt-btn {
  padding: 12px 16px; font-family: inherit; font-size: 12px; background: #3a3a5e;
  color: #fff; border: 2px solid #5C4BE1; border-radius: 6px; cursor: pointer;
}
.pt-btn:hover { background: #5C4BE1; }
.pt-btn:active { transform: translateY(2px); box-shadow: none; }
.pt-btn-primary { background: #FFC046; border-color: #d99a2a; color: #111; text-shadow: none; }
.pt-btn-primary:hover { background: #ffcf70; }

/* Arena */
.pb-arena {
  width: 720px; max-width: 100vw; height: 100%; max-height: 520px;
  background: linear-gradient(180deg, #1e1e30 0%, #111 100%);
  border: 4px solid #5C4BE1; border-radius: 12px; box-shadow: 0 0 0 4px #111, 0 20px 50px rgba(0,0,0,0.9);
  position: relative; overflow: hidden; display: flex; flex-direction: column;
}
.pb-bg-grid {
  position: absolute; inset: 0; pointer-events: none;
  background: 
    linear-gradient(rgba(92,75,225,0.2) 1px, transparent 1px),
    linear-gradient(90deg, rgba(92,75,225,0.2) 1px, transparent 1px);
  background-size: 32px 32px; transform: perspective(400px) rotateX(60deg) scale(2);
  transform-origin: center bottom; opacity: 0.5;
}
.pb-top-bar {
  position: absolute; top: 0; left: 0; right: 0; padding: 12px 16px;
  display: flex; justify-content: space-between; align-items: center; z-index: 10;
}
#pb-round-text { font-size: 14px; color: #fff; text-shadow: 2px 2px 0 #5C4BE1; display: flex; align-items: center; gap: 12px; }
#pb-timer { color: #f1c40f; }
#pb-forfeit-btn {
  background: #e74c3c; border: 2px solid #c0392b; color: #fff; padding: 8px 12px;
  font-family: inherit; font-size: 10px; border-radius: 6px; cursor: pointer;
}
#pb-forfeit-btn:hover { background: #c0392b; }

.pb-stage { flex: 1; position: relative; z-index: 5; }

.pb-combatant {
  position: absolute; display: flex; flex-direction: column; align-items: center;
  width: 160px;
}
.pb-opponent { top: 40px; right: 20px; }
.pb-challenger { bottom: 130px; left: 20px; }
@media (min-width: 600px) {
  .pb-combatant { width: 220px; }
  .pb-opponent { top: 60px; right: 40px; }
  .pb-challenger { bottom: 140px; left: 40px; }
}

.pb-hud {
  background: rgba(17,17,17,0.85); border: 2px solid #5C4BE1; border-radius: 8px;
  padding: 8px; width: 100%; position: relative;
}
.pb-hud-name { font-size: 10px; color: #fff; margin-bottom: 4px; }
.pb-hud-form { font-size: 8px; color: #FFC046; margin-bottom: 8px; }
.pb-bar-bg { width: 100%; height: 12px; background: #000; border: 2px solid #333; margin-bottom: 4px; position: relative; }
.pb-hp-bar { height: 100%; background: #2ecc71; width: 100%; transition: width 0.3s ease; }
.pb-hp-text { position: absolute; right: 4px; top: -1px; font-size: 8px; color: #fff; text-shadow: 1px 1px 0 #000; }
.pb-charge-bg { width: 100%; height: 6px; background: #000; border: 2px solid #333; display: flex; }
.pb-charge-pip { flex: 1; border-right: 1px solid #333; transition: background 0.3s; }
.pb-charge-pip:last-child { border-right: none; }
.pb-charge-pip.filled { background: #3498db; }
.pb-charge-pip.ult-ready { background: #f1c40f; box-shadow: 0 0 6px #f1c40f; }

.pb-sprite-container {
  width: 120px; height: 120px; position: relative; display: flex;
  align-items: flex-end; justify-content: center; margin-top: 10px;
}
@media (min-width: 600px) { .pb-sprite-container { width: 160px; height: 160px; } }

.pb-sprite { width: 100%; height: auto; max-height: 100%; object-fit: contain; image-rendering: pixelated; transition: transform 0.2s; filter: drop-shadow(0 10px 0 rgba(0,0,0,0.5)); }
.pb-opponent .pb-sprite { transform: scaleX(-1); }

.pb-fx-layer { position: absolute; inset: -40px; pointer-events: none; overflow: visible; z-index: 20; }

.pb-bottom-panel {
  min-height: 120px; background: #111; border-top: 4px solid #5C4BE1;
  display: flex; flex-direction: column; position: relative; z-index: 10;
}
@media (min-width: 600px) { .pb-bottom-panel { flex-direction: row; } }

.pb-msg-box {
  flex: 1; padding: 12px; font-size: 12px; color: #fff; line-height: 1.4;
  border-bottom: 2px solid #5C4BE1;
}
@media (min-width: 600px) { .pb-msg-box { padding: 20px; font-size: 14px; border-bottom: none; border-right: 4px solid #5C4BE1; } }

.pb-controls {
  width: 100%; display: grid; grid-template-columns: 1fr 1fr; grid-template-rows: 1fr 1fr;
  gap: 8px; padding: 12px; background: #1e1e30; box-sizing: border-box;
}
@media (min-width: 600px) { .pb-controls { width: 320px; } }

.pb-move-btn {
  background: #3a3a5e; border: 2px solid #5C4BE1; color: #fff;
  font-family: inherit; font-size: 10px; border-radius: 6px; cursor: pointer;
  position: relative; overflow: hidden; padding: 8px;
}
.pb-move-btn:hover:not(:disabled) { background: #5C4BE1; color: #FFC046; }
.pb-move-btn:disabled { opacity: 0.4; cursor: not-allowed; filter: grayscale(1); }
.pb-cd-text { font-size: 8px; color: #ff7675; position: absolute; bottom: 4px; right: 4px; }

#pb-result-screen {
  position: absolute; inset: 0; background: rgba(0,0,0,0.9); z-index: 30;
  display: none; flex-direction: column; align-items: center; justify-content: center;
}
#pb-result-screen.open { display: flex; }
#pb-result-title { font-size: 32px; color: #FFC046; margin-bottom: 20px; text-shadow: 4px 4px 0 #c0392b; }
#pb-result-xp { font-size: 14px; color: #2ecc71; margin-bottom: 30px; text-align: center; line-height: 1.5; }
.pb-result-btn-row { display: flex; gap: 16px; flex-wrap: wrap; justify-content: center; }

/* Battle Animations */
@keyframes pb-hit-shake {
  0% { transform: translate(0, 0); }
  20% { transform: translate(-10px, 5px); }
  40% { transform: translate(10px, -5px); }
  60% { transform: translate(-10px, -5px); }
  80% { transform: translate(10px, 5px); }
  100% { transform: translate(0, 0); }
}
.pb-shake { animation: pb-hit-shake 0.3s cubic-bezier(.36,.07,.19,.97) both; }

@keyframes pb-flash {
  0%, 100% { filter: brightness(1) drop-shadow(0 10px 0 rgba(0,0,0,0.5)); }
  50% { filter: brightness(3) drop-shadow(0 10px 0 rgba(0,0,0,0.5)); }
}
.pb-flash { animation: pb-flash 0.15s ease-in-out 2; }

@keyframes pb-guard-pose {
  0% { transform: scale(1); filter: brightness(1); }
  20% { transform: scale(0.9) translateY(10px); filter: brightness(0.8) drop-shadow(0 0 10px #bdc3c7); }
  80% { transform: scale(0.9) translateY(10px); filter: brightness(0.8) drop-shadow(0 0 10px #bdc3c7); }
  100% { transform: scale(1); filter: brightness(1); }
}
.pb-anim-guard { animation: pb-guard-pose 0.8s ease-in-out; }

@keyframes pb-dodge {
  0% { transform: translateX(0); opacity: 1; filter: blur(0); }
  20% { transform: translateX(-40px); opacity: 0.5; filter: blur(2px); }
  80% { transform: translateX(-40px); opacity: 0.5; filter: blur(2px); }
  100% { transform: translateX(0); opacity: 1; filter: blur(0); }
}
.pb-anim-dodge-cha { animation: pb-dodge 0.6s ease-in-out; }
.pb-anim-dodge-opp { animation: pb-dodge 0.6s ease-in-out reverse; }

@keyframes pb-atk-cha {
  0% { transform: translate(0, 0); }
  20% { transform: translate(-20px, 10px); }
  40% { transform: translate(60px, -40px); }
  100% { transform: translate(0, 0); }
}
@keyframes pb-atk-opp {
  0% { transform: translate(0, 0) scaleX(-1); }
  20% { transform: translate(20px, 10px) scaleX(-1); }
  40% { transform: translate(-60px, 40px) scaleX(-1); }
  100% { transform: translate(0, 0) scaleX(-1); }
}
.pb-anim-atk-cha { animation: pb-atk-cha 0.5s ease-in-out; }
.pb-anim-atk-opp { animation: pb-atk-opp 0.5s ease-in-out; }

.pb-dmg-text {
  position: absolute; font-size: 20px; font-weight: bold; color: #ff7675; text-shadow: 2px 2px 0 #000;
  pointer-events: none; z-index: 100; animation: pb-dmg-float 1s ease-out forwards;
}
.pb-dmg-text.crit { font-size: 28px; color: #FFC046; text-shadow: 3px 3px 0 #c0392b; z-index: 101; }
@keyframes pb-dmg-float {
  0% { opacity: 1; transform: translateY(0) scale(0.8); }
  20% { transform: translateY(-30px) scale(1.2); }
  100% { opacity: 0; transform: translateY(-60px) scale(1); }
}

.pb-big-label {
  position: absolute; font-size: 28px; font-weight: bold; font-style: italic; text-transform: uppercase;
  z-index: 110; top: 50%; left: 50%; transform: translate(-50%, -50%) rotate(-10deg);
  pointer-events: none; animation: pb-big-label-pop 0.9s forwards; white-space: nowrap;
}
.pb-lbl-crit { color: #ff0000; text-shadow: 4px 4px 0 #fff; }
.pb-lbl-dodge { color: #3498db; text-shadow: 4px 4px 0 #fff; transform: translate(-50%, -50%) rotate(10deg); }
@keyframes pb-big-label-pop {
  0% { opacity: 0; transform: translate(-50%, -50%) scale(3) rotate(-10deg); }
  20% { opacity: 1; transform: translate(-50%, -50%) scale(1) rotate(-10deg); }
  80% { opacity: 1; transform: translate(-50%, -50%) scale(1) rotate(-10deg); }
  100% { opacity: 0; transform: translate(-50%, -50%) scale(0.8) rotate(-10deg); }
}

/* Base Particle */
.pb-particle {
  position: absolute; width: 8px; height: 8px; background: #fff;
  pointer-events: none; z-index: 40; border-radius: 50%;
}
@keyframes pb-proj-cha {
  0% { left: 0%; top: 50%; transform: scale(1); opacity: 1; }
  100% { left: 100%; top: 50%; transform: scale(1.5); opacity: 0; }
}
@keyframes pb-proj-opp {
  0% { right: 0%; top: 50%; transform: scale(1); opacity: 1; }
  100% { right: 100%; top: 50%; transform: scale(1.5); opacity: 0; }
}
.pb-anim-proj-cha { animation: pb-proj-cha 0.4s cubic-bezier(0.4, 0, 1, 1) forwards; }
.pb-anim-proj-opp { animation: pb-proj-opp 0.4s cubic-bezier(0.4, 0, 1, 1) forwards; }
`;

html = html.replace(/\/\* ── Pet Battle RPG Interface ── \*\/[\s\S]*?\/\* ── End Pet Battle CSS ── \*\//, '');
html = html.replace(/\/\* ── Pet Battle RPG Interface ── \*\/[\s\S]*?\.pb-anim-proj-opp \{[^\}]*?\}/, '');
// Wait, I will just do a string replace where I know it was injected
html = html.replace('</style>', cssUpdates + '\n  </style>');
fs.writeFileSync('artifacts/jpo-huddle/public/index.html', html);
