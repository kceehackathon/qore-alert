import path from "node:path";
import express from "express";

import { env } from "./env.js";
import {
  addWatch,
  countEvents,
  getWatch,
  listEvents,
  listWatches,
  removeWatch,
} from "./db.js";
import { startIndexer } from "./indexer.js";
import {
  explorerAddressUrl,
  explorerTxUrl,
  getDecodedTx,
  messageType,
  normalizeAddress,
  shortAddress,
} from "./qore.js";
import { notifyTelegram, startTelegramBot } from "./telegram.js";
import type { AlertEvent } from "./types.js";

const app = express();
app.use(express.json({ limit: "32kb" }));

const clients = new Set<express.Response>();

function broadcast(event: AlertEvent): void {
  const payload = `event: alert\ndata: ${JSON.stringify(event)}\n\n`;
  for (const client of clients) {
    try {
      client.write(payload);
    } catch {
      clients.delete(client);
    }
  }
  notifyTelegram(event);
}

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    network: env.network,
    chainId: env.chainId,
    restUrl: env.restUrl,
    evmRpcUrl: env.evmRpcUrl,
    watches: listWatches().length,
    events: countEvents(),
    telegram: Boolean(env.telegramBotToken),
    now: new Date().toISOString(),
  });
});

app.get("/api/watches", (_req, res) => {
  res.json(
    listWatches().map((watch) => ({
      ...watch,
      explorerUrl: explorerAddressUrl(watch.address),
    })),
  );
});

app.post("/api/watches", (req, res) => {
  const body = req.body as { address?: string; label?: string; telegramChatId?: string };
  const normalized = normalizeAddress(body.address ?? "");
  if (!normalized) {
    res.status(400).json({ error: "Enter a valid qor1... or 0x... address." });
    return;
  }
  const watch = addWatch(
    {
      address: normalized.address,
      label: String(body.label ?? "").slice(0, 80),
      telegramChatId: body.telegramChatId ? String(body.telegramChatId) : null,
    },
    normalized,
  );
  res.status(201).json({ ...watch, explorerUrl: explorerAddressUrl(watch.address) });
});

app.delete("/api/watches/:address", (req, res) => {
  const normalized = normalizeAddress(req.params.address);
  if (!normalized) {
    res.status(400).json({ error: "Invalid address." });
    return;
  }
  const removed = removeWatch(normalized.address);
  res.status(removed ? 200 : 404).json({ removed });
});

app.get("/api/events", (req, res) => {
  const addressParam = typeof req.query.address === "string" ? req.query.address : undefined;
  const normalized = addressParam ? normalizeAddress(addressParam) : null;
  if (addressParam && !normalized) {
    res.status(400).json({ error: "Invalid address filter." });
    return;
  }
  const limit = Number(req.query.limit ?? 50);
  res.json(
    listEvents({
      address: normalized?.address,
      limit: Number.isFinite(limit) ? limit : 50,
    }),
  );
});

app.get("/api/events/stream", (req, res) => {
  res.setHeader("content-type", "text/event-stream");
  res.setHeader("cache-control", "no-cache, no-transform");
  res.setHeader("connection", "keep-alive");
  res.flushHeaders();
  res.write(`event: hello\ndata: {"ok":true}\n\n`);
  clients.add(res);
  const heartbeat = setInterval(() => {
    try {
      res.write(`: ping ${Date.now()}\n\n`);
    } catch {
      clients.delete(res);
    }
  }, 25_000);
  req.on("close", () => {
    clearInterval(heartbeat);
    clients.delete(res);
  });
});

app.post("/api/registrations/verify", async (req, res) => {
  const body = req.body as { txHash?: string; address?: string; telegramChatId?: string };
  const txHash = String(body.txHash ?? "").trim();
  if (!/^[0-9a-fA-F]{64}$/.test(txHash)) {
    res.status(400).json({ error: "Enter a 64-character transaction hash." });
    return;
  }
  const decoded = await getDecodedTx(txHash.toUpperCase());
  if (!decoded) {
    res.status(404).json({ error: "Transaction not found on the Diana testnet." });
    return;
  }
  if (decoded.code !== 0) {
    res.status(400).json({ error: `Transaction failed with code ${decoded.code}.` });
    return;
  }
  const memo = decoded.memo ?? "";
  const prefix = "qorealert:watch:";
  if (!memo.startsWith(prefix)) {
    res.status(400).json({ error: "This transaction does not carry a QoreAlert watch memo." });
    return;
  }
  const target = normalizeAddress(memo.slice(prefix.length).trim());
  if (!target) {
    res.status(400).json({ error: "The memo does not contain a valid watch address." });
    return;
  }
  if (!decoded.isHybrid) {
    res.status(400).json({ error: "The transaction is not hybrid-signed. Refusing to register it." });
    return;
  }
  const selfSend = decoded.messages.some((message) => {
    if (!messageType(message).endsWith("MsgSend")) return false;
    const from = String(message.from_address ?? "");
    const to = String(message.to_address ?? "");
    const amount = Array.isArray(message.amount) ? message.amount : [];
    const hasOneUqor = amount.some((coin) => {
      const entry = coin as { amount?: string; denom?: string };
      return String(entry.amount) === "1" && entry.denom === "uqor";
    });
    return from === target.address && to === target.address && hasOneUqor;
  });
  if (!selfSend) {
    res.status(400).json({
      error: "Expected a 0.000001 QOR self-send from the address named in the memo.",
    });
    return;
  }
  const watch = addWatch(
    {
      address: target.address,
      label: "On-chain registration",
      telegramChatId: body.telegramChatId ?? null,
    },
    target,
  );
  res.json({
    verified: true,
    hybrid: decoded.isHybrid,
    sender: target.address,
    memo,
    watch,
    txUrl: explorerTxUrl(decoded.hash),
  });
});

app.get("/api/registration/:address", (req, res) => {
  const normalized = normalizeAddress(req.params.address);
  if (!normalized) {
    res.status(400).json({ error: "Invalid address." });
    return;
  }
  const watch = getWatch(normalized.address);
  res.json({
    address: normalized.address,
    watched: Boolean(watch),
    memo: `qorealert:watch:${normalized.address}`,
    amount: "0.000001 QOR",
    instruction:
      "In QoreX, switch to Testnet and send exactly 0.000001 QOR to your own address with this memo. Then paste the transaction hash here.",
    explorerUrl: explorerAddressUrl(normalized.address),
  });
});

const dist = path.resolve(process.cwd(), "dist");
app.use(express.static(dist));
app.get("*", (req, res, next) => {
  if (req.path.startsWith("/api/")) return next();
  res.sendFile(path.join(dist, "index.html"), (error) => {
    if (error) next();
  });
});

const server = app.listen(env.port, () => {
  console.log(`QoreAlert API on http://localhost:${env.port}`);
  startTelegramBot();
  startIndexer((event) => {
    console.log(`[${event.severity}] ${event.title}: ${event.detail}`);
    broadcast(event);
  });
});

function shutdown(): void {
  console.log("Shutting down QoreAlert...");
  for (const client of clients) client.end();
  server.close(() => process.exit(0));
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

void shortAddress; // keep the helper available for future log formatting
