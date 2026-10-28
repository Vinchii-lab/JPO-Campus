import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
const source = fs.readFileSync(new URL('../public/reindeer-battle.js',import.meta.url),'utf8');
const window = {};
vm.runInNewContext(source,{window});
const battle = window.ReindeerBattle;
test('each form has its own basic attack and Christmas special',()=>{
  assert.equal(battle.profile(1,'attack').label,'SNOWBALL BONK');
  assert.equal(battle.profile(1,'special').label,'PRESENT POP');
  assert.equal(battle.profile(2,'attack').label,'ANTLER BASH');
  assert.equal(battle.profile(2,'special').label,'JINGLE DASH');
  assert.equal(battle.profile(3,'attack').label,'GOLDEN ANTLER STRIKE');
  assert.equal(battle.profile(3,'ultimate').label,'SANTA’S SLEIGHRIDE');
});
test('all nine move paths complete on either side without combat mutations',async()=>{
  for(const stage of [1,2,3]) for(const moveId of ['attack','special','ultimate']) for(const dir of [-1,1]) {
    const props=[], bursts=[];
    const ctx={stage,moveId,gen:1,mover:{},from:{x:100,y:100,width:60},to:{x:100+dir*200,y:100},
      alive:()=>true,node:()=>{const n={style:{cssText:''},firstElementChild:{style:{}}};props.push(n);return n;},
      animate:async()=>true,burst:(...args)=>bursts.push(args)};
    assert.equal(await battle.play(ctx),true);
    assert.ok(bursts.length);
    if(stage===3&&moveId==='ultimate') assert.ok(props.length>=9);
    assert.equal(ctx.damage,undefined);
  }
});
test('cancelled choreography never emits its impact',async()=>{
  for(const stage of [1,2,3]) for(const moveId of ['attack','special','ultimate']) {
    let impacts=0;
    const to={x:300,y:100};
    const result=await battle.play({stage,moveId,gen:1,mover:{},from:{x:100,y:100,width:60},to,
      alive:()=>false,node:()=>({style:{cssText:''}}),animate:async()=>false,
      burst:(p)=>{if(p===to) impacts++;}});
    assert.equal(result,false);
    assert.equal(impacts,0);
  }
});
