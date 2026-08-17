# ☁️ Deploy FreeCall on Cloudflare (free)

This folder holds the **Cloudflare backend code** for FreeCall. The project
runs entirely on Cloudflare's free plan — no Node.js server needed:

- **Cloudflare Workers** serves the web app (`public/`) and handles HTTP
- **Cloudflare Durable Objects** run the signaling — one object per call room,
  with WebSocket hibernation, so idle rooms cost ~nothing
- Media still flows **peer-to-peer via WebRTC** and never touches Cloudflare

It speaks the exact same JSON protocol as `server.js`, so the browser client
works unchanged with either backend.

> ⚠️ Config note: `wrangler.toml` lives at the **repo root** (not here) so it
> works from any build environment. All commands below run from the repo root.

## Deploy — pick one path

### A. From your computer (simplest)

```bash
# 1. Install dependencies (includes wrangler)
npm install

# 2. Log in to your Cloudflare account (free tier is fine)
npx wrangler login

# 3. Deploy
npm run cf:deploy
```

Wrangler prints your public URL, e.g. `https://freecall.<you>.workers.dev`.

### B. Cloudflare Workers Builds (CI, recommended)

In the Cloudflare dashboard: **Workers & Pages → freecall → Settings → Builds**,
connect your GitHub repo, then set:

- Build command: `npm run cf:deploy`
- Build configuration: `wrangler.toml`

Cloudflare handles credentials automatically and redeploys on every push.
(Workers Builds is the right CI product for this — it's designed for
Workers + Durable Objects.)

### C. Cloudflare Pages (works, with one note)

If you'd rather use Pages: create a Pages project connected to the repo,
root directory = repo root, **deploy command: `npm run cf:deploy`**.
Pages injects Cloudflare credentials into the build automatically, so the
Worker deploys from the build. One caveat: Pages will also publish the
(empty) build output as a static site — ignore that pages.dev URL and use the
workers.dev URL that Wrangler prints in the build log.

> The earlier error — `Could not detect a directory containing static files` —
> happened because the deploy ran at the repo root while `wrangler.toml` was
> inside `cloudflare/`. The config now lives at the repo root, so it's found
> from any working directory.

### D. GitHub Actions (optional)

If you prefer GitHub Actions over Workers Builds, add a workflow like this to
`.github/workflows/deploy-cloudflare.yml` (via the GitHub web editor, since
adding workflow files requires write permission):

```yaml
name: Deploy to Cloudflare
on:
  push:
    branches: [main]
  workflow_dispatch:
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20, cache: npm }
      - run: npm ci
      - run: npm test
      - run: npm run cf:deploy
        env:
          CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
```

Add the two secrets (`CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`) in
GitHub → Settings → Secrets and variables → Actions. Secrets aren't needed
for options B and C.

## Try it locally first

```bash
npm install
npm run cf:dev        # → http://localhost:8787
```

Open `http://localhost:8787` in two tabs and make a test call. Wrangler
emulates Workers + Durable Objects locally.

## Verify with the test suite

```bash
BASE_URL=http://localhost:8787 npm test
```

## What's inside

```
cloudflare/
  src/index.js       Worker (routing) + CallRoom Durable Object (signaling)
wrangler.toml        Worker + Durable Object config, static assets binding (repo root)
```

| Endpoint | Purpose |
|---|---|
| `GET /health` | health check |
| `POST /api/rooms` | reserve a 6-letter room code |
| `GET /room?code=…&name=…` | WebSocket upgrade — join the room |
| everything else | static assets → the app in `public/` |

## Notes

- **HTTPS is automatic** (workers.dev and custom domains are proxied by
  Cloudflare), so camera/microphone permissions work out of the box.
- **Custom domain:** Workers & Pages → freecall → Settings → Domains & Routes.
- **Calls across different networks** usually connect via the free public STUN
  server already configured in `public/app.js`. For users behind very strict
  firewalls, add a TURN server to `PC_CONFIG` (Cloudflare Calls offers a free
  TURN service: <https://developers.cloudflare.com/calls/turn/>).
- Room codes auto-expire 15 minutes after the last person leaves.
- Free-plan limits are far more than enough for personal signaling traffic.
