/* Christmas battle presentation only. Damage and outcomes stay server-owned. */
(function (root) {
  const labels = [
    ['Snowball Bonk', 'Present Pop', 'Present Blizzard'],
    ['Antler Bash', 'Jingle Dash', 'Jingle Stampede'],
    ['Golden Antler Strike', 'Jingle Dash', "Santa’s Sleighride"],
  ];
  function profile(stage, move) {
    const s = Math.max(1, Math.min(3, Number(stage) || 1));
    const index = { attack: 0, special: 1, ultimate: 2 }[move] ?? 0;
    return { effect: 'snow', label: labels[s - 1][index].toUpperCase(), stage: s };
  }
  // All SVG is authored locally; no player content is inserted into markup.
  const art = {
    snowball: '<circle cx="32" cy="32" r="20" fill="#fffdf2" stroke="#b7e5f5" stroke-width="5"/><path d="M20 28l8-9m4 29l12-6" stroke="#c7eaf5" stroke-width="4"/>',
    present: '<path d="M10 24h44v33H10z" fill="#bc243b" stroke="#fff2c5" stroke-width="3"/><path d="M6 20h52v12H6z" fill="#25814f"/><path d="M29 20h7v37h-7z" fill="#ffdb71"/><path d="M32 20C8 19 16 0 32 20C48 0 56 19 32 20" fill="none" stroke="#ffdb71" stroke-width="5"/>',
    bell: '<path d="M15 44h34L44 31q0-20-12-20T20 31z" fill="#ffe385" stroke="#b77822" stroke-width="3"/><circle cx="32" cy="49" r="5" fill="#f5bc43"/>',
    antler: '<path d="M29 56L21 33 9 24M21 33L21 10M21 23L10 13M35 56L43 33 55 24M43 33V10M43 23L54 13" fill="none" stroke="#ffe398" stroke-width="6" stroke-linecap="round"/>',
    candy: '<path d="M24 58V20a12 12 0 0124 0v8" fill="none" stroke="#fff" stroke-width="10"/><path d="M20 48l8 4m-8-18l8 4m-8-18l8 4m5-16l5 7m7 1l7 4" stroke="#de3248" stroke-width="4"/>',
    sleigh: '<path d="M8 31h38l8-12h6L55 46H20z" fill="#c52d42" stroke="#ffdc82" stroke-width="3"/><path d="M19 46v8m27-8v8M9 55h43q11 0 11-10" fill="none" stroke="#ffdc82" stroke-width="4"/><path d="M15 12h18v20H15z" fill="#258451"/><path d="M23 12v20" stroke="#ffdc82" stroke-width="4"/><path d="M34 19h15v13H34z" fill="#d93646"/><path d="M41 19v13" stroke="#fff" stroke-width="3"/>',
  };
  async function play(ctx) {
    const { stage, moveId, from, to, mover, gen, animate, node, burst, alive } = ctx;
    const dx = to.x - from.x, dy = to.y - from.y;
    const rise = Math.max(18, Math.min(90, from.y - from.height * .6 - 16));
    const gold = stage >= 3, color = gold ? '#ffdb78' : '#d6f6ff';
    const icon = (kind, point, size = 42) => {
      const el = node('pb-christmas-prop', point, {});
      el.style.cssText += `;width:${size}px;height:${size}px;pointer-events:none;filter:drop-shadow(0 0 7px ${color});`;
      el.innerHTML = `<svg viewBox="0 0 64 64" width="100%" height="100%" aria-hidden="true">${art[kind]}</svg>`;
      if (kind === 'sleigh' && dx < 0) el.firstElementChild.style.transform = 'scaleX(-1)';
      return el;
    };
    const travel = (kind, start, end, duration, size=42, arc=35) => animate(icon(kind,start,size), [
      { transform:'translate(-50%,-50%) scale(.5)', opacity:0 },
      { offset:.18, transform:'translate(-50%,-50%) scale(1)', opacity:1 },
      { offset:.55, transform:`translate(calc(-50% + ${(end.x-start.x)*.5}px),calc(-50% + ${(end.y-start.y)*.5-arc}px)) rotate(-12deg)`,opacity:1 },
      { transform:`translate(calc(-50% + ${end.x-start.x}px),calc(-50% + ${end.y-start.y}px)) rotate(20deg)`,opacity:0 },
    ], {duration,easing:'ease-in-out'},gen,true);
    const impact = (big=false) => {
      if (!alive()) return;
      burst(to,'snow',color,'#fffdf2',big?24:12,gen,big?95:55);
    };
    const fragments = () => {
      for (let i=0;i<5;i++) void travel('candy',to,{x:to.x+(i-2)*24,y:to.y-25-(i%2)*25},480,20,12);
    };
    if (stage === 1 || (gold && moveId === 'attack')) {
      const kind = gold ? 'antler' : moveId === 'attack' ? 'snowball' : 'present';
      void animate(mover,[
        {transform:'translate(0,0)'},
        {offset:.45,transform:`translate(${-Math.sign(dx)*8}px,-8px) rotate(${-Math.sign(dx)*8}deg)`},
        {transform:'translate(0,0)'},
      ],{duration:320},gen);
      if (!(await travel(kind,from,to,700,gold?76:46))) return false;
      impact(moveId === 'ultimate');
      if (kind === 'present') fragments();
      return animate(mover,[{transform:'translate(0,0)'},{transform:'translate(0,-8px)',offset:.4},{transform:'translate(0,0)'}],{duration:350},gen);
    }
    if (gold && moveId === 'ultimate') {
      // Charge -> summon sleigh -> aerial strike -> presents -> landing.
      burst(from,'snow',color,'#ffffff',16,gen,48);
      if (!(await animate(mover,[
        {transform:'translate(0,0)',filter:'brightness(1)'},
        {transform:'translate(0,-18px)',filter:'brightness(1.7) drop-shadow(0 0 16px #ffdb78)'},
      ],{duration:360},gen))) return false;
      void travel('sleigh',{x:from.x-Math.sign(dx)*65,y:from.y+10},{x:to.x-Math.sign(dx)*45,y:to.y-35},1100,100,rise);
      if (!(await animate(mover,[
        {transform:'translate(0,-18px)'},
        {offset:.38,transform:`translate(${dx*.35}px,${-rise}px)`},
        {offset:.75,transform:`translate(${dx*.83}px,${dy-35}px)`},
        {transform:`translate(${dx*.65}px,${dy-70}px)`},
      ],{duration:1000,easing:'ease-in-out'},gen))) return false;
      await Promise.all([-35,0,35].map(x=>travel('present',{x:to.x+x,y:to.y-110},{x:to.x+x*.5,y:to.y},440,32,5)));
      if (!alive()) return false;
      impact(true); fragments();
      const finished = await animate(mover,[
        {transform:`translate(${dx*.65}px,${dy-70}px)`},
        {offset:.7,transform:'translate(0,10px) scale(1.12,.85)'},
        {transform:'translate(0,0) scale(1)'},
      ],{duration:500,easing:'ease-out'},gen);
      if (finished) burst(from,'snow',color,'#fff',18,gen,70);
      return finished;
    }
    // Adult antler strike or stage 2/3 jingle charge.
    if (moveId !== 'attack') {
      for(let i=0;i<3;i++) void travel('bell',{x:from.x+(i-1)*24,y:from.y-35},{x:to.x+(i-1)*24,y:to.y-20},850,24,30);
      for(let i=1;i<=5;i++) {
        const hoof = node('pb-christmas-hoof',{x:from.x+dx*i/6,y:from.y+from.height*.4+dy*i/6},{});
        hoof.style.cssText += ';width:9px;height:14px;border:2px solid #b9eeff;border-radius:45%;box-shadow:0 0 8px #e6faff;';
        void animate(hoof,[{opacity:0},{opacity:.9,offset:.3},{opacity:0}],{duration:700,delay:i*65},gen,true);
      }
      const nose = node('pb-christmas-nose',{x:from.x+Math.sign(dx)*from.width*.3,y:from.y-8},{});
      nose.style.cssText += ';width:12px;height:12px;background:#ff334d;border-radius:50%;box-shadow:0 0 18px 8px #ff334d;';
      void animate(nose,[{opacity:0},{opacity:1,offset:.4},{opacity:0}],{duration:400},gen,true);
    }
    if (!(await animate(mover,[
      {transform:'translate(0,0)'},
      {offset:.2,transform:`translate(${-Math.sign(dx)*12}px,6px) rotate(${-Math.sign(dx)*10}deg)`},
      {transform:`translate(${dx*.78}px,${dy}px) rotate(${Math.sign(dx)*10}deg)`},
    ],{duration:580,easing:'cubic-bezier(.3,.1,.2,1)'},gen))) return false;
    impact(moveId==='ultimate');
    return animate(mover,[
      {transform:`translate(${dx*.78}px,${dy}px) rotate(${Math.sign(dx)*10}deg)`},
      {transform:'translate(0,0) rotate(0)'},
    ],{duration:320,easing:'ease-out'},gen);
  }
  root.ReindeerBattle = { profile, play };
})(window);
