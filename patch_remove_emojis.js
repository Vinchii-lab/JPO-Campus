const fs = require('fs');
let html = fs.readFileSync('artifacts/jpo-huddle/public/index.html', 'utf8');

html = html.replace('💥 Pet Battle', 'Pet Battle');
html = html.replace('🐾 Train', 'Train');
html = html.replace('💥', '');
html = html.replace('🐾', '');

fs.writeFileSync('artifacts/jpo-huddle/public/index.html', html);
