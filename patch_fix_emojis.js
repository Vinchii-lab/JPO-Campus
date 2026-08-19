const fs = require('fs');
let html = fs.readFileSync('artifacts/jpo-huddle/public/index.html', 'utf8');

html = html.replace('<button id="rps-menu-trade" type="button"> Trade pets</button>', '<button id="rps-menu-trade" type="button">🐾 Trade pets</button>');

fs.writeFileSync('artifacts/jpo-huddle/public/index.html', html);
