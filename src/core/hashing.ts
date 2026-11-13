import fs from 'node:fs';
import { createXXHash128 } from 'hash-wasm';
import { AppConfig, HashStrategy } from './config';
import { withDatabase } from './database';
import { extractPhysicalDriveLetter, getHslColorForBar } from './utils';

export type HashMode = 'full' | 'sparse' | 'quick';

export interface HashTask {
  id: number;
  full_path: string;
  file_size: number;
  physical_drive: string;
  mode: HashMode;
  chunkSizeBytes?: number;
  sparseSampleSizeBytes?: number;
}

export interface HashResult {
  id: number;
  mode: HashMode;
  status: 'hashed' | 'sparse_hashed' | 'quick_hashed' | 'error_hashing';
  xxh128_hash?: string | null;
  sparse_hash?: string | null;
  quick_hash?: string | null;
  bytesHashed: number;
  durationMs: number;
  errorMessage?: string | null;
}

export interface DriveHashProgress {
  drive: string;
  colorHsl: string;
  filesTotal: number;
  filesCompleted: number;
  bytesTotal: number;
  bytesCompleted: number;
  speedBytesPerSec: number;
  currentFile: string;
  phase: 'sparse' | 'full' | 'done';
}

export interface HashPauseControl {
  isPaused?: () => boolean;
  waitIfPaused?: () => Promise<void>;
}

export interface MultiDriveHashProgress {
  strategy: HashStrategy;
  phase: 'sparse_candidates' | 'full_candidates' | 'full_library' | 'completed';
  paused?: boolean;
  drives: Record<string, DriveHashProgress>;
  totalFiles: number;
  completedFiles: number;
  totalBytes: number;
  completedBytes: number;
  aggregateSpeedBytesPerSec: number;
}

const STREAM_BUFFER_SIZE = 256 * 1024; // 256 KiB

export function getQuickHashChunkSize(
  fileSize: number,
  config: Pick<AppConfig, 'quickHashRulesMiB' | 'defaultQuickHashSizeMiB'>,
): number {
  const sorted = [...config.quickHashRulesMiB].sort(
    (a, b) => a.maxFileSizeMiB - b.maxFileSizeMiB,
  );
  for (const rule of sorted) {
    if (fileSize <= rule.maxFileSizeMiB * 1024 * 1024) {
      return Math.min(fileSize, rule.quickHashSizeMiB * 1024 * 1024);
    }
  }
  return Math.min(fileSize, config.defaultQuickHashSizeMiB * 1024 * 1024);
}

/**
 * Computes a full or partial stream xxh128 hash up to maxBytesToRead (or full file if omitted).
 */
export async function computeStreamXxh128(
  fullPath: string,
  maxBytesToRead?: number,
  signal?: AbortSignal,
  pauseControl?: HashPauseControl,
): Promise<{ hash: string; bytesRead: number }> {
  const hasher = await createXXHash128();
  hasher.init();

  const fd = await fs.promises.open(fullPath, 'r');
  let bytesReadTotal = 0;
  try {
    const buf = Buffer.allocUnsafe(STREAM_BUFFER_SIZE);
    while (true) {
      if (signal?.aborted) {
        throw new Error('Hashing aborted');
      }
      if (pauseControl?.isPaused?.() && pauseControl.waitIfPaused) {
        await pauseControl.waitIfPaused();
        if (signal?.aborted) {
          throw new Error('Hashing aborted');
        }
      }
      const remaining =
        maxBytesToRead !== undefined ? maxBytesToRead - bytesReadTotal : STREAM_BUFFER_SIZE;
      if (remaining <= 0) break;

      const toRead = Math.min(STREAM_BUFFER_SIZE, remaining);
      const { bytesRead } = await fd.read(buf, 0, toRead, bytesReadTotal);
      if (bytesRead <= 0) break;

      hasher.update(buf.subarray(0, bytesRead));
      bytesReadTotal += bytesRead;
    }
  } finally {
    await fd.close();
  }

  return {
    hash: hasher.digest('hex'),
    bytesRead: bytesReadTotal,
  };
}

/**
 * Computes a 3-point sparse sample hash (head + middle + tail + fileSize header).
 * If fileSize <= sampleSizeBytes * 3, reads the entire file once and returns BOTH sparseHash and fullHash.
 */
export async function computeSparseHash(
  fullPath: string,
  fileSize: number,
  sampleSizeBytes: number = 1024 * 1024,
  signal?: AbortSignal,
  pauseControl?: HashPauseControl,
): Promise<{ sparseHash: string; fullHash?: string; bytesRead: number }> {
  if (fileSize <= sampleSizeBytes * 3) {
    const { hash, bytesRead } = await computeStreamXxh128(
      fullPath,
      undefined,
      signal,
      pauseControl,
    );
    return {
      sparseHash: hash,
      fullHash: hash,
      bytesRead,
    };
  }

  const hasher = await createXXHash128();
  hasher.init();

  // Mix file size into the sparse hash so different-sized files can never collide
  const sizeHeader = Buffer.allocUnsafe(8);
  sizeHeader.writeBigUInt64LE(BigInt(fileSize), 0);
  hasher.update(sizeHeader);

  const offsets = [
    0,
    Math.max(0, Math.floor(fileSize / 2) - Math.floor(sampleSizeBytes / 2)),
    Math.max(0, fileSize - sampleSizeBytes),
  ];

  const fd = await fs.promises.open(fullPath, 'r');
  let totalRead = 0;
  try {
    const buf = Buffer.allocUnsafe(sampleSizeBytes);
    for (const offset of offsets) {
      if (signal?.aborted) {
        throw new Error('Hashing aborted');
      }
      if (pauseControl?.isPaused?.() && pauseControl.waitIfPaused) {
        await pauseControl.waitIfPaused();
        if (signal?.aborted) {
          throw new Error('Hashing aborted');
        }
      }
      let sliceRead = 0;
      while (sliceRead < sampleSizeBytes) {
        const { bytesRead } = await fd.read(
          buf,
          sliceRead,
          sampleSizeBytes - sliceRead,
          offset + sliceRead,
        );
        if (bytesRead <= 0) break;
        sliceRead += bytesRead;
      }
      hasher.update(buf.subarray(0, sliceRead));
      totalRead += sliceRead;
    }
  } finally {
    await fd.close();
  }

  return {
    sparseHash: hasher.digest('hex'),
    bytesRead: totalRead,
  };
}

export async function hashFileWorker(
  task: HashTask,
  signal?: AbortSignal,
  pauseControl?: HashPauseControl,
): Promise<HashResult> {
  const start = performance.now();
  try {
    if (task.mode === 'sparse') {
      const sampleSize = task.sparseSampleSizeBytes ?? 1024 * 1024;
      const { sparseHash, fullHash, bytesRead } = await computeSparseHash(
        task.full_path,
        task.file_size,
        sampleSize,
        signal,
        pauseControl,
      );
      return {
        id: task.id,
        mode: 'sparse',
        status: fullHash ? 'hashed' : 'sparse_hashed',
        sparse_hash: sparseHash,
        xxh128_hash: fullHash ?? null,
        bytesHashed: bytesRead,
        durationMs: performance.now() - start,
      };
    }

    if (task.mode === 'quick') {
      const maxBytes = task.chunkSizeBytes ?? task.file_size;
      const { hash, bytesRead } = await computeStreamXxh128(
        task.full_path,
        maxBytes,
        signal,
        pauseControl,
      );
      const isFull = bytesRead >= task.file_size;
      return {
        id: task.id,
        mode: 'quick',
        status: isFull ? 'hashed' : 'quick_hashed',
        quick_hash: hash,
        xxh128_hash: isFull ? hash : null,
        bytesHashed: bytesRead,
        durationMs: performance.now() - start,
      };
    }

    // Default: full xxh128 hash
    const { hash, bytesRead } = await computeStreamXxh128(
      task.full_path,
      undefined,
      signal,
      pauseControl,
    );
    return {
      id: task.id,
      mode: 'full',
      status: 'hashed',
      xxh128_hash: hash,
      sparse_hash: task.sparseSampleSizeBytes && task.file_size <= task.sparseSampleSizeBytes * 3 ? hash : undefined,
      bytesHashed: bytesRead,
      durationMs: performance.now() - start,
    };
  } catch (err) {
    return {
      id: task.id,
      mode: task.mode,
      status: 'error_hashing',
      bytesHashed: 0,
      durationMs: performance.now() - start,
      errorMessage: (err as Error).message,
    };
  }
}

export function writeHashesToDb(dbFilePath: string, results: HashResult[]): number {
  if (results.length === 0) return 0;

  return withDatabase(dbFilePath, (db) => {
    const stmtFull = db.prepare(`
      UPDATE files
      SET xxh128_hash = ?,
          sparse_hash = COALESCE(?, sparse_hash),
          status = 'hashed',
          hash_date = unixepoch(),
          error_message = NULL
      WHERE id = ?
    `);

    const stmtSparse = db.prepare(`
      UPDATE files
      SET sparse_hash = ?,
          xxh128_hash = COALESCE(?, xxh128_hash),
          status = CASE WHEN ? IS NOT NULL THEN 'hashed' ELSE 'sparse_hashed' END,
          hash_date = unixepoch(),
          error_message = NULL
      WHERE id = ?
    `);

    const stmtQuick = db.prepare(`
      UPDATE files
      SET quick_hash = ?,
          xxh128_hash = COALESCE(?, xxh128_hash),
          status = CASE WHEN ? IS NOT NULL THEN 'hashed' ELSE 'quick_hashed' END,
          hash_date = unixepoch(),
          error_message = NULL
      WHERE id = ?
    `);

    const stmtError = db.prepare(`
      UPDATE files
      SET status = 'error_hashing',
          error_message = ?
      WHERE id = ?
    `);

    let updated = 0;
    db.exec('BEGIN IMMEDIATE TRANSACTION;');
    try {
      for (const r of results) {
        if (r.status === 'error_hashing') {
          stmtError.run(r.errorMessage ?? 'Unknown hashing error', r.id);
        } else if (r.mode === 'sparse') {
          stmtSparse.run(
            r.sparse_hash ?? null,
            r.xxh128_hash ?? null,
            r.xxh128_hash ?? null,
            r.id,
          );
        } else if (r.mode === 'quick') {
          stmtQuick.run(
            r.quick_hash ?? null,
            r.xxh128_hash ?? null,
            r.xxh128_hash ?? null,
            r.id,
          );
        } else {
          stmtFull.run(r.xxh128_hash ?? null, r.sparse_hash ?? null, r.id);
        }
        updated++;
      }
      db.exec('COMMIT;');
    } catch (err) {
      db.exec('ROLLBACK;');
      throw err;
    }
    return updated;
  });
}

/**
 * Runs tasks grouped by physical drive concurrently across drives (1 sequential worker per drive)
 * with threshold-based SQLite batch flushing.
 */
async function executePerDriveTasks(
  config: AppConfig,
  tasks: HashTask[],
  phaseLabel: MultiDriveHashProgress['phase'],
  onProgress?: (progress: MultiDriveHashProgress) => void,
  signal?: AbortSignal,
  pauseControl?: HashPauseControl,
): Promise<{ filesHashed: number; bytesHashed: number }> {
  if (tasks.length === 0) {
    return { filesHashed: 0, bytesHashed: 0 };
  }

  const byDrive = new Map<string, HashTask[]>();
  for (const t of tasks) {
    const d = t.physical_drive || extractPhysicalDriveLetter(t.full_path) || 'OTHER';
    const arr = byDrive.get(d) ?? [];
    arr.push(t);
    byDrive.set(d, arr);
  }

  const drivesProgress: Record<string, DriveHashProgress> = {};
  let totalFiles = 0;
  let totalBytes = 0;
  for (const [drive, driveTasks] of byDrive.entries()) {
    const driveBytes = driveTasks.reduce(
      (acc, t) =>
        acc +
        (t.mode === 'sparse'
          ? Math.min(t.file_size, (t.sparseSampleSizeBytes ?? 1024 * 1024) * 3)
          : t.file_size),
      0,
    );
    totalFiles += driveTasks.length;
    totalBytes += driveBytes;
    drivesProgress[drive] = {
      drive,
      colorHsl: getHslColorForBar(drive),
      filesTotal: driveTasks.length,
      filesCompleted: 0,
      bytesTotal: driveBytes,
      bytesCompleted: 0,
      speedBytesPerSec: 0,
      currentFile: '',
      phase: driveTasks[0]?.mode === 'sparse' ? 'sparse' : 'full',
    };
  }

  let completedFiles = 0;
  let completedBytes = 0;
  let pendingBatch: HashResult[] = [];
  let pendingBatchBytes = 0;
  let lastFlushTime = performance.now();

  const thresholdBytes = config.dbWriteThresholdGiB * 1024 * 1024 * 1024;
  const thresholdFiles = config.dbWriteThresholdFiles;
  const thresholdMs = config.dbWriteThresholdSeconds * 1000;

  const flushIfNeeded = (force: boolean = false) => {
    if (pendingBatch.length === 0) return;
    const elapsed = performance.now() - lastFlushTime;
    if (
      force ||
      pendingBatchBytes >= thresholdBytes ||
      pendingBatch.length >= thresholdFiles ||
      elapsed >= thresholdMs
    ) {
      const batchToWrite = pendingBatch;
      pendingBatch = [];
      pendingBatchBytes = 0;
      lastFlushTime = performance.now();
      writeHashesToDb(config.dbFilePath, batchToWrite);
    }
  };

  const emitProgress = () => {
    if (!onProgress) return;
    const aggregateSpeed = Object.values(drivesProgress).reduce(
      (sum, d) => sum + d.speedBytesPerSec,
      0,
    );
    onProgress({
      strategy: config.hashStrategy,
      phase: phaseLabel,
      paused: Boolean(pauseControl?.isPaused?.()),
      drives: { ...drivesProgress },
      totalFiles,
      completedFiles,
      totalBytes,
      completedBytes,
      aggregateSpeedBytesPerSec: aggregateSpeed,
    });
  };

  const driveEntries = Array.from(byDrive.entries());
  const startTimeByDrive: Record<string, number> = {};
  const pausedMsByDrive: Record<string, number> = {};

  await Promise.all(
    driveEntries.map(async ([drive, driveTasks]) => {
      startTimeByDrive[drive] = performance.now();
      pausedMsByDrive[drive] = 0;

      const drivePauseControl: HashPauseControl | undefined = pauseControl
        ? {
            isPaused: pauseControl.isPaused,
            waitIfPaused: async () => {
              if (!pauseControl.waitIfPaused) return;
              flushIfNeeded(true);
              emitProgress();
              const pauseStart = performance.now();
              await pauseControl.waitIfPaused();
              pausedMsByDrive[drive] += performance.now() - pauseStart;
              emitProgress();
            },
          }
        : undefined;

      for (const task of driveTasks) {
        if (signal?.aborted) break;
        if (drivePauseControl?.isPaused?.() && drivePauseControl.waitIfPaused) {
          await drivePauseControl.waitIfPaused();
          if (signal?.aborted) break;
        }
        drivesProgress[drive].currentFile = task.full_path;
        emitProgress();

        const res = await hashFileWorker(task, signal, drivePauseControl);
        if (signal?.aborted && res.status === 'error_hashing') {
          break;
        }

        pendingBatch.push(res);
        pendingBatchBytes += res.bytesHashed;
        completedFiles++;
        completedBytes += res.bytesHashed;

        const dp = drivesProgress[drive];
        dp.filesCompleted++;
        dp.bytesCompleted += res.bytesHashed;
        const activeMs =
          performance.now() - startTimeByDrive[drive] - pausedMsByDrive[drive];
        const elapsedSec = Math.max(0.001, activeMs / 1000);
        dp.speedBytesPerSec = dp.bytesCompleted / elapsedSec;

        flushIfNeeded(false);
        emitProgress();
      }
      drivesProgress[drive].phase = 'done';
      drivesProgress[drive].currentFile = '';
      emitProgress();
    }),
  );

  flushIfNeeded(true);
  return { filesHashed: completedFiles, bytesHashed: completedBytes };
}

/**
 * Hashes specific file IDs with full xxh128 (on-demand collision resolution).
 */
export async function hashSpecificFiles(
  config: AppConfig,
  fileIds: number[],
  onProgress?: (progress: MultiDriveHashProgress) => void,
  signal?: AbortSignal,
): Promise<number> {
  if (fileIds.length === 0) return 0;

  const tasks = withDatabase(config.dbFilePath, (db) => {
    const placeholders = fileIds.map(() => '?').join(',');
    const rows = db
      .prepare(
        `SELECT id, full_path, file_size, physical_drive
         FROM files
         WHERE id IN (${placeholders}) AND is_symlink = 0`,
      )
      .all(...fileIds) as Array<{
      id: number;
      full_path: string;
      file_size: number;
      physical_drive: string | null;
    }>;

    return rows.map(
      (r): HashTask => ({
        id: r.id,
        full_path: r.full_path,
        file_size: r.file_size,
        physical_drive: r.physical_drive ?? extractPhysicalDriveLetter(r.full_path) ?? 'OTHER',
        mode: 'full',
        sparseSampleSizeBytes: config.sparseSampleSizeBytes,
      }),
    );
  });

  const { filesHashed } = await executePerDriveTasks(
    config,
    tasks,
    'full_candidates',
    onProgress,
    signal,
  );
  return filesHashed;
}

/**
 * Main per-drive hashing orchestrator supporting both:
 *  - 'smart_candidates': Size-Intersection -> 3-point Sparse Hash -> Full xxh128 Hash on collisions
 *  - 'full_library': Full xxh128 Hash on all unhashed non-symlink files (for disaster recovery catalog + dedup)
 */
export async function hashUnHashedFilesPerDrive(
  config: AppConfig,
  options: {
    strategy?: HashStrategy;
    driveFilter?: string[];
    onProgress?: (progress: MultiDriveHashProgress) => void;
    signal?: AbortSignal;
    isPaused?: () => boolean;
    waitIfPaused?: () => Promise<void>;
  } = {},
): Promise<{
  totalFilesHashed: number;
  totalBytesHashed: number;
  candidateCollisionsHashed: number;
}> {
  const pauseControl: HashPauseControl | undefined =
    options.isPaused || options.waitIfPaused
      ? { isPaused: options.isPaused, waitIfPaused: options.waitIfPaused }
      : undefined;
  const strategy = options.strategy ?? config.hashStrategy;
  const driveFilterSet = options.driveFilter
    ? new Set(options.driveFilter.map((d) => d.toUpperCase()))
    : null;

  if (strategy === 'full_library') {
    const tasks = withDatabase(config.dbFilePath, (db) => {
      const rows = db
        .prepare(
          `SELECT id, full_path, file_size, physical_drive
           FROM files
           WHERE is_symlink = 0
             AND file_size > 0
             AND xxh128_hash IS NULL
             AND status NOT LIKE 'error%'
           ORDER BY file_size DESC`,
        )
        .all() as Array<{
        id: number;
        full_path: string;
        file_size: number;
        physical_drive: string | null;
      }>;

      return rows
        .map((r): HashTask => ({
          id: r.id,
          full_path: r.full_path,
          file_size: r.file_size,
          physical_drive: r.physical_drive ?? extractPhysicalDriveLetter(r.full_path) ?? 'OTHER',
          mode: 'full',
          sparseSampleSizeBytes: config.sparseSampleSizeBytes,
        }))
        .filter((t) => !driveFilterSet || driveFilterSet.has(t.physical_drive.toUpperCase()));
    });

    const { filesHashed, bytesHashed } = await executePerDriveTasks(
      config,
      tasks,
      'full_library',
      options.onProgress,
      options.signal,
      pauseControl,
    );

    return {
      totalFilesHashed: filesHashed,
      totalBytesHashed: bytesHashed,
      candidateCollisionsHashed: 0,
    };
  }

  // Smart Candidates Strategy:
  // Step 1: Find all non-symlink files with file_size > 0 whose byte size appears >= 2 times across files,
  // and which don't yet have sparse_hash or xxh128_hash.
  const sparseTasks = withDatabase(config.dbFilePath, (db) => {
    const rows = db
      .prepare(
        `SELECT id, full_path, file_size, physical_drive
         FROM files
         WHERE is_symlink = 0
           AND file_size > 0
           AND sparse_hash IS NULL
           AND xxh128_hash IS NULL
           AND status NOT LIKE 'error%'
           AND file_size IN (
             SELECT file_size
             FROM files
             WHERE is_symlink = 0 AND file_size > 0
             GROUP BY file_size
             HAVING COUNT(DISTINCT scan_source) > 1 OR (file_size >= 10485760 AND COUNT(*) > 1)
           )
         ORDER BY file_size DESC`,
      )
      .all() as Array<{
      id: number;
      full_path: string;
      file_size: number;
      physical_drive: string | null;
    }>;

    return rows
      .map((r): HashTask => ({
        id: r.id,
        full_path: r.full_path,
        file_size: r.file_size,
        physical_drive: r.physical_drive ?? extractPhysicalDriveLetter(r.full_path) ?? 'OTHER',
        mode: 'sparse',
        sparseSampleSizeBytes: config.sparseSampleSizeBytes,
      }))
      .filter((t) => !driveFilterSet || driveFilterSet.has(t.physical_drive.toUpperCase()));
  });

  const sparseStats = await executePerDriveTasks(
    config,
    sparseTasks,
    'sparse_candidates',
    options.onProgress,
    options.signal,
    pauseControl,
  );

  if (options.signal?.aborted) {
    return {
      totalFilesHashed: sparseStats.filesHashed,
      totalBytesHashed: sparseStats.bytesHashed,
      candidateCollisionsHashed: 0,
    };
  }

  // Step 2: Find all files that share (file_size, sparse_hash) with at least one other file
  // and still need full xxh128_hash.
  const collisionIds = withDatabase(config.dbFilePath, (db) => {
    const rows = db
      .prepare(
        `SELECT f.id, f.physical_drive, f.full_path
         FROM files f
         INNER JOIN (
           SELECT file_size, sparse_hash
           FROM files
           WHERE is_symlink = 0
             AND file_size > 0
             AND sparse_hash IS NOT NULL
           GROUP BY file_size, sparse_hash
           HAVING COUNT(*) > 1
         ) c ON f.file_size = c.file_size AND f.sparse_hash = c.sparse_hash
         WHERE f.is_symlink = 0
           AND f.xxh128_hash IS NULL
           AND f.file_size <= 67108864
           AND f.status NOT LIKE 'error%'
         ORDER BY f.file_size DESC`,
      )
      .all() as Array<{ id: number; physical_drive: string | null; full_path: string }>;

    return rows
      .filter((r) => {
        if (!driveFilterSet) return true;
        const d = r.physical_drive ?? extractPhysicalDriveLetter(r.full_path) ?? 'OTHER';
        return driveFilterSet.has(d.toUpperCase());
      })
      .map((r) => r.id);
  });

  const fullTasks = withDatabase(config.dbFilePath, (db) => {
    if (collisionIds.length === 0) return [];
    const placeholders = collisionIds.map(() => '?').join(',');
    const rows = db
      .prepare(
        `SELECT id, full_path, file_size, physical_drive
         FROM files
         WHERE id IN (${placeholders})`,
      )
      .all(...collisionIds) as Array<{
      id: number;
      full_path: string;
      file_size: number;
      physical_drive: string | null;
    }>;

    return rows.map(
      (r): HashTask => ({
        id: r.id,
        full_path: r.full_path,
        file_size: r.file_size,
        physical_drive: r.physical_drive ?? extractPhysicalDriveLetter(r.full_path) ?? 'OTHER',
        mode: 'full',
        sparseSampleSizeBytes: config.sparseSampleSizeBytes,
      }),
    );
  });

  const fullStats = await executePerDriveTasks(
    config,
    fullTasks,
    'full_candidates',
    options.onProgress,
    options.signal,
    pauseControl,
  );

  return {
    totalFilesHashed: sparseStats.filesHashed + fullStats.filesHashed,
    totalBytesHashed: sparseStats.bytesHashed + fullStats.bytesHashed,
    candidateCollisionsHashed: fullStats.filesHashed,
  };
}
