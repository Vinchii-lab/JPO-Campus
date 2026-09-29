// Native Halloween pixel art. Run with NODE_PATH=.agents/tools/node_modules
// node artifacts/jpo-huddle/tools/halloween-art-gen.cjs [--preview|--bat-only|--wear-only]
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
function save(name,p){fs.mkdirSync(path.dirname(name),{recursive:true});fs.writeFileSync(name,PNG.sync.write(p));}
if (!process.argv.includes('--wear-only')) {
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
// Only the wings move: inverse-map one wings-level drawing around fixed
// shoulder roots. Never refit/trim individual flight frames. The entire
// central strip (ears, face, chest and feet) is byte-identical in every frame.
function flap(base, phase) {
  const out=image(64,64);
  for(let y=0;y<64;y++)for(let x=0;x<64;x++){
    const reach=x<27 ? (27-x)/25 : x>44 ? (x-44)/19 : 0;
    const shift=Math.sin(phase)*12*reach;
    const sy=Math.round(y-shift);
    if(sy>=0 && sy<64) {
      const src=(sy*64+x)*4;
      base.data.copy(out.data,(y*64+x)*4,src,src+4);
    }
  }
  return out;
}
const flights=[];
const stamps=stages.map(stage=>{
  const row=batRow(stage);
  // Move the level drawing up 8px to reserve downstroke space, without
  // rescaling it. Rest/action/static retain the approved original drawings.
  const base=image(64,64);
  row[3].data.copy(base.data,0,8*64*4);
  const cycle=Array.from({length:16},(_,i)=>flap(base,i*Math.PI/8));
  flights.push(cycle);
  return [row[0],cycle[12],cycle[0],cycle[4],row[4],row[5]];
});
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
stages.forEach((stage,j)=>flights[j].forEach((frame,i)=>{
  save(path.join(ROOT,`pets/anim/bat${stage===1?'':`_s${stage}`}_flap${i}.png`),frame);
}));
if(process.argv.includes('--bat-only')) {
  console.log('Installed generated bat: 3 distinct stages × 6 transparent 64×64 frames.');
  process.exit(0);
}
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
  ['................','................','................','.......OOO......','......OLVDO.....','.....OLVDD......','.....LVVDD......','....OVVVDDO.....','....OBBKBDO.....','..OOVVVVDDDOO...','.OVVVVVVVDDDDO..','..OOOOOOOOOOOO..','................'],
  ['................','................','................','........OOO.....','.......OLVDO....','......OLVDD.....','......LVVDD.....','.....OVVDDO.....','.....OBBKDO.....','...OOVVVDDOO....','..OVVVVVDDDDO...','...OOOOOOOOOO...','................'],
  ['................','................','................','.......OOO......','......OLVDO.....','.....OLVDD......','.....LVVDD......','....OVVVDDO.....','....OBBBBDO.....','..OOVVVVDDDOO...','.OVVVVVVVDDDDO..','..OOOOOOOOOOOO..','................']
]);
gridSprite('pumpkinhead',[
  ['......G.........','......G.........','....OOAAOO......','...OAAAAAAO.....','..OIAAAAAADOO...','.OIIAAAAAADDO...','.OIAOAADOOADDO..','.OIAKKAADKKAADO.','.OIAKKADAKKAADO.','.OIAAOOOAAADDO..','..OIAKAKAKADO...','...OOAKAKOOO....','.....OOOO.......'],
  ['......G.........','......G.........','....OOAAOO......','...OAAAAAAO.....','..OIAAAAAADOO...','.OIIAAAAAADDO...','.OIAAAAOOAADDO..','.OIAAAOKKAADDO..','.OIAAAOKKAADDO..','.OIAAOOOAAADDO..','..OIAAKKAKADO...','...OOAKAKOOO....','.....OOOO.......'],
  ['......G.........','......G.........','....OOAAOO......','...OAAAAAAO.....','..OIAAAAAADOO...','.OIIAAAAAADDO...','.OIAAAAAAADDO...','.OIAAAAAAADDO...','.OIAAAAAAADDO...','.OIAAAAAAADDO...','..OIAAAAAADO....','...OOAAAAOO.....','.....OOOO.......']
]);
// Fallback directional cape sheet; the tailored per-character layer below is
// the preferred bake path (body-shaped, extends behind shoulder instead of sticker).
gridSprite('vampirecape',[
  ['...OR....RO.....','..OCR....RCO....','..OCR....RCO....','..OC......CO....',
    '..OC......CO....','..OC......CO....','.OCT......TCO...','.OCT......TCO...',
    '.OCT......TCO...','.OCT......TCO...','OCT........TCO..','OCT........TCO..','OCO........OCO..','OO..........OO..'],
  ['...OOSSSSO......','..ORRRRRRO......','..OCTKCCO.......','..OCCCCCO.......','.OCCCTCO........',
    '.OCCCTCO........','OCCCTCO.........','OCCCTCO.........','OCCCTCO.........','OCCCTCO.........',
    'OCCTCO..........','OCCTCO..........','OCCTCO..........','OOOOOO..........'],
  ['...ORRRRRO......','..OCCCCCCCO.....','..OCCCCCCCO.....','..OCCCCCCCO.....','..OCCCTCCCO.....',
    '..OCCCTCCCO.....','.OCCCCTCCCCO....','.OCCCCTCCCCO....','.OCCCCTCCCCO....','.OCCCCTCCCCO....',
    'OCCCCTCTCCCCO...','OCCCCTCTCCCCO...','OCCOTTTTOCCCO...','OOOOOOOOOOOO....']
]);

// Per-frame cape layers sit at the actual shirt/shoulder and are cut to the
// animated silhouette. These have identical canvas dimensions to split layers.
const anchors=JSON.parse(fs.readFileSync(path.join(ROOT,'layers/anchors.json')));
for(const [character,sheets] of Object.entries(anchors)) for(const [suffix,frames] of Object.entries(sheets)){
  const cap=character[0].toUpperCase()+character.slice(1);
  const file=path.join(ROOT,'layers',`${cap}_${suffix}_shirt.png`);
  if(!fs.existsSync(file))continue;
  const shirt=PNG.sync.read(fs.readFileSync(file));
  const load = part => PNG.sync.read(fs.readFileSync(path.join(ROOT,'layers',`${cap}_${suffix}_${part}.png`)));
  const pants=load('pants'), hair=load('hair'), skin=load('skin');
  const base=PNG.sync.read(fs.readFileSync(path.join(ROOT,`${cap}_${suffix}_16x16.png`)));
  const hatSheet=PNG.sync.read(fs.readFileSync(path.join(ROOT,'wear_witchhat.png')));
  const out=image(shirt.width,shirt.height);
  const hats=image(shirt.width,shirt.height);
  const wideCape=image(frames.length*40,32), pumpkins=image(frames.length*40,32);
  const fw=shirt.width/frames.length;
  for(let f=0;f<frames.length;f++){
    const dir=suffix==='run'?['right','up','left','down'][Math.floor(f/6)]:{sit:'right',sit2:'right',sit3:'down'}[suffix];
    const a=frames[f]; if(!a||a.hy<0)continue;
    const alpha=(img,x,y)=>x>=0&&x<fw&&y>=0&&y<32 ? img.data[(y*img.width+f*fw+x)*4+3] : 0;
    const clothing=[];
    for(let y=0;y<32;y++)for(let x=0;x<fw;x++)
      if(alpha(shirt,x,y)||alpha(pants,x,y))clothing.push([x,y]);
    // Some legacy split sheets (Amelia seated) have empty clothing masks.
    // Head/feet bounds remain valid, so never drop either wearable there.
    const shoulderY=Math.min(...clothing.map(p=>p[1]),a.hy+(dir==='up'?14:13));
    const hem=Math.min(a.fy-2,shoulderY+10);
    const cx=clothing.length?Math.round(clothing.reduce((s,p)=>s+p[0],0)/clothing.length):a.hx;
    // 40px pose cells deliberately extend OUTSIDE the body's 16px tiles.
    // Native centre alignment also supports the 32px side-sitting sheets.
    const pad=(40-fw)/2, center=cx+pad, bottom=a.fy-1;
    const shoulder=Math.min(shoulderY,a.hy+14), top=Math.min(shoulder-2,a.hy+9);
    const cape=image(40,32);
    const side=dir==='right'||dir==='left', sign=dir==='left'?1:-1;
    const points=side
      ? [[center+sign*2,top+2],[center+sign*8,top-1],[center+sign*14,bottom-1],
         [center+sign*9,bottom],[center+sign*5,bottom-1],[center+sign*1,bottom-2]]
      : [[center-8,top],[center-5,top+2],[center+5,top+2],[center+8,top],[center+14,bottom-1],
         [center+8,bottom],[center+4,bottom-1],[center,bottom],
         [center-4,bottom-1],[center-8,bottom],[center-14,bottom-1]];
    poly(cape,points,'#24182f');
    poly(cape,points.map(([x,y])=>[x+(x<center?1:-1),y+ (y===top?1:0)]),dir==='down'?'#9d2949':'#49305f');
    if(side){
      line(cape,center+sign*5,top+1,center+sign*11,bottom-2,'#bf3e58',2);
      line(cape,center+sign*3,top+2,center+sign*6,bottom-2,'#765087');
    } else {
      for(const dx of [-4,4]){
        line(cape,center+dx,top+1,center+dx*2.3,bottom-2,dir==='down'?'#e05a6c':'#79518f',2);
        line(cape,center+dx*.7,top+2,center+dx*1.3,bottom-2,'#35213f');
      }
    }
    for(let y=0;y<32;y++)for(let x=0;x<40;x++){
      const local=x-pad, i=(y*40+x)*4;
      // Mask to real anatomy: front torso/arms stay unobstructed. The back
      // drape covers clothing but never the head or hands.
      if((dir!=='up' && alpha(base,local,y)) ||
        (dir==='up' && (alpha(hair,local,y)||alpha(skin,local,y)))) cape.data[i+3]=0;
    }
    // Full replacement HEAD: head bounds include every hair pixel above the
    // shoulders (including a rain hood), not the old 13-row face sticker.
    let minX=fw,maxX=0;
    for(let y=a.hy;y<=shoulder;y++)for(let x=0;x<fw;x++)
      if(alpha(hair,x,y)||alpha(skin,x,y)){minX=Math.min(minX,x);maxX=Math.max(maxX,x);}
    const head=image(40,32), hc=pad+(minX+maxX)/2;
    const ht=Math.max(2,a.hy-1), hb=Math.min(shoulder+1,27);
    const ry=(hb-ht)/2, cy=(hb+ht)/2, rx=Math.max(9,(maxX-minX)/2+2);
    ellipse(head,hc,cy,rx,ry,'#66302a');
    ellipse(head,hc,cy,rx-1,ry-1,'#d86120');
    ellipse(head,hc-2,cy-.5,rx-3,ry-1.5,'#f58a27');
    for(const dx of [-.65,-.25,.3,.68]){
      for(let y=ht+2;y<hb-1;y++){
        const width=Math.sqrt(Math.max(0,1-((y-cy)/ry)**2))*rx;
        pixel(head,hc+dx*width,y,dx<0?'#ffac3e':'#b94a20');
      }
    }
    line(head,hc,ht,hc+1,ht-2,'#42612d',2);
    poly(head,[[hc+1,ht-1],[hc+5,ht-2],[hc+4,ht+1],[hc+1,ht+1]],'#6d943b');
    if(dir!=='up'){
      const eyeY=Math.round(cy-1), face=side?hc+sign*-3:hc;
      if(!side) poly(head,[[face-6,eyeY+2],[face-3,eyeY-2],[face-1,eyeY+2]],'#482333');
      poly(head,[[face+1,eyeY+2],[face+3,eyeY-2],[face+5,eyeY+2]],'#482333');
      if(!side)pixel(head,face-3,eyeY+1,'#ffd36a');
      pixel(head,face+3,eyeY+1,'#ffd36a');
      poly(head,[[face-5,eyeY+4],[face,eyeY+5],[face+5,eyeY+3],[face+3,eyeY+7],[face-3,eyeY+7]],'#482333');
      for(const dx of [-2,1,3])pixel(head,face+dx,eyeY+5,'#ffd36a');
    }
    for(let y=0;y<32;y++){
      cape.data.copy(wideCape.data,(y*wideCape.width+f*40)*4,y*40*4,(y+1)*40*4);
      head.data.copy(pumpkins.data,(y*pumpkins.width+f*40)*4,y*40*4,(y+1)*40*4);
    }
    // Material starts at shoulder, flows with torso, and ends ABOVE feet.
    // Charcoal outer cloth; only the narrow inner side edge shows crimson.
    let pts;
    if(dir==='right') pts=[[cx-1,shoulderY],[cx-5,shoulderY],[cx-8,hem],[cx-3,hem-1],[cx+1,shoulderY+2]];
    else if(dir==='left') pts=[[cx+1,shoulderY],[cx+5,shoulderY],[cx+8,hem],[cx+3,hem-1],[cx-1,shoulderY+2]];
    else pts=[[cx-4,shoulderY],[cx+4,shoulderY],[cx+6,hem],[cx+3,hem-1],[cx,hem],[cx-3,hem-1],[cx-6,hem]];
    // Local temporary frame ensures capes NEVER bleed into adjoining frames.
    const q=image(fw,32);
    poly(q,pts,'O');
    poly(q,pts.map(([x,y])=>[x+(x<cx?1:-1),y]),'C');
    for(const dx of [-3,3])line(q,cx+dx,shoulderY+2,cx+dx,hem-1,'T');
    if(dir==='right')line(q,cx-5,shoulderY+1,cx-7,hem-1,'R');
    if(dir==='left')line(q,cx+5,shoulderY+1,cx+7,hem-1,'R');
    // A raised velvet collar is visible above the shirt shoulder in every
    // direction.  It wraps the neck rather than floating in front of the face.
    for(const dx of [-4,4]){
      line(q,cx+dx,shoulderY-2,cx+dx,shoulderY+1,'O',2);
      line(q,cx+dx,shoulderY-1,cx+dx,shoulderY+1,'R');
    }
    for(let y=0;y<32;y++)for(let x=0;x<fw;x++){
      const i=(y*fw+x)*4;
      // Front and side fabric is entirely BEHIND the original silhouette.
      // Rear fabric may cover clothes, never hair, face, arms or hands.
      const rearCloth=dir==='up'&&(alpha(shirt,x,y)||alpha(pants,x,y));
      if(q.data[i+3] && y<=hem && !alpha(hair,x,y)&&!alpha(skin,x,y)&&(!alpha(base,x,y)||rearCloth))
        q.data.copy(out.data,(y*out.width+f*fw+x)*4,i,i+4);
    }
    // Brim intersects the crown by two pixels, following each actual head.
    // The source's transparent top padding is excluded from the fit.
    const art=dir==='up'||suffix==='sit2'?2:dir==='down'?0:1;
    const hatH=Math.min(9,a.hy+3),hatY=a.hy+3-hatH, hatX=a.hx-8;
    for(let y=0;y<hatH;y++)for(let x=0;x<16;x++){
      const tx=hatX+(dir==='left'?15-x:x),ty=hatY+y;
      const sy=3+Math.round(y*8/(hatH-1));
      const si=(sy*hatSheet.width+art*16+x)*4;
      if(tx>=0&&tx<fw&&ty>=0&&ty<32&&hatSheet.data[si+3]&&!alpha(skin,tx,ty))
        hatSheet.data.copy(hats.data,(ty*hats.width+f*fw+tx)*4,si,si+4);
    }
  }
  save(path.join(ROOT,'layers',`${cap}_${suffix}_wear_vampirecape.png`),wideCape);
  save(path.join(ROOT,'layers',`${cap}_${suffix}_wear_pumpkinhead.png`),pumpkins);
  save(path.join(ROOT,'layers',`${cap}_${suffix}_wear_witchhat.png`),hats);
}
console.log('Fitted Halloween wearable layers: 4 characters x 4 sheets.');