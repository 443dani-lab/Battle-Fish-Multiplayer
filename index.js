// Battle Fish — multiplayer server entrypoint
const { listen } = require("@colyseus/tools");
const app = require("./app.config");
listen(app);
