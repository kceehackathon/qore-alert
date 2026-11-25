# Architecture

## Goal

Watch a QoreChain address on both lanes and notify its owner when something security-relevant changes.

## Components

### Indexer

- TypeScript process.
- Reads the watchlist from SQLite.
- Polls QoreChain REST and EVM RPC for:
  - native transfers;
  - EVM transactions;
  - EVM-window opens and closes;
  - PQC key registration and rotation;
  - approval/permit exposure (where available from logs).
- Normalises events and writes them to SQLite with a deduplication key.

### Telegram bot

- Commands: `/start`, `/watch <address> [label]`, `/unwatch <address>`, `/list`, `/status`, `/alerts`.
- Sends one message per new high-signal event.
- Links every event to the QoreChain explorer.

### Dashboard

- Lists watches and recent events.
- Shows severity and the raw transaction hash.
- Allows adding a watch by signing a `0.000001 QOR` self-send with a `qorealert:watch:<address>` memo.

### Registration verifier

- Reads the transaction behind the memo.
- Checks the sender, memo shape, amount, and hybrid signature.
- Adds the watch only after the transaction is confirmed.

## Data model

```sql
watches(id, address, label, telegram_chat_id, created_at)
events(id, watch_id, kind, severity, tx_hash, block_height, payload, created_at)
registrations(tx_hash, address, verified_at)
```

## Trust boundaries

- Public chain data is untrusted input and must be validated.
- Telegram user input is untrusted; addresses and labels are length-limited.
- The service holds no signing keys.
- The dashboard is a convenience layer; the chain is the source of truth.

## Failure modes

- RPC outage: retry with backoff, keep the last processed height.
- Duplicate events: deduplicate by `(tx_hash, event_index)`.
- Telegram outage: queue alerts and retry.
- Reorg: re-scan the last N blocks; do not treat an alert as final until the confirmation depth is reached.
