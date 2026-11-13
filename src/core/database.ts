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

export interface LivePoolFilter {
  minSizeBytes?: number | null;
  maxSizeBytes?: number | null;
  ageMode?: 'older' | 'newer';
  ageDays?: number | null;
  textQuery?: string | null;
}

export interface StatusCounts {
  total: number;
  new: number;
  sparse_hashed: number;
  hashed: number;
  duplicate_found: number;
  symlinked: number;
  error: number;
  totalBytes: number;
  newBytes: number;
  sparseHashedBytes: number;
  hashedBytes: number;
  duplicateFoundBytes: number;
  symlinkedBytes: number;
  errorBytes: number;
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
      CREATE INDEX IF NOT EXISTS idx_files_status_size ON files (status, file_size);
      CREATE INDEX IF NOT EXISTS idx_torrent_files_filepath ON torrent_files (filepath_in_torrent);
      CREATE INDEX IF NOT EXISTS idx_torrent_files_virtual_path ON torrent_files (virtual_path);

      -- Self-heal any non-zero-byte files erroneously marked is_symlink=1 by Everything INVALID_FILE_ATTRIBUTES (0xFFFFFFFF)
      UPDATE files
      SET is_symlink = 0,
          symlink_target = NULL,
          status = CASE WHEN xxh128_hash IS NOT NULL THEN 'hashed' ELSE 'new' END
      WHERE file_size > 0 AND is_symlink = 1;
    `);
  });
}

export function buildLivePoolWhereClause(
  filter?: LivePoolFilter,
  tableAlias?: string,
): { clauses: string[]; params: Array<string | number> } {
  const clauses: string[] = [];
  const params: Array<string | number> = [];
  if (!filter) {
    return { clauses, params };
  }

  const prefix = tableAlias ? `${tableAlias}.` : '';

  if (filter.minSizeBytes != null && filter.minSizeBytes > 0) {
    clauses.push(`${prefix}file_size >= ?`);
    params.push(filter.minSizeBytes);
  }

  if (filter.maxSizeBytes != null && filter.maxSizeBytes > 0) {
    clauses.push(`${prefix}file_size <= ?`);
    params.push(filter.maxSizeBytes);
  }

  if (filter.ageDays != null && filter.ageDays > 0) {
    const cutoffSec = Math.floor(Date.now() / 1000) - filter.ageDays * 86400;
    if (filter.ageMode === 'newer') {
      clauses.push(`${prefix}modified_date >= ?`);
      params.push(cutoffSec);
    } else {
      clauses.push(`${prefix}modified_date > 0 AND ${prefix}modified_date <= ?`);
      params.push(cutoffSec);
    }
  }

  if (filter.textQuery && filter.textQuery.trim().length > 0) {
    clauses.push(`${prefix}full_path LIKE ?`);
    params.push(`%${filter.textQuery.trim()}%`);
  }

  return { clauses, params };
}

export function getStatusCounts(
  dbFilePath: string,
  filter?: LivePoolFilter,
): StatusCounts {
  return withDatabase(dbFilePath, (db) => {
    const { clauses, params } = buildLivePoolWhereClause(filter);
    const whereSql = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = db
      .prepare(
        `SELECT status, COUNT(*) AS c, COALESCE(SUM(file_size), 0) AS b
         FROM files
         ${whereSql}
         GROUP BY status`,
      )
      .all(...params) as Array<{ status: string; c: number; b: number }>;

    const counts: StatusCounts = {
      total: 0,
      new: 0,
      sparse_hashed: 0,
      hashed: 0,
      duplicate_found: 0,
      symlinked: 0,
      error: 0,
      totalBytes: 0,
      newBytes: 0,
      sparseHashedBytes: 0,
      hashedBytes: 0,
      duplicateFoundBytes: 0,
      symlinkedBytes: 0,
      errorBytes: 0,
    };

    for (const row of rows) {
      const c = Number(row.c ?? 0);
      const b = Number(row.b ?? 0);
      counts.total += c;
      counts.totalBytes += b;

      if (row.status === 'new') {
        counts.new += c;
        counts.newBytes += b;
      } else if (row.status === 'sparse_hashed') {
        counts.sparse_hashed += c;
        counts.sparseHashedBytes += b;
      } else if (row.status === 'hashed') {
        counts.hashed += c;
        counts.hashedBytes += b;
      } else if (row.status === 'duplicate_found') {
        counts.duplicate_found += c;
        counts.duplicateFoundBytes += b;
      } else if (row.status === 'symlinked' || row.status === 'processed') {
        counts.symlinked += c;
        counts.symlinkedBytes += b;
      } else if (row.status.startsWith('error')) {
        counts.error += c;
        counts.errorBytes += b;
      }
    }

    if (counts.symlinked > 0 && counts.symlinkedBytes === 0) {
      const { clauses: symClauses, params: symParams } = buildLivePoolWhereClause(filter, 's');
      const symFilterAndSql = symClauses.length > 0 ? `AND ${symClauses.join(' AND ')}` : '';
      const symRow = db
        .prepare(
          `SELECT COALESCE(SUM(COALESCE(m.file_size, v.file_size, p.file_size, s.file_size)), 0) AS sym_bytes
           FROM files s
           LEFT JOIN files m ON m.id = s.duplicate_of_id
           LEFT JOIN files v ON v.virtual_path = s.symlink_target AND v.is_symlink = 0
           LEFT JOIN files p ON p.full_path = s.symlink_target AND p.is_symlink = 0
           WHERE s.status IN ('symlinked', 'processed') ${symFilterAndSql}`,
        )
        .get(...symParams) as { sym_bytes: number } | undefined;
      const resolvedSymBytes = Number(symRow?.sym_bytes ?? 0);
      counts.symlinkedBytes = resolvedSymBytes;
      counts.totalBytes += resolvedSymBytes;
    }

    return counts;
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
