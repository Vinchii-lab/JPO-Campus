const fs = require('fs');
let html = fs.readFileSync('artifacts/jpo-huddle/public/index.html', 'utf8');

html = html.replace('id="pt-close"', 'id="pt-close" aria-label="Close Pet Training"');
html = html.replace('id="pb-forfeit-btn"', 'id="pb-forfeit-btn" aria-label="Forfeit Match"');
html = html.replace('id="pb-btn-attack"', 'id="pb-btn-attack" aria-label="Attack"');
html = html.replace('id="pb-btn-guard"', 'id="pb-btn-guard" aria-label="Guard"');
html = html.replace('id="pb-btn-special"', 'id="pb-btn-special" aria-label="Special Move"');
html = html.replace('id="pb-btn-ultimate"', 'id="pb-btn-ultimate" aria-label="Ultimate Move"');
html = html.replace('alt="Pet"', 'alt="Your equipped pet"');
html = html.replace('class="pb-sprite" id="pb-opp-sprite"', 'class="pb-sprite" id="pb-opp-sprite" alt="Opponent Pet"');
html = html.replace('class="pb-sprite" id="pb-cha-sprite"', 'class="pb-sprite" id="pb-cha-sprite" alt="Your Pet"');

fs.writeFileSync('artifacts/jpo-huddle/public/index.html', html);
