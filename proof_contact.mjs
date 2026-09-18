import fs from 'fs';
import path from 'path';

const SRC = "/tmp/sprites/1_Interiors/16x16/Theme_Sorter_Singles";
const proofList = [
  { name: "museum_bench", file: "22_Museum_Singles/Museum_Singles_5.png" },
  { name: "diner_burger", file: "12_Kitchen_Singles/Kitchen_Singles_167.png" },
  { name: "sushi_plate", file: "20_Japanese_Interiors_Singles/Japanese_Interiors_Singles_74.png" },
  { name: "shop_cash_register", file: "16_Grocery_Store_Singles/Grocery_Store_Singles_125.png" },
  { name: "museum_door", file: "22_Museum_Singles/Museum_Singles_1.png" }
];

let html = "<html><body><style>body{background:#333;color:#fff} .item{display:inline-block; margin:20px; text-align:center; font-size:14px; border: 1px solid #555; padding: 10px;} img{image-rendering:pixelated; transform:scale(3); transform-origin: top center; margin-bottom: 30px;}</style><h1>Proof of Selected Assets</h1>";

proofList.forEach(item => {
  const dir = path.join(SRC, path.dirname(item.file));
  const file = path.basename(item.file);
  html += `<div class="item"><h3>${item.name}</h3><img src="../contact/${path.dirname(item.file)}/${file}" /><br>${item.file}</div>`;
});

html += "</body></html>";
fs.writeFileSync("/home/runner/workspace/artifacts/jpo-huddle/public/contact/proof.html", html);
