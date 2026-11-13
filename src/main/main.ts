import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import path from 'node:path';
import {
  AppConfig,
  BrokenSymlinkReportItem,
  cleanupBackupFiles,
  convertExistingSymlinkTargets,
  createDefaultConfig,
  deleteOrphanedFiles,
  discoverDrivePoolPaths,
  exportDriveDisasterRecoveryManifest,
  findIntraMediaDuplicates,
  findOrphanedDownloads,
  getDriveRecoveryCatalogSummary,
  getPendingDuplicatePairs,
  getStatusCounts,
  hashUnHashedFilesPerDrive,
  healBrokenSymlinks,
  identifyAndLinkDuplicates,
  initializeDatabase,
  listBakFiles,
  loadPersistedSettings,
  processDuplicates,
  restoreBakFiles,
  runFileScan,
  runSymlinkTargetSandboxTest,
  savePersistedSettings,
  scanBrokenSymlinks,
  SymlinkTargetMode,
  updateDbWithTorrentInfo,
  resolveIntraMediaDuplicateSet,
} from '../core';

let mainWindow: BrowserWindow | null = null;
let currentConfig: AppConfig = createDefaultConfig(process.cwd());
let activeHashAbortController: AbortController | null = null;

function bootstrapDatabaseAndConfig(): void {
  initializeDatabase(currentConfig.dbFilePath);
  currentConfig = loadPersistedSettings(currentConfig.dbFilePath, currentConfig);
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1100,
    minHeight: 720,
    backgroundColor: '#0b0f19',
    title: 'Media Symlinker v3',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  const devServerUrl = process.env.VITE_DEV_SERVER_URL;
  if (devServerUrl) {
    void mainWindow.loadURL(devServerUrl);
  } else {
    void mainWindow.loadFile(path.join(__dirname, '../../dist/index.html'));
  }
}

function registerIpcHandlers(): void {
  ipcMain.handle('config:get', () => currentConfig);

  ipcMain.handle('config:update', (_e, partial: Partial<AppConfig>) => {
    currentConfig = { ...currentConfig, ...partial };
    savePersistedSettings(currentConfig.dbFilePath, partial);
    return currentConfig;
  });

  ipcMain.handle('config:discover-drives', () => {
    const discovered = discoverDrivePoolPaths();
    if (Object.keys(discovered).length > 0) {
      currentConfig = { ...currentConfig, physicalDrivePaths: discovered };
      savePersistedSettings(currentConfig.dbFilePath, {
        physicalDrivePaths: discovered,
      });
    }
    return currentConfig.physicalDrivePaths;
  });

  ipcMain.handle('db:status-counts', () => {
    return getStatusCounts(currentConfig.dbFilePath);
  });

  ipcMain.handle(
    'pipeline:scan',
    (_e, options?: { useEverythingSdk?: boolean; pruneMissing?: boolean }) => {
      return runFileScan(currentConfig, options);
    },
  );

  ipcMain.handle(
    'pipeline:hash',
    async (
      _e,
      options?: { strategy?: 'smart_candidates' | 'full_library'; driveFilter?: string[] },
    ) => {
      activeHashAbortController = new AbortController();
      try {
        return await hashUnHashedFilesPerDrive(currentConfig, {
          strategy: options?.strategy ?? currentConfig.hashStrategy,
          driveFilter: options?.driveFilter,
          signal: activeHashAbortController.signal,
          onProgress: (progress) => {
            mainWindow?.webContents.send('hash:progress', progress);
          },
        });
      } finally {
        activeHashAbortController = null;
      }
    },
  );

  ipcMain.handle('pipeline:cancel-hash', () => {
    if (activeHashAbortController) {
      activeHashAbortController.abort();
      return true;
    }
    return false;
  });

  ipcMain.handle('pipeline:sync-torrents', async () => {
    return await updateDbWithTorrentInfo(currentConfig);
  });

  ipcMain.handle(
    'pipeline:find-duplicates',
    async (_e, options?: { forceRelink?: boolean }) => {
      return await identifyAndLinkDuplicates(currentConfig, options);
    },
  );

  ipcMain.handle('pipeline:pending-duplicates', () => {
    return getPendingDuplicatePairs(currentConfig);
  });

  ipcMain.handle(
    'pipeline:process-duplicates',
    async (
      _e,
      options?: {
        fileIds?: number[];
        targetMode?: SymlinkTargetMode;
        pauseAll?: boolean;
        verifyRecheck?: boolean;
      },
    ) => {
      return await processDuplicates(currentConfig, options);
    },
  );

  // Priority #1: Broken Symlink Healer
  ipcMain.handle('healer:scan', () => {
    return scanBrokenSymlinks(currentConfig);
  });

  ipcMain.handle(
    'healer:heal',
    (_e, items: BrokenSymlinkReportItem[], targetMode?: SymlinkTargetMode) => {
      return healBrokenSymlinks(currentConfig, items, targetMode);
    },
  );

  // Priority #2: .bak Safety Vault
  ipcMain.handle('vault:list', () => {
    return listBakFiles(currentConfig);
  });

  ipcMain.handle('vault:restore', async (_e, backupPaths: string[]) => {
    return await restoreBakFiles(currentConfig, backupPaths);
  });

  ipcMain.handle(
    'vault:cleanup',
    (_e, options?: { backupPaths?: string[]; requireHealthySymlink?: boolean }) => {
      return cleanupBackupFiles(currentConfig, options);
    },
  );

  // Priority #3: Orphaned Downloads Finder
  ipcMain.handle('orphans:find', () => {
    return findOrphanedDownloads(currentConfig);
  });

  ipcMain.handle('orphans:delete', (_e, fileIds: number[]) => {
    return deleteOrphanedFiles(currentConfig, fileIds);
  });

  // Priority #4: Symlink Target Mode Tester & Converter
  ipcMain.handle('target:sandbox-test', async () => {
    return await runSymlinkTargetSandboxTest(currentConfig);
  });

  ipcMain.handle(
    'target:convert',
    (_e, desiredMode: SymlinkTargetMode, fileIds?: number[]) => {
      return convertExistingSymlinkTargets(currentConfig, desiredMode, fileIds);
    },
  );

  // Priority #5: Intra-Media Duplicate Manager
  ipcMain.handle('intramedia:find', () => {
    return findIntraMediaDuplicates(currentConfig);
  });

  ipcMain.handle(
    'intramedia:resolve',
    (
      _e,
      keepFileId: number,
      redundantFileIds: number[],
      action: 'symlink' | 'delete',
      targetMode?: SymlinkTargetMode,
    ) => {
      return resolveIntraMediaDuplicateSet(
        currentConfig,
        keepFileId,
        redundantFileIds,
        action,
        targetMode,
      );
    },
  );

  // Feature #6: Drive Disaster Recovery Catalog
  ipcMain.handle('catalog:summary', () => {
    return getDriveRecoveryCatalogSummary(currentConfig);
  });

  ipcMain.handle(
    'catalog:export',
    async (_e, driveLetter: string, outputPath?: string) => {
      let targetOutput = outputPath;
      if (!targetOutput && mainWindow) {
        const res = await dialog.showSaveDialog(mainWindow, {
          title: `Export Drive ${driveLetter} Disaster Recovery Manifest`,
          defaultPath: `drive_${driveLetter}_recovery_manifest.json`,
          filters: [{ name: 'JSON Manifest', extensions: ['json'] }],
        });
        if (res.canceled || !res.filePath) {
          return null;
        }
        targetOutput = res.filePath;
      }
      targetOutput =
        targetOutput ??
        path.join(process.cwd(), `drive_${driveLetter}_recovery_manifest.json`);
      return exportDriveDisasterRecoveryManifest(
        currentConfig,
        driveLetter,
        targetOutput,
      );
    },
  );
}

app.whenReady().then(() => {
  bootstrapDatabaseAndConfig();
  registerIpcHandlers();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
