# Battle Fish — Multiplayer Prototype (Colyseus)

A **working authoritative multiplayer server**: the server owns the game state, players
send inputs, and everyone sees the same world. This is the proof-of-concept starting
point for real multiplayer — a canvas where connected players see each other move.

> Tested: two clients connect, one moves, the other sees the server-validated position.

---

## 1) Run it locally

1. Install **Node.js** (LTS) from nodejs.org.
2. Unzip this folder and open a terminal inside it.
3. Install dependencies:
   ```
   npm install
   ```
4. Start the server:
   ```
   npm start
   ```
5. Open **http://localhost:2567** in **two browser tabs**. Move your mouse in each —
   you'll see the fish move in *both* tabs in real time. That's real multiplayer.

---

## 2) What's inside

| File | What it does |
|------|--------------|
| `index.js` | Entry point — starts the server |
| `app.config.js` | Defines the `"battle"` room and serves the client |
| `rooms/GameRoom.js` | **The authoritative room** — holds player state, validates moves |
| `public/index.html` | The demo browser client (canvas) |
| `public/lib/colyseus.js` | The client SDK (bundled) |
| `ecosystem.config.js` | PM2 config (needed by Colyseus Cloud) |
| `package.json` | Dependencies (pinned — see the note at the bottom) |

**How it works:** the client sends a `move` message ("I want to be at x,y"); the server
decides if that's allowed and updates the shared state; Colyseus automatically syncs that
state to every connected client. Game logic lives on the server, so no one can cheat.

---

## 3) Deploy — Option A: Colyseus Cloud (easiest, managed)

Colyseus Cloud runs NGINX + PM2 for you. This project is already in the required shape.

1. Sign up at **cloud.colyseus.io** and create an application.
2. Put this project in a **Git repo** (e.g. GitHub) and commit it.
3. Install the deploy tool and deploy:
   ```
   npm install -g @colyseus/cloud
   npx @colyseus/cloud deploy
   ```
   A browser opens — pick your application. It creates a `.colyseus-cloud.json` file with
   your credentials — **keep it safe and do NOT commit it.**
   (Alternatively: connect your GitHub repo in the dashboard under
   Settings → Build & Deployment to auto-deploy on every push.)
4. Colyseus Cloud gives you a server URL like `wss://xxxxx.colyseus.cloud`.
5. In `public/index.html`, set `SERVER_URL` to that URL. Done.

---

## 4) Deploy — Option B: Google Cloud (self-host, full control)

1. In Google Cloud, create a **Compute Engine VM** (an `e2-small`, Ubuntu is fine).
2. **Firewall:** allow HTTP/HTTPS (80/443). (Direct port 2567 also works for testing.)
3. **SSH into the VM**, then install Node.js and PM2:
   ```
   sudo apt update && sudo apt install -y nodejs npm
   sudo npm install -g pm2
   ```
4. Copy this project onto the VM (git clone, or upload), then:
   ```
   npm install
   pm2 start ecosystem.config.js
   ```
   Your server is now running on port 2567.
5. **For secure WebSockets (wss://), put NGINX in front** (your game is HTTPS, so it must
   connect over wss). Point a domain at the VM and use this NGINX site config:
   ```
   server {
     listen 80;
     server_name yourdomain.com;
     location / {
       proxy_pass http://localhost:2567;
       proxy_http_version 1.1;
       proxy_set_header Upgrade $http_upgrade;
       proxy_set_header Connection 'upgrade';
       proxy_set_header Host $host;
       proxy_read_timeout 86400s;
     }
   }
   ```
   Then get a free SSL certificate with Let's Encrypt (`certbot`). Now your server is at
   `wss://yourdomain.com`.
6. In `public/index.html`, set `SERVER_URL` to `wss://yourdomain.com`.

---

## 5) Connecting this to your real game

This prototype uses a tiny demo client (`public/index.html`) so you can *see* multiplayer
working. The next step is to move your fish game's simulation into `GameRoom.js` (server
side) and have your real game connect to the server and render the synced state — the same
`Colyseus.Client` + `room.state` pattern the demo client uses. That's the bigger project,
and it's the part to tackle once you've watched this prototype run.

---

## Version note (important)

The dependencies are pinned to the **Colyseus 0.16 line** because that's the current
matched pair between the server (`colyseus`) and the browser client (`colyseus.js`).
Do **not** run `npm update` to 0.17 unless a matching `colyseus.js@0.17` exists — the
server and client schema formats must match or connections silently fail.
