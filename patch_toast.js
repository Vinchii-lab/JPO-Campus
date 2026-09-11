const fs = require('fs');
let code = fs.readFileSync('artifacts/jpo-huddle/public/neighborhood.js', 'utf8');

// Ensure that success or failure is clearly shown and panel can be refreshed
code = code.replace(/socket\.on\('homePurchaseResult', \(d\) => \{ \n    if \(d\?\.home\) \{ homeState = d\.home; renderHome\(\); \} \n    if \(d\?\.message\) getGlobals\(\)\.showToast\(d\.message\); \n  \}\);/, `socket.on('homePurchaseResult', (d) => { 
    if (d?.home) { homeState = d.home; if (currentLocation.startsWith('home:')) renderHome(); } 
    if (d?.message) getGlobals().showToast(d.message); 
  });`);

fs.writeFileSync('artifacts/jpo-huddle/public/neighborhood.js', code);
