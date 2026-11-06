/**
 * A minimal RFC 6455 WebSocket server, with no dependencies.
 *
 * Node has a WebSocket *client* built in, but no server, and the test
 * emulator needs a server. Writing it here keeps the relay testable in the
 * sandbox without pulling anything from npm.
 *
 * Only what the relay needs is implemented: text and binary frames, ping and
 * pong, and a clean close. Fragmented frames are reassembled.
 */

import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

const OP_CONT = 0x0;
const OP_TEXT = 0x1;
const OP_BINARY = 0x2;
const OP_CLOSE = 0x8;
const OP_PING = 0x9;
const OP_PONG = 0xa;

/** One connected client. */
export class WsConnection extends EventEmitter {
  constructor(socket) {
    super();
    this.socket = socket;
    this.closed = false;
    this.attachment = null;
    this._buffer = Buffer.alloc(0);
    this._fragments = [];
    this._fragmentOpcode = null;

    socket.on('data', (chunk) => this._onData(chunk));
    socket.on('close', () => this._onClose());
    socket.on('error', () => this._onClose());
  }

  /** Stores a small piece of state on the connection, like Cloudflare does. */
  serializeAttachment(value) {
    this.attachment = value;
  }

  /** Reads back what serializeAttachment stored. */
  deserializeAttachment() {
    return this.attachment;
  }

  /** Sends a text message. */
  sendText(text) {
    this._send(OP_TEXT, Buffer.from(text, 'utf8'));
  }

  /** Sends a binary message. */
  sendBinary(bytes) {
    this._send(OP_BINARY, Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes));
  }

  /** Sends a close frame and tears the socket down. */
  close(code = 1000, reason = '') {
    if (this.closed) return;
    this.closed = true;
    try {
      const payload = Buffer.alloc(2 + Buffer.byteLength(reason));
      payload.writeUInt16BE(code, 0);
      payload.write(reason, 2, 'utf8');
      this._send(OP_CLOSE, payload);
    } catch (e) {
      // the peer is already gone
    }
    try {
      this.socket.end();
    } catch (e) {
      // ignore
    }
    this.emit('close', code, reason);
  }

  _send(opcode, payload) {
    if (this.socket.destroyed) return;
    const len = payload.length;
    let header;
    if (len < 126) {
      header = Buffer.alloc(2);
      header[1] = len;
    } else if (len <= 0xffff) {
      header = Buffer.alloc(4);
      header[1] = 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(len), 2);
    }
    header[0] = 0x80 | opcode;
    this.socket.write(Buffer.concat([header, payload]));
  }

  _onData(chunk) {
    this._buffer = Buffer.concat([this._buffer, chunk]);
    while (true) {
      const frame = this._readFrame();
      if (!frame) return;
      this._handleFrame(frame);
    }
  }

  _readFrame() {
    const buf = this._buffer;
    if (buf.length < 2) return null;

    const fin = (buf[0] & 0x80) !== 0;
    const opcode = buf[0] & 0x0f;
    const masked = (buf[1] & 0x80) !== 0;
    let len = buf[1] & 0x7f;
    let offset = 2;

    if (len === 126) {
      if (buf.length < offset + 2) return null;
      len = buf.readUInt16BE(offset);
      offset += 2;
    } else if (len === 127) {
      if (buf.length < offset + 8) return null;
      len = Number(buf.readBigUInt64BE(offset));
      offset += 8;
    }

    let mask = null;
    if (masked) {
      if (buf.length < offset + 4) return null;
      mask = buf.subarray(offset, offset + 4);
      offset += 4;
    }

    if (buf.length < offset + len) return null;

    const payload = Buffer.from(buf.subarray(offset, offset + len));
    if (mask) {
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
    }
    this._buffer = buf.subarray(offset + len);
    return { fin, opcode, payload };
  }

  _handleFrame(frame) {
    const { fin, opcode, payload } = frame;

    if (opcode === OP_CLOSE) {
      this.close(1000, '');
      return;
    }
    if (opcode === OP_PING) {
      this._send(OP_PONG, payload);
      return;
    }
    if (opcode === OP_PONG) {
      return;
    }

    if (opcode === OP_CONT) {
      this._fragments.push(payload);
    } else {
      this._fragments = [payload];
      this._fragmentOpcode = opcode;
    }

    if (!fin) return;

    const complete = Buffer.concat(this._fragments);
    this._fragments = [];
    const type = this._fragmentOpcode;
    this._fragmentOpcode = null;

    if (type === OP_TEXT) {
      this.emit('message', complete.toString('utf8'), false);
    } else {
      this.emit('message', complete, true);
    }
  }

  _onClose() {
    if (this.closed) return;
    this.closed = true;
    this.emit('close', 1006, 'socket closed');
  }
}

/**
 * Attaches WebSocket handling to a plain http server.
 *
 * @param server an http/https server.
 * @param onConnection called with (connection, request).
 */
export function attachWebSocket(server, onConnection) {
  server.on('upgrade', (req, socket, head) => {
    const key = req.headers['sec-websocket-key'];
    if (!key || (req.headers.upgrade || '').toLowerCase() !== 'websocket') {
      socket.destroy();
      return;
    }
    const accept = crypto
      .createHash('sha1')
      .update(key + GUID)
      .digest('base64');

    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
    );

    const conn = new WsConnection(socket);
    if (head && head.length) conn._onData(head);
    onConnection(conn, req);
  });
}
