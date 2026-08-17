/**
 * FreeCall signaling test suite.
 *
 * Runs against either:
 *   - the local Node server (spawned automatically), or
 *   - any other backend speaking the same protocol, via:
 *       BASE_URL=http://localhost:8787 node test/signaling.test.js
 */

const { spawn } = require('child_process');
const path = require('path');
const WebSocket = require('ws');

let BASE = process.env.BASE_URL;
let child = null;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForHealth(base, tries = 40) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(base + '/health');
      if (res.ok) return;
    } catch {}
    await sleep(250);
  }
  throw new Error('Server did not become healthy at ' + base);
}

async function createRoom(base, name) {
  const res = await fetch(base + '/api/rooms', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) throw new Error('create-room failed: ' + (data.error || res.status));
  return data.code;
}

function connectWs(base, code, name) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(
      `${base.replace(/^http/, 'ws')}/room?code=${encodeURIComponent(code)}&name=${encodeURIComponent(name)}`
    );
    const messages = [];
    const timer = setTimeout(() => { try { ws.close(); } catch {} reject(new Error('join timeout')); }, 5000);
    ws.on('message', (d) => {
      const m = JSON.parse(d.toString());
      messages.push(m);
      if (m.type === 'joined') { clearTimeout(timer); resolve({ ws, messages, joined: m }); }
      else if (m.type === 'error') { clearTimeout(timer); try { ws.close(); } catch {} reject(new Error(m.message)); }
    });
    ws.on('error', () => { clearTimeout(timer); reject(new Error('ws error')); });
  });
}

function once(ws, predicate, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout waiting for message')), timeout);
    const handler = (d) => {
      const m = JSON.parse(d.toString());
      if (predicate(m)) {
        clearTimeout(timer);
        ws.off('message', handler);
        resolve(m);
      }
    };
    ws.on('message', handler);
  });
}

async function runSuite(base, label) {
  console.log(`\n— Testing ${label} (${base}) —`);

  const code = await createRoom(base, 'Alice');
  console.log('  room created:', code);

  // Alice (creator) joins
  const alice = await connectWs(base, code, 'Alice');
  console.log('  Alice joined, peers:', JSON.stringify(alice.joined.peers));

  // Subscribe to Alice's room-update BEFORE Bob joins (avoid message race)
  const aliceUpdate = once(
    alice.ws,
    (m) => m.type === 'event' && m.event === 'room-update' && m.payload.peers.some((p) => p.name === 'Bob')
  );

  // Bob joins
  const bob = await connectWs(base, code, 'Bob');
  if (bob.joined.peers.length !== 1 || bob.joined.peers[0].name !== 'Alice') {
    throw new Error('Bob should see Alice as peer');
  }
  console.log('  Bob joined, peers:', JSON.stringify(bob.joined.peers));

  // Alice gets room-update about Bob
  const upd = await aliceUpdate;
  console.log('  Alice sees Bob via room-update ✔');

  // Unknown room
  let rejected = false;
  try { await connectWs(base, 'ZZZZZZ', 'X'); } catch { rejected = true; }
  if (!rejected) throw new Error('unknown room should be rejected');
  console.log('  unknown room rejected ✔');

  // Full room
  rejected = false;
  try { await connectWs(base, code, 'Cara'); } catch { rejected = true; }
  if (!rejected) throw new Error('full room should be rejected');
  console.log('  full room rejected ✔');

  // Call relay A -> B
  alice.ws.send(JSON.stringify({ type: 'relay', event: 'call', payload: { name: 'Alice', sdp: { type: 'offer', sdp: 'FAKE' } } }));
  const callMsg = await once(bob.ws, (m) => m.type === 'event' && m.event === 'call');
  if (!callMsg.from || callMsg.payload.sdp.type !== 'offer') throw new Error('call relay broken');
  console.log('  call relayed to Bob ✔');

  // Accept relay B -> A
  bob.ws.send(JSON.stringify({ type: 'relay', event: 'accept', payload: { sdp: { type: 'answer', sdp: 'FAKE' } } }));
  const ans = await once(alice.ws, (m) => m.type === 'event' && m.event === 'accept');
  if (ans.payload.sdp.type !== 'answer') throw new Error('accept relay broken');
  console.log('  accept relayed to Alice ✔');

  // ICE both ways
  bob.ws.send(JSON.stringify({ type: 'relay', event: 'ice', payload: { candidate: { candidate: 'x', sdpMid: '0' } } }));
  const iceA = await once(alice.ws, (m) => m.type === 'event' && m.event === 'ice');
  if (iceA.payload.candidate.candidate !== 'x') throw new Error('ice B->A broken');
  alice.ws.send(JSON.stringify({ type: 'relay', event: 'ice', payload: { candidate: { candidate: 'y', sdpMid: '0' } } }));
  const iceB = await once(bob.ws, (m) => m.type === 'event' && m.event === 'ice');
  if (iceB.payload.candidate.candidate !== 'y') throw new Error('ice A->B broken');
  console.log('  ICE candidates relayed both ways ✔');

  // Bob leaves -> Alice notified
  bob.ws.close();
  const left = await once(alice.ws, (m) => m.type === 'event' && m.event === 'room-update' && m.payload.peers.length === 0);
  console.log('  peer-leave notification ✔');

  alice.ws.close();
  console.log(`✅ ALL TESTS PASSED — ${label}\n`);
}

(async () => {
  if (!BASE) {
    const PORT = 3200 + Math.floor(Math.random() * 400);
    BASE = `http://localhost:${PORT}`;
    child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
      env: { ...process.env, PORT: String(PORT) },
      stdio: 'ignore',
    });
    await waitForHealth(BASE);
  }
  try {
    await runSuite(BASE, BASE === process.env.BASE_URL ? 'external server' : 'Node server');
  } finally {
    if (child) child.kill();
  }
  process.exit(0);
})().catch((err) => {
  console.error('\n❌ TEST FAILED:', err.message);
  if (child) child.kill();
  process.exit(1);
});
