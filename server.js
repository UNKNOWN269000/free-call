/**
 * FreeCall — signaling server (Node.js).
 *
 * This server does NOT carry the call itself. It only helps two browsers
 * find each other and exchange connection details (WebRTC signaling over a
 * plain WebSocket with a small JSON protocol). Once connected, audio/video
 * flows directly peer-to-peer between the two devices — that's what makes
 * the calls free.
 *
 * The exact same protocol is implemented for Cloudflare Workers +
 * Durable Objects in ./cloudflare/src/index.js, so the client works with
 * either backend unchanged.
 */

const path = require('path');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const { WebSocketServer, WebSocket } = require('ws');

const app = express();
const server = http.createServer(app);

app.use(express.json({ limit: '16kb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (_req, res) => res.json({ ok: true }));

// ---------------------------------------------------------------------------
// Rooms: code -> { peers: Map<id, { ws, name }>, createdAt }
// A room holds at most 2 peers (a 1-to-1 call).
// ---------------------------------------------------------------------------
const MAX_PEERS_PER_ROOM = 2;
const ROOM_TTL_MS = 15 * 60 * 1000; // release codes of abandoned empty rooms
const rooms = new Map();

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no ambiguous chars
const CODE_LENGTH = 6;

function makeRoomCode() {
  let code;
  do {
    code = Array.from(
      { length: CODE_LENGTH },
      () => CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)]
    ).join('');
  } while (rooms.has(code));
  return code;
}

function cleanName(raw) {
  return String(raw || '').trim().slice(0, 24) || 'Guest';
}

function peersOf(room, excludeId) {
  const out = [];
  for (const [id, peer] of room.peers) {
    if (id !== excludeId) out.push({ id, name: peer.name });
  }
  return out;
}

function sendJson(ws, obj) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(obj));
  }
}

function pushRoomUpdate(room) {
  for (const [id, peer] of room.peers) {
    sendJson(peer.ws, {
      type: 'event',
      event: 'room-update',
      payload: { peers: peersOf(room, id) },
    });
  }
}

// ---------------------------------------------------------------------------
// HTTP API
// ---------------------------------------------------------------------------

// POST /api/rooms  { name }  ->  { ok: true, code }
// "Creating" a room reserves the code; the first WebSocket connection to
// /room?code=... becomes its first peer.
app.post('/api/rooms', (req, res) => {
  for (let attempt = 0; attempt < 12; attempt++) {
    const code = makeRoomCode();
    rooms.set(code, { peers: new Map(), createdAt: Date.now() });
    return res.json({ ok: true, code });
  }
  res.status(500).json({ ok: false, error: 'Could not create a room. Try again.' });
});

// ---------------------------------------------------------------------------
// WebSocket signaling — GET /room?code=CODE&name=NAME
// ---------------------------------------------------------------------------
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname !== '/room') {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://localhost');
  const code = String(url.searchParams.get('code') || '').trim().toUpperCase();
  const name = cleanName(url.searchParams.get('name'));
  const room = rooms.get(code);

  if (!room) {
    sendJson(ws, { type: 'error', message: 'Room not found. Check the code with your friend.' });
    ws.close(1008, 'Room not found');
    return;
  }
  if (room.peers.size >= MAX_PEERS_PER_ROOM) {
    sendJson(ws, { type: 'error', message: 'Room is already full.' });
    ws.close(1008, 'Room full');
    return;
  }

  const id = crypto.randomUUID();
  room.peers.set(id, { ws, name });
  sendJson(ws, { type: 'joined', code, peers: peersOf(room, id) });
  pushRoomUpdate(room);

  ws.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }

    if (msg.type === 'relay' && typeof msg.event === 'string') {
      const payload = msg.payload || {};
      for (const [pid, peer] of room.peers) {
        if (pid !== id) {
          sendJson(peer.ws, { type: 'event', event: msg.event, from: id, payload });
        }
      }
    } else if (msg.type === 'leave') {
      ws.close(1000, 'Left room');
    }
  });

  ws.on('close', () => {
    if (!room.peers.has(id)) return; // rejected joiner — never added
    room.peers.delete(id);
    if (room.peers.size === 0) {
      rooms.delete(code);
    } else {
      pushRoomUpdate(room);
    }
  });
});

// Sweep abandoned empty rooms so codes free up.
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (room.peers.size === 0 && now - room.createdAt > ROOM_TTL_MS) {
      rooms.delete(code);
    }
  }
}, 60 * 1000).unref();

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`FreeCall is running → http://0.0.0.0:${PORT}`);
});
