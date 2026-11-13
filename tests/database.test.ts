import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createDefaultConfig,
  getStatusCounts,
  initializeDatabase,
  loadPersistedSettings,
  savePersistedSettings,
  withDatabase,
} from '../src/core';

describe('database.ts', () => {
  let tempDir: string;
  let dbPath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-v3-db-test-'));
    dbPath = path.join(tempDir, 'test.sqlite');
    initializeDatabase(dbPath);
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('initializes tables with WAL mode and computes status counts, byte totals, and filters accurately', () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const oldSec = nowSec - 30 * 86400; // 30 days ago
    const recentSec = nowSec - 2 * 86400; // 2 days ago

    withDatabase(dbPath, (db) => {
      const modeRow = db.prepare('PRAGMA journal_mode;').get() as { journal_mode: string };
      expect(modeRow.journal_mode.toLowerCase()).toBe('wal');

      const stmt = db.prepare(`
        INSERT INTO files (
          full_path, filename, directory, scan_source, file_size, modified_date, status
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      stmt.run('D:\\Movies\\a.mkv', 'a.mkv', 'D:\\Movies', 'media', 1000, oldSec, 'new');
      stmt.run('D:\\Movies\\b.mkv', 'b.mkv', 'D:\\Movies', 'media', 2000, recentSec, 'sparse_hashed');
      stmt.run('D:\\TV\\c.mkv', 'c.mkv', 'D:\\TV', 'media', 3000, oldSec, 'hashed');
      stmt.run('D:\\Downloads\\d.mkv', 'd.mkv', 'D:\\Downloads', 'downloads', 4000, recentSec, 'duplicate_found');
      stmt.run('D:\\Downloads\\e.mkv', 'e.mkv', 'D:\\Downloads', 'downloads', 5000, recentSec, 'symlinked');
      stmt.run('D:\\Downloads\\f.mkv', 'f.mkv', 'D:\\Downloads', 'downloads', 6000, oldSec, 'error_hashing');
    });

    const counts = getStatusCounts(dbPath);
    expect(counts).toEqual({
      total: 6,
      new: 1,
      sparse_hashed: 1,
      hashed: 1,
      duplicate_found: 1,
      symlinked: 1,
      error: 1,
      totalBytes: 21000,
      newBytes: 1000,
      sparseHashedBytes: 2000,
      hashedBytes: 3000,
      duplicateFoundBytes: 4000,
      symlinkedBytes: 5000,
      errorBytes: 6000,
    });

    // Test minSizeBytes + maxSizeBytes filter
    const sizeFiltered = getStatusCounts(dbPath, { minSizeBytes: 2000, maxSizeBytes: 4000 });
    expect(sizeFiltered.total).toBe(3);
    expect(sizeFiltered.totalBytes).toBe(9000);

    // Test ageMode ('older' vs 'newer')
    const olderCounts = getStatusCounts(dbPath, { ageMode: 'older', ageDays: 10 });
    expect(olderCounts.total).toBe(3);
    expect(olderCounts.totalBytes).toBe(10000);

    const newerCounts = getStatusCounts(dbPath, { ageMode: 'newer', ageDays: 10 });
    expect(newerCounts.total).toBe(3);
    expect(newerCounts.totalBytes).toBe(11000);

    // Test textQuery filter
    const moviesOnly = getStatusCounts(dbPath, { textQuery: 'Movies' });
    expect(moviesOnly.total).toBe(2);
    expect(moviesOnly.totalBytes).toBe(3000);
  });

  it('persists and loads user configuration settings in SQLite', () => {
    const baseCfg = createDefaultConfig(tempDir);
    savePersistedSettings(dbPath, {
      symlinkTargetMode: 'physical',
      hashStrategy: 'full_library',
      hashingWorkers: 6,
    });

    const loaded = loadPersistedSettings(dbPath, baseCfg);
    expect(loaded.symlinkTargetMode).toBe('physical');
    expect(loaded.hashStrategy).toBe('full_library');
    expect(loaded.hashingWorkers).toBe(6);
    expect(loaded.virtualPoolRoot).toBe(baseCfg.virtualPoolRoot);
  });
});
