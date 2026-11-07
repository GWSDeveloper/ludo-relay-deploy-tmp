# Ludo Dice Relay

A Cloudflare Worker that lets a **Ludo Dice Controller** on one network drive a
**Ludo King** on another network.

```
   controller phone                Cloudflare                gaming phone
  ┌────────────────┐            ┌──────────────┐          ┌────────────────┐
  │  controller    │  wss       │   Worker     │   wss    │  Ludo King     │
  │  app           │───────────▶│  + Durable   │◀─────────│  + bridge      │
  │                │            │    Object    │          │                │
  └────────────────┘            └──────────────┘          └────────────────┘
```

## Roles

| role   | what it is                                 |
|--------|--------------------------------------------|
| `game` | the bridge injected into the Ludo King APK |
| `ctrl` | the controller app                         |

Both connect to `wss://<host>/ws/<key>/<role>`. After a one-line handshake
every frame is binary and carries raw bytes, so the QAServer protocol stays
**end to end**.

One key drives one game and one controller. A second connection with the same
role **replaces** the older one (newest wins) instead of being refused.

---

## Deploy / auto-deploy

This repo is connected to Cloudflare Workers Builds.

- Push to `main` → automatic deploy to  
  **https://ludo-dice-relay.thehackerofficialtho.workers.dev**
- Worker name in `wrangler.toml` must stay `ludo-dice-relay`.

Local deploy:

```bash
npm install
npx wrangler login
npm run deploy
```

### Important fix (do not revert)

`src/room.js` must use **`this.ctx.storage`** (not `this.state.storage`).
The Durable Object constructor is `(ctx, env)`; storage lives on `ctx`.
Using `state.storage` causes HTTP 500 on every WebSocket upgrade.

## Free plan

Idle Durable Objects hibernate (no duration cost). Fine for this workload on the free plan.
