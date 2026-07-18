// Authoritative arena: the SERVER owns every fish, its size, and the eating rule.
const { Room } = require("colyseus");
const { Schema, MapSchema, defineTypes } = require("@colyseus/schema");

const WORLD = 1600;        // bounded square arena (players share this space)
const START_SIZE = 20;
const MAX_SIZE = 220;

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

class GameState extends Schema {
  constructor() { super(); this.players = new MapSchema(); }
}
defineTypes(GameState, { players: { map: Player } });

// ---- pure eating logic (exported so it can be unit-tested) ----
function resolveCollisions(players, world) {
  for (let i = 0; i < players.length; i++) {
    for (let j = i + 1; j < players.length; j++) {
      const a = players[i], b = players[j];
      let big, small;
      if (a.size > b.size * 1.1) { big = a; small = b; }
      else if (b.size > a.size * 1.1) { big = b; small = a; }
      else continue;                                   // too close in size — no eat
      const dx = big.x - small.x, dy = big.y - small.y;
      if (Math.sqrt(dx * dx + dy * dy) < big.size) {   // small's centre is inside big
        big.size = Math.min(MAX_SIZE, big.size + small.size * 0.5);
        big.score = (big.score || 0) + Math.round(small.size);
        small.size = START_SIZE;                       // eaten fish respawns small elsewhere
        small.x = Math.random() * world;
        small.y = Math.random() * world;
      }
    }
  }
}

class GameRoom extends Room {
  onCreate() {
    this.maxClients = 50;
    this.setState(new GameState());

    this.onMessage("move", (client, data) => {
      const p = this.state.players.get(client.sessionId);
      if (!p) return;
      p.x = Math.max(0, Math.min(WORLD, Number(data.x)));
      p.y = Math.max(0, Math.min(WORLD, Number(data.y)));
    });

    // server game loop ~20x/sec: run the eating rule authoritatively
    this.setSimulationInterval(() => {
      const arr = [];
      this.state.players.forEach((p) => arr.push(p));
      resolveCollisions(arr, WORLD);
    }, 50);
  }

  onJoin(client, options) {
    const p = new Player();
    if (options && options.name) p.name = String(options.name).slice(0, 16);
    this.state.players.set(client.sessionId, p);
    console.log(`+ ${p.name} joined (${this.state.players.size} fish)`);
  }
  onLeave(client) { this.state.players.delete(client.sessionId); }
}
module.exports = { GameRoom, resolveCollisions, WORLD, START_SIZE };
