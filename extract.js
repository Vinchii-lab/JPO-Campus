const fs = require('fs');
const html = fs.readFileSync('artifacts/jpo-huddle/public/index.html', 'utf8');
const scripts = html.match(/<script>(.*?)<\/script>/gs);
if (scripts) {
  const lastScript = scripts[scripts.length - 1];
  fs.writeFileSync('temp.js', lastScript.replace(/<\/?script>/g, ''));
}
