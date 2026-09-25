// server.js — WebSocket-Server für Lucky Vault Online-Duell

const WebSocket = require("ws");

const PORT = Number(process.env.PORT) || 8080;
const HOST = process.env.HOST || "0.0.0.0";

const wss = new WebSocket.Server({
  host: HOST,
  port: PORT
});

console.log(`Lucky Vault Server läuft auf ${HOST}:${PORT}`);

let waiting = null;
// { ws, name, id }

const rooms = new Map();
// roomId -> { a, b, bets, rolls }

let idCounter = 1;

function newId() {
  return "p" + idCounter++;
}

function send(ws, data) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    try {
      ws.send(JSON.stringify(data));
    } catch (err) {
      console.error("Sendefehler:", err.message);
    }
  }
}

wss.on("connection", (ws) => {
  ws.id = newId();
  ws.roomId = null;
  ws.side = null;

  console.log(`Spieler verbunden: ${ws.id}`);

  send(ws, {
    type: "hello",
    id: ws.id
  });

  ws.on("message", (raw) => {
    let m;

    try {
      m = JSON.parse(raw.toString());
    } catch (err) {
      return;
    }

    // Spieler möchte der Warteschlange beitreten
    if (m.type === "queue") {
      if (ws.roomId) return;

      const name = String(m.name || "Spieler")
        .trim()
        .slice(0, 16) || "Spieler";

      if (!waiting) {
        waiting = {
          ws,
          name,
          id: ws.id
        };

        send(ws, {
          type: "queued",
          info: "Warte auf Gegner…"
        });

        console.log(`${name} wartet auf einen Gegner.`);
      } else if (waiting.ws === ws) {
        // Spieler ist bereits in der Warteschlange.
        return;
      } else {
        // Match erstellen
        const roomId =
          "r" +
          Date.now().toString(36) +
          Math.random().toString(36).slice(2, 6);

        const a = waiting;

        const b = {
          ws,
          name,
          id: ws.id
        };

        waiting = null;

        rooms.set(roomId, {
          a,
          b,
          bets: {
            a: null,
            b: null
          },
          rolls: {
            a: null,
            b: null
          }
        });

        a.ws.roomId = roomId;
        a.ws.side = "a";

        b.ws.roomId = roomId;
        b.ws.side = "b";

        send(a.ws, {
          type: "matched",
          roomId,
          side: "a",
          you: a.name,
          opponent: b.name
        });

        send(b.ws, {
          type: "matched",
          roomId,
          side: "b",
          you: b.name,
          opponent: a.name
        });

        console.log(
          `Match erstellt: ${a.name} vs. ${b.name} (${roomId})`
        );
      }

      return;
    }

    const roomId = ws.roomId;

    if (!roomId) return;

    const room = rooms.get(roomId);

    if (!room) return;

    const side = ws.side;
    const otherSide = side === "a" ? "b" : "a";
    const other = room[otherSide];

    // Einsatz
    if (m.type === "bet") {
      const amount = Math.max(
        1,
        Math.min(
          10000,
          Math.floor(Number(m.amount) || 0)
        )
      );

      room.bets[side] = amount;

      send(other.ws, {
        type: "opBet",
        amount
      });

      // Beide haben gesetzt -> Runde auswerten
      if (
        room.bets.a !== null &&
        room.bets.b !== null
      ) {
        const rollA = Math.random() * 100;
        const rollB = Math.random() * 100;

        let winnerA;

        if (rollA > rollB) {
          winnerA = "you";
        } else if (rollA < rollB) {
          winnerA = "opp";
        } else {
          winnerA = "tie";
        }

        send(room.a.ws, {
          type: "roll",
          you: rollA,
          opp: rollB,
          winner: winnerA
        });

        send(room.b.ws, {
          type: "roll",
          you: rollB,
          opp: rollA,
          winner:
            winnerA === "you"
              ? "opp"
              : winnerA === "opp"
                ? "you"
                : "tie"
        });

        // Einsätze für nächste Runde zurücksetzen
        room.bets.a = null;
        room.bets.b = null;

        console.log(
          `Runde ${roomId}: ${rollA.toFixed(2)} vs ${rollB.toFixed(2)}`
        );
      }

      return;
    }

    // Spieler verlässt das Match
    if (m.type === "leave") {
      cleanupRoom(roomId, ws);
      return;
    }
  });

  ws.on("close", () => {
    console.log(`Spieler getrennt: ${ws.id}`);

    if (waiting && waiting.ws === ws) {
      waiting = null;
    }

    if (ws.roomId) {
      cleanupRoom(ws.roomId, ws);
    }
  });

  ws.on("error", (err) => {
    console.error(`WebSocket-Fehler bei ${ws.id}:`, err.message);
  });
});

function cleanupRoom(roomId, leaver) {
  const room = rooms.get(roomId);

  if (!room) return;

  rooms.delete(roomId);

  const other =
    leaver === room.a.ws
      ? room.b
      : room.a;

  if (
    other &&
    other.ws &&
    other.ws.readyState === WebSocket.OPEN
  ) {
    send(other.ws, {
      type: "oppLeft"
    });
  }

  if (room.a && room.a.ws) {
    room.a.ws.roomId = null;
    room.a.ws.side = null;
  }

  if (room.b && room.b.ws) {
    room.b.ws.roomId = null;
    room.b.ws.side = null;
  }

  console.log(`Raum geschlossen: ${roomId}`);
}

wss.on("listening", () => {
  const address = wss.address();

  if (address && typeof address === "object") {
    console.log(
      `WebSocket-Server hört auf ${address.address}:${address.port}`
    );
  }
});

wss.on("error", (err) => {
  console.error("Serverfehler:", err);
});