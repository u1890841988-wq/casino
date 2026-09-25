// server.js — WebSocket-Server für Lucky Vault Online-Duell
// Start:   node server.js
// Dann im Browser Online-Tab öffnen und als URL eintragen:  ws://localhost:8080

const WebSocket = require('ws');

const PORT = process.env.PORT || 8080;
const wss = new WebSocket.Server({ port: PORT });

console.log('Lucky Vault Server läuft auf ws://localhost:' + PORT);

let waiting = null;          // { ws, name, id }
let rooms = new Map();       // roomId -> { a: {ws,name,id}, b: {ws,name,id}, bets, rolls }

let idCounter = 1;
function newId() { return 'p' + (idCounter++); }

wss.on('connection', ws => {
  ws.id = newId();
  ws.roomId = null;
  ws.side = null;

  ws.send(JSON.stringify({ type: 'hello', id: ws.id }));

  ws.on('message', raw => {
    let m;
    try { m = JSON.parse(raw); } catch (e) { return; }

    if (m.type === 'queue') {
      if (ws.roomId) return;
      const name = String(m.name || 'Spieler').slice(0, 16);

      if (!waiting) {
        waiting = { ws, name, id: ws.id };
        ws.send(JSON.stringify({ type: 'queued', info: 'Warte auf Gegner…' }));
      } else if (waiting.ws === ws) {
        // schon in Warteschlange
      } else {
        // Match!
        const roomId = 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
        const a = waiting;
        const b = { ws, name, id: ws.id };
        waiting = null;

        rooms.set(roomId, { a, b, bets: { a: null, b: null }, rolls: { a: null, b: null } });
        a.ws.roomId = roomId; a.ws.side = 'a';
        b.ws.roomId = roomId; b.ws.side = 'b';

        a.ws.send(JSON.stringify({ type: 'matched', roomId, side: 'a', you: a.name, opponent: b.name }));
        b.ws.send(JSON.stringify({ type: 'matched', roomId, side: 'b', you: b.name, opponent: a.name }));
      }
      return;
    }

    const roomId = ws.roomId;
    if (!roomId) return;
    const room = rooms.get(roomId);
    if (!room) return;
    const side = ws.side;
    const otherSide = side === 'a' ? 'b' : 'a';
    const other = room[otherSide];

    if (m.type === 'bet') {
      const amount = Math.max(1, Math.min(10000, Math.floor(Number(m.amount) || 0)));
      room.bets[side] = amount;
      if (other && other.ws.readyState === 1) {
        other.ws.send(JSON.stringify({ type: 'opBet', amount }));
      }
      if (room.bets.a !== null && room.bets.b !== null) {
        const rollA = Math.random() * 100;
        const rollB = Math.random() * 100;
        let winnerA;
        if (rollA > rollB) winnerA = 'you';
        else if (rollA < rollB) winnerA = 'opp';
        else winnerA = 'tie';

        room.a.ws.send(JSON.stringify({
          type: 'roll',
          you: rollA,
          opp: rollB,
          winner: winnerA
        }));
        room.b.ws.send(JSON.stringify({
          type: 'roll',
          you: rollB,
          opp: rollA,
          winner: winnerA === 'you' ? 'opp' : (winnerA === 'opp' ? 'you' : 'tie')
        }));
        room.bets.a = null; room.bets.b = null;
      }
      return;
    }

    if (m.type === 'leave') {
      cleanupRoom(roomId, ws);
      return;
    }
  });

  ws.on('close', () => {
    if (waiting && waiting.ws === ws) waiting = null;
    if (ws.roomId) cleanupRoom(ws.roomId, ws);
  });
});

function cleanupRoom(roomId, leaver) {
  const room = rooms.get(roomId);
  if (!room) return;
  rooms.delete(roomId);
  const other = (leaver === room.a.ws) ? room.b : room.a;
  if (other && other.ws && other.ws.readyState === 1) {
    try { other.ws.send(JSON.stringify({ type: 'oppLeft' })); } catch (e) {}
  }
  if (room.a && room.a.ws) room.a.ws.roomId = null;
  if (room.b && room.b.ws) room.b.ws.roomId = null;
}