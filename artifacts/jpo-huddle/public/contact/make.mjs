import fs from 'fs';
import path from 'path';

const SRC = "/tmp/sprites/1_Interiors/16x16/Theme_Sorter_Singles";
const folders = ["22_Museum_Singles", "12_Kitchen_Singles", "24_Ice_Cream_Shop_Singles", "16_Grocery_Store_Singles", "20_Japanese_Interiors_Singles", "2_Living_Room_Singles", "21_Clothing_Store_Singles"];

let html = "<html><body><style>body{background:#333;color:#fff} .item{display:inline-block; margin:5px; text-align:center; font-size:10px; border: 1px solid #555;} img{image-rendering:pixelated; transform:scale(2); transform-origin: top left; margin: 16px;}</style>";

folders.forEach(f => {
  const dir = path.join(SRC, f);
  if(!fs.existsSync(dir)) return;
  html += `<h2 id="${f}">${f}</h2>`;
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.png'));
  files.sort((a,b) => {
    const numA = parseInt(a.match(/_(\d+)\.png/)[1]);
    const numB = parseInt(b.match(/_(\d+)\.png/)[1]);
    return numA - numB;
  });
  files.forEach(file => {
    html += `<div class="item"><img src="${f}/${file}" /><br>${file}</div>`;
  });
});

html += "</body></html>";
fs.writeFileSync(path.join("/home/runner/workspace/artifacts/jpo-huddle/public/contact", "index.html"), html);
