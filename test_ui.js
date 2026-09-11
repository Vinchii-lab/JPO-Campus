const fs = require('fs');
let code = fs.readFileSync('artifacts/jpo-huddle/public/neighborhood.js', 'utf8');
code = code.replace(/renderHome\(\);\n  \}\n\n  socket\.on\('homeSnapshot'/, "renderHome(); renderShop();\n  }\n\n  socket.on('homeSnapshot'");
fs.writeFileSync('artifacts/jpo-huddle/public/neighborhood.js', code);
