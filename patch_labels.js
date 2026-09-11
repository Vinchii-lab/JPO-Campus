const fs = require('fs');
let content = fs.readFileSync('artifacts/jpo-huddle/public/neighborhood.js', 'utf8');

const updatedLabels = `        const label = portal.destination === 'home' ? String(portal.label || (portal.residence ? ('Lot ' + portal.lot) : 'Home')).toUpperCase() :
          portal.destination === 'furniture-shop' ? 'FURNISHINGS' :
          portal.destination === 'garden-shop' ? 'WILLOW & GREEN' :
          portal.destination === 'decor-shop' ? 'PLAZA DECOR' :
          portal.destination === 'cafe' ? 'THE DAILY GRIND' :
          portal.destination === 'diner' ? 'NEON DINER' :
          portal.destination === 'bakery' ? 'SWEET CRUST BAKERY' :
          portal.destination === 'sushi' ? 'SAKURA SUSHI' :
          portal.destination === 'city' ? 'PLAZA' :`;

content = content.replace(
  /const label = portal\.destination === 'home' \? String[\s\S]*?portal\.destination === 'city' \? 'PLAZA' :/,
  updatedLabels
);

fs.writeFileSync('artifacts/jpo-huddle/public/neighborhood.js', content);
