import { RelayRoom } from './room.js';
import { isValidKey, isValidRole, parsePath } from './core.js';

/**
 * The relay's front door.
 *
 *   wss://<host>/ws/<key>/<role>
 *
 * The key in the path decides which room the connection lands in, and the
 * role says whether this end is the game or the controller. The Worker does
 * no relaying itself - it just routes to the Durable Object for that key.
 *
 * Everything the relay actually does lives in core.js, which is shared with
 * the local test emulator, so the rules that get tested are the rules that
 * ship.
 */
export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/' || url.pathname === '/health') {
      return new Response('ludo dice relay\n', {
        status: 200,
        headers: { 'content-type': 'text/plain' },
      });
    }

    const parsed = parsePath(url.pathname);
    if (!parsed) {
      return new Response(
        'expected /ws/<32 hex key>/<ctrl|game>\n',
        { status: 400, headers: { 'content-type': 'text/plain' } }
      );
    }

    if (!isValidKey(parsed.key) || !isValidRole(parsed.role)) {
      return new Response('bad key or role\n', { status: 400 });
    }

    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('expected a websocket upgrade\n', { status: 426 });
    }

    // The key becomes the Durable Object's name, so the same key always
    // reaches the same room - no database and no lookup needed.
    const id = env.RELAY.idFromName(parsed.key);
    const stub = env.RELAY.get(id);

    const headers = new Headers(request.headers);
    headers.set('x-ludo-key', parsed.key);
    headers.set('x-ludo-role', parsed.role);

    return stub.fetch(request, { headers });
  },
};

export { RelayRoom };
