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
const DECAY_BASE = 26;       // everyone above this slowly shrinks — big fish must hunt or fade
const DECAY_RATE = 0.0009;   // per tick, proportional to how far above base
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
    this.kills = 0;
    this.deaths = 0;
  }
}
defineTypes(Player, {
  x: "number", y: "number", size: "number",
  name: "string", color: "string", score: "number",
  kills: "number", deaths: "number"
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
        big.kills = (big.kills || 0) + 1;
        small.deaths = (small.deaths || 0) + 1;
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
        const grow = Math.max(0.3, PELLET_GROW * (START_SIZE / pl.size));
        pl.size = Math.min(MAX_SIZE, pl.size + grow);
        pl.score = (pl.score || 0) + 1;
        pe.x = Math.random() * world;
        pe.y = Math.random() * world;
        eaten++;
      }
    }
  }
  return eaten;
}

function applyDecay(players) {
  for (let i = 0; i < players.length; i++) {
    const p = players[i];
    if (p.size > DECAY_BASE) p.size = Math.max(DECAY_BASE, p.size - (p.size - DECAY_BASE) * DECAY_RATE);
  }
}

class GameRoom extends Room {
  onCreate() {
    console.log("[BF] GameRoom v7 (career stats → cloud) live");
    this.maxClients = 50;
    this.setState(new GameState());
    this.bots = new Map();           // botId -> brain { tx, ty, repath }
    this.botSeq = 0;
    this.tokens = new Map();          // sessionId -> { token, uid }  (player-supplied Firebase ID token)
    this.pending = new Map();         // sessionId -> { kills, deaths } awaiting cloud flush
    this.onMessage("auth", (client, data) => {
      const token = data && typeof data.token === "string" ? data.token : null;
      const uid = token ? decodeIdTokenUid(token) : null;
      if (!uid) return;
      this.tokens.set(client.sessionId, { token, uid });
      if (!this.pending.has(client.sessionId)) this.pending.set(client.sessionId, { kills: 0, deaths: 0 });
      console.log(`[BF] stats tracking on for ${uid.slice(0, 8)}…`);
    });
    this.clock.setInterval(() => this.flushAllStats(), 10000);
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
      applyDecay(arr);
      const pel = [];
      this.state.pellets.forEach((pe) => pel.push(pe));
      eatPellets(arr, pel, WORLD);
      const events = resolveCollisions(arr, WORLD);
      for (let k = 0; k < events.length; k++) {
        const ev = events[k];
        const eaterId = ids[arr.indexOf(ev.big)], victimId = ids[arr.indexOf(ev.small)];
        this.broadcast("eat", {
          eater: eaterId,  eaterName: ev.big.name,
          victim: victimId, victimName: ev.small.name
        });
        const pk = this.pending.get(eaterId); if (pk && this.tokens.has(eaterId)) pk.kills++;
        const pd = this.pending.get(victimId); if (pd && this.tokens.has(victimId)) pd.deaths++;
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
    this.flushStats(client.sessionId);
    this.tokens.delete(client.sessionId);
    this.pending.delete(client.sessionId);
    this.state.players.delete(client.sessionId);
    this.state.online = this.clients.length;
  }

  flushAllStats() { this.tokens.forEach((_, sid) => this.flushStats(sid)); }

  flushStats(sid) {
    const auth = this.tokens.get(sid), pend = this.pending.get(sid);
    if (!auth || !pend || (pend.kills === 0 && pend.deaths === 0)) return;
    const k = pend.kills, d = pend.deaths;
    pend.kills = 0; pend.deaths = 0;
    statsCommit(auth.uid, auth.token, k, d).catch((e) => {
      console.warn(`[BF] stat save failed for ${auth.uid.slice(0, 8)}…:`, e && e.message);
    });
  }
}
/* ---- career stats -> Firestore (uses the PLAYER'S OWN ID token; owner-only rules still apply) ---- */
const FIRESTORE_COMMIT = "https://firestore.googleapis.com/v1/projects/battle-fish-royale/databases/(default)/documents:commit";
function decodeIdTokenUid(token) {
  try {
    const part = token.split(".")[1];
    const json = JSON.parse(Buffer.from(part.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
    return json.user_id || json.sub || null;
  } catch (e) { return null; }
}
function statsCommitBody(uid, kills, deaths) {
  return {
    writes: [{
      transform: {
        document: `projects/battle-fish-royale/databases/(default)/documents/users/${uid}`,
        fieldTransforms: [
          { fieldPath: "srvKills",  increment: { integerValue: String(kills) } },
          { fieldPath: "srvDeaths", increment: { integerValue: String(deaths) } },
          { fieldPath: "statsAt",   setToServerValue: "REQUEST_TIME" }
        ]
      }
    }]
  };
}
async function statsCommit(uid, token, kills, deaths) {
  if (typeof fetch !== "function") throw new Error("global fetch unavailable (need Node 18+)");
  const res = await fetch(FIRESTORE_COMMIT, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": "Bearer " + token },
    body: JSON.stringify(statsCommitBody(uid, kills, deaths))
  });
  if (!res.ok) throw new Error("HTTP " + res.status + " " + (await res.text()).slice(0, 120));
}

module.exports = { GameRoom, resolveCollisions, eatPellets, applyDecay, WORLD, START_SIZE, decodeIdTokenUid, statsCommitBody, statsCommit };
