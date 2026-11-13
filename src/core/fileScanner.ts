import fs from 'node:fs';
import path from 'node:path';
import { AppConfig } from './config';
import { withDatabase } from './database';
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

const EVERYTHING_REQUEST_FILE_NAME = 0x00000001;
const EVERYTHING_REQUEST_PATH = 0x00000002;
const EVERYTHING_REQUEST_SIZE = 0x00000010;
const EVERYTHING_REQUEST_DATE_MODIFIED = 0x00000080;
const EVERYTHING_REQUEST_ATTRIBUTES = 0x00000400;
const FILE_ATTRIBUTE_REPARSE_POINT = 0x0400;
const WINDOWS_TICK = 10000000n;
const SEC_TO_UNIX_EPOCH = 116444736000000000n;

/**
 * Safely inspects whether a path (or its virtual DrivePool counterpart) is a symlink and reads its target.
 */
export function inspectSymlinkState(
  fullPath: string,
  virtualPathOrPoolRoot?: string | null,
  attrHint?: number,
): { isSymlink: boolean; target: string | null; symlinkTarget: string | null } {
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
        const raw = fs.readlinkSync(fullPath).replace(/^\\\\\?\\/, '');
        target = path.win32.isAbsolute(raw)
          ? normalizeWinPath(raw)
          : normalizeWinPath(path.win32.resolve(path.win32.dirname(fullPath), raw));
      } catch {
        target = null;
      }

      if (virtualPath && virtualPath !== fullPath) {
        try {
          const vStat = fs.lstatSync(virtualPath);
          if (vStat.isSymbolicLink()) {
            const vRaw = fs.readlinkSync(virtualPath).replace(/^\\\\\?\\/, '');
            if (vRaw) {
              target = path.win32.isAbsolute(vRaw)
                ? normalizeWinPath(vRaw)
                : normalizeWinPath(path.win32.resolve(path.win32.dirname(virtualPath), vRaw));
            }
          }
        } catch {
          // Ignore virtual readlink failure
        }
      }
      return { isSymlink: true, target, symlinkTarget: target };
    }

    // Check if it's a 0-byte CoveFS virtual symlink stub on the PoolPart drive
    if (lstat.size === 0 && virtualPath && virtualPath !== fullPath) {
      try {
        const vStat = fs.lstatSync(virtualPath);
        if (vStat.isSymbolicLink()) {
          const vRaw = fs.readlinkSync(virtualPath).replace(/^\\\\\?\\/, '');
          const vTarget = path.win32.isAbsolute(vRaw)
            ? normalizeWinPath(vRaw)
            : normalizeWinPath(path.win32.resolve(path.win32.dirname(virtualPath), vRaw));
          return { isSymlink: true, target: vTarget, symlinkTarget: vTarget };
        }
      } catch {
        // Not a virtual symlink
      }
    }
  } catch {
    if (attrHint !== undefined && (attrHint & FILE_ATTRIBUTE_REPARSE_POINT) !== 0) {
      return { isSymlink: true, target: null, symlinkTarget: null };
    }
  }
  return { isSymlink: false, target: null, symlinkTarget: null };
}

/**
 * Queries Everything64.dll via koffi FFI if available and Everything IPC is running.
 */
export function queryEverythingSdk(
  searchPath: string,
  extensions?: string[] | null,
  virtualPoolRoot = 'M:\\',
): ScannedFileEntry[] | null {
  const dllCandidates = [
    'C:\\Program Files\\Everything\\Everything64.dll',
    'C:\\Program Files (x86)\\Everything\\Everything32.dll',
  ];
  const dllPath = dllCandidates.find((p) => fs.existsSync(p));
  if (!dllPath) return null;

  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const koffi = require('koffi');
    const lib = koffi.load(dllPath);

    const Everything_SetSearchW = lib.func('void __stdcall Everything_SetSearchW(str16)');
    const Everything_SetRequestFlags = lib.func(
      'void __stdcall Everything_SetRequestFlags(uint32)',
    );
    const Everything_QueryW = lib.func('bool __stdcall Everything_QueryW(bool)');
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

    Everything_SetRequestFlags(flags);

    let searchQuery = `file: path:"${normalizedPath}"`;
    if (extensions && extensions.length > 0) {
      const cleaned = extensions
        .map((e) => e.trim().replace(/^\./, '').toLowerCase())
        .filter(Boolean);
      if (cleaned.length > 0) {
        searchQuery += ` ext:${cleaned.join(';')}`;
      }
    }

    Everything_SetSearchW(searchQuery);
    if (!Everything_QueryW(true)) {
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
  } catch {
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
        const lstat = fs.lstatSync(fullPath);
        if (lstat.isDirectory() && !lstat.isSymbolicLink()) {
          stack.push(fullPath);
          continue;
        }
        if (!lstat.isFile() && !lstat.isSymbolicLink()) {
          continue;
        }

        if (allowedExts) {
          const ext = path.extname(entry.name).replace(/^\./, '').toLowerCase();
          if (!allowedExts.has(ext)) continue;
        }

        const { isSymlink, target } = inspectSymlinkState(fullPath, virtualPoolRoot);

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
 * Supports calling as:
 *   scanDirectory(config, searchPath, scanSource, options?)
 * or:
 *   scanDirectory(config, searchPath, scanSource, physicalDrive, options?)
 */
export function scanDirectory(
  config: AppConfig,
  searchPath: string,
  scanSource: 'media' | 'downloads',
  physicalDriveOrOptions?: string | ScanOptions,
  maybeOptions?: ScanOptions,
): ScanSummary {
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

  let rawEntries: Iterable<ScannedFileEntry>;
  if (options.iteratorOverride) {
    rawEntries = options.iteratorOverride(searchPath, extensions);
  } else if (useEverythingSdk) {
    const sdkEntries = queryEverythingSdk(searchPath, extensions, config.virtualPoolRoot);
    rawEntries =
      sdkEntries ?? scanDirectoryNativeWalk(searchPath, extensions, config.virtualPoolRoot);
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
  const mediaSubfolder = path.win32.basename(normalizeWinPath(config.virtualMediaPath));
  const downloadsSubfolder = path.win32.basename(
    normalizeWinPath(config.virtualDownloadsPath),
  );

  let scannedCount = 0;
  let upsertedCount = 0;
  let skippedBySize = 0;
  let skippedBakCount = 0;
  let prunedCount = 0;

  for (const [driveLetter, poolPartPath] of Object.entries(config.physicalDrivePaths)) {
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
