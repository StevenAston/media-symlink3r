import path from 'node:path';
import { AppConfig } from './config';
import { withDatabase } from './database';
import { normalizeWinPath } from './utils';

export interface QBitTorrentInfo {
  hash: string;
  name: string;
  save_path: string;
  category?: string;
  tags?: string;
  state?: string;
  progress?: number;
  total_size?: number;
  size?: number;
}

export interface QBitTorrentFile {
  name: string;
  size: number;
  progress?: number;
}

export interface IQBittorrentClient {
  login(): Promise<boolean>;
  getVersion(): Promise<string>;
  getTorrents(): Promise<QBitTorrentInfo[]>;
  getTorrentFiles(hash: string): Promise<QBitTorrentFile[]>;
  pauseTorrents(hashes: string[] | 'all'): Promise<boolean>;
  resumeTorrents(hashes: string[] | 'all'): Promise<boolean>;
  recheckTorrents(hashes: string[]): Promise<boolean>;
  waitForRecheckCompletion(
    hashes: string[],
    timeoutMs?: number,
    pollIntervalMs?: number,
  ): Promise<{ verified: boolean; states: Record<string, { state: string; progress: number }> }>;
}

export class QBittorrentClient implements IQBittorrentClient {
  private baseUrl: string;
  private username: string;
  private password: string;
  private cookie: string | null = null;
  private fetchImpl: typeof fetch;
  private isV5OrNewer: boolean | null = null;

  constructor(
    config: Pick<
      AppConfig,
      'qbittorrentHost' | 'qbittorrentPort' | 'qbittorrentUsername' | 'qbittorrentPassword'
    >,
    fetchImpl: typeof fetch = fetch,
  ) {
    const host = config.qbittorrentHost.replace(/^https?:\/\//, '');
    this.baseUrl = `http://${host}:${config.qbittorrentPort}`;
    this.username = config.qbittorrentUsername;
    this.password = config.qbittorrentPassword;
    this.fetchImpl = fetchImpl;
  }

  private async request(
    endpoint: string,
    init: RequestInit = {},
    retryAuth: boolean = true,
  ): Promise<Response> {
    if (!this.cookie && endpoint !== '/api/v2/auth/login') {
      await this.login();
    }

    const headers = new Headers(init.headers ?? {});
    if (this.cookie) {
      headers.set('Cookie', this.cookie);
    }

    const response = await this.fetchImpl(`${this.baseUrl}${endpoint}`, {
      ...init,
      headers,
    });

    if (response.status === 403 && retryAuth && endpoint !== '/api/v2/auth/login') {
      const loggedIn = await this.login();
      if (loggedIn) {
        return this.request(endpoint, init, false);
      }
    }

    return response;
  }

  async login(): Promise<boolean> {
    try {
      const body = new URLSearchParams({
        username: this.username,
        password: this.password,
      });

      const response = await this.fetchImpl(`${this.baseUrl}/api/v2/auth/login`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: body.toString(),
      });

      if (!response.ok) return false;
      const setCookie = response.headers.get('set-cookie');
      if (setCookie) {
        const sidMatch = /SID=[^;]+/i.exec(setCookie);
        this.cookie = sidMatch ? sidMatch[0] : setCookie.split(';')[0];
      } else {
        // Localhost / subnet bypass may succeed without SID cookie
        this.cookie = '';
      }
      return true;
    } catch {
      return false;
    }
  }

  async getVersion(): Promise<string> {
    const res = await this.request('/api/v2/app/version');
    if (!res.ok) {
      throw new Error(`qBittorrent getVersion failed: HTTP ${res.status}`);
    }
    const ver = (await res.text()).trim();
    const majorMatch = /^v?(\d+)/.exec(ver);
    if (majorMatch) {
      this.isV5OrNewer = Number(majorMatch[1]) >= 5;
    }
    return ver;
  }

  async getTorrents(): Promise<QBitTorrentInfo[]> {
    const res = await this.request('/api/v2/torrents/info');
    if (!res.ok) {
      throw new Error(`qBittorrent getTorrents failed: HTTP ${res.status}`);
    }
    return (await res.json()) as QBitTorrentInfo[];
  }

  async getTorrentFiles(hash: string): Promise<QBitTorrentFile[]> {
    const res = await this.request(
      `/api/v2/torrents/files?hash=${encodeURIComponent(hash)}`,
    );
    if (!res.ok) {
      throw new Error(`qBittorrent getTorrentFiles(${hash}) failed: HTTP ${res.status}`);
    }
    return (await res.json()) as QBitTorrentFile[];
  }

  async pauseTorrents(hashes: string[] | 'all'): Promise<boolean> {
    const hashesParam = hashes === 'all' ? 'all' : hashes.join('|');
    if (!hashesParam) return true;

    const body = new URLSearchParams({ hashes: hashesParam }).toString();
    const endpoints =
      this.isV5OrNewer === true
        ? ['/api/v2/torrents/stop', '/api/v2/torrents/pause']
        : ['/api/v2/torrents/pause', '/api/v2/torrents/stop'];

    for (const ep of endpoints) {
      const res = await this.request(ep, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
      });
      if (res.ok) return true;
    }
    return false;
  }

  async resumeTorrents(hashes: string[] | 'all'): Promise<boolean> {
    const hashesParam = hashes === 'all' ? 'all' : hashes.join('|');
    if (!hashesParam) return true;

    const body = new URLSearchParams({ hashes: hashesParam }).toString();
    const endpoints =
      this.isV5OrNewer === true
        ? ['/api/v2/torrents/start', '/api/v2/torrents/resume']
        : ['/api/v2/torrents/resume', '/api/v2/torrents/start'];

    for (const ep of endpoints) {
      const res = await this.request(ep, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
      });
      if (res.ok) return true;
    }
    return false;
  }

  async recheckTorrents(hashes: string[]): Promise<boolean> {
    if (hashes.length === 0) return true;
    const body = new URLSearchParams({ hashes: hashes.join('|') }).toString();
    const res = await this.request('/api/v2/torrents/recheck', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    return res.ok;
  }

  async waitForRecheckCompletion(
    hashes: string[],
    timeoutMs: number = 30000,
    pollIntervalMs: number = 250,
  ): Promise<{
    verified: boolean;
    states: Record<string, { state: string; progress: number }>;
  }> {
    const targetSet = new Set(hashes.map((h) => h.toLowerCase()));
    const deadline = Date.now() + timeoutMs;
    const states: Record<string, { state: string; progress: number }> = {};

    while (Date.now() <= deadline) {
      const allTorrents = await this.getTorrents();
      let stillChecking = false;

      for (const t of allTorrents) {
        const h = t.hash.toLowerCase();
        if (!targetSet.has(h)) continue;
        const st = t.state ?? 'unknown';
        const prog = t.progress ?? 0;
        states[t.hash] = { state: st, progress: prog };
        if (st.toLowerCase().includes('checking')) {
          stillChecking = true;
        }
      }

      if (!stillChecking) {
        const allComplete = Object.values(states).every(
          (s) => s.progress >= 0.9999 && !s.state.toLowerCase().includes('error') && !s.state.toLowerCase().includes('missing'),
        );
        return { verified: allComplete, states };
      }

      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }

    return { verified: false, states };
  }
}

export interface TorrentSyncSummary {
  torrentsSynced: number;
  torrentFilesSynced: number;
  downloadFilesMatchedExact: number;
  downloadFilesMatchedFolderSize: number;
  downloadFilesMatchedFilenameSize: number;
  totalDownloadFilesLinked: number;
}

/**
 * Pulls all torrents and torrent_files from qBittorrent into SQLite and links
 * 'downloads' files to their corresponding torrent_hash using 3-tier path/size resolution.
 */
export async function updateDbWithTorrentInfo(
  config: AppConfig,
  clientOverride?: IQBittorrentClient,
): Promise<TorrentSyncSummary> {
  const client = clientOverride ?? new QBittorrentClient(config);
  const loggedIn = await client.login();
  if (!loggedIn) {
    throw new Error('Failed to authenticate with qBittorrent WebUI');
  }

  const torrents = await client.getTorrents();
  const filesByTorrent = new Map<string, QBitTorrentFile[]>();

  for (const t of torrents) {
    const tFiles = await client.getTorrentFiles(t.hash);
    filesByTorrent.set(t.hash, tFiles);
  }

  return withDatabase(config.dbFilePath, (db) => {
    let torrentFilesSynced = 0;

    const upsertTorrentStmt = db.prepare(`
      INSERT INTO torrents (hash, name, save_path, category, tags, state, progress, total_size)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(hash) DO UPDATE SET
        name = excluded.name,
        save_path = excluded.save_path,
        category = excluded.category,
        tags = excluded.tags,
        state = excluded.state,
        progress = excluded.progress,
        total_size = excluded.total_size
    `);

    const insertTorrentFileStmt = db.prepare(`
      INSERT OR REPLACE INTO torrent_files (
        torrent_hash, filepath_in_torrent, file_size, virtual_path, filename
      ) VALUES (?, ?, ?, ?, ?)
    `);

    db.exec('BEGIN IMMEDIATE TRANSACTION;');
    try {
      db.exec('DELETE FROM torrent_files;');
      db.exec('DELETE FROM torrents;');

      for (const t of torrents) {
        const savePath = normalizeWinPath(t.save_path || config.virtualDownloadsPath);
        upsertTorrentStmt.run(
          t.hash,
          t.name ?? '',
          savePath,
          t.category ?? '',
          t.tags ?? '',
          t.state ?? '',
          t.progress ?? 1.0,
          t.total_size ?? t.size ?? 0,
        );

        const tFiles = filesByTorrent.get(t.hash) ?? [];
        for (const tf of tFiles) {
          const relPath = tf.name.replace(/\//g, '\\');
          const virtualPath = normalizeWinPath(path.win32.join(savePath, relPath));
          const fname = path.win32.basename(virtualPath);
          insertTorrentFileStmt.run(t.hash, tf.name, tf.size, virtualPath, fname);
          torrentFilesSynced++;
        }
      }

      // Reset stale torrent associations before re-linking
      db.exec(`
        UPDATE files
        SET torrent_hash = NULL,
            torrent_name = NULL,
            category = NULL,
            tags = NULL
        WHERE scan_source = 'downloads'
      `);

      // Tier 1: Exact case-insensitive virtual_path match
      const exactRes = db.prepare(`
        UPDATE files
        SET torrent_hash = (
              SELECT tf.torrent_hash
              FROM torrent_files tf
              WHERE LOWER(tf.virtual_path) = LOWER(files.virtual_path)
              LIMIT 1
            ),
            torrent_name = (
              SELECT t.name
              FROM torrent_files tf
              JOIN torrents t ON t.hash = tf.torrent_hash
              WHERE LOWER(tf.virtual_path) = LOWER(files.virtual_path)
              LIMIT 1
            ),
            category = (
              SELECT t.category
              FROM torrent_files tf
              JOIN torrents t ON t.hash = tf.torrent_hash
              WHERE LOWER(tf.virtual_path) = LOWER(files.virtual_path)
              LIMIT 1
            ),
            tags = (
              SELECT t.tags
              FROM torrent_files tf
              JOIN torrents t ON t.hash = tf.torrent_hash
              WHERE LOWER(tf.virtual_path) = LOWER(files.virtual_path)
              LIMIT 1
            )
        WHERE scan_source = 'downloads'
          AND virtual_path IS NOT NULL
          AND EXISTS (
            SELECT 1 FROM torrent_files tf
            WHERE LOWER(tf.virtual_path) = LOWER(files.virtual_path)
          )
      `).run();

      const downloadFilesMatchedExact = Number(exactRes.changes ?? 0);

      // Tier 2: Same virtual parent directory + exact file_size match (for renamed files inside a torrent folder)
      const unlinkedRows = db.prepare(`
        SELECT id, virtual_path, filename, file_size
        FROM files
        WHERE scan_source = 'downloads'
          AND torrent_hash IS NULL
      `).all() as Array<{
        id: number;
        virtual_path: string | null;
        filename: string;
        file_size: number;
      }>;

      const allTorrentFiles = db.prepare(`
        SELECT tf.torrent_hash, tf.virtual_path, tf.filename, tf.file_size,
               t.name AS torrent_name, t.category, t.tags
        FROM torrent_files tf
        JOIN torrents t ON t.hash = tf.torrent_hash
      `).all() as Array<{
        torrent_hash: string;
        virtual_path: string;
        filename: string;
        file_size: number;
        torrent_name: string;
        category: string;
        tags: string;
      }>;

      const byDirAndSize = new Map<string, typeof allTorrentFiles>();
      const byFilenameAndSize = new Map<string, typeof allTorrentFiles>();

      for (const tf of allTorrentFiles) {
        const dirKey = `${path.win32.dirname(tf.virtual_path).toLowerCase()}|${tf.file_size}`;
        const dirArr = byDirAndSize.get(dirKey) ?? [];
        dirArr.push(tf);
        byDirAndSize.set(dirKey, dirArr);

        const fnKey = `${(tf.filename || '').toLowerCase()}|${tf.file_size}`;
        const fnArr = byFilenameAndSize.get(fnKey) ?? [];
        fnArr.push(tf);
        byFilenameAndSize.set(fnKey, fnArr);
      }

      const updateSingleFileTorrentStmt = db.prepare(`
        UPDATE files
        SET torrent_hash = ?,
            torrent_name = ?,
            category = ?,
            tags = ?
        WHERE id = ?
      `);

      let downloadFilesMatchedFolderSize = 0;
      let downloadFilesMatchedFilenameSize = 0;

      for (const row of unlinkedRows) {
        if (row.virtual_path) {
          const dirKey = `${path.win32.dirname(row.virtual_path).toLowerCase()}|${row.file_size}`;
          const candidates = byDirAndSize.get(dirKey);
          if (candidates && candidates.length === 1) {
            const c = candidates[0];
            updateSingleFileTorrentStmt.run(
              c.torrent_hash,
              c.torrent_name,
              c.category,
              c.tags,
              row.id,
            );
            downloadFilesMatchedFolderSize++;
            continue;
          }
        }

        // Tier 3: Unambiguous (LOWER(filename), file_size) match
        const fnKey = `${row.filename.toLowerCase()}|${row.file_size}`;
        const fnCandidates = byFilenameAndSize.get(fnKey);
        if (fnCandidates && fnCandidates.length === 1) {
          const c = fnCandidates[0];
          updateSingleFileTorrentStmt.run(
            c.torrent_hash,
            c.torrent_name,
            c.category,
            c.tags,
            row.id,
          );
          downloadFilesMatchedFilenameSize++;
        }
      }

      db.exec('COMMIT;');

      return {
        torrentsSynced: torrents.length,
        torrentFilesSynced,
        downloadFilesMatchedExact,
        downloadFilesMatchedFolderSize,
        downloadFilesMatchedFilenameSize,
        totalDownloadFilesLinked:
          downloadFilesMatchedExact +
          downloadFilesMatchedFolderSize +
          downloadFilesMatchedFilenameSize,
      };
    } catch (err) {
      db.exec('ROLLBACK;');
      throw err;
    }
  });
}
