// Battle Fish — GameRoom v12 SHARED OCEAN + ROYALE MATCHMAKING (2026-07-21).
//
// v12 adds real Battle Royale: players who queue within the same window are
// bundled into one match ticket {matchId, startAt, roster}. Every fish carries
// a `match` field ("" = Open Waters); state relay is global but clients only
// render fish from their own waters, and damage only forwards inside the same
// match. The Royale storm is deterministic client-side (fixed centre, linear
// shrink over the match clock) — sharing startAt IS the zone sync.
//
// ★ ARCHITECTURE CHANGE per the owner: there is NO separate arena any more.
// The REAL GAME is the multiplayer world. Every player's Open Waters session
// joins this one room; each client renders every other real player inside its
// own ocean. The AI shoal that keeps the ocean busy is simulated CLIENT-side
// (the game's existing 200-bot ecosystem) and simply fills in around the real
// players — so the server no longer owns any fish AI, combat sim, pellets,
// projectiles, grenades or trails. Those all died with the arena (v10).
//
// What the server IS now:
//   • presence            — online count for the home-screen badge
//   • real-player state   — x/y/ang/hp/alive/name/char relayed to everyone
//   • damage forwarding   — attacker's client reports the hit ('dmg'); we
//                           validate + forward a 'hurt' to the victim's client,
//                           whose own game applies its armour/shields/i-frames
//                           and stays the authority on its OWN hp
//   • kill ledger         — victim confirms with 'died'; kills/deaths are
//                           credited HERE, broadcast as the same v7 'eat'
//                           event, and flushed to Firestore (srvKills/srvDeaths)
//
// Movement stays client-authoritative (accepted since the lag fix); identity
// verification on the socket is still a future hardening step.

const { Room } = require("colyseus");
const { Schema, MapSchema, defineTypes } = require("@colyseus/schema");
const https = require("https");

const NAME_MAX        = 16;
const COORD_LIMIT     = 200000;   // the game's free-roam spawns reach ~70k from origin; clamp far past that
const DMG_MAX_PER_MSG = 400;      // no single reported hit above this (sniper crits sit well under)
const DMG_WINDOW_S    = 2;        // rolling sanity window for reported damage…
const DMG_WINDOW_CAP  = 1600;     // …and the most one attacker may report inside it
const DIED_COOLDOWN_S = 1.5;      // one death confirmation per victim per this many seconds
const MATCH_MAX       = 24;       // match id length cap
const BR_WINDOW_MS    = parseInt(process.env.BF_BR_WINDOW || "", 10) || 10000;   // royale gather window (env-tunable for tests)
const BR_START_DELAY  = 3000;     // everyone drops this long after the ticket — the shared match clock starts here

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
// One entry per REAL player currently swimming in Open Waters. Menu browsers
// (presence-only connections) never appear here — they only count toward online.
class Player extends Schema {
  constructor() {
    super();
    this.x      = 0;
    this.y      = 0;
    this.ang    = 0;
    this.name   = "Fish";
    this.char   = "";        // equipped character id → other clients render the right fish
    this.hp     = 100;       // mirrored from the owner's client (their game owns their hp)
    this.maxHp  = 100;
    this.match  = "";        // "" = Open Waters; otherwise the Royale match id this fish swims in
    this.wpn    = "";        // equipped weapon id — purely visual, lets other screens replicate the LOOK of your fire
    this.mass   = 0;         // the fish's SIZE — every screen shows you as big as you really are
    this.fireSeq = 0;        // increments every shot — other screens replay it as harmless light
    this.aim    = 0;         // the angle those shots went
    this.alive  = true;
    this.kills  = 0;
    this.deaths = 0;
  }
}
defineTypes(Player, {
  x: "number", y: "number", ang: "number",
  name: "string", char: "string",
  hp: "number", maxHp: "number", alive: "boolean",
  kills: "number", deaths: "number",
  match: "string",
  wpn: "string", fireSeq: "number", aim: "number",
  mass: "number"
});

class GameState extends Schema {
  constructor() {
    super();
    this.players = new MapSchema();
    this.online  = 0;
  }
}
defineTypes(GameState, { players: { map: Player }, online: "number" });

// ---- Pure validation helpers (unit-tested) -----------------------------------
function clampCoord(v) {
  if (typeof v !== "number" || !isFinite(v)) return null;
  return Math.max(-COORD_LIMIT, Math.min(COORD_LIMIT, v));
}

// Rolling-window damage sanity for one attacker. meter = {t0, sum} (mutated).
// Returns the amount to forward (0 = drop the report).
function meterDamage(meter, amount, nowS) {
  if (typeof amount !== "number" || !isFinite(amount) || amount <= 0) return 0;
  const a = Math.min(DMG_MAX_PER_MSG, amount);
  if (nowS - meter.t0 > DMG_WINDOW_S) { meter.t0 = nowS; meter.sum = 0; }
  if (meter.sum + a > DMG_WINDOW_CAP) return 0;
  meter.sum += a;
  return a;
}

class GameRoom extends Room {
  onCreate() {
    console.log("[BF] GameRoom v14 (SHARED OCEAN + SIZE SYNC) live");
    this.maxClients = 150;                                 // per-OCEAN cap — joinOrCreate auto-spawns ocean #2, #3… when full
    this.setState(new GameState());
    this.tokens  = new Map();   // sessionId -> { token, uid }   (Firestore stat flushes)
    this.pending = new Map();   // sessionId -> { kills, deaths } awaiting flush
    this.meters  = new Map();   // sessionId -> { t0, sum }      damage sanity window
    this.diedAt  = new Map();   // sessionId -> last accepted 'died' (ms)

    // Firebase ID token → per-account kill/death persistence (unchanged v7 path)
    this.onMessage("auth", (client, data) => {
      const token = data && typeof data.token === "string" ? data.token : null;
      const uid = token ? decodeIdTokenUid(token) : null;
      if (!uid) return;
      this.tokens.set(client.sessionId, { token, uid });
      if (!this.pending.has(client.sessionId)) this.pending.set(client.sessionId, { kills: 0, deaths: 0 });
      console.log(`[BF] stats tracking on for ${uid.slice(0, 8)}…`);
    });

    // The player dove into Open Waters — they now exist as a fish for everyone.
    this.onMessage("enter", (client, data) => {
      let p = this.state.players.get(client.sessionId);
      if (!p) { p = new Player(); this.state.players.set(client.sessionId, p); }
      if (data && typeof data.name === "string" && data.name.trim()) p.name = data.name.slice(0, NAME_MAX);
      if (data && typeof data.char === "string") p.char = data.char.slice(0, 24);
      if (data && typeof data.hp === "number" && isFinite(data.hp)) p.hp = Math.max(0, data.hp);
      if (data && typeof data.maxHp === "number" && isFinite(data.maxHp) && data.maxHp > 0) p.maxHp = data.maxHp;
      const x = data ? clampCoord(data.x) : null, y = data ? clampCoord(data.y) : null;
      if (x !== null) p.x = x;
      if (y !== null) p.y = y;
      p.alive = true;
      p.match = (data && typeof data.match === "string") ? data.match.slice(0, MATCH_MAX) : "";
      p.wpn = (data && typeof data.wpn === "string") ? data.wpn.slice(0, 24) : "";
      if (data && typeof data.mass === "number" && isFinite(data.mass)) p.mass = Math.max(1, Math.min(100000, data.mass));
      if (!this.pending.has(client.sessionId)) this.pending.set(client.sessionId, { kills: 0, deaths: 0 });
    });

    // ---- Royale matchmaking: queue inside one gather window → one shared ticket
    this.brQueue = new Map();     // sessionId -> { client, name, char }
    this.brT0 = 0;                // when the current gather window opened
    this.matchSeq = 0;
    this.onMessage("queue", (client, data) => {
      const name = (data && typeof data.name === "string" && data.name.trim()) ? data.name.slice(0, NAME_MAX) : "Fish";
      const char = (data && typeof data.char === "string") ? data.char.slice(0, 24) : "";
      this.brQueue.set(client.sessionId, { client, name, char });
      if (!this.brT0) this.brT0 = Date.now();
    });
    this.onMessage("unqueue", (client) => {
      this.brQueue.delete(client.sessionId);
      if (!this.brQueue.size) this.brT0 = 0;
    });
    this.clock.setInterval(() => this.brSweep(), 500);

    // Back to the home screen / into a Battle Royale match — leave the shared ocean.
    this.onMessage("exitworld", (client) => {
      this.state.players.delete(client.sessionId);
    });

    // Client-authoritative movement + self-reported hp (their game owns their hp).
    this.onMessage("move", (client, data) => {
      const p = this.state.players.get(client.sessionId);
      if (!p || !data) return;
      const x = clampCoord(data.x), y = clampCoord(data.y);
      if (x !== null) p.x = x;
      if (y !== null) p.y = y;
      if (typeof data.ang === "number" && isFinite(data.ang)) p.ang = data.ang;
      if (typeof data.hp === "number" && isFinite(data.hp)) p.hp = Math.max(0, data.hp);
      if (typeof data.maxHp === "number" && isFinite(data.maxHp) && data.maxHp > 0) p.maxHp = data.maxHp;
      if (typeof data.alive === "boolean") p.alive = data.alive;
      if (typeof data.fireSeq === "number" && isFinite(data.fireSeq)){       // fire events: monotonic, never backwards, sane rate cap
        const fs = Math.floor(data.fireSeq);
        if (fs > p.fireSeq && fs - p.fireSeq < 1000) p.fireSeq = fs;
      }
      if (typeof data.aim === "number" && isFinite(data.aim)) p.aim = Math.max(-7, Math.min(7, data.aim));
      if (typeof data.mass === "number" && isFinite(data.mass)) p.mass = Math.max(1, Math.min(100000, data.mass));
    });

    // Attacker's game reports damage it dealt to another REAL player.
    // We sanity-check it and forward a 'hurt' to the victim's client — the
    // victim's own game runs it through its full damage pipeline (armour,
    // shields, dodge i-frames…) and remains the authority on its own hp.
    this.onMessage("dmg", (client, data) => {
      if (!data || typeof data.t !== "string") return;
      const atk = this.state.players.get(client.sessionId);
      const vic = this.state.players.get(data.t);
      if (!atk || !atk.alive || !vic || !vic.alive || data.t === client.sessionId) return;
      if (atk.match !== vic.match) return;   // a Royale never leaks into the open ocean (or another Royale)
      let meter = this.meters.get(client.sessionId);
      if (!meter) { meter = { t0: 0, sum: 0 }; this.meters.set(client.sessionId, meter); }
      const amount = meterDamage(meter, data.a, Date.now() / 1000);
      if (amount <= 0) return;
      const target = this.clients.find((c) => c.sessionId === data.t);
      if (!target) return;
      target.send("hurt", { f: client.sessionId, n: atk.name, a: amount });
    });

    // Victim's game confirms its fish died and names the killer → the ledger
    // credits both sides here and everyone gets the same v7 'eat' broadcast.
    this.onMessage("died", (client, data) => {
      const vic = this.state.players.get(client.sessionId);
      if (!vic) return;
      const now = Date.now();
      if (now - (this.diedAt.get(client.sessionId) || 0) < DIED_COOLDOWN_S * 1000) return;
      this.diedAt.set(client.sessionId, now);
      vic.alive = false;
      vic.deaths = (vic.deaths || 0) + 1;
      const killerId = data && typeof data.k === "string" ? data.k : "";
      const killer = killerId ? this.state.players.get(killerId) : null;
      if (killer) killer.kills = (killer.kills || 0) + 1;
      const pv = this.pending.get(client.sessionId); if (pv && this.tokens.has(client.sessionId)) pv.deaths++;
      const pk = killerId ? this.pending.get(killerId) : null; if (pk && this.tokens.has(killerId)) pk.kills++;
      this.broadcast("eat", {
        eater: killerId,             eaterName: killer ? killer.name : "?",
        victim: client.sessionId,    victimName: vic.name
      });
    });

    this.clock.setInterval(() => this.flushAllStats(), 10000);
  }

  onJoin(client) {
    // Nobody exists as a fish until their game sends 'enter' — a connection by
    // itself (home screen, splash) only counts toward the online number.
    this.state.online = this.clients.length;
  }

  // One gather window, everyone inside it drops together. A solo queuer gets a
  // match of one — identical to today's all-AI Royale, just server-stamped.
  brSweep() {
    if (!this.brT0 || Date.now() - this.brT0 < BR_WINDOW_MS) return;
    const entries = [...this.brQueue.entries()].filter(([sid, q]) => q.client && this.clients.find((c) => c.sessionId === sid));
    this.brQueue.clear(); this.brT0 = 0;
    if (!entries.length) return;
    this.matchSeq++;
    const matchId = ("m" + Date.now().toString(36) + "_" + this.matchSeq).slice(0, MATCH_MAX);
    const at = Date.now() + BR_START_DELAY;
    const roster = entries.map(([sid, q]) => ({ sid, name: q.name, char: q.char }));
    console.log("[BF] royale ticket " + matchId + " — " + roster.length + " pilot(s)");
    for (const [sid, q] of entries) {
      try { q.client.send("brmatch", { m: matchId, at, now: Date.now(), roster }); } catch (e) {}
    }
  }

  onLeave(client) {
    this.brQueue.delete(client.sessionId);
    if (!this.brQueue.size) this.brT0 = 0;
    this.flushStats(client.sessionId);
    this.tokens.delete(client.sessionId);
    this.pending.delete(client.sessionId);
    this.meters.delete(client.sessionId);
    this.diedAt.delete(client.sessionId);
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

module.exports = { GameRoom, meterDamage, clampCoord, decodeIdTokenUid,
                   DMG_MAX_PER_MSG, DMG_WINDOW_CAP, DMG_WINDOW_S };
