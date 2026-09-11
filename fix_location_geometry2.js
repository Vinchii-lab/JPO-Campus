const fs = require('fs');
let content = fs.readFileSync('artifacts/jpo-huddle/neighborhood.mjs', 'utf8');

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

fs.writeFileSync('artifacts/jpo-huddle/neighborhood.mjs', content);
