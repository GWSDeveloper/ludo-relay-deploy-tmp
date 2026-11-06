/**
 * The relay's core logic.
 *
 * This file deliberately contains no Cloudflare specific code, so the exact
 * same routing rules run in two places:
 *
 *   - inside the Cloudflare Durable Object (src/room.js), and
 *   - inside the local test emulator (tools/emulator.js).
 *
 * That way the emulator is not a loose imitation of the real thing - it is
 * the same code, so a bug in the routing shows up in the local test.
 *
 * The relay is a dumb byte tunnel. It knows two roles and nothing about the
 * QAServer protocol:
 *
 *   game  the bridge inside the Ludo King APK
 *   ctrl  the controller app
 *
 * Both connect to /ws/<key>/<role>. The relay replies with a short text
 * frame - "OK <role>" or "ERR <reason>" - and after that every frame is
 * binary and carries raw bytes between the two peers.
 */

export const ROLE_CTRL = 'ctrl';
export const ROLE_GAME = 'game';

/** Roles the relay accepts. */
export const ROLES = [ROLE_CTRL, ROLE_GAME];

/** A key is 128 bits, written as 32 lowercase hex characters. */
export function isValidKey(key) {
  return typeof key === 'string' && /^[0-9a-f]{32}$/.test(key);
}

/** True when the role is one the relay understands. */
export function isValidRole(role) {
  return ROLES.indexOf(role) !== -1;
}

/** The handshake reply that says "you are in". */
export function okMsg(role) {
  return 'OK ' + role + '\n';
}

/** The handshake reply that says "no". */
export function errMsg(reason) {
  return 'ERR ' + reason + '\n';
}

/**
 * The socket interface the core needs.
 *
 * Cloudflare's WebSocket has send(); the local emulator's does not, and the
 * two disagree about text versus binary frames. Rather than let each side
 * guess, the core defines exactly what it needs and the host runtime adapts
 * its sockets to it:
 *
 *   sendText(text)    a control message, e.g. "OK ctrl"
 *   sendBinary(bytes) tunnelled bytes
 *
 * @param ctrlSockets sockets that claimed the controller role.
 * @param gameSockets sockets that claimed the game role.
 * @param adapter     { text(ws, s), binary(ws, bytes) } - defaults to the
 *                    Cloudflare WebSocket API.
 */
export function buildList(ctrlSockets, gameSockets, adapter) {
  const a = adapter || {
    text: (ws, s) => ws.send(s),
    binary: (ws, b) => ws.send(b),
  };
  const list = [];
  for (const ws of ctrlSockets || []) {
    list.push({
      ws,
      role: ROLE_CTRL,
      seq: attachmentOf(ws).seq || 0,
      sendText: (s) => a.text(ws, s),
      sendBinary: (b) => a.binary(ws, b),
    });
  }
  for (const ws of gameSockets || []) {
    list.push({
      ws,
      role: ROLE_GAME,
      seq: attachmentOf(ws).seq || 0,
      sendText: (s) => a.text(ws, s),
      sendBinary: (b) => a.binary(ws, b),
    });
  }
  return list;
}

/** The attachment a socket carries, or an empty object. */
export function attachmentOf(ws) {
  try {
    const a = ws.deserializeAttachment();
    return a || {};
  } catch (e) {
    return {};
  }
}

/**
 * The newest socket holding a role, or null.
 *
 * "Newest wins" is what keeps a key from being locked out forever. If the
 * controller app is killed, or the game phone loses signal, the old socket
 * can linger for a while. If a new connection were simply refused, the user
 * would be locked out until the network eventually noticed the dead socket -
 * which on a phone can be many minutes.
 *
 * Taking the slot over keeps the invariant that matters (exactly one
 * controller and one game per key) while making the whole thing self
 * healing.
 */
export function newestFor(list, role) {
  let best = null;
  for (const entry of list) {
    if (entry.role !== role) continue;
    if (!best || (entry.seq || 0) > (best.seq || 0)) best = entry;
  }
  return best;
}

/**
 * Checks whether a role is already taken.
 *
 * Kept for the case where the room genuinely cannot hand the slot over.
 */
export function roleTaken(list, role) {
  return list.some((entry) => entry.role === role);
}

/**
 * The socket holding the opposite role, or null.
 *
 * The newest one, so a socket that is on its way out is never picked as the
 * peer.
 */
export function peerFor(list, role) {
  const other = role === ROLE_CTRL ? ROLE_GAME : ROLE_CTRL;
  return newestFor(list, other);
}

/**
 * Forwards a chunk of tunnelled bytes to the peer.
 *
 * @returns {{ok: boolean, reason?: string}} 'no-peer' when the other side is
 *          not connected yet.
 */
export function forward(list, fromRole, bytes) {
  const peer = peerFor(list, fromRole);
  if (!peer) {
    return { ok: false, reason: 'no-peer' };
  }
  try {
    peer.sendBinary(bytes);
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: 'send-failed' };
  }
}

/**
 * Called when a peer disappears.
 *
 * When the game goes away the controller is told and disconnected, so its
 * app can say "the game phone went offline" instead of hanging on a dead
 * tunnel. When the controller goes away the game is left alone - it simply
 * waits for the controller to come back.
 */
export function onPeerGone(list, goneRole) {
  if (goneRole !== ROLE_GAME) {
    return false;
  }
  // The controller itself, not the peer of the controller - peerFor() would
  // hand back the game, which is the socket that just went away.
  const ctrl = newestFor(list, ROLE_CTRL);
  if (!ctrl) {
    return false;
  }
  try {
    ctrl.sendText(errMsg('game-gone'));
    ctrl.ws.close(1000, 'game-gone');
  } catch (e) {
    // the controller is already gone
  }
  return true;
}

/** Parses /ws/<key>/<role> out of a URL path. */
export function parsePath(pathname) {
  const parts = String(pathname || '')
    .split('/')
    .filter((p) => p.length > 0);
  if (parts.length < 3 || parts[0] !== 'ws') {
    return null;
  }
  const key = parts[1].toLowerCase();
  const role = parts[2].toLowerCase();
  if (!isValidKey(key) || !isValidRole(role)) {
    return null;
  }
  return { key, role };
}


/**
 * The notice sent to a socket that is being replaced by a newer one with the
 * same role.
 */
export const REPLACED = 'replaced';
