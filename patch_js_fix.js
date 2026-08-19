const fs = require('fs');
let html = fs.readFileSync('artifacts/jpo-huddle/public/index.html', 'utf8');

// I'll extract the injection from patch_js.js again and replace `new Phaser.Game({`
const injection = fs.readFileSync('patch_js.js', 'utf8').match(/const injection = `([\s\S]*?)`;/)[1];
html = html.replace('new Phaser.Game({', injection + '\n    new Phaser.Game({');
fs.writeFileSync('artifacts/jpo-huddle/public/index.html', html);
