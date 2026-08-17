/**
 * FreeCall — signaling server.
 *
 * This server does NOT carry the call itself. It only helps two browsers
 * find each other and exchange connection details (WebRTC signaling via
 * Socket.IO). Once connected, audio/video flows directly peer-to-peer
 * between the two devices, so the calls are completely free — they only
 * use whatever internet connection (Wi-Fi / mobile data) both sides have.
 */

const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);

// Accept any origin so the app works behind proxies (e.g. hosted previews).
const io = new Server(server, {
  cors: { origin: '*' },
  serveClient: true,
});

app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (_req, res) => res.json({ ok: true }));

// ---------------------------------------------------------------------------
// Rooms: code -> { peers: Map<socketId, { socket, name }> }
// A room holds at most 2 peers (a 1-to-1 call).
// ---------------------------------------------------------------------------
const MAX_PEERS_PER_ROOM = 2;
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

function findRoom(socketId) {
  for (const [code, room] of rooms) {
    if (room.peers.has(socketId)) return { code, room };
  }
  return null;
}

function roomSnapshot(room, excludeSocketId = null) {
  return [...room.peers.values()]
    .filter((p) => p.socket.id !== excludeSocketId)
    .map((p) => ({ id: p.socket.id, name: p.name }));
}

function pushRoomUpdate(room) {
  for (const peer of room.peers.values()) {
    peer.socket.emit('room-update', {
      peers: roomSnapshot(room, peer.socket.id),
    });
  }
}

// ---------------------------------------------------------------------------
// Connection handling
// ---------------------------------------------------------------------------
io.on('connection', (socket) => {
  // -- create / join ---------------------------------------------------------
  socket.on('create-room', ({ name } = {}, ack) => {
    const cleanName = String(name || '').trim().slice(0, 24) || 'Guest';
    const code = makeRoomCode();
    rooms.set(code, { peers: new Map([[socket.id, { socket, name: cleanName }]]) });
    if (typeof ack === 'function') ack({ ok: true, code });
    pushRoomUpdate(rooms.get(code));
  });

  socket.on('join-room', ({ code, name } = {}, ack) => {
    const room = rooms.get(String(code || '').trim().toUpperCase());
    if (!room) {
      if (typeof ack === 'function') ack({ ok: false, error: 'Room not found. Check the code with your friend.' });
      return;
    }
    if (room.peers.size >= MAX_PEERS_PER_ROOM) {
      if (typeof ack === 'function') ack({ ok: false, error: 'Room is already full.' });
      return;
    }
    const cleanName = String(name || '').trim().slice(0, 24) || 'Guest';
    room.peers.set(socket.id, { socket, name: cleanName });
    if (typeof ack === 'function') {
      ack({ ok: true, code: String(code).trim().toUpperCase(), peers: roomSnapshot(room, socket.id) });
    }
    pushRoomUpdate(room);
  });

  // -- signaling relay -------------------------------------------------------
  // Everything below is simply forwarded to the *other* peer in the room,
  // tagged with the sender's socket id.
  const RELAY_EVENTS = [
    'call',
    'accept',
    'decline',
    'cancel',
    'offer',
    'answer',
    'ice',
    'end-call',
  ];

  for (const event of RELAY_EVENTS) {
    socket.on(event, (payload = {}) => {
      const entry = findRoom(socket.id);
      if (!entry) return;
      for (const [id, peer] of entry.room.peers) {
        if (id !== socket.id) {
          peer.socket.emit(event, { ...payload, from: socket.id });
        }
      }
    });
  }

  // -- leave / disconnect ----------------------------------------------------
  function removeFromRoom() {
    const entry = findRoom(socket.id);
    if (!entry) return;
    entry.room.peers.delete(socket.id);
    if (entry.room.peers.size === 0) {
      rooms.delete(entry.code);
    } else {
      pushRoomUpdate(entry.room);
    }
  }

  socket.on('leave-room', removeFromRoom);
  socket.on('disconnect', removeFromRoom);
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`FreeCall is running → http://0.0.0.0:${PORT}`);
});
