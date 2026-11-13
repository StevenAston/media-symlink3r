import { contextBridge, ipcRenderer } from 'electron';

const api = {
  getConfig: () => ipcRenderer.invoke('config:get'),
  updateConfig: (partial: Record<string, unknown>) =>
    ipcRenderer.invoke('config:update', partial),
  discoverDrives: () => ipcRenderer.invoke('config:discover-drives'),
  getStatusCounts: () => ipcRenderer.invoke('db:status-counts'),

  runScan: (options?: { useEverythingSdk?: boolean; pruneMissing?: boolean }) =>
    ipcRenderer.invoke('pipeline:scan', options),
  runHash: (options?: { strategy?: 'smart_candidates' | 'full_library'; driveFilter?: string[] }) =>
    ipcRenderer.invoke('pipeline:hash', options),
  cancelHash: () => ipcRenderer.invoke('pipeline:cancel-hash'),
  syncTorrents: () => ipcRenderer.invoke('pipeline:sync-torrents'),
  findDuplicates: (options?: { forceRelink?: boolean }) =>
    ipcRenderer.invoke('pipeline:find-duplicates', options),
  getPendingDuplicates: () => ipcRenderer.invoke('pipeline:pending-duplicates'),
  processDuplicates: (options?: {
    fileIds?: number[];
    targetMode?: 'virtual' | 'physical';
    pauseAll?: boolean;
    verifyRecheck?: boolean;
  }) => ipcRenderer.invoke('pipeline:process-duplicates', options),

  // Priority #1: Broken Symlink Healer
  scanBrokenSymlinks: () => ipcRenderer.invoke('healer:scan'),
  healBrokenSymlinks: (items: unknown[], targetMode?: 'virtual' | 'physical') =>
    ipcRenderer.invoke('healer:heal', items, targetMode),

  // Priority #2: .bak Safety Vault & Undo
  listBakFiles: () => ipcRenderer.invoke('vault:list'),
  restoreBakFiles: (backupPaths: string[]) =>
    ipcRenderer.invoke('vault:restore', backupPaths),
  cleanupBakFiles: (options?: { backupPaths?: string[]; requireHealthySymlink?: boolean }) =>
    ipcRenderer.invoke('vault:cleanup', options),

  // Priority #3: Orphaned Downloads Finder
  findOrphanedDownloads: () => ipcRenderer.invoke('orphans:find'),
  deleteOrphanedFiles: (fileIds: number[]) =>
    ipcRenderer.invoke('orphans:delete', fileIds),

  // Priority #4: Symlink Target Mode Tester & Converter
  runTargetSandboxTest: () => ipcRenderer.invoke('target:sandbox-test'),
  convertExistingTargets: (desiredMode: 'virtual' | 'physical', fileIds?: number[]) =>
    ipcRenderer.invoke('target:convert', desiredMode, fileIds),

  // Priority #5: Intra-Media Duplicate Manager
  findIntraMediaDuplicates: () => ipcRenderer.invoke('intramedia:find'),
  resolveIntraMediaSet: (
    keepFileId: number,
    redundantFileIds: number[],
    action: 'symlink' | 'delete',
    targetMode?: 'virtual' | 'physical',
  ) =>
    ipcRenderer.invoke(
      'intramedia:resolve',
      keepFileId,
      redundantFileIds,
      action,
      targetMode,
    ),

  // Feature #6: Drive Disaster Recovery Catalog
  getDriveCatalogSummary: () => ipcRenderer.invoke('catalog:summary'),
  exportDriveManifest: (driveLetter: string, outputPath?: string) =>
    ipcRenderer.invoke('catalog:export', driveLetter, outputPath),

  onHashProgress: (callback: (progress: unknown) => void) => {
    const listener = (_event: unknown, data: unknown) => callback(data);
    ipcRenderer.on('hash:progress', listener);
    return () => ipcRenderer.removeListener('hash:progress', listener);
  },
};

contextBridge.exposeInMainWorld('mediaLinker', api);
