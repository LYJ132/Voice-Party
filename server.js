'use strict';
/* Voice Party - mobile room server (zero dependencies).
   Serves the single-page client AND relays room state so two real devices on
   the same network can play together. The host (player A) is authoritative for
   the bird; the guest (player B) sends its control value and renders the host's
   state. Both directions travel in ONE request/response, so the perceived
   latency is a single round-trip instead of two.

   Endpoints (POST, JSON):
     /api/room/create  {diff,source,level:{seed,customLine}} -> {code,role:'A',token,room}
     /api/room/join    {code}                                -> {code,role:'B',token,room}
     /api/room/ready   {code,token,ready}                   -> {room}
     /api/room/start   {code,token}                         -> {room}   (host only)
     /api/room/stop    {code,token}                         -> {room}   (host only, back to lobby)
     /api/room/sync    {code,token,role,ctrl,state}         -> {room}
     /api/room/leave   {code,token}                         -> {ok}
   GET  /api/room/state?code=XXXXXX -> {room}  (public lobby snapshot)
   GET  /            -> index.html
*/
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT || 8123);
const HOST = '0.0.0.0';
const ROOT = __dirname;
const ROOM_TTL = 30 * 60 * 1000;   /* drop abandoned rooms after 30 min */
const CODE_ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

const rooms = new Map();

/* ---------------------------------------------------------------- helpers */
function newCode() {
  for (let i = 0; i < 50; i++) {
    let c = '';
    for (let k = 0; k < 6; k++) c += CODE_ALPHA[crypto.randomInt(CODE_ALPHA.length)];
    if (!rooms.has(c)) return c;
  }
  return 'R' + Date.now().toString(36).toUpperCase().slice(-5);
}
function newToken() { return crypto.randomBytes(12).toString('base64url'); }

function publicRoom(r) {
  return {
    phase: r.phase,
    diff: r.diff,
    source: r.source,
    level: r.level,
    startAt: r.startAt,
    members: {
      A: { joined: r.members.A.joined, ready: r.members.A.ready },
      B: { joined: r.members.B.joined, ready: r.members.B.ready }
    },
    ctrl: { A: r.ctrl.A, B: r.ctrl.B },
    state: r.state,
    tick: r.tick
  };
}

function send(res, code, obj) {
  /* `now` lets the client compute the clock offset between its own device and
     this server. Two phones rarely share a clock, and the shared countdown
     (startAt) is issued in SERVER time — without the offset the two devices
     would start the round at different moments. */
  if(obj && typeof obj==='object' && obj.ok!==undefined) obj.now=Date.now();
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body)
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let d = '';
    req.on('data', (c) => {
      d += c;
      if (d.length > 1e6) { req.destroy(); reject(new Error('payload too large')); }
    });
    req.on('end', () => {
      try { resolve(d ? JSON.parse(d) : {}); }
      catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

function getRoom(code, token) {
  const r = rooms.get(String(code || '').toUpperCase());
  if (!r) return { err: 'ROOM_NOT_FOUND' };
  if (token && !(r.tokens.A === token || r.tokens.B === token)) return { err: 'BAD_TOKEN' };
  return { r };
}

/* ------------------------------------------------------------------ rooms */
function createRoom(body) {
  const code = newCode();
  const token = newToken();
  const diff = ['easy', 'normal', 'hard'].includes(body.diff) ? body.diff : 'easy';
  const source = body.source === 'volume' ? 'volume' : 'pitch';
  /* A hand-drawn strip carries its own style (pipes / spikes) and loop length.
     Both must survive the customLine branch, otherwise host and guest sample
     different geometry. */
  const customStyle = body.level && body.level.customStyle === 'spikes' ? 'spikes' : 'pipes';
  const loopLen = Math.max(400, Math.min(9600, Number(body.level && body.level.loopLen) || 3000));
  /* A custom track is a list of GATE heights plus the spacing between them,
     so the guest must get the spacing too or its gates land elsewhere. */
  const keyGap = Math.max(40, Math.min(600, Number(body.level && body.level.keyGap) || 0));
  let level = {
    seed: (Number(body.level && body.level.seed) || 1) >>> 0,
    customLine: null,
    keyGap: 0,
    track: ['random', 'spikes', 'custom'].includes(body.level && body.level.track)
      ? body.level.track
      : (body.level && Array.isArray(body.level.customLine) ? 'custom' : 'random'),
    customStyle,
    loopLen
  };
  if (body.level && Array.isArray(body.level.customLine) && body.level.customLine.length >= 4) {
    level = {
      seed: level.seed,
      customLine: body.level.customLine.map((v) => Math.round(Number(v) * 100) / 100),
      keyGap,
      track: level.track,
      customStyle,
      loopLen
    };
  }
  const r = {
    code,
    phase: 'lobby',
    diff,
    source,
    level,
    /* The host has no ready button, so creating the room IS the host's ready
       signal. Without this A.ready stays false forever and /start (which
       requires both players) can never succeed. */
    members: { A: { joined: true, ready: true }, B: { joined: false, ready: false } },
    tokens: { A: token, B: null },
    ctrl: { A: { v: 0, hz: 0, t: 0 }, B: { v: 0, hz: 0, t: 0 } },
    state: null,
    startAt: 0,
    tick: 0,
    createdAt: Date.now(),
    lastActive: Date.now()
  };
  rooms.set(code, r);
  return { r, token };
}

function joinRoom(code) {
  const r = rooms.get(String(code || '').toUpperCase());
  if (!r) return { err: 'ROOM_NOT_FOUND' };
  if (r.phase === 'closed') return { err: 'ROOM_CLOSED' };
  if (r.members.B.joined) return { err: 'ROOM_FULL' };
  const token = newToken();
  r.tokens.B = token;
  r.members.B.joined = true;
  r.lastActive = Date.now();
  return { r, token };
}

function leaveRoom(code, token) {
  const r = rooms.get(String(code || '').toUpperCase());
  if (!r) return;
  if (r.tokens.A === token) { r.phase = 'closed'; r.members.A.joined = false; r.members.A.ready = false; }
  else if (r.tokens.B === token) { r.members.B.joined = false; r.members.B.ready = false; r.tokens.B = null; }
  r.lastActive = Date.now();
  if (!r.members.A.joined && !r.members.B.joined) rooms.delete(r.code);
}

/* ----------------------------------------------------------------- routes */
async function handleApi(req, res, url) {
  if (req.method === 'GET' && url.pathname === '/api/room/state') {
    const code = String(url.searchParams.get('code') || '').toUpperCase();
    const r = rooms.get(code);
    if (!r) return send(res, 404, { ok: false, error: 'ROOM_NOT_FOUND' });
    return send(res, 200, { ok: true, room: publicRoom(r) });
  }

  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'METHOD_NOT_ALLOWED' });

  let body = {};
  try { body = await readBody(req); } catch (e) {
    return send(res, 400, { ok: false, error: 'BAD_JSON' });
  }

  const p = url.pathname;

  if (p === '/api/room/create') {
    const { r, token } = createRoom(body);
    return send(res, 200, { ok: true, code: r.code, role: 'A', token, room: publicRoom(r) });
  }

  if (p === '/api/room/join') {
    const j = joinRoom(body.code);
    if (j.err) return send(res, 404, { ok: false, error: j.err });
    return send(res, 200, { ok: true, code: j.r.code, role: 'B', token: j.token, room: publicRoom(j.r) });
  }

  if (p === '/api/room/ready') {
    const g = getRoom(body.code, body.token);
    if (g.err) return send(res, 404, { ok: false, error: g.err });
    const r = g.r;
    const side = r.tokens.A === body.token ? 'A' : 'B';
    r.members[side].ready = !!body.ready;
    r.lastActive = Date.now();
    return send(res, 200, { ok: true, room: publicRoom(r) });
  }

  if (p === '/api/room/start') {
    const g = getRoom(body.code, body.token);
    if (g.err) return send(res, 404, { ok: false, error: g.err });
    const r = g.r;
    if (r.tokens.A !== body.token) return send(res, 403, { ok: false, error: 'HOST_ONLY' });
    if (!r.members.B.joined) return send(res, 409, { ok: false, error: 'NEED_TWO' });
    if (!r.members.A.ready || !r.members.B.ready) return send(res, 409, { ok: false, error: 'NOT_READY' });
    r.phase = 'play';
    r.startAt = Date.now() + 1800;   /* shared countdown instant for both devices */
    r.lastActive = Date.now();
    return send(res, 200, { ok: true, room: publicRoom(r) });
  }

  if (p === '/api/room/stop') {
    /* The host ends the run for BOTH players: phase back to lobby so every
       client's poll picks the transition up and returns to the room screen
       without a tap. Ctrl values are zeroed so no stale push survives. */
    const g = getRoom(body.code, body.token);
    if (g.err) return send(res, 404, { ok: false, error: g.err });
    const r = g.r;
    if (r.tokens.A !== body.token) return send(res, 403, { ok: false, error: 'HOST_ONLY' });
    r.phase = 'lobby';
    r.startAt = 0;
    r.state = null;
    r.ctrl.A = { v: 0, hz: 0, t: 0 };
    r.ctrl.B = { v: 0, hz: 0, t: 0 };
    r.lastActive = Date.now();
    return send(res, 200, { ok: true, room: publicRoom(r) });
  }

  if (p === '/api/room/sync') {
    const g = getRoom(body.code, body.token);
    if (g.err) return send(res, 404, { ok: false, error: g.err });
    const r = g.r;
    const side = r.tokens.A === body.token ? 'A' : 'B';
    if (body.ctrl && typeof body.ctrl.v === 'number') {
      r.ctrl[side] = {
        v: Math.max(-1, Math.min(1, body.ctrl.v)),
        hz: Number(body.ctrl.hz) || 0,
        t: Date.now()
      };
    }
    if (side === 'A' && body.state) {
      /* The host owns the authoritative bird. The guest needs x (to place the
         world), y, theta, vy (to interpolate between 30 Hz updates), score
         and the alive flag to render the same frame. */
      r.state = {
        x: Number(body.state.x) || 0,
        y: Number(body.state.y) || 0,
        theta: Number(body.state.theta) || 0,
        vy: Number(body.state.vy) || 0,
        score: Number(body.state.score) || 0,
        alive: body.state.alive !== false,
        dist: Number(body.state.dist) || 0,
        paused: !!body.state.paused
      };
    }
    r.tick++;
    r.lastActive = Date.now();
    return send(res, 200, { ok: true, room: publicRoom(r) });
  }

  if (p === '/api/room/leave') {
    leaveRoom(body.code, body.token);
    return send(res, 200, { ok: true });
  }

  return send(res, 404, { ok: false, error: 'NO_ENDPOINT' });
}

/* ----------------------------------------------------------------- static */
function serveStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  const file = path.join(ROOT, path.normalize(rel).replace(/^([/\\])+/, ''));
  if (!file.startsWith(ROOT)) return send(res, 403, { ok: false, error: 'FORBIDDEN' });
  fs.readFile(file, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('404');
    }
    const ext = path.extname(file).toLowerCase();
    const type = ext === '.html' ? 'text/html; charset=utf-8'
      : ext === '.js' ? 'text/javascript; charset=utf-8'
        : ext === '.css' ? 'text/css; charset=utf-8'
          : ext === '.json' ? 'application/json; charset=utf-8'
            : ext === '.png' ? 'image/png' : 'application/octet-stream';
    res.writeHead(200, {
      'Content-Type': type,
      'Cache-Control': ext === '.html' ? 'no-store' : 'public, max-age=300'
    });
    res.end(buf);
  });
}

const server = http.createServer((req, res) => {
  let url;
  try { url = new URL(req.url, 'http://localhost'); }
  catch (e) { return send(res, 400, { ok: false, error: 'BAD_URL' }); }

  if (url.pathname.startsWith('/api/')) {
    handleApi(req, res, url).catch(() => send(res, 500, { ok: false, error: 'INTERNAL' }));
    return;
  }
  serveStatic(req, res, url);
});

setInterval(() => {
  const now = Date.now();
  for (const [code, r] of rooms) {
    if (now - r.lastActive > ROOM_TTL || (r.phase === 'closed' && now - r.lastActive > 60 * 1000)) {
      rooms.delete(code);
    }
  }
}, 60 * 1000).unref();

server.listen(PORT, HOST, () => {
  const nets = require('os').networkInterfaces();
  const lan = [];
  for (const name of Object.keys(nets)) {
    for (const n of nets[name] || []) {
      if (n.family === 'IPv4' && !n.internal) lan.push(n.address);
    }
  }
  console.log('Voice Party server on port ' + PORT);
  console.log('  local: http://127.0.0.1:' + PORT);
  for (const ip of lan) console.log('  lan:   http://' + ip + ':' + PORT + '   <- open this on the second phone');
});
