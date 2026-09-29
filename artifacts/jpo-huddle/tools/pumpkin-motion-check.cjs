// Native running preview only: no accounts, socket mutations, or server starts.
const puppeteer = require('puppeteer-core');
const fs = require('fs');
const path = require('path');
const assert = require('assert/strict');
const { execFileSync } = require('child_process');
(async()=>{
  const out=path.resolve(__dirname,'../tests/evidence/pumpkin-motion');
  fs.mkdirSync(out,{recursive:true});
  const browser=await puppeteer.launch({executablePath:'/repl/tools/bin/chromium',headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});
  try{
    const page=await browser.newPage();
    await page.goto(process.env.URL||'http://localhost:20158',{waitUntil:'domcontentloaded',timeout:60000});
    await page.waitForFunction(()=>window._gameScene&&['adam','alex','amelia','bob'].every(c=>['pumpkinhead','vampirecape'].every(id=>_wearLayerImgs[`${c}_run_${id}`])),{timeout:60000});
    const result=await page.evaluate(async()=>{
      const sc=window._gameScene, chars=['adam','alex','amelia','bob'], rows=[];
      const canvas=document.createElement('canvas'); canvas.width=920;canvas.height=620;
      const ctx=canvas.getContext('2d');ctx.imageSmoothingEnabled=false;
      for(const char of chars){
        const key=sc._buildPlayerTex(char,0,0,0,0,[]);
        const body=sc.add.sprite(-1000,-1000,key,0).setScale(3);
        const overlays=['vampirecape','pumpkinhead'].map(id=>sc._makeCosmetic(id,-1000,-1000,'right',body,char).obj);
        rows.push({char,body,overlays});
      }
      const images=[], checks=[];
      // Both horizontal directions and front/back, all six phases. Capture the
      // actual pose helper's native frames rather than drawing guessed art.
      for(let phase=0;phase<6;phase++){
        ctx.fillStyle='#c5d5b8';ctx.fillRect(0,0,920,620);
        ctx.fillStyle='#24302b';ctx.font='18px sans-serif';
        ctx.fillText(`Native pumpkin/cape cycle — phase ${phase} (base beside equipped)`,20,26);
        for(let c=0;c<4;c++)for(let d=0;d<4;d++){
          const {body,overlays,char}=rows[c], frame=d*6+phase;
          body.setFrame(frame);
          // No network update or explicit _placeWearable: postupdate must
          // follow the independently advancing native remote-style body.
          await new Promise(resolve=>sc.events.once('postupdate',resolve));
          checks.push({char,frame,overlay:overlays[1].frame.name});
          const x=d*225+20,y=c*140+55;
          ctx.fillStyle='#24302b';ctx.fillText(`${char} ${['right','up','left','down'][d]}`,x,y);
          const draw=(obj,px)=>{
            const f=obj.frame, w=f.cutWidth;
            ctx.drawImage(obj.texture.source[0].image,f.cutX,f.cutY,w,32,px+(40-w)*1.5,y+8,w*3,96);
          };
          draw(body,x-28);
          const ordered=[body,...overlays].sort((a,b)=>sc.children.getIndex(a)-sc.children.getIndex(b));
          ordered.forEach(obj=>draw(obj,x+67));
        }
        images.push(canvas.toDataURL());
      }
      rows.forEach(({body,overlays})=>{overlays.forEach(o=>o.destroy());body.destroy();});
      return {images,checks};
    });
    for(const check of result.checks)assert.equal(Number(check.overlay),check.frame,JSON.stringify(check));
    result.images.forEach((data,i)=>fs.writeFileSync(path.join(out,`phase-${i}.png`),Buffer.from(data.split(',')[1],'base64')));
    execFileSync('magick',['-delay','10','-loop','0',...result.images.map((_,i)=>path.join(out,`phase-${i}.png`)),path.join(out,'all-characters-four-directions.gif')]);
    fs.writeFileSync(path.join(out,'native-frame-checks.json'),JSON.stringify(result.checks,null,2));
    console.log(`PASS: ${result.checks.length} native frame mappings; ${out}/all-characters-four-directions.gif`);
  }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});