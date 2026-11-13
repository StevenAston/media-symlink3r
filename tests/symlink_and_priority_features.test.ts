import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AppConfig,
  cleanupBackupFiles,
  convertExistingSymlinkTargets,
  createDefaultConfig,
  deleteOrphanedFiles,
  exportDriveDisasterRecoveryManifest,
  findIntraMediaDuplicates,
  findOrphanedDownloads,
  getDriveRecoveryCatalogSummary,
  hashUnHashedFilesPerDrive,
  healBrokenSymlinks,
  identifyAndLinkDuplicates,
  initializeDatabase,
  IQBittorrentClient,
  listBakFiles,
  processDuplicates,
  resolveIntraMediaDuplicateSet,
  restoreBakFiles,
  runFileScan,
  runSymlinkTargetSandboxTest,
  scanBrokenSymlinks,
  updateDbWithTorrentInfo,
  withDatabase,
} from '../src/core';

describe('symlinkProcessor.ts & Priority Features #1-#6', () => {
  let tempDir: string;
  let config: AppConfig;
  let poolPartD: string;
  let poolPartU: string;
  let virtualRoot: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-v3-priority-test-'));
    poolPartD = path.join(tempDir, 'DriveD', 'PoolPart.bff64b92-d745-4ff9-933b-ae092c32cfc7');
    poolPartU = path.join(tempDir, 'DriveU', 'PoolPart.6610f243-02f1-4552-ae81-c9fdae7722fe');
    virtualRoot = path.join(tempDir, 'VirtualM');

    fs.mkdirSync(path.join(poolPartD, 'Downloads'), { recursive: true });
    fs.mkdirSync(path.join(poolPartD, 'Media'), { recursive: true });
    fs.mkdirSync(path.join(poolPartU, 'Downloads'), { recursive: true });
    fs.mkdirSync(path.join(poolPartU, 'Media'), { recursive: true });
    fs.mkdirSync(path.join(virtualRoot, 'Downloads'), { recursive: true });
    fs.mkdirSync(path.join(virtualRoot, 'Media'), { recursive: true });

    config = {
      ...createDefaultConfig(tempDir),
      physicalDrivePaths: {
        D: poolPartD,
        U: poolPartU,
      },
      virtualPoolRoot: virtualRoot,
      virtualDownloadsPath: path.join(virtualRoot, 'Downloads'),
      virtualMediaPath: path.join(virtualRoot, 'Media'),
      symlinkTargetMode: 'virtual',
    };
    initializeDatabase(config.dbFilePath);
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('processes duplicates into symlinks with .bak safety vault and rolls back automatically if torrent recheck fails', async () => {
    const payload = Buffer.from('this is the test content');
    const dlFile = path.join(poolPartD, 'Downloads', 'Show.S01E01.mkv');
    const mediaFile = path.join(poolPartU, 'Media', 'Show.S01E01.mkv');
    const virtualMediaFile = path.join(virtualRoot, 'Media', 'Show.S01E01.mkv');

    fs.writeFileSync(dlFile, payload);
    fs.writeFileSync(mediaFile, payload);
    fs.writeFileSync(virtualMediaFile, payload);

    runFileScan(config, { useEverythingSdk: false });
    await hashUnHashedFilesPerDrive(config, { strategy: 'smart_candidates' });

    let shouldFailRecheck = true;
    const mockQbit: IQBittorrentClient = {
      login: async () => true,
      getVersion: async () => 'v5.0.0',
      getTorrents: async () => [
        {
          hash: 't_hash_1',
          name: 'Show.S01E01.mkv',
          save_path: config.virtualDownloadsPath,
          state: 'stalledUP',
          progress: shouldFailRecheck ? 0.0 : 1.0,
        },
      ],
      getTorrentFiles: async () => [{ name: 'Show.S01E01.mkv', size: payload.length }],
      pauseTorrents: async () => true,
      resumeTorrents: async () => true,
      recheckTorrents: async () => true,
      waitForRecheckCompletion: async () => ({
        verified: !shouldFailRecheck,
        states: {
          t_hash_1: {
            state: shouldFailRecheck ? 'missingFiles' : 'stalledUP',
            progress: shouldFailRecheck ? 0 : 1,
          },
        },
      }),
    };

    await updateDbWithTorrentInfo(config, mockQbit);
    await identifyAndLinkDuplicates(config);

    // 1. First run: recheck fails -> automatic rollback from .bak!
    const failedRun = await processDuplicates(config, {
      qbitClient: mockQbit,
      verifyRecheck: true,
    });
    expect(failedRun.rolledBack).toBe(1);
    expect(failedRun.succeeded).toBe(0);
    expect(fs.lstatSync(dlFile).isSymbolicLink()).toBe(false);
    expect(fs.existsSync(`${dlFile}.bak`)).toBe(false);

    // 2. Second run: recheck passes -> symlink + .bak persisted!
    shouldFailRecheck = false;
    await identifyAndLinkDuplicates(config, { forceRelink: true });
    const successRun = await processDuplicates(config, {
      qbitClient: mockQbit,
      verifyRecheck: true,
      targetMode: 'virtual',
    });
    expect(successRun.succeeded).toBe(1);
    expect(fs.lstatSync(dlFile).isSymbolicLink()).toBe(true);
    expect(fs.existsSync(`${dlFile}.bak`)).toBe(true);
    expect(fs.readFileSync(dlFile).equals(payload)).toBe(true);

    // Priority #2: .bak Safety Vault list, Undo/Restore, and Cleanup
    const vaultItems = listBakFiles(config);
    expect(vaultItems).toHaveLength(1);
    expect(vaultItems[0].safeToDeleteBak).toBe(true);

    // Test 1-Click Undo (Restore .bak)
    const restoreRes = await restoreBakFiles(config, [vaultItems[0].backupPath], mockQbit);
    expect(restoreRes.restored).toBe(1);
    expect(fs.lstatSync(dlFile).isSymbolicLink()).toBe(false);
    expect(fs.existsSync(`${dlFile}.bak`)).toBe(false);

    // Re-create symlink and test safe .bak purge
    await identifyAndLinkDuplicates(config, { forceRelink: true });
    await processDuplicates(config, { qbitClient: mockQbit, verifyRecheck: true });
    const purgeRes = cleanupBackupFiles(config, { requireHealthySymlink: true });
    expect(purgeRes.deleted).toBe(1);
    expect(fs.existsSync(`${dlFile}.bak`)).toBe(false);
  });

  it('Priority #1: detects and auto-heals DrivePool-rebalanced, 0-byte corrupted, and renamed symlinks', async () => {
    const realPayload = Buffer.from('this is the test content');

    // Case A: DrivePool Rebalanced symlink (target was on DriveD PoolPart, moved to DriveU PoolPart & VirtualM)
    const dlRebalanced = path.join(poolPartD, 'Downloads', 'DanDaDan.S02E02.mkv');
    const oldMissingTarget = path.join(poolPartD, 'Media', 'DanDaDan.S02E02.mkv');
    const newMovedTargetU = path.join(poolPartU, 'Media', 'DanDaDan.S02E02.mkv');
    const newVirtualTarget = path.join(virtualRoot, 'Media', 'DanDaDan.S02E02.mkv');

    fs.writeFileSync(newMovedTargetU, realPayload);
    fs.writeFileSync(newVirtualTarget, realPayload);
    fs.symlinkSync(oldMissingTarget, dlRebalanced, 'file'); // Points to missing DriveD target!

    // Case B: 0-byte corrupted symlink (points to 0-byte .srt while real Media .mkv exists in DB)
    const dlCorrupted0Byte = path.join(poolPartD, 'Downloads', 'BrokenZeroByte.mkv');
    const zeroByteSrt = path.join(poolPartU, 'Media', 'PrivateLifeOfPlants.en.srt');
    const realMediaForCorrupted = path.join(poolPartU, 'Media', 'BrokenZeroByte.mkv');
    fs.writeFileSync(zeroByteSrt, Buffer.alloc(0));
    fs.writeFileSync(realMediaForCorrupted, realPayload);
    fs.symlinkSync(zeroByteSrt, dlCorrupted0Byte, 'file');

    runFileScan(config, { useEverythingSdk: false });
    await hashUnHashedFilesPerDrive(config, { strategy: 'full_library' });

    const brokenReport = scanBrokenSymlinks(config);
    expect(brokenReport.length).toBeGreaterThanOrEqual(2);

    const rebalancedItem = brokenReport.find((b) => b.symlinkPath === dlRebalanced);
    expect(rebalancedItem?.classification).toBe('drivepool_rebalanced');
    expect(rebalancedItem?.canAutoHeal).toBe(true);

    const zeroByteItem = brokenReport.find((b) => b.symlinkPath === dlCorrupted0Byte);
    expect(zeroByteItem?.classification).toBe('covefs_0byte_corrupted');
    expect(zeroByteItem?.canAutoHeal).toBe(true);

    const healSummary = healBrokenSymlinks(config, brokenReport, 'virtual');
    expect(healSummary.healed).toBe(2);
    expect(fs.readFileSync(dlRebalanced).equals(realPayload)).toBe(true);
    expect(fs.readFileSync(dlCorrupted0Byte).equals(realPayload)).toBe(true);
  });

  it('Priority #3: finds orphaned downloads (already_in_media vs unique_to_downloads) and deletes selected', async () => {
    const dupContent = Buffer.from('this is the test content');
    const orphanInMedia = path.join(poolPartD, 'Downloads', 'OrphanCopy.mkv');
    const canonicalMedia = path.join(poolPartU, 'Media', 'OrphanCopy.mkv');
    const orphanUnique = path.join(poolPartD, 'Downloads', 'UnimportedGrab.mkv');

    fs.writeFileSync(orphanInMedia, dupContent);
    fs.writeFileSync(canonicalMedia, dupContent);
    fs.writeFileSync(orphanUnique, Buffer.from('unique-unimported-content'));

    runFileScan(config, { useEverythingSdk: false });
    await hashUnHashedFilesPerDrive(config, { strategy: 'full_library' });

    const orphans = findOrphanedDownloads(config);
    expect(orphans).toHaveLength(2);

    const safeOrphan = orphans.find((o) => o.filename === 'OrphanCopy.mkv')!;
    const uniqueOrphan = orphans.find((o) => o.filename === 'UnimportedGrab.mkv')!;
    expect(safeOrphan.classification).toBe('already_in_media');
    expect(uniqueOrphan.classification).toBe('unique_to_downloads');

    const delSummary = deleteOrphanedFiles(config, [safeOrphan.fileId]);
    expect(delSummary.deleted).toBe(1);
    expect(fs.existsSync(orphanInMedia)).toBe(false);
    expect(fs.existsSync(orphanUnique)).toBe(true);
  });

  it('Priority #4: runs symlink target sandbox test and batch-converts existing symlink targets', async () => {
    const sandboxRes = await runSymlinkTargetSandboxTest(config);
    expect(sandboxRes.canCreateSymlinks).toBe(true);
    expect(sandboxRes.virtualTargetReadPassed).toBe(true);
    expect(sandboxRes.physicalTargetReadPassed).toBe(true);
    expect(sandboxRes.hashVerificationPassed).toBe(true);
    expect(sandboxRes.physicalBreaksOnRebalance).toBe(true);
    expect(sandboxRes.virtualSurvivesRebalance).toBe(true);

    // Create a physical-target symlink and convert it to virtual target mode
    const payload = Buffer.from('this is the test content');
    const physMedia = path.join(poolPartU, 'Media', 'ConvertMe.mkv');
    const virtMedia = path.join(virtualRoot, 'Media', 'ConvertMe.mkv');
    const dlLink = path.join(poolPartD, 'Downloads', 'ConvertMe.mkv');

    fs.writeFileSync(physMedia, payload);
    fs.writeFileSync(virtMedia, payload);
    fs.symlinkSync(physMedia, dlLink, 'file');

    runFileScan(config, { useEverythingSdk: false });

    const toVirtual = convertExistingSymlinkTargets(config, 'virtual');
    expect(toVirtual.converted).toBe(1);
    expect(fs.readlinkSync(dlLink).replace(/^\\\\\?\\/, '').toLowerCase()).toBe(
      virtMedia.toLowerCase(),
    );

    const toPhysical = convertExistingSymlinkTargets(config, 'physical');
    expect(toPhysical.converted).toBe(1);
    expect(fs.readlinkSync(dlLink).replace(/^\\\\\?\\/, '').toLowerCase()).toBe(
      physMedia.toLowerCase(),
    );
  });

  it('Priority #5 & #6: manages intra-media duplicates and exports drive disaster recovery manifest', async () => {
    const payload = Buffer.from('this is the test content');
    const mediaCopy1 = path.join(poolPartD, 'Media', 'MovieCopy1.mkv');
    const mediaCopy2 = path.join(poolPartU, 'Media', 'MovieCopy2.mkv');
    const uniqueOnD = path.join(poolPartD, 'Media', 'OnlyOnDriveD.mkv');

    fs.writeFileSync(mediaCopy1, payload);
    fs.writeFileSync(mediaCopy2, payload);
    fs.writeFileSync(uniqueOnD, Buffer.from('unique-to-drive-d-only'));

    runFileScan(config, { useEverythingSdk: false });
    await hashUnHashedFilesPerDrive(config, { strategy: 'full_library' });

    // Feature #6: Drive Disaster Recovery Catalog Summary & Export
    const catalog = getDriveRecoveryCatalogSummary(config);
    const driveD = catalog.find((c) => c.drive === 'D')!;
    expect(driveD.totalFiles).toBe(2);
    expect(driveD.coveragePercent).toBe(100);
    expect(driveD.duplicatedOnOtherDriveFiles).toBe(1);
    expect(driveD.uniqueFilesAtRisk).toBe(1);

    const manifestPath = path.join(tempDir, 'drive_D_manifest.json');
    const exportRes = exportDriveDisasterRecoveryManifest(config, 'D', manifestPath);
    expect(exportRes.totalExported).toBe(2);
    expect(exportRes.uniqueAtRiskCount).toBe(1);
    expect(fs.existsSync(manifestPath)).toBe(true);

    // Priority #5: Intra-Media Duplicate Manager
    const intraGroups = findIntraMediaDuplicates(config);
    expect(intraGroups).toHaveLength(1);
    expect(intraGroups[0].copyCount).toBe(2);
    expect(intraGroups[0].wastedBytes).toBe(payload.length);

    const keepId = intraGroups[0].recommendedKeepId;
    const redIds = intraGroups[0].files.filter((f) => f.id !== keepId).map((f) => f.id);

    const resolveRes = resolveIntraMediaDuplicateSet(
      config,
      keepId,
      redIds,
      'symlink',
      'physical',
    );
    expect(resolveRes.processed).toBe(1);
    expect(resolveRes.bytesReclaimed).toBe(payload.length);
    expect(fs.lstatSync(mediaCopy2).isSymbolicLink()).toBe(true);

    withDatabase(config.dbFilePath, (db) => {
      const historyCount = db
        .prepare('SELECT COUNT(*) AS c FROM symlink_history')
        .get() as { c: number };
      expect(historyCount.c).toBe(1);
    });
  });
});
