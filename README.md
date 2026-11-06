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

| role  | what it is                                          |
|-------|-----------------------------------------------------|
| `game` | the bridge injected into the Ludo King APK          |
| `ctrl`| the controller app                                  |

Both connect to `wss://<host>/ws/<key>/<role>`. After a one line handshake
every frame is binary and carries raw bytes, so the QAServer protocol stays
**end to end** - the controller speaks exactly the same protocol whether it is
on the same Wi-Fi or across the internet.

One key drives one game and one controller. A second controller with the same
key is **replaced** (newest wins), not refused.

---

## Updating an existing deployment

Pull the new files over the old ones and deploy again:

```bash
npm install
npm run deploy
```

Two things changed, and both matter:

- **Newest wins.** If a controller or a game connects with a key that is
  already in use, the older connection is closed with `ERR replaced` and the
  new one takes over. Before, the newcomer was refused - and because the
  refused socket was left in the room, the key was **locked out permanently**.
  A killed app or a phone that lost signal could leave a key unusable until
  the network finally noticed the dead connection.
- The connection sequence number is kept in the Durable Object's storage, so
  "the newest" is unambiguous even when two connections land in the same
  millisecond, and it survives hibernation.

## Deploy it (5 minutes, free)

You need a Cloudflare account and Node 18 or newer.

```bash
cd ludo-relay
npm install          # installs wrangler
npx wrangler login   # opens a browser
npm run deploy
```

Wrangler prints something like:

```
Deployed ludo-dice-relay to b8f1....workers.dev
```

That URL is the relay address. It goes into the controller app, and into the
game APK as `assets/relay.txt`.

Test it:

```bash
curl https://b8f1....workers.dev/
# ludo dice relay

curl https://b8f1....workers.dev/ws/notakey/ctrl
# expected /ws/<32 hex key>/<ctrl|game>
```

### Free plan limits

The Free plan is enough for this, by a wide margin:

| what | free allowance | what this uses |
|---|---|---|
| requests | 100,000 / day | one per dice command, plus the connection |
| duration | 13,000 GB-s / day | **zero while idle** - the Hibernation API lets the Durable Object sleep while the sockets stay open |
| storage | 5 GB | **none** - the key *is* the Durable Object's name |

Outgoing messages are free. Only inbound ones are counted, and a dice command
is one inbound message.
