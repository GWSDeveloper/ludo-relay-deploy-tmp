import { DurableObject } from 'cloudflare:workers';
import {
  REPLACED,
  ROLE_CTRL,
  ROLE_GAME,
  buildList,
  errMsg,
  isValidKey,
  isValidRole,
  newestFor,
  okMsg,
  onPeerGone,
  peerFor,
} from './core.js';

/**
 * One room per key.
 *
 * The Worker routes every request for a key to the Durable Object whose id
 * comes from that key, so this class only ever deals with a single key.
 *
 * It uses the WebSocket Hibernation API: `ctx.acceptWebSocket()` hands the
 * socket to the runtime, which keeps it open while the object sleeps. An
 * idle relay therefore costs nothing, and the object only wakes up when a
 * message actually arrives.
 *
 * The role of each socket is kept in two places:
 *
 *   - a tag, so `ctx.getWebSockets(role)` is a cheap lookup, and
 *   - an attachment, so the role survives hibernation and can be read back
 *     from the socket itself.
 */
export class RelayRoom extends DurableObject {
  constructor(ctx, state) {
    super(ctx, state);
    this.ctx = ctx;
    this.state = state;
  }

  /** The upgrade request arrives here. */
  async fetch(request) {
    const key = request.headers.get('x-ludo-key') || '';
    const role = request.headers.get('x-ludo-role') || '';

    if (!isValidKey(key) || !isValidRole(role)) {
      return new Response('bad request', { status: 400 });
    }
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('expected a websocket upgrade', { status: 426 });
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];

    // Newest wins. Exactly one controller and one game per key is still the
    // rule - but the slot is handed over rather than refused, because a
    // refused connection that stays in the room would lock the key out
    // forever once the controller app had been killed.
    const older = newestFor(this.list(), role);
    if (older) {
      try {
        older.sendText(errMsg(REPLACED));
        older.ws.close(1000, REPLACED);
      } catch (e) {
        // the old socket is already gone
      }
    }

    // A strictly increasing sequence number, so the newest socket of a role
    // is always identifiable even when two connections land in the same
    // millisecond. It lives in storage, so it survives hibernation.
    const seq = ((await this.state.storage.get('seq')) || 0) + 1;
    await this.state.storage.put('seq', seq);

    this.ctx.acceptWebSocket(server, [role]);
    server.serializeAttachment({ role, key, seq });
    server.send(okMsg(role));

    return new Response(null, { status: 101, webSocket: client });
  }

  /** The live sockets, rebuilt from the runtime on every use. */
  list() {
    return buildList(this.ctx.getWebSockets(ROLE_CTRL), this.ctx.getWebSockets(ROLE_GAME));
  }

  /** The role a socket claimed. */
  roleOf(ws) {
    try {
      const attachment = ws.deserializeAttachment();
      if (attachment && attachment.role) {
        return attachment.role;
      }
    } catch (e) {
      // fall through to the tag based lookup
    }
    if (this.ctx.getWebSockets(ROLE_CTRL).includes(ws)) {
      return ROLE_CTRL;
    }
    return ROLE_GAME;
  }

  /** A tunnelled message arrived. */
  async webSocketMessage(ws, message) {
    const role = this.roleOf(ws);
    const bytes = typeof message === 'string' ? new TextEncoder().encode(message) : message;

    const peer = peerFor(this.list(), role);
    if (!peer) {
      if (role === ROLE_CTRL) {
        // The game phone is not there yet. Say so instead of dropping the
        // command silently, so the controller can retry.
        ws.send(errMsg('no-game'));
      }
      return;
    }

    try {
      peer.sendBinary(bytes);
    } catch (e) {
      // the peer went away between the lookup and the send
    }
  }

  /** A socket closed. */
  async webSocketClose(ws, code, reason) {
    this.handleGone(ws);
  }

  /** A socket broke. */
  async webSocketError(ws, error) {
    this.handleGone(ws);
  }

  /**
   * A socket went away.
   *
   * If a newer socket already took over the role, this one is just the old
   * connection being cleaned up and nothing should be announced.
   */
  handleGone(ws) {
    const role = this.roleOf(ws);
    const list = this.list();
    const newest = newestFor(list, role);
    if (newest && newest.ws !== ws) {
      return;
    }
    onPeerGone(list, role);
  }
}
