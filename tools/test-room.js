/**
 * Tests the Durable Object's routing logic without Cloudflare.
 *
 * The DO cannot run outside workerd, so this harness gives it the small
 * slice of the runtime it actually uses - acceptWebSocket, getWebSockets,
 * WebSocketPair, Response - and then drives it through the same scenarios
 * the real relay has to handle.
 *
 *   node tools/test-room.js
 */

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

// ---- a fake slice of the workers runtime -------------------------------

class FakeSocket {
  constructor() {
    this.sent = [];
    this.closed = false;
    this.closeCode = null;
    this.attachment = null;
    this.tag = null;
  }
  send(data) {
    this.sent.push(data);
  }
  close(code, reason) {
    this.closed = true;
    this.closeCode = code;
    this.closeReason = reason;
  }
  serializeAttachment(value) {
    this.attachment = value;
  }
  deserializeAttachment() {
    return this.attachment;
  }
}

class FakeCtx {
  constructor() {
    this.sockets = [];
  }
  acceptWebSocket(ws, tags) {
    ws.tag = (tags || [])[0];
    this.sockets.push(ws);
  }
  getWebSockets(tag) {
    return this.sockets.filter(
      (s) => s.tag === tag && !s.closed
    );
  }
}

class DurableObjectStub {
  constructor(ctx, state) {
    this.ctx = ctx;
    this.state = state;
  }
}

/** A DurableObjectStorage stub - just enough for the sequence counter. */
class FakeStorage {
  constructor() {
    this.data = new Map();
  }
  async get(key) {
    return this.data.get(key);
  }
  async put(key, value) {
    this.data.set(key, value);
  }
}

globalThis.__DurableObjectStub = DurableObjectStub;
globalThis.WebSocketPair = function WebSocketPair() {
  this[0] = new FakeSocket();
  this[1] = new FakeSocket();
};
globalThis.Response = class FakeResponse {
  constructor(body, init) {
    this.body = body;
    this.status = (init && init.status) || 200;
    this.webSocket = init && init.webSocket;
  }
};

// ---- load the Durable Object with the runtime import faked -------------

const coreSource = fs.readFileSync(path.join(root, 'src/core.js'), 'utf8');
const roomSource = fs
  .readFileSync(path.join(root, 'src/room.js'), 'utf8')
  .replace("import { DurableObject } from 'cloudflare:workers';", 'const DurableObject = __DurableObjectStub;')
  .replace(/import\s*\{([^}]*)\}\s*from\s*'\.\/core\.js';/, 'const {$1} = __core;')
  .replace('export class RelayRoom', 'class RelayRoom')
  + '\n__RelayRoom = RelayRoom;\n';

const coreModule = await import('data:text/javascript;base64,' + Buffer.from(coreSource).toString('base64'));

const sandbox = {
  globalThis: null,
  __core: coreModule,
  __DurableObjectStub: DurableObjectStub,
  WebSocketPair: globalThis.WebSocketPair,
  Response: globalThis.Response,
  console,
};
vm.createContext(sandbox);
sandbox.globalThis = sandbox;
vm.runInContext(roomSource, sandbox, { filename: 'room.js' });
const RelayRoom = sandbox.__RelayRoom;

// ---- the test ----------------------------------------------------------

let passed = 0;
let failed = 0;

function expect(name, want, got) {
  if (want === got) {
    passed++;
    console.log('  PASS  ' + name);
  } else {
    failed++;
    console.log('  FAIL  ' + name);
    console.log('        want: ' + JSON.stringify(want));
    console.log('        got:  ' + JSON.stringify(got));
  }
}

function check(name, cond) {
  expect(name, true, cond);
}

const KEY = '0123456789abcdef0123456789abcdef';
const OTHER = 'ffffffffffffffffffffffffffffffff';

async function connect(room, key, role) {
  const req = {
    headers: {
      get: (h) =>
        ({
          'x-ludo-key': key,
          'x-ludo-role': role,
          Upgrade: 'websocket',
        })[h] || null,
    },
  };
  const res = await room.fetch(req);
  // the server side is the socket the DO accepted
  const server = room.ctx.sockets[room.ctx.sockets.length - 1];
  return { res, server };
}

console.log('=== the Durable Object routing ===');

// 1. the game connects and is welcomed
{
  const room = new RelayRoom(new FakeCtx(), { storage: new FakeStorage() });
  const { res, server } = await connect(room, KEY, 'game');
  expect('the upgrade succeeds', 101, res.status);
  expect('the game is welcomed', 'OK game\n', server.sent[0]);
  expect('the role is remembered', 'game', server.deserializeAttachment().role);
}

// 2. a controller connects and is welcomed
{
  const room = new RelayRoom(new FakeCtx(), { storage: new FakeStorage() });
  await connect(room, KEY, 'game');
  const { server } = await connect(room, KEY, 'ctrl');
  expect('the controller is welcomed', 'OK ctrl\n', server.sent[0]);
}

// 3. a second controller takes the slot over - the old one is told and closed
{
  const room = new RelayRoom(new FakeCtx(), { storage: new FakeStorage() });
  await connect(room, KEY, 'game');
  const { server: first } = await connect(room, KEY, 'ctrl');
  const { server: second } = await connect(room, KEY, 'ctrl');
  expect('the new controller is welcomed', 'OK ctrl\n', second.sent[0]);
  expect('the old controller is told it was replaced', 'ERR replaced\n', first.sent[1]);
  check('the old controller is closed', first.closed);
}

// 3b. the slot must stay usable no matter how many takeovers happen
{
  const room = new RelayRoom(new FakeCtx(), { storage: new FakeStorage() });
  await connect(room, KEY, 'ctrl');
  await connect(room, KEY, 'ctrl');
  await connect(room, KEY, 'ctrl');
  const { server } = await connect(room, KEY, 'ctrl');
  expect('the slot is still usable after three takeovers', 'OK ctrl\n', server.sent[0]);
}

// 4. a second game takes the slot over too
{
  const room = new RelayRoom(new FakeCtx(), { storage: new FakeStorage() });
  const { server: first } = await connect(room, KEY, 'game');
  const { server: second } = await connect(room, KEY, 'game');
  expect('the new game is welcomed', 'OK game\n', second.sent[0]);
  expect('the old game is told it was replaced', 'ERR replaced\n', first.sent[1]);
}

// 5. bytes flow from the controller to the game and back
{
  const room = new RelayRoom(new FakeCtx(), { storage: new FakeStorage() });
  const { server: game } = await connect(room, KEY, 'game');
  const { server: ctrl } = await connect(room, KEY, 'ctrl');

  await room.webSocketMessage(ctrl, new TextEncoder().encode('SET 0 6\n'));
  expect('the game receives the command', 2, game.sent.length);
  check('the bytes arrive unchanged', String.fromCharCode(...game.sent[1]) === 'SET 0 6\n');

  await room.webSocketMessage(game, new TextEncoder().encode('OK SET P1: 6\n'));
  check('the controller receives the reply', String.fromCharCode(...ctrl.sent[1]) === 'OK SET P1: 6\n');
}

// 6. a command with no game gets a clear answer, not silence
{
  const room = new RelayRoom(new FakeCtx(), { storage: new FakeStorage() });
  const { server: ctrl } = await connect(room, KEY, 'ctrl');
  await room.webSocketMessage(ctrl, new TextEncoder().encode('STATUS\n'));
  expect('the controller is told the game is not there', 'ERR no-game\n', ctrl.sent[1]);
}

// 7. when the game goes away the controller is told and disconnected
{
  const room = new RelayRoom(new FakeCtx(), { storage: new FakeStorage() });
  const { server: game } = await connect(room, KEY, 'game');
  const { server: ctrl } = await connect(room, KEY, 'ctrl');

  await room.webSocketClose(game, 1000, 'bye');
  expect('the controller is told', 'ERR game-gone\n', ctrl.sent[1]);
  check('the controller is disconnected', ctrl.closed);
}

// 8. the controller going away leaves the game alone
{
  const room = new RelayRoom(new FakeCtx(), { storage: new FakeStorage() });
  const { server: game } = await connect(room, KEY, 'game');
  const { server: ctrl } = await connect(room, KEY, 'ctrl');

  await room.webSocketClose(ctrl, 1000, 'bye');
  check('the game is left connected', !game.closed);
  expect('the game is not disturbed', 1, game.sent.length);
}

// 9. a bad key or role is refused outright
{
  const room = new RelayRoom(new FakeCtx(), { storage: new FakeStorage() });
  const { res } = await connect(room, 'not-a-key', 'ctrl');
  expect('a bad key is refused', 400, res.status);
}

// 10. a non-upgrade request is refused
{
  const room = new RelayRoom(new FakeCtx(), { storage: new FakeStorage() });
  const res = await room.fetch({ headers: { get: () => null } });
  expect('a plain request is refused', 400, res.status);
}

// 11. two different keys are two different rooms
{
  const roomA = new RelayRoom(new FakeCtx(), { storage: new FakeStorage() });
  const roomB = new RelayRoom(new FakeCtx(), { storage: new FakeStorage() });
  await connect(roomA, KEY, 'game');
  const { server } = await connect(roomB, OTHER, 'ctrl');
  expect('a different key is a different room', 'OK ctrl\n', server.sent[0]);
}

console.log();
console.log('passed=' + passed + ' failed=' + failed);
if (failed > 0) process.exit(1);
