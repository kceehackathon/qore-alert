import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

import { env } from "./env.js";
import type { AlertEvent, EventKind, NewWatch, Severity, Watch } from "./types.js";

fs.mkdirSync(path.dirname(env.databaseUrl), { recursive: true });

export const db = new Database(env.databaseUrl);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS watches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    address TEXT NOT NULL UNIQUE,
    evm_address TEXT NOT NULL,
    label TEXT NOT NULL DEFAULT '',
    telegram_chat_id TEXT,
    created_at TEXT NOT NULL,
    last_native_height INTEGER NOT NULL DEFAULT 0,
    last_evm_block INTEGER NOT NULL DEFAULT 0,
    last_pqc_fingerprint TEXT,
    last_window_fingerprint TEXT
  );

  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    watch_id INTEGER NOT NULL REFERENCES watches(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    severity TEXT NOT NULL,
    title TEXT NOT NULL,
    detail TEXT NOT NULL,
    tx_hash TEXT,
    block_height INTEGER,
    created_at TEXT NOT NULL,
    UNIQUE(watch_id, kind, tx_hash)
  );

  CREATE INDEX IF NOT EXISTS events_watch_created
    ON events(watch_id, created_at DESC);
`);

interface WatchRow {
  id: number;
  address: string;
  evm_address: string;
  label: string;
  telegram_chat_id: string | null;
  created_at: string;
  last_native_height: number;
  last_evm_block: number;
  last_pqc_fingerprint: string | null;
  last_window_fingerprint: string | null;
}

interface EventRow {
  id: number;
  watch_id: number;
  address: string;
  label: string;
  kind: EventKind;
  severity: Severity;
  title: string;
  detail: string;
  tx_hash: string | null;
  block_height: number | null;
  created_at: string;
}

function mapWatch(row: WatchRow): Watch {
  return {
    id: row.id,
    address: row.address,
    evmAddress: row.evm_address,
    label: row.label,
    telegramChatId: row.telegram_chat_id,
    createdAt: row.created_at,
    lastNativeHeight: row.last_native_height,
    lastEvmBlock: row.last_evm_block,
    lastPqcFingerprint: row.last_pqc_fingerprint,
    lastWindowFingerprint: row.last_window_fingerprint,
  };
}

function mapEvent(row: EventRow): AlertEvent {
  return {
    id: row.id,
    watchId: row.watch_id,
    address: row.address,
    label: row.label,
    kind: row.kind,
    severity: row.severity,
    title: row.title,
    detail: row.detail,
    txHash: row.tx_hash,
    blockHeight: row.block_height,
    createdAt: row.created_at,
  };
}

export function listWatches(): Watch[] {
  const rows = db
    .prepare("SELECT * FROM watches ORDER BY created_at DESC")
    .all() as WatchRow[];
  return rows.map(mapWatch);
}

export function getWatch(address: string): Watch | undefined {
  const row = db
    .prepare("SELECT * FROM watches WHERE address = ?")
    .get(address) as WatchRow | undefined;
  return row ? mapWatch(row) : undefined;
}

export function addWatch(input: NewWatch, normalized: { address: string; evmAddress: string }): Watch {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO watches (address, evm_address, label, telegram_chat_id, created_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(address) DO UPDATE SET
       label = CASE WHEN excluded.label <> '' THEN excluded.label ELSE watches.label END,
       telegram_chat_id = COALESCE(excluded.telegram_chat_id, watches.telegram_chat_id)`,
  ).run(
    normalized.address,
    normalized.evmAddress,
    input.label?.trim() ?? "",
    input.telegramChatId ?? null,
    now,
  );
  return getWatch(normalized.address)!;
}

export function removeWatch(address: string): boolean {
  const result = db.prepare("DELETE FROM watches WHERE address = ?").run(address);
  return result.changes > 0;
}

export function updateWatchCursor(
  watchId: number,
  patch: Partial<Pick<Watch, "lastNativeHeight" | "lastEvmBlock" | "lastPqcFingerprint" | "lastWindowFingerprint">>,
): void {
  const fields: string[] = [];
  const values: unknown[] = [];
  const map: Record<string, string> = {
    lastNativeHeight: "last_native_height",
    lastEvmBlock: "last_evm_block",
    lastPqcFingerprint: "last_pqc_fingerprint",
    lastWindowFingerprint: "last_window_fingerprint",
  };
  for (const [key, value] of Object.entries(patch)) {
    const column = map[key];
    if (column && value !== undefined) {
      fields.push(`${column} = ?`);
      values.push(value);
    }
  }
  if (fields.length === 0) return;
  values.push(watchId);
  db.prepare(`UPDATE watches SET ${fields.join(", ")} WHERE id = ?`).run(...values);
}

export function insertEvent(input: {
  watchId: number;
  kind: EventKind;
  severity: Severity;
  title: string;
  detail: string;
  txHash?: string | null;
  blockHeight?: number | null;
}): AlertEvent | null {
  const result = db
    .prepare(
      `INSERT OR IGNORE INTO events
        (watch_id, kind, severity, title, detail, tx_hash, block_height, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.watchId,
      input.kind,
      input.severity,
      input.title,
      input.detail,
      input.txHash ?? null,
      input.blockHeight ?? null,
      new Date().toISOString(),
    );
  if (result.changes === 0) return null;
  const row = db
    .prepare(
      `SELECT e.*, w.address, w.label
       FROM events e JOIN watches w ON w.id = e.watch_id
       WHERE e.id = ?`,
    )
    .get(result.lastInsertRowid) as EventRow;
  return mapEvent(row);
}

export function listEvents(opts: { address?: string; limit?: number } = {}): AlertEvent[] {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const rows = opts.address
    ? (db
        .prepare(
          `SELECT e.*, w.address, w.label
           FROM events e JOIN watches w ON w.id = e.watch_id
           WHERE w.address = ?
           ORDER BY e.created_at DESC LIMIT ?`,
        )
        .all(opts.address, limit) as EventRow[])
    : (db
        .prepare(
          `SELECT e.*, w.address, w.label
           FROM events e JOIN watches w ON w.id = e.watch_id
           ORDER BY e.created_at DESC LIMIT ?`,
        )
        .all(limit) as EventRow[]);
  return rows.map(mapEvent);
}

export function countEvents(): number {
  const row = db.prepare("SELECT COUNT(*) AS n FROM events").get() as { n: number };
  return row.n;
}
