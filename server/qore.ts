import {
  evmToQor,
  fetchEvmWindow,
  fetchPqcStatus,
  isValidBech32,
  qorToEvm,
  type PqcStatus,
} from "@qorechain/sdk";

import { env } from "./env.js";

export interface NormalizedAddress {
  address: string;
  evmAddress: string;
}

export function normalizeAddress(input: string): NormalizedAddress | null {
  const value = input.trim();
  if (!value) return null;

  try {
    if (value.startsWith("0x") && /^0x[0-9a-fA-F]{40}$/.test(value)) {
      const address = evmToQor(value);
      return { address, evmAddress: qorToEvm(address) };
    }
    if (value.startsWith("qor1") && isValidBech32(value, "qor")) {
      return { address: value, evmAddress: qorToEvm(value) };
    }
  } catch {
    return null;
  }
  return null;
}

export function shortAddress(address: string): string {
  if (address.length <= 14) return address;
  return `${address.slice(0, 8)}…${address.slice(-6)}`;
}

export function explorerTxUrl(hash: string): string {
  return `${env.explorerBaseUrl}/tx/${hash}?network=testnet`;
}

export function explorerAddressUrl(address: string): string {
  return `${env.explorerBaseUrl}/address/${address}?network=testnet`;
}

/** Minimal JSON-RPC client for the QoreChain consensus RPC. */
async function rpc<T>(method: string, params: unknown): Promise<T> {
  const response = await fetch(env.rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!response.ok) {
    throw new Error(`Qore RPC ${method} failed: HTTP ${response.status}`);
  }
  const payload = (await response.json()) as {
    result?: T;
    error?: { message?: string; data?: string };
  };
  if (payload.error) {
    throw new Error(`Qore RPC ${method} failed: ${payload.error.message ?? "unknown error"}`);
  }
  if (payload.result === undefined) {
    throw new Error(`Qore RPC ${method} returned no result`);
  }
  return payload.result;
}

export async function getLatestHeight(): Promise<number> {
  const response = await fetch(
    `${env.restUrl}/cosmos/base/tendermint/v1beta1/blocks/latest`,
  );
  if (!response.ok) throw new Error(`latest block failed: HTTP ${response.status}`);
  const payload = (await response.json()) as {
    block?: { header?: { height?: string } };
  };
  const height = Number(payload.block?.header?.height ?? 0);
  if (!Number.isFinite(height) || height <= 0) {
    throw new Error("latest block response did not contain a height");
  }
  return height;
}

export interface RpcTx {
  hash: string;
  height: number;
  index: number;
  tx: string;
  tx_result: {
    code: number;
    log?: string;
    events?: Array<{ type: string; attributes: Array<{ key: string; value: string }> }>;
  };
}

interface TxSearchResult {
  txs?: RpcTx[];
  total_count?: string;
}

export async function searchNativeTxs(
  address: string,
  fromHeight: number,
  limit = 25,
): Promise<RpcTx[]> {
  const queries = [
    `message.sender='${address}' AND tx.height>${fromHeight}`,
    `transfer.recipient='${address}' AND tx.height>${fromHeight}`,
  ];
  const results = await Promise.all(
    queries.map(async (query) => {
      const result = await rpc<TxSearchResult>("tx_search", {
        query,
        per_page: String(limit),
        order_by: "desc",
        prove: false,
      });
      return result.txs ?? [];
    }),
  );
  const byHash = new Map<string, RpcTx>();
  for (const tx of results.flat()) byHash.set(tx.hash, tx);
  return [...byHash.values()].sort((a, b) => a.height - b.height || a.index - b.index);
}

export interface DecodedTx {
  hash: string;
  height: number;
  code: number;
  memo: string;
  messages: Array<Record<string, unknown>>;
  isHybrid: boolean;
  events: Array<{ type: string; attributes: Array<{ key: string; value: string }> }>;
}

interface RestTxResponse {
  tx?: {
    body?: {
      messages?: Array<Record<string, unknown>>;
      memo?: string;
      extension_options?: Array<Record<string, unknown>>;
      non_critical_extension_options?: Array<Record<string, unknown>>;
    };
  };
  tx_response?: {
    txhash?: string;
    height?: string;
    code?: number;
    events?: Array<{ type: string; attributes: Array<{ key: string; value: string }> }>;
  };
}

function findHybridExtension(tx: RestTxResponse["tx"]): boolean {
  const options = [
    ...(tx?.body?.extension_options ?? []),
    ...(tx?.body?.non_critical_extension_options ?? []),
  ];
  return options.some((option) => {
    const type = String(option["@type"] ?? option.type_url ?? option.typeUrl ?? "");
    return type.includes("PQCHybridSignature");
  });
}

export async function getDecodedTx(hash: string): Promise<DecodedTx | null> {
  const response = await fetch(`${env.restUrl}/cosmos/tx/v1beta1/txs/${hash}`);
  if (!response.ok) return null;
  const payload = (await response.json()) as RestTxResponse;
  const responseData = payload.tx_response;
  if (!responseData) return null;
  const messages = payload.tx?.body?.messages ?? [];
  const events = responseData.events ?? [];
  const hybridEvent = events.some(
    (event) =>
      event.type === "pqc_hybrid_verify" &&
      event.attributes.some((attribute) => attribute.key === "status" && attribute.value === "verified"),
  );
  return {
    hash: responseData.txhash ?? hash,
    height: Number(responseData.height ?? 0),
    code: Number(responseData.code ?? 0),
    memo: payload.tx?.body?.memo ?? "",
    messages,
    isHybrid: hybridEvent || findHybridExtension(payload.tx),
    events,
  };
}

export function messageType(message: Record<string, unknown>): string {
  return String(message["@type"] ?? message.type ?? message.typeUrl ?? "");
}

export function attribute(
  events: Array<{ type: string; attributes: Array<{ key: string; value: string }> }>,
  type: string,
  key: string,
): string | undefined {
  for (const event of events) {
    if (event.type !== type) continue;
    const found = event.attributes.find((entry) => entry.key === key);
    if (found) return found.value;
  }
  return undefined;
}

export function formatUqor(raw: string | number | bigint): string {
  const value = BigInt(raw);
  const whole = value / 1_000_000n;
  const fraction = value % 1_000_000n;
  if (fraction === 0n) return `${whole.toString()} QOR`;
  return `${whole.toString()}.${fraction.toString().padStart(6, "0").replace(/0+$/, "")} QOR`;
}

/** EVM JSON-RPC helpers. */
async function evmRpc<T>(method: string, params: unknown[]): Promise<T> {
  const response = await fetch(env.evmRpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!response.ok) throw new Error(`EVM RPC ${method} failed: HTTP ${response.status}`);
  const payload = (await response.json()) as {
    result?: T;
    error?: { message?: string };
  };
  if (payload.error) {
    throw new Error(`EVM RPC ${method} failed: ${payload.error.message ?? "unknown error"}`);
  }
  return payload.result as T;
}

export interface EvmBlock {
  number: string;
  timestamp: string;
  transactions: Array<{
    hash: string;
    from: string;
    to: string | null;
    value: string;
    input: string;
    nonce: string;
  }>;
}

export async function getEvmBlockNumber(): Promise<number> {
  const result = await evmRpc<string>("eth_blockNumber", []);
  return Number.parseInt(result, 16);
}

export async function getEvmBlock(blockNumber: number): Promise<EvmBlock | null> {
  return evmRpc<EvmBlock | null>("eth_getBlockByNumber", [
    `0x${blockNumber.toString(16)}`,
    true,
  ]);
}

export async function readPqcStatus(address: string): Promise<PqcStatus> {
  return fetchPqcStatus({ rest: env.restUrl, address });
}

export type EvmWindow = Awaited<ReturnType<typeof fetchEvmWindow>>;

export async function readEvmWindow(address: string): Promise<EvmWindow> {
  return fetchEvmWindow({ rest: env.restUrl, address });
}

export function pqcFingerprint(status: PqcStatus): string {
  return JSON.stringify({
    registered: status.registered,
    algorithmId: status.algorithmId ?? null,
    pubkey:
      typeof status.pubkey === "string"
        ? status.pubkey
        : status.pubkey
          ? Array.from(status.pubkey).join(",")
          : null,
  });
}

export function evmWindowFingerprint(window: EvmWindow): string {
  return JSON.stringify({
    found: window.found,
    live: window.live,
    expiryHeight: String(window.expiryHeight),
    remainingTxs: String(window.remainingTxs),
    nativeOnly: window.nativeOnly,
    allowedTargets: window.allowedTargets,
  });
}
