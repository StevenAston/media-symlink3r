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

  it('initializes tables with WAL mode and computes status counts accurately', () => {
    withDatabase(dbPath, (db) => {
      const modeRow = db.prepare('PRAGMA journal_mode;').get() as { journal_mode: string };
      expect(modeRow.journal_mode.toLowerCase()).toBe('wal');

      const stmt = db.prepare(`
        INSERT INTO files (
          full_path, filename, directory, scan_source, file_size, modified_date, status
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      stmt.run('D:\\a.mkv', 'a.mkv', 'D:\\', 'media', 1000, 100, 'new');
      stmt.run('D:\\b.mkv', 'b.mkv', 'D:\\', 'media', 2000, 100, 'sparse_hashed');
      stmt.run('D:\\c.mkv', 'c.mkv', 'D:\\', 'media', 3000, 100, 'hashed');
      stmt.run('D:\\d.mkv', 'd.mkv', 'D:\\', 'downloads', 3000, 100, 'duplicate_found');
      stmt.run('D:\\e.mkv', 'e.mkv', 'D:\\', 'downloads', 3000, 100, 'symlinked');
      stmt.run('D:\\f.mkv', 'f.mkv', 'D:\\', 'downloads', 3000, 100, 'error_hashing');
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
    });
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
