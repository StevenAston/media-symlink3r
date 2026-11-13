import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';
import { AppConfig } from './config';

const { DatabaseSync } = process.getBuiltinModule(
  'node:sqlite',
) as typeof import('node:sqlite');
export type DatabaseSync = DatabaseSyncType;

export interface FileRecord {
  id: number;
  full_path: string;
  virtual_path: string | null;
  physical_drive: string | null;
  filename: string;
  directory: string;
  scan_source: 'media' | 'downloads';
  file_size: number;
  modified_date: number;
  is_symlink: number;
  symlink_target: string | null;
  status: string;
  xxh128_hash: string | null;
  sparse_hash: string | null;
  quick_hash: string | null;
  hash_date: number | null;
  duplicate_of_id: number | null;
  torrent_hash: string | null;
  torrent_name: string | null;
  category: string | null;
  tags: string | null;
  error_message: string | null;
}

export interface StatusCounts {
  total: number;
  new: number;
  sparse_hashed: number;
  hashed: number;
  duplicate_found: number;
  symlinked: number;
  error: number;
}

export function openDatabase(dbFilePath: string): DatabaseSync {
  const db = new DatabaseSync(dbFilePath);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA synchronous = NORMAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA busy_timeout = 10000;');
  return db;
}

export function withDatabase<T>(dbFilePath: string, fn: (db: DatabaseSync) => T): T {
  const db = openDatabase(dbFilePath);
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

export function initializeDatabase(dbFilePath: string): void {
  withDatabase(dbFilePath, (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS files (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        full_path TEXT UNIQUE NOT NULL,
        virtual_path TEXT,
        physical_drive TEXT,
        filename TEXT NOT NULL,
        directory TEXT NOT NULL,
        scan_source TEXT NOT NULL,
        file_size INTEGER NOT NULL,
        modified_date REAL NOT NULL,
        is_symlink INTEGER NOT NULL DEFAULT 0,
        symlink_target TEXT,
        status TEXT NOT NULL DEFAULT 'new',
        xxh128_hash TEXT,
        sparse_hash TEXT,
        quick_hash TEXT,
        hash_date REAL,
        duplicate_of_id INTEGER,
        torrent_hash TEXT,
        torrent_name TEXT,
        category TEXT,
        tags TEXT,
        error_message TEXT,
        FOREIGN KEY (duplicate_of_id) REFERENCES files (id) ON DELETE SET NULL
      );

      CREATE TABLE IF NOT EXISTS torrents (
        hash TEXT PRIMARY KEY,
        name TEXT,
        save_path TEXT,
        category TEXT,
        tags TEXT,
        state TEXT,
        progress REAL DEFAULT 1.0,
        total_size INTEGER DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS torrent_files (
        torrent_hash TEXT NOT NULL,
        filepath_in_torrent TEXT NOT NULL,
        file_size INTEGER NOT NULL,
        virtual_path TEXT,
        filename TEXT,
        PRIMARY KEY (torrent_hash, filepath_in_torrent),
        FOREIGN KEY (torrent_hash) REFERENCES torrents (hash) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS symlink_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        download_file_id INTEGER,
        download_path TEXT NOT NULL,
        virtual_download_path TEXT,
        backup_path TEXT NOT NULL,
        target_path TEXT NOT NULL,
        target_mode TEXT NOT NULL DEFAULT 'virtual',
        file_size INTEGER NOT NULL DEFAULT 0,
        xxh128_hash TEXT,
        torrent_hash TEXT,
        created_at REAL NOT NULL DEFAULT (unixepoch()),
        bak_status TEXT NOT NULL DEFAULT 'present',
        recheck_verified INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_files_full_path ON files (full_path);
      CREATE INDEX IF NOT EXISTS idx_files_virtual_path ON files (virtual_path);
      CREATE INDEX IF NOT EXISTS idx_files_xxh128_hash ON files (xxh128_hash);
      CREATE INDEX IF NOT EXISTS idx_files_sparse_hash ON files (sparse_hash);
      CREATE INDEX IF NOT EXISTS idx_files_quick_hash ON files (quick_hash);
      CREATE INDEX IF NOT EXISTS idx_files_file_size ON files (file_size);
      CREATE INDEX IF NOT EXISTS idx_files_status_source ON files (scan_source, status, is_symlink);
      CREATE INDEX IF NOT EXISTS idx_torrent_files_filepath ON torrent_files (filepath_in_torrent);
      CREATE INDEX IF NOT EXISTS idx_torrent_files_virtual_path ON torrent_files (virtual_path);
    `);
  });
}

export function getStatusCounts(dbFilePath: string): StatusCounts {
  return withDatabase(dbFilePath, (db) => {
    const getCount = (whereClause?: string): number => {
      const sql = whereClause
        ? `SELECT COUNT(*) AS c FROM files WHERE ${whereClause}`
        : `SELECT COUNT(*) AS c FROM files`;
      const row = db.prepare(sql).get() as { c: number } | undefined;
      return Number(row?.c ?? 0);
    };

    return {
      total: getCount(),
      new: getCount("status = 'new'"),
      sparse_hashed: getCount("status = 'sparse_hashed'"),
      hashed: getCount("status = 'hashed'"),
      duplicate_found: getCount("status = 'duplicate_found'"),
      symlinked: getCount("status IN ('symlinked', 'processed')"),
      error: getCount("status LIKE 'error%'"),
    };
  });
}

export function savePersistedSettings(dbFilePath: string, partialConfig: Partial<AppConfig>): void {
  withDatabase(dbFilePath, (db) => {
    const stmt = db.prepare(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    );
    for (const [k, v] of Object.entries(partialConfig)) {
      if (v !== undefined) {
        stmt.run(k, JSON.stringify(v));
      }
    }
  });
}

export function loadPersistedSettings(dbFilePath: string, baseConfig: AppConfig): AppConfig {
  return withDatabase(dbFilePath, (db) => {
    const rows = db.prepare('SELECT key, value FROM settings').all() as Array<{
      key: string;
      value: string;
    }>;
    const merged: Record<string, unknown> = { ...baseConfig };
    for (const row of rows) {
      try {
        merged[row.key] = JSON.parse(row.value);
      } catch {
        // Ignore malformed setting
      }
    }
    return merged as unknown as AppConfig;
  });
}
