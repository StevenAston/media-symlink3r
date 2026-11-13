import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AppConfig,
  computeSparseHash,
  computeStreamXxh128,
  createDefaultConfig,
  getQuickHashChunkSize,
  hashFileWorker,
  hashSpecificFiles,
  hashUnHashedFilesPerDrive,
  initializeDatabase,
  runFileScan,
  withDatabase,
  writeHashesToDb,
} from '../src/core';

describe('hashing.ts', () => {
  let tempDir: string;
  let config: AppConfig;
  let poolPartD: string;
  let poolPartE: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-v3-hashing-test-'));
    poolPartD = path.join(tempDir, 'DriveD', 'PoolPart.bff64b92-d745-4ff9-933b-ae092c32cfc7');
    poolPartE = path.join(tempDir, 'DriveE', 'PoolPart.46e9a8f6-1019-4e8f-af54-ec2673cb3a28');
    fs.mkdirSync(path.join(poolPartD, 'Media'), { recursive: true });
    fs.mkdirSync(path.join(poolPartD, 'Downloads'), { recursive: true });
    fs.mkdirSync(path.join(poolPartE, 'Media'), { recursive: true });
    fs.mkdirSync(path.join(poolPartE, 'Downloads'), { recursive: true });

    config = {
      ...createDefaultConfig(tempDir),
      physicalDrivePaths: {
        D: poolPartD,
        E: poolPartE,
      },
      dbWriteThresholdFiles: 2,
      sparseSampleSizeBytes: 1024, // 1 KiB sample slices for fast unit tests
    };
    initializeDatabase(config.dbFilePath);
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('matches the exact legacy xxh128 test vector', async () => {
    const sampleFile = path.join(tempDir, 'vector.bin');
    fs.writeFileSync(sampleFile, Buffer.from('this is the test content'));

    const { hash, bytesRead } = await computeStreamXxh128(sampleFile);
    expect(bytesRead).toBe(24);
    expect(hash).toBe('a9743c380ea0f5ad410955782a16010e');
  });

  it('calculates tiered quick-hash chunk sizes accurately', () => {
    const mib = 1024 * 1024;
    expect(getQuickHashChunkSize(10 * mib, config)).toBe(10 * mib);
    expect(getQuickHashChunkSize(100 * mib, config)).toBe(32 * mib);
    expect(getQuickHashChunkSize(400 * mib, config)).toBe(64 * mib);
    expect(getQuickHashChunkSize(1500 * mib, config)).toBe(128 * mib);
    expect(getQuickHashChunkSize(5000 * mib, config)).toBe(256 * mib);
    expect(getQuickHashChunkSize(12000 * mib, config)).toBe(512 * mib);
  });

  it('computes single-pass sparse+full hash for small files and 3-point sample for larger files', async () => {
    const smallFile = path.join(tempDir, 'small.bin');
    fs.writeFileSync(smallFile, Buffer.from('this is the test content'));
    const smallRes = await computeSparseHash(smallFile, 24, 1024);
    expect(smallRes.sparseHash).toBe('a9743c380ea0f5ad410955782a16010e');
    expect(smallRes.fullHash).toBe('a9743c380ea0f5ad410955782a16010e');

    const largeFile1 = path.join(tempDir, 'large1.bin');
    const largeFile2 = path.join(tempDir, 'large2.bin');
    const buf1 = Buffer.alloc(10 * 1024, 'x');
    const buf2 = Buffer.alloc(10 * 1024, 'x');
    buf2[5 * 1024] = 0x42; // Mutate middle byte

    fs.writeFileSync(largeFile1, buf1);
    fs.writeFileSync(largeFile2, buf2);

    const sp1 = await computeSparseHash(largeFile1, buf1.length, 1024);
    const sp2 = await computeSparseHash(largeFile2, buf2.length, 1024);
    expect(sp1.fullHash).toBeUndefined();
    expect(sp1.bytesRead).toBe(3 * 1024);
    expect(sp1.sparseHash).not.toBe(sp2.sparseHash);
  });

  it('handles full, sparse, quick, and error cases in hashFileWorker and writeHashesToDb', async () => {
    const fPath = path.join(poolPartD, 'Media', 'Test.mkv');
    fs.writeFileSync(fPath, Buffer.from('this is the test content'));
    runFileScan(config, { useEverythingSdk: false });

    const fullRes = await hashFileWorker({
      id: 1,
      full_path: fPath,
      file_size: 24,
      physical_drive: 'D',
      mode: 'full',
    });
    expect(fullRes.status).toBe('hashed');
    expect(fullRes.xxh128_hash).toBe('a9743c380ea0f5ad410955782a16010e');

    const missingRes = await hashFileWorker({
      id: 999,
      full_path: path.join(tempDir, 'nonexistent.mkv'),
      file_size: 100,
      physical_drive: 'D',
      mode: 'full',
    });
    expect(missingRes.status).toBe('error_hashing');

    writeHashesToDb(config.dbFilePath, [fullRes]);
    withDatabase(config.dbFilePath, (db) => {
      const row = db.prepare('SELECT status, xxh128_hash FROM files WHERE id = 1').get() as {
        status: string;
        xxh128_hash: string;
      };
      expect(row.status).toBe('hashed');
      expect(row.xxh128_hash).toBe('a9743c380ea0f5ad410955782a16010e');
    });
  });

  it('runs smart_candidates strategy (skipping unique file sizes) and full_library strategy', async () => {
    const dupPayload = Buffer.alloc(8192, 'M');
    const uniquePayload = Buffer.alloc(5555, 'U');

    const mediaDup = path.join(poolPartD, 'Media', 'DupShow.mkv');
    const dlDup = path.join(poolPartE, 'Downloads', 'DupShow.mkv');
    const uniqueMedia = path.join(poolPartD, 'Media', 'UniqueShow.mkv');

    fs.writeFileSync(mediaDup, dupPayload);
    fs.writeFileSync(dlDup, dupPayload);
    fs.writeFileSync(uniqueMedia, uniquePayload);

    runFileScan(config, { useEverythingSdk: false });

    const smartStats = await hashUnHashedFilesPerDrive(config, {
      strategy: 'smart_candidates',
    });

    // Only the 2 size-matching files are hashed in smart_candidates mode; UniqueShow.mkv is skipped!
    expect(smartStats.candidateCollisionsHashed).toBe(2);

    withDatabase(config.dbFilePath, (db) => {
      const uniqueRow = db
        .prepare('SELECT status, xxh128_hash FROM files WHERE filename = ?')
        .get('UniqueShow.mkv') as { status: string; xxh128_hash: string | null };
      expect(uniqueRow.status).toBe('new');
      expect(uniqueRow.xxh128_hash).toBeNull();

      const dupRows = db
        .prepare('SELECT status, xxh128_hash FROM files WHERE filename = ?')
        .all('DupShow.mkv') as Array<{ status: string; xxh128_hash: string | null }>;
      expect(dupRows).toHaveLength(2);
      expect(dupRows[0].status).toBe('hashed');
      expect(dupRows[0].xxh128_hash).toBe(dupRows[1].xxh128_hash);
    });

    // Now run full_library mode to hash the remaining UniqueShow.mkv for the disaster recovery catalog
    const fullStats = await hashUnHashedFilesPerDrive(config, {
      strategy: 'full_library',
    });
    expect(fullStats.totalFilesHashed).toBe(1);

    withDatabase(config.dbFilePath, (db) => {
      const uniqueRowAfter = db
        .prepare('SELECT status, xxh128_hash FROM files WHERE filename = ?')
        .get('UniqueShow.mkv') as { status: string; xxh128_hash: string | null };
      expect(uniqueRowAfter.status).toBe('hashed');
      expect(uniqueRowAfter.xxh128_hash).toBeTruthy();
    });
  });

  it('supports hashSpecificFiles and AbortSignal cancellation', async () => {
    const f1 = path.join(poolPartD, 'Media', 'CancelTest.mkv');
    fs.writeFileSync(f1, Buffer.alloc(4096, 'Z'));
    runFileScan(config, { useEverythingSdk: false });

    const abortController = new AbortController();
    abortController.abort();

    const countAborted = await hashSpecificFiles(
      config,
      [1],
      undefined,
      abortController.signal,
    );
    expect(countAborted).toBe(0);

    const countCompleted = await hashSpecificFiles(config, [1]);
    expect(countCompleted).toBe(1);
  });

  it('supports in-place pause and resume while preserving exact xxh128 hashes', async () => {
    const payload = Buffer.alloc(600 * 1024, 'P');
    const f1 = path.join(poolPartD, 'Media', 'PauseMovie.mkv');
    fs.writeFileSync(f1, payload);
    runFileScan(config, { useEverythingSdk: false });

    const expected = await computeStreamXxh128(f1);

    let paused = true;
    let resumeFn: (() => void) | null = null;
    let enteredWait = false;
    const seenPausedStates: boolean[] = [];

    const hashPromise = hashUnHashedFilesPerDrive(config, {
      strategy: 'full_library',
      isPaused: () => paused,
      waitIfPaused: () =>
        new Promise<void>((resolve) => {
          if (!paused) {
            resolve();
            return;
          }
          enteredWait = true;
          resumeFn = () => {
            paused = false;
            resolve();
          };
        }),
      onProgress: (prog) => {
        seenPausedStates.push(Boolean(prog.paused));
      },
    });

    // Wait briefly until waitIfPaused is entered while paused
    for (let i = 0; i < 20 && !enteredWait; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(enteredWait).toBe(true);
    expect(seenPausedStates).toContain(true);

    // Resume and wait for completion
    resumeFn!();
    const res = await hashPromise;
    expect(res.totalFilesHashed).toBe(1);

    withDatabase(config.dbFilePath, (db) => {
      const row = db
        .prepare('SELECT status, xxh128_hash FROM files WHERE filename = ?')
        .get('PauseMovie.mkv') as { status: string; xxh128_hash: string };
      expect(row.status).toBe('hashed');
      expect(row.xxh128_hash).toBe(expected.hash);
    });
  });

  it('filters the live pool of files to be hashed using LivePoolFilter', async () => {
    const smallFile = path.join(poolPartD, 'Media', 'SmallClip.mkv');
    const matchMovie = path.join(poolPartD, 'Media', 'TargetMovie.mkv');
    const hugeSkip = path.join(poolPartD, 'Media', 'TooLarge.mkv');
    const wrongName = path.join(poolPartD, 'Media', 'OtherMovie.mkv');

    fs.writeFileSync(smallFile, Buffer.alloc(1000, 'A'));
    fs.writeFileSync(matchMovie, Buffer.alloc(5000, 'B'));
    fs.writeFileSync(hugeSkip, Buffer.alloc(9000, 'C'));
    fs.writeFileSync(wrongName, Buffer.alloc(5000, 'D'));

    runFileScan(config, { useEverythingSdk: false });

    const res = await hashUnHashedFilesPerDrive(config, {
      strategy: 'full_library',
      filter: {
        minSizeBytes: 2000,
        maxSizeBytes: 8000,
        textQuery: 'TargetMovie',
      },
    });

    expect(res.totalFilesHashed).toBe(1);

    withDatabase(config.dbFilePath, (db) => {
      const rows = db
        .prepare('SELECT filename, status, xxh128_hash FROM files ORDER BY filename ASC')
        .all() as Array<{ filename: string; status: string; xxh128_hash: string | null }>;

      const byName = new Map(rows.map((r) => [r.filename, r]));
      expect(byName.get('TargetMovie.mkv')?.status).toBe('hashed');
      expect(byName.get('TargetMovie.mkv')?.xxh128_hash).toBeTruthy();
      expect(byName.get('SmallClip.mkv')?.status).toBe('new');
      expect(byName.get('TooLarge.mkv')?.status).toBe('new');
      expect(byName.get('OtherMovie.mkv')?.status).toBe('new');
    });
  });
});
