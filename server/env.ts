import "dotenv/config";

function numberFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export const env = {
  port: numberFromEnv("PORT", 8787),
  restUrl: process.env.QORE_REST_URL ?? "https://api-testnet.qore.host",
  rpcUrl: process.env.QORE_RPC_URL ?? "https://rpc-testnet.qore.host",
  evmRpcUrl: process.env.QORE_EVM_RPC_URL ?? "https://evm-testnet.qore.host",
  chainId: numberFromEnv("QORE_CHAIN_ID", 9800),
  network: process.env.QORE_NETWORK ?? "qorechain-diana",
  databaseUrl: process.env.DATABASE_URL ?? "./data/qorealert.sqlite",
  pollIntervalMs: numberFromEnv("POLL_INTERVAL_MS", 15_000),
  confirmationDepth: numberFromEnv("CONFIRMATION_DEPTH", 3),
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN ?? "",
  telegramAllowedChatIds: (process.env.TELEGRAM_ALLOWED_CHAT_IDS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean),
  explorerBaseUrl: process.env.QORE_EXPLORER_URL ?? "https://explore.qore.network",
};
