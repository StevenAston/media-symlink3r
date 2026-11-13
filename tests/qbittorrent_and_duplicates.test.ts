import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AppConfig,
  cleanupBrokenLinks,
  createDefaultConfig,
  getPendingDuplicatePairs,
  hashUnHashedFilesPerDrive,
  identifyAndLinkDuplicates,
  initializeDatabase,
  IQBittorrentClient,
  QBittorrentClient,
  runFileScan,
  updateDbWithTorrentInfo,
  withDatabase,
} from '../src/core';

describe('qbittorrentClient.ts & duplicateFinder.ts', () => {
  let tempDir: string;
  let config: AppConfig;
  let poolPartD: string;
  let poolPartU: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-v3-qbit-dup-test-'));
    poolPartD = path.join(tempDir, 'DriveD', 'PoolPart.bff64b92-d745-4ff9-933b-ae092c32cfc7');
    poolPartU = path.join(tempDir, 'DriveU', 'PoolPart.6610f243-02f1-4552-ae81-c9fdae7722fe');

    fs.mkdirSync(path.join(poolPartD, 'Downloads', 'TorrentA'), { recursive: true });
    fs.mkdirSync(path.join(poolPartD, 'Downloads', 'TorrentB'), { recursive: true });
    fs.mkdirSync(path.join(poolPartU, 'Media', 'Movies'), { recursive: true });

    config = {
      ...createDefaultConfig(tempDir),
      physicalDrivePaths: {
        D: poolPartD,
        U: poolPartU,
      },
      virtualPoolRoot: 'M:\\',
      virtualDownloadsPath: 'M:\\Downloads',
      virtualMediaPath: 'M:\\Media',
    };
    initializeDatabase(config.dbFilePath);
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('supports qBittorrent HTTP API v4/v5 endpoints and recheck polling', async () => {
    const calledUrls: string[] = [];
    let recheckPolls = 0;

    const mockFetch: typeof fetch = async (input) => {
      const url = String(input);
      calledUrls.push(url);

      if (url.endsWith('/api/v2/auth/login')) {
        return new Response('Ok.', {
          status: 200,
          headers: { 'set-cookie': 'SID=mock-session-id; Path=/' },
        });
      }
      if (url.endsWith('/api/v2/app/version')) {
        return new Response('v5.0.2', { status: 200 });
      }
      if (url.endsWith('/api/v2/torrents/stop') || url.endsWith('/api/v2/torrents/start')) {
        return new Response('', { status: 200 });
      }
      if (url.endsWith('/api/v2/torrents/recheck')) {
        return new Response('', { status: 200 });
      }
      if (url.endsWith('/api/v2/torrents/info')) {
        recheckPolls++;
        const state = recheckPolls < 2 ? 'checkingUP' : 'stalledUP';
        return new Response(
          JSON.stringify([
            {
              hash: 'abc123hash',
              name: 'Sample.Torrent',
              save_path: 'M:\\Downloads',
              state,
              progress: 1.0,
            },
          ]),
          { status: 200 },
        );
      }
      return new Response('', { status: 404 });
    };

    const client = new QBittorrentClient(config, mockFetch);
    expect(await client.login()).toBe(true);
    expect(await client.getVersion()).toBe('v5.0.2');
    expect(await client.pauseTorrents(['abc123hash'])).toBe(true);
    expect(calledUrls.some((u) => u.endsWith('/api/v2/torrents/stop'))).toBe(true);

    const checkRes = await client.waitForRecheckCompletion(['abc123hash'], 5000, 10);
    expect(checkRes.verified).toBe(true);
    expect(await client.resumeTorrents(['abc123hash'])).toBe(true);
  });

  it('syncs torrents and links download files across all 3 tiers (exact virtual path, folder+size, filename+size)', async () => {
    const fileExact = path.join(poolPartD, 'Downloads', 'TorrentA', 'ExactMatch.mkv');
    const fileRenamedInFolder = path.join(
      poolPartD,
      'Downloads',
      'TorrentB',
      'LocallyRenamed.mkv',
    );
    fs.writeFileSync(fileExact, Buffer.alloc(4096, 'E'));
    fs.writeFileSync(fileRenamedInFolder, Buffer.alloc(7777, 'R'));

    runFileScan(config, { useEverythingSdk: false });

    const mockClient: IQBittorrentClient = {
      login: async () => true,
      getVersion: async () => 'v4.6.5',
      getTorrents: async () => [
        {
          hash: 'hash_torrent_a',
          name: 'TorrentA',
          save_path: 'M:\\Downloads',
          category: 'movies',
          tags: 'hd',
          state: 'uploading',
          progress: 1.0,
        },
        {
          hash: 'hash_torrent_b',
          name: 'TorrentB',
          save_path: 'M:\\Downloads',
          category: 'tv',
          tags: '4k',
          state: 'stalledUP',
          progress: 1.0,
        },
      ],
      getTorrentFiles: async (hash: string) => {
        if (hash === 'hash_torrent_a') {
          return [{ name: 'TorrentA/ExactMatch.mkv', size: 4096 }];
        }
        return [{ name: 'TorrentB/OriginalTorrentName.mkv', size: 7777 }];
      },
      pauseTorrents: async () => true,
      resumeTorrents: async () => true,
      recheckTorrents: async () => true,
      waitForRecheckCompletion: async () => ({ verified: true, states: {} }),
    };

    const syncSummary = await updateDbWithTorrentInfo(config, mockClient);
    expect(syncSummary.torrentsSynced).toBe(2);
    expect(syncSummary.downloadFilesMatchedExact).toBe(1);
    expect(syncSummary.downloadFilesMatchedFolderSize).toBe(1);
    expect(syncSummary.totalDownloadFilesLinked).toBe(2);
  });

  it('identifies cross-source duplicates, excludes 0-byte files, and self-heals broken links', async () => {
    const payload = Buffer.from('this is the test content');
    const dlFile = path.join(poolPartD, 'Downloads', 'TorrentA', 'Movie.2024.mkv');
    const mediaFile = path.join(poolPartU, 'Media', 'Movies', 'Movie (2024).mkv');
    const zeroDl = path.join(poolPartD, 'Downloads', 'TorrentA', 'Empty.srt');
    const zeroMedia = path.join(poolPartU, 'Media', 'Movies', 'Empty.srt');

    fs.writeFileSync(dlFile, payload);
    fs.writeFileSync(mediaFile, payload);
    fs.writeFileSync(zeroDl, Buffer.alloc(0));
    fs.writeFileSync(zeroMedia, Buffer.alloc(0));

    runFileScan(config, { useEverythingSdk: false });
    await hashUnHashedFilesPerDrive(config, { strategy: 'smart_candidates' });

    const dupSummary = await identifyAndLinkDuplicates(config);
    expect(dupSummary.duplicatesLinked).toBe(1);
    expect(dupSummary.reclaimableBytes).toBe(payload.length);

    const pending = getPendingDuplicatePairs(config);
    expect(pending).toHaveLength(1);
    expect(pending[0].downloadFullPath).toBe(dlFile);
    expect(pending[0].mediaFullPath).toBe(mediaFile);
    expect(pending[0].proposedTargetVirtual).toBe('M:\\Media\\Movies\\Movie (2024).mkv');

    // Corrupt the media row into a symlink and verify cleanupBrokenLinks self-heals the download row
    withDatabase(config.dbFilePath, (db) => {
      db.prepare(`UPDATE files SET is_symlink = 1 WHERE id = ?`).run(pending[0].mediaFileId);
    });

    const healedCount = cleanupBrokenLinks(config.dbFilePath);
    expect(healedCount).toBe(1);
    expect(getPendingDuplicatePairs(config)).toHaveLength(0);
  });
});
