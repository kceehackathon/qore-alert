# QoreAlert

**Know the moment your QoreChain wallet changes — before an attacker acts.**

QoreAlert is a post-quantum wallet watchtower for QoreChain. Add a native `qor1...` address or an EVM `0x...` address, and QoreAlert watches both lanes for transfers, EVM-window changes, PQC key changes, and approval exposure. Alerts arrive in Telegram; the dashboard keeps the timeline.

> **Status:** early scaffold. The repository, licence, architecture, and scope are in place. The indexer, bot, and dashboard are being built for the Build Before Q-Day deadline (2 December 2026, 23:59 UTC).

## The problem

QoreChain accounts are not just balances. An account can have:

- a native lane and an EVM lane;
- an ML-DSA-87 post-quantum key registered on chain;
- an open EVM authorisation window with block, transaction, value, and target limits;
- token approvals and contract permissions.

The explorer is built for inspection, not notification. A user has to remember to look. QoreAlert makes the account tell them when something changes, including changes that matter after Q-Day.

## What it will do

- **Watch both lanes.** One watch entry covers the `qor1` address and its EVM `0x` encoding.
- **Alert on meaningful events.** Native transfers, EVM transactions, EVM-window opens and closes, PQC key registration or rotation, and approval/permit exposure.
- **Telegram first.** `/watch`, `/unwatch`, `/list`, `/status`, and `/alerts` commands.
- **Dashboard.** Watchlist, event timeline, severity, and links to the transaction on the QoreChain explorer.
- **Hybrid-signed registration.** A watch can be registered on chain with a `0.000001 QOR` self-send carrying a `qorealert:watch:<address>` memo, signed hybrid (secp256k1 + ML-DSA-87). The indexer verifies the transaction and adds the watch.
- **No custody.** QoreAlert never asks for a seed phrase, private key, or QoreX recovery phrase.

## Planned MVP

1. Index native and EVM activity for one or more watched addresses.
2. Store normalised events in SQLite.
3. Send Telegram alerts with deduplication.
4. Provide a small web dashboard.
5. Register one watch with a real hybrid-signed testnet transaction and link the transaction in the README and project page.

## QoreChain features

| Feature | Use |
|---|---|
| Native lane (`qor1`) | Self-send watch registration; native transfer alerts |
| EVM lane (`0x`, chain ID 9800) | EVM transaction and window alerts |
| Hybrid ML-DSA-87 transactions | Registration transaction; proof that a watch was created by the address owner |
| PQC key registration | Alert when an account's ML-DSA-87 key is registered or changed |
| QoreChain SDK | Address conversion, transaction lookup, typed REST access |
| QoreX | User signs the registration self-send; QoreAlert never holds keys |

## Architecture

```text
QoreChain REST + EVM RPC
          │
          ▼
   indexer (TypeScript) ──────► SQLite
          │                       │
          ├──► Telegram bot ◄─────┤
          │                       │
          └──► web dashboard ◄────┘
```

The indexer polls public testnet endpoints. It stores only public chain data and user-supplied watch labels. No private keys are stored.

## Quickstart

> The app is not runnable yet. Setup instructions will be added as the scaffold lands.

```bash
git clone https://github.com/kceehackathon/qore-alert.git
cd qore-alert
cp .env.example .env
npm install
npm run dev
```

## Testnet addresses

| Purpose | Address |
|---|---|
| QoreAlert registration / demo | _to be added_ |
| Contract (if used) | _not used in the MVP_ |

## Demo video

_To be recorded before submission._

## Security and limitations

- Testnet only (`qorechain-diana`, EVM chain ID `9800`).
- Polling is near-real-time, not a mempool-level guarantee.
- Telegram delivery depends on Telegram's API and the bot's rate limits.
- The service is read-only by design. It cannot move funds.
- A watch registration proves control of the address at registration time; it does not prove that the address is safe.

## Licence

MIT. See [LICENSE](LICENSE).

## AI usage

See [AI_USAGE.md](AI_USAGE.md).

## Team

- Kcee Hackathon — [@kceehackathon](https://github.com/kceehackathon)
