import { useEffect, useState } from "react";

type Team = "red" | "blue";
type Screen = "lobby" | "battle";

const teamMembers = {
  red: ["Maya", "Jon", "You", "Open"],
  blue: ["Pia", "Noah", "Iris", "Open"],
};

const colors = {
  red: "#ef5b57",
  blue: "#5cb8e8",
  ink: "#151a2f",
};

const mapPlayers = [
  { name: "Maya", team: "red", left: 18, top: 37, state: "carrying" },
  { name: "Jon", team: "red", left: 30, top: 65, state: "cover" },
  { name: "You", team: "blue", left: 67, top: 59, state: "aiming" },
  { name: "Pia", team: "blue", left: 78, top: 30, state: "cover" },
  { name: "Noah", team: "blue", left: 60, top: 24, state: "cover" },
];

export default function OfficeInvaders() {
  const [screen, setScreen] = useState<Screen>("battle");
  const [team, setTeam] = useState<Team>("blue");
  const [slot, setSlot] = useState(2);
  const [fired, setFired] = useState(false);
  const [notice, setNotice] = useState("OBJECTIVE ACTIVE");
  const [redScore, setRedScore] = useState(62);
  const [blueScore, setBlueScore] = useState(71);

  useEffect(() => {
    if (!fired) return;
    const timeout = window.setTimeout(() => setFired(false), 450);
    return () => window.clearTimeout(timeout);
  }, [fired]);

  const fire = () => {
    setFired(true);
    setBlueScore((score) => score + 1);
    setNotice("HIT CONFIRMED  +25");
    window.setTimeout(() => setNotice("OBJECTIVE ACTIVE"), 900);
  };

  const selectTeam = (nextTeam: Team) => {
    setTeam(nextTeam);
    const openIndex = teamMembers[nextTeam].findIndex((member) => member === "Open");
    setSlot(openIndex === -1 ? 0 : openIndex);
  };

  return (
    <main className="arena-shell">
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=DM+Mono:wght@400;500&family=Syne:wght@500;600;700;800&display=swap');
        .arena-shell{--ink:#151a2f;--paper:#f3ead8;--red:#ef5b57;--blue:#5cb8e8;--yellow:#f5c95e;min-height:100dvh;background:var(--paper);color:var(--ink);font-family:'Syne',sans-serif;overflow:hidden}.arena-shell *{box-sizing:border-box}.arena-shell button{font:inherit;cursor:pointer}.arena-top{height:72px;padding:0 4.5vw;border-bottom:2px solid var(--ink);display:flex;align-items:center;justify-content:space-between;background:#f8f0df}.arena-brand{display:flex;align-items:center;gap:11px;font:700 13px 'DM Mono';letter-spacing:-.7px}.arena-mark{width:28px;height:28px;background:var(--red);border:2px solid var(--ink);display:grid;place-items:center;color:var(--paper);font:700 14px 'DM Mono';clip-path:polygon(0 0,100% 0,100% 70%,72% 70%,50% 100%,50% 70%,0 70%)}.arena-nav{display:flex;gap:3px;background:#e8decc;border:2px solid var(--ink);padding:3px;border-radius:30px}.arena-nav button{border:0;background:transparent;padding:9px 16px;border-radius:20px;color:#556078;font:500 11px 'DM Mono'}.arena-nav button.active{background:var(--ink);color:var(--paper)}.arena-pot{border:2px solid var(--ink);background:var(--yellow);padding:9px 12px;font:500 11px 'DM Mono';box-shadow:3px 3px 0 var(--ink)}.arena-lobby{max-width:1200px;margin:auto;padding:7vh 4.5vw}.arena-kicker{font:500 11px 'DM Mono';letter-spacing:1.8px;color:#6e7281}.arena-lobby h1{font-size:clamp(45px,7vw,92px);line-height:.86;letter-spacing:-5px;max-width:770px;margin:17px 0 20px}.arena-lobby h1 em{font-style:normal;color:var(--red)}.arena-copy{font-size:17px;line-height:1.4;max-width:550px;margin-bottom:36px}.arena-lobby-grid{display:grid;grid-template-columns:1fr 110px 1fr;gap:18px;align-items:stretch}.squad-card{border:3px solid var(--ink);padding:20px;background:#f7ddd1;box-shadow:6px 6px 0 var(--ink)}.squad-card.blue{background:#dbeef5}.squad-heading{display:flex;align-items:center;justify-content:space-between;margin-bottom:18px}.squad-heading h2{font:700 23px 'DM Mono';letter-spacing:-2px;margin:0}.squad-card.red h2{color:var(--red)}.squad-card.blue h2{color:#328ec1}.squad-count{border:2px solid var(--ink);padding:5px 7px;font:500 10px 'DM Mono'}.slot-grid{display:grid;grid-template-columns:1fr 1fr;gap:9px}.slot{min-height:95px;border:2px dashed #a89c9b;background:#fff7e8;padding:10px;text-align:left;transition:transform .15s,background .15s}.slot:hover{transform:translate(-2px,-2px);background:#fff}.slot.selected{border-style:solid;outline:3px solid var(--ink);background:var(--yellow)}.slot-avatar{width:28px;height:28px;border:2px solid var(--ink);display:grid;place-items:center;font:500 10px 'DM Mono';margin-bottom:8px}.slot strong{display:block;font-size:14px}.slot small{font:10px 'DM Mono';color:#687080}.squad-join{width:100%;border:0;background:var(--ink);color:#fff7e8;padding:12px 13px;margin-top:17px;text-align:left;display:flex;justify-content:space-between;font:500 11px 'DM Mono'}.squad-join:hover{background:#293452}.versus{display:grid;place-items:center;position:relative}.versus:before,.versus:after{content:"";position:absolute;background:var(--ink)}.versus:before{width:2px;height:100%}.versus:after{height:2px;width:100%}.versus b{z-index:1;background:var(--ink);border-radius:50%;width:68px;height:68px;display:grid;place-items:center;color:var(--paper);font:500 17px 'DM Mono'}.lobby-foot{display:flex;justify-content:space-between;align-items:center;margin-top:28px;font:500 11px 'DM Mono'}.launch{border:2px solid var(--ink);background:var(--yellow);padding:11px 15px;box-shadow:4px 4px 0 var(--ink)}.arena-battle{min-height:calc(100dvh - 72px);background:#1a2037;color:#f5ead6;padding:20px 4vw 24px;display:grid;grid-template-columns:180px minmax(480px,1fr) 190px;gap:19px;align-items:stretch}.battle-column{font:500 10px 'DM Mono';display:flex;flex-direction:column;gap:11px}.score-card{border:2px solid currentColor;padding:13px}.score-card.red{color:#ff8176}.score-card.blue{color:#7dd3f4}.score-card span{color:#ddd1c2;display:block;margin-bottom:8px}.score-card strong{color:#fff8ea;display:block;font-size:32px;letter-spacing:-3px}.stat-card{border:2px solid #656b85;padding:13px;color:#c7c9d4;line-height:1.65}.stat-card b{color:var(--yellow);display:block;font-size:14px;margin-bottom:7px}.stat-card i{display:block;height:6px;background:#3b435f;margin-top:9px}.stat-card i:after{content:"";display:block;width:72%;height:100%;background:var(--yellow)}.team-players{line-height:1.9;color:#b8bdcf}.team-players b{color:#f7ead6}.game-card{border:4px solid #f5ead6;background:#303955;padding:9px;box-shadow:9px 9px 0 #0d1020;display:flex;flex-direction:column}.game-marquee{height:42px;background:var(--red);color:var(--ink);display:flex;justify-content:space-between;align-items:center;padding:0 12px;font:700 12px 'DM Mono';letter-spacing:1px}.game-marquee span:last-child{font-size:10px}.game-map{min-height:500px;position:relative;overflow:hidden;background:#667365;border:2px solid #111728;background-image:linear-gradient(34deg,rgba(255,255,255,.04) 25%,transparent 25%),linear-gradient(-34deg,rgba(0,0,0,.07) 25%,transparent 25%);background-size:34px 34px;cursor:crosshair}.game-map:before{content:"";position:absolute;inset:0;background:linear-gradient(90deg,rgba(32,39,47,.18) 1px,transparent 1px),linear-gradient(rgba(32,39,47,.18) 1px,transparent 1px);background-size:8% 10%;opacity:.75}.cover{position:absolute;background:#283344;border:3px solid #131a2b;box-shadow:5px 5px 0 rgba(18,22,32,.35);z-index:1}.cover.one{left:39%;top:20%;width:24%;height:11%}.cover.two{left:14%;top:71%;width:23%;height:10%;transform:rotate(-9deg)}.cover.three{right:12%;top:54%;width:21%;height:12%;transform:rotate(8deg)}.zone{position:absolute;left:39%;top:39%;width:24%;height:22%;border:3px dashed var(--yellow);background:rgba(245,201,94,.15);display:grid;place-items:center;z-index:1}.zone b{font:700 13px 'DM Mono';color:var(--yellow);letter-spacing:2px}.player{position:absolute;width:44px;height:44px;transform:translate(-50%,-50%);z-index:3}.player .body{width:31px;height:31px;border:3px solid #f7ead6;display:grid;place-items:center;font:700 9px 'DM Mono';color:var(--ink);box-shadow:4px 4px 0 rgba(15,19,30,.45)}.player.red .body{background:var(--red)}.player.blue .body{background:var(--blue)}.player .label{position:absolute;left:50%;top:-22px;transform:translateX(-50%);white-space:nowrap;padding:3px 5px;background:var(--ink);font:500 9px 'DM Mono';color:#fff8e9}.player.carrying:after{content:"PAYLOAD";position:absolute;top:35px;left:32px;background:var(--yellow);color:var(--ink);font:700 7px 'DM Mono';padding:3px}.crosshair{position:absolute;left:67%;top:59%;width:88px;height:88px;transform:translate(-50%,-50%);border:1px solid rgba(255,232,153,.9);border-radius:50%;z-index:2}.crosshair:before,.crosshair:after{content:"";position:absolute;background:var(--yellow)}.crosshair:before{width:1px;height:110%;top:-5%;left:50%}.crosshair:after{height:1px;width:110%;left:-5%;top:50%}.bullet{position:absolute;left:67%;top:50%;width:4px;height:38px;background:var(--yellow);transform:rotate(18deg);box-shadow:0 0 0 2px #fff8d3;z-index:4;animation:fly .45s linear forwards}@keyframes fly{to{top:22%;opacity:.1}}.notice{position:absolute;top:13%;left:50%;transform:translateX(-50%);font:700 14px 'DM Mono';color:var(--yellow);text-shadow:3px 3px #171b2b;z-index:4;animation:pop .9s ease-out}@keyframes pop{0%{opacity:0;transform:translate(-50%,10px)}25%{opacity:1}100%{opacity:.55;transform:translate(-50%,-7px)}}.map-footer{height:46px;padding:0 7px;display:flex;align-items:center;justify-content:space-between;font:500 10px 'DM Mono';color:#c8c0c2}.fire{border:2px solid #121728;background:var(--yellow);color:var(--ink);padding:9px 12px;font:700 10px 'DM Mono';box-shadow:3px 3px 0 #121728}.fire:hover{background:#ffdb78}.minimap{height:130px;border:2px solid #5f6782;background:#343c57;position:relative;overflow:hidden}.minimap:before{content:"";position:absolute;inset:18px 20px;background:#667365;border:2px solid #111728}.mini-dot{position:absolute;width:7px;height:7px;border-radius:50%;z-index:1}.mini-dot.red{background:var(--red)}.mini-dot.blue{background:var(--blue)}.mini-dot.yellow{background:var(--yellow)}.battle-caption{color:#aeb3c3;line-height:1.5}.battle-caption b{color:#f7ead6}.arena-battle .battle-column:last-child{padding-top:0}@media(max-width:850px){.arena-top{padding:0 15px;height:64px}.arena-brand span{display:none}.arena-pot{display:none}.arena-battle{grid-template-columns:1fr;padding:12px;min-height:calc(100dvh - 64px)}.battle-column{display:grid;grid-template-columns:1fr 1fr;order:2}.game-card{order:1}.game-map{min-height:54vh}.minimap{display:none}.arena-lobby{padding:42px 18px}.arena-lobby-grid{grid-template-columns:1fr;gap:20px}.versus{height:40px}.versus:before{height:2px;width:100%}.versus:after{height:2px;width:100%}.lobby-foot{font-size:9px}.arena-lobby h1{letter-spacing:-3px}.slot{min-height:82px}}
      `}</style>
      <header className="arena-top">
        <div className="arena-brand"><span className="arena-mark">+</span><span>JPO HUDDLE&nbsp; / &nbsp;SQUAD ARENA</span></div>
        <nav className="arena-nav">
          <button className={screen === "lobby" ? "active" : ""} onClick={() => setScreen("lobby")}>SQUAD UP</button>
          <button className={screen === "battle" ? "active" : ""} onClick={() => setScreen("battle")}>LIVE MATCH</button>
        </nav>
        <div className="arena-pot">PRIZE POT&nbsp; 10,000 COINS</div>
      </header>
      {screen === "lobby" ? (
        <section className="arena-lobby">
          <div className="arena-kicker">FRIDAY / 5:30 PM / 4V4 OBJECTIVE MATCH</div>
          <h1>CHOOSE YOUR<br /><em>SQUAD.</em></h1>
          <p className="arena-copy">Two crews. One contested zone. Push together, hold the floor, and split the coin pot when your squad takes the match.</p>
          <div className="arena-lobby-grid">
            {(["red", "blue"] as Team[]).map((side) => (
              <div className={`squad-card ${side}`} key={side}>
                <div className="squad-heading"><h2>{side === "red" ? "RED SHIFT" : "BLUE SHIFT"}</h2><span className="squad-count">{teamMembers[side].filter((member) => member !== "Open").length + (team === side ? 1 : 0)} / 4</span></div>
                <div className="slot-grid">{teamMembers[side].map((member, index) => {
                  const selected = team === side && slot === index;
                  return <button className={`slot ${selected ? "selected" : ""}`} key={`${side}-${index}`} onClick={() => member === "Open" && selectTeam(side)}><span className="slot-avatar" style={{ background: selected ? colors.blue : member === "Open" ? "#fff7e8" : colors[side] }}>{selected ? "YO" : member === "Open" ? "+" : member.slice(0, 2).toUpperCase()}</span><strong>{selected ? "You" : member}</strong><small>{selected ? "Assault" : member === "Open" ? "Claim station" : "Online"}</small></button>;
                })}</div>
                <button className="squad-join" onClick={() => selectTeam(side)}><span>{team === side ? "SQUAD SELECTED" : `JOIN ${side.toUpperCase()}`}</span><span>→</span></button>
              </div>
            ))}
            <div className="versus"><b>VS</b></div>
          </div>
          <div className="lobby-foot"><span>YOUR LOADOUT: <b>ASSAULT / {team.toUpperCase()} / SLOT {slot + 1}</b></span><button className="launch" onClick={() => setScreen("battle")}>ENTER MATCH&nbsp; →</button></div>
        </section>
      ) : (
        <section className="arena-battle">
          <aside className="battle-column">
            <div className="score-card red"><span>RED SHIFT / ATTACK</span><strong>{redScore}</strong></div>
            <div className="team-players">SQUAD<br /><b>MAYA</b> · JON<br />PAYLOAD CARRIER<br /><b>+18 PTS</b></div>
            <div className="stat-card"><b>ROUND 02</b>FIRST TO 100<br />ZONE CONTROL<i /></div>
          </aside>
          <div className="game-card">
            <div className="game-marquee"><span>SQUAD ARENA / MIDTOWN</span><span>02:18</span></div>
            <div className="game-map" onClick={fire}>
              <div className="cover one" /><div className="cover two" /><div className="cover three" /><div className="zone"><b>ZONE A</b></div>
              {mapPlayers.map((player) => <div className={`player ${player.team} ${player.state}`} key={player.name} style={{ left: `${player.left}%`, top: `${player.top}%` }}><span className="body">{player.name.slice(0, 2).toUpperCase()}</span><span className="label">{player.name}</span></div>)}
              <div className="crosshair" style={{ left: "67%", top: "59%" }} />{fired && <div className="bullet" />}<div className="notice" key={notice}>{notice}</div>
            </div>
            <div className="map-footer"><span>WASD MOVE&nbsp; / &nbsp;MOUSE AIM&nbsp; / &nbsp;CLICK SHOOT</span><button className="fire" onClick={fire}>FIRE</button></div>
          </div>
          <aside className="battle-column">
            <div className="score-card blue"><span>BLUE SHIFT / DEFEND</span><strong>{blueScore}</strong></div>
            <div className="minimap"><span className="mini-dot red" style={{ left: "30%", top: "42%" }} /><span className="mini-dot blue" style={{ left: "68%", top: "57%" }} /><span className="mini-dot blue" style={{ left: "74%", top: "29%" }} /><span className="mini-dot yellow" style={{ left: "50%", top: "50%" }} /></div>
            <div className="stat-card"><b>YOUR LOADOUT</b>ASSAULT RIFLE<br />HEALTH 84 / 100<i /></div>
            <div className="battle-caption">Your squad wins if you hold <b>ZONE A</b> for 20 more seconds.</div>
          </aside>
        </section>
      )}
    </main>
  );
}