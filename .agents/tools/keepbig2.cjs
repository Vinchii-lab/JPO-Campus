const fs = require('fs'), { PNG } = require(require('path').join(__dirname, 'node_modules/pngjs'));
const img = PNG.sync.read(fs.readFileSync(process.argv[2]));
const R = +(process.argv[4] || 4);
const { width: W, height: H, data: D } = img;
const solid = new Uint8Array(W * H);
for (let i = 0; i < W * H; i++) solid[i] = D[i * 4 + 3] >= 20 ? 1 : 0;
const dil = new Uint8Array(W * H);
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
  if (!solid[y * W + x]) continue;
  for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) {
    const nx = x + dx, ny = y + dy;
    if (nx >= 0 && ny >= 0 && nx < W && ny < H) dil[ny * W + nx] = 1;
  }
}
const lab = new Int32Array(W * H).fill(-1);
let best = -1, bestN = 0, cur = 0;
for (let i = 0; i < W * H; i++) {
  if (!dil[i] || lab[i] >= 0) continue;
  let n = 0; const st = [i]; lab[i] = cur;
  while (st.length) {
    const p = st.pop(); if (solid[p]) n++;
    const x = p % W, y = (p / W) | 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      const q = ny * W + nx;
      if (lab[q] < 0 && dil[q]) { lab[q] = cur; st.push(q); }
    }
  }
  if (n > bestN) { bestN = n; best = cur; }
  cur++;
}
for (let i = 0; i < W * H; i++) if (!solid[i] || lab[i] !== best) D[i * 4 + 3] = 0;
fs.writeFileSync(process.argv[3], PNG.sync.write(img));
console.log('kept px:', bestN);
