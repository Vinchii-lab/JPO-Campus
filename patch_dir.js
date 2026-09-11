const fs = require('fs');
let code = fs.readFileSync('artifacts/jpo-huddle/public/neighborhood.js', 'utf8');

const oldDirBind = `    homePanel.querySelectorAll('[data-visit]').forEach(b => b.onclick = () => travel('home:' + b.dataset.visit));`;
const newDirBind = `    homePanel.querySelectorAll('[data-visit]').forEach(b => b.onclick = () => travel('home:' + b.dataset.visit));
    homePanel.querySelector('[data-refresh-dir]')?.addEventListener('click', () => socket.emit('homeDirectoryRequest'));`;

code = code.replace(oldDirBind, newDirBind);

const oldDirCard = `    const dirCard = dirList.length ? '<div><small>Visit Coworkers:</small>' + dirList.map(h => '<button data-visit="' + esc(h.ownerEmail) + '">' + esc(h.name || h.ownerEmail) + ' (' + esc(h.accessMode) + ')</button>').join('') + '</div><br>' : '';`;
const newDirCard = `    const dirCard = '<div class="home-section" style="max-height: 150px; overflow-y: auto"><small style="display:flex; justify-content:space-between">Visit Coworkers <button data-refresh-dir style="padding:2px 6px">Refresh</button></small>' + 
       (dirList.length ? dirList.map(h => '<span class="home-item" style="cursor:pointer" data-visit="' + esc(h.ownerEmail) + '">' + esc(h.name || h.ownerEmail) + ' <span style="opacity:0.5; font-size:10px">(' + esc(h.accessMode) + ')</span></span>').join('') : '<small>No homes available</small>') + 
       '</div>';`;
code = code.replace(oldDirCard, newDirCard);

fs.writeFileSync('artifacts/jpo-huddle/public/neighborhood.js', code);
