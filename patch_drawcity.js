const fs = require('fs');
let content = fs.readFileSync('artifacts/jpo-huddle/public/neighborhood.js', 'utf8');

// Update _drawCity
let drawCityStart = content.indexOf('_drawCity() {');
let drawCityEnd = content.indexOf('}', drawCityStart + 3000); // approximate end of method
let drawCityCode = content.substring(drawCityStart, drawCityEnd + 1);

let newDrawCityCode = drawCityCode
  .replace(/this\._path\(\{ x: 456, y: 0, width: 240, height: 912 \}, 0x535e66, 0x3e4750\);/, "this._path({ x: 456, y: 0, width: 240, height: 1600 }, 0x535e66, 0x3e4750);")
  .replace(/this\._path\(\{ x: 432, y: 0, width: 24, height: 912 \}\);/, "this._path({ x: 432, y: 0, width: 24, height: 1600 });")
  .replace(/this\._path\(\{ x: 696, y: 0, width: 24, height: 912 \}\);/, "this._path({ x: 696, y: 0, width: 24, height: 1600 });")
  .replace(/this\._path\(\{ x: 836, y: 852, width: 72, height: 36 \}\);/, "this._path({ x: 836, y: 852, width: 72, height: 36 });\n      this._path({ x: 254, y: 1180, width: 72, height: 36 });\n      this._path({ x: 836, y: 1180, width: 72, height: 36 });\n      this._path({ x: 254, y: 1480, width: 72, height: 36 });\n      this._path({ x: 836, y: 1480, width: 72, height: 36 });")
  .replace(/this\._exterior\('shop', 872, 860\);/, "this._exterior('shop', 872, 860);\n      // New food district venues\n      this._exterior('shop', 290, 1188);\n      this._exterior('shop', 872, 1188);\n      this._exterior('shop', 290, 1488);\n      this._exterior('shop', 872, 1488);")
  .replace(/this\._storefrontSign\(872, 604, 'PLAZA DECOR'\);/, "this._storefrontSign(872, 604, 'PLAZA DECOR');\n      this._storefrontSign(290, 932, 'THE DAILY GRIND');\n      this._storefrontSign(872, 932, 'NEON DINER');\n      this._storefrontSign(290, 1232, 'SWEET CRUST BAKERY');\n      this._storefrontSign(872, 1232, 'SAKURA SUSHI');");

content = content.replace(drawCityCode, newDrawCityCode);

fs.writeFileSync('artifacts/jpo-huddle/public/neighborhood.js', content);
