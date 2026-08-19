const fs = require('fs');
let html = fs.readFileSync('artifacts/jpo-huddle/public/index.html', 'utf8');

// remove everything between `// ── Pet Battle RPG Client` and `new Phaser.Game({`
html = html.replace(/\/\/ ══════════════════════════════════════════════════════════════════════════\n    \/\/ ── Pet Battle RPG Client(.*?)new Phaser\.Game\(\{/s, 'new Phaser.Game({');
fs.writeFileSync('artifacts/jpo-huddle/public/index.html', html);
