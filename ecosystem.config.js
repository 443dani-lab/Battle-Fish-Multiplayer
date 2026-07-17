module.exports = {
  apps: [{
    name: "battle-fish",
    script: "index.js",
    instances: 1,
    exec_mode: "fork",
    wait_ready: true,
    env: { NODE_ENV: "production" },
  }],
};
