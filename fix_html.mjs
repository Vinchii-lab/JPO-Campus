import fs from 'fs';
let html = fs.readFileSync("/home/runner/workspace/artifacts/jpo-huddle/public/contact/kitchen.html", "utf8");
html = html.replace(/\.\.\/contact/g, ".");
fs.writeFileSync("/home/runner/workspace/artifacts/jpo-huddle/public/contact/kitchen.html", html);
