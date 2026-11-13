import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AppConfig,
  createDefaultConfig,
  initializeDatabase,
  inspectSymlinkState,
  runFileScan,
  scanDirectory,
  withDatabase,
} from '../src/core';

describe('fileScanner.ts', () => {
  let tempDir: string;
  let config: AppConfig;
  let poolPartDir: string;
  let mediaDir: string;
  let downloadsDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-v3-scanner-test-'));
    poolPartDir = path.join(tempDir, 'PoolPart.bff64b92-d745-4ff9-933b-ae092c32cfc7');
    mediaDir = path.join(poolPartDir, 'Media');
    downloadsDir = path.join(poolPartDir, 'Downloads');
    fs.mkdirSync(mediaDir, { recursive: true });
    fs.mkdirSync(downloadsDir, { recursive: true });

    config = {
      ...createDefaultConfig(tempDir),
      physicalDrivePaths: { D: poolPartDir },
      virtualPoolRoot: path.join(tempDir, 'VirtualM'),
    };
    initializeDatabase(config.dbFilePath);
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('scans initial directory, filters by extension/size, and skips .bak files', () => {
    const file1 = path.join(mediaDir, 'Movie1.mkv');
    const file2 = path.join(mediaDir, 'Subtitle.srt');
    const fileBak = path.join(mediaDir, 'Movie1.mkv.bak');
    const smallFile = path.join(mediaDir, 'Tiny.mkv');

    fs.writeFileSync(file1, Buffer.alloc(2048, 'a'));
    fs.writeFileSync(file2, Buffer.alloc(512, 'b'));
    fs.writeFileSync(fileBak, Buffer.alloc(2048, 'c'));
    fs.writeFileSync(smallFile, Buffer.alloc(100, 'd'));

    const res = scanDirectory(config, mediaDir, 'media', {
      useEverythingSdk: false,
      extensions: ['.mkv'],
      minSizeBytes: 1024,
    });

    expect(res.filesDiscovered).toBe(1);
    expect(res.addedOrUpdated).toBe(1);

    withDatabase(config.dbFilePath, (db) => {
      const rows = db.prepare('SELECT filename, file_size, status FROM files').all() as Array<{
        filename: string;
        file_size: number;
        status: string;
      }>;
      expect(rows).toEqual([
        {
          filename: 'Movie1.mkv',
          file_size: 2048,
          status: 'new',
        },
      ]);
    });
  });

  it('preserves symlinked status on rescan, resets status when file changes, and prunes deleted files', () => {
    const mediaFile = path.join(mediaDir, 'Episode.mkv');
    const downloadFile = path.join(downloadsDir, 'Episode.mkv');
    const deletedFile = path.join(downloadsDir, 'Deleted.mkv');

    fs.writeFileSync(mediaFile, Buffer.from('episode-content-v1'));
    fs.writeFileSync(deletedFile, Buffer.from('will-be-deleted'));
    fs.symlinkSync(mediaFile, downloadFile, 'file');

    scanDirectory(config, mediaDir, 'media', { useEverythingSdk: false });
    scanDirectory(config, downloadsDir, 'downloads', { useEverythingSdk: false });

    withDatabase(config.dbFilePath, (db) => {
      const dlRow = db
        .prepare('SELECT is_symlink, status, symlink_target FROM files WHERE full_path = ?')
        .get(downloadFile) as {
        is_symlink: number;
        status: string;
        symlink_target: string | null;
      };
      expect(dlRow.is_symlink).toBe(1);
      expect(dlRow.status).toBe('symlinked');
      expect(dlRow.symlink_target?.toLowerCase()).toBe(mediaFile.toLowerCase());

      // Mark mediaFile as hashed
      db.prepare(`UPDATE files SET status = 'hashed', xxh128_hash = 'abc123' WHERE full_path = ?`).run(
        mediaFile,
      );
    });

    // Delete deletedFile and modify mediaFile size
    fs.unlinkSync(deletedFile);
    fs.writeFileSync(mediaFile, Buffer.from('episode-content-v2-longer-payload'));

    const resMedia = scanDirectory(config, mediaDir, 'media', {
      useEverythingSdk: false,
      pruneMissing: true,
    });
    const resDl = scanDirectory(config, downloadsDir, 'downloads', {
      useEverythingSdk: false,
      pruneMissing: true,
    });

    expect(resMedia.addedOrUpdated).toBe(1);
    expect(resDl.prunedMissing).toBe(1);

    withDatabase(config.dbFilePath, (db) => {
      const mRow = db
        .prepare('SELECT status, xxh128_hash FROM files WHERE full_path = ?')
        .get(mediaFile) as { status: string; xxh128_hash: string | null };
      // Changed size resets status to 'new' and clears stale hash
      expect(mRow.status).toBe('new');
      expect(mRow.xxh128_hash).toBeNull();

      const dlRow = db
        .prepare('SELECT is_symlink, status FROM files WHERE full_path = ?')
        .get(downloadFile) as { is_symlink: number; status: string };
      // Symlinked status is preserved!
      expect(dlRow.is_symlink).toBe(1);
      expect(dlRow.status).toBe('symlinked');

      const deletedRow = db
        .prepare('SELECT id FROM files WHERE full_path = ?')
        .get(deletedFile);
      expect(deletedRow).toBeUndefined();
    });
  });

  it('detects CoveFS 0-byte stub on physical PoolPart when virtual path is a symlink', () => {
    const physicalStub = path.join(downloadsDir, 'CoveFsStub.mkv');
    fs.writeFileSync(physicalStub, Buffer.alloc(0)); // 0-byte stub on physical PoolPart

    const virtualDownloadsDir = path.join(config.virtualPoolRoot, 'Downloads');
    fs.mkdirSync(virtualDownloadsDir, { recursive: true });
    const virtualLink = path.join(virtualDownloadsDir, 'CoveFsStub.mkv');
    const mediaTarget = path.join(mediaDir, 'RealTarget.mkv');
    fs.writeFileSync(mediaTarget, Buffer.from('real-media-bytes'));
    fs.symlinkSync(mediaTarget, virtualLink, 'file');

    const inspected = inspectSymlinkState(physicalStub, config.virtualPoolRoot);
    expect(inspected.isSymlink).toBe(true);
    expect(inspected.symlinkTarget?.toLowerCase()).toBe(mediaTarget.toLowerCase());
  });

  it('runs full pool scan across Media and Downloads via runFileScan', () => {
    fs.writeFileSync(path.join(mediaDir, 'M1.mkv'), Buffer.from('media-1'));
    fs.writeFileSync(path.join(downloadsDir, 'D1.mkv'), Buffer.from('dl-1'));

    const summary = runFileScan(config, { useEverythingSdk: false });
    expect(summary.totalDiscovered).toBe(2);
    expect(summary.totalAddedOrUpdated).toBe(2);
  });
});
