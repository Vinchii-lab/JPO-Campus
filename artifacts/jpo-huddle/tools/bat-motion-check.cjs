// Focused real-Chromium/Phaser test, using the production _stepPet verbatim.
// Requires an already-running preview at localhost:80; never starts the app.
const fs = require('fs');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const { PNG } = require('pngjs');
const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');
const method = html.slice(html.indexOf('      _stepPet(petObj'), html.indexOf('      // One-shot brew animation'));
const assert = (ok, msg) => { if (!ok) throw Error(msg); };
// Validate every inline script without executing its browser dependencies.
for (const match of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g))
  if (match[1].trim()) new Function(match[1]);
for (const stage of [1, 2, 3]) {
  const stem = `bat${stage === 1 ? '' : `_s${stage}`}`;
  const frames = Array.from({length:16}, (_,i) => PNG.sync.read(fs.readFileSync(path.join(root, `public/assets/pets/anim/${stem}_flap${i}.png`))));
  for (const frame of frames) {
    assert(frame.width === 64 && frame.height === 64, 'Canvas changed');
    for (let y=0;y<64;y++) for(let x=27;x<=44;x++) {
      const i=(y*64+x)*4;
      assert(frame.data.subarray(i,i+4).equals(frames[0].data.subarray(i,i+4)), 'Body/face anchor drift');
    }
  }
}
console.log('PASS: syntax; 48 flight canvases; all central body/face pixels identical.');
const chrome = process.env.CHROME_PATH || '/nix/store/71577rskzyhch3axhdqx7faygc2xyn4v-playwright-browsers-1.55.0-with-cjk/chromium-1187/chrome-linux/chrome';
const browser = spawn(chrome, ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--disable-features=VizDisplayCompositor', '--remote-debugging-port=9225', '--user-data-dir=/tmp/bat-native-check', 'about:blank'], {stdio:'ignore'});
const sleep = ms => new Promise(r=>setTimeout(r,ms));
(async()=>{
  let targets;
  for(let i=0;i<40;i++) {
    try {targets=await (await fetch('http://localhost:9225/json/list')).json(); if(targets.length)break;} catch {}
    await sleep(250);
  }
  assert(targets?.length, 'Chromium did not start');
  const ws=new WebSocket(targets[0].webSocketDebuggerUrl);
  await new Promise(r=>ws.addEventListener('open',r,{once:true}));
  let id=0;const pending=new Map();
  ws.addEventListener('message',e=>{const m=JSON.parse(e.data);if(m.id){pending.get(m.id)(m);pending.delete(m.id);}});
  const cdp=(method,params={})=>new Promise((resolve,reject)=>{const n=++id;pending.set(n,m=>m.error?reject(Error(JSON.stringify(m.error))):resolve(m.result));ws.send(JSON.stringify({id:n,method,params}));});
  const run=async expression=>{
    const r=await cdp('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});
    assert(!r.exceptionDetails,JSON.stringify(r.exceptionDetails));
    return r.result.value;
  };
  await cdp('Page.enable');
  await cdp('Emulation.setDeviceMetricsOverride',{width:900,height:540,deviceScaleFactor:1,mobile:false});
  await cdp('Page.navigate',{url:'http://localhost:80/contact/'});
  await sleep(1000);
  const phaser=await (await fetch('https://cdn.jsdelivr.net/npm/phaser@3.80.1/dist/phaser.min.js')).text();
  await run(phaser);
  await run(`document.body.innerHTML='';document.body.style.cssText='margin:0;background:#181425';`);
  await run(`(()=>{
    const PET_GAP=68,PET_SIT_GAP=58;
    const step=({${method}})._stepPet;
    window.samples=[]; window.bats=[];
    window.testGame=new Phaser.Game({type:Phaser.CANVAS,width:900,height:540,backgroundColor:'#211b32',audio:{noAudio:true},
      scene:{preload(){
        for(let s=1;s<=3;s++){const stem='bat'+(s===1?'':'_s'+s);
          for(const f of [...Array.from({length:16},(_,i)=>'flap'+i),'sit','action'])
            this.load.image(stem+'_'+f,'/assets/pets/anim/'+stem+'_'+f+'.png?native-check=3');
        }
      },create(){
        this._stepPet=step;this._placePetAcc=()=>{};this._trackPetFx=()=>()=>{};this._petTrick=()=>{};
        this.add.text(30,20,'ANCHORED BAT FLIGHT  /  native _stepPet',{fontSize:'22px',color:'#ece6ff'});
        this.add.text(30,62,'STATIONARY HOVER',{fontSize:'14px',color:'#bcb0d1'});
        this.add.text(30,295,'MOVING FOLLOW',{fontSize:'14px',color:'#bcb0d1'});
        for(let row=0;row<2;row++)for(let s=1;s<=3;s++){
          const stem='bat'+(s===1?'':'_s'+s), x=135+(s-1)*285,y=235+row*220;
          const p=this.add.image(x,y,stem+'_flap0').setOrigin(.5,1).setScale(2.4);
          Object.assign(p,{_petId:'pet_bat',_petStage:s,_lively:true,_baseScale:2.4,_trickAt:Infinity,
            _animSet:{walk:Array.from({length:16},(_,i)=>stem+'_flap'+i),sit:stem+'_sit',action:stem+'_action',idle:stem+'_flap0'}});
          window.bats.push({p,row,x,y,seen:new Set()});
          this.add.text(x-40,row?510:265,['BABY','ADULT','SPECTRAL'][s-1],{fontSize:'13px',color:'#bcb0d1'});
        }
        window.testScene=this;window.ready=true;
      }}});
    window.tick=(n)=>{
      for(const b of bats){
        const px=b.row?b.x+68+Math.sin(n/15)*65:b.x+68;
        testScene._stepPet(b.p,px,b.y-10,40,false);
        b.seen.add(b.p.texture.key);
        samples.push({row:b.row,stage:b.p._petStage,x:b.p.x,y:b.p.y,sx:b.p.scaleX,sy:b.p.scaleY,angle:b.p.angle,origin:b.p.originY});
      }
    };
  })()`);
  for(let i=0;i<100&&!await run('!!window.ready');i++)await sleep(100);
  assert(await run('!!window.ready'),'Textures/Phaser scene failed to load');
  const frames='/tmp/bat-native-frames';fs.mkdirSync(frames,{recursive:true});
  // Manual fixed-delta stepping isolates the exact native motion from capture latency.
  for(let i=0;i<96;i++){
    await run(`tick(${i})`);await sleep(25);
    if(i>=16) {
      const shot=await cdp('Page.captureScreenshot',{format:'png'});
      fs.writeFileSync(`${frames}/${String(i-16).padStart(3,'0')}.png`,Buffer.from(shot.data,'base64'));
    }
  }
  const evidence=await run(`({samples,cycles:bats.map(b=>({row:b.row,stage:b.p._petStage,frames:b.seen.size}))})`);
  for(const c of evidence.cycles)assert(c.frames===16,'Incomplete native flap cycle');
  for(const s of evidence.samples)assert(s.sx===2.4&&s.sy===2.4,'Squash/breathing scale leaked into flight');
  for(let i=6;i<evidence.samples.length;i++) {
    const a=evidence.samples[i-6],b=evidence.samples[i];
    assert(Math.abs(a.x-b.x)<25,'Follow position snapped');
    assert(Math.abs(a.angle-b.angle)<2,'Lean snapped');
    if(!b.row)assert(a.x===b.x&&a.y===b.y,'Stationary anchor moved');
  }
  const rest=await run(`bats.map(b=>{testScene._stepPet(b.p,b.p.x+58,b.p.y-10,16,true);return b.p.texture.key;})`);
  assert(rest.every(k=>k.endsWith('_sit')),'Seated art regression');
  const teleport=await run(`(()=>{const p=bats[0].p,x=p.x;testScene._stepPet(p,x+1000,p.y-10,16,false);return p.x-x;})()`);
  assert(teleport>0&&teleport<200,'Far-follow teleport regression');
  const out=path.join(root,'design/halloween-bat-native-motion.gif');
  execFileSync('magick',['-delay','4','-loop','0',...fs.readdirSync(frames).sort().map(f=>path.join(frames,f)),'-layers','Optimize',out]);
  fs.writeFileSync(path.join(root,'design/halloween-bat-motion-evidence.json'),JSON.stringify({cycles:evidence.cycles,scale:'constant 2.4',stationaryAnchor:'unchanged',rest,farFollowDelta:teleport},null,2));
  console.log('PASS: real Chromium + Phaser native _stepPet, 3 stages × stationary/moving, 16 frames each; fixed scale, stable anchors, smooth lean/follow, sit, far-follow. GIF:',out);
  ws.close();
})().catch(e=>{console.error(e);process.exitCode=1;}).finally(()=>browser.kill());