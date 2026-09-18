import fs from 'fs';

let content = fs.readFileSync('artifacts/jpo-huddle/public/neighborhood-interiors.js', 'utf8');

content = content.replace(
  `    for (const portal of scene.info.portals || []) {
      if (portal.y !== 0) continue;
      scene.add.image(portal.x + portal.width / 2, portal.y + portal.height, 'pe_shop_door')`,
  `    for (const portal of scene.info.portals || []) {
      if (portal.y !== 0) continue;
      const isMuseum = locationId.startsWith('museum');
      const doorKey = isMuseum ? 'museum_door' : (scene.textures.exists('pe_shop_door') ? 'pe_shop_door' : 'museum_door');
      scene.add.image(portal.x + portal.width / 2, portal.y + portal.height, doorKey)`
);

fs.writeFileSync('artifacts/jpo-huddle/public/neighborhood-interiors.js', content);
