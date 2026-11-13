import fs from 'node:fs';
import path from 'node:path';
import { AppConfig } from './config';
import { withDatabase } from './database';
import { IQBittorrentClient } from './qbittorrentClient';
import { normalizeWinPath } from './utils';

export interface BakVaultItem {
  historyId: number | null;
  downloadFileId: number | null;
  downloadPath: string;
  backupPath: string;
  targetPath: string | null;
  fileSize: number;
  torrentHash: string | null;
  bakExists: boolean;
  symlinkExists: boolean;
  targetHealthy: boolean;
  recheckVerified: boolean;
  safeToDeleteBak: boolean;
}

export interface RestoreBakSummary {
  restored: number;
  failed: number;
  bytesRestored: number;
  errors: Array<{ backupPath: string; error: string }>;
}

export interface CleanupBakSummary {
  deleted: number;
  skippedUnsafe: number;
  failed: number;
  bytesReclaimed: number;
}

/**
 * Lists all .bak files tracked in symlink_history as well as any untracked .bak files found in extraSearchRoots.
 */
export function listBakFiles(
  config: AppConfig,
  extraSearchRoots: string[] = [],
): BakVaultItem[] {
  const items: BakVaultItem[] = [];
  const seenBackups = new Set<string>();
  const suffix = config.backupSuffix;

  const inspectBak = (
    historyId: number | null,
    downloadFileId: number | null,
    downloadPath: string,
    backupPath: string,
    dbTargetPath: string | null,
    dbFileSize: number,
    torrentHash: string | null,
    recheckVerified: boolean,
  ) => {
    const normBackup = normalizeWinPath(backupPath);
    const key = normBackup.toLowerCase();
    if (seenBackups.has(key)) return;
    seenBackups.add(key);

    let bakExists = false;
    let fileSize = dbFileSize;
    try {
      const st = fs.statSync(normBackup);
      if (st.isFile()) {
        bakExists = true;
        fileSize = st.size;
      }
    } catch {
      bakExists = false;
    }

    if (!bakExists) return;

    const normDownload = normalizeWinPath(downloadPath);
    let symlinkExists = false;
    let targetPath = dbTargetPath;
    let targetHealthy = false;

    try {
      const lstat = fs.lstatSync(normDownload);
      if (lstat.isSymbolicLink()) {
        symlinkExists = true;
        const readTarget = fs.readlinkSync(normDownload).replace(/^\\\\\?\\/, '');
        targetPath = path.win32.isAbsolute(readTarget)
          ? readTarget
          : path.win32.resolve(path.win32.dirname(normDownload), readTarget);
      }
    } catch {
      symlinkExists = false;
    }

    if (symlinkExists && targetPath) {
      try {
        const targetStat = fs.statSync(targetPath);
        targetHealthy = targetStat.isFile() && targetStat.size === fileSize && fileSize > 0;
      } catch {
        targetHealthy = false;
      }
    }

    items.push({
      historyId,
      downloadFileId,
      downloadPath: normDownload,
      backupPath: normBackup,
      targetPath,
      fileSize,
      torrentHash,
      bakExists,
      symlinkExists,
      targetHealthy,
      recheckVerified,
      safeToDeleteBak: bakExists && symlinkExists && targetHealthy,
    });
  };

  withDatabase(config.dbFilePath, (db) => {
    const rows = db
      .prepare(
        `SELECT id, download_file_id, download_path, backup_path, target_path,
                file_size, torrent_hash, recheck_verified
         FROM symlink_history
         WHERE bak_status = 'present'
         ORDER BY created_at DESC`,
      )
      .all() as Array<{
      id: number;
      download_file_id: number | null;
      download_path: string;
      backup_path: string;
      target_path: string;
      file_size: number;
      torrent_hash: string | null;
      recheck_verified: number;
    }>;

    for (const r of rows) {
      inspectBak(
        r.id,
        r.download_file_id,
        r.download_path,
        r.backup_path,
        r.target_path,
        r.file_size,
        r.torrent_hash,
        r.recheck_verified === 1,
      );
    }
  });

  // Also scan any provided roots on disk for untracked .bak files
  const stack = [...extraSearchRoots];
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
      } else if (e.isFile() && e.name.toLowerCase().endsWith(suffix.toLowerCase())) {
        const origPath = full.slice(0, full.length - suffix.length);
        inspectBak(null, null, origPath, full, null, 0, null, true);
      }
    }
  }

  return items;
}

/**
 * One-Click Undo: Restores .bak files back to their original Download paths, removing the symlink.
 */
export async function restoreBakFiles(
  config: AppConfig,
  backupPaths: string[],
  qbitClient?: IQBittorrentClient | null,
): Promise<RestoreBakSummary> {
  const allItems = listBakFiles(config);
  const byBackup = new Map(allItems.map((i) => [i.backupPath.toLowerCase(), i]));

  let restored = 0;
  let failed = 0;
  let bytesRestored = 0;
  const errors: Array<{ backupPath: string; error: string }> = [];
  const affectedTorrents = new Set<string>();

  for (const rawBak of backupPaths) {
    const normBak = normalizeWinPath(rawBak);
    const item = byBackup.get(normBak.toLowerCase());
    const downloadPath =
      item?.downloadPath ??
      (normBak.toLowerCase().endsWith(config.backupSuffix.toLowerCase())
        ? normBak.slice(0, normBak.length - config.backupSuffix.length)
        : normBak);

    if (item?.torrentHash) {
      affectedTorrents.add(item.torrentHash);
    }

    try {
      if (!fs.existsSync(normBak)) {
        throw new Error(`Backup file does not exist: ${normBak}`);
      }

      if (qbitClient && item?.torrentHash) {
        await qbitClient.pauseTorrents([item.torrentHash]);
      }

      const bakStat = fs.statSync(normBak);
      try {
        const lstat = fs.lstatSync(downloadPath);
        if (lstat.isSymbolicLink() || lstat.isFile()) {
          fs.unlinkSync(downloadPath);
        }
      } catch {
        // Nothing at downloadPath
      }

      fs.renameSync(normBak, downloadPath);

      withDatabase(config.dbFilePath, (db) => {
        db.prepare(`
          UPDATE files
          SET is_symlink = 0,
              symlink_target = NULL,
              status = CASE WHEN xxh128_hash IS NOT NULL THEN 'hashed' ELSE 'new' END,
              error_message = NULL
          WHERE LOWER(full_path) = LOWER(?)
        `).run(downloadPath);

        db.prepare(`
          UPDATE symlink_history
          SET bak_status = 'restored'
          WHERE LOWER(backup_path) = LOWER(?)
        `).run(normBak);
      });

      restored++;
      bytesRestored += bakStat.size;
    } catch (err) {
      failed++;
      errors.push({
        backupPath: normBak,
        error: (err as Error).message,
      });
    }
  }

  if (qbitClient && affectedTorrents.size > 0) {
    const hashes = Array.from(affectedTorrents);
    await qbitClient.recheckTorrents(hashes);
    await qbitClient.resumeTorrents(hashes);
  }

  return {
    restored,
    failed,
    bytesRestored,
    errors,
  };
}

/**
 * Purges .bak files safely. By default, only deletes .bak files whose active symlink is present and target is healthy.
 */
export function cleanupBackupFiles(
  config: AppConfig,
  options: {
    backupPaths?: string[];
    requireHealthySymlink?: boolean;
    searchRoots?: string[];
  } = {},
): CleanupBakSummary {
  const requireHealthy = options.requireHealthySymlink ?? true;
  const allItems = listBakFiles(config, options.searchRoots ?? []);
  const filterSet = options.backupPaths
    ? new Set(options.backupPaths.map((p) => normalizeWinPath(p).toLowerCase()))
    : null;

  const candidates = filterSet
    ? allItems.filter((i) => filterSet.has(i.backupPath.toLowerCase()))
    : allItems;

  let deleted = 0;
  let skippedUnsafe = 0;
  let failed = 0;
  let bytesReclaimed = 0;

  withDatabase(config.dbFilePath, (db) => {
    const updateHistoryStmt = db.prepare(`
      UPDATE symlink_history
      SET bak_status = 'deleted'
      WHERE LOWER(backup_path) = LOWER(?)
    `);

    for (const item of candidates) {
      if (requireHealthy && !item.safeToDeleteBak) {
        skippedUnsafe++;
        continue;
      }

      try {
        if (fs.existsSync(item.backupPath)) {
          fs.unlinkSync(item.backupPath);
        }
        updateHistoryStmt.run(item.backupPath);
        deleted++;
        bytesReclaimed += item.fileSize;
      } catch {
        failed++;
      }
    }
  });

  return {
    deleted,
    skippedUnsafe,
    failed,
    bytesReclaimed,
  };
}
