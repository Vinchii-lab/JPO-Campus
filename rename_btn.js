const fs = require('fs');
let html = fs.readFileSync('artifacts/jpo-huddle/public/index.html', 'utf8');
html = html.replace('<button id="pet-bot-btn" onclick="openPetTraining()" title="Pet Battle Training">Train</button>',
  '<button id="pet-bot-btn" onclick="openPetTraining()" title="Pet Battle Training" style="padding: 3px 10px; font-size: 12px; font-family: monospace; background: #e67e22; color: #fff; border: none; border-radius: 5px; cursor: pointer; transition: background 0.15s; margin-right: 8px;">Pet Arena</button>');
fs.writeFileSync('artifacts/jpo-huddle/public/index.html', html);
