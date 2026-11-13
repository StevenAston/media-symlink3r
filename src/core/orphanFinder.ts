import fs from 'node:fs';
import { AppConfig } from './config';
import { withDatabase } from './database';

export type OrphanClassification = 'already_in_media' | 'unique_to_downloads';

export interface OrphanedDownloadItem {
  fileId: number;
  fullPath: string;
  virtualPath: string | null;
  physicalDrive: string | null;
  filename: string;
  fileSize: number;
  xxh128Hash: string | null;
  classification: OrphanClassification;
  matchingMediaPath: string | null;
}

export interface DeleteOrphansSummary {
  deleted: number;
  failed: number;
  bytesReclaimed: number;
  errors: Array<{ fileId: number; error: string }>;
}

/**
 * Finds all non-symlink files in Downloads that are not tracked by any qBittorrent torrent (torrent_hash IS NULL),
 * classifying them into 'already_in_media' (100% safe to delete) vs 'unique_to_downloads' (unimported).
 */
export function findOrphanedDownloads(config: AppConfig): OrphanedDownloadItem[] {
  return withDatabase(config.dbFilePath, (db) => {
    const rows = db
      .prepare(
        `SELECT
           d.id AS fileId,
           d.full_path AS fullPath,
           d.virtual_path AS virtualPath,
           d.physical_drive AS physicalDrive,
           d.filename AS filename,
           d.file_size AS fileSize,
           d.xxh128_hash AS xxh128Hash,
           d.sparse_hash AS sparseHash,
           d.duplicate_of_id AS duplicateOfId
         FROM files d
         WHERE d.scan_source = 'downloads'
           AND d.is_symlink = 0
           AND d.torrent_hash IS NULL
         ORDER BY d.file_size DESC, d.filename ASC`,
      )
      .all() as Array<{
      fileId: number;
      fullPath: string;
      virtualPath: string | null;
      physicalDrive: string | null;
      filename: string;
      fileSize: number;
      xxh128Hash: string | null;
      sparseHash: string | null;
      duplicateOfId: number | null;
    }>;

    const findByIdStmt = db.prepare(`
      SELECT full_path FROM files WHERE id = ? AND scan_source = 'media' AND is_symlink = 0
    `);
    const findByFullHashStmt = db.prepare(`
      SELECT full_path FROM files
      WHERE scan_source = 'media' AND is_symlink = 0 AND file_size = ? AND xxh128_hash = ?
      ORDER BY id ASC LIMIT 1
    `);
    const findBySparseHashStmt = db.prepare(`
      SELECT full_path FROM files
      WHERE scan_source = 'media' AND is_symlink = 0 AND file_size = ? AND sparse_hash = ?
      ORDER BY id ASC LIMIT 1
    `);
    const findByNameSizeStmt = db.prepare(`
      SELECT full_path FROM files
      WHERE scan_source = 'media' AND is_symlink = 0 AND file_size = ? AND LOWER(filename) = LOWER(?)
      ORDER BY id ASC LIMIT 1
    `);

    return rows.map((r): OrphanedDownloadItem => {
      let matchingMediaPath: string | null = null;

      if (r.duplicateOfId) {
        const m = findByIdStmt.get(r.duplicateOfId) as { full_path: string } | undefined;
        if (m) matchingMediaPath = m.full_path;
      }

      if (!matchingMediaPath && r.fileSize > 0 && r.xxh128Hash) {
        const m = findByFullHashStmt.get(r.fileSize, r.xxh128Hash) as
          | { full_path: string }
          | undefined;
        if (m) matchingMediaPath = m.full_path;
      }

      if (!matchingMediaPath && r.fileSize > 0 && r.sparseHash) {
        const m = findBySparseHashStmt.get(r.fileSize, r.sparseHash) as
          | { full_path: string }
          | undefined;
        if (m) matchingMediaPath = m.full_path;
      }

      if (!matchingMediaPath && r.fileSize > 0) {
        const m = findByNameSizeStmt.get(r.fileSize, r.filename) as
          | { full_path: string }
          | undefined;
        if (m) matchingMediaPath = m.full_path;
      }

      return {
        fileId: r.fileId,
        fullPath: r.fullPath,
        virtualPath: r.virtualPath,
        physicalDrive: r.physicalDrive,
        filename: r.filename,
        fileSize: r.fileSize,
        xxh128Hash: r.xxh128Hash,
        classification: matchingMediaPath ? 'already_in_media' : 'unique_to_downloads',
        matchingMediaPath,
      };
    });
  });
}

/**
 * Deletes selected orphaned download files from disk and removes their DB records.
 */
export function deleteOrphanedFiles(
  config: AppConfig,
  fileIds: number[],
): DeleteOrphansSummary {
  if (fileIds.length === 0) {
    return { deleted: 0, failed: 0, bytesReclaimed: 0, errors: [] };
  }

  let deleted = 0;
  let failed = 0;
  let bytesReclaimed = 0;
  const errors: Array<{ fileId: number; error: string }> = [];

  withDatabase(config.dbFilePath, (db) => {
    const getStmt = db.prepare(`
      SELECT id, full_path, file_size
      FROM files
      WHERE id = ? AND scan_source = 'downloads' AND torrent_hash IS NULL
    `);
    const delStmt = db.prepare(`DELETE FROM files WHERE id = ?`);

    for (const id of fileIds) {
      const row = getStmt.get(id) as
        | { id: number; full_path: string; file_size: number }
        | undefined;
      if (!row) {
        failed++;
        errors.push({ fileId: id, error: 'Orphaned file record not found' });
        continue;
      }

      try {
        if (fs.existsSync(row.full_path)) {
          fs.unlinkSync(row.full_path);
        }
        delStmt.run(id);
        deleted++;
        bytesReclaimed += row.file_size;
      } catch (err) {
        failed++;
        errors.push({ fileId: id, error: (err as Error).message });
      }
    }
  });

  return { deleted, failed, bytesReclaimed, errors };
}
