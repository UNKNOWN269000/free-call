# ☁️ Deploy FreeCall on Cloudflare (free)

This folder hosts the **complete FreeCall backend on Cloudflare** — no Node.js
server needed:

- **Cloudflare Workers** serves the web app (`../public`) and handles HTTP
- **Cloudflare Durable Objects** run the signaling — one object per call room,
  with WebSocket hibernation, so idle rooms cost ~nothing
- Media still flows **peer-to-peer via WebRTC** and never touches Cloudflare

It speaks the exact same JSON protocol as `server.js`, so the browser client
works unchanged with either backend. Everything here runs on Cloudflare's
**free plan**.

## One-time setup

```bash
# 1. Install Wrangler (Cloudflare's CLI)
npm install -g wrangler

# 2. Log in to your Cloudflare account (free tier is fine)
wrangler login
```

## Try it locally first

```bash
cd cloudflare
npm install
npm run dev          # → http://localhost:8787
```

Open `http://localhost:8787` in two tabs and make a test call. (Wrangler
emulates Workers + Durable Objects locally.)

## Deploy to the world

```bash
cd cloudflare
npm run deploy       # → wrangler deploy
```

Done. Wrangler prints your public URL, e.g.
`https://freecall.<your-subdomain>.workers.dev`. Share that link — the app's
**🔗 Copy invite link** button builds invite links with the room code built in.

- **Custom domain:** add one in the Cloudflare dashboard
  (Workers & Pages → your worker → Settings → Domains & Routes) if you want
  `call.yourdomain.com`.
- **Redeploy after changes:** just run `npm run deploy` again.
- **Test suite:** `BASE_URL=http://localhost:8787 node ../test/signaling.test.js`
  (from this folder) runs the full signaling test against the Worker.

## What's inside

```
cloudflare/
  wrangler.toml     Worker + Durable Object config, static assets binding
  package.json      wrangler dev dependency
  src/index.js      Worker (routing) + CallRoom Durable Object (signaling)
```

| Endpoint | Purpose |
|---|---|
| `GET /health` | health check |
| `POST /api/rooms` | reserve a 6-letter room code |
| `GET /room?code=…&name=…` | WebSocket upgrade — join the room |
| everything else | static assets → the app in `../public` |

## Notes

- **HTTPS is automatic** (workers.dev and custom domains are proxied by
  Cloudflare), so camera/microphone permissions work out of the box.
- **Calls across different networks** usually connect via the free public STUN
  server already configured in `public/app.js`. For users behind very strict
  firewalls, add a TURN server to `PC_CONFIG` (Cloudflare Calls offers a free
  TURN service: <https://developers.cloudflare.com/calls/turn/>).
- Room codes auto-expire 15 minutes after the last person leaves.
- Billing: on the free plan, Workers and Durable Objects are included with
  generous limits — far more than enough for personal signaling traffic.
