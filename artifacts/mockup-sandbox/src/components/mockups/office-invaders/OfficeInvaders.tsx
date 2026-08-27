import { useEffect, useMemo, useState, type CSSProperties } from "react";

type Team = "red" | "blue";
type View = "lobby" | "battle";

const people = {
  red: [
    { name: "Maya", role: "Ops", color: "#ff7a66" },
    { name: "Jon", role: "Design", color: "#e84d75" },
    { name: "Open", role: "Claim this station", color: "" },
    { name: "Open", role: "Claim this station", color: "" },
  ],
  blue: [
    { name: "Pia", role: "People", color: "#82e4ed" },
    { name: "Noah", role: "Product", color: "#4da9ff" },
    { name: "Iris", role: "Eng", color: "#8c9cff" },
    { name: "Open", role: "Claim this station", color: "" },
  ],
};

export default function OfficeInvaders() {
  const [view, setView] = useState<View>("lobby");
  const [team, setTeam] = useState<Team>("blue");
  const [slot, setSlot] = useState<number | null>(3);
  const [shipX, setShipX] = useState(50);
  const [aim, setAim] = useState(52);
  const [shots, setShots] = useState<{ id: number; x: number }[]>([]);
  const [score, setScore] = useState({ red: 1240, blue: 1510 });
  const [timer, setTimer] = useState(86);
  const [notice, setNotice] = useState("FORMING UP");

  const enemies = useMemo(
    () => Array.from({ length: 24 }, (_, index) => ({ id: index, x: (index % 8) * 12 + 7, y: Math.floor(index / 8) * 13 + 7 })),
    [],
  );

  useEffect(() => {
    if (view !== "battle") return;
    const tick = window.setInterval(() => setTimer((current) => (current > 0 ? current - 1 : 120)), 1000);
    return () => window.clearInterval(tick);
  }, [view]);

  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if (view !== "battle") return;
      if (event.key === "ArrowLeft" || event.key.toLowerCase() === "a") setShipX((x) => Math.max(8, x - 4));
      if (event.key === "ArrowRight" || event.key.toLowerCase() === "d") setShipX((x) => Math.min(92, x + 4));
      if (event.key === " " || event.key === "Enter") {
        event.preventDefault();
        fire();
      }
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  });

  const fire = () => {
    const id = Date.now();
    setShots((current) => [...current, { id, x: shipX }]);
    setScore((current) => ({ ...current, blue: current.blue + 10 }));
    setNotice("NICE SHOT +10");
    window.setTimeout(() => setShots((current) => current.filter((shot) => shot.id !== id)), 700);
    window.setTimeout(() => setNotice("FORMING UP"), 750);
  };

  const claimSlot = (selected: Team, position: number) => {
    if (people[selected][position].name !== "Open") return;
    setTeam(selected);
    setSlot(position);
  };

  return (
    <main className="oi-shell">
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wdth,wght@12..96,75..100,400..800&family=Space+Mono:wght@400;700&display=swap');
        .oi-shell{--ink:#17142b;--paper:#f6eddb;--red:#f24f4f;--blue:#2566e8;--aqua:#9ee1d5;min-height:100dvh;background:#f6eddb;color:var(--ink);font-family:'Bricolage Grotesque',sans-serif;overflow:hidden;position:relative}.oi-shell *{box-sizing:border-box}.oi-shell:before{content:"";position:fixed;inset:0;opacity:.12;pointer-events:none;background-image:radial-gradient(#19172d .7px,transparent .8px);background-size:5px 5px;z-index:10}.oi-top{height:76px;border-bottom:3px solid var(--ink);display:flex;align-items:center;justify-content:space-between;padding:0 5.5vw;position:relative;z-index:2}.oi-brand{font-family:'Space Mono';font-weight:700;font-size:16px;letter-spacing:-1px;display:flex;align-items:center;gap:10px}.oi-brand i{width:25px;height:25px;background:var(--red);display:block;clip-path:polygon(50% 0,64% 30%,100% 20%,76% 49%,92% 82%,58% 68%,50% 100%,40% 68%,7% 82%,24% 49%,0 20%,36% 30%)}.oi-tabs{border:2px solid var(--ink);border-radius:100px;padding:3px;display:flex;gap:2px;background:#efe3ce}.oi-tabs button,.oi-play,.oi-join{border:0;background:transparent;font:700 12px 'Space Mono';padding:10px 16px;border-radius:100px;cursor:pointer;color:var(--ink)}.oi-tabs button.active{color:#fff;background:var(--ink)}.oi-pool{font:700 12px 'Space Mono';border:2px solid var(--ink);padding:8px 12px;border-radius:3px;background:#ffd45e}.oi-lobby{max-width:1200px;margin:auto;padding:7vh 5.5vw 5vh}.oi-kicker{font:700 11px 'Space Mono';letter-spacing:1.6px;color:#695f7b}.oi-lobby h1{font-size:clamp(48px,7vw,98px);line-height:.84;letter-spacing:-5px;margin:18px 0 20px;max-width:740px}.oi-lobby h1 em{color:var(--red);font-style:normal}.oi-intro{font-size:18px;line-height:1.35;max-width:490px;margin:0 0 40px}.oi-match{display:grid;grid-template-columns:1fr 175px 1fr;align-items:stretch;gap:15px}.oi-team{border:3px solid var(--ink);min-height:340px;padding:21px;background:#faeee1;box-shadow:7px 7px 0 var(--ink);position:relative}.oi-team.blue{background:#d9e8fc}.oi-team-head{display:flex;justify-content:space-between;align-items:start;margin-bottom:22px}.oi-team-tag{font:800 28px 'Space Mono';letter-spacing:-2px}.red .oi-team-tag{color:var(--red)}.blue .oi-team-tag{color:var(--blue)}.oi-team-count{font:700 11px 'Space Mono';padding:6px 8px;border:2px solid var(--ink);background:#f6eddb}.oi-slots{display:grid;grid-template-columns:1fr 1fr;gap:10px}.oi-slot{height:105px;border:2px dashed #9a8e91;background:#fff8ec;padding:11px;text-align:left;cursor:pointer;position:relative;transition:transform .15s,background .15s}.oi-slot:hover{transform:translate(-2px,-2px);background:#fff}.oi-slot.filled{border-style:solid}.oi-slot.selected{outline:4px solid var(--ink);outline-offset:2px;background:#fff5c2}.oi-avatar{width:30px;height:30px;border:2px solid var(--ink);display:grid;place-items:center;font:700 11px 'Space Mono';margin-bottom:8px}.oi-slot strong{font-size:15px;display:block;line-height:1}.oi-slot span{font:11px 'Space Mono';color:#675b69}.oi-cross{display:grid;place-items:center;position:relative}.oi-cross:before,.oi-cross:after{content:"";position:absolute;background:var(--ink)}.oi-cross:before{width:2px;height:100%}.oi-cross:after{height:2px;width:100%}.oi-versus{background:var(--ink);width:78px;height:78px;border-radius:50%;display:grid;place-items:center;color:#f6eddb;font:700 20px 'Space Mono';z-index:1}.oi-join{margin-top:20px;background:var(--ink);color:#fff;border-radius:2px;width:100%;text-align:left;display:flex;justify-content:space-between;align-items:center}.oi-join:hover{background:var(--blue)}.oi-footer-note{display:flex;justify-content:space-between;align-items:center;margin-top:33px;font:12px 'Space Mono'}.oi-dots{display:flex;gap:5px}.oi-dots b{width:8px;height:8px;border-radius:100%;background:var(--blue);animation:oiPulse 1.2s infinite}.oi-dots b:nth-child(2){animation-delay:.2s}.oi-dots b:nth-child(3){animation-delay:.4s}@keyframes oiPulse{50%{transform:scale(.45);opacity:.35}}.oi-battle{height:calc(100dvh - 76px);background:#17142b;padding:22px 5.5vw 28px;display:grid;grid-template-columns:180px minmax(430px,1fr) 180px;gap:20px;color:#fff;align-items:center}.oi-side{font-family:'Space Mono';font-size:11px}.oi-score{border:2px solid currentColor;padding:16px;margin-bottom:12px}.oi-score.red{color:#ff897d}.oi-score.blue{color:#76c9ff}.oi-score strong{display:block;font:700 35px 'Space Mono';letter-spacing:-3px;color:#fff;margin-top:6px}.oi-side-label{color:#bcb1c7;line-height:1.5}.oi-side-label b{color:#f9d863}.oi-cabinet{background:#292342;border:4px solid #f6eddb;padding:9px;box-shadow:10px 10px 0 #090814;position:relative;max-height:680px}.oi-marquee{height:38px;background:#f24f4f;color:#17142b;display:flex;align-items:center;justify-content:space-between;padding:0 12px;font:700 13px 'Space Mono';letter-spacing:.5px}.oi-marquee span{font-size:10px}.oi-stage{height:min(62vh,530px);position:relative;overflow:hidden;background:linear-gradient(#272040 0%,#19172f 80%);border:2px solid #0b0917;cursor:crosshair}.oi-stage:before{content:"";position:absolute;inset:0;background:repeating-linear-gradient(0deg,transparent 0 4px,rgba(255,255,255,.045) 5px 6px);pointer-events:none}.oi-grid{position:absolute;inset:0;background-image:linear-gradient(rgba(129,211,233,.09) 1px,transparent 1px),linear-gradient(90deg,rgba(129,211,233,.09) 1px,transparent 1px);background-size:10% 12%;mask-image:linear-gradient(transparent,black 35%,black)}.oi-enemy{position:absolute;width:29px;height:20px;background:#f6eddb;clip-path:polygon(0 25%,23% 25%,23% 0,77% 0,77% 25%,100% 25%,84% 48%,100% 75%,73% 75%,73% 100%,27% 100%,27% 75%,0 75%,16% 48%);animation:oiFloat 1.7s steps(2) infinite}.oi-enemy:nth-child(3n){background:#f9d863}.oi-enemy:nth-child(4n){background:#ff897d}@keyframes oiFloat{50%{transform:translateY(5px)}}.oi-ship{position:absolute;bottom:38px;width:58px;height:38px;transform:translateX(-50%);background:#78d8e0;clip-path:polygon(48% 0,65% 28%,100% 63%,83% 72%,78% 100%,22% 100%,17% 72%,0 63%,35% 28%);filter:drop-shadow(0 4px 0 #090814);transition:left .12s linear}.oi-ship:before{content:"YOU";position:absolute;top:-23px;left:50%;transform:translateX(-50%);font:700 9px 'Space Mono';color:#fff;background:#2566e8;padding:3px}.oi-aim{position:absolute;bottom:72px;width:2px;height:calc(var(--aim) * 1%);background:linear-gradient(#f9d863 0 45%,transparent 45% 60%,#f9d863 60%);transform-origin:bottom;opacity:.75;pointer-events:none}.oi-shot{position:absolute;bottom:72px;width:5px;height:24px;background:#f9d863;box-shadow:0 0 0 2px #fff;animation:oiShoot .7s linear forwards}@keyframes oiShoot{to{bottom:95%;opacity:.2}}.oi-controls{display:flex;justify-content:space-between;align-items:center;padding:12px 5px 0;font:10px 'Space Mono';color:#cbc0d7}.oi-controls button{background:#f9d863;border:2px solid #0b0917;box-shadow:3px 3px 0 #0b0917;color:#17142b;font:700 11px 'Space Mono';padding:8px 12px;cursor:pointer}.oi-power{border:2px solid #a692bf;padding:14px;margin-bottom:12px;color:#e2d9ed}.oi-power b{font:700 15px 'Space Mono';color:#f9d863;display:block;margin:6px 0}.oi-power-meter{height:8px;background:#493e5d;margin-top:10px}.oi-power-meter i{display:block;background:#78d8e0;height:100%;width:67%;animation:oiCharge 2s infinite alternate}@keyframes oiCharge{to{width:87%}}.oi-fire{background:#f24f4f!important;color:#fff!important}.oi-toast{position:absolute;top:18%;left:50%;transform:translateX(-50%);font:700 15px 'Space Mono';color:#f9d863;text-shadow:3px 3px #17142b;animation:oiPop .75s ease-out}@keyframes oiPop{0%{opacity:0;transform:translate(-50%,10px) scale(.8)}30%{opacity:1}100%{opacity:.5;transform:translate(-50%,-10px)}}.oi-mobile-move{display:none}@media(max-width:800px){.oi-top{padding:0 16px;height:64px}.oi-brand{font-size:12px}.oi-pool{display:none}.oi-lobby{padding:42px 18px}.oi-lobby h1{letter-spacing:-3px}.oi-match{grid-template-columns:1fr;gap:22px}.oi-cross{height:42px}.oi-cross:before{height:2px;width:100%}.oi-cross:after{height:2px;width:100%}.oi-battle{height:auto;min-height:calc(100dvh - 64px);padding:14px;grid-template-columns:1fr}.oi-side{display:flex;gap:8px;order:2}.oi-score,.oi-power{margin:0;flex:1;padding:9px}.oi-score strong{font-size:21px}.oi-cabinet{order:1}.oi-stage{height:50vh}.oi-controls{padding-top:9px}.oi-mobile-move{display:flex;gap:6px}.oi-mobile-move button{background:#eee1f2;border:2px solid #0b0917;color:#17142b;font:700 12px 'Space Mono';padding:7px 10px;cursor:pointer}.oi-footer-note{font-size:10px}.oi-tabs button{padding:8px 10px;font-size:10px}}
      `}</style>
      <style>{`.oi-team.blue{grid-column:3;grid-row:1}.oi-cross{grid-column:2;grid-row:1}@media(max-width:800px){.oi-team.blue,.oi-cross{grid-column:auto;grid-row:auto}}`}</style>
      <header className="oi-top">
        <div className="oi-brand"><i /> JPO HUDDLE <span>/ OFFICE INVADERS</span></div>
        <nav className="oi-tabs">
          <button className={view === "lobby" ? "active" : ""} onClick={() => setView("lobby")}>LOBBY</button>
          <button className={view === "battle" ? "active" : ""} onClick={() => setView("battle")}>BATTLE</button>
        </nav>
        <div className="oi-pool">PRIZE POT&nbsp; 10,000 COINS</div>
      </header>
      {view === "lobby" ? (
        <section className="oi-lobby">
          <div className="oi-kicker">THURSDAY, 5:30 PM · 9 MINUTES TO LAUNCH</div>
          <h1>TAKE A SIDE.<br /><em>DEFEND THE FLOOR.</em></h1>
          <p className="oi-intro">Pick your crew and lock a station. One shared screen, two rival teams, one after-hours coin prize.</p>
          <div className="oi-match">
            {(["red", "blue"] as Team[]).map((side) => (
              <div className={`oi-team ${side}`} key={side}>
                <div className="oi-team-head"><div className="oi-team-tag">{side === "red" ? "RED SHIFT" : "BLUE SHIFT"}</div><div className="oi-team-count">{people[side].filter(p => p.name !== "Open").length + (team === side && slot !== null ? 1 : 0)}/4</div></div>
                <div className="oi-slots">{people[side].map((person, index) => {
                  const isYou = team === side && slot === index;
                  const filled = person.name !== "Open" || isYou;
                  return <button key={index} className={`oi-slot ${filled ? "filled" : ""} ${isYou ? "selected" : ""}`} onClick={() => claimSlot(side, index)}>
                    <div className="oi-avatar" style={{ background: isYou ? "#f9d863" : person.color }}>{isYou ? "YO" : person.name === "Open" ? "+" : person.name.slice(0, 2).toUpperCase()}</div>
                    <strong>{isYou ? "You" : person.name}</strong><span>{isYou ? "Locked in" : person.role}</span>
                  </button>;
                })}</div>
                <button className="oi-join" onClick={() => { setTeam(side); const open = people[side].findIndex(p => p.name === "Open"); setSlot(open); }}><span>{team === side ? "TEAM SELECTED" : `JOIN ${side.toUpperCase()} SHIFT`}</span><span>→</span></button>
              </div>
            ))}
            <div className="oi-cross"><div className="oi-versus">VS</div></div>
          </div>
          <div className="oi-footer-note"><span>YOUR STATION: <b>{slot !== null ? `${team.toUpperCase()} / ${slot + 1}` : "UNASSIGNED"}</b></span><span className="oi-dots"><b /><b /><b /></span><button className="oi-play" onClick={() => setView("battle")}>PREVIEW BATTLE →</button></div>
        </section>
      ) : (
        <section className="oi-battle">
          <aside className="oi-side"><div className="oi-score red">RED SHIFT<strong>{score.red.toLocaleString()}</strong></div><div className="oi-side-label">PILOTS<br /><b>MAYA · JON</b><br />COMBO × 3</div></aside>
          <div className="oi-cabinet">
            <div className="oi-marquee"><span>OFFICE INVADERS</span><span>WAVE 03 · {Math.floor(timer / 60)}:{String(timer % 60).padStart(2, "0")}</span></div>
            <div className="oi-stage" onMouseMove={(e) => { const rect = e.currentTarget.getBoundingClientRect(); setAim(Math.max(25, Math.min(82, ((rect.bottom - e.clientY) / rect.height) * 100))); }} onClick={fire}>
              <div className="oi-grid" />
              {enemies.map(enemy => <i className="oi-enemy" key={enemy.id} style={{ left: `${enemy.x}%`, top: `${enemy.y}%` }} />)}
              {shots.map(shot => <i className="oi-shot" key={shot.id} style={{ left: `${shot.x}%` }} />)}
              <i className="oi-aim" style={{ left: `${shipX}%`, "--aim": aim } as CSSProperties} />
              <div className="oi-ship" style={{ left: `${shipX}%` }} />
              <div className="oi-toast" key={notice}>{notice}</div>
            </div>
            <div className="oi-controls"><span>A / D MOVE · MOUSE AIM · SPACE FIRE</span><div className="oi-mobile-move"><button onClick={() => setShipX(x => Math.max(8, x - 6))}>←</button><button onClick={() => setShipX(x => Math.min(92, x + 6))}>→</button></div><button className="oi-fire" onClick={fire}>FIRE [SPACE]</button></div>
          </div>
          <aside className="oi-side"><div className="oi-score blue">BLUE SHIFT<strong>{score.blue.toLocaleString()}</strong></div><div className="oi-power">PICKUP ACTIVE<b>TRIPLE TAP</b><div className="oi-power-meter"><i /></div></div><div className="oi-side-label">PILOTS<br /><b>PIA · NOAH · IRIS · YOU</b></div></aside>
        </section>
      )}
    </main>
  );
}