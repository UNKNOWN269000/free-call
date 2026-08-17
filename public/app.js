/* ==========================================================================
 * FreeCall — client
 *
 * Signaling (room codes, offers/answers, ICE candidates) travels through the
 * small Socket.IO server. The actual audio/video goes peer-to-peer via
 * WebRTC, straight between the two devices — that's what makes it free.
 * ========================================================================== */

(() => {
  'use strict';

  const socket = io();

  // ------------------------------------------------------------------ DOM
  const $ = (id) => document.getElementById(id);
  const screens = {
    home: $('home-screen'),
    room: $('room-screen'),
    call: $('call-screen'),
  };
  const els = {
    nameInput: $('name-input'),
    createBtn: $('create-btn'),
    codeInput: $('code-input'),
    joinBtn: $('join-btn'),
    roomCode: $('room-code'),
    roomStatus: $('room-status'),
    copyLinkBtn: $('copy-link-btn'),
    callBtn: $('call-btn'),
    peers: $('peers'),
    topLeave: $('top-leave'),
    remoteVideo: $('remote-video'),
    localVideo: $('local-video'),
    overlay: $('call-overlay'),
    overlayAvatar: $('overlay-avatar'),
    overlayTitle: $('overlay-title'),
    overlaySub: $('overlay-sub'),
    acceptBtn: $('accept-btn'),
    declineBtn: $('decline-btn'),
    cancelBtn: $('cancel-btn'),
    controls: $('controls'),
    muteBtn: $('mute-btn'),
    camBtn: $('cam-btn'),
    shareBtn: $('share-btn'),
    hangupBtn: $('hangup-btn'),
    toast: $('toast'),
  };

  // ------------------------------------------------------------------ state
  const state = {
    name: '',
    code: null,
    peer: null,           // { id, name } — the other person in the room
    status: 'idle',       // idle | waiting | ringing-out | ringing-in | in-call
    pc: null,
    local: null,          // local MediaStream
    pendingOffer: null,
    pendingCandidates: [],
    sharing: false,
    savedCamTrack: null,
  };

  const PC_CONFIG = {
    iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
  };

  const STATUS_TEXT = {
    idle: '',
    waiting: (peer) =>
      peer
        ? `${peer.name} is in the room. Ready to call?`
        : 'Share your code (or the invite link) and wait for your friend to join.',
    'ringing-out': (peer) => `Calling ${peer ? peer.name : '…'}…`,
    'ringing-in': (peer) => `${peer ? peer.name : 'Someone'} is calling you…`,
    'in-call': (peer) => `On a call with ${peer ? peer.name : '…'}`,
  };

  // ------------------------------------------------------------------ utils
  function show(screen) {
    Object.values(screens).forEach((s) => s.classList.add('hidden'));
    screen.classList.remove('hidden');
  }

  let toastTimer = null;
  function toast(msg, kind = '') {
    els.toast.textContent = msg;
    els.toast.className = `toast ${kind}`;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => els.toast.classList.add('hidden'), 3200);
  }

  function getInitials(name) {
    return (name || '?')
      .split(/\s+/)
      .map((w) => w[0])
      .join('')
      .slice(0, 2)
      .toUpperCase();
  }

  function inviteUrl() {
    return `${location.origin}${location.pathname}#join=${state.code}`;
  }

  // ------------------------------------------------------------------ UI
  function updateRoomUI() {
    els.roomCode.textContent = state.code || '······';
    els.roomStatus.textContent = STATUS_TEXT[state.status]
      ? STATUS_TEXT[state.status](state.peer)
      : '';

    els.peers.innerHTML = '';
    if (state.peer) {
      const chip = document.createElement('span');
      chip.className = 'peer-chip';
      chip.innerHTML = `<span class="dot"></span>${escapeHtml(state.peer.name)}`;
      els.peers.appendChild(chip);
    }

    const canCall = Boolean(state.peer) && (state.status === 'waiting');
    els.callBtn.classList.toggle('hidden', !canCall);
  }

  function updateCallUI() {
    const ringingIn = state.status === 'ringing-in';
    const ringingOut = state.status === 'ringing-out';
    const inCall = state.status === 'in-call';
    const showOverlay = ringingIn || ringingOut;

    els.overlay.classList.toggle('hidden', !showOverlay);
    els.controls.classList.toggle('hidden', !inCall);
    els.localVideo.classList.toggle('hidden', !(state.local && (inCall || showOverlay)));
    els.remoteVideo.classList.toggle('empty', !els.remoteVideo.srcObject);

    if (showOverlay) {
      const peerName = state.peer ? state.peer.name : 'Friend';
      els.overlayAvatar.textContent = getInitials(peerName);
      els.overlayTitle.textContent = ringingIn ? peerName : 'Calling…';
      els.overlaySub.textContent = ringingIn
        ? 'Incoming call — it’s free, answer away!'
        : `${peerName}’s phone is ringing…`;
      els.acceptBtn.classList.toggle('hidden', !ringingIn);
      els.declineBtn.classList.toggle('hidden', !ringingIn);
      els.cancelBtn.classList.toggle('hidden', !ringingOut);
    }

    // control button states
    const audioTrack = state.local && state.local.getAudioTracks()[0];
    const videoTrack = state.local && state.local.getVideoTracks()[0];
    els.muteBtn.classList.toggle('off', !!(audioTrack && !audioTrack.enabled));
    els.camBtn.classList.toggle('off', !!(videoTrack && !videoTrack.enabled));
    els.shareBtn.classList.toggle('off', state.sharing);
  }

  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
    );
  }

  // ------------------------------------------------------------------ ringtones
  let ring = null;

  function startRingtone(kind) {
    stopRingtone();
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    ctx.resume().catch(() => {});

    const beep = (freq, t0, dur, vol = 0.22) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, t0);
      gain.gain.exponentialRampToValueAtTime(vol, t0 + 0.03);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t0);
      osc.stop(t0 + dur + 0.05);
    };

    const playPattern = () => {
      const t = ctx.currentTime + 0.03;
      if (kind === 'in') {
        // European-style double ring
        beep(880, t, 0.4);
        beep(880, t + 0.55, 0.4);
      } else {
        // US-style ringback
        beep(440, t, 1.0, 0.16);
        beep(480, t, 1.0, 0.16);
      }
    };

    playPattern();
    ring = {
      ctx,
      timer: setInterval(playPattern, kind === 'in' ? 2000 : 3000),
    };
  }

  function stopRingtone() {
    if (!ring) return;
    clearInterval(ring.timer);
    try { ring.ctx.close(); } catch {}
    ring = null;
  }

  // ------------------------------------------------------------------ media
  async function getLocalMedia() {
    if (state.local) return state.local;
    state.local = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    els.localVideo.srcObject = state.local;
    await els.localVideo.play().catch(() => {});
    return state.local;
  }

  function handleMediaError(err) {
    console.error('Media error:', err);
    const denied =
      err && (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError' || err.name === 'SecurityError');
    toast(
      denied
        ? 'Camera/microphone access was blocked. Allow it in your browser settings, then try again.'
        : 'Could not access camera/microphone. Check that no other app is using them.',
      'error'
    );
    teardownCall({ silent: true });
    if (state.code) state.status = 'waiting';
    updateRoomUI();
    updateCallUI();
    show(screens.room);
  }

  // ------------------------------------------------------------------ WebRTC
  function createPeerConnection() {
    const pc = new RTCPeerConnection(PC_CONFIG);
    state.pc = pc;

    pc.onicecandidate = (e) => {
      if (e.candidate) socket.emit('ice', { candidate: e.candidate });
    };

    pc.ontrack = (e) => {
      els.remoteVideo.srcObject = e.streams[0];
      els.remoteVideo.play().catch(() => {});
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'connected') stopRingtone();
      if (pc.connectionState === 'failed') {
        toast('Connection lost. Check that both sides still have internet.', 'error');
        teardownCall({ silent: true });
        state.status = 'waiting';
        updateRoomUI();
        updateCallUI();
        show(screens.room);
      }
    };

    for (const track of state.local.getTracks()) {
      pc.addTrack(track, state.local);
    }
    return pc;
  }

  async function flushCandidates() {
    const pc = state.pc;
    if (!pc || !pc.remoteDescription) return;
    const queue = state.pendingCandidates;
    state.pendingCandidates = [];
    for (const candidate of queue) {
      try { await pc.addIceCandidate(candidate); } catch {}
    }
  }

  function teardownCall({ silent = false } = {}) {
    stopRingtone();
    if (state.pc) {
      state.pc.onicecandidate = null;
      state.pc.ontrack = null;
      state.pc.onconnectionstatechange = null;
      try { state.pc.close(); } catch {}
      state.pc = null;
    }
    if (state.local) {
      state.local.getTracks().forEach((t) => t.stop());
      state.local = null;
    }
    els.remoteVideo.srcObject = null;
    els.localVideo.srcObject = null;
    state.pendingOffer = null;
    state.pendingCandidates = [];
    state.sharing = false;
    state.savedCamTrack = null;
    if (!silent) toast('Call ended', '');
  }

  // ------------------------------------------------------------------ call flow
  async function startCall() {
    if (!state.peer || state.status !== 'waiting') return;
    try {
      await getLocalMedia();
      createPeerConnection();
      const offer = await state.pc.createOffer();
      await state.pc.setLocalDescription(offer);
      state.status = 'ringing-out';
      updateRoomUI();
      updateCallUI();
      show(screens.call);
      startRingtone('out');
      socket.emit('call', { name: state.name, sdp: offer });
    } catch (err) {
      handleMediaError(err);
    }
  }

  async function acceptCall() {
    try {
      await getLocalMedia();
      createPeerConnection();
      await state.pc.setRemoteDescription(state.pendingOffer);
      state.pendingOffer = null;
      await flushCandidates();
      const answer = await state.pc.createAnswer();
      await state.pc.setLocalDescription(answer);
      state.status = 'in-call';
      stopRingtone();
      updateRoomUI();
      updateCallUI();
      socket.emit('accept', { sdp: answer });
    } catch (err) {
      handleMediaError(err);
    }
  }

  function declineCall() {
    socket.emit('decline', {});
    stopRingtone();
    state.status = 'waiting';
    teardownCall({ silent: true });
    updateRoomUI();
    updateCallUI();
    show(screens.room);
  }

  function cancelCall() {
    socket.emit('cancel', {});
    stopRingtone();
    state.status = 'waiting';
    teardownCall({ silent: true });
    updateRoomUI();
    updateCallUI();
    show(screens.room);
  }

  function hangup() {
    if (state.status === 'ringing-out') { cancelCall(); return; }
    if (state.status === 'ringing-in') { declineCall(); return; }
    socket.emit('end-call', {});
    state.status = 'waiting';
    teardownCall({ silent: true });
    updateRoomUI();
    updateCallUI();
    show(screens.room);
  }

  // ------------------------------------------------------------------ controls
  function toggleMute() {
    const track = state.local && state.local.getAudioTracks()[0];
    if (!track) return;
    track.enabled = !track.enabled;
    updateCallUI();
  }

  function toggleCamera() {
    const track = state.local && state.local.getVideoTracks()[0];
    if (!track) return;
    track.enabled = !track.enabled;
    updateCallUI();
  }

  async function toggleScreenShare() {
    if (!state.pc) return;
    const sender = state.pc.getSenders().find((s) => s.track && s.track.kind === 'video');
    if (!sender) return;

    if (state.sharing) {
      state.sharing = false;
      if (state.savedCamTrack) await sender.replaceTrack(state.savedCamTrack);
      state.savedCamTrack = null;
      updateCallUI();
      return;
    }

    try {
      const display = await navigator.mediaDevices.getDisplayMedia({ video: true });
      state.savedCamTrack = state.local ? state.local.getVideoTracks()[0] || null : null;
      const screenTrack = display.getVideoTracks()[0];
      await sender.replaceTrack(screenTrack);
      state.sharing = true;
      updateCallUI();
      screenTrack.onended = () => {
        state.sharing = false;
        if (state.pc && state.savedCamTrack) {
          sender.replaceTrack(state.savedCamTrack).catch(() => {});
        }
        state.savedCamTrack = null;
        updateCallUI();
      };
    } catch {
      // user cancelled the picker — nothing to do
    }
  }

  // ------------------------------------------------------------------ signaling (incoming)
  socket.on('call', (msg) => {
    if (state.status === 'ringing-in' || state.status === 'in-call' || state.status === 'ringing-out') {
      socket.emit('decline', {});
      return;
    }
    state.peer = { id: msg.from, name: msg.name || 'Friend' };
    state.pendingOffer = msg.sdp;
    state.status = 'ringing-in';
    updateRoomUI();
    updateCallUI();
    show(screens.call);
    startRingtone('in');
  });

  socket.on('accept', async (msg) => {
    if (!state.pc || state.status !== 'ringing-out') return;
    try {
      await state.pc.setRemoteDescription(msg.sdp);
      await flushCandidates();
      state.status = 'in-call';
      stopRingtone();
      updateRoomUI();
      updateCallUI();
    } catch (err) {
      console.error(err);
    }
  });

  socket.on('decline', () => {
    if (state.status !== 'ringing-out') return;
    toast('Call declined', 'error');
    state.status = 'waiting';
    teardownCall({ silent: true });
    updateRoomUI();
    updateCallUI();
    show(screens.room);
  });

  socket.on('cancel', () => {
    if (state.status !== 'ringing-in') return;
    toast('Call cancelled', '');
    state.status = 'waiting';
    teardownCall({ silent: true });
    updateRoomUI();
    updateCallUI();
    show(screens.room);
  });

  socket.on('end-call', () => {
    if (state.status === 'in-call' || state.status === 'ringing-in') {
      toast('Call ended', '');
      state.status = 'waiting';
      teardownCall({ silent: true });
      updateRoomUI();
      updateCallUI();
      show(screens.room);
    }
  });

  socket.on('ice', async (msg) => {
    const pc = state.pc;
    if (!pc) return;
    if (!pc.remoteDescription) {
      state.pendingCandidates.push(msg.candidate);
      return;
    }
    try { await pc.addIceCandidate(msg.candidate); } catch {}
  });

  socket.on('room-update', ({ peers }) => {
    const previousPeerId = state.peer && state.peer.id;
    state.peer = peers[0] || null;

    if (previousPeerId && !state.peer) {
      // Our peer left.
      if (state.status !== 'waiting') {
        toast('Your friend left the room.', '');
        teardownCall({ silent: true });
        state.status = 'waiting';
      }
      updateRoomUI();
      updateCallUI();
      show(screens.room);
      return;
    }

    if (state.peer && !previousPeerId && state.status === 'waiting') {
      toast(`${state.peer.name} joined the room!`, 'ok');
    }
    updateRoomUI();
  });

  // ------------------------------------------------------------------ room actions
  function createRoom() {
    const name = els.nameInput.value.trim();
    socket.emit('create-room', { name }, (res) => {
      if (!res || !res.ok) { toast('Could not create a room. Try again.', 'error'); return; }
      enterRoom(res.code, name);
    });
  }

  function joinRoom() {
    const name = els.nameInput.value.trim();
    const code = els.codeInput.value.trim().toUpperCase();
    if (!code) { toast('Enter the room code your friend shared.', 'error'); return; }
    socket.emit('join-room', { code, name }, (res) => {
      if (!res || !res.ok) { toast(res ? res.error : 'Could not join.', 'error'); return; }
      enterRoom(res.code, name, res.peers[0] || null);
    });
  }

  function enterRoom(code, name, peer = null) {
    state.name = name || 'Guest';
    state.code = code;
    state.peer = peer ? { id: peer.id, name: peer.name } : null;
    state.status = 'waiting';
    els.topLeave.classList.remove('hidden');
    updateRoomUI();
    show(screens.room);
    if (!peer) toast(`Room ${code} created. Share the code with a friend!`, 'ok');
  }

  function leaveRoom() {
    socket.emit('leave-room');
    teardownCall({ silent: true });
    state.code = null;
    state.peer = null;
    state.status = 'idle';
    els.topLeave.classList.add('hidden');
    updateRoomUI();
    show(screens.home);
  }

  async function copyInviteLink() {
    try {
      await navigator.clipboard.writeText(inviteUrl());
      toast(`Invite link copied! Send it to your friend.`, 'ok');
    } catch {
      window.prompt('Copy this link and send it to your friend:', inviteUrl());
    }
  }

  // ------------------------------------------------------------------ wiring
  els.createBtn.addEventListener('click', createRoom);
  els.joinBtn.addEventListener('click', joinRoom);
  els.copyLinkBtn.addEventListener('click', copyInviteLink);
  els.callBtn.addEventListener('click', startCall);
  els.topLeave.addEventListener('click', leaveRoom);
  els.acceptBtn.addEventListener('click', acceptCall);
  els.declineBtn.addEventListener('click', declineCall);
  els.cancelBtn.addEventListener('click', cancelCall);
  els.hangupBtn.addEventListener('click', hangup);
  els.muteBtn.addEventListener('click', toggleMute);
  els.camBtn.addEventListener('click', toggleCamera);
  els.shareBtn.addEventListener('click', toggleScreenShare);

  els.codeInput.addEventListener('input', () => {
    els.codeInput.value = els.codeInput.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
  });

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && state.code) updateRoomUI();
  });

  window.addEventListener('beforeunload', () => {
    stopRingtone();
    if (state.local) state.local.getTracks().forEach((t) => t.stop());
  });

  // ------------------------------------------------------------------ deep link
  const hash = location.hash.match(/join=([A-Za-z0-9]{4,8})/);
  if (hash) {
    const code = hash[1].toUpperCase();
    els.codeInput.value = code;
    els.nameInput.focus();
    toast(`Joining room ${code} — enter your name and press Join!`, 'ok');
  } else {
    els.nameInput.focus();
  }

  console.log('%c📞 FreeCall ready — free peer-to-peer calls over Wi-Fi / data.', 'font-weight:bold;');
})();
