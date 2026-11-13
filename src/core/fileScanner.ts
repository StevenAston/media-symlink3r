import fs from 'node:fs';
import path from 'node:path';
import { AppConfig } from './config';
import { withDatabase } from './database';
import { logger } from './logger';
import {
  extractPhysicalDriveLetter,
  normalizeWinPath,
  physicalToVirtualPath,
} from './utils';

export interface ScannedFileEntry {
  full_path: string;
  file_size: number;
  modified_date: number;
  is_symlink: boolean;
  symlink_target?: string | null;
}

export interface ScanOptions {
  useEverythingSdk?: boolean;
  minSize?: number | null;
  minSizeBytes?: number | null;
  maxSize?: number | null;
  maxSizeBytes?: number | null;
  extensions?: string[] | null;
  pruneDeleted?: boolean;
  pruneMissing?: boolean;
  iteratorOverride?: (
    searchPath: string,
    extensions?: string[] | null,
  ) => Iterable<ScannedFileEntry>;
}

export interface ScanSummary {
  scannedCount: number;
  filesDiscovered: number;
  totalDiscovered: number;
  upsertedCount: number;
  addedOrUpdated: number;
  totalAddedOrUpdated: number;
  skippedBySize: number;
  skippedBakCount: number;
  prunedCount: number;
  prunedMissing: number;
  totalPruned: number;
}

export interface DriveScanProgress {
  driveLetter: string;
  scanSource: 'media' | 'downloads';
  folderIndex: number;
  totalFolders: number;
  searchPath: string;
  status: 'scanning' | 'completed';
  filesFound: number;
  elapsedMs: number;
}

const EVERYTHING_REQUEST_FILE_NAME = 0x00000001;
const EVERYTHING_REQUEST_PATH = 0x00000002;
const EVERYTHING_REQUEST_SIZE = 0x00000010;
const EVERYTHING_REQUEST_DATE_MODIFIED = 0x00000080;
const EVERYTHING_REQUEST_ATTRIBUTES = 0x00000400;
const FILE_ATTRIBUTE_REPARSE_POINT = 0x0400;
const WINDOWS_TICK = 10000000n;
const SEC_TO_UNIX_EPOCH = 116444736000000000n;

function resolveReadlinkTarget(linkPath: string, rawTarget: string): string {
  const cleaned = rawTarget.replace(/^\\\\\?\\/, '');
  return path.win32.isAbsolute(cleaned)
    ? normalizeWinPath(cleaned)
    : normalizeWinPath(path.win32.resolve(path.win32.dirname(linkPath), cleaned));
}

/**
 * Safely inspects whether a path (or its virtual DrivePool counterpart) is a symlink and reads its target.
 * Fast-paths NTFS reparse points so normal symlinks don't trigger redundant M:\ CoveFS lstat calls.
 */
export function inspectSymlinkState(
  fullPath: string,
  virtualPathOrPoolRoot?: string | null,
  attrHint?: number,
): { isSymlink: boolean; target: string | null; symlinkTarget: string | null } {
  // Fast path when Everything SDK already reported FILE_ATTRIBUTE_REPARSE_POINT
  if (attrHint !== undefined && (attrHint & FILE_ATTRIBUTE_REPARSE_POINT) !== 0) {
    try {
      const raw = fs.readlinkSync(fullPath);
      const target = resolveReadlinkTarget(fullPath, raw);
      return { isSymlink: true, target, symlinkTarget: target };
    } catch {
      return { isSymlink: true, target: null, symlinkTarget: null };
    }
  }

  let virtualPath: string | null = null;
  if (virtualPathOrPoolRoot) {
    const derived = physicalToVirtualPath(fullPath, virtualPathOrPoolRoot);
    virtualPath = derived ?? virtualPathOrPoolRoot;
  }

  try {
    const lstat = fs.lstatSync(fullPath);
    if (lstat.isSymbolicLink()) {
      let target: string | null = null;
      try {
        const raw = fs.readlinkSync(fullPath);
        target = resolveReadlinkTarget(fullPath, raw);
      } catch {
        target = null;
      }
      return { isSymlink: true, target, symlinkTarget: target };
    }

    // Check if it's a 0-byte CoveFS virtual symlink stub on the PoolPart drive
    if (lstat.size === 0 && virtualPath && virtualPath !== fullPath) {
      try {
        const vStat = fs.lstatSync(virtualPath);
        if (vStat.isSymbolicLink()) {
          const vRaw = fs.readlinkSync(virtualPath);
          const vTarget = resolveReadlinkTarget(virtualPath, vRaw);
          return { isSymlink: true, target: vTarget, symlinkTarget: vTarget };
        }
      } catch {
        // Not a virtual symlink
      }
    }
  } catch {
    // Ignore inaccessible file
  }
  return { isSymlink: false, target: null, symlinkTarget: null };
}

/**
 * Queries Everything64.dll via koffi FFI if available and Everything IPC is running.
 * Automatically tries both default instance ("") and Everything 1.5a ("1.5a") if needed.
 */
export function queryEverythingSdk(
  searchPath: string,
  extensions?: string[] | null,
  virtualPoolRoot = 'M:\\',
): ScannedFileEntry[] | null {
  const dllCandidates = [
    'C:\\Program Files\\Everything\\Everything64.dll',
    'C:\\Software\\Everything\\Everything64.dll',
    'C:\\Program Files (x86)\\Everything\\Everything32.dll',
  ];
  const dllPath = dllCandidates.find((p) => fs.existsSync(p));
  if (!dllPath) return null;

  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const koffi = require('koffi');
    const lib = koffi.load(dllPath);

    const Everything_SetInstanceNameW = lib.func(
      'void __stdcall Everything_SetInstanceNameW(str16)',
    );
    const Everything_SetSearchW = lib.func('void __stdcall Everything_SetSearchW(str16)');
    const Everything_SetRequestFlags = lib.func(
      'void __stdcall Everything_SetRequestFlags(uint32)',
    );
    const Everything_QueryW = lib.func('bool __stdcall Everything_QueryW(bool)');
    const Everything_GetLastError = lib.func('uint32 __stdcall Everything_GetLastError()');
    const Everything_GetNumResults = lib.func('uint32 __stdcall Everything_GetNumResults()');
    const Everything_GetResultPathW = lib.func(
      'str16 __stdcall Everything_GetResultPathW(uint32)',
    );
    const Everything_GetResultFileNameW = lib.func(
      'str16 __stdcall Everything_GetResultFileNameW(uint32)',
    );
    const Everything_GetResultSize = lib.func(
      'bool __stdcall Everything_GetResultSize(uint32, _Out_ int64 *)',
    );
    const Everything_GetResultDateModified = lib.func(
      'bool __stdcall Everything_GetResultDateModified(uint32, _Out_ int64 *)',
    );
    const Everything_GetResultAttributes = lib.func(
      'uint32 __stdcall Everything_GetResultAttributes(uint32)',
    );

    const normalizedPath = normalizeWinPath(searchPath);
    const flags =
      EVERYTHING_REQUEST_PATH |
      EVERYTHING_REQUEST_FILE_NAME |
      EVERYTHING_REQUEST_SIZE |
      EVERYTHING_REQUEST_DATE_MODIFIED |
      EVERYTHING_REQUEST_ATTRIBUTES;

    let searchQuery = `file: path:"${normalizedPath}"`;
    if (extensions && extensions.length > 0) {
      const cleaned = extensions
        .map((e) => e.trim().replace(/^\./, '').toLowerCase())
        .filter(Boolean);
      if (cleaned.length > 0) {
        searchQuery += ` ext:${cleaned.join(';')}`;
      }
    }

    Everything_SetInstanceNameW('');
    Everything_SetRequestFlags(flags);
    Everything_SetSearchW(searchQuery);

    let ok: boolean = Everything_QueryW(true);
    if (!ok && Everything_GetLastError() === 2) {
      // Try Everything 1.5a named instance
      Everything_SetInstanceNameW('1.5a');
      Everything_SetRequestFlags(flags);
      Everything_SetSearchW(searchQuery);
      ok = Everything_QueryW(true);
    }

    if (!ok) {
      const errCode = Everything_GetLastError();
      logger.warn(
        'EverythingSDK',
        `Query failed for ${normalizedPath} (errorCode=${errCode}); falling back to native directory walk.`,
      );
      return null;
    }

    const numResults: number = Everything_GetNumResults();
    const results: ScannedFileEntry[] = [];
    const sizeOut: [bigint] = [0n];
    const dateOut: [bigint] = [0n];

    for (let i = 0; i < numResults; i++) {
      const dirPart: string = Everything_GetResultPathW(i);
      const filePart: string = Everything_GetResultFileNameW(i);
      if (!dirPart || !filePart) continue;

      const fullPath = path.win32.join(dirPart, filePart);
      Everything_GetResultSize(i, sizeOut);
      Everything_GetResultDateModified(i, dateOut);
      const attrs: number = Everything_GetResultAttributes(i);

      const fileSize = Number(sizeOut[0] >= 0n ? sizeOut[0] : 0n);
      const ft = BigInt(dateOut[0]);
      const unixTimestamp =
        ft > SEC_TO_UNIX_EPOCH ? Number((ft - SEC_TO_UNIX_EPOCH) / WINDOWS_TICK) : 0;

      const isReparseAttr = (attrs & FILE_ATTRIBUTE_REPARSE_POINT) !== 0;
      let isSymlink = isReparseAttr;
      let symlinkTarget: string | null = null;

      if (isReparseAttr || fileSize === 0) {
        const inspected = inspectSymlinkState(fullPath, virtualPoolRoot, attrs);
        isSymlink = inspected.isSymlink;
        symlinkTarget = inspected.target;
      }

      results.push({
        full_path: fullPath,
        file_size: fileSize,
        modified_date: unixTimestamp,
        is_symlink: isSymlink,
        symlink_target: symlinkTarget,
      });
    }

    return results;
  } catch (err) {
    logger.warn('EverythingSDK', `Exception loading Everything64.dll: ${(err as Error).message}`);
    return null;
  }
}

/**
 * Native recursive directory walker used when Everything SDK is disabled or unavailable.
 */
export function scanDirectoryNativeWalk(
  searchPath: string,
  extensions?: string[] | null,
  virtualPoolRoot = 'M:\\',
): ScannedFileEntry[] {
  const results: ScannedFileEntry[] = [];
  if (!fs.existsSync(searchPath)) return results;

  const allowedExts =
    extensions && extensions.length > 0
      ? new Set(
          extensions.map((e) => e.trim().replace(/^\./, '').toLowerCase()).filter(Boolean),
        )
      : null;

  const stack: string[] = [searchPath];
  while (stack.length > 0) {
    const currentDir = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (
        entry.name === '.covefs' ||
        entry.name === '$RECYCLE.BIN' ||
        entry.name === 'System Volume Information'
      ) {
        continue;
      }
      const fullPath = path.join(currentDir, entry.name);
      try {
        if (entry.isDirectory() && !entry.isSymbolicLink()) {
          stack.push(fullPath);
          continue;
        }
        if (!entry.isFile() && !entry.isSymbolicLink()) {
          continue;
        }

        if (allowedExts) {
          const ext = path.extname(entry.name).replace(/^\./, '').toLowerCase();
          if (!allowedExts.has(ext)) continue;
        }

        const lstat = fs.lstatSync(fullPath);
        let isSymlink = lstat.isSymbolicLink();
        let target: string | null = null;

        if (isSymlink) {
          try {
            target = resolveReadlinkTarget(fullPath, fs.readlinkSync(fullPath));
          } catch {
            target = null;
          }
        } else if (lstat.size === 0) {
          const inspected = inspectSymlinkState(fullPath, virtualPoolRoot);
          isSymlink = inspected.isSymlink;
          target = inspected.target;
        }

        results.push({
          full_path: fullPath,
          file_size: isSymlink ? 0 : lstat.size,
          modified_date: lstat.mtimeMs / 1000,
          is_symlink: isSymlink,
          symlink_target: target,
        });
      } catch {
        // Skip unreadable entry
      }
    }
  }

  return results;
}

/**
 * Scans a single directory and upserts matching files into SQLite.
 */
export function scanDirectory(
  config: AppConfig,
  searchPath: string,
  scanSource: 'media' | 'downloads',
  physicalDriveOrOptions?: string | ScanOptions,
  maybeOptions?: ScanOptions,
): ScanSummary {
  const t0 = Date.now();
  const physicalDrive =
    typeof physicalDriveOrOptions === 'string'
      ? physicalDriveOrOptions
      : (extractPhysicalDriveLetter(searchPath) ?? 'OTHER');
  const options: ScanOptions =
    typeof physicalDriveOrOptions === 'object' && physicalDriveOrOptions !== null
      ? physicalDriveOrOptions
      : (maybeOptions ?? {});

  const useEverythingSdk = options.useEverythingSdk ?? true;
  const minSize = options.minSizeBytes ?? options.minSize ?? null;
  const maxSize = options.maxSizeBytes ?? options.maxSize ?? null;
  const extensions = options.extensions ?? null;
  const pruneDeleted = options.pruneMissing ?? options.pruneDeleted ?? false;

  logger.info(
    'Scanner',
    `Scanning [${physicalDrive}:/${scanSource}] ${searchPath} (${useEverythingSdk ? 'Everything SDK' : 'Native Walk'})...`,
  );

  let rawEntries: Iterable<ScannedFileEntry>;
  let usedMethod = 'Native Walk';
  if (options.iteratorOverride) {
    rawEntries = options.iteratorOverride(searchPath, extensions);
    usedMethod = 'Custom Iterator';
  } else if (useEverythingSdk) {
    const sdkEntries = queryEverythingSdk(searchPath, extensions, config.virtualPoolRoot);
    if (sdkEntries !== null) {
      rawEntries = sdkEntries;
      usedMethod = 'Everything SDK';
    } else {
      rawEntries = scanDirectoryNativeWalk(searchPath, extensions, config.virtualPoolRoot);
    }
  } else {
    rawEntries = scanDirectoryNativeWalk(searchPath, extensions, config.virtualPoolRoot);
  }

  let scannedCount = 0;
  let upsertedCount = 0;
  let skippedBySize = 0;
  let skippedBakCount = 0;
  let prunedCount = 0;

  const rowsToUpsert: Array<{
    full_path: string;
    virtual_path: string | null;
    physical_drive: string;
    filename: string;
    directory: string;
    scan_source: 'media' | 'downloads';
    file_size: number;
    modified_date: number;
    is_symlink: number;
    symlink_target: string | null;
  }> = [];

  const seenPaths = new Set<string>();
  const bakSuffixLower = (config.backupSuffix || '.bak').toLowerCase();

  for (const r of rawEntries) {
    scannedCount++;
    const fullPath = normalizeWinPath(r.full_path);
    const filename = path.win32.basename(fullPath);

    if (filename.toLowerCase().endsWith(bakSuffixLower)) {
      skippedBakCount++;
      continue;
    }

    if (!r.is_symlink) {
      if (minSize !== null && r.file_size < minSize) {
        skippedBySize++;
        continue;
      }
      if (maxSize !== null && r.file_size > maxSize) {
        skippedBySize++;
        continue;
      }
    }

    const directory = path.win32.dirname(fullPath);
    const virtualPath = physicalToVirtualPath(fullPath, config.virtualPoolRoot);

    seenPaths.add(fullPath.toLowerCase());
    rowsToUpsert.push({
      full_path: fullPath,
      virtual_path: virtualPath,
      physical_drive: physicalDrive,
      filename,
      directory,
      scan_source: scanSource,
      file_size: r.file_size,
      modified_date: r.modified_date,
      is_symlink: r.is_symlink ? 1 : 0,
      symlink_target: r.symlink_target ?? null,
    });
  }

  withDatabase(config.dbFilePath, (db) => {
    db.exec('BEGIN IMMEDIATE TRANSACTION;');
    try {
      const upsertStmt = db.prepare(`
        INSERT INTO files (
          full_path, virtual_path, physical_drive, filename, directory,
          scan_source, file_size, modified_date, is_symlink, symlink_target, status
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CASE WHEN ? = 1 THEN 'symlinked' ELSE 'new' END)
        ON CONFLICT(full_path) DO UPDATE SET
          virtual_path = excluded.virtual_path,
          physical_drive = excluded.physical_drive,
          file_size = excluded.file_size,
          modified_date = excluded.modified_date,
          is_symlink = excluded.is_symlink,
          symlink_target = COALESCE(excluded.symlink_target, files.symlink_target),
          status = CASE
            WHEN excluded.is_symlink = 1 OR files.status = 'symlinked' THEN 'symlinked'
            WHEN files.file_size != excluded.file_size OR ABS(files.modified_date - excluded.modified_date) > 0.001 THEN 'new'
            ELSE files.status
          END,
          xxh128_hash = CASE
            WHEN excluded.is_symlink = 1 THEN files.xxh128_hash
            WHEN files.file_size != excluded.file_size OR ABS(files.modified_date - excluded.modified_date) > 0.001 THEN NULL
            ELSE files.xxh128_hash
          END,
          sparse_hash = CASE
            WHEN excluded.is_symlink = 1 THEN files.sparse_hash
            WHEN files.file_size != excluded.file_size OR ABS(files.modified_date - excluded.modified_date) > 0.001 THEN NULL
            ELSE files.sparse_hash
          END
      `);

      for (const row of rowsToUpsert) {
        upsertStmt.run(
          row.full_path,
          row.virtual_path,
          row.physical_drive,
          row.filename,
          row.directory,
          row.scan_source,
          row.file_size,
          row.modified_date,
          row.is_symlink,
          row.symlink_target,
          row.is_symlink,
        );
        upsertedCount++;
      }

      if (
        pruneDeleted &&
        minSize === null &&
        maxSize === null &&
        (!extensions || extensions.length === 0)
      ) {
        const prefix = (normalizeWinPath(searchPath) + '\\').toLowerCase();
        const existingRows = db
          .prepare('SELECT id, full_path FROM files WHERE scan_source = ?')
          .all(scanSource) as Array<{ id: number; full_path: string }>;
        const delStmt = db.prepare('DELETE FROM files WHERE id = ?');
        for (const ex of existingRows) {
          const normEx = normalizeWinPath(ex.full_path).toLowerCase();
          if (normEx.startsWith(prefix) && !seenPaths.has(normEx)) {
            delStmt.run(ex.id);
            prunedCount++;
          }
        }
      }

      db.exec('COMMIT;');
    } catch (err) {
      db.exec('ROLLBACK;');
      throw err;
    }
  });

  const elapsedMs = Date.now() - t0;
  logger.success(
    'Scanner',
    `Completed [${physicalDrive}:/${scanSource}] via ${usedMethod} in ${elapsedMs}ms — ${upsertedCount.toLocaleString()} indexed (${skippedBakCount} .bak skipped, ${prunedCount} pruned).`,
  );

  const discovered = rowsToUpsert.length;
  return {
    scannedCount,
    filesDiscovered: discovered,
    totalDiscovered: discovered,
    upsertedCount,
    addedOrUpdated: upsertedCount,
    totalAddedOrUpdated: upsertedCount,
    skippedBySize,
    skippedBakCount,
    prunedCount,
    prunedMissing: prunedCount,
    totalPruned: prunedCount,
  };
}

/**
 * Scans all configured physical drives for both Media and Downloads subfolders.
 */
export function runFileScan(
  config: AppConfig,
  options: ScanOptions = {},
  onDriveProgress?: (
    driveLetter: string,
    source: 'media' | 'downloads',
    summary: ScanSummary,
  ) => void,
): ScanSummary {
  const t0 = Date.now();
  const mediaSubfolder = path.win32.basename(normalizeWinPath(config.virtualMediaPath));
  const downloadsSubfolder = path.win32.basename(
    normalizeWinPath(config.virtualDownloadsPath),
  );

  const driveEntries = Object.entries(config.physicalDrivePaths);
  logger.info(
    'Scanner',
    `Starting pool scan across ${driveEntries.length} physical drives (${driveEntries.map(([d]) => `${d}:`).join(', ')})...`,
  );

  let scannedCount = 0;
  let upsertedCount = 0;
  let skippedBySize = 0;
  let skippedBakCount = 0;
  let prunedCount = 0;

  for (const [driveLetter, poolPartPath] of driveEntries) {
    const mediaFolder = path.win32.join(poolPartPath, mediaSubfolder);
    if (fs.existsSync(mediaFolder)) {
      const s = scanDirectory(config, mediaFolder, 'media', driveLetter, options);
      scannedCount += s.scannedCount;
      upsertedCount += s.upsertedCount;
      skippedBySize += s.skippedBySize;
      skippedBakCount += s.skippedBakCount;
      prunedCount += s.prunedCount;
      onDriveProgress?.(driveLetter, 'media', s);
    }

    const downloadsFolder = path.win32.join(poolPartPath, downloadsSubfolder);
    if (fs.existsSync(downloadsFolder)) {
      const s = scanDirectory(
        config,
        downloadsFolder,
        'downloads',
        driveLetter,
        options,
      );
      scannedCount += s.scannedCount;
      upsertedCount += s.upsertedCount;
      skippedBySize += s.skippedBySize;
      skippedBakCount += s.skippedBakCount;
      prunedCount += s.prunedCount;
      onDriveProgress?.(driveLetter, 'downloads', s);
    }
  }

  logger.success(
    'Scanner',
    `Full pool scan finished in ${((Date.now() - t0) / 1000).toFixed(2)}s — ${upsertedCount.toLocaleString()} total files indexed, ${prunedCount.toLocaleString()} dead entries pruned.`,
  );

  return {
    scannedCount,
    filesDiscovered: upsertedCount,
    totalDiscovered: upsertedCount,
    upsertedCount,
    addedOrUpdated: upsertedCount,
    totalAddedOrUpdated: upsertedCount,
    skippedBySize,
    skippedBakCount,
    prunedCount,
    prunedMissing: prunedCount,
    totalPruned: prunedCount,
  };
}
