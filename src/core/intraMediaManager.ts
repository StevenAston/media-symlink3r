import fs from 'node:fs';
import { AppConfig, SymlinkTargetMode } from './config';
import { withDatabase } from './database';
import { physicalToVirtualPath } from './utils';

export interface IntraMediaFileEntry {
  id: number;
  fullPath: string;
  virtualPath: string | null;
  physicalDrive: string | null;
  filename: string;
  directory: string;
  fileSize: number;
  modifiedDate: number;
}

export interface IntraMediaDuplicateGroup {
  xxh128Hash: string;
  fileSize: number;
  copyCount: number;
  wastedBytes: number;
  recommendedKeepId: number;
  files: IntraMediaFileEntry[];
}

export interface ResolveIntraMediaSummary {
  processed: number;
  failed: number;
  bytesReclaimed: number;
  errors: Array<{ fileId: number; error: string }>;
}

/**
 * Finds all sets of duplicate non-symlink files within the Media library itself.
 */
export function findIntraMediaDuplicates(config: AppConfig): IntraMediaDuplicateGroup[] {
  return withDatabase(config.dbFilePath, (db) => {
    const groups = db
      .prepare(
        `SELECT COALESCE(xxh128_hash, sparse_hash) AS xxh128Hash,
                file_size AS fileSize,
                COUNT(*) AS copyCount,
                (COUNT(*) - 1) * file_size AS wastedBytes,
                MIN(id) AS recommendedKeepId
         FROM files
         WHERE scan_source = 'media'
           AND is_symlink = 0
           AND file_size > 0
           AND COALESCE(xxh128_hash, sparse_hash) IS NOT NULL
         GROUP BY COALESCE(xxh128_hash, sparse_hash), file_size
         HAVING COUNT(*) > 1
         ORDER BY wastedBytes DESC`,
      )
      .all() as Array<{
      xxh128Hash: string;
      fileSize: number;
      copyCount: number;
      wastedBytes: number;
      recommendedKeepId: number;
    }>;

    const filesStmt = db.prepare(`
      SELECT id,
             full_path AS fullPath,
             virtual_path AS virtualPath,
             physical_drive AS physicalDrive,
             filename,
             directory,
             file_size AS fileSize,
             modified_date AS modifiedDate
      FROM files
      WHERE scan_source = 'media'
        AND is_symlink = 0
        AND COALESCE(xxh128_hash, sparse_hash) = ?
        AND file_size = ?
      ORDER BY id ASC
    `);

    return groups.map((g) => ({
      ...g,
      files: filesStmt.all(g.xxh128Hash, g.fileSize) as unknown as IntraMediaFileEntry[],
    }));
  });
}

/**
 * Resolves a duplicate set within Media by either symlinking redundant copies to the kept file
 * (creating a .bak backup) or deleting the redundant copies while re-pointing any referencing rows.
 */
export function resolveIntraMediaDuplicateSet(
  config: AppConfig,
  keepFileId: number,
  redundantFileIds: number[],
  action: 'symlink' | 'delete',
  targetMode: SymlinkTargetMode = config.symlinkTargetMode,
): ResolveIntraMediaSummary {
  let processed = 0;
  let failed = 0;
  let bytesReclaimed = 0;
  const errors: Array<{ fileId: number; error: string }> = [];

  withDatabase(config.dbFilePath, (db) => {
    const keepRow = db
      .prepare(
        `SELECT id, full_path, virtual_path, file_size, xxh128_hash
         FROM files
         WHERE id = ? AND scan_source = 'media' AND is_symlink = 0`,
      )
      .get(keepFileId) as
      | {
          id: number;
          full_path: string;
          virtual_path: string | null;
          file_size: number;
          xxh128_hash: string | null;
        }
      | undefined;

    if (!keepRow || !fs.existsSync(keepRow.full_path)) {
      throw new Error(`Kept primary media file (id=${keepFileId}) does not exist on disk`);
    }

    const virtualKeepPath =
      keepRow.virtual_path ?? physicalToVirtualPath(keepRow.full_path, config.virtualPoolRoot);
    const chosenTarget =
      targetMode === 'virtual' && virtualKeepPath && fs.existsSync(virtualKeepPath)
        ? virtualKeepPath
        : keepRow.full_path;

    for (const redId of redundantFileIds) {
      if (redId === keepFileId) continue;

      const redRow = db
        .prepare(
          `SELECT id, full_path, virtual_path, file_size
           FROM files
           WHERE id = ? AND scan_source = 'media' AND is_symlink = 0`,
        )
        .get(redId) as
        | { id: number; full_path: string; virtual_path: string | null; file_size: number }
        | undefined;

      if (!redRow) {
        failed++;
        errors.push({ fileId: redId, error: 'Redundant media file not found in DB' });
        continue;
      }

      try {
        // Re-point any Downloads rows that referenced redId so they now reference keepFileId
        db.prepare(`UPDATE files SET duplicate_of_id = ? WHERE duplicate_of_id = ?`).run(
          keepFileId,
          redId,
        );

        if (action === 'delete') {
          if (fs.existsSync(redRow.full_path)) {
            fs.unlinkSync(redRow.full_path);
          }
          db.prepare(`DELETE FROM files WHERE id = ?`).run(redId);
        } else {
          const backupPath = `${redRow.full_path}${config.backupSuffix}`;
          if (fs.existsSync(backupPath)) {
            fs.unlinkSync(backupPath);
          }
          fs.renameSync(redRow.full_path, backupPath);
          fs.symlinkSync(chosenTarget, redRow.full_path, 'file');

          db.prepare(`
            UPDATE files
            SET is_symlink = 1,
                status = 'symlinked',
                symlink_target = ?,
                duplicate_of_id = ?
            WHERE id = ?
          `).run(chosenTarget, keepFileId, redId);

          db.prepare(`
            INSERT INTO symlink_history (
              download_file_id, download_path, virtual_download_path, backup_path,
              target_path, target_mode, file_size, xxh128_hash, torrent_hash,
              bak_status, recheck_verified
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, 'present', 1)
          `).run(
            redId,
            redRow.full_path,
            redRow.virtual_path,
            backupPath,
            chosenTarget,
            targetMode,
            redRow.file_size,
            keepRow.xxh128_hash,
          );
        }

        processed++;
        bytesReclaimed += redRow.file_size;
      } catch (err) {
        failed++;
        errors.push({ fileId: redId, error: (err as Error).message });
      }
    }
  });

  return { processed, failed, bytesReclaimed, errors };
}
