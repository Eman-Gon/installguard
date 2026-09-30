-- Gateway job store (SQLite). Mirrors the schema created in gateway/src/store.mjs.
PRAGMA journal_mode=WAL;

CREATE TABLE IF NOT EXISTS proofs (
  hash       TEXT PRIMARY KEY,
  request_id TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS jobs (
  id   TEXT PRIMARY KEY,
  hash TEXT NOT NULL,
  data TEXT NOT NULL
);
