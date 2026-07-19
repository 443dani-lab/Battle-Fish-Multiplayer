// Authoritative arena: the SERVER owns every fish, pellet, the eating rules — and the bots.
const { Room } = require("colyseus");
const { Schema, MapSchema, defineTypes } = require("@colyseus/schema");

const WORLD = 1600;
const START_SIZE = 20;
const MAX_SIZE = 220;
const MIN_FISH = 8;          // arena never feels emptier than this
const MAX_BOTS = 12;
const PELLET_COUNT = 60;     // food dots scattered around
const PELLET_GROW = 1.2;
const BOT_SOFT_CAP = 70;     // bots slowly shrink above this so one can't rule forever
const BOT_NAMES = ["Bubbles","Finn","Chomp","Nibbles","Snapper","Gill","Marlin","Coral","Pike","Moby","Squirt","Fang"];

class Player extends Schema {
  constructor() {
    super();
    this.x = Math.random() * WORLD;
    this.y = Math.random() * WORLD;
    this.size = START_SIZE;
    this.name = "Fish";
    this.color = "#" + Math.floor(Math.random() * 16777215).toString(16).padStart(6, "0");
    this.score = 0;
  }
}
defineTypes(Player, {
  x: "number", y: "number", size: "number",
  name: "string", color: "string", score: "number"
});

class Pellet extends Schema {
  constructor() {
    super();
    this.x = Math.random() * WORLD;
    this.y = Math.random() * WORLD;
  }
}
defineTypes(Pellet, { x: "number", y: "number" });

class GameState extends Schema {
  constructor() {
    super();
    this.players = new MapSchema();
    this.pellets = new MapSchema();
    this.online = 0;                 // real humans connected
  }
}
defineTypes(GameState, { players: { map: Player }, pellets: { map: Pellet }, online: "number" });

// ---- pure, unit-testable rules ----
function resolveCollisions(players, world) {
  const events = [];
  for (let i = 0; i < players.length; i++) {
    for (let j = i + 1; j < players.length; j++) {
      const a = players[i], b = players[j];
      let big, small;
      if (a.size > b.size * 1.1) { big = a; small = b; }
      else if (b.size > a.size * 1.1) { big = b; small = a; }
      else continue;
      const dx = big.x - small.x, dy = big.y - small.y;
      if (Math.sqrt(dx * dx + dy * dy) < big.size) {
        big.size = Math.min(MAX_SIZE, big.size + small.size * 0.5);
        big.score = (big.score || 0) + Math.round(small.size);
        events.push({ big, small });
        small.size = START_SIZE;
        small.x = Math.random() * world;
        small.y = Math.random() * world;
      }
    }
  }
  return events;
}

function eatPellets(players, pellets, world) {
  let eaten = 0;
  for (let i = 0; i < players.length; i++) {
    const pl = players[i];
    for (let j = 0; j < pellets.length; j++) {
      const pe = pellets[j];
      const dx = pl.x - pe.x, dy = pl.y - pe.y;
      if (dx * dx + dy * dy < pl.size * pl.size) {
        pl.size = Math.min(MAX_SIZE, pl.size + PELLET_GROW);
        pl.score = (pl.score || 0) + 1;
        pe.x = Math.random() * world;
        pe.y = Math.random() * world;
        eaten++;
      }
    }
  }
  return eaten;
}

class GameRoom extends Room {
  onCreate() {
    this.maxClients = 50;
    this.setState(new GameState());
    this.bots = new Map();           // botId -> brain { tx, ty, repath }
    this.botSeq = 0;
    for (let i = 0; i < PELLET_COUNT; i++) this.state.pellets.set("f" + i, new Pellet());

    this.onMessage("move", (client, data) => {
      const p = this.state.players.get(client.sessionId);
      if (!p) return;
      p.x = Math.max(0, Math.min(WORLD, Number(data.x)));
      p.y = Math.max(0, Math.min(WORLD, Number(data.y)));
    });

    // server game loop ~20x/sec
    this.setSimulationInterval(() => {
      this.updateBots();
      const arr = [], ids = [];
      this.state.players.forEach((p, id) => { arr.push(p); ids.push(id); });
      const pel = [];
      this.state.pellets.forEach((pe) => pel.push(pe));
      eatPellets(arr, pel, WORLD);
      const events = resolveCollisions(arr, WORLD);
      for (let k = 0; k < events.length; k++) {
        const ev = events[k];
        this.broadcast("eat", {
          eater: ids[arr.indexOf(ev.big)],  eaterName: ev.big.name,
          victim: ids[arr.indexOf(ev.small)], victimName: ev.small.name
        });
      }
    }, 50);
  }

  addBot() {
    const id = "bot-" + (++this.botSeq);
    const p = new Player();
    p.name = BOT_NAMES[Math.floor(Math.random() * BOT_NAMES.length)];
    p.size = 16 + Math.random() * 40;
    this.state.players.set(id, p);
    this.bots.set(id, { tx: p.x, ty: p.y, repath: 0 });
  }

  removeBot() {
    const id = this.bots.keys().next().value;
    if (!id) return;
    this.bots.delete(id);
    this.state.players.delete(id);
  }

  updateBots() {
    const real = this.state.players.size - this.bots.size;
    const want = Math.max(0, Math.min(MAX_BOTS, MIN_FISH - real));
    while (this.bots.size < want) this.addBot();
    while (this.bots.size > want) this.removeBot();

    const now = Date.now();
    this.bots.forEach((brain, id) => {
      const b = this.state.players.get(id);
      if (!b) { this.bots.delete(id); return; }
      if (b.size > BOT_SOFT_CAP) b.size = Math.max(BOT_SOFT_CAP, b.size - 0.08);  // gentle decay

      let prey = null, preyD = 350, threat = null, threatD = 260;
      this.state.players.forEach((o, oid) => {
        if (oid === id) return;
        const dx = o.x - b.x, dy = o.y - b.y;
        const d = Math.sqrt(dx * dx + dy * dy);
        if (b.size > o.size * 1.15 && d < preyD) { prey = o; preyD = d; }
        if (o.size > b.size * 1.15 && d < threatD) { threat = o; threatD = d; }
      });

      let tx, ty;
      if (threat) { tx = b.x + (b.x - threat.x) * 3; ty = b.y + (b.y - threat.y) * 3; }
      else if (prey) { tx = prey.x; ty = prey.y; }
      else {
        if (now > brain.repath || (Math.abs(brain.tx - b.x) < 30 && Math.abs(brain.ty - b.y) < 30)) {
          brain.tx = Math.random() * WORLD;
          brain.ty = Math.random() * WORLD;
          brain.repath = now + 3000 + Math.random() * 5000;
        }
        tx = brain.tx; ty = brain.ty;
      }

      const dx = tx - b.x, dy = ty - b.y;
      const d = Math.sqrt(dx * dx + dy * dy) || 1;
      const spd = Math.max(3, 11 - b.size * 0.03);
      const step = Math.min(spd, d);
      b.x = Math.max(0, Math.min(WORLD, b.x + dx / d * step));
      b.y = Math.max(0, Math.min(WORLD, b.y + dy / d * step));
    });
  }

  onJoin(client, options) {
    this.state.online = this.clients.length;
    if (options && options.presence) return;       // menu browsers: count only, no fish
    const p = new Player();
    if (options && options.name) p.name = String(options.name).slice(0, 16);
    this.state.players.set(client.sessionId, p);
    console.log(`+ ${p.name} joined (${this.state.players.size} fish, ${this.state.online} online)`);
  }

  onLeave(client) {
    this.state.players.delete(client.sessionId);
    this.state.online = this.clients.length;
  }
}
module.exports = { GameRoom, resolveCollisions, eatPellets, WORLD, START_SIZE };
