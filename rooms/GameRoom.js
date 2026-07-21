// Battle Fish arena — v10 FULL LOADOUT (2026-07-21).
// The arena now carries the main game's starter loadout so skills transfer 1:1:
//   PRIMARY  = lock & shoot (server auto-locks nearest live opponent within
//              LOCK_RANGE and auto-fires — no button, exactly like the game).
//   SPECIAL  = 🚀 tap-fire side weapon (aims at lock target). 55 dmg, 3s cd.
//   GRENADE  = 💣 tap-drop depth grenade. 1.1s fuse → 150px blast, 70 dmg,
//              OWNER IMMUNE (matches the game's player-immune depth grenade).
//   TRAIL    = ☠️ poison trail. Tap → lays toxic segments behind you for 4s;
//              each segment lives 7s (main-game buff duration) and deals DoT
//              to enemies crossing it. You are immune to your own trail.
//
// Kill credit is unified: projectile, grenade, and poison kills all route
// through the same onKill → broadcast('eat', {eater, eaterName, victim,
// victimName}) → pending tally → Firestore INCREMENT flush. The whole K/D
// pipeline (v7) is untouched; the game side needs zero changes.

const { Room } = require("colyseus");
const { Schema, MapSchema, defineTypes } = require("@colyseus/schema");
const https = require("https");

const WORLD          = 1600;
const FISH_SIZE      = 34;
const FISH_HP        = 100;
const MOVE_SPEED     = 220;
const LOCK_RANGE     = 420;
const FIRE_CD        = 0.35;
const SHOT_SPEED     = 520;
const SHOT_DMG       = 22;      // 5 primary hits to kill
const SHOT_TTL       = 1.5;
const SHOT_R         = 3;
const SPECIAL_CD     = 3.0;
const SPECIAL_DMG    = 55;
const SPECIAL_SPEED  = 460;
const SPECIAL_TTL    = 1.8;
const SPECIAL_R      = 9;
const GRENADE_CD     = 6.0;     // 💣 tool cooldown
const GRENADE_FUSE   = 1.1;     // seconds until detonation
const GRENADE_R      = 150;     // blast radius
const GRENADE_DMG    = 70;      // kills anything ≤70 hp
const TRAIL_CD       = 9.0;     // ☠️ tool cooldown
const TRAIL_ACTIVE   = 4.0;     // seconds of laying after activation
const TRAIL_DROP     = 0.09;    // seconds between segments while laying
const TRAIL_SEG_TTL  = 7.0;     // segment lifetime (main-game 7s buff)
const TRAIL_SEG_R    = 18;      // segment radius
const POISON_DPS     = 14;      // DoT while standing in a segment
const RESPAWN_DELAY  = 2.5;
const MIN_FISH       = 8;
const MAX_BOTS       = 12;
const BOT_SPECIAL_RANGE = 260;
const BOT_GRENADE_RANGE = 170;
const BOT_NAMES = [
  "Bubbles","Finn","Chomp","Nibbles","Snapper","Gill",
  "Marlin","Coral","Pike","Moby","Squirt","Fang"
];

// ---- Firebase ID-token uid decode (JWT payload middle segment) ---------------
function decodeIdTokenUid(jwt) {
  try {
    const parts = String(jwt).split(".");
    if (parts.length !== 3) return null;
    let b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    while (b64.length % 4) b64 += "=";
    const json = JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
    return json && (json.user_id || json.sub || null);
  } catch (e) { return null; }
}

// ---- Schema ------------------------------------------------------------------
class Player extends Schema {
  constructor() {
    super();
    this.x         = Math.random() * WORLD;
    this.y         = Math.random() * WORLD;
    this.size      = FISH_SIZE;
    this.name      = "Fish";
    this.color     = "#" + Math.floor(Math.random() * 16777215).toString(16).padStart(6, "0");
    this.score     = 0;
    this.kills     = 0;
    this.deaths    = 0;
    this.hp        = FISH_HP;
    this.maxHp     = FISH_HP;
    this.ang       = 0;
    this.fireCd    = 0;
    this.specialCd = 0;
    this.grenadeCd = 0;         // 💣 synced so the client slot shows the countdown
    this.trailCd   = 0;         // ☠️ synced cooldown
    this.trailT    = 0;         // ☠️ seconds of active laying remaining (synced → button glow)
    this.lockId    = "";
    this.respawnT  = 0;
  }
}
defineTypes(Player, {
  x: "number", y: "number", size: "number",
  name: "string", color: "string", score: "number",
  kills: "number", deaths: "number",
  hp: "number", maxHp: "number", ang: "number",
  fireCd: "number", specialCd: "number", grenadeCd: "number",
  trailCd: "number", trailT: "number",
  lockId: "string", respawnT: "number"
});

class Projectile extends Schema {
  constructor() {
    super();
    this.x = 0; this.y = 0;
    this.vx = 0; this.vy = 0;
    this.owner = "";
    this.ttl = SHOT_TTL;
    this.kind = "p";            // "p" primary · "s" special
    this.r = SHOT_R;
  }
}
defineTypes(Projectile, {
  x: "number", y: "number", vx: "number", vy: "number",
  owner: "string", ttl: "number", kind: "string", r: "number"
});

class Grenade extends Schema {
  constructor() {
    super();
    this.x = 0; this.y = 0;
    this.fuse = GRENADE_FUSE;
    this.owner = "";
  }
}
defineTypes(Grenade, { x: "number", y: "number", fuse: "number", owner: "string" });

class TrailSeg extends Schema {
  constructor() {
    super();
    this.x = 0; this.y = 0;
    this.ttl = TRAIL_SEG_TTL;
    this.owner = "";
  }
}
defineTypes(TrailSeg, { x: "number", y: "number", ttl: "number", owner: "string" });

class GameState extends Schema {
  constructor() {
    super();
    this.players     = new MapSchema();
    this.projectiles = new MapSchema();
    this.grenades    = new MapSchema();
    this.trails      = new MapSchema();
    this.online      = 0;
  }
}
defineTypes(GameState, {
  players:     { map: Player },
  projectiles: { map: Projectile },
  grenades:    { map: Grenade },
  trails:      { map: TrailSeg },
  online:      "number"
});

// ---- Pure tick functions -----------------------------------------------------
function respawnPlayer(p) {
  p.hp = p.maxHp;
  p.x = Math.random() * WORLD;
  p.y = Math.random() * WORLD;
  p.fireCd = 0;
  p.specialCd = 0;
  p.grenadeCd = 0;
  p.trailCd = 0;
  p.trailT = 0;
  p.lockId = "";
  p.respawnT = 0;
}

// Shared lethal-hit bookkeeping: any damage source that zeroes a fish routes
// through here so projectile / grenade / poison kills are indistinguishable to
// the K/D pipeline.
function applyLethal(state, victim, victimId, ownerId, emitKill) {
  victim.respawnT = RESPAWN_DELAY;
  victim.deaths = (victim.deaths || 0) + 1;
  const killer = state.players.get(ownerId);
  if (killer) killer.kills = (killer.kills || 0) + 1;
  emitKill(ownerId, victimId);
}

function tickPlayers(state, dt) {
  state.players.forEach((p) => {
    if (p.fireCd > 0)    p.fireCd    = Math.max(0, p.fireCd - dt);
    if (p.specialCd > 0) p.specialCd = Math.max(0, p.specialCd - dt);
    if (p.grenadeCd > 0) p.grenadeCd = Math.max(0, p.grenadeCd - dt);
    if (p.trailCd > 0)   p.trailCd   = Math.max(0, p.trailCd - dt);
    if (p.hp <= 0 && p.respawnT > 0) {
      p.respawnT = Math.max(0, p.respawnT - dt);
      if (p.respawnT <= 0) respawnPlayer(p);
    }
  });
}

// ☠️ While trailT > 0, lay a segment at the fish's position every TRAIL_DROP s.
// lay(ownerId, x, y) is supplied by the room (it owns the id sequence).
function tickTrailLay(state, dt, lay) {
  state.players.forEach((p, id) => {
    if (p.hp <= 0) { p.trailT = 0; return; }
    if (p.trailT <= 0) return;
    p.trailT = Math.max(0, p.trailT - dt);
    p._trailAcc = (p._trailAcc || 0) + dt;
    while (p._trailAcc >= TRAIL_DROP) {
      p._trailAcc -= TRAIL_DROP;
      lay(id, p.x, p.y);
    }
  });
}

function tickAutoFire(state, fire) {
  state.players.forEach((p, id) => {
    if (p.hp <= 0) { p.lockId = ""; return; }
    let best = null, bestD = LOCK_RANGE, bestId = "";
    state.players.forEach((o, oid) => {
      if (oid === id || o.hp <= 0) return;
      const dx = o.x - p.x, dy = o.y - p.y;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d < bestD) { best = o; bestD = d; bestId = oid; }
    });
    p.lockId = bestId;
    if (best) {
      p.ang = Math.atan2(best.y - p.y, best.x - p.x);
      if (p.fireCd <= 0) fire(id, p, p.ang);
    }
  });
}

function tickProjectiles(state, dt, emitKill) {
  const toRemove = [];
  state.projectiles.forEach((pr, id) => {
    pr.x += pr.vx * dt;
    pr.y += pr.vy * dt;
    pr.ttl -= dt;
    if (pr.ttl <= 0 || pr.x < 0 || pr.x > WORLD || pr.y < 0 || pr.y > WORLD) {
      toRemove.push(id);
      return;
    }
    let consumed = false;
    state.players.forEach((pl, plId) => {
      if (consumed) return;
      if (plId === pr.owner) return;
      if (pl.hp <= 0) return;
      const dx = pl.x - pr.x, dy = pl.y - pr.y;
      const rr = pl.size + (pr.r || 0);
      if (dx * dx + dy * dy < rr * rr) {
        const dmg = pr.kind === "s" ? SPECIAL_DMG : SHOT_DMG;
        pl.hp = Math.max(0, pl.hp - dmg);
        consumed = true;
        toRemove.push(id);
        if (pl.hp <= 0) applyLethal(state, pl, plId, pr.owner, emitKill);
      }
    });
  });
  toRemove.forEach((id) => state.projectiles.delete(id));
}

// 💣 fuse countdown → area blast. Owner immune. onBoom(x, y, r) lets the room
// broadcast a detonation cue for the client's explosion ring.
function tickGrenades(state, dt, onBoom, emitKill) {
  const toRemove = [];
  state.grenades.forEach((g, id) => {
    g.fuse -= dt;
    if (g.fuse > 0) return;
    toRemove.push(id);
    onBoom(g.x, g.y, GRENADE_R);
    state.players.forEach((pl, plId) => {
      if (plId === g.owner) return;                       // player immune to own grenade
      if (pl.hp <= 0) return;
      const dx = pl.x - g.x, dy = pl.y - g.y;
      if (dx * dx + dy * dy < GRENADE_R * GRENADE_R) {
        pl.hp = Math.max(0, pl.hp - GRENADE_DMG);
        if (pl.hp <= 0) applyLethal(state, pl, plId, g.owner, emitKill);
      }
    });
  });
  toRemove.forEach((id) => state.grenades.delete(id));
}

// ☠️ segments age out; enemies inside take POISON_DPS. Owner immune. Poison
// kills credit the trail's owner through the same pipeline.
// NO STACKING: adjacent segments overlap by design (laid every 0.09s), so a
// fish standing in the trail is inside 2-3 segments at once — damage is capped
// at ONE dose per player per tick or the trail would be 2-3× more lethal than
// the stated POISON_DPS.
function tickTrails(state, dt, emitKill) {
  const toRemove = [];
  const dosed = {};                                       // plId -> already poisoned this tick
  state.trails.forEach((t, id) => {
    t.ttl -= dt;
    if (t.ttl <= 0) { toRemove.push(id); return; }
    state.players.forEach((pl, plId) => {
      if (dosed[plId]) return;                            // one dose per tick, no overlap stacking
      if (plId === t.owner) return;                       // immune to own trail
      if (pl.hp <= 0) return;
      const dx = pl.x - t.x, dy = pl.y - t.y;
      const rr = TRAIL_SEG_R + pl.size * 0.4;
      if (dx * dx + dy * dy < rr * rr) {
        dosed[plId] = true;
        pl.hp = Math.max(0, pl.hp - POISON_DPS * dt);
        if (pl.hp <= 0) applyLethal(state, pl, plId, t.owner, emitKill);
      }
    });
  });
  toRemove.forEach((id) => state.trails.delete(id));
}

class GameRoom extends Room {
  onCreate() {
    console.log("[BF] GameRoom v10 (FULL LOADOUT) live");
    this.maxClients = 50;
    this.setState(new GameState());
    this.bots    = new Map();
    this.botSeq  = 0;
    this.projSeq = 0;
    this.grenSeq = 0;
    this.trailSeq = 0;
    this.tokens  = new Map();
    this.pending = new Map();

    this.onMessage("auth", (client, data) => {
      const token = data && typeof data.token === "string" ? data.token : null;
      const uid = token ? decodeIdTokenUid(token) : null;
      if (!uid) return;
      this.tokens.set(client.sessionId, { token, uid });
      if (!this.pending.has(client.sessionId)) this.pending.set(client.sessionId, { kills: 0, deaths: 0 });
      console.log(`[BF] stats tracking on for ${uid.slice(0, 8)}…`);
    });

    this.onMessage("move", (client, data) => {
      const p = this.state.players.get(client.sessionId);
      if (!p || p.hp <= 0) return;
      if (typeof data.x === "number") p.x = Math.max(0, Math.min(WORLD, data.x));
      if (typeof data.y === "number") p.y = Math.max(0, Math.min(WORLD, data.y));
      if (typeof data.ang === "number" && !p.lockId) p.ang = data.ang;
    });

    // 🚀 special — tap-fire, aims at the lock target
    this.onMessage("special", (client) => {
      const p = this.state.players.get(client.sessionId);
      if (!p || p.hp <= 0 || p.specialCd > 0) return;
      this.fireSpecial(client.sessionId, p);
    });

    // 💣 grenade — tap-drop at the fish's position, fuse then blast
    this.onMessage("grenade", (client) => {
      const p = this.state.players.get(client.sessionId);
      if (!p || p.hp <= 0 || p.grenadeCd > 0) return;
      this.dropGrenade(client.sessionId, p);
    });

    // ☠️ trail — tap to start laying poison behind you for TRAIL_ACTIVE seconds
    this.onMessage("trail", (client) => {
      const p = this.state.players.get(client.sessionId);
      if (!p || p.hp <= 0 || p.trailCd > 0) return;
      p.trailT = TRAIL_ACTIVE;
      p.trailCd = TRAIL_CD;
      p._trailAcc = 0;
    });

    this.clock.setInterval(() => this.flushAllStats(), 10000);

    const dt = 0.05;
    this.setSimulationInterval(() => {
      this.updateBots(dt);
      tickPlayers(this.state, dt);
      tickTrailLay(this.state, dt, (id, x, y) => this.layTrailSeg(id, x, y));
      tickAutoFire(this.state, (id, p, ang) => {
        this.spawnShot(id, p, ang, "p");
        p.fireCd = FIRE_CD;
      });
      tickProjectiles(this.state, dt, (e, v) => this.onKill(e, v));
      tickGrenades(this.state, dt, (x, y, r) => this.broadcast("boom", { x, y, r }),
                   (e, v) => this.onKill(e, v));
      tickTrails(this.state, dt, (e, v) => this.onKill(e, v));
    }, 50);
  }

  spawnShot(ownerId, ownerPlayer, ang, kind) {
    const id = "s" + (++this.projSeq);
    const pr = new Projectile();
    const speed = kind === "s" ? SPECIAL_SPEED : SHOT_SPEED;
    pr.x = ownerPlayer.x + Math.cos(ang) * (ownerPlayer.size + 4);
    pr.y = ownerPlayer.y + Math.sin(ang) * (ownerPlayer.size + 4);
    pr.vx = Math.cos(ang) * speed;
    pr.vy = Math.sin(ang) * speed;
    pr.owner = ownerId;
    pr.kind = kind || "p";
    pr.ttl = kind === "s" ? SPECIAL_TTL : SHOT_TTL;
    pr.r = kind === "s" ? SPECIAL_R : SHOT_R;
    this.state.projectiles.set(id, pr);
  }

  fireSpecial(sessionId, p) {
    let ang = p.ang;
    if (p.lockId) {
      const t = this.state.players.get(p.lockId);
      if (t && t.hp > 0) ang = Math.atan2(t.y - p.y, t.x - p.x);
    }
    this.spawnShot(sessionId, p, ang, "s");
    p.specialCd = SPECIAL_CD;
  }

  dropGrenade(sessionId, p) {
    const id = "g" + (++this.grenSeq);
    const g = new Grenade();
    g.x = p.x; g.y = p.y;
    g.fuse = GRENADE_FUSE;
    g.owner = sessionId;
    this.state.grenades.set(id, g);
    p.grenadeCd = GRENADE_CD;
  }

  layTrailSeg(ownerId, x, y) {
    const id = "t" + (++this.trailSeq);
    const t = new TrailSeg();
    t.x = x; t.y = y;
    t.ttl = TRAIL_SEG_TTL;
    t.owner = ownerId;
    this.state.trails.set(id, t);
  }

  onKill(eaterId, victimId) {
    const pk = this.pending.get(eaterId); if (pk && this.tokens.has(eaterId)) pk.kills++;
    const pd = this.pending.get(victimId); if (pd && this.tokens.has(victimId)) pd.deaths++;
    const shooter = this.state.players.get(eaterId);
    const victim = this.state.players.get(victimId);
    this.broadcast("eat", {
      eater: eaterId,   eaterName: shooter ? shooter.name : "?",
      victim: victimId, victimName: victim ? victim.name : "?"
    });
  }

  addBot() {
    const id = "bot-" + (++this.botSeq);
    const p = new Player();
    p.name = BOT_NAMES[Math.floor(Math.random() * BOT_NAMES.length)];
    this.state.players.set(id, p);
    this.bots.set(id, { tx: p.x, ty: p.y, repath: 0 });
  }

  removeBot() {
    const id = this.bots.keys().next().value;
    if (!id) return;
    this.bots.delete(id);
    this.state.players.delete(id);
  }

  updateBots(dt) {
    const real = this.state.players.size - this.bots.size;
    const want = Math.max(0, Math.min(MAX_BOTS, MIN_FISH - real));
    while (this.bots.size < want) this.addBot();
    while (this.bots.size > want) this.removeBot();

    const now = Date.now();
    this.bots.forEach((brain, id) => {
      const b = this.state.players.get(id);
      if (!b) { this.bots.delete(id); return; }
      if (b.hp <= 0) return;

      const target = b.lockId ? this.state.players.get(b.lockId) : null;
      let tx, ty;
      if (target && target.hp > 0) {
        const dx = target.x - b.x, dy = target.y - b.y;
        const d = Math.sqrt(dx * dx + dy * dy) || 1;
        if (d < BOT_SPECIAL_RANGE && b.specialCd <= 0 && Math.random() < 0.03) {
          this.fireSpecial(id, b);
          b.specialCd = SPECIAL_CD + 2 + Math.random() * 2;
        }
        if (d < BOT_GRENADE_RANGE && b.grenadeCd <= 0 && Math.random() < 0.02) {
          this.dropGrenade(id, b);
          b.grenadeCd = GRENADE_CD + 2 + Math.random() * 3;
        }
        if (d < 320 && b.trailCd <= 0 && Math.random() < 0.008) {
          b.trailT = TRAIL_ACTIVE;
          b.trailCd = TRAIL_CD + 3;
          b._trailAcc = 0;
        }
        if (d > 280)      { tx = target.x;      ty = target.y; }
        else if (d < 160) { tx = b.x - dx;      ty = b.y - dy; }
        else              { tx = b.x + dy * .6; ty = b.y - dx * .6; }
      } else {
        if (now > brain.repath || (Math.abs(brain.tx - b.x) < 30 && Math.abs(brain.ty - b.y) < 30)) {
          brain.tx = Math.random() * WORLD;
          brain.ty = Math.random() * WORLD;
          brain.repath = now + 3000 + Math.random() * 5000;
        }
        tx = brain.tx; ty = brain.ty;
      }

      const dxm = tx - b.x, dym = ty - b.y;
      const dm = Math.sqrt(dxm * dxm + dym * dym) || 1;
      const step = Math.min(MOVE_SPEED * dt, dm);
      b.x = Math.max(0, Math.min(WORLD, b.x + dxm / dm * step));
      b.y = Math.max(0, Math.min(WORLD, b.y + dym / dm * step));
    });
  }

  onJoin(client, options) {
    this.state.online = this.clients.length;
    if (options && options.presence) return;
    const p = new Player();
    p.name = (options && options.name) ? String(options.name).slice(0, 16) : "Fish";
    this.state.players.set(client.sessionId, p);
    if (!this.pending.has(client.sessionId)) this.pending.set(client.sessionId, { kills: 0, deaths: 0 });
  }

  onLeave(client) {
    this.flushStats(client.sessionId);
    this.tokens.delete(client.sessionId);
    this.pending.delete(client.sessionId);
    this.state.players.delete(client.sessionId);
    this.state.online = Math.max(0, this.clients.length - 1);
  }

  // -------- Firestore flush (unchanged from v7) -------------------------------
  flushAllStats() {
    const it = this.pending.keys();
    let n = it.next();
    while (!n.done) { this.flushStats(n.value); n = it.next(); }
  }

  flushStats(sessionId) {
    const auth = this.tokens.get(sessionId);
    const pend = this.pending.get(sessionId);
    if (!auth || !pend || (pend.kills === 0 && pend.deaths === 0)) return;
    const k = pend.kills, d = pend.deaths;
    pend.kills = 0; pend.deaths = 0;

    const projectId = "battle-fish-royale";
    const doc = `projects/${projectId}/databases/(default)/documents/users/${auth.uid}`;
    const body = JSON.stringify({
      writes: [{
        transform: {
          document: doc,
          fieldTransforms: [
            { fieldPath: "srvKills",  increment: { integerValue: String(k) } },
            { fieldPath: "srvDeaths", increment: { integerValue: String(d) } }
          ]
        }
      }]
    });

    const opts = {
      hostname: "firestore.googleapis.com",
      path: `/v1/projects/${projectId}/databases/(default)/documents:commit`,
      method: "POST",
      headers: {
        "Content-Type":   "application/json",
        "Authorization":  "Bearer " + auth.token,
        "Content-Length": Buffer.byteLength(body)
      }
    };

    const req = https.request(opts, (res) => {
      let chunks = "";
      res.on("data", (c) => { chunks += c; });
      res.on("end", () => {
        if (res.statusCode >= 200 && res.statusCode < 300) return;
        console.warn(`[BF] flushStats non-2xx (${res.statusCode}) for ${auth.uid.slice(0,8)}: ${chunks.slice(0,120)}`);
      });
    });
    req.on("error", (e) => { console.warn("[BF] flushStats network err:", e && e.message); });
    req.write(body);
    req.end();
  }
}

module.exports = { GameRoom };
