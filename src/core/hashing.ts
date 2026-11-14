import fs from 'node:fs';
import { createXXHash128 } from 'hash-wasm';
import { AppConfig, HashStrategy } from './config';
import { buildLivePoolWhereClause, LivePoolFilter, withDatabase } from './database';
import { logger } from './logger';
import { extractPhysicalDriveLetter, formatDisplayPoolPath, getHslColorForBar } from './utils';

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
  onChunkRead?: (chunkBytes: number) => void,
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
      onChunkRead?.(bytesRead);
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
  onChunkRead?: (chunkBytes: number) => void,
): Promise<{ sparseHash: string; fullHash?: string; bytesRead: number }> {
  if (fileSize <= sampleSizeBytes * 3) {
    const { hash, bytesRead } = await computeStreamXxh128(
      fullPath,
      undefined,
      signal,
      pauseControl,
      onChunkRead,
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
        onChunkRead?.(bytesRead);
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
  onChunkRead?: (chunkBytes: number) => void,
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
        onChunkRead,
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
        onChunkRead,
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
      onChunkRead,
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

interface DriveBaseline {
  filesCompleted: number;
  bytesCompleted: number;
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
  baselineByDrive?: Record<string, DriveBaseline>,
  loggedFilePaths: Set<string> = new Set<string>(),
  workerLogIntervalMs: number = 5000,
): Promise<{ filesHashed: number; bytesHashed: number }> {
  const hasBaselineDrives = Boolean(baselineByDrive && Object.keys(baselineByDrive).length > 0);
  if (tasks.length === 0 && !hasBaselineDrives) {
    return { filesHashed: 0, bytesHashed: 0 };
  }

  const byDrive = new Map<string, HashTask[]>();
  for (const t of tasks) {
    const d = t.physical_drive || extractPhysicalDriveLetter(t.full_path) || 'OTHER';
    const arr = byDrive.get(d) ?? [];
    arr.push(t);
    byDrive.set(d, arr);
  }

  const allDrives = Array.from(
    new Set([...byDrive.keys(), ...Object.keys(baselineByDrive ?? {})]),
  ).sort((a, b) => a.localeCompare(b));

  const drivesProgress: Record<string, DriveHashProgress> = {};
  const sessionBytesByDrive: Record<string, number> = {};
  let totalFiles = 0;
  let completedFiles = 0;
  let totalBytes = 0;
  let completedBytes = 0;
  let sessionFilesHashed = 0;
  let sessionBytesHashed = 0;

  for (const drive of allDrives) {
    const driveTasks = byDrive.get(drive) ?? [];
    const baseFiles = baselineByDrive?.[drive]?.filesCompleted ?? 0;
    const baseBytes = baselineByDrive?.[drive]?.bytesCompleted ?? 0;
    const driveBytes = driveTasks.reduce(
      (acc, t) =>
        acc +
        (t.mode === 'sparse'
          ? Math.min(t.file_size, (t.sparseSampleSizeBytes ?? 1024 * 1024) * 3)
          : t.file_size),
      0,
    );
    totalFiles += baseFiles + driveTasks.length;
    completedFiles += baseFiles;
    totalBytes += baseBytes + driveBytes;
    completedBytes += baseBytes;
    sessionBytesByDrive[drive] = 0;
    drivesProgress[drive] = {
      drive,
      colorHsl: getHslColorForBar(drive),
      filesTotal: baseFiles + driveTasks.length,
      filesCompleted: baseFiles,
      bytesTotal: baseBytes + driveBytes,
      bytesCompleted: baseBytes,
      speedBytesPerSec: 0,
      currentFile: '',
      phase:
        driveTasks.length === 0
          ? 'done'
          : driveTasks[0]?.mode === 'sparse'
            ? 'sparse'
            : 'full',
    };
  }

  let pendingBatch: HashResult[] = [];
  let pendingBatchBytes = 0;
  let lastFlushTime = performance.now();
  let lastEmitTime = 0;

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
    lastEmitTime = performance.now();
    const aggregateSpeed = Object.values(drivesProgress).reduce(
      (sum, d) => sum + d.speedBytesPerSec,
      0,
    );
    const drivesSnapshot: Record<string, DriveHashProgress> = {};
    for (const [key, val] of Object.entries(drivesProgress)) {
      drivesSnapshot[key] = { ...val };
    }
    onProgress({
      strategy: config.hashStrategy,
      phase: phaseLabel,
      paused: Boolean(pauseControl?.isPaused?.()),
      drives: drivesSnapshot,
      totalFiles,
      completedFiles,
      totalBytes,
      completedBytes,
      aggregateSpeedBytesPerSec: aggregateSpeed,
    });
  };

  const emitProgressThrottled = () => {
    if (!onProgress) return;
    if (performance.now() - lastEmitTime >= 100) {
      emitProgress();
    }
  };

  emitProgress();

  const driveEntries = allDrives.map((d) => [d, byDrive.get(d) ?? []] as const);
  const startTimeByDrive: Record<string, number> = {};
  const pausedMsByDrive: Record<string, number> = {};
  const lastWorkerLogTimeByDrive: Record<string, number> = {};

  const maybeLogDriveCurrentFile = (drive: string, now: number = performance.now()) => {
    if (signal?.aborted || pauseControl?.isPaused?.()) return;
    const dp = drivesProgress[drive];
    if (!dp || dp.phase === 'done' || !dp.currentFile) return;
    const lastLog = lastWorkerLogTimeByDrive[drive] ?? 0;
    if (lastLog > 0 && now - lastLog < workerLogIntervalMs) return;
    const displayPath = formatDisplayPoolPath(dp.currentFile);
    if (loggedFilePaths.has(displayPath)) return;
    loggedFilePaths.add(displayPath);
    lastWorkerLogTimeByDrive[drive] = now;
    logger.info('Hashing', displayPath);
  };

  const workerLogTimer = setInterval(() => {
    const now = performance.now();
    for (const drive of allDrives) {
      maybeLogDriveCurrentFile(drive, now);
    }
  }, Math.max(10, workerLogIntervalMs));
  workerLogTimer.unref?.();

  try {
    await Promise.all(
      driveEntries.map(async ([drive, driveTasks]) => {
        if (driveTasks.length === 0) return;

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
          maybeLogDriveCurrentFile(drive);
          emitProgress();

          let inFlightBytes = 0;
          const res = await hashFileWorker(task, signal, drivePauseControl, (chunkBytes) => {
            inFlightBytes += chunkBytes;
            sessionBytesByDrive[drive] += chunkBytes;
            drivesProgress[drive].bytesCompleted += chunkBytes;
            completedBytes += chunkBytes;
            const activeMs =
              performance.now() - startTimeByDrive[drive] - pausedMsByDrive[drive];
            const elapsedSec = Math.max(0.001, activeMs / 1000);
            drivesProgress[drive].speedBytesPerSec = sessionBytesByDrive[drive] / elapsedSec;
            emitProgressThrottled();
          });
          if (signal?.aborted && res.status === 'error_hashing') {
            drivesProgress[drive].bytesCompleted -= inFlightBytes;
            sessionBytesByDrive[drive] -= inFlightBytes;
            completedBytes -= inFlightBytes;
            break;
          }

          const deltaBytes = res.bytesHashed - inFlightBytes;
          const dp = drivesProgress[drive];
          dp.bytesCompleted += deltaBytes;
          sessionBytesByDrive[drive] += deltaBytes;
          completedBytes += deltaBytes;

          pendingBatch.push(res);
          pendingBatchBytes += res.bytesHashed;
          completedFiles++;
          dp.filesCompleted++;
          sessionFilesHashed++;
          sessionBytesHashed += res.bytesHashed;

          const activeMs =
            performance.now() - startTimeByDrive[drive] - pausedMsByDrive[drive];
          const elapsedSec = Math.max(0.001, activeMs / 1000);
          dp.speedBytesPerSec = sessionBytesByDrive[drive] / elapsedSec;

          flushIfNeeded(false);
          emitProgress();
        }
        drivesProgress[drive].phase = 'done';
        drivesProgress[drive].currentFile = '';
        emitProgress();
      }),
    );
  } finally {
    clearInterval(workerLogTimer);
  }

  flushIfNeeded(true);
  return { filesHashed: sessionFilesHashed, bytesHashed: sessionBytesHashed };
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
    filter?: LivePoolFilter;
    onProgress?: (progress: MultiDriveHashProgress) => void;
    signal?: AbortSignal;
    isPaused?: () => boolean;
    waitIfPaused?: () => Promise<void>;
    workerLogIntervalMs?: number;
  } = {},
): Promise<{
  totalFilesHashed: number;
  totalBytesHashed: number;
  candidateCollisionsHashed: number;
}> {
  const loggedFilePaths = new Set<string>();
  const workerLogIntervalMs = options.workerLogIntervalMs ?? 5000;
  const pauseControl: HashPauseControl | undefined =
    options.isPaused || options.waitIfPaused
      ? { isPaused: options.isPaused, waitIfPaused: options.waitIfPaused }
      : undefined;
  const strategy = options.strategy ?? config.hashStrategy;
  const driveFilterSet = options.driveFilter
    ? new Set(options.driveFilter.map((d) => d.toUpperCase()))
    : null;
  const { clauses: filterClauses, params: filterParams } = buildLivePoolWhereClause(
    options.filter,
  );
  const filterAndSql =
    filterClauses.length > 0 ? `AND ${filterClauses.join(' AND ')}` : '';
  const { clauses: fFilterClauses, params: fFilterParams } = buildLivePoolWhereClause(
    options.filter,
    'f',
  );
  const fFilterAndSql =
    fFilterClauses.length > 0 ? `AND ${fFilterClauses.join(' AND ')}` : '';

  if (strategy === 'full_library') {
    const { tasks, baselineByDrive } = withDatabase(config.dbFilePath, (db) => {
      const baselineRows = db
        .prepare(
          `SELECT
             COALESCE(physical_drive, 'OTHER') AS drive,
             COUNT(*) AS hashedFiles,
             COALESCE(SUM(file_size), 0) AS hashedBytes
           FROM files
           WHERE is_symlink = 0
             AND file_size > 0
             AND xxh128_hash IS NOT NULL
             ${filterAndSql}
           GROUP BY COALESCE(physical_drive, 'OTHER')`,
        )
        .all(...filterParams) as Array<{
        drive: string;
        hashedFiles: number;
        hashedBytes: number;
      }>;

      const baselines: Record<string, DriveBaseline> = {};
      for (const row of baselineRows) {
        if (driveFilterSet && !driveFilterSet.has(row.drive.toUpperCase())) continue;
        baselines[row.drive] = {
          filesCompleted: Number(row.hashedFiles ?? 0),
          bytesCompleted: Number(row.hashedBytes ?? 0),
        };
      }

      const rows = db
        .prepare(
          `SELECT id, full_path, file_size, physical_drive
           FROM files
           WHERE is_symlink = 0
             AND file_size > 0
             AND xxh128_hash IS NULL
             AND status NOT LIKE 'error%'
             ${filterAndSql}
           ORDER BY file_size DESC`,
        )
        .all(...filterParams) as Array<{
        id: number;
        full_path: string;
        file_size: number;
        physical_drive: string | null;
      }>;

      const unhashedTasks = rows
        .map((r): HashTask => ({
          id: r.id,
          full_path: r.full_path,
          file_size: r.file_size,
          physical_drive: r.physical_drive ?? extractPhysicalDriveLetter(r.full_path) ?? 'OTHER',
          mode: 'full',
          sparseSampleSizeBytes: config.sparseSampleSizeBytes,
        }))
        .filter((t) => !driveFilterSet || driveFilterSet.has(t.physical_drive.toUpperCase()));

      return { tasks: unhashedTasks, baselineByDrive: baselines };
    });

    const { filesHashed, bytesHashed } = await executePerDriveTasks(
      config,
      tasks,
      'full_library',
      options.onProgress,
      options.signal,
      pauseControl,
      baselineByDrive,
      loggedFilePaths,
      workerLogIntervalMs,
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
           ${filterAndSql}
           AND file_size IN (
             SELECT file_size
             FROM files
             WHERE is_symlink = 0 AND file_size > 0
             GROUP BY file_size
             HAVING COUNT(DISTINCT scan_source) > 1 OR (file_size >= 10485760 AND COUNT(*) > 1)
           )
         ORDER BY file_size DESC`,
      )
      .all(...filterParams) as Array<{
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
    undefined,
    loggedFilePaths,
    workerLogIntervalMs,
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
           ${fFilterAndSql}
         ORDER BY f.file_size DESC`,
      )
      .all(...fFilterParams) as Array<{ id: number; physical_drive: string | null; full_path: string }>;

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
    undefined,
    loggedFilePaths,
    workerLogIntervalMs,
  );

  return {
    totalFilesHashed: sparseStats.filesHashed + fullStats.filesHashed,
    totalBytesHashed: sparseStats.bytesHashed + fullStats.bytesHashed,
    candidateCollisionsHashed: fullStats.filesHashed,
  };
}
