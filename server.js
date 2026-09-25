// server.js — Lucky Vault HTTP-Server (keine Abhängigkeiten!)
// Start:   node server.js
// Dann im Browser öffnen:  http://localhost:8080

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 8080;

/* ---------- In-Memory-Daten ---------- */
const users = new Map();          // name -> { password, token }
const sessions = new Map();       // token -> name
const queue = [];                 // [{ name }]
const rooms = new Map();          // roomId -> room

function newToken() { return crypto.randomBytes(16).toString('hex'); }
function newRoomId() {
  return 'r' + Date.now().toString(36) + crypto.randomBytes(3).toString('hex');
}
function findRoomByName(name) {
  for (const [id, r] of rooms) {
    if (r.a.name === name) return { id, side: 'a', room: r };
    if (r.b.name === name) return { id, side: 'b', room: r };
  }
  return null;
}

/* ---------- HTTP Helfer ---------- */
function sendJSON(res, code, data) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}
function readBody(req) {
  return new Promise(resolve => {
    let b = '';
    req.on('data', c => { b += c; if (b.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch { resolve({}); } });
  });
}

/* ---------- API Handler ---------- */
function apiLogin(req, res, body) {
  const name = String(body.name || '').trim().slice(0, 16);
  const password = String(body.password || '').slice(0, 64);

  if (name.length < 2) return sendJSON(res, 400, { error: 'Name zu kurz (min. 2)' });
  if (password.length < 3) return sendJSON(res, 400, { error: 'Passwort zu kurz (min. 3)' });

  const existing = users.get(name);
  if (existing) {
    if (existing.password !== password) return sendJSON(res, 401, { error: 'Falsches Passwort' });
    const token = newToken();
    sessions.set(token, name);
    existing.token = token;
    return sendJSON(res, 200, { token, name });
  }
  const token = newToken();
  users.set(name, { password, token });
  sessions.set(token, name);
  return sendJSON(res, 200, { token, name });
}

function apiQueue(req, res, body) {
  const name = sessions.get(body.token);
  if (!name) return sendJSON(res, 401, { error: 'Nicht angemeldet' });

  // Schon in einem Raum?
  const existing = findRoomByName(name);
  if (existing) {
    const other = existing.room[existing.side === 'a' ? 'b' : 'a'];
    return sendJSON(res, 200, {
      state: 'matched',
      roomId: existing.id,
      side: existing.side,
      opponent: other.name
    });
  }

  // Schon in Warteschlange?
  if (queue.find(q => q.name === name)) return sendJSON(res, 200, { state: 'queued' });

  // Gegner suchen
  let opponent = null;
  while (queue.length > 0) {
    const cand = queue.shift();
    if (cand.name !== name && sessions.has(users.get(cand.name)?.token)) {
      opponent = cand;
      break;
    }
  }

  if (!opponent) {
    queue.push({ name });
    return sendJSON(res, 200, { state: 'queued' });
  }

  const roomId = newRoomId();
  rooms.set(roomId, {
    a: { name: opponent.name },
    b: { name },
    bets: { a: null, b: null },
    result: null,
    resultDelivered: { a: false, b: false }
  });
  return sendJSON(res, 200, {
    state: 'matched',
    roomId, side: 'b', opponent: opponent.name
  });
}

function apiPoll(req, res, body) {
  const name = sessions.get(body.token);
  if (!name) return sendJSON(res, 401, { error: 'Nicht angemeldet' });

  const found = findRoomByName(name);
  if (found) {
    const { id: roomId, side, room } = found;
    const otherSide = side === 'a' ? 'b' : 'a';
    const other = room[otherSide];
    const myBet = room.bets[side];
    const opBet = room.bets[otherSide];

    if (room.result) {
      const you   = side === 'a' ? room.result.rollA : room.result.rollB;
      const opp   = side === 'a' ? room.result.rollB : room.result.rollA;
      const winner = room.result.winnerA === side ? 'you'
                   : room.result.winnerA === otherSide ? 'opp'
                   : 'tie';

      if (!room.resultDelivered[side]) {
        room.resultDelivered[side] = true;
        // Wenn beide das Ergebnis gesehen haben → Raum für neue Runde zurücksetzen
        if (room.resultDelivered.a && room.resultDelivered.b) {
          room.result = null;
          room.resultDelivered = { a: false, b: false };
          room.bets = { a: null, b: null };
        }
        return sendJSON(res, 200, {
          state: 'result', you, opp, winner,
          opponent: other.name
        });
      }
    }

    return sendJSON(res, 200, {
      state: 'matched',
      roomId, side,
      opponent: other.name,
      myBet, opBet
    });
  }

  if (queue.find(q => q.name === name)) return sendJSON(res, 200, { state: 'queued' });
  return sendJSON(res, 200, { state: 'idle' });
}

function apiBet(req, res, body) {
  const name = sessions.get(body.token);
  if (!name) return sendJSON(res, 401, { error: 'Nicht angemeldet' });

  const found = findRoomByName(name);
  if (!found) return sendJSON(res, 404, { error: 'Kein Raum' });

  const { side, room } = found;
  const amount = Math.max(1, Math.min(10000, Math.floor(Number(body.amount) || 0)));
  room.bets[side] = amount;

  // Beide haben gesetzt → würfeln
  if (room.bets.a !== null && room.bets.b !== null && !room.result) {
    const rollA = Math.round(Math.random() * 10000) / 100;
    const rollB = Math.round(Math.random() * 10000) / 100;
    let winnerA;
    if (rollA > rollB) winnerA = 'a';
    else if (rollA < rollB) winnerA = 'b';
    else winnerA = 'tie';
    room.result = { rollA, rollB, winnerA };
  }

  return sendJSON(res, 200, { ok: true });
}

function apiLeave(req, res, body) {
  const name = sessions.get(body.token);
  if (!name) return sendJSON(res, 401, { error: 'Nicht angemeldet' });

  const qi = queue.findIndex(q => q.name === name);
  if (qi >= 0) queue.splice(qi, 1);

  const found = findRoomByName(name);
  if (found) rooms.delete(found.id);

  return sendJSON(res, 200, { ok: true });
}

/* ---------- Statische Dateien ausliefern ---------- */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png':  'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.svg':  'image/svg+xml', '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json'
};

function serveStatic(req, res) {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/index.html';
  const filePath = path.join(__dirname, p);
  // Sicherheitscheck: Datei muss im Projektordner liegen
  if (!filePath.startsWith(__dirname)) return sendJSON(res, 403, { error: 'Forbidden' });

  fs.readFile(filePath, (err, data) => {
    if (err) return sendJSON(res, 404, { error: 'Nicht gefunden' });
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

/* ---------- Hauptserver ---------- */
const server = http.createServer(async (req, res) => {
  const p = req.url.split('?')[0];

  if (p.startsWith('/api/')) {
    const body = (req.method === 'POST') ? await readBody(req) : {};
    try {
      if (p === '/api/login') return apiLogin(req, res, body);
      if (p === '/api/queue') return apiQueue(req, res, body);
      if (p === '/api/poll')  return apiPoll(req, res, body);
      if (p === '/api/bet')   return apiBet(req, res, body);
      if (p === '/api/leave') return apiLeave(req, res, body);
      return sendJSON(res, 404, { error: 'Unbekannter Endpunkt' });
    } catch (e) {
      console.error(e);
      return sendJSON(res, 500, { error: 'Serverfehler' });
    }
  }

  if (req.method === 'GET') return serveStatic(req, res);
  sendJSON(res, 405, { error: 'Method not allowed' });
});

server.listen(PORT, () => {
  console.log('═══════════════════════════════════════════════════');
  console.log('  Lucky Vault läuft auf:  http://localhost:' + PORT);
  console.log('  Einfach im Browser öffnen. Kein npm install.');
  console.log('═══════════════════════════════════════════════════');
});