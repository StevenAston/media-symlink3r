import fs from 'node:fs';
import { AppConfig, SymlinkTargetMode } from './config';
import { withDatabase } from './database';
import { getPendingDuplicatePairs, PendingDuplicatePair } from './duplicateFinder';
import { IQBittorrentClient, QBittorrentClient } from './qbittorrentClient';

export interface ProcessDuplicatesOptions {
  fileIds?: number[];
  targetMode?: SymlinkTargetMode;
  pauseAll?: boolean;
  verifyRecheck?: boolean;
  recheckTimeoutMs?: number;
  qbitClient?: IQBittorrentClient | null;
  skipQbittorrent?: boolean;
}

export interface SymlinkOperationResult {
  downloadFileId: number;
  downloadPath: string;
  backupPath: string;
  targetPath: string;
  targetMode: SymlinkTargetMode;
  torrentHash: string | null;
  success: boolean;
  rolledBack: boolean;
  recheckVerified: boolean;
  bytesSaved: number;
  errorMessage?: string;
}

export interface ProcessDuplicatesSummary {
  attempted: number;
  succeeded: number;
  failed: number;
  rolledBack: number;
  bytesReclaimed: number;
  results: SymlinkOperationResult[];
}

/**
 * Dynamically searches torrent_files if a download file didn't have torrent_hash pre-populated.
 */
function resolveFallbackTorrentHash(
  dbFilePath: string,
  pair: PendingDuplicatePair,
): string | null {
  if (pair.torrentHash) return pair.torrentHash;

  return withDatabase(dbFilePath, (db) => {
    if (pair.downloadVirtualPath) {
      const exact = db
        .prepare(
          `SELECT torrent_hash FROM torrent_files
           WHERE LOWER(virtual_path) = LOWER(?)
           LIMIT 1`,
        )
        .get(pair.downloadVirtualPath) as { torrent_hash: string } | undefined;
      if (exact?.torrent_hash) return exact.torrent_hash;
    }

    const byNameSize = db
      .prepare(
        `SELECT torrent_hash FROM torrent_files
         WHERE LOWER(filename) = LOWER(?) AND file_size = ?`,
      )
      .all(pair.downloadFilename, pair.fileSize) as Array<{ torrent_hash: string }>;

    if (byNameSize.length === 1) {
      return byNameSize[0].torrent_hash;
    }
    return null;
  });
}

/**
 * Resolves the target path for a symlink according to targetMode ('virtual' vs 'physical').
 * Falls back to physical path if the virtual path does not exist on the current machine (e.g. in unit tests).
 */
export function resolveTargetPathForMode(
  pair: Pick<PendingDuplicatePair, 'proposedTargetVirtual' | 'proposedTargetPhysical'>,
  targetMode: SymlinkTargetMode,
): { targetPath: string; effectiveMode: SymlinkTargetMode } {
  if (targetMode === 'virtual') {
    if (
      pair.proposedTargetVirtual &&
      fs.existsSync(pair.proposedTargetVirtual)
    ) {
      return { targetPath: pair.proposedTargetVirtual, effectiveMode: 'virtual' };
    }
    // If virtual mount isn't mounted in a test environment, check if proposedTargetVirtual is explicitly desired or fall back
    if (pair.proposedTargetVirtual && !fs.existsSync(pair.proposedTargetPhysical)) {
      return { targetPath: pair.proposedTargetVirtual, effectiveMode: 'virtual' };
    }
  }
  return {
    targetPath:
      targetMode === 'virtual' && fs.existsSync(pair.proposedTargetVirtual)
        ? pair.proposedTargetVirtual
        : pair.proposedTargetPhysical,
    effectiveMode:
      targetMode === 'virtual' && fs.existsSync(pair.proposedTargetVirtual)
        ? 'virtual'
        : 'physical',
  };
}

export async function processDuplicates(
  config: AppConfig,
  options: ProcessDuplicatesOptions = {},
): Promise<ProcessDuplicatesSummary> {
  const allPairs = getPendingDuplicatePairs(config);
  const filterSet = options.fileIds ? new Set(options.fileIds) : null;
  const pairs = filterSet
    ? allPairs.filter((p) => filterSet.has(p.downloadFileId))
    : allPairs;

  if (pairs.length === 0) {
    return {
      attempted: 0,
      succeeded: 0,
      failed: 0,
      rolledBack: 0,
      bytesReclaimed: 0,
      results: [],
    };
  }

  const targetMode = options.targetMode ?? config.symlinkTargetMode;
  const pauseAll = options.pauseAll ?? config.pauseAllTorrents;
  const verifyRecheck = options.verifyRecheck ?? config.verifyRecheckBeforeResume;
  const recheckTimeoutMs = options.recheckTimeoutMs ?? 30000;

  // Group pairs by torrent hash
  const groups = new Map<string, PendingDuplicatePair[]>();
  for (const p of pairs) {
    const tHash = resolveFallbackTorrentHash(config.dbFilePath, p) ?? '__NO_TORRENT__';
    p.torrentHash = tHash === '__NO_TORRENT__' ? null : tHash;
    const arr = groups.get(tHash) ?? [];
    arr.push(p);
    groups.set(tHash, arr);
  }

  let qbit: IQBittorrentClient | null = null;
  if (!options.skipQbittorrent) {
    qbit = options.qbitClient !== undefined ? options.qbitClient : new QBittorrentClient(config);
    if (qbit) {
      const ok = await qbit.login();
      if (!ok) {
        qbit = null;
      }
    }
  }

  const results: SymlinkOperationResult[] = [];
  let succeeded = 0;
  let failed = 0;
  let rolledBack = 0;
  let bytesReclaimed = 0;

  if (qbit && pauseAll) {
    await qbit.pauseTorrents('all');
  }

  try {
    for (const [groupKey, groupPairs] of groups.entries()) {
      const hasTorrent = groupKey !== '__NO_TORRENT__';
      if (qbit && hasTorrent && !pauseAll) {
        await qbit.pauseTorrents([groupKey]);
      }

      const groupResults: SymlinkOperationResult[] = [];

      for (const pair of groupPairs) {
        const downloadPath = pair.downloadFullPath;
        const backupPath = `${downloadPath}${config.backupSuffix}`;
        const { targetPath, effectiveMode } = resolveTargetPathForMode(pair, targetMode);

        // Verify source and target exist before touching download file
        if (!fs.existsSync(pair.mediaFullPath) && !fs.existsSync(targetPath)) {
          const errRes: SymlinkOperationResult = {
            downloadFileId: pair.downloadFileId,
            downloadPath,
            backupPath,
            targetPath,
            targetMode: effectiveMode,
            torrentHash: pair.torrentHash,
            success: false,
            rolledBack: false,
            recheckVerified: false,
            bytesSaved: 0,
            errorMessage: `Target media file missing: ${targetPath}`,
          };
          groupResults.push(errRes);
          results.push(errRes);
          failed++;
          withDatabase(config.dbFilePath, (db) => {
            db.prepare(
              `UPDATE files SET status = 'error_symlink', error_message = ? WHERE id = ?`,
            ).run(errRes.errorMessage!, pair.downloadFileId);
          });
          continue;
        }

        if (!fs.existsSync(downloadPath)) {
          const errRes: SymlinkOperationResult = {
            downloadFileId: pair.downloadFileId,
            downloadPath,
            backupPath,
            targetPath,
            targetMode: effectiveMode,
            torrentHash: pair.torrentHash,
            success: false,
            rolledBack: false,
            recheckVerified: false,
            bytesSaved: 0,
            errorMessage: `Download source file missing: ${downloadPath}`,
          };
          groupResults.push(errRes);
          results.push(errRes);
          failed++;
          withDatabase(config.dbFilePath, (db) => {
            db.prepare(
              `UPDATE files SET status = 'error_symlink', error_message = ? WHERE id = ?`,
            ).run(errRes.errorMessage!, pair.downloadFileId);
          });
          continue;
        }

        let renamedToBak = false;
        try {
          if (fs.existsSync(backupPath)) {
            fs.unlinkSync(backupPath);
          }
          fs.renameSync(downloadPath, backupPath);
          renamedToBak = true;

          fs.symlinkSync(targetPath, downloadPath, 'file');

          const opRes: SymlinkOperationResult = {
            downloadFileId: pair.downloadFileId,
            downloadPath,
            backupPath,
            targetPath,
            targetMode: effectiveMode,
            torrentHash: pair.torrentHash,
            success: true,
            rolledBack: false,
            recheckVerified: !hasTorrent || !qbit,
            bytesSaved: pair.fileSize,
          };
          groupResults.push(opRes);
          results.push(opRes);
          succeeded++;
          bytesReclaimed += pair.fileSize;
        } catch (err) {
          // Roll back .bak -> original if symlink creation failed
          if (renamedToBak && fs.existsSync(backupPath) && !fs.existsSync(downloadPath)) {
            try {
              fs.renameSync(backupPath, downloadPath);
            } catch {
              // Keep .bak intact if rename back fails
            }
          }
          const msg = (err as Error).message;
          const errRes: SymlinkOperationResult = {
            downloadFileId: pair.downloadFileId,
            downloadPath,
            backupPath,
            targetPath,
            targetMode: effectiveMode,
            torrentHash: pair.torrentHash,
            success: false,
            rolledBack: renamedToBak,
            recheckVerified: false,
            bytesSaved: 0,
            errorMessage: msg,
          };
          groupResults.push(errRes);
          results.push(errRes);
          failed++;
          withDatabase(config.dbFilePath, (db) => {
            db.prepare(
              `UPDATE files SET status = 'error_symlink', error_message = ? WHERE id = ?`,
            ).run(msg, pair.downloadFileId);
          });
        }
      }

      const successfulInGroup = groupResults.filter((r) => r.success);

      // Trigger recheck & optionally verify before resuming
      let recheckVerified = true;
      if (qbit && hasTorrent && successfulInGroup.length > 0) {
        await qbit.recheckTorrents([groupKey]);
        if (verifyRecheck) {
          const checkOutcome = await qbit.waitForRecheckCompletion(
            [groupKey],
            recheckTimeoutMs,
          );
          recheckVerified = checkOutcome.verified;
        }
      }

      if (!recheckVerified && verifyRecheck) {
        // Roll back every symlink in this torrent group from .bak!
        for (const op of successfulInGroup) {
          try {
            if (fs.lstatSync(op.downloadPath).isSymbolicLink()) {
              fs.unlinkSync(op.downloadPath);
            }
            if (fs.existsSync(op.backupPath)) {
              fs.renameSync(op.backupPath, op.downloadPath);
            }
            op.success = false;
            op.rolledBack = true;
            op.recheckVerified = false;
            op.errorMessage = 'Rolled back: qBittorrent recheck failed (< 100% progress)';
            succeeded--;
            failed++;
            rolledBack++;
            bytesReclaimed -= op.bytesSaved;
            op.bytesSaved = 0;

            withDatabase(config.dbFilePath, (db) => {
              db.prepare(
                `UPDATE files
                 SET status = 'error_recheck_rollback',
                     is_symlink = 0,
                     symlink_target = NULL,
                     error_message = ?
                 WHERE id = ?`,
              ).run(op.errorMessage ?? 'Rolled back', op.downloadFileId);
            });
          } catch (rbErr) {
            op.errorMessage = `Recheck failed and rollback encountered error: ${(rbErr as Error).message}`;
          }
        }

        if (qbit && hasTorrent) {
          await qbit.recheckTorrents([groupKey]);
        }
      } else {
        // Persist successful symlink records to DB
        withDatabase(config.dbFilePath, (db) => {
          const updateFileStmt = db.prepare(`
            UPDATE files
            SET status = 'symlinked',
                is_symlink = 1,
                symlink_target = ?,
                error_message = NULL
            WHERE id = ?
          `);

          const insertHistoryStmt = db.prepare(`
            INSERT INTO symlink_history (
              download_file_id, download_path, virtual_download_path, backup_path,
              target_path, target_mode, file_size, xxh128_hash, torrent_hash,
              bak_status, recheck_verified
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'present', ?)
          `);

          db.exec('BEGIN IMMEDIATE TRANSACTION;');
          try {
            for (const op of successfulInGroup) {
              op.recheckVerified = recheckVerified;
              const pair = groupPairs.find((p) => p.downloadFileId === op.downloadFileId)!;
              updateFileStmt.run(op.targetPath, op.downloadFileId);
              insertHistoryStmt.run(
                op.downloadFileId,
                op.downloadPath,
                pair.downloadVirtualPath ?? null,
                op.backupPath,
                op.targetPath,
                op.targetMode,
                pair.fileSize,
                pair.xxh128Hash,
                op.torrentHash,
                recheckVerified ? 1 : 0,
              );
            }
            db.exec('COMMIT;');
          } catch (err) {
            db.exec('ROLLBACK;');
            throw err;
          }
        });
      }

      if (qbit && hasTorrent && !pauseAll) {
        await qbit.resumeTorrents([groupKey]);
      }
    }
  } finally {
    if (qbit && pauseAll) {
      await qbit.resumeTorrents('all');
    }
  }

  return {
    attempted: pairs.length,
    succeeded,
    failed,
    rolledBack,
    bytesReclaimed,
    results,
  };
}
