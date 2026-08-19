const fs = require('fs');
let html = fs.readFileSync('artifacts/jpo-huddle/public/index.html', 'utf8');

html = html.replace("pbEl('pt-pet-name').textContent = _petLabel(pet);", 
"const cPet = PETS.find(p => p.id === pet); pbEl('pt-pet-name').textContent = cPet ? \`\${cPet.species} — \${cPet.name}\` : pet;");

fs.writeFileSync('artifacts/jpo-huddle/public/index.html', html);
