const fs = require('fs'), { PNG } = require(require('path').join(__dirname, 'node_modules/pngjs'));
const img = PNG.sync.read(fs.readFileSync(process.argv[2]));
const { width: W, height: H, data: D } = img;
const seen = new Uint8Array(W * H);
const st = [];
for (let x = 0; x < W; x++) { st.push(x, (H - 1) * W + x); }
for (let y = 0; y < H; y++) { st.push(y * W, y * W + W - 1); }
while (st.length) {
  const p = st.pop();
  if (seen[p] || D[p * 4 + 3] >= 20) continue;
  seen[p] = 1;
  const x = p % W, y = (p / W) | 0;
  if (x > 0) st.push(p - 1);
  if (x < W - 1) st.push(p + 1);
  if (y > 0) st.push(p - W);
  if (y < H - 1) st.push(p + W);
}
let fixed = 0;
for (let i = 0; i < W * H; i++)
  if (D[i * 4 + 3] < 20 && !seen[i]) { D[i * 4 + 3] = 255; fixed++; }
fs.writeFileSync(process.argv[3], PNG.sync.write(img));
console.log('holes filled px:', fixed);
