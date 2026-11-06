import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const code = fs.readFileSync(new URL('../public/mobile-admin-access.js', import.meta.url), 'utf8');
const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');

function target() {
  const handlers = new Map();
  return {
    addEventListener(name, fn) { if (!handlers.has(name)) handlers.set(name, new Set()); handlers.get(name).add(fn); },
    removeEventListener(name, fn) { handlers.get(name)?.delete(fn); },
    send(name, args = {}) { for (const fn of handlers.get(name) || []) fn(args); },
  };
}
function setup() {
  const document = Object.assign(target(), { hidden:false }), window=target(), balance=target(), timers=new Map();
  let now=0,id=0,opened=0,ready=true;
  vm.runInNewContext(code, {
    window, document, Date:{now:()=>now},
    setTimeout: (fn,ms)=>{timers.set(++id,{fn,at:now+ms});return id;},
    clearTimeout:key=>timers.delete(key),
  });
  const dispose=window.JpoMobileAdmin.bind({target:balance,ready:()=>ready,open:()=>opened++});
  function advance(ms) {
    now+=ms;
    for(const [key,timer] of [...timers]) if(timer.at<=now) { timers.delete(key); timer.fn(); }
  }
  function down(extra={}) {
    const event={pointerId:1,pointerType:'touch',button:0,isPrimary:true,clientX:30,clientY:40,...extra};
    document.send('pointerdown',event);balance.send('pointerdown',event);
    return event;
  }
  return {document,window,balance,down,advance,dispose,opened:()=>opened,setReady:value=>{ready=value;}};
}
test('only a full two-second touch hold opens the unlock flow, exactly once',()=>{
  const s=setup();s.down();s.advance(1999);assert.equal(s.opened(),0);
  s.advance(1);assert.equal(s.opened(),1);s.advance(4000);assert.equal(s.opened(),1);
});
test('short tap and drag never open, and a later intentional hold still works',()=>{
  for(const cancel of [
    s=>s.document.send('pointerup',{pointerId:1}),
    s=>s.document.send('pointermove',{pointerId:1,clientX:45,clientY:40}),
  ]) {
    const s=setup();s.down();s.advance(400);cancel(s);s.advance(2500);assert.equal(s.opened(),0);
    s.document.send('pointerup',{pointerId:1});s.down();s.advance(2000);assert.equal(s.opened(),1);
  }
});
test('scroll, cancelled touch, multitouch, blur and hidden-page interruptions cancel the hold',()=>{
  for(const cancel of [
    s=>s.document.send('scroll'),
    s=>s.document.send('pointercancel',{pointerId:1}),
    s=>s.document.send('pointerdown',{pointerId:2}),
    s=>s.window.send('blur'),
    s=>{s.document.hidden=true;s.document.send('visibilitychange');},
    s=>s.window.send('pagehide'),
  ]) {
    const s=setup();s.down();cancel(s);s.advance(2500);assert.equal(s.opened(),0);
  }
});
test('mouse, secondary touches, disconnected readiness and disposal cannot unlock',()=>{
  const s=setup();s.down({pointerType:'mouse'});s.advance(2100);assert.equal(s.opened(),0);
  s.document.send('pointerup',{pointerId:1});
  s.down({isPrimary:false});s.advance(2100);assert.equal(s.opened(),0);
  s.document.send('pointerup',{pointerId:1});s.setReady(false);s.down();s.advance(2100);assert.equal(s.opened(),0);
  s.document.send('pointerup',{pointerId:1});s.setReady(true);s.down();s.setReady(false);s.advance(2100);assert.equal(s.opened(),0);
  s.setReady(true);s.document.send('pointerup',{pointerId:1});s.down();s.dispose();s.advance(2100);assert.equal(s.opened(),0);
});
test('context menu suppression is local to the held coin balance',()=>{
  const s=setup();let prevented=0;
  s.balance.send('contextmenu',{preventDefault:()=>prevented++});assert.equal(prevented,0);
  s.down();s.balance.send('contextmenu',{preventDefault:()=>prevented++});assert.equal(prevented,1);
  s.document.send('pointerup',{pointerId:1});s.balance.send('contextmenu',{preventDefault:()=>prevented++});assert.equal(prevented,1);
});
test('unrelated chat auto-scroll does not interrupt a stationary HUD hold',()=>{
  const s=setup();s.down();s.advance(1000);
  s.document.send('scroll',{target:{contains:()=>false}});
  s.advance(1000);assert.equal(s.opened(),1);
});
test('entry has no visible admin label, and desktop F8 shares the existing password gate',()=>{
  const balance=html.match(/<span id="coin-balance">([\s\S]*?)<\/span><\/span>/)?.[0];
  assert.ok(balance);
  assert.doesNotMatch(balance,/admin|owner|title=|onclick|role="button"/i);
  assert.match(html,/if \(e.key === 'F8'\)[\s\S]*?toggleOwnerAccess\(\)/);
  assert.match(html,/if \(!_adminAuthed\) \{ openOwnerPwd\(\); return; \}/);
  assert.match(html,/function openOwnerPanel\(\) \{\s*if \(!_adminAuthed \|\| !socket.connected\) return;/);
});
test('disconnect closes stale privilege UI and reconnect reauthenticates before reuse',()=>{
  assert.match(html,/socket.on\('disconnect', \(\) => \{\s*_adminAuthed = false;[\s\S]*?closeOwnerPanel\(\);/);
  assert.match(html,/if \(_adminPwd\) socket.emit\('adminAuth', \{ password: _adminPwd \}\)/);
  assert.match(html,/if \(\(tab === 'prices' \|\| tab === 'whispers'\) && !window._ownerAuthed\) tab = 'reg'/);
});
test('keyboard and viewport scrolling keep dialogs in the actual visible area',()=>{
  const viewport=Object.assign(target(),{height:360,width:390,offsetTop:210,offsetLeft:0});
  const window=Object.assign(target(),{visualViewport:viewport,innerHeight:844,innerWidth:390});
  const values={};
  const document={
    getElementById:id=>({style:{setProperty:(key,value)=>{(values[id] ||= {})[key]=value;}}}),
    querySelectorAll:()=>[],
  };
  vm.runInNewContext(code,{window,document});
  window.JpoMobileAdmin.fitViewport();
  for(const id of ['owner-panel','owner-pwd-modal']) {
    assert.equal(values[id]['--admin-vv-height'],'360px');
    assert.equal(values[id]['--admin-vv-top'],'210px');
  }
  viewport.height=700;viewport.offsetTop=0;viewport.send('resize');
  assert.equal(values['owner-panel']['--admin-vv-height'],'700px');
  assert.equal(values['owner-pwd-modal']['--admin-vv-top'],'0px');
});
