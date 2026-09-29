// Native Halloween pixel art. Run with NODE_PATH=.agents/tools/node_modules
// node artifacts/jpo-huddle/tools/halloween-art-gen.cjs [--preview|--bat-only]
// Preview only writes design/halloween-bat-preview.png; full run writes the game art.
const fs = require('fs');
const path = require('path');
const { PNG } = require('pngjs');
const ROOT = path.resolve(__dirname, '../public/assets');
const previewOnly = process.argv.includes('--preview');
const C = {
  outline: '#20152f', edge: '#41244e', plum: '#47305f', light: '#695183',
  violet: '#946db1', wing: '#372139', membrane: '#703c61', rib: '#a15b83',
  glow: '#9b57e2', glowLight: '#d49aff', amber: '#ffb638', cream: '#ffe69b',
  ivory: '#ece3dc', nose: '#d994a9', soot: '#292537',
};
const parse = hex => [1, 3, 5].map(i => parseInt(hex.slice(i, i+2), 16));
const image = (w, h) => new PNG({ width: w, height: h });
function pixel(p, x, y, color, alpha = 255) {
  x = Math.round(x); y = Math.round(y);
  if (x < 0 || y < 0 || x >= p.width || y >= p.height) return;
  const i = (y*p.width+x)*4, c = parse(C[color] || P[color] || color);
  p.data[i] = c[0]; p.data[i+1] = c[1]; p.data[i+2] = c[2]; p.data[i+3] = alpha;
}
function ellipse(p,cx,cy,rx,ry,color,alpha=255) {
  for(let y=Math.floor(cy-ry);y<=Math.ceil(cy+ry);y++)
    for(let x=Math.floor(cx-rx);x<=Math.ceil(cx+rx);x++)
      if (((x-cx)/rx)**2+((y-cy)/ry)**2<=1) pixel(p,x,y,color,alpha);
}
function poly(p, pts, color, alpha=255) {
  const minX=Math.floor(Math.min(...pts.map(a=>a[0]))),maxX=Math.ceil(Math.max(...pts.map(a=>a[0])));
  const minY=Math.floor(Math.min(...pts.map(a=>a[1]))),maxY=Math.ceil(Math.max(...pts.map(a=>a[1])));
  for(let y=minY;y<=maxY;y++)for(let x=minX;x<=maxX;x++){
    let inside=false;
    for(let i=0,j=pts.length-1;i<pts.length;j=i++){
      const a=pts[i],b=pts[j];
      if ((a[1]>y+0.5)!==(b[1]>y+0.5) && x+0.5<(b[0]-a[0])*(y+0.5-a[1])/(b[1]-a[1])+a[0]) inside=!inside;
    }
    if(inside) pixel(p,x,y,color,alpha);
  }
}
function line(p,x1,y1,x2,y2,color,width=1) {
  const n=Math.max(Math.abs(x2-x1),Math.abs(y2-y1))*2;
  for(let i=0;i<=n;i++) ellipse(p,x1+(x2-x1)*i/n,y1+(y2-y1)*i/n,Math.max(.55,width/2),Math.max(.55,width/2),color);
}
// Keep the generated source: the three rows have genuinely different anatomy,
// not one procedural face scaled up. Explicit crops avoid wide-wing tile bleed.
const { execFileSync } = require('child_process');
const source = path.resolve(__dirname, '../../../attached_assets/generated_images/bat_evolution_native_sheet.png');
const sheet = PNG.sync.read(fs.readFileSync(source));
// Key the warm cream only; purple highlights and white teeth remain intact.
for(let i=0;i<sheet.data.length;i+=4){
  const [r,g,b]=sheet.data.subarray(i,i+3);
  if(r>218 && g>208 && b>175 && r>=g && g-b>8 && r-g<26) sheet.data[i+3]=0;
}
const boxes = [
  [[12,135,170,150],[202,110,140,180],[342,178,160,134],[508,174,216,116],[728,148,112,164],[862,146,157,155]],
  [[2,404,178,183],[208,344,136,242],[329,445,174,163],[498,441,236,150],[732,408,120,200],[866,395,155,211]],
  [[0,695,186,231],[200,645,142,276],[328,748,173,195],[500,731,242,193],[731,696,128,244],[860,679,162,261]],
];
function batRow(stage) {
  const crops=boxes[stage-1].map(([x,y,w,h],pose)=>{
    const p=image(w,h);
    for(let j=0;j<h;j++) sheet.data.copy(p.data,j*w*4,((y+j)*sheet.width+x)*4,((y+j)*sheet.width+x+w)*4);
    // Neighboring elder wisps cross rectangular cell bounds. Remove only
    // their known empty-air regions, never a wing or this pose's own magic.
    if(stage===3) for(let j=0;j<h;j++) for(let i=0;i<w;i++){
      if((pose===2 && x+i<350 && y+j<886) || (pose===3 && x+i>734))
        p.data[(j*w+i)*4+3]=0;
    }
    return PNG.sync.read(execFileSync('magick',['png:-','-trim','+repage','png:-'],{input:PNG.sync.write(p)}));
  });
  const factor=[44,53,60][stage-1]/Math.max(...crops.map(p=>Math.max(p.width,p.height)));
  return crops.map(p=>PNG.sync.read(execFileSync('magick',[
    'png:-','-filter','Lanczos','-resize',`${factor*100}%`,
    '-gravity','south','-background','none','-extent','64x64','png:-'
  ],{input:PNG.sync.write(p)})));
}
const stages=[1,2,3];
const poses=['static','walk1','walk2','walk3','sit','action'];
// Runtime cycles walk1, walk2, walk3, walk2: up → level → down → level.
const stamps=stages.map(stage=>{
  const row=batRow(stage);
  return [row[0],row[1],row[3],row[2],row[4],row[5]];
});
function save(name,p){fs.mkdirSync(path.dirname(name),{recursive:true});fs.writeFileSync(name,PNG.sync.write(p));}
function makePreview(){
  const p=image(64*6,64*3);
  stamps.forEach((row,j)=>row.forEach((src,i)=>{
    for(let y=0;y<64;y++)for(let x=0;x<64;x++){
      const a=(y*64+x)*4, b=((j*64+y)*p.width+i*64+x)*4;
      src.data.copy(p.data,b,a,a+4);
    }
  }));
  save(path.resolve(__dirname,'../design/halloween-bat-preview.png'),p);
}
makePreview();
if(previewOnly){ console.log('Compact 3-stage / 6-pose preview: design/halloween-bat-preview.png'); process.exit(0); }
stages.forEach((stage,j)=>poses.forEach((pose,k)=>{
  const stem=stage===1?'pet_bat':`pet_bat_s${stage}`;
  const dest=pose==='static'?`pets/${stem}.png`:`pets/anim/${stem.replace(/^pet_/, '')}_${pose}.png`;
  const previous=path.join(ROOT,`pets/anim/${stem}_${pose}.png`);
  if(pose!=='static' && fs.existsSync(previous))fs.unlinkSync(previous);
  save(path.join(ROOT,dest),stamps[j][k]);
}));
if(process.argv.includes('--bat-only')) {
  console.log('Installed generated bat: 3 distinct stages × 6 transparent 64×64 frames.');
  process.exit(0);
}

// Directional art sheets: front/down, right-facing side, rear/up.
// Navy outline + left-hand highlights match the LimeZu sheets.
const P={O:'#292039',D:'#422456',V:'#692c81',L:'#a057bb',H:'#d292dc',
  B:'#593039',K:'#d59d34',Y:'#ffe095',R:'#a93a41',S:'#e2645e',
  C:'#282631',T:'#68262f',A:'#ed9c33',I:'#ffd36a',G:'#46632e'};
function gridSprite(name,frames) {
  const h=Math.max(...frames.map(f=>f.length)),w=Math.max(...frames.flat().map(r=>r.length));
  const out=image(w*3,h);
  for(let k=0;k<3;k++){
    if(frames[k].length!==h || frames[k].some(row=>row.length<w-2))throw Error(`${name}: invalid frame geometry`);
    frames[k].forEach((row,y)=>[...row.padEnd(w,'.')].forEach((ch,x)=>{
      if(ch!=='.') {
        if(!P[ch])throw Error(`${name}: missing color for ${ch}`);
        pixel(out,k*w+x,y,P[ch]);
      }
    }));
  }
  save(path.join(ROOT,`wear_${name}.png`),out);
  console.log(`wear_${name}: ${w}x${h}, 3 frames, ${out.width}x${h} sheet`);
}
gridSprite('witchhat',[
  ['........H.......','.......HV.......','......HLVV......','......LVVVD.....','.....LVVVDD.....','....LVVVVD.....','.....VVVD......','.....VVDB......','...OOOBBBOOO...','..OVVVKKVVDDO..','.OVVVKYKVVDDDO.','..OOOOOOOOOOOO..','................'],
  ['.........H......','........HV......','.......HLV......','......LVVVD.....','.....LVVVDD.....','......VVVD......','......VVDB......','.....OOOBBOO....','...OOVVKKDDOO...','..OVVVKYKVDDDO..','...OOOOOOOOOO...','................','................'],
  ['........H.......','.......HV.......','......HLVV......','......LVVVD.....','.....LVVVDD.....','....LVVVVD.....','.....VVVD......','.....VVDB......','...OOOBBBOOO...','..OVVVBBVVDDO..','.OVVVBBVVVDDDO.','..OOOOOOOOOOOO..','................']
]);
gridSprite('pumpkinhead',[
  ['......G.........','......G.........','....OOAAOO......','...OAAAAAAO.....','..OIAAAAAADOO...','.OIIAAAAAADDO...','.OIAOAADOOADDO..','.OIAKKAADKKAADO.','.OIAKKADAKKAADO.','.OIAAOOOAAADDO..','..OIAKAKAKADO...','...OOAKAKOOO....','.....OOOO.......'],
  ['......G.........','......G.........','....OOAAOO......','...OAAAAAAO.....','..OIAAAAAADOO...','.OIIAAAAAADDO...','.OIAAAAOOAADDO..','.OIAAAOKKAADDO..','.OIAAAOKKAADDO..','.OIAAOOOAAADDO..','..OIAAKKAKADO...','...OOAKAKOOO....','.....OOOO.......'],
  ['......G.........','......G.........','....OOAAOO......','...OAAAAAAO.....','..OIAAAAAADOO...','.OIIAAAAAADDO...','.OIAAAAAAADDO...','.OIAAAAAAADDO...','.OIAAAAAAADDO...','.OIAAAAAAADDO...','..OIAAAAAADO....','...OOAAAAOO.....','.....OOOO.......']
]);
// Fallback directional cape sheet; the tailored per-character layer below is
// the preferred bake path (body-shaped, extends behind shoulder instead of sticker).
gridSprite('vampirecape',[
  ['.OOSSSSSSSSOO..','..ORRRRRRRRO...','...OTTKTTO.....','...OCCCCCО.....'.replace('О','O'),
    '..OCCCCCCCO....','..OCCCCCCCO....','..OCCCTCCCO....','..OCCCTCCCO....','..OCCCTCCCO....','..OCCCTCCCO....',
    '.OCCTCCTCCCO...','OCCCTCCTCCCO...','OCCOCCOOCCCO...','OOOOOOOOOOOO...'],
  ['...OOSSSSO......','..ORRRRRRO......','..OCTKCCO.......','..OCCCCCO.......','.OCCCTCO........',
    '.OCCCTCO........','OCCCTCO.........','OCCCTCO.........','OCCCTCO.........','OCCCTCO.........',
    'OCCTCO..........','OCCTCO..........','OCCTCO..........','OOOOOO..........'],
  ['.OOSSSSSSSSOO..','..ORRRRRRRRO...','..OSRRKRRRSO...','..ORRRRRRRRO...','..ORRRTRRRO.....',
    '..ORRRTRRRO.....','.ORRRRTRRRRO....','.ORRRRTRRRRO....','.ORRRRTRRRRO....','.ORRRRTRRRRO....',
    'ORRRRTRRRRRRO...','ORRRTTRTRRRRO...','ORROTRTTRORRO...','OOOOOOOOOOOO...']
]);

// Per-frame cape layers sit at the actual shirt/shoulder and are cut to the
// animated silhouette. These have identical canvas dimensions to split layers.
const anchors=JSON.parse(fs.readFileSync(path.join(ROOT,'layers/anchors.json')));
for(const [character,sheets] of Object.entries(anchors)) for(const [suffix,frames] of Object.entries(sheets)){
  const cap=character[0].toUpperCase()+character.slice(1);
  const file=path.join(ROOT,'layers',`${cap}_${suffix}_shirt.png`);
  if(!fs.existsSync(file))continue;
  const shirt=PNG.sync.read(fs.readFileSync(file));
  const out=image(shirt.width,shirt.height);
  const fw=shirt.width/frames.length;
  for(let f=0;f<frames.length;f++){
    const dir=suffix==='run'?['right','up','left','down'][Math.floor(f/6)]:{sit:'right',sit2:'up',sit3:'down'}[suffix];
    const a=frames[f]; if(!a||a.hy<0)continue;
    const shoulderY=Math.min(27,a.hy+10);
    // Material starts at shoulder, flows with torso, and ends ABOVE feet.
    // Back cape displays its red lining; side cape trails opposite motion.
    let pts;
    if(dir==='right') pts=[[a.hx-2,shoulderY],[a.hx-4,shoulderY+1],[a.hx-8,shoulderY+12],[a.hx-13,shoulderY+15],[a.hx-10,shoulderY+15],[a.hx-5,shoulderY+14],[a.hx,shoulderY+7],[a.hx+2,shoulderY+2]];
    else if(dir==='left') pts=[[a.hx+2,shoulderY],[a.hx+4,shoulderY+1],[a.hx+8,shoulderY+12],[a.hx+13,shoulderY+15],[a.hx+10,shoulderY+15],[a.hx+5,shoulderY+14],[a.hx,shoulderY+7],[a.hx-2,shoulderY+2]];
    else pts=[[a.hx-5,shoulderY],[a.hx-3,shoulderY+2],[a.hx+3,shoulderY+2],[a.hx+5,shoulderY],
      [a.hx+7,shoulderY+14],[a.hx+4,shoulderY+13],[a.hx+2,shoulderY+15],[a.hx,shoulderY+13],
      [a.hx-3,shoulderY+15],[a.hx-7,shoulderY+14]];
    // Local temporary frame ensures capes NEVER bleed into adjoining frames.
    const q=image(fw,32);
    poly(q,pts,dir==='up'?'T':'O');
    if(dir==='up'){
      poly(q,pts,'R');
      line(q,a.hx,shoulderY+3,a.hx,shoulderY+12,'T');
    } else {
      const rim=dir==='right'?a.hx-3:dir==='left'?a.hx+3:a.hx;
      line(q,rim,shoulderY+2,rim+(dir==='left'?5:-5),shoulderY+12,'T');
    }
    // A raised velvet collar is visible above the shirt shoulder in every
    // direction.  It wraps the neck rather than floating in front of the face.
    poly(q,[[a.hx-5,shoulderY-2],[a.hx-2,shoulderY-4],[a.hx,shoulderY],
      [a.hx+2,shoulderY-4],[a.hx+5,shoulderY-2],[a.hx+3,shoulderY+2],[a.hx-3,shoulderY+2]],'O');
    line(q,a.hx-4,shoulderY-1,a.hx-2,shoulderY+1,'R');
    line(q,a.hx+4,shoulderY-1,a.hx+2,shoulderY+1,'R');
    ellipse(q,a.hx,shoulderY+2,1.3,1.3,'K');
    for(let y=0;y<32;y++)for(let x=0;x<fw;x++){
      const i=(y*fw+x)*4;
      if(q.data[i+3] && y<=Math.min(31,a.fy-2))q.data.copy(out.data,(y*out.width+f*fw+x)*4,i,i+4);
    }
  }
  save(path.join(ROOT,'layers',`${cap}_${suffix}_wear_vampirecape.png`),out);
}
console.log('Bat 3 stages x 6 frames: transparent 64x64; cape layers: 4 characters x 4 sheets.');