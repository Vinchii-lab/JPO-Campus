const fs = require('fs');
let html = fs.readFileSync('artifacts/jpo-huddle/public/index.html', 'utf8');

html = html.replace('function pbCloseAll() {', 'function pbCloseAll() {\n      pbAnimQueue = []; pbIsAnimating = false;');
fs.writeFileSync('artifacts/jpo-huddle/public/index.html', html);
