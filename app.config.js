const config = require("@colyseus/tools").default;
const express = require("express");
const path = require("path");
const { GameRoom } = require("./rooms/GameRoom");

module.exports = config({
  initializeGameServer: (gameServer) => {
    gameServer.define("battle", GameRoom);   // room type: "battle"
  },
  initializeExpress: (app) => {
    // serve the game client (works locally; harmless on Colyseus Cloud)
    app.use(express.static(path.join(__dirname, "public")));
  },
});
