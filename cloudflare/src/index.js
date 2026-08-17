/**
 * FreeCall signaling for Cloudflare Workers + Durable Objects.
 *
 * Speaks the exact same JSON protocol as server.js (Node), so the browser
 * client works with either backend unchanged:
 *
 *   POST /api/rooms                 { name }   -> { ok, code }   (reserve a room code)
 *   GET  /room?code=CODE&name=NAME  (WebSocket upgrade)          (join a room)
 *
 *   client -> server: { type: 'relay', event, payload } | { type: 'leave' }
 *   server -> client: { type: 'joined', code, peers }
 *                     | { type: 'error', message }
 *                     | { type: 'event', event, from, payload }
 *
 * Each room is a Durable Object keyed by its code. WebSocket connections use
 * the hibernation API, so idle rooms cost almost nothing. Media never
 * touches Cloudflare — calls are peer-to-peer WebRTC between the two devices.
 */

import { DurableObject } from 'cloudflare:workers';

const MAX_PEERS_PER_ROOM = 2;
const ROOM_TTL_MS = 15 * 60 * 1000; // free up codes of abandoned empty rooms
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no ambiguous chars
const CODE_LENGTH = 6;

function makeRoomCode() {
  return Array.from(
    { length: CODE_LENGTH },
    () => CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)]
  ).join('');
}

function cleanName(raw) {
  return String(raw || '').trim().slice(0, 24) || 'Guest';
}

function sendJson(ws, obj) {
  try {
    ws.send(JSON.stringify(obj));
  } catch {}
}

// ---------------------------------------------------------------------------
// CallRoom — one Durable Object per room code
// ---------------------------------------------------------------------------
export class CallRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
  }

  /**
   * RPC from the Worker: reserve this room's code, or reuse it if the room
   * was abandoned (created but nobody ever joined, more than ROOM_TTL ago).
   */
  async claim(now = Date.now()) {
    const exists = await this.ctx.storage.get('exists');
    if (exists) {
      const createdAt = (await this.ctx.storage.get('createdAt')) || 0;
      if (this.peers().length === 0 && now - createdAt > ROOM_TTL_MS) {
        await this.ctx.storage.deleteAll(); // abandoned — recycle the code
      } else {
        return false; // code is taken
      }
    }
    await this.ctx.storage.put('exists', true);
    await this.ctx.storage.put('createdAt', now);
    return true;
  }

  peers() {
    return this.ctx
      .getWebSockets()
      .map((ws) => ws.deserializeAttachment())
      .filter((att) => att && att.id);
  }

  pushRoomUpdate(excludeWs) {
    const all = this.ctx.getWebSockets().filter((ws) => ws !== excludeWs);
    for (const ws of all) {
      const me = ws.deserializeAttachment();
      if (!me) continue;
      sendJson(ws, {
        type: 'event',
        event: 'room-update',
        payload: { peers: this.peers().filter((p) => p.id !== me.id) },
      });
    }
  }

  async fetch(request) {
    const url = new URL(request.url);
    const name = cleanName(url.searchParams.get('name'));

    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('Expected a WebSocket upgrade', { status: 426 });
    }

    const exists = await this.ctx.storage.get('exists');
    if (!exists) {
      return this.reject(request, 'Room not found. Check the code with your friend.');
    }
    if (this.peers().length >= MAX_PEERS_PER_ROOM) {
      return this.reject(request, 'Room is already full.');
    }

    // Accept the connection (hibernation-enabled).
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ id: crypto.randomUUID(), name });

    sendJson(server, {
      type: 'joined',
      code: String(url.searchParams.get('code') || '').toUpperCase(),
      peers: this.peers().filter((p) => p.id !== server.deserializeAttachment().id),
    });
    this.pushRoomUpdate(server);

    return new Response(null, { status: 101, webSocket: client });
  }

  /** Accept the socket just long enough to deliver an error, then close. */
  reject(request, message) {
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server); // no attachment → ignored in cleanup
    sendJson(server, { type: 'error', message });
    server.close(1008, message);
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, message) {
    let msg;
    try { msg = JSON.parse(message); } catch { return; }

    if (msg.type === 'relay' && typeof msg.event === 'string') {
      const from = ws.deserializeAttachment();
      for (const other of this.ctx.getWebSockets()) {
        if (other === ws) continue;
        sendJson(other, {
          type: 'event',
          event: msg.event,
          from: from ? from.id : null,
          payload: msg.payload || {},
        });
      }
    } else if (msg.type === 'leave') {
      ws.close(1000, 'Left room');
    }
  }

  async webSocketClose(ws) {
    const att = ws.deserializeAttachment();
    if (!att) return; // rejected joiner — never joined the room

    // The closing socket may still appear in getWebSockets() while this
    // handler runs, so always exclude it explicitly.
    const sockets = this.ctx.getWebSockets().filter((w) => w !== ws);
    if (sockets.length === 0) {
      await this.ctx.storage.deleteAll(); // room empty — free the code
      return;
    }
    for (const other of sockets) {
      const me = other.deserializeAttachment();
      if (!me) continue;
      sendJson(other, {
        type: 'event',
        event: 'room-update',
        payload: {
          peers: sockets
            .map((w) => w.deserializeAttachment())
            .filter((a) => a && a.id && a.id !== me.id),
        },
      });
    }
  }

  async webSocketError(_ws, error) {
    console.error('WebSocket error in CallRoom:', error);
  }
}

// ---------------------------------------------------------------------------
// Worker — routes HTTP + WebSocket traffic
// ---------------------------------------------------------------------------
export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/health') {
      return Response.json({ ok: true });
    }

    // Reserve a room code (RPC into a fresh Durable Object).
    if (url.pathname === '/api/rooms' && request.method === 'POST') {
      let name = 'Guest';
      try {
        const body = await request.json();
        name = cleanName(body.name);
      } catch {}

      for (let attempt = 0; attempt < 12; attempt++) {
        const code = makeRoomCode();
        const id = env.CALL_ROOM.idFromName('room:' + code);
        const stub = env.CALL_ROOM.get(id);
        if (await stub.claim(Date.now())) {
          return Response.json({ ok: true, code });
        }
      }
      return Response.json(
        { ok: false, error: 'Could not create a room. Try again.' },
        { status: 500 }
      );
    }

    // Join an existing room via WebSocket.
    if (url.pathname === '/room') {
      const code = String(url.searchParams.get('code') || '').trim().toUpperCase();
      if (!/^[A-Z0-9]{4,8}$/.test(code)) {
        return new Response('Bad room code', { status: 400 });
      }
      const id = env.CALL_ROOM.idFromName('room:' + code);
      const stub = env.CALL_ROOM.get(id);
      return stub.fetch(request);
    }

    // Everything else → static assets (the web app in ../public).
    return env.ASSETS.fetch(request);
  },
};
