const { execSync } = require('child_process');
const fs = require('fs');
const dir = process.argv[2], out = process.argv[3];
fs.mkdirSync(out, { recursive: true });
const dims = [];
for (let i = 0; i < 5; i++) {
  execSync(`magick ${dir}/b${i}.png -trim +repage ${out}/_uni_${i}.png`);
  const [w, h] = execSync(`magick ${out}/_uni_${i}.png -format "%w %h" info:`).toString().trim().split(' ').map(Number);
  dims.push([w, h]);
}
const maxDim = Math.max(...dims.flat());
const f = 60 / maxDim;
for (let i = 0; i < 5; i++) {
  const [w, h] = dims[i];
  execSync(`magick ${out}/_uni_${i}.png -resize ${Math.max(1,Math.round(w*f))}x${Math.max(1,Math.round(h*f))}! -background none -gravity south -extent 64x64 ${out}/g${i}.png`);
  fs.unlinkSync(`${out}/_uni_${i}.png`);
}
console.log('maxDim', maxDim, 'factor', f.toFixed(3), dims.map(d=>d.join('x')).join(' '));
