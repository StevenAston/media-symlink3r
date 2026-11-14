import fs from 'node:fs';
import path from 'node:path';

export type SymlinkTargetMode = 'virtual' | 'physical';
export type SymlinkLocationMode = 'virtual' | 'physical';
export type HashStrategy = 'smart_candidates' | 'full_library';

export interface QuickHashRule {
  maxFileSizeMiB: number;
  quickHashSizeMiB: number;
}

export interface AppConfig {
  physicalDrivePaths: Record<string, string>;
  virtualPoolRoot: string;
  virtualDownloadsPath: string;
  virtualMediaPath: string;
  dbFilePath: string;
  logFilePath: string;
  hashingWorkers: number;
  dbWriteThresholdGiB: number;
  dbWriteThresholdFiles: number;
  dbWriteThresholdSeconds: number;
  sparseSampleSizeBytes: number;
  quickHashRulesMiB: QuickHashRule[];
  defaultQuickHashSizeMiB: number;
  qbittorrentHost: string;
  qbittorrentPort: number;
  qbittorrentUsername: string;
  qbittorrentPassword: string;
  backupSuffix: string;
  symlinkTargetMode: SymlinkTargetMode;
  symlinkLocationMode: SymlinkLocationMode;
  hashStrategy: HashStrategy;
  pauseAllTorrents: boolean;
  verifyRecheckBeforeResume: boolean;
}

export const DEFAULT_PHYSICAL_DRIVE_PATHS: Record<string, string> = {
  D: 'D:\\PoolPart.bff64b92-d745-4ff9-933b-ae092c32cfc7',
  E: 'E:\\PoolPart.46e9a8f6-1019-4e8f-af54-ec2673cb3a28',
  F: 'F:\\PoolPart.c3eea89e-5163-4f85-89fa-8720729cda69',
  H: 'H:\\PoolPart.8698780e-2b8d-41bb-9da1-e00739184da7',
  I: 'I:\\PoolPart.40c6f0c7-d2ec-467b-8cb7-a40c43b96728',
  K: 'K:\\PoolPart.3bbf55df-af05-4d1b-8f4d-42e7257c5744',
  Q: 'Q:\\PoolPart.360536be-a733-4484-b8c5-fdefe3d00e89',
  U: 'U:\\PoolPart.6610f243-02f1-4552-ae81-c9fdae7722fe',
  V: 'V:\\PoolPart.cd8bed16-b13c-4f35-967a-1abb245bc3eb',
  Z: 'Z:\\PoolPart.352400c4-6432-4d03-8f76-aa21f2591ba3',
};

export function createDefaultConfig(rootDir: string = process.cwd()): AppConfig {
  return {
    physicalDrivePaths: { ...DEFAULT_PHYSICAL_DRIVE_PATHS },
    virtualPoolRoot: 'M:\\',
    virtualDownloadsPath: 'M:\\Downloads',
    virtualMediaPath: 'M:\\Media',
    dbFilePath: path.join(rootDir, 'media_linker_v3.sqlite'),
    logFilePath: path.join(rootDir, 'media_linker_v3.log'),
    hashingWorkers: 10,
    dbWriteThresholdGiB: 1,
    dbWriteThresholdFiles: 16,
    dbWriteThresholdSeconds: 5,
    sparseSampleSizeBytes: 1024 * 1024, // 1 MiB at head, mid, and tail
    quickHashRulesMiB: [
      { maxFileSizeMiB: 256, quickHashSizeMiB: 32 },
      { maxFileSizeMiB: 512, quickHashSizeMiB: 64 },
      { maxFileSizeMiB: 2048, quickHashSizeMiB: 128 },
      { maxFileSizeMiB: 8192, quickHashSizeMiB: 256 },
    ],
    defaultQuickHashSizeMiB: 512,
    qbittorrentHost: '192.168.0.20',
    qbittorrentPort: 8777,
    qbittorrentUsername: 'mvl',
    qbittorrentPassword: '',
    backupSuffix: '.bak',
    symlinkTargetMode: 'virtual',
    symlinkLocationMode: 'physical',
    hashStrategy: 'smart_candidates',
    pauseAllTorrents: false,
    verifyRecheckBeforeResume: true,
  };
}

/**
 * Automatically scans Windows drive letters A..Z for StableBit DrivePool 'PoolPart.*' folders.
 */
export function discoverDrivePoolPaths(
  driveLetters: string[] = 'DEFGHIJKLMNOPQRSTUVWXYZ'.split(''),
  fsImpl: Pick<typeof fs, 'existsSync' | 'readdirSync'> = fs,
): Record<string, string> {
  const discovered: Record<string, string> = {};
  for (const letter of driveLetters) {
    const root = `${letter.toUpperCase()}:\\`;
    try {
      if (!fsImpl.existsSync(root)) continue;
      const entries = fsImpl.readdirSync(root, { withFileTypes: true });
      const poolPart = entries.find(
        (e) => e.isDirectory() && /^PoolPart\.[0-9a-fA-F-]{36}$/i.test(e.name),
      );
      if (poolPart) {
        discovered[letter.toUpperCase()] = path.win32.join(root, poolPart.name);
      }
    } catch {
      // Ignore inaccessible drives
    }
  }
  return discovered;
}
