import { Bot } from "grammy";

import { env } from "./env.js";
import { addWatch, listEvents, listWatches, removeWatch } from "./db.js";
import { normalizeAddress, shortAddress } from "./qore.js";
import type { AlertEvent } from "./types.js";

let bot: Bot | null = null;

function allowed(chatId: string): boolean {
  return env.telegramAllowedChatIds.length === 0 || env.telegramAllowedChatIds.includes(chatId);
}

function helpText(): string {
  return [
    "QoreAlert watches a QoreChain address on both lanes.",
    "",
    "/watch qor1... [label] — add or update a watch",
    "/unwatch qor1... — remove a watch",
    "/list — list your watches",
    "/alerts — recent alerts",
    "/status — service status",
    "",
    "QoreAlert is read-only. It never asks for a seed phrase or private key.",
  ].join("\n");
}

export function startTelegramBot(): void {
  if (!env.telegramBotToken) {
    console.log("TELEGRAM_BOT_TOKEN is not set; Telegram bot disabled.");
    return;
  }
  const instance = new Bot(env.telegramBotToken);
  bot = instance;

  instance.command("start", async (ctx) => {
    if (!ctx.chat) return;
    if (!allowed(String(ctx.chat.id))) {
      await ctx.reply("This bot is not enabled for this chat.");
      return;
    }
    await ctx.reply(helpText());
  });

  instance.command("watch", async (ctx) => {
    if (!ctx.chat) return;
    if (!allowed(String(ctx.chat.id))) return;
    const [rawAddress, ...labelParts] = (ctx.match ?? "").trim().split(/\s+/);
    if (!rawAddress) {
      await ctx.reply("Usage: /watch qor1... [label]");
      return;
    }
    const normalized = normalizeAddress(rawAddress);
    if (!normalized) {
      await ctx.reply("That is not a valid qor1... or 0x... address.");
      return;
    }
    const watch = addWatch(
      {
        address: normalized.address,
        label: labelParts.join(" ").slice(0, 80),
        telegramChatId: String(ctx.chat.id),
      },
      normalized,
    );
    await ctx.reply(
      `Watching ${watch.label || shortAddress(watch.address)}\n${watch.address}\nEVM: ${watch.evmAddress}`,
    );
  });

  instance.command("unwatch", async (ctx) => {
    if (!ctx.chat) return;
    const normalized = normalizeAddress((ctx.match ?? "").trim());
    if (!normalized) {
      await ctx.reply("Usage: /unwatch qor1...");
      return;
    }
    const removed = removeWatch(normalized.address);
    await ctx.reply(removed ? "Watch removed." : "That address is not on the watchlist.");
  });

  instance.command("list", async (ctx) => {
    if (!ctx.chat) return;
    const watches = listWatches();
    if (watches.length === 0) {
      await ctx.reply("No watches yet. Use /watch qor1... to add one.");
      return;
    }
    await ctx.reply(
      watches
        .slice(0, 15)
        .map(
          (watch) =>
            `${watch.label || "(no label)"}\n${watch.address}\nEVM ${watch.evmAddress}`,
        )
        .join("\n\n"),
    );
  });

  instance.command("alerts", async (ctx) => {
    if (!ctx.chat) return;
    const events = listEvents({ limit: 8 });
    if (events.length === 0) {
      await ctx.reply("No alerts yet.");
      return;
    }
    await ctx.reply(
      events
        .map(
          (event) =>
            `[${event.severity}] ${event.title}\n${event.detail}\n${event.txHash ?? ""}`.trim(),
        )
        .join("\n\n"),
    );
  });

  instance.command("status", async (ctx) => {
    if (!ctx.chat) return;
    const watches = listWatches();
    await ctx.reply(
      [
        `Network: ${env.network} (chain ${env.chainId})`,
        `Watches: ${watches.length}`,
        `Indexer: every ${env.pollIntervalMs / 1000}s`,
        "Read-only: no keys are stored.",
      ].join("\n"),
    );
  });

  instance.catch((error) => {
    console.error("Telegram bot error:", error);
  });

  void instance.start({
    onStart: (info) => console.log(`Telegram bot @${info.username} started`),
  });
}

export function notifyTelegram(event: AlertEvent): void {
  if (!bot) return;
  const watch = listWatches().find((entry) => entry.id === event.watchId);
  const chatId = watch?.telegramChatId;
  if (!chatId) return;
  const text = [
    `[${event.severity.toUpperCase()}] ${event.title}`,
    event.detail,
    event.txHash ? `Tx: ${event.txHash}` : "",
  ]
    .filter(Boolean)
    .join("\n");
  void bot.api.sendMessage(chatId, text).catch((error) => {
    console.error("Telegram send failed:", error);
  });
}
