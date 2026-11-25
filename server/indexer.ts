import { formatEther } from "viem";

import { env } from "./env.js";
import { insertEvent, listWatches, updateWatchCursor } from "./db.js";
import {
  attribute,
  evmWindowFingerprint,
  explorerTxUrl,
  formatUqor,
  getDecodedTx,
  getEvmBlock,
  getEvmBlockNumber,
  getLatestHeight,
  messageType,
  pqcFingerprint,
  readEvmWindow,
  readPqcStatus,
  searchNativeTxs,
  shortAddress,
  type DecodedTx,
  type EvmBlock,
  type RpcTx,
} from "./qore.js";
import type { AlertEvent, EventKind, Severity, Watch } from "./types.js";

type EventSink = (event: AlertEvent) => void;

let timer: NodeJS.Timeout | undefined;
let running = false;
let evmCursor = 0;
let lastPqcCheck = 0;
let lastWindowCheck = 0;

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

interface Transfer {
  from: string;
  to: string;
  amount: string;
}

function nativeTransfers(message: Record<string, unknown>): Transfer[] {
  const type = messageType(message);
  if (type.endsWith("MsgSend")) {
    return [
      {
        from: String(message.from_address ?? ""),
        to: String(message.to_address ?? ""),
        amount: asArray(message.amount)
          .map((coin) => {
            const entry = asRecord(coin);
            return `${entry.amount ?? "?"}${entry.denom ?? ""}`;
          })
          .join(", "),
      },
    ];
  }
  if (type.endsWith("MsgMultiSend")) {
    const inputs = asArray(message.inputs).map(asRecord);
    const outputs = asArray(message.outputs).map(asRecord);
    const from = String(inputs[0]?.address ?? "");
    return outputs.map((output) => ({
      from,
      to: String(output.address ?? ""),
      amount: asArray(output.coins)
        .map((coin) => {
          const entry = asRecord(coin);
          return `${entry.amount ?? "?"}${entry.denom ?? ""}`;
        })
        .join(", "),
    }));
  }
  return [];
}

function formatNativeAmount(raw: string): string {
  const match = raw.match(/^(\d+)(.+)$/);
  if (!match) return raw || "0";
  const [, amount, denom] = match;
  if (denom === "uqor") return formatUqor(amount!);
  return `${BigInt(amount!).toLocaleString("en-US")} ${denom}`;
}

function notify(
  sink: EventSink,
  input: Parameters<typeof insertEvent>[0],
): void {
  const event = insertEvent(input);
  if (event) sink(event);
}

function registrationTarget(memo: string): string | null {
  const prefix = "qorealert:watch:";
  if (!memo.startsWith(prefix)) return null;
  return memo.slice(prefix.length).trim() || null;
}

function describeNative(watch: Watch, tx: DecodedTx): {
  kind: EventKind;
  severity: Severity;
  title: string;
  detail: string;
} | null {
  const transfers = tx.messages.flatMap(nativeTransfers);
  const outgoing = transfers.filter((transfer) => transfer.from === watch.address);
  const incoming = transfers.filter((transfer) => transfer.to === watch.address);

  if (outgoing.length > 0) {
    const transfer = outgoing[0]!;
    return {
      kind: "native-out",
      severity: "warning",
      title: `Outgoing transfer from ${watch.label || shortAddress(watch.address)}`,
      detail: `${formatNativeAmount(transfer.amount)} sent to ${shortAddress(transfer.to)}.${
        tx.isHybrid ? " Hybrid-signed." : " Classical-only signature."
      }`,
    };
  }
  if (incoming.length > 0) {
    const transfer = incoming[0]!;
    return {
      kind: "native-in",
      severity: "info",
      title: `Incoming transfer to ${watch.label || shortAddress(watch.address)}`,
      detail: `${formatNativeAmount(transfer.amount)} received from ${shortAddress(transfer.from)}.${
        tx.isHybrid ? " Hybrid-signed." : ""
      }`,
    };
  }

  const memo = tx.memo ?? "";
  const target = registrationTarget(memo);
  if (target && (target === watch.address || tx.messages.some((message) => String(message.sender ?? "") === watch.address))) {
    return {
      kind: "registration",
      severity: "info",
      title: "Watch registered on chain",
      detail: `A QoreAlert watch registration was confirmed${tx.isHybrid ? " with a hybrid signature" : ""}. Memo: ${memo}`,
    };
  }

  const sender = tx.messages
    .map((message) => String(message.sender ?? message.from_address ?? ""))
    .find(Boolean);
  if (sender === watch.address) {
    const type = tx.messages.map(messageType).filter(Boolean).join(", ") || "transaction";
    return {
      kind: "native-out",
      severity: "warning",
      title: `Activity from ${watch.label || shortAddress(watch.address)}`,
      detail: `${type} confirmed.${tx.isHybrid ? " Hybrid-signed." : ""}${
        memo ? ` Memo: ${memo}` : ""
      }`,
    };
  }

  return null;
}

function windowChanged(previous: string | null, current: string): boolean {
  if (!previous) return false;
  try {
    const before = JSON.parse(previous) as {
      found?: boolean;
      live?: boolean;
      remainingTxs?: string;
    };
    const after = JSON.parse(current) as {
      found?: boolean;
      live?: boolean;
      remainingTxs?: string;
    };
    return (
      before.found !== after.found ||
      before.live !== after.live ||
      (before.remainingTxs !== "0" && after.remainingTxs === "0")
    );
  } catch {
    return previous !== current;
  }
}

async function scanNative(sink: EventSink, latestHeight: number): Promise<void> {
  const watches = listWatches();
  for (const watch of watches) {
    const fromHeight = watch.lastNativeHeight > 0 ? watch.lastNativeHeight : Math.max(0, latestHeight - 50);
    let txs: RpcTx[] = [];
    try {
      txs = await searchNativeTxs(watch.address, fromHeight);
    } catch (error) {
      console.error(`native search failed for ${watch.address}:`, error);
      continue;
    }
    let cursor = fromHeight;
    for (const rpcTx of txs) {
      cursor = Math.max(cursor, rpcTx.height);
      if (rpcTx.tx_result.code !== 0) continue;
      let decoded: DecodedTx | null = null;
      try {
        decoded = await getDecodedTx(rpcTx.hash);
      } catch (error) {
        console.error(`decode failed for ${rpcTx.hash}:`, error);
        continue;
      }
      if (!decoded) continue;
      const description = describeNative(watch, decoded);
      if (!description) continue;
      notify(sink, {
        watchId: watch.id,
        kind: description.kind,
        severity: description.severity,
        title: description.title,
        detail: description.detail,
        txHash: rpcTx.hash,
        blockHeight: rpcTx.height,
      });
    }
    updateWatchCursor(watch.id, { lastNativeHeight: cursor || latestHeight });
  }
}

async function scanEvm(sink: EventSink, watches: Watch[]): Promise<void> {
  const latest = await getEvmBlockNumber();
  if (evmCursor === 0) {
    evmCursor = Math.max(0, latest - 3);
    return;
  }
  if (latest <= evmCursor) return;
  const start = Math.max(evmCursor + 1, latest - 10);
  for (let height = start; height <= latest; height += 1) {
    let block: EvmBlock | null = null;
    try {
      block = await getEvmBlock(height);
    } catch (error) {
      console.error(`EVM block ${height} failed:`, error);
      continue;
    }
    if (!block) continue;
    for (const transaction of block.transactions) {
      const from = transaction.from.toLowerCase();
      const to = transaction.to?.toLowerCase() ?? "";
      for (const watch of watches) {
        const watched = watch.evmAddress.toLowerCase();
        if (from !== watched && to !== watched) continue;
        const outgoing = from === watched;
        const value = BigInt(transaction.value || "0");
        const valueText = value > 0n ? `${formatEther(value)} QOR` : "0 QOR";
        const isContractCall = Boolean(transaction.to && transaction.input && transaction.input !== "0x");
        const kind: EventKind = outgoing ? "evm-out" : isContractCall ? "evm-call" : "evm-in";
        notify(sink, {
          watchId: watch.id,
          kind,
          severity: outgoing ? "warning" : "info",
          title: outgoing
            ? `Outgoing EVM transaction from ${watch.label || shortAddress(watch.address)}`
            : `Incoming EVM activity to ${watch.label || shortAddress(watch.address)}`,
          detail: `${valueText}${transaction.to ? ` to ${shortAddress(transaction.to)}` : " (contract creation)"}${
            isContractCall ? " with calldata" : ""
          }.`,
          txHash: transaction.hash,
          blockHeight: height,
        });
      }
    }
    evmCursor = height;
    for (const watch of watches) {
      updateWatchCursor(watch.id, { lastEvmBlock: height });
    }
  }
}

async function scanConsent(sink: EventSink): Promise<void> {
  const now = Date.now();
  if (now - lastPqcCheck < 60_000 && now - lastWindowCheck < 60_000) return;
  const watches = listWatches();
  for (const watch of watches) {
    if (now - lastPqcCheck >= 60_000) {
      try {
        const status = await readPqcStatus(watch.address);
        const fingerprint = pqcFingerprint(status);
        if (watch.lastPqcFingerprint && watch.lastPqcFingerprint !== fingerprint) {
          notify(sink, {
            watchId: watch.id,
            kind: "pqc-key",
            severity: status.registered ? "info" : "critical",
            title: status.registered ? "Post-quantum key changed" : "Post-quantum key removed",
            detail: status.registered
              ? `The account has a registered ML-DSA-87 key. Fingerprint: ${fingerprint.slice(0, 140)}`
              : "The account no longer reports a registered ML-DSA-87 key. Treat this as urgent.",
            txHash: null,
            blockHeight: null,
          });
        }
        updateWatchCursor(watch.id, { lastPqcFingerprint: fingerprint });
      } catch (error) {
        console.error(`PQC status failed for ${watch.address}:`, error);
      }
    }

    if (now - lastWindowCheck >= 60_000) {
      try {
        const window = await readEvmWindow(watch.address);
        const fingerprint = evmWindowFingerprint(window);
        if (windowChanged(watch.lastWindowFingerprint, fingerprint)) {
          notify(sink, {
            watchId: watch.id,
            kind: "evm-window",
            severity: window.live ? "info" : "warning",
            title: window.live ? "EVM window changed" : "EVM window closed or exhausted",
            detail: window.found
              ? `Window ${window.live ? "is live" : "is not usable"}: ${window.remainingTxs} transactions left, ${window.remainingBlocks} blocks left.`
              : "No EVM authorisation window is open for this account.",
            txHash: null,
            blockHeight: null,
          });
        }
        updateWatchCursor(watch.id, { lastWindowFingerprint: fingerprint });
      } catch (error) {
        console.error(`EVM window failed for ${watch.address}:`, error);
      }
    }
  }
  lastPqcCheck = now;
  lastWindowCheck = now;
}

async function tick(sink: EventSink): Promise<void> {
  if (running) return;
  running = true;
  try {
    const watches = listWatches();
    if (watches.length === 0) return;
    const latestHeight = await getLatestHeight();
    await scanNative(sink, latestHeight);
    await scanEvm(sink, watches);
    await scanConsent(sink);
  } catch (error) {
    console.error("indexer tick failed:", error);
  } finally {
    running = false;
  }
}

export function startIndexer(sink: EventSink): void {
  if (timer) return;
  const run = () => void tick(sink);
  run();
  timer = setInterval(run, env.pollIntervalMs);
  console.log(`QoreAlert indexer started (${env.network}, every ${env.pollIntervalMs}ms)`);
}

export function stopIndexer(): void {
  if (timer) clearInterval(timer);
  timer = undefined;
}
