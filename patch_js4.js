const fs = require('fs');
let html = fs.readFileSync('artifacts/jpo-huddle/public/index.html', 'utf8');

html = html.replace("socket.on('petBattlePickStatus', (payload) => {", 
"socket.on('petBattlePickStatus', (payload) => {\n       if (payload.matchId !== pbMatchId) return;\n       pbAnimQueue.push(async () => {\n");
html = html.replace("       pbRenderSide('pb-cha', payload.you);\n       pbRenderSide('pb-opp', payload.foe);\n    });", 
"       pbRenderSide('pb-cha', payload.you);\n       pbRenderSide('pb-opp', payload.foe);\n       });\n       pbProcessQueue();\n    });");

// Also remove the old `if (payload.matchId !== pbMatchId) return;` because we injected it twice basically.
html = html.replace("       if (payload.matchId !== pbMatchId) return;\n       if (payload.matchId !== pbMatchId) return;", "       if (payload.matchId !== pbMatchId) return;");

fs.writeFileSync('artifacts/jpo-huddle/public/index.html', html);
