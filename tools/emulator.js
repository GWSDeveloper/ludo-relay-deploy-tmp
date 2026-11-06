/**
 * Local relay emulator.
 *
 * Runs the relay's routing rules on a plain Node WebSocket server so the
 * whole stack can be tested in the sandbox without touching Cloudflare.
 *
 * It uses the SAME core.js as the Durable Object does, so the behaviour that
 * gets tested here is the behaviour that ships.
 *
 *   node tools/emulator.js --port 8790
 *
 * The URL layout matches the Worker:
 *
 *   ws://127.0.0.1:8790/ws/<key>/<role>      role is "game" or "ctrl"
 */

import http from 'node:http';
import { attachWebSocket } from './wsserver.js';
import {
  REPLACED,
  ROLE_CTRL,
  ROLE_GAME,
  buildList,
  errMsg,
  forward,
  newestFor,
  okMsg,
  onPeerGone,
  parsePath,
} from '../src/core.js';

const args = process.argv.slice(2);
let port = 8790;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--port') port = parseInt(args[++i], 10);
}

/** One room per key. */
const rooms = new Map();

/** Strictly increasing, so the newest socket of a role is always clear. */
let seq = 0;

function roomFor(key) {
  let room = rooms.get(key);
  if (!room) {
    room = { key, ctrl: [], game: [] };
    rooms.set(key, room);
  }
  return room;
}

/** The adapter between the core and this emulator's socket objects. */
const ADAPTER = {
  text: (ws, s) => ws.sendText(s),
  binary: (ws, b) => ws.sendBinary(b),
};

function listFor(room) {
  return buildList(room.ctrl, room.game, ADAPTER);
}

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/plain' });
  res.end('ludo relay emulator\n');
});

attachWebSocket(server, (conn, req) => {
  const parsed = parsePath(new URL(req.url, 'http://localhost').pathname);
  if (!parsed) {
    conn.close(1008, 'bad path');
    return;
  }

  const { key, role } = parsed;
  const room = roomFor(key);

  // Newest wins, exactly as the Durable Object does it.
  const older = newestFor(listFor(room), role);
  if (older) {
    try {
      older.sendText(errMsg(REPLACED));
      older.ws.close(1000, REPLACED);
    } catch (e) {
      // already gone
    }
  }

  conn.serializeAttachment({ role, key, seq: ++seq });

  if (role === ROLE_CTRL) room.ctrl.push(conn);
  else room.game.push(conn);

  conn.sendText(okMsg(role));

  conn.on('message', (data, isBinary) => {
    if (process.env.LUDO_DEBUG) {
      console.log(`[relay] ${role} <- ${isBinary ? 'bin' : 'txt'} ${data.length}b`);
    }
    const current = listFor(room);
    const fromRole = role;
    const result = forward(current, fromRole, isBinary ? data : Buffer.from(data));
    if (process.env.LUDO_DEBUG) {
      console.log(`[relay] ${role} -> peer: ${result.ok ? 'sent' : 'FAILED ' + result.reason}`
        + ` list=[${current.map((e) => e.role).join(',')}] key=${key}`);
    }

    if (!result.ok && result.reason === 'no-peer') {
      if (fromRole === ROLE_CTRL) {
        // The game phone is not connected yet. Say so instead of dropping the
        // command silently, so the controller can retry.
        conn.sendText(errMsg('no-game'));
      }
      return;
    }
  });

  conn.on('close', () => {
    const idx = role === ROLE_CTRL ? room.ctrl.indexOf(conn) : room.game.indexOf(conn);
    if (idx >= 0) {
      if (role === ROLE_CTRL) room.ctrl.splice(idx, 1);
      else room.game.splice(idx, 1);
    }
    // Only announce the loss if this socket was the newest of its role - a
    // socket that was replaced by a newer one is just being cleaned up.
    const newest = newestFor(listFor(room), role);
    if (!newest || newest.ws === conn) {
      onPeerGone(listFor(room), role);
    }
    if (room.ctrl.length === 0 && room.game.length === 0) {
      rooms.delete(room.key);
    }
  });
});

server.listen(port, '127.0.0.1', () => {
  console.log(`ludo relay emulator on ws://127.0.0.1:${port}/ws/<key>/<role>`);
});
