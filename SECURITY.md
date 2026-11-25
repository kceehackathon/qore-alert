# Security policy

## Scope

QoreAlert is a testnet-only, read-only watchtower. It does not custody funds and it must never ask for a seed phrase, private key, or QoreX recovery phrase.

## Reporting a vulnerability

Open a private security advisory on GitHub, or contact the maintainer through the project page. Do not publish an exploitable issue before it has been acknowledged.

## Operational rules

- Keep `.env` out of git. Only `.env.example` is committed.
- Use a dedicated Telegram bot token for testnet.
- Treat all chain data as public; do not store private evidence in the database.
- Rotate any credential that is accidentally committed or shared.
- The indexer only needs read access to public RPC/REST endpoints.

## Known limitations

- Polling is not a consensus-level guarantee. A block reorganisation can delay or change an alert.
- Telegram delivery is best-effort.
- A watch registration proves control at registration time; it does not prove that an address is safe.
