const fs = require('fs');
let content = fs.readFileSync('artifacts/jpo-huddle/neighborhood.mjs', 'utf8');

// 1. Update LOCATIONS
content = content.replace(
  'city: { id: "city", label: "Huddle Plaza", spawn: { x: 144, y: 480, dir: "right" }, bounds: { width: 1152, height: 912 } },',
  'city: { id: "city", label: "Huddle Plaza", spawn: { x: 144, y: 480, dir: "right" }, bounds: { width: 1152, height: 1600 } },\n  cafe: { id: "cafe", label: "Cafe", spawn: { x: 480, y: 576, dir: "up" }, bounds: { width: 960, height: 720 } },\n  diner: { id: "diner", label: "Diner", spawn: { x: 480, y: 576, dir: "up" }, bounds: { width: 960, height: 720 } },\n  bakery: { id: "bakery", label: "Bakery", spawn: { x: 480, y: 576, dir: "up" }, bounds: { width: 960, height: 720 } },\n  sushi: { id: "sushi", label: "Sushi", spawn: { x: 480, y: 576, dir: "up" }, bounds: { width: 960, height: 720 } },'
);

// 2. Update parseLocation
content = content.replace(
  'if (value === "office" || value === "neighborhood" || value === "city" || isShopLocation(value)) return { id: value, kind: value };',
  'if (["office", "neighborhood", "city", "cafe", "diner", "bakery", "sushi"].includes(value) || isShopLocation(value)) return { id: value, kind: value };'
);

// 3. Update LOCATION_GEOMETRY
const newLocationsGeometry = `  cafe: {
    blockers: [
      { x: 0, y: 0, width: 960, height: 48 }, { x: 0, y: 0, width: 48, height: 720 }, { x: 912, y: 0, width: 48, height: 720 },
      { x: 0, y: 672, width: 408, height: 48 }, { x: 552, y: 672, width: 408, height: 48 },
      { x: 200, y: 150, width: 560, height: 80 }, { x: 200, y: 350, width: 100, height: 150 }, { x: 660, y: 350, width: 100, height: 150 }
    ],
    doors: [{ destination: "city", x: 408, y: 648, width: 144, height: 72, label: "Plaza exit" }],
    seats: [ { x: 250, y: 250, dir: "up" }, { x: 350, y: 250, dir: "up" }, { x: 450, y: 250, dir: "up" }, { x: 550, y: 250, dir: "up" } ]
  },
  diner: {
    blockers: [
      { x: 0, y: 0, width: 960, height: 48 }, { x: 0, y: 0, width: 48, height: 720 }, { x: 912, y: 0, width: 48, height: 720 },
      { x: 0, y: 672, width: 408, height: 48 }, { x: 552, y: 672, width: 408, height: 48 },
      { x: 100, y: 150, width: 760, height: 60 },
      { x: 100, y: 350, width: 200, height: 100 }, { x: 660, y: 350, width: 200, height: 100 },
      { x: 100, y: 500, width: 200, height: 100 }, { x: 660, y: 500, width: 200, height: 100 }
    ],
    doors: [{ destination: "city", x: 408, y: 648, width: 144, height: 72, label: "Plaza exit" }],
    seats: [ { x: 150, y: 460, dir: "left" }, { x: 710, y: 460, dir: "right" } ]
  },
  bakery: {
    blockers: [
      { x: 0, y: 0, width: 960, height: 48 }, { x: 0, y: 0, width: 48, height: 720 }, { x: 912, y: 0, width: 48, height: 720 },
      { x: 0, y: 672, width: 408, height: 48 }, { x: 552, y: 672, width: 408, height: 48 },
      { x: 250, y: 200, width: 460, height: 100 },
      { x: 250, y: 400, width: 150, height: 60 }, { x: 560, y: 400, width: 150, height: 60 }
    ],
    doors: [{ destination: "city", x: 408, y: 648, width: 144, height: 72, label: "Plaza exit" }],
    seats: []
  },
  sushi: {
    blockers: [
      { x: 0, y: 0, width: 960, height: 48 }, { x: 0, y: 0, width: 48, height: 720 }, { x: 912, y: 0, width: 48, height: 720 },
      { x: 0, y: 672, width: 408, height: 48 }, { x: 552, y: 672, width: 408, height: 48 },
      { x: 200, y: 200, width: 560, height: 120 }, { x: 200, y: 450, width: 120, height: 120 }, { x: 640, y: 450, width: 120, height: 120 }
    ],
    doors: [{ destination: "city", x: 408, y: 648, width: 144, height: 72, label: "Plaza exit" }],
    seats: [ { x: 250, y: 350, dir: "up" }, { x: 480, y: 350, dir: "up" }, { x: 710, y: 350, dir: "up" } ]
  },`;

content = content.replace(
  '  "decor-shop": {',
  newLocationsGeometry + '\n  "decor-shop": {'
);

const cityBlockersInjection = `      // Cafe
      { x: 178, y: 950, width: 224, height: 122 }, { x: 178, y: 1072, width: 76, height: 100 }, { x: 326, y: 1072, width: 76, height: 100 },
      // Diner
      { x: 760, y: 950, width: 224, height: 122 }, { x: 760, y: 1072, width: 76, height: 100 }, { x: 908, y: 1072, width: 76, height: 100 },
      // Bakery
      { x: 178, y: 1250, width: 224, height: 122 }, { x: 178, y: 1372, width: 76, height: 100 }, { x: 326, y: 1372, width: 76, height: 100 },
      // Sushi
      { x: 760, y: 1250, width: 224, height: 122 }, { x: 760, y: 1372, width: 76, height: 100 }, { x: 908, y: 1372, width: 76, height: 100 },`;
content = content.replace(
  '{ x: 908, y: 744, width: 76, height: 100 },',
  '{ x: 908, y: 744, width: 76, height: 100 },\n' + cityBlockersInjection
);

const cityDoorsInjection = `      { destination: "cafe", x: 254, y: 1080, width: 72, height: 100, label: "Cafe" },
      { destination: "diner", x: 836, y: 1080, width: 72, height: 100, label: "Diner" },
      { destination: "bakery", x: 254, y: 1380, width: 72, height: 100, label: "Bakery" },
      { destination: "sushi", x: 836, y: 1380, width: 72, height: 100, label: "Sushi" },`;
content = content.replace(
  '{ destination: "decor-shop", x: 836, y: 752, width: 72, height: 100, label: "Plaza Decor" },',
  '{ destination: "decor-shop", x: 836, y: 752, width: 72, height: 100, label: "Plaza Decor" },\n' + cityDoorsInjection
);

// 4. Update LOCATION_PORTALS
const returnPortalsInjection = `  cafe: [{ destination: "city", x: 408, y: 648, width: 144, height: 72, spawn: { x: 290, y: 1190, dir: "down" } }],
  diner: [{ destination: "city", x: 408, y: 648, width: 144, height: 72, spawn: { x: 872, y: 1190, dir: "down" } }],
  bakery: [{ destination: "city", x: 408, y: 648, width: 144, height: 72, spawn: { x: 290, y: 1490, dir: "down" } }],
  sushi: [{ destination: "city", x: 408, y: 648, width: 144, height: 72, spawn: { x: 872, y: 1490, dir: "down" } }],`;
content = content.replace(
  '  "decor-shop": [{ destination: "city", x: 408, y: 648, width: 144, height: 72, spawn: { x: 872, y: 880, dir: "down" } }],',
  '  "decor-shop": [{ destination: "city", x: 408, y: 648, width: 144, height: 72, spawn: { x: 872, y: 880, dir: "down" } }],\n' + returnPortalsInjection
);

const cityPortalsInjection = `    { destination: "cafe", x: 254, y: 1080, width: 72, height: 100, spawn: { x: 480, y: 576, dir: "up" } },
    { destination: "diner", x: 836, y: 1080, width: 72, height: 100, spawn: { x: 480, y: 576, dir: "up" } },
    { destination: "bakery", x: 254, y: 1380, width: 72, height: 100, spawn: { x: 480, y: 576, dir: "up" } },
    { destination: "sushi", x: 836, y: 1380, width: 72, height: 100, spawn: { x: 480, y: 576, dir: "up" } },`;
content = content.replace(
  '    { destination: "decor-shop", x: 836, y: 752, width: 72, height: 100, spawn: { x: 480, y: 576, dir: "up" } },',
  '    { destination: "decor-shop", x: 836, y: 752, width: 72, height: 100, spawn: { x: 480, y: 576, dir: "up" } },\n' + cityPortalsInjection
);

fs.writeFileSync('artifacts/jpo-huddle/neighborhood.mjs', content);
