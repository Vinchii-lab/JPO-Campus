const fs = require('fs');
let code = fs.readFileSync('artifacts/jpo-huddle/public/neighborhood.js', 'utf8');

// The UI should request the directory as soon as it initializes so it's ready.
const initPatch = `
  const title = document.getElementById('neighborhood-title');
  const homePanel = document.getElementById('home-panel');
  let homeState = null;
  let furnitureCatalog = {};
  let selectedInstance = null;
  let selectedRotation = 0;
  let currentLocation = 'office';
  
  socket.emit('homeDirectoryRequest');
`;
code = code.replace(/  const title = document.getElementById\('neighborhood-title'\);[\s\S]*?let currentLocation = 'office';/, initPatch);
fs.writeFileSync('artifacts/jpo-huddle/public/neighborhood.js', code);
