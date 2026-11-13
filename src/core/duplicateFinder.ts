import { AppConfig } from './config';
import { withDatabase } from './database';
import { hashSpecificFiles, hashUnHashedFilesPerDrive } from './hashing';
import { physicalToVirtualPath } from './utils';

export interface PendingDuplicatePair {
  downloadFileId: number;
  downloadFullPath: string;
  downloadVirtualPath: string | null;
  downloadDrive: string | null;
  downloadFilename: string;
  fileSize: number;
  xxh128Hash: string;
  torrentHash: string | null;
  torrentName: string | null;
  category: string | null;
  mediaFileId: number;
  mediaFullPath: string;
  mediaVirtualPath: string | null;
  mediaDrive: string | null;
  proposedTargetVirtual: string;
  proposedTargetPhysical: string;
}

export interface DuplicateLinkSummary {
  cleanedUpLinks: number;
  onDemandHashed: number;
  duplicatesLinked: number;
  reclaimableBytes: number;
}

/**
 * Self-heals invalid duplicate_of_id links on downloads rows where the referenced media file:
 * - no longer exists,
 * - is itself a symlink (is_symlink = 1),
 * - is marked as a duplicate of another file (duplicate_of_id IS NOT NULL),
 * - has file_size <= 0, or
 * - no longer matches xxh128_hash.
 */
export function cleanupBrokenLinks(dbFilePath: string): number {
  return withDatabase(dbFilePath, (db) => {
    const res = db
      .prepare(
        `UPDATE files
         SET status = CASE
               WHEN xxh128_hash IS NOT NULL THEN 'hashed'
               WHEN sparse_hash IS NOT NULL THEN 'sparse_hashed'
               ELSE 'new'
             END,
             duplicate_of_id = NULL
         WHERE scan_source = 'downloads'
           AND is_symlink = 0
           AND (status = 'duplicate_found' OR duplicate_of_id IS NOT NULL)
           AND (
             file_size <= 0
             OR duplicate_of_id IS NULL
             OR NOT EXISTS (
               SELECT 1
               FROM files m
               WHERE m.id = files.duplicate_of_id
                 AND m.scan_source = 'media'
                 AND m.is_symlink = 0
                 AND m.duplicate_of_id IS NULL
                 AND m.file_size > 0
                 AND m.file_size = files.file_size
                 AND COALESCE(m.xxh128_hash, m.sparse_hash) IS NOT NULL
                 AND COALESCE(m.xxh128_hash, m.sparse_hash) = COALESCE(files.xxh128_hash, files.sparse_hash)
             )
           )`,
      )
      .run();

    return Number(res.changes ?? 0);
  });
}

/**
 * Identifies downloads files that match canonical media files by size + hash (xxh128_hash or 3-point sparse_hash).
 * Automatically resolves any unhashed cross-source size candidates on demand before linking.
 */
export async function identifyAndLinkDuplicates(
  config: AppConfig,
  options: {
    forceRelink?: boolean;
    signal?: AbortSignal;
  } = {},
): Promise<DuplicateLinkSummary> {
  const cleanedUpLinks = cleanupBrokenLinks(config.dbFilePath);

  if (options.forceRelink) {
    withDatabase(config.dbFilePath, (db) => {
      db.prepare(
        `UPDATE files
         SET status = CASE
               WHEN xxh128_hash IS NOT NULL THEN 'hashed'
               WHEN sparse_hash IS NOT NULL THEN 'sparse_hashed'
               ELSE 'new'
             END,
             duplicate_of_id = NULL,
             error_message = NULL
         WHERE scan_source = 'downloads'
           AND is_symlink = 0
           AND status IN ('duplicate_found', 'error_recheck_rollback', 'error_symlink')`,
      ).run();
    });
  }

  // Ensure any unhashed cross-source candidate pairs sharing file_size are sparse-hashed first
  const unhashedCrossSourceCount = withDatabase(config.dbFilePath, (db) => {
    const row = db
      .prepare(
        `SELECT COUNT(DISTINCT f.id) AS cnt
         FROM files f
         JOIN files other
           ON f.file_size = other.file_size
          AND f.id != other.id
          AND f.scan_source != other.scan_source
         WHERE f.is_symlink = 0
           AND other.is_symlink = 0
           AND f.file_size > 0
           AND f.xxh128_hash IS NULL
           AND f.sparse_hash IS NULL`,
      )
      .get() as { cnt: number } | undefined;
    return Number(row?.cnt ?? 0);
  });

  let onDemandHashed = 0;
  if (unhashedCrossSourceCount > 0 && !options.signal?.aborted) {
    const smartRes = await hashUnHashedFilesPerDrive(config, {
      strategy: 'smart_candidates',
      signal: options.signal,
    });
    onDemandHashed += smartRes.totalFilesHashed;
  }

  // Also resolve any legacy quick_hash-only collisions <= 64 MiB
  const candidateIdsToFullHash = withDatabase(config.dbFilePath, (db) => {
    const rows = db
      .prepare(
        `SELECT DISTINCT f.id
         FROM files f
         JOIN files other
           ON f.file_size = other.file_size
          AND f.id != other.id
          AND f.scan_source != other.scan_source
         WHERE f.is_symlink = 0
           AND other.is_symlink = 0
           AND f.file_size > 0
           AND f.xxh128_hash IS NULL
           AND f.sparse_hash IS NULL
           AND (
             (f.quick_hash IS NOT NULL AND f.quick_hash = other.quick_hash)
             OR (f.quick_hash IS NULL AND f.file_size <= 67108864)
           )`,
      )
      .all() as Array<{ id: number }>;

    return rows.map((r) => r.id);
  });

  if (candidateIdsToFullHash.length > 0 && !options.signal?.aborted) {
    onDemandHashed += await hashSpecificFiles(
      config,
      candidateIdsToFullHash,
      undefined,
      options.signal,
    );
  }

  // Link downloads files to canonical media files (MIN(m.id) per (file_size, COALESCE(xxh128_hash, sparse_hash)))
  return withDatabase(config.dbFilePath, (db) => {
    const linkRes = db
      .prepare(
        `UPDATE files
         SET duplicate_of_id = (
               SELECT MIN(m.id)
               FROM files m
               WHERE m.scan_source = 'media'
                 AND m.is_symlink = 0
                 AND m.duplicate_of_id IS NULL
                 AND m.file_size = files.file_size
                 AND COALESCE(m.xxh128_hash, m.sparse_hash) = COALESCE(files.xxh128_hash, files.sparse_hash)
                 AND (m.xxh128_hash IS NULL OR files.xxh128_hash IS NULL OR m.xxh128_hash = files.xxh128_hash)
             ),
             status = 'duplicate_found'
         WHERE scan_source = 'downloads'
           AND is_symlink = 0
           AND file_size > 0
           AND COALESCE(xxh128_hash, sparse_hash) IS NOT NULL
           AND status IN ('hashed', 'sparse_hashed', 'quick_hashed', 'new')
           AND EXISTS (
             SELECT 1
             FROM files m
             WHERE m.scan_source = 'media'
               AND m.is_symlink = 0
               AND m.duplicate_of_id IS NULL
               AND m.file_size = files.file_size
               AND COALESCE(m.xxh128_hash, m.sparse_hash) = COALESCE(files.xxh128_hash, files.sparse_hash)
               AND (m.xxh128_hash IS NULL OR files.xxh128_hash IS NULL OR m.xxh128_hash = files.xxh128_hash)
           )`,
      )
      .run();

    const duplicatesLinked = Number(linkRes.changes ?? 0);

    const bytesRow = db
      .prepare(
        `SELECT COALESCE(SUM(file_size), 0) AS total_bytes
         FROM files
         WHERE scan_source = 'downloads'
           AND is_symlink = 0
           AND status = 'duplicate_found'
           AND duplicate_of_id IS NOT NULL`,
      )
      .get() as { total_bytes: number } | undefined;

    return {
      cleanedUpLinks,
      onDemandHashed,
      duplicatesLinked,
      reclaimableBytes: Number(bytesRow?.total_bytes ?? 0),
    };
  });
}

/**
 * Returns all pending duplicate pairs for the Dry-Run Workbench UI.
 */
export function getPendingDuplicatePairs(config: AppConfig): PendingDuplicatePair[] {
  return withDatabase(config.dbFilePath, (db) => {
    const rows = db
      .prepare(
        `SELECT
           d.id AS downloadFileId,
           d.full_path AS downloadFullPath,
           d.virtual_path AS downloadVirtualPath,
           d.physical_drive AS downloadDrive,
           d.filename AS downloadFilename,
           d.file_size AS fileSize,
           COALESCE(d.xxh128_hash, d.sparse_hash) AS xxh128Hash,
           d.torrent_hash AS torrentHash,
           d.torrent_name AS torrentName,
           d.category AS category,
           m.id AS mediaFileId,
           m.full_path AS mediaFullPath,
           m.virtual_path AS mediaVirtualPath,
           m.physical_drive AS mediaDrive
         FROM files d
         JOIN files m ON m.id = d.duplicate_of_id
         WHERE d.scan_source = 'downloads'
           AND d.is_symlink = 0
           AND d.status = 'duplicate_found'
         ORDER BY d.file_size DESC, d.filename ASC`,
      )
      .all() as Array<{
      downloadFileId: number;
      downloadFullPath: string;
      downloadVirtualPath: string | null;
      downloadDrive: string | null;
      downloadFilename: string;
      fileSize: number;
      xxh128Hash: string;
      torrentHash: string | null;
      torrentName: string | null;
      category: string | null;
      mediaFileId: number;
      mediaFullPath: string;
      mediaVirtualPath: string | null;
      mediaDrive: string | null;
    }>;

    return rows.map((r) => {
      const virtualTarget =
        r.mediaVirtualPath ??
        physicalToVirtualPath(r.mediaFullPath, config.virtualPoolRoot) ??
        r.mediaFullPath;
      return {
        ...r,
        proposedTargetVirtual: virtualTarget,
        proposedTargetPhysical: r.mediaFullPath,
      };
    });
  });
}
