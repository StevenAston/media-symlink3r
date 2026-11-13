import { parentPort, workerData } from 'node:worker_threads';
import {
  AppConfig,
  BrokenSymlinkReportItem,
  cleanupBackupFiles,
  configureLogger,
  convertExistingSymlinkTargets,
  deleteOrphanedFiles,
  exportDriveDisasterRecoveryManifest,
  findIntraMediaDuplicates,
  findOrphanedDownloads,
  getDriveRecoveryCatalogSummary,
  healBrokenSymlinks,
  listBakFiles,
  logger,
  onLogEntry,
  resolveIntraMediaDuplicateSet,
  runFileScan,
  scanBrokenSymlinks,
  ScanOptions,
  SymlinkTargetMode,
} from '../core';

interface WorkerPayload {
  action: string;
  config: AppConfig;
  args: unknown[];
}

function execute(): void {
  if (!parentPort) return;
  const payload = workerData as WorkerPayload;
  const { action, config, args } = payload;

  configureLogger(config.logFilePath);
  const unsub = onLogEntry((entry) => {
    parentPort?.postMessage({ type: 'log', entry });
  });

  try {
    let result: unknown;
    switch (action) {
      case 'scan': {
        const options = (args[0] as ScanOptions) ?? {};
        result = runFileScan(config, options, (driveLetter, source, summary) => {
          parentPort?.postMessage({
            type: 'scan-progress',
            data: { driveLetter, source, summary },
          });
        });
        break;
      }
      case 'healer:scan': {
        logger.info('Healer', 'Scanning symlinks across database and pool drives...');
        const items = scanBrokenSymlinks(config);
        logger.success(
          'Healer',
          `Symlink scan complete: ${items.length} broken/rebalanced/corrupted symlinks detected.`,
        );
        result = items;
        break;
      }
      case 'healer:heal': {
        const items = (args[0] as BrokenSymlinkReportItem[]) ?? [];
        const targetMode = (args[1] as SymlinkTargetMode) ?? config.symlinkTargetMode;
        logger.info('Healer', `Auto-healing ${items.length} symlinks (mode=${targetMode})...`);
        const res = healBrokenSymlinks(config, items, targetMode);
        logger.success(
          'Healer',
          `Auto-heal complete: ${res.healed} healed, ${res.restoredFromBak} restored from .bak, ${res.failed} failed.`,
        );
        result = res;
        break;
      }
      case 'vault:list': {
        logger.info('Vault', 'Inspecting .bak safety vault and active symlink targets...');
        const list = listBakFiles(config);
        logger.success('Vault', `Found ${list.length} .bak backup files.`);
        result = list;
        break;
      }
      case 'vault:cleanup': {
        const opts = (args[0] as { backupPaths?: string[]; requireHealthySymlink?: boolean }) ?? {};
        logger.info('Vault', 'Purging verified .bak files...');
        const res = cleanupBackupFiles(config, opts);
        logger.success(
          'Vault',
          `Purged ${res.deleted} .bak files (${res.skippedUnsafe} unsafe skipped).`,
        );
        result = res;
        break;
      }
      case 'orphans:find': {
        logger.info('Orphans', 'Scanning for orphaned downloads untracked by qBittorrent...');
        const list = findOrphanedDownloads(config);
        logger.success('Orphans', `Found ${list.length} orphaned download files.`);
        result = list;
        break;
      }
      case 'orphans:delete': {
        const fileIds = (args[0] as number[]) ?? [];
        logger.info('Orphans', `Deleting ${fileIds.length} orphaned download files...`);
        const res = deleteOrphanedFiles(config, fileIds);
        logger.success('Orphans', `Deleted ${res.deleted} orphaned files.`);
        result = res;
        break;
      }
      case 'target:convert': {
        const desiredMode = (args[0] as SymlinkTargetMode) ?? 'virtual';
        const fileIds = args[1] as number[] | undefined;
        logger.info('TargetMode', `Converting existing symlinks to '${desiredMode}' target mode...`);
        const res = convertExistingSymlinkTargets(config, desiredMode, fileIds);
        logger.success(
          'TargetMode',
          `Converted ${res.converted} symlinks (${res.alreadyInTargetMode} already in ${desiredMode} mode).`,
        );
        result = res;
        break;
      }
      case 'intramedia:find': {
        logger.info('IntraMedia', 'Querying duplicate file sets within Media library...');
        const groups = findIntraMediaDuplicates(config);
        logger.success('IntraMedia', `Found ${groups.length} duplicate sets inside Media.`);
        result = groups;
        break;
      }
      case 'intramedia:resolve': {
        const keepFileId = args[0] as number;
        const redundantFileIds = (args[1] as number[]) ?? [];
        const act = (args[2] as 'symlink' | 'delete') ?? 'symlink';
        const targetMode = (args[3] as SymlinkTargetMode) ?? config.symlinkTargetMode;
        logger.info(
          'IntraMedia',
          `Resolving Intra-Media duplicate set (keep=${keepFileId}, action=${act})...`,
        );
        const res = resolveIntraMediaDuplicateSet(
          config,
          keepFileId,
          redundantFileIds,
          act,
          targetMode,
        );
        logger.success('IntraMedia', `Processed ${res.processed} redundant Media copies.`);
        result = res;
        break;
      }
      case 'catalog:summary': {
        result = getDriveRecoveryCatalogSummary(config);
        break;
      }
      case 'catalog:export': {
        const driveLetter = (args[0] as string) ?? 'ALL';
        const outputPath = args[1] as string;
        logger.info('Catalog', `Exporting Drive ${driveLetter} recovery manifest to ${outputPath}...`);
        const res = exportDriveDisasterRecoveryManifest(config, driveLetter, outputPath);
        logger.success(
          'Catalog',
          `Exported ${res.totalExported.toLocaleString()} records to ${res.outputPath}.`,
        );
        result = res;
        break;
      }
      default:
        throw new Error(`Unknown worker action: ${action}`);
    }

    parentPort.postMessage({ type: 'result', data: result });
  } catch (err) {
    logger.error('Worker', `Error in ${action}: ${(err as Error).message}`);
    parentPort.postMessage({ type: 'error', error: (err as Error).message });
  } finally {
    unsub();
  }
}

execute();
