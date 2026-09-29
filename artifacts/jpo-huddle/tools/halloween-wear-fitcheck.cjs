// Capture the running game's native texture builder; no login or player edits.
const puppeteer = require('puppeteer-core');
const fs = require('fs');
const path = require('path');
(async () => {
  const browser = await puppeteer.launch({
    executablePath: '/repl/tools/bin/chromium',
    headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage']
  });
  try {
    const page = await browser.newPage();
    await page.goto(process.env.URL || 'http://localhost:20158', { waitUntil: 'networkidle2' });
    await page.waitForFunction(() => window._gameScene &&
      ['adam','alex','amelia','bob'].every(c =>
        ['witchhat','raincoat','rainboots'].every(id => _wearBakeReady(id,c)) &&
        ['run','sit','sit2','sit3'].every(s=>['pumpkinhead','vampirecape'].every(id=>_wearLayerImgs[`${c}_${s}_${id}`]))), { timeout: 60000 });
    const result = await page.evaluate(() => {
      const scene = window._gameScene;
      const chars = ['adam','alex','amelia','bob'];
      const outfits = [[], ['vampirecape'], ['pumpkinhead','vampirecape'],
        ['rainboots','raincoat','vampirecape','pumpkinhead']];
      const cv = document.createElement('canvas');
      cv.width=1100; cv.height=16*150+45;
      const ctx=cv.getContext('2d'); ctx.imageSmoothingEnabled=false;
      ctx.fillStyle='#dededc'; ctx.fillRect(0,0,cv.width,cv.height);
      ctx.font='16px sans-serif'; ctx.fillStyle='#252331';
      const labels=['stand R','stand U','stand L','stand D','sit R','sit U','sit L','sit D'];
      labels.forEach((s,i)=>ctx.fillText(s,200+i*110,25));
      chars.forEach((char,c)=>outfits.forEach((ids,o)=>{
        const row=c*4+o, y=45+row*150;
        const key=scene._buildPlayerTex(char,0,0,0,0,ids.filter(id=>_wearBakeReady(id,char)));
        ctx.fillStyle='#252331'; ctx.fillText(char,8,y+45);
        ctx.fillText(['base','cape','pumpkin + cape','rain + Halloween'][o],8,y+67);
        labels.forEach((_,d)=>{
          const dir=['right','up','left','down'][d%4];
          const tex=d<4?key:key.replace(`pl_${char}`,`pl_sit_${dir==='left'?'right':dir}_${char}`);
          const img=scene.textures.get(tex).source[0].image;
          const fw=d<4||dir==='down'?16:32;
          const sx=d<4?d*6*16:0;
          const body=scene.add.sprite(0,0,tex,d<4?d*6:0).setScale(3).setFlipX(d===6);
          const overlays=ids.filter(id=>WEARABLE_DEFS[id].poseLayer).map(id=>scene._makeCosmetic(id,0,0,dir,body,char));
          ctx.save();
          ctx.translate(200+d*110+(32-fw)*1.5,y);
          if(d===6){ctx.translate(96,0);ctx.scale(-1,1);}
          ctx.drawImage(img,sx,0,fw,32,0,0,fw*3,96);
          ctx.restore();
          for(const made of overlays.sort((a,b)=>Number(a.def===WEARABLE_DEFS.pumpkinhead)-Number(b.def===WEARABLE_DEFS.pumpkinhead))){
            const obj=made.obj, f=obj.frame;
            ctx.save();ctx.translate(200+d*110-12,y);
            if(obj.flipX){ctx.translate(120,0);ctx.scale(-1,1);}
            ctx.drawImage(obj.texture.source[0].image,f.cutX,f.cutY,40,32,0,0,120,96);
            ctx.restore();obj.destroy();
          }
          body.destroy();
        });
      }));
      return cv.toDataURL();
    });
    const dest=path.resolve(__dirname,'../design/halloween-wear-native-fit.png');
    fs.writeFileSync(dest,Buffer.from(result.split(',')[1],'base64'));
    console.log(dest);
  } finally { await browser.close(); }
})().catch(e=>{console.error(e);process.exitCode=1;});