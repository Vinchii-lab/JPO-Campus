// Pet Race test bots — auto-join any race lobby and place a small random bet.
// Run via the "Pet Race Bots" workflow (or: node race_bots.cjs).
const { io } = require("socket.io-client");
const URL = "http://localhost:" + (process.env.JPO_PORT || 20158);
const PW  = "rlglbotpw123";
const rnd = (a, b) => Math.floor(a + Math.random() * (b - a));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

const BOTS = [
  { name: "Jepoy Bot",   email: "botjepoy@test.local"    },
  { name: "Marites Bot", email: "botmarites@test.local"  },
  { name: "Dodong Bot",  email: "botdodong@test.local"   },
  { name: "Inday Bot",   email: "botinday@test.local"    },
  { name: "Bunny Bot",   email: "botbunny@test.local"    },
  { name: "CatSnow Bot", email: "botcatsnow@test.local"  },
  { name: "Choco Bot",   email: "botdogchoco@test.local" },
  { name: "Duck Bot",    email: "botduck@test.local"     },
  { name: "Turtle Bot",  email: "botturtle@test.local"   },
  { name: "Dragon Bot",  email: "botdragon2@test.local"  },
];

function mkBot(cfg) {
  const s = io(URL, { transports: ["websocket"], reconnection: true, reconnectionDelay: 2000 });
  let _entrants = [];  // full entrant objects {id (socket), name, petId, ...}
  let _betPlaced = false;

  s.on("buildStamp",  () => s.emit("clientBuild"));
  s.on("connect",     () => { _entrants = []; _betPlaced = false; s.emit("login", { email: cfg.email, password: PW }); });
  s.on("approved",    () => log(cfg.name, "in the office 🏢"));
  s.on("loginFail",   d  => log(cfg.name, "login failed:", JSON.stringify(d)));

  s.on("raceLobby", ({ entrants }) => {
    _entrants = entrants || [];
    _betPlaced = false;
    // Join after a short random delay so they don't all pile in at once
    setTimeout(() => {
      log(cfg.name, "joining race 🐾");
      s.emit("raceJoin");
    }, rnd(600, 3000));
  });

  // When new entrants arrive, update the local list so late bets pick the right IDs
  s.on("raceEntrantUpdate", ({ entrants }) => {
    _entrants = entrants || [];
    // Place a bet once we see at least 2 racers and haven't bet yet
    if (!_betPlaced && _entrants.length >= 2) {
      _betPlaced = true;
      setTimeout(() => {
        if (!_entrants.length) return;
        const target = _entrants[rnd(0, _entrants.length)];
        const coins  = rnd(50, 250);
        log(cfg.name, `betting ${coins} on ${target.name} (${target.petId})`);
        s.emit("raceBet", { onId: target.id, amount: coins });
      }, rnd(500, 3000));
    }
  });

  s.on("raceJoinOk",  ()  => log(cfg.name, "joined! 🏁"));
  s.on("raceJoinErr", msg => log(cfg.name, "join err:", msg));
  s.on("raceBetAck",  d   => log(cfg.name, `bet locked ✅ (${d.amount} on ${d.onId})`));
  s.on("raceBetErr",  msg => log(cfg.name, "bet err:", msg));
  s.on("raceHeatStart", d => log(cfg.name, `heat ${d.heatNum} starting 🔥`));
  s.on("raceFinalStart",()  => log(cfg.name, "FINAL! 🏆"));
  s.on("raceResult",  d   => log(cfg.name, `race over — winner: ${d.winnerId} | pot: ${d.pot}`));
  s.on("racePayout",  d   => log(cfg.name, `💰 payout: +${d.amount} coins`));
  s.on("raceCancelled", () => log(cfg.name, "race cancelled 😢"));

  return s;
}

BOTS.forEach((c, i) => setTimeout(() => mkBot(c), i * 800));
log("Race bots connecting to", URL);
