// Battle Fish arena — v9 LOCK & SHOOT (2026-07-21).
// Matches the main game's fire model:
//   PRIMARY  = lock & shoot. The server auto-locks every live fish onto its
//              nearest live opponent within LOCK_RANGE and auto-fires while
//              locked and off cooldown. No fire button, no client aim.
//   SPECIAL  = tap-to-fire (🚀). Client sends 'special'; server aims it at the
//              current lock target (or facing direction if none), bigger damage,
//              long cooldown. This mirrors the main game's spwbtn side weapons.
//
// K/D pipeline preserved from v7/v8: kills broadcast 'eat' with
// { eater, eaterName, victim, victimName }; pending tally per tokened session;
// Firestore INCREMENT flush every 10s + onLeave using the player's own Bearer
// token. Game-side needs zero changes.

const { Room } = require("colyseus");
const { Schema, MapSchema, defineTypes } = require("@colyseus/schema");
const https = require("https");

const WORLD          = 1600;
const FISH_SIZE      = 34;      // fixed — no growth
const FISH_HP        = 100;
const MOVE_SPEED     = 220;     // px/sec
const LOCK_RANGE     = 420;     // auto-lock + auto-fire radius
const FIRE_CD        = 0.35;    // primary cooldown (auto-fire cadence)
const SHOT_SPEED     = 520;
const SHOT_DMG       = 22;      // 5 primary hits to kill
const SHOT_TTL       = 1.5;
const SHOT_R         = 3;       // primary projectile radius (added to fish radius on hit test)
const SPECIAL_CD     = 3.0;     // tap-fire side weapon
const SPECIAL_DMG    = 55;
const SPECIAL_SPEED  = 460;
const SPECIAL_TTL    = 1.8;
const SPECIAL_R      = 9;
const RESPAWN_DELAY  = 2.5;
const MIN_FISH       = 8;
const MAX_BOTS       = 12;
const BOT_SPECIAL_RANGE = 260;  // bots consider a special inside this range
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
    this.ang       = 0;         // facing (server points it at the lock target while locked)
    this.fireCd    = 0;         // primary auto-fire cooldown
    this.specialCd = 0;         // 🚀 side-weapon cooldown (synced so the client button can show it)
    this.lockId    = "";        // sessionId of the current lock target ("" = none) — client draws the reticle from this
    this.respawnT  = 0;
  }
}
defineTypes(Player, {
  x: "number", y: "number", size: "number",
  name: "string", color: "string", score: "number",
  kills: "number", deaths: "number",
  hp: "number", maxHp: "number", ang: "number",
  fireCd: "number", specialCd: "number", lockId: "string", respawnT: "number"
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

class GameState extends Schema {
  constructor() {
    super();
    this.players     = new MapSchema();
    this.projectiles = new MapSchema();
    this.online      = 0;
  }
}
defineTypes(GameState, {
  players:     { map: Player },
  projectiles: { map: Projectile },
  online:      "number"
});

// ---- Pure tick functions -----------------------------------------------------
function respawnPlayer(p) {
  p.hp = p.maxHp;
  p.x = Math.random() * WORLD;
  p.y = Math.random() * WORLD;
  p.fireCd = 0;
  p.specialCd = 0;
  p.lockId = "";
  p.respawnT = 0;
}

function tickPlayers(state, dt) {
  state.players.forEach((p) => {
    if (p.fireCd > 0)    p.fireCd    = Math.max(0, p.fireCd - dt);
    if (p.specialCd > 0) p.specialCd = Math.max(0, p.specialCd - dt);
    if (p.hp <= 0 && p.respawnT > 0) {
      p.respawnT = Math.max(0, p.respawnT - dt);
      if (p.respawnT <= 0) respawnPlayer(p);
    }
  });
}

// LOCK & SHOOT core: every live fish locks its nearest live opponent within
// LOCK_RANGE (lockId synced to clients for the reticle), faces it, and — while
// off cooldown — fire(id, p, ang) is invoked to spawn a primary shot.
// The caller's fire callback owns spawning + resetting fireCd.
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
      if (pl.hp <= 0) return;                          // dead fish phase through
      const dx = pl.x - pr.x, dy = pl.y - pr.y;
      const rr = pl.size + (pr.r || 0);
      if (dx * dx + dy * dy < rr * rr) {
        const dmg = pr.kind === "s" ? SPECIAL_DMG : SHOT_DMG;
        pl.hp = Math.max(0, pl.hp - dmg);
        consumed = true;
        toRemove.push(id);
        if (pl.hp <= 0) {
          pl.respawnT = RESPAWN_DELAY;
          pl.deaths = (pl.deaths || 0) + 1;
          const shooter = state.players.get(pr.owner);
          if (shooter) shooter.kills = (shooter.kills || 0) + 1;
          emitKill(pr.owner, plId);
        }
      }
    });
  });
  toRemove.forEach((id) => state.projectiles.delete(id));
}

class GameRoom extends Room {
  onCreate() {
    console.log("[BF] GameRoom v9 (LOCK & SHOOT) live");
    this.maxClients = 50;
    this.setState(new GameState());
    this.bots    = new Map();
    this.botSeq  = 0;
    this.projSeq = 0;
    this.tokens  = new Map();      // sessionId -> { token, uid }
    this.pending = new Map();      // sessionId -> { kills, deaths }

    this.onMessage("auth", (client, data) => {
      const token = data && typeof data.token === "string" ? data.token : null;
      const uid = token ? decodeIdTokenUid(token) : null;
      if (!uid) return;
      this.tokens.set(client.sessionId, { token, uid });
      if (!this.pending.has(client.sessionId)) this.pending.set(client.sessionId, { kills: 0, deaths: 0 });
      console.log(`[BF] stats tracking on for ${uid.slice(0, 8)}…`);
    });

    // Movement is client-authoritative (server clamps). ang is the client's
    // travel direction — used as the special's fallback aim when unlocked;
    // the auto-fire loop overrides ang to face the lock target while locked.
    this.onMessage("move", (client, data) => {
      const p = this.state.players.get(client.sessionId);
      if (!p || p.hp <= 0) return;
      if (typeof data.x === "number") p.x = Math.max(0, Math.min(WORLD, data.x));
      if (typeof data.y === "number") p.y = Math.max(0, Math.min(WORLD, data.y));
      if (typeof data.ang === "number" && !p.lockId) p.ang = data.ang;
    });

    // 🚀 SPECIAL — the only click/tap-fired weapon. Aims at the lock target if
    // one exists (like the main game's side weapons firing at the locked enemy),
    // otherwise fires straight ahead. Server owns cooldown + damage.
    this.onMessage("special", (client) => {
      const p = this.state.players.get(client.sessionId);
      if (!p || p.hp <= 0 || p.specialCd > 0) return;
      this.fireSpecial(client.sessionId, p);
    });

    this.clock.setInterval(() => this.flushAllStats(), 10000);

    const dt = 0.05;
    this.setSimulationInterval(() => {
      this.updateBots(dt);
      tickPlayers(this.state, dt);
      tickAutoFire(this.state, (id, p, ang) => {         // ← lock & shoot: everyone auto-fires
        this.spawnShot(id, p, ang, "p");
        p.fireCd = FIRE_CD;
      });
      tickProjectiles(this.state, dt, (eaterId, victimId) => this.onKill(eaterId, victimId));
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
    // Aim: lock target first (side weapons fire at the locked enemy), facing otherwise.
    let ang = p.ang;
    if (p.lockId) {
      const t = this.state.players.get(p.lockId);
      if (t && t.hp > 0) ang = Math.atan2(t.y - p.y, t.x - p.x);
    }
    this.spawnShot(sessionId, p, ang, "s");
    p.specialCd = SPECIAL_CD;
  }

  onKill(eaterId, victimId) {
    const pk = this.pending.get(eaterId); if (pk && this.tokens.has(eaterId)) pk.kills++;
    const pd = this.pending.get(victimId); if (pd && this.tokens.has(victimId)) pd.deaths++;
    const shooter = this.state.players.get(eaterId);
    const victim = this.state.players.get(victimId);
    this.broadcast("eat", {                       // name kept for game-listener compat
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

  // Bots only need to MOVE — the universal lock & shoot loop fires their
  // primaries exactly like it does for humans. They kite around their lock
  // target and occasionally throw a special when close.
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
          b.specialCd = SPECIAL_CD + 2 + Math.random() * 2;   // bots slower on specials than humans
        }
        if (d > 280)      { tx = target.x;      ty = target.y; }        // close in
        else if (d < 160) { tx = b.x - dx;      ty = b.y - dy; }        // back off
        else              { tx = b.x + dy * .6; ty = b.y - dx * .6; }   // strafe
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
