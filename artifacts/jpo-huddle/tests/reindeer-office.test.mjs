import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
const window={};
vm.runInNewContext(fs.readFileSync(new URL('../public/reindeer-office.js',import.meta.url),'utf8'),{window});
const api=window.ReindeerOffice;
function fixture(stage) {
  const g=new Proxy({},{get:(o,k)=>o[k]||(()=>g)});
  let disposed=0;
  const scene={add:{graphics:()=>g},_trackPetFx:()=>()=>disposed++};
  const p={active:true,visible:true,_petStage:stage,_baseScale:1,x:50,y:50,height:64,depth:2,
    setOrigin(x,y){this.originY=y;return this;},setScale(){return this;}};
  return {scene,p,disposed:()=>disposed};
}
test('all forms have finite actions and restore their resting transform',()=>{
  for(const stage of [1,2,3]){
    const {scene,p,disposed}=fixture(stage);
    api.start(scene,p);
    assert.ok(p._trickBusy);
    api.step(scene,p,80);
    assert.ok(p.originY>1);
    for(let i=0;i<45;i++)api.step(scene,p,80);
    assert.equal(p._trickBusy,false);
    assert.equal(p.originY,1);
    assert.equal(disposed(),1);
  }
});
test('hidden pets never start and active tricks clean up on hiding',()=>{
  const {scene,p,disposed}=fixture(3);
  p.visible=false;api.start(scene,p);assert.equal(p._reindeerTrick,undefined);
  p.visible=true;api.start(scene,p);
  const original=p._reindeerTrick;api.start(scene,p);assert.equal(p._reindeerTrick,original);
  p.visible=false;api.step(scene,p,16);
  assert.equal(p._trickBusy,false);assert.equal(disposed(),1);
});
