(function(root) {
  // Delta-driven office performances: no delayed callbacks can outlive a pet.
  function stop(scene,p) {
    const s=p._reindeerTrick;
    if(!s)return;
    s.dispose();
    p._reindeerTrick=null;
    p._trickBusy=false;
    p.setOrigin(.5,1).setScale(p._baseScale||1);
    p.angle=0;
  }
  function start(scene,p) {
    if(!p.active||!p.visible||p._trickBusy)return;
    const g=scene.add.graphics();
    const dispose=scene._trackPetFx(p,g);
    p._reindeerTrick={t:0,g,dispose,stage:p._petStage||1,dir:p.flipX?-1:1};
    p._trickBusy=true;
    if(p._animSet)p.setTexture(p._animSet.action);
  }
  function step(scene,p,delta) {
    const s=p._reindeerTrick;
    if(!s)return false;
    if(!p.active||!p.visible){stop(scene,p);return false;}
    s.t+=Math.min(80,Math.max(0,delta));
    const duration=s.stage===3?3000:2100;
    if(s.t>=duration){stop(scene,p);return false;}
    const t=s.t/duration,g=s.g,bs=p._baseScale||1;
    g.clear().setPosition(p.x,p.y).setDepth(p.depth+.1);
    const lift=Math.sin(t*Math.PI)*(s.stage===3?48:s.stage===2?15:22);
    p.setOrigin(.5,1+lift/Math.max(1,p.height*bs));
    p.angle=Math.sin(t*Math.PI*4)*(s.stage===2?10:4)*s.dir;
    const gift=(x,y,size)=>{
      g.fillStyle(0xc83248).fillRect(x-size/2,y-size,size,size);
      g.fillStyle(0x247e50).fillRect(x-size/2-2,y-size-3,size+4,5);
      g.fillStyle(0xffdf81).fillRect(x-2,y-size-5,4,size+5);
    };
    if(s.stage===1) {
      if(t<.55)gift(s.dir*24,-4,18);
      else for(let i=0;i<12;i++){
        const a=i*Math.PI/6,r=(t-.55)*95;
        g.fillStyle(i%2?0xffffff:0xe74151,1-t*.5).fillRect(s.dir*24+Math.cos(a)*r,-20+Math.sin(a)*r-15,3,6);
      }
    } else if(s.stage===2) {
      for(let i=0;i<5;i++) {
        const a=t*Math.PI*4+i*Math.PI*.4;
        const x=Math.cos(a)*30,y=-25-lift+Math.sin(a)*10;
        g.fillStyle(0xffd15c).fillTriangle(x-4,y+3,x+4,y+3,x,y-7);
        g.fillStyle(0xfff1b1).fillCircle(x,y+4,2);
      }
      g.fillStyle(0xff3348,.6+.4*Math.sin(t*30)).fillCircle(s.dir*13,-25-lift,4);
    } else {
      const sx=-s.dir*38,sy=-lift+4;
      g.lineStyle(2,0xffdf81).lineBetween(s.dir*-10,-lift-8,sx,sy-12);
      g.fillStyle(0xbb2c46).fillRoundedRect(sx-16,sy-13,32,14,4);
      g.lineStyle(3,0xffdf81).beginPath().moveTo(sx-19,sy+4).lineTo(sx+17,sy+4).lineTo(sx+22,sy-2).strokePath();
      gift(sx-6,sy-13,12);gift(sx+7,sy-13,10);
      for(let i=0;i<14;i++){
        const a=t*5+i*2.4,r=22+i*2;
        const x=Math.cos(a)*r,y=-lift-12+Math.sin(a)*r*.5;
        g.lineStyle(1,0xffe5a0).lineBetween(x-3,y,x+3,y).lineBetween(x,y-3,x,y+3);
      }
    }
    return true;
  }
  root.ReindeerOffice={start,step,stop};
})(window);
