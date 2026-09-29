// Native Halloween pixel art. Run with NODE_PATH=.agents/tools/node_modules
// node artifacts/jpo-huddle/tools/halloween-art-gen.cjs [--preview]
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
function bat(stage, pose) {
  const p=image(64,64);
  const scale=[.63,.79,.94][stage-1];
  // All poses use the same per-stage scale and ground anchor. Never per-frame fit.
  const ox=32, oy=stage===1?48:stage===2?46:43;
  const X=x=>ox+(x-32)*scale, Y=y=>oy+(y-43)*scale;
  const P=pts=>pts.map(([x,y])=>[X(x),Y(y)]);
  const E=(x,y,rx,ry,c)=>ellipse(p,X(x),Y(y),rx*scale,ry*scale,c);
  const L=(x1,y1,x2,y2,c,w=1)=>line(p,X(x1),Y(y1),X(x2),Y(y2),c,w*scale);
  const W=(pts,col)=>poly(p,P(pts),col);
  const seated=pose==='sit', act=pose==='action';
  const flap=pose==='walk1'? -12:pose==='walk2'? 8:pose==='walk3'? 1:pose==='static'? -4:seated? 11:-17;
  // Far wing first, then body, then near wing. Three scallops and vein highlights.
  function wing(xsign,far) {
    const sx=xsign;
    const tipY=22+flap+(far?3:0);
    const coords=[[32,39],[32+sx*12,35],[32+sx*29,tipY],[32+sx*25,tipY+14],
      [32+sx*29,tipY+18],[32+sx*22,tipY+26],[32+sx*16,tipY+20],
      [32+sx*12,tipY+28],[32+sx*7,tipY+23],[32,46]];
    W(coords,'outline');
    W([[32+sx*2,39],[32+sx*12,36],[32+sx*27,tipY+4],[32+sx*23,tipY+15],
      [32+sx*26,tipY+18],[32+sx*21,tipY+22],[32+sx*16,tipY+18],
      [32+sx*12,tipY+24],[32+sx*8,tipY+20],[32+sx*3,44]],far?'wing':'membrane');
    L(32,39,32+sx*28,tipY+2,far?'edge':'rib',1.4);
    L(32+sx*15,34,32+sx*21,tipY+21,'edge');
    L(32+sx*15,34,32+sx*12,tipY+24,'edge');
    E(32+sx*29,tipY,2,2,stage===3?'glowLight':'ivory');
  }
  wing(-1,true);
  if(stage===3) {
    // Spectral violet flame curling around the grown silhouette.
    W([[13,53],[8,48],[11,43],[7,37],[13,40],[12,31],[16,35],[18,47]],'glow');
    W([[51,53],[56,46],[54,39],[59,36],[52,34],[50,43],[46,49]],'glow');
    E(10,52,2,2,'glowLight'); E(55,48,2,2,'glowLight');
  }
  E(32,46,12,12,'outline'); E(31,45,10,10,stage===3?'plum':'edge');
  E(27,42,5,6,'light'); E(34,49,6,5,'plum');
  // Tiny dangling feet visibly separate from the tail/body.
  for(const dx of [-5,5]){
    E(32+dx,56,3,4,'outline'); E(31+dx,55,1.4,2,'light');
    L(30+dx,59,28+dx,61,'ivory');
  }
  // Baby has a rounder face; elder has a fur ruff and more angular eyebrows.
  if(stage===3) {
    for(let i=0;i<5;i++) W([[19+i*5,44],[17+i*5,52],[23+i*5,47]],'light');
  }
  W([[18,34],[17,15],[24,21],[30,32]],'outline');
  W([[20,31],[20,19],[24,23],[27,33]],'membrane');
  W([[41,33],[46,14],[51,24],[47,40]],'outline');
  W([[43,32],[46,20],[49,25],[47,34]],'membrane');
  L(21,21,22,29,'rib'); L(47,21,47,29,'rib');
  E(34,38,16,14,'outline'); E(34,37,14,12,'plum');
  E(29,35,9,7,'light'); E(35,42,11,5,'edge');
  wing(1,false);
  // A wing overlays only the far cheek; redraw the face for clear expression.
  E(37,39,11,9,'plum');
  if(stage===1){E(27,38,5,5,'outline');E(27,38,3,3,'amber');E(42,38,5,5,'outline');E(42,38,3,3,'amber');}
  else {E(28,38,5,4,'outline');E(28,38,3,2.6,'amber');E(42,38,5,4,'outline');E(42,38,3,2.6,'amber');}
  E(28,37,1,1,'cream'); E(42,37,1,1,'cream');
  E(36,43,2,1.5,'nose');
  L(35,46,41,47,'outline',2);
  E(41,46,1,1,'ivory');
  if(act){
    // Action: delighted sonar chirp and a pair of magic glyphs.
    E(55,32,2.5,2.5,'glow'); E(57,25,1.5,1.5,'glowLight');
    L(51,34,56,30,'glowLight',1);
  }
  if(stage===3) for(const [x,y] of [[8,32],[58,37],[47,13],[17,18]]) E(x,y,1.5,1.5,'glowLight');
  if(seated){E(28,56,4,2,'plum');E(38,56,4,2,'plum');}
  return p;
}
const stages=[1,2,3];
const poses=['static','walk1','walk2','walk3','sit','action'];
const stamps=stages.map(stage=>poses.map(pose=>bat(stage,pose)));
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