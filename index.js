// local test harness — mirrors the repo's server: define room "battle"
const http = require("http");
const { Server } = require("colyseus");
const { GameRoom } = require("./rooms/GameRoom");
const server = http.createServer();
const gameServer = new Server({ server });
gameServer.define("battle", GameRoom);
server.listen(2567, () => console.log("[test] listening :2567"));

/* 🌊 PADDLE WEBHOOK — signature-verified transaction log (audit trail for web
   purchases). Runs on :2568 in this same process; nginx proxies
   /paddle-webhook to it. Secret comes from env BF_PADDLE_WEBHOOK_SECRET
   (Paddle dashboard → Notifications → your webhook's secret key).           */
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const WH_SECRET = process.env.BF_PADDLE_WEBHOOK_SECRET || "";
const WH_LOG = path.join(__dirname, "paddle-transactions.jsonl");
http.createServer((req, res) => {
  if (req.method !== "POST" || req.url.split("?")[0] !== "/paddle-webhook") { res.writeHead(404); res.end(); return; }
  let raw = "";
  req.on("data", (c) => { raw += c; if (raw.length > 1e6) req.destroy(); });
  req.on("end", () => {
    try {
      if (!WH_SECRET) { res.writeHead(503); res.end("no secret configured"); return; }
      const sig = String(req.headers["paddle-signature"] || "");
      const ts = (sig.match(/ts=(\d+)/) || [])[1];
      const h1 = (sig.match(/h1=([0-9a-f]+)/) || [])[1];
      if (!ts || !h1) { res.writeHead(403); res.end("bad signature header"); return; }
      const want = crypto.createHmac("sha256", WH_SECRET).update(ts + ":" + raw).digest("hex");
      if (!crypto.timingSafeEqual(Buffer.from(want), Buffer.from(h1))) { res.writeHead(403); res.end("bad signature"); return; }
      const ev = JSON.parse(raw);
      const line = JSON.stringify({
        at: new Date().toISOString(),
        event: ev.event_type,
        txn: ev.data && ev.data.id,
        status: ev.data && ev.data.status,
        custom: ev.data && ev.data.custom_data,
        items: ((ev.data && ev.data.items) || []).map((i) => i.price && i.price.id),
        total: ev.data && ev.data.details && ev.data.details.totals && ev.data.details.totals.grand_total
      }) + "\n";
      fs.appendFile(WH_LOG, line, () => {});
      console.log("[PADDLE]", ev.event_type, ev.data && ev.data.id);
      try { maybeGrantSub(ev); } catch (e) { console.warn("[SUB] grant error:", e.message); }
      res.writeHead(200); res.end("ok");
    } catch (e) { res.writeHead(400); res.end("bad payload"); }
  });
}).listen(2568, () => console.log("[PADDLE] webhook listening :2568"));

/* 🏦 SUBSCRIPTION RENEWALS — the one grant that MUST be server-side: Paddle
   bills monthly while the player is away, so each transaction.completed for the
   sub price extends users/{uid}.subUntil in Firestore (clients adopt it on next
   sync). Needs: BF_PADDLE_SUB_PRICE (the pri_ id) and BF_SA_KEY_FILE (a Google
   service-account JSON with Firestore access). BF_SUB_DRYRUN=1 logs the intended
   grant instead of writing — used by tests. Unconfigured = logged skip, never a
   failure. */
const SUB_PRICE = process.env.BF_PADDLE_SUB_PRICE || "";
const SA_FILE = process.env.BF_SA_KEY_FILE || "";
const SUB_DAYS = 32;
let _saTok = null, _saTokExp = 0;
function saToken(cb) {
  if (_saTok && Date.now() < _saTokExp) return cb(null, _saTok);
  let key;
  try { key = JSON.parse(fs.readFileSync(SA_FILE, "utf8")); } catch (e) { return cb(new Error("SA key unreadable")); }
  const now = Math.floor(Date.now() / 1000);
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const unsigned = b64({ alg: "RS256", typ: "JWT" }) + "." + b64({
    iss: key.client_email, scope: "https://www.googleapis.com/auth/datastore",
    aud: key.token_uri, iat: now, exp: now + 3600
  });
  const sig = crypto.createSign("RSA-SHA256").update(unsigned).sign(key.private_key).toString("base64url");
  const body = "grant_type=" + encodeURIComponent("urn:ietf:params:oauth:grant-type:jwt-bearer") + "&assertion=" + unsigned + "." + sig;
  const u = new URL(key.token_uri);
  const rq = require("https").request({ hostname: u.hostname, path: u.pathname, method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "Content-Length": Buffer.byteLength(body) } }, (rs) => {
    let d = ""; rs.on("data", (c) => d += c); rs.on("end", () => {
      try { const j = JSON.parse(d); if (!j.access_token) return cb(new Error("no token: " + d.slice(0, 120)));
        _saTok = j.access_token; _saTokExp = Date.now() + 55 * 60000; cb(null, _saTok);
      } catch (e) { cb(e); }
    });
  });
  rq.on("error", cb); rq.end(body);
}
function maybeGrantSub(ev) {
  if (ev.event_type !== "transaction.completed") return;
  if (!SUB_PRICE) return;
  const items = (ev.data && ev.data.items) || [];
  if (!items.some((i) => i.price && i.price.id === SUB_PRICE)) return;
  const uid = ev.data && ev.data.custom_data && ev.data.custom_data.uid;
  if (!uid || !/^[A-Za-z0-9_-]{6,64}$/.test(uid)) { console.warn("[SUB] no usable uid on txn", ev.data && ev.data.id); return; }
  const until = Date.now() + SUB_DAYS * 24 * 3600 * 1000;
  if (process.env.BF_SUB_DRYRUN === "1") {
    fs.appendFile(WH_LOG, JSON.stringify({ subGrant: { uid, subUntil: until, dryrun: true } }) + "\n", () => {});
    console.log("[SUB] DRYRUN grant", uid, "until", new Date(until).toISOString());
    return;
  }
  if (!SA_FILE) { console.warn("[SUB] BF_SA_KEY_FILE not set — renewal logged only; grant manually or configure the SA"); return; }
  saToken((err, tok) => {
    if (err) return console.warn("[SUB] token failed:", err.message);
    let pid = "";
    try { pid = JSON.parse(fs.readFileSync(SA_FILE, "utf8")).project_id; } catch (_) {}
    const body = JSON.stringify({ fields: { subUntil: { integerValue: String(until) } } });
    const rq = require("https").request({ hostname: "firestore.googleapis.com",
      path: "/v1/projects/" + pid + "/databases/(default)/documents/users/" + encodeURIComponent(uid) + "?updateMask.fieldPaths=subUntil",
      method: "PATCH", headers: { "Content-Type": "application/json", "Authorization": "Bearer " + tok, "Content-Length": Buffer.byteLength(body) } }, (rs) => {
      let d = ""; rs.on("data", (c) => d += c); rs.on("end", () => {
        if (rs.statusCode === 200) {
          console.log("[SUB] granted", uid, "until", new Date(until).toISOString());
          fs.appendFile(WH_LOG, JSON.stringify({ subGrant: { uid, subUntil: until } }) + "\n", () => {});
        } else console.warn("[SUB] firestore " + rs.statusCode + ":", d.slice(0, 160));
      });
    });
    rq.on("error", (e) => console.warn("[SUB] firestore error:", e.message)); rq.end(body);
  });
}
