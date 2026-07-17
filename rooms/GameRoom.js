// The authoritative room: the server owns all player state.
const { Room } = require("colyseus");
const { Schema, MapSchema, defineTypes } = require("@colyseus/schema");

// One player's state (what every client sees about each fish)
class Player extends Schema {
  constructor() {
    super();
    this.x = 100 + Math.random() * 600;
    this.y = 100 + Math.random() * 400;
    this.name = "Fish";
    this.color = "#" + Math.floor(Math.random() * 16777215).toString(16).padStart(6, "0");
  }
}
defineTypes(Player, { x: "number", y: "number", name: "string", color: "string" });

// The whole room's state: a map of players keyed by their session id
class GameState extends Schema {
  constructor() {
    super();
    this.players = new MapSchema();
  }
}
defineTypes(GameState, { players: { map: Player } });

class GameRoom extends Room {
  onCreate(options) {
    this.setState(new GameState());

    // A client tells us where it wants to move; the SERVER decides if it's allowed.
    this.onMessage("move", (client, data) => {
      const p = this.state.players.get(client.sessionId);
      if (!p) return;
      p.x = Math.max(0, Math.min(800, Number(data.x)));
      p.y = Math.max(0, Math.min(600, Number(data.y)));
    });
  }

  onJoin(client, options) {
    const p = new Player();
    if (options && options.name) p.name = String(options.name).slice(0, 16);
    this.state.players.set(client.sessionId, p);
    console.log(`+ ${p.name} joined  (${this.state.players.size} in room)`);
  }

  onLeave(client) {
    this.state.players.delete(client.sessionId);
    console.log(`- a fish left  (${this.state.players.size} in room)`);
  }
}
module.exports = { GameRoom };
