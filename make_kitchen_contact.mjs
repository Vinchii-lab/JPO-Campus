import fs from 'fs';
import path from 'path';
const dir = "/tmp/sprites/1_Interiors/16x16/Theme_Sorter_Singles/12_Kitchen_Singles";
let html = "<html><body><style>body{background:#333;color:#fff} .item{display:inline-block; margin:20px; text-align:center; font-size:14px; border: 1px solid #555; padding: 10px;} img{image-rendering:pixelated; transform:scale(3); transform-origin: top center; margin-bottom: 30px;}</style><h1>Kitchen Singles</h1>";
fs.readdirSync(dir).filter(f => f.endsWith('.png')).sort((a,b) => parseInt(a.match(/_(\d+)/)[1]) - parseInt(b.match(/_(\d+)/)[1])).forEach(file => {
  html += `<div class="item"><h3>${file}</h3><img src="../contact/12_Kitchen_Singles/${file}" /></div>`;
});
html += "</body></html>";
fs.writeFileSync("/home/runner/workspace/artifacts/jpo-huddle/public/contact/kitchen.html", html);
