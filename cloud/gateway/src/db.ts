import { Database } from "bun:sqlite";

/**
 * The gateway's own state: accounts, sessions, sandboxes, the credit ledger, metered
 * usage, push targets. Small and single-writer, so SQLite on the gateway's volume.
 * Money is integer micro-dollars (1 credit = 10_000 µ$ = one US cent of usage).
 */
const DDL = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  pw_hash TEXT NOT NULL,
  plan TEXT NOT NULL DEFAULT 'free',
  plan_renews_at INTEGER,
  stripe_customer_id TEXT,
  stripe_subscription_id TEXT,
  byok_anthropic TEXT,
  byok_openai TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sandboxes (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  driver TEXT NOT NULL,
  machine_id TEXT,
  volume_id TEXT,
  address TEXT,
  edge_secret TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  key_enc TEXT NOT NULL,
  status TEXT NOT NULL,
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS credit_ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  delta_micros INTEGER NOT NULL,
  reason TEXT NOT NULL,
  ref TEXT UNIQUE,
  at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS credit_ledger_user ON credit_ledger(user_id);
CREATE TABLE IF NOT EXISTS usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  agent_id TEXT,
  input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  cache_read_tokens INTEGER NOT NULL,
  cache_write_tokens INTEGER NOT NULL,
  cost_micros INTEGER NOT NULL,
  byok INTEGER NOT NULL,
  at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS usage_user_at ON usage(user_id, at);
CREATE TABLE IF NOT EXISTS push_targets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  target TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(kind, target)
);
CREATE TABLE IF NOT EXISTS stripe_events (
  id TEXT PRIMARY KEY,
  at INTEGER NOT NULL
);
`;

export type Db = Database;

export function openDb(path: string): Db {
  const db = new Database(path, { create: true, strict: true });
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  db.exec(DDL);
  return db;
}

export interface UserRow {
  id: string;
  email: string;
  pw_hash: string;
  plan: string;
  plan_renews_at: number | null;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  byok_anthropic: string | null;
  byok_openai: string | null;
  created_at: number;
}

export interface SandboxRow {
  user_id: string;
  driver: string;
  machine_id: string | null;
  volume_id: string | null;
  address: string | null;
  edge_secret: string;
  key_hash: string;
  key_enc: string;
  status: "creating" | "running" | "error" | "deleting";
  error: string | null;
  created_at: number;
  updated_at: number;
}
