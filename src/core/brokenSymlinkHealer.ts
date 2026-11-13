import fs from 'node:fs';
import path from 'node:path';
import { AppConfig, SymlinkTargetMode } from './config';
import { withDatabase } from './database';
import {
  extractRelativePoolPath,
  normalizeWinPath,
  physicalToVirtualPath,
  virtualToPhysicalPath,
} from './utils';

export type BrokenSymlinkClassification =
  | 'drivepool_rebalanced'
  | 'covefs_0byte_corrupted'
  | 'renamed_or_moved'
  | 'missing_target';

export interface BrokenSymlinkReportItem {
  fileId: number | null;
  symlinkPath: string;
  virtualSymlinkPath: string | null;
  currentTarget: string;
  classification: BrokenSymlinkClassification;
  canAutoHeal: boolean;
  proposedTargetVirtual: string | null;
  proposedTargetPhysical: string | null;
  hasBackupFile: boolean;
  backupPath: string;
  reason: string;
}

export interface HealBrokenSymlinksSummary {
  attempted: number;
  healed: number;
  restoredFromBak: number;
  failed: number;
  errors: Array<{ symlinkPath: string; error: string }>;
}

/**
 * Checks if a symlink target is a 0-byte corrupted target (such as the legacy 0-byte .srt collision).
 */
function isZeroByteCorruptedTarget(targetPath: string, symlinkPath: string): boolean {
  try {
    if (!fs.existsSync(targetPath)) return false;
    const stat = fs.statSync(targetPath);
    if (stat.size !== 0) return false;
    const symlinkExt = path.win32.extname(symlinkPath).toLowerCase();
    const targetExt = path.win32.extname(targetPath).toLowerCase();
    // If symlink is a video/audio/archive or has a different filename/extension than a 0-byte target, it's corrupted
    return (
      symlinkExt !== targetExt ||
      path.win32.basename(symlinkPath).toLowerCase() !==
        path.win32.basename(targetPath).toLowerCase()
    );
  } catch {
    return false;
  }
}

/**
 * Resolves a moved/rebalanced target across virtualPoolRoot and all configured physicalDrivePaths.
 */
function findRebalancedTarget(
  currentTarget: string,
  config: AppConfig,
): { virtualPath: string | null; physicalPath: string | null } {
  const rel = extractRelativePoolPath(currentTarget, config.virtualPoolRoot);
  if (!rel) return { virtualPath: null, physicalPath: null };

  const virtualCandidate = normalizeWinPath(path.win32.join(config.virtualPoolRoot, rel));
  const physicalCandidate = virtualToPhysicalPath(
    virtualCandidate,
    config.physicalDrivePaths,
    config.virtualPoolRoot,
    fs.existsSync,
  );

  const virtualExists = fs.existsSync(virtualCandidate);
  if (virtualExists || physicalCandidate) {
    return {
      virtualPath: virtualCandidate,
      physicalPath: physicalCandidate ?? (virtualExists ? virtualCandidate : null),
    };
  }

  return { virtualPath: null, physicalPath: null };
}

/**
 * Scans all symlinks recorded in SQLite (and optionally extra directories on disk) to detect broken,
 * DrivePool-rebalanced, or 0-byte corrupted symlinks, and proposes healed targets.
 */
export function scanBrokenSymlinks(
  config: AppConfig,
  extraDirectoriesToWalk: string[] = [],
): BrokenSymlinkReportItem[] {
  const report: BrokenSymlinkReportItem[] = [];
  const seenPaths = new Set<string>();

  withDatabase(config.dbFilePath, (db) => {
    const dbSymlinks = db
      .prepare(
        `SELECT id, full_path, virtual_path, filename, file_size, xxh128_hash, symlink_target
         FROM files
         WHERE is_symlink = 1 OR status = 'symlinked'`,
      )
      .all() as Array<{
      id: number;
      full_path: string;
      virtual_path: string | null;
      filename: string;
      file_size: number;
      xxh128_hash: string | null;
      symlink_target: string | null;
    }>;

    const inspectCandidate = (
      fileId: number | null,
      symlinkPath: string,
      virtualSymlinkPath: string | null,
      filename: string,
      fileSize: number,
      xxh128Hash: string | null,
      dbTarget: string | null,
    ) => {
      const normPath = normalizeWinPath(symlinkPath);
      const lowerKey = normPath.toLowerCase();
      if (seenPaths.has(lowerKey)) return;
      seenPaths.add(lowerKey);

      let rawTarget = dbTarget ?? '';
      let isActualSymlinkOnDisk = false;
      try {
        const lstat = fs.lstatSync(normPath);
        if (lstat.isSymbolicLink()) {
          isActualSymlinkOnDisk = true;
          const readTarget = fs.readlinkSync(normPath).replace(/^\\\\\?\\/, '');
          rawTarget = path.win32.isAbsolute(readTarget)
            ? readTarget
            : path.win32.resolve(path.win32.dirname(normPath), readTarget);
        }
      } catch {
        // File itself may be missing
      }

      if (!isActualSymlinkOnDisk && !rawTarget) return;

      const backupPath = `${normPath}${config.backupSuffix}`;
      const hasBackupFile = fs.existsSync(backupPath);

      const targetExists = rawTarget ? fs.existsSync(rawTarget) : false;
      const zeroByteCorrupted =
        targetExists && rawTarget ? isZeroByteCorruptedTarget(rawTarget, normPath) : false;

      if (targetExists && !zeroByteCorrupted) {
        // Healthy symlink!
        return;
      }

      // Case 1: DrivePool Rebalanced (target missing at physical PoolPart path, but exists on another PoolPart or virtual M:\)
      if (!targetExists && rawTarget) {
        const rebalanced = findRebalancedTarget(rawTarget, config);
        if (rebalanced.virtualPath || rebalanced.physicalPath) {
          report.push({
            fileId,
            symlinkPath: normPath,
            virtualSymlinkPath:
              virtualSymlinkPath ?? physicalToVirtualPath(normPath, config.virtualPoolRoot),
            currentTarget: rawTarget,
            classification: 'drivepool_rebalanced',
            canAutoHeal: true,
            proposedTargetVirtual: rebalanced.virtualPath,
            proposedTargetPhysical: rebalanced.physicalPath,
            hasBackupFile,
            backupPath,
            reason:
              'Target moved to another drive during StableBit DrivePool rebalance; file still exists in pool',
          });
          return;
        }
      }

      // Case 2 & 3: Look up canonical media match in SQLite by xxh128_hash (if > 0 bytes) or by filename
      let matchedMedia: { full_path: string; virtual_path: string | null } | undefined;

      if (xxh128Hash && fileSize > 0) {
        const candidates = db
          .prepare(
            `SELECT full_path, virtual_path
             FROM files
             WHERE scan_source = 'media'
               AND is_symlink = 0
               AND file_size > 0
               AND xxh128_hash = ?
             ORDER BY id ASC`,
          )
          .all(xxh128Hash) as Array<{ full_path: string; virtual_path: string | null }>;

        matchedMedia = candidates.find(
          (c) => fs.existsSync(c.full_path) || (c.virtual_path && fs.existsSync(c.virtual_path)),
        );
      }

      if (!matchedMedia && filename) {
        const byName = db
          .prepare(
            `SELECT full_path, virtual_path
             FROM files
             WHERE scan_source = 'media'
               AND is_symlink = 0
               AND file_size > 0
               AND LOWER(filename) = LOWER(?)
             ORDER BY id ASC`,
          )
          .all(filename) as Array<{ full_path: string; virtual_path: string | null }>;

        matchedMedia = byName.find(
          (c) => fs.existsSync(c.full_path) || (c.virtual_path && fs.existsSync(c.virtual_path)),
        );
      }

      if (matchedMedia) {
        const virtTarget =
          matchedMedia.virtual_path ??
          physicalToVirtualPath(matchedMedia.full_path, config.virtualPoolRoot);
        const physTarget = fs.existsSync(matchedMedia.full_path)
          ? matchedMedia.full_path
          : virtTarget
            ? virtualToPhysicalPath(
                virtTarget,
                config.physicalDrivePaths,
                config.virtualPoolRoot,
                fs.existsSync,
              )
            : null;

        report.push({
          fileId,
          symlinkPath: normPath,
          virtualSymlinkPath:
            virtualSymlinkPath ?? physicalToVirtualPath(normPath, config.virtualPoolRoot),
          currentTarget: rawTarget,
          classification: zeroByteCorrupted ? 'covefs_0byte_corrupted' : 'renamed_or_moved',
          canAutoHeal: true,
          proposedTargetVirtual: virtTarget,
          proposedTargetPhysical: physTarget ?? matchedMedia.full_path,
          hasBackupFile,
          backupPath,
          reason: zeroByteCorrupted
            ? 'Corrupted 0-byte symlink target; canonical Media match found'
            : 'Original target moved/renamed; matching Media file found in database',
        });
        return;
      }

      // Case 4: Missing target (e.g., Sonarr/Radarr upgraded or deleted the Media copy)
      report.push({
        fileId,
        symlinkPath: normPath,
        virtualSymlinkPath:
          virtualSymlinkPath ?? physicalToVirtualPath(normPath, config.virtualPoolRoot),
        currentTarget: rawTarget,
        classification: zeroByteCorrupted ? 'covefs_0byte_corrupted' : 'missing_target',
        canAutoHeal: hasBackupFile,
        proposedTargetVirtual: null,
        proposedTargetPhysical: null,
        hasBackupFile,
        backupPath,
        reason: hasBackupFile
          ? 'Target no longer exists in Media, but original .bak file is available for restoration'
          : 'Target no longer exists in Media (likely upgraded/deleted) and no .bak file exists',
      });
    };

    for (const row of dbSymlinks) {
      inspectCandidate(
        row.id,
        row.full_path,
        row.virtual_path,
        row.filename,
        row.file_size,
        row.xxh128_hash,
        row.symlink_target,
      );
    }

    // Walk any extra directories on disk for untracked symlinks
    const stack = [...extraDirectoriesToWalk];
    while (stack.length > 0) {
      const dir = stack.pop()!;
      if (!fs.existsSync(dir)) continue;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of entries) {
        const full = path.win32.join(dir, e.name);
        if (e.isDirectory() && !e.isSymbolicLink()) {
          stack.push(full);
        } else if (e.isSymbolicLink()) {
          inspectCandidate(
            null,
            full,
            physicalToVirtualPath(full, config.virtualPoolRoot),
            e.name,
            0,
            null,
            null,
          );
        }
      }
    }
  });

  return report;
}

/**
 * Heals broken/corrupted symlinks by either re-pointing them to their new valid Media target
 * or restoring their .bak file if the Media target was deleted.
 */
export function healBrokenSymlinks(
  config: AppConfig,
  items: BrokenSymlinkReportItem[],
  targetMode: SymlinkTargetMode = config.symlinkTargetMode,
): HealBrokenSymlinksSummary {
  let healed = 0;
  let restoredFromBak = 0;
  let failed = 0;
  const errors: Array<{ symlinkPath: string; error: string }> = [];

  withDatabase(config.dbFilePath, (db) => {
    const updateSymlinkStmt = db.prepare(`
      UPDATE files
      SET is_symlink = 1,
          status = 'symlinked',
          symlink_target = ?,
          error_message = NULL
      WHERE full_path = ?
    `);

    const updateRestoredStmt = db.prepare(`
      UPDATE files
      SET is_symlink = 0,
          status = CASE WHEN xxh128_hash IS NOT NULL THEN 'hashed' ELSE 'new' END,
          symlink_target = NULL,
          error_message = NULL
      WHERE full_path = ?
    `);

    for (const item of items) {
      if (!item.canAutoHeal) continue;

      try {
        const desiredTarget =
          targetMode === 'virtual'
            ? item.proposedTargetVirtual && fs.existsSync(item.proposedTargetVirtual)
              ? item.proposedTargetVirtual
              : item.proposedTargetPhysical ?? item.proposedTargetVirtual
            : item.proposedTargetPhysical ?? item.proposedTargetVirtual;

        if (desiredTarget) {
          try {
            const st = fs.lstatSync(item.symlinkPath);
            if (st.isSymbolicLink() || st.isFile()) {
              fs.unlinkSync(item.symlinkPath);
            }
          } catch {
            // Symlink did not exist on disk yet
          }

          fs.symlinkSync(desiredTarget, item.symlinkPath, 'file');
          updateSymlinkStmt.run(desiredTarget, item.symlinkPath);
          healed++;
        } else if (item.hasBackupFile && fs.existsSync(item.backupPath)) {
          try {
            const st = fs.lstatSync(item.symlinkPath);
            if (st.isSymbolicLink() || st.isFile()) {
              fs.unlinkSync(item.symlinkPath);
            }
          } catch {
            // Ignore
          }
          fs.renameSync(item.backupPath, item.symlinkPath);
          updateRestoredStmt.run(item.symlinkPath);
          restoredFromBak++;
        }
      } catch (err) {
        failed++;
        errors.push({
          symlinkPath: item.symlinkPath,
          error: (err as Error).message,
        });
      }
    }
  });

  return {
    attempted: items.filter((i) => i.canAutoHeal).length,
    healed,
    restoredFromBak,
    failed,
    errors,
  };
}
