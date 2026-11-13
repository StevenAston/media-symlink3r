import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import {
  AppConfig,
  BrokenSymlinkReportItem,
  configureLogger,
  createDefaultConfig,
  discoverDrivePoolPaths,
  getPendingDuplicatePairs,
  getRecentLogs,
  getStatusCounts,
  hashUnHashedFilesPerDrive,
  identifyAndLinkDuplicates,
  initializeDatabase,
  loadPersistedSettings,
  LogEntry,
  logger,
  onLogEntry,
  processDuplicates,
  restoreBakFiles,
  runSymlinkTargetSandboxTest,
  savePersistedSettings,
  SymlinkTargetMode,
  updateDbWithTorrentInfo,
} from '../core';

let mainWindow: BrowserWindow | null = null;
let currentConfig: AppConfig = createDefaultConfig(process.cwd());
let activeHashAbortController: AbortController | null = null;

function runInWorker<T>(action: string, ...args: unknown[]): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const workerPath = path.join(__dirname, 'workerTask.js');
    const worker = new Worker(workerPath, {
      workerData: {
        action,
        config: currentConfig,
        args,
      },
    });

    worker.on('message', (msg: { type: string; entry?: LogEntry; data?: unknown; error?: string }) => {
      if (msg.type === 'log' && msg.entry) {
        mainWindow?.webContents.send('log:entry', msg.entry);
      } else if (msg.type === 'scan-progress') {
        mainWindow?.webContents.send('scan:progress', msg.data);
      } else if (msg.type === 'result') {
        resolve(msg.data as T);
      } else if (msg.type === 'error') {
        reject(new Error(msg.error ?? 'Worker task failed'));
      }
    });

    worker.on('error', (err) => {
      reject(err);
    });

    worker.on('exit', (code) => {
      if (code !== 0) {
        reject(new Error(`Worker stopped with exit code ${code}`));
      }
    });
  });
}

function bootstrapDatabaseAndConfig(): void {
  initializeDatabase(currentConfig.dbFilePath);
  currentConfig = loadPersistedSettings(currentConfig.dbFilePath, currentConfig);
  configureLogger(currentConfig.logFilePath);
  onLogEntry((entry) => {
    mainWindow?.webContents.send('log:entry', entry);
  });
  logger.info(
    'System',
    `Media Symlinker v3 initialized. DB: ${currentConfig.dbFilePath} | Log: ${currentConfig.logFilePath}`,
  );
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1480,
    height: 940,
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

  if (process.env.ELECTRON_SMOKE_TEST === '1') {
    mainWindow.webContents.once('did-finish-load', () => {
      console.log('ELECTRON_SMOKE_TEST: Renderer loaded successfully');
      setTimeout(() => app.quit(), 200);
    });
  }
}

function registerIpcHandlers(): void {
  ipcMain.handle('config:get', () => currentConfig);

  ipcMain.handle('config:update', (_e, partial: Partial<AppConfig>) => {
    currentConfig = { ...currentConfig, ...partial };
    savePersistedSettings(currentConfig.dbFilePath, partial);
    logger.info('Config', `Updated configuration: ${Object.keys(partial).join(', ')}`);
    return currentConfig;
  });

  ipcMain.handle('config:discover-drives', () => {
    const discovered = discoverDrivePoolPaths();
    if (Object.keys(discovered).length > 0) {
      currentConfig = { ...currentConfig, physicalDrivePaths: discovered };
      savePersistedSettings(currentConfig.dbFilePath, {
        physicalDrivePaths: discovered,
      });
      logger.success(
        'Config',
        `Discovered ${Object.keys(discovered).length} PoolPart drives: ${Object.keys(discovered).join(', ')}`,
      );
    }
    return currentConfig.physicalDrivePaths;
  });

  ipcMain.handle('db:status-counts', () => {
    return getStatusCounts(currentConfig.dbFilePath);
  });

  ipcMain.handle('logs:recent', () => {
    return getRecentLogs();
  });

  ipcMain.handle(
    'pipeline:scan',
    async (_e, options?: { useEverythingSdk?: boolean; pruneMissing?: boolean }) => {
      return await runInWorker('scan', options);
    },
  );

  ipcMain.handle(
    'pipeline:hash',
    async (
      _e,
      options?: { strategy?: 'smart_candidates' | 'full_library'; driveFilter?: string[] },
    ) => {
      const strategy = options?.strategy ?? currentConfig.hashStrategy;
      logger.info('Hashing', `Starting per-drive hashing (strategy=${strategy})...`);
      activeHashAbortController = new AbortController();
      try {
        const res = await hashUnHashedFilesPerDrive(currentConfig, {
          strategy,
          driveFilter: options?.driveFilter,
          signal: activeHashAbortController.signal,
          onProgress: (progress) => {
            mainWindow?.webContents.send('hash:progress', progress);
          },
        });
        logger.success(
          'Hashing',
          `Hashing complete: ${res.totalFilesHashed.toLocaleString()} files hashed (${res.candidateCollisionsHashed.toLocaleString()} full collision hashes).`,
        );
        const dupRes = await identifyAndLinkDuplicates(currentConfig);
        logger.success(
          'Duplicates',
          `Auto-linked ${dupRes.duplicatesLinked.toLocaleString()} duplicates after hashing.`,
        );
        return res;
      } finally {
        activeHashAbortController = null;
      }
    },
  );

  ipcMain.handle('pipeline:cancel-hash', () => {
    if (activeHashAbortController) {
      logger.warn('Hashing', 'User requested hashing cancellation...');
      activeHashAbortController.abort();
      return true;
    }
    return false;
  });

  ipcMain.handle('pipeline:sync-torrents', async () => {
    logger.info(
      'qBittorrent',
      `Connecting to qBittorrent at ${currentConfig.qbittorrentHost}:${currentConfig.qbittorrentPort}...`,
    );
    const res = await updateDbWithTorrentInfo(currentConfig);
    logger.success(
      'qBittorrent',
      `Synced ${res.torrentsSynced} torrents (${res.torrentFilesSynced} files; ${res.totalDownloadFilesLinked} download rows linked).`,
    );
    return res;
  });

  ipcMain.handle(
    'pipeline:find-duplicates',
    async (_e, options?: { forceRelink?: boolean }) => {
      logger.info('Duplicates', 'Identifying cross-source duplicates between Downloads and Media...');
      const res = await identifyAndLinkDuplicates(currentConfig, options);
      logger.success(
        'Duplicates',
        `Duplicate search complete: ${res.duplicatesLinked.toLocaleString()} duplicates linked (${res.cleanedUpLinks} stale links cleaned, ${res.onDemandHashed} on-demand full hashes).`,
      );
      return res;
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
      logger.info(
        'Symlinker',
        `Processing duplicate files into symlinks (mode=${options?.targetMode ?? currentConfig.symlinkTargetMode})...`,
      );
      const res = await processDuplicates(currentConfig, options);
      logger.success(
        'Symlinker',
        `Symlink processing finished: ${res.succeeded} succeeded, ${res.rolledBack} rolled back, ${res.failed} failed.`,
      );
      return res;
    },
  );

  // Priority #1: Broken Symlink Healer (Offloaded to Worker Thread)
  ipcMain.handle('healer:scan', async () => {
    return await runInWorker('healer:scan');
  });

  ipcMain.handle(
    'healer:heal',
    async (_e, items: BrokenSymlinkReportItem[], targetMode?: SymlinkTargetMode) => {
      return await runInWorker('healer:heal', items, targetMode);
    },
  );

  // Priority #2: .bak Safety Vault (Offloaded to Worker Thread)
  ipcMain.handle('vault:list', async () => {
    return await runInWorker('vault:list');
  });

  ipcMain.handle('vault:restore', async (_e, backupPaths: string[]) => {
    logger.info('Vault', `Restoring ${backupPaths.length} .bak backup file(s)...`);
    const res = await restoreBakFiles(currentConfig, backupPaths);
    logger.success('Vault', `Restored ${res.restored} original file(s) from .bak.`);
    return res;
  });

  ipcMain.handle(
    'vault:cleanup',
    async (_e, options?: { backupPaths?: string[]; requireHealthySymlink?: boolean }) => {
      return await runInWorker('vault:cleanup', options);
    },
  );

  // Priority #3: Orphaned Downloads Finder (Offloaded to Worker Thread)
  ipcMain.handle('orphans:find', async () => {
    return await runInWorker('orphans:find');
  });

  ipcMain.handle('orphans:delete', async (_e, fileIds: number[]) => {
    return await runInWorker('orphans:delete', fileIds);
  });

  // Priority #4: Symlink Target Mode Tester & Converter
  ipcMain.handle('target:sandbox-test', async () => {
    logger.info('TargetMode', 'Running live symlink target & DrivePool rebalance sandbox test...');
    const res = await runSymlinkTargetSandboxTest(currentConfig);
    logger.success(
      'TargetMode',
      `Sandbox test finished: virtualSurvivesRebalance=${res.virtualSurvivesRebalance}, physicalBreaksOnRebalance=${res.physicalBreaksOnRebalance}.`,
    );
    return res;
  });

  ipcMain.handle(
    'target:convert',
    async (_e, desiredMode: SymlinkTargetMode, fileIds?: number[]) => {
      return await runInWorker('target:convert', desiredMode, fileIds);
    },
  );

  // Priority #5: Intra-Media Duplicate Manager (Offloaded to Worker Thread)
  ipcMain.handle('intramedia:find', async () => {
    return await runInWorker('intramedia:find');
  });

  ipcMain.handle(
    'intramedia:resolve',
    async (
      _e,
      keepFileId: number,
      redundantFileIds: number[],
      action: 'symlink' | 'delete',
      targetMode?: SymlinkTargetMode,
    ) => {
      return await runInWorker(
        'intramedia:resolve',
        keepFileId,
        redundantFileIds,
        action,
        targetMode,
      );
    },
  );

  // Feature #6: Drive Disaster Recovery Catalog (Offloaded to Worker Thread)
  ipcMain.handle('catalog:summary', async () => {
    return await runInWorker('catalog:summary');
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
      return await runInWorker('catalog:export', driveLetter, targetOutput);
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
