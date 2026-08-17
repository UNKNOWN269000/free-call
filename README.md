# 📞 FreeCall — free voice & video calling

FreeCall is a web app for **free, unlimited voice and video calls** between any
two devices. Calls are routed **peer-to-peer over the internet** (Wi-Fi or
mobile data) using WebRTC — the same technology WhatsApp, Signal, and FaceTime
use. There are no carrier minutes, no SIM requirement, no subscription, and no
cost.

## Why it's free

Your call never touches a phone company's network. The server only introduces
the two devices to each other; after that, the audio and video flow **directly
between the two devices**. You only need internet on both ends.

## Honest note about "free satellite calling"

There is no satellite network that apps can use for free voice calls:

- **Emergency satellite SOS** (iPhone 14+ / Android 15+ satellite messaging)
  is built into the operating system for emergency *texts* only. Third-party
  apps cannot access it, and it does not allow regular free voice calls.
- **Satellite voice calls** (Iridium, Inmarsat, Globalstar, …) require
  licensed, expensive hardware and paid airtime (dollars per minute). No
  "free satellite signal" exists to tap into — and transmitting on licensed
  satellite/emergency frequencies without authorization is illegal.
- **Real emergencies:** dial 911 / 112 / 999 from any phone — by law, mobile
  networks must accept these calls even with no SIM, no plan, and zero credit.
  They are always free.

FreeCall delivers the legitimate version of the dream: genuinely free calls,
using the internet you already have.

## Run it

```bash
npm install
npm start
```

Then open <http://localhost:3000> in two browsers (or two tabs):

1. Enter a name and click **Create a room** → you get a 6-letter code.
2. In the other browser, enter a name + the code and click **Join**.
3. Click **Call** → the other side accepts → talk as long as you like. Free.

> Both devices need internet. When both are on the same Wi-Fi, calls are
> fully local; across networks, the connection is established peer-to-peer
> (with the help of a public STUN server for NAT traversal).

## How it works

| Layer | Technology |
|---|---|
| Media (audio/video) | WebRTC — direct device-to-device, encrypted (DTLS-SRTP) |
| Signaling (finding each other) | Socket.IO — exchanges room codes, offers/answers, ICE candidates |
| Serving the UI | Node.js + Express |
| NAT traversal | Public STUN server (Google) |

## Project layout

```
server.js          signaling server (rooms + relay)
public/
  index.html       UI: home, room, call screens + emergency/satellite facts
  style.css        dark, phone-first styling
  app.js           WebRTC call flow, ringtones, UI state machine
```

## Privacy

Calls are peer-to-peer and encrypted in transit. The signaling server sees
only connection metadata (room codes, IP addresses, SDP handshakes) — never
the audio or video itself. Nothing is recorded.

## Deploying beyond your own machine

To let friends call each other over the internet, deploy this to any Node.js
host (Render, Railway, Fly.io, a VPS…). For reliable calls between arbitrary
networks, add a free TURN server (e.g. Cloudflare TURN) to `PC_CONFIG` in
`public/app.js`.
