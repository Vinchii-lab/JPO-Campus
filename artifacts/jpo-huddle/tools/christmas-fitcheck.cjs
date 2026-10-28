// Native renderer QA, without registering/logging in or changing any accounts.
// URL="https://$REPLIT_DEV_DOMAIN/" node tools/christmas-fitcheck.cjs
// Outputs contact sheets plus every native animation frame, using real bake,
// placement, flip and display-list order. Generated evidence is not committed.
const puppeteer = require('puppeteer-core');
const fs = require('node:fs');
const path = require('node:path');
const out = path.resolve(__dirname, '../../../generated-artifacts/christmas-fitcheck');
const items = ['santahat','reindeerantlers','christmasscarf','christmassweater','elfoutfit','snowflakewings'];
(async () => {
  fs.mkdirSync(out, { recursive: true });
  const browser = await puppeteer.launch({
    executablePath: process.env.CHROMIUM || '/repl/tools/bin/chromium',
    headless: true, args: ['--no-sandbox','--disable-dev-shm-usage']
  });
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(process.env.URL, { waitUntil: 'domcontentloaded', timeout: 90000 });
    await page.waitForFunction(ids => window._gameScene &&
      ['adam','alex','amelia','bob'].every(c => ids.every(id =>
        _gameScene.textures.exists(WEARABLE_DEFS[id].tex) &&
        (id === 'snowflakewings' || (WEARABLE_DEFS[id].poseLayer
          ? ['run','sit','sit2','sit3'].every(sfx=>_wearLayerImgs[`${c}_${sfx}_${id}`])
          : _wearBakeReady(id,c))))), { timeout: 60000 }, items);
    const result = await page.evaluate(items => {
      const s = _gameScene, outputs = {};
      const canvas = (w,h,title) => {
        const cv = document.createElement('canvas'); cv.width=w; cv.height=h;
        const cx=cv.getContext('2d'); cx.imageSmoothingEnabled=false;
        cx.fillStyle='#dededc'; cx.fillRect(0,0,w,h);
        cx.fillStyle='#242331'; cx.font='14px sans-serif'; cx.fillText(title,10,20);
        return {cv,cx};
      };
      function draw(cx,obj,x,y) {
        if(!obj.visible) return;
        const f=obj.frame;
        cx.save(); cx.translate(x+obj.x,y+obj.y);
        cx.rotate(obj.rotation);
        cx.scale(obj.scaleX*(obj.flipX?-1:1),obj.scaleY*(obj.flipY?-1:1));
        cx.drawImage(obj.texture.source[0].image,f.cutX,f.cutY,f.cutWidth,f.cutHeight,
          -obj.originX*f.realWidth,-obj.originY*f.realHeight,f.cutWidth,f.cutHeight);
        cx.restore();
      }
      const poses = [
        ...['right','up','left','down'].map((dir,i)=>({dir,frame:i*6,label:`stand ${dir}`})),
        ...['right','up','down'].flatMap((dir,i)=>[0,6].flatMap(frame=>[false,true].map(flip=>({
          dir,sit:true,frame,flip,label:`sit${i+1} f${frame}${flip?' mirror':''}`
        }))))
      ];
      let rendered=0;
      for(const char of ['adam','alex','amelia','bob']) {
        const {cv,cx}=canvas(2100,1080,`${char} — native Christmas fitting (3x); seated names refer to source sheets`);
        poses.forEach((p,i)=>cx.fillText(p.label,180+i*120,48));
        const outfits=[[],...items.map(id=>[id]),['santahat','christmasscarf','christmassweater','snowflakewings']];
        outfits.forEach((ids,row)=>{
          cx.fillText(ids.length>1?'combined':ids[0]||'base',8,115+row*125);
          const key=s._buildPlayerTex(char,0,0,0,0,ids.filter(id=>_wearBakeReady(id,char)));
          poses.forEach((p,col)=>{
            const tex=p.sit?key.replace(`pl_${char}`,`pl_sit_${p.dir}_${char}`):key;
            const body=s.add.sprite(0,0,tex,p.frame).setScale(3).setFlipX(!!p.flip);
            const overlays=ids.map(id=>s._makeCosmetic(id,0,0,p.dir,body,char)).filter(Boolean).map(m=>m.obj);
            for(const obj of overlays) {
              if(!obj.visible || obj.texture.key==='__MISSING') throw new Error(`Invisible overlay ${char}/${ids}/${p.label}`);
              if(obj.frame.cutHeight===48 && Number(obj.frame.name)!==p.frame)
                throw new Error('Headwear does not track native frame');
            }
            const objects=[body,...overlays].sort((a,b)=>s.children.getIndex(a)-s.children.getIndex(b));
            objects.forEach(obj=>draw(cx,obj,225+col*120,112+row*125));
            overlays.forEach(obj=>{s.tweens.killTweensOf(obj);obj.destroy();}); body.destroy(); rendered++;
          });
        });
        outputs[`${char}-poses`]=cv.toDataURL();
        // Every gait/seat animation frame, not only the representative poses.
        for(const id of items) {
          const {cv,cx}=canvas(1580,570,`${char} / ${id} — every native animation frame`);
          const key=s._buildPlayerTex(char,0,0,0,0,_wearBakeReady(id,char)?[id]:[]);
          ['run','right','up','down'].forEach((sheet,row)=>{
            const tex=sheet==='run'?key:key.replace(`pl_${char}`,`pl_sit_${sheet}_${char}`);
            const count=s.textures.get(tex).frameTotal-1;
            cx.fillText(sheet,6,95+row*130);
            for(let f=0;f<count;f++) {
              const dir=sheet==='run'?['right','up','left','down'][Math.floor(f/6)]:sheet;
              const body=s.add.sprite(0,0,tex,f).setScale(2);
              const made=s._makeCosmetic(id,0,0,dir,body,char), overlay=made?.obj;
              if(overlay && !WEARABLE_DEFS[id].poseLayer) {overlay.setScale(2);overlay.x*=2/3;overlay.y*=2/3;}
              [body,...(overlay?[overlay]:[])].sort((a,b)=>s.children.getIndex(a)-s.children.getIndex(b))
                .forEach(obj=>draw(cx,obj,90+f*62,85+row*130));
              cx.fillText(String(f),83+f*62,140+row*130);
              if(overlay){s.tweens.killTweensOf(overlay);overlay.destroy();} body.destroy();rendered++;
            }
          });
          outputs[`${char}-${id}-frames`]=cv.toDataURL();
        }
      }
      const {cv,cx}=canvas(2460,780,'Reindeer — all three stages; native art right and mirrored left (3x)');
      const names=['idle','walk1','walk2','walk3','sit','action'];
      const pets=[];
      for(let stage=1;stage<=3;stage++) for(let i=0;i<names.length;i++) {
        const suffix=stage===1?'':`_s${stage}`;
        const key=i===0?`pet_reindeer${suffix}`:`petanim_reindeer${suffix}_${names[i]}`;
        if(!s.textures.exists(key)) throw new Error(`Missing pet texture ${key}`);
        const im=s.textures.get(key).source[0].image;
        pets.push({key,width:im.width,height:im.height});
        const x=10+i*408,y=50+(stage-1)*240;
        cx.fillText(`S${stage} ${names[i]}`,x,y);
        for(let flip=0;flip<2;flip++){
          cx.save();cx.translate(x+96+flip*195,y+200);
          cx.scale(flip?-3:3,3);
          cx.drawImage(im,-im.width/2,-im.height);cx.restore();
        }
      }
      outputs.reindeer=cv.toDataURL();
      return {outputs,rendered,pets};
    }, items);
    for(const [name,data] of Object.entries(result.outputs))
      fs.writeFileSync(path.join(out,`${name}.png`),Buffer.from(data.split(',')[1],'base64'));
    const sections=Object.entries(result.outputs).sort(([a],[b])=>{
      const rank=n=>n==='reindeer'?0:n.endsWith('-poses')?1:2;
      return rank(a)-rank(b)||a.localeCompare(b);
    }).map(([name,data])=>`<section><h2>${name}</h2><a href="${data}" target="_blank"><img src="${data}" alt="${name}"></a></section>`).join('');
    fs.writeFileSync(path.join(out,'contact-sheets.html'),`<!doctype html><html lang="en"><meta charset="utf-8"><title>Christmas visual QA</title><style>body{font:16px system-ui;background:#eee;color:#222;margin:24px}img{max-width:100%;image-rendering:pixelated}section{margin:32px 0}a{display:block}</style><h1>Christmas outfits and reindeer — development QA</h1><p>All four characters, six wearables, four standing facings, both halves and flips of every seated sheet, combined outfit, and all native animation frames. Click any sheet for its original resolution. Reindeer: all three stages, idle, three walk frames, sit and action, both directions.</p>${sections}</html>`);
    delete result.outputs;
    result.errors=errors;
    fs.writeFileSync(path.join(out,'results.json'),JSON.stringify(result,null,2));
    console.log(JSON.stringify(result));
    if(errors.length) throw new Error('Browser errors encountered');
  } finally {
    // No identity is registered; close the anonymous socket before browser teardown.
    for(const p of await browser.pages()) await p.evaluate(()=>{if(typeof socket!=='undefined')socket.disconnect();}).catch(()=>{});
    await browser.close();
  }
})().catch(e=>{console.error(e);process.exitCode=1;});
