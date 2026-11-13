import React, { useEffect, useRef, useState } from 'react';
import type {
  AppConfig,
  BakVaultItem,
  BrokenSymlinkReportItem,
  DriveRecoverySummary,
  IntraMediaDuplicateGroup,
  LogEntry,
  MultiDriveHashProgress,
  OrphanedDownloadItem,
  PendingDuplicatePair,
  ScanSummary,
  StatusCounts,
  SymlinkSandboxTestResult,
} from '../core';

declare global {
  interface Window {
    mediaLinker?: {
      getConfig(): Promise<AppConfig>;
      updateConfig(partial: Partial<AppConfig>): Promise<AppConfig>;
      discoverDrives(): Promise<Record<string, string>>;
      getStatusCounts(): Promise<StatusCounts>;
      getRecentLogs(): Promise<LogEntry[]>;
      runScan(options?: { useEverythingSdk?: boolean; pruneMissing?: boolean }): Promise<unknown>;
      runHash(options?: {
        strategy?: 'smart_candidates' | 'full_library';
        driveFilter?: string[];
      }): Promise<unknown>;
      cancelHash(): Promise<boolean>;
      syncTorrents(): Promise<unknown>;
      findDuplicates(options?: { forceRelink?: boolean }): Promise<unknown>;
      getPendingDuplicates(): Promise<PendingDuplicatePair[]>;
      processDuplicates(options?: {
        fileIds?: number[];
        targetMode?: 'virtual' | 'physical';
        pauseAll?: boolean;
        verifyRecheck?: boolean;
      }): Promise<unknown>;
      scanBrokenSymlinks(): Promise<BrokenSymlinkReportItem[]>;
      healBrokenSymlinks(
        items: BrokenSymlinkReportItem[],
        targetMode?: 'virtual' | 'physical',
      ): Promise<unknown>;
      listBakFiles(): Promise<BakVaultItem[]>;
      restoreBakFiles(backupPaths: string[]): Promise<unknown>;
      cleanupBakFiles(options?: {
        backupPaths?: string[];
        requireHealthySymlink?: boolean;
      }): Promise<unknown>;
      findOrphanedDownloads(): Promise<OrphanedDownloadItem[]>;
      deleteOrphanedFiles(fileIds: number[]): Promise<unknown>;
      runTargetSandboxTest(): Promise<SymlinkSandboxTestResult>;
      convertExistingTargets(
        desiredMode: 'virtual' | 'physical',
        fileIds?: number[],
      ): Promise<unknown>;
      findIntraMediaDuplicates(): Promise<IntraMediaDuplicateGroup[]>;
      resolveIntraMediaSet(
        keepFileId: number,
        redundantFileIds: number[],
        action: 'symlink' | 'delete',
        targetMode?: 'virtual' | 'physical',
      ): Promise<unknown>;
      getDriveCatalogSummary(): Promise<DriveRecoverySummary[]>;
      exportDriveManifest(driveLetter: string, outputPath?: string): Promise<unknown>;
      onHashProgress(cb: (progress: MultiDriveHashProgress) => void): () => void;
      onScanProgress(
        cb: (progress: {
          driveLetter: string;
          source: 'media' | 'downloads';
          summary: ScanSummary;
        }) => void,
      ): () => void;
      onLogEntry(cb: (entry: LogEntry) => void): () => void;
    };
  }
}

type TabId =
  | 'dashboard'
  | 'workbench'
  | 'healer'
  | 'vault'
  | 'orphans'
  | 'target_tester'
  | 'intramedia_catalog';

function formatBytes(bytes: number): string {
  if (!bytes || bytes <= 0) return '0 B';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const val = bytes / Math.pow(1024, i);
  return `${val.toFixed(i === 0 ? 0 : 2)} ${units[i]}`;
}

export function App() {
  const [activeTab, setActiveTab] = useState<TabId>('dashboard');
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [counts, setCounts] = useState<StatusCounts>({
    total: 0,
    new: 0,
    sparse_hashed: 0,
    hashed: 0,
    duplicate_found: 0,
    symlinked: 0,
    error: 0,
  });
  const [busyMessage, setBusyMessage] = useState<string | null>(null);
  const [statusBanner, setStatusBanner] = useState<string | null>(null);
  const [hashProgress, setHashProgress] = useState<MultiDriveHashProgress | null>(null);

  // Workbench state
  const [pendingPairs, setPendingPairs] = useState<PendingDuplicatePair[]>([]);
  const [selectedPairIds, setSelectedPairIds] = useState<Set<number>>(new Set());
  const [workbenchPage, setWorkbenchPage] = useState<number>(1);
  const [workbenchPageSize, setWorkbenchPageSize] = useState<number>(50);
  const [workbenchSearch, setWorkbenchSearch] = useState<string>('');

  // Priority #1: Broken Symlink Healer state
  const [brokenSymlinks, setBrokenSymlinks] = useState<BrokenSymlinkReportItem[]>([]);

  // Priority #2: .bak Vault state
  const [bakItems, setBakItems] = useState<BakVaultItem[]>([]);

  // Priority #3: Orphaned Downloads state
  const [orphanItems, setOrphanItems] = useState<OrphanedDownloadItem[]>([]);

  // Priority #4: Target Mode Sandbox Test state
  const [sandboxResult, setSandboxResult] = useState<SymlinkSandboxTestResult | null>(null);

  // Priority #5 + #6: Intra-Media & Drive Catalog state
  const [intraGroups, setIntraGroups] = useState<IntraMediaDuplicateGroup[]>([]);
  const [driveSummaries, setDriveSummaries] = useState<DriveRecoverySummary[]>([]);

  // Live logs & scan status
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const logContainerRef = useRef<HTMLDivElement | null>(null);

  const refreshCoreState = async () => {
    if (!window.mediaLinker) return;
    const [cfg, st] = await Promise.all([
      window.mediaLinker.getConfig(),
      window.mediaLinker.getStatusCounts(),
    ]);
    setConfig(cfg);
    setCounts(st);
  };

  useEffect(() => {
    void refreshCoreState();
    if (!window.mediaLinker) return;
    void window.mediaLinker.getRecentLogs().then((initial) => setLogs(initial));

    const unsubHash = window.mediaLinker.onHashProgress((prog) => {
      setHashProgress(prog);
    });
    const unsubScan = window.mediaLinker.onScanProgress((prog) => {
      setBusyMessage(
        `Scanning Drive ${prog.driveLetter}: (${prog.source}) — ${prog.summary.upsertedCount.toLocaleString()} files indexed...`,
      );
      void window.mediaLinker?.getStatusCounts().then((st) => setCounts(st));
    });
    const unsubLog = window.mediaLinker.onLogEntry((entry) => {
      setLogs((prev) => [...prev.slice(-399), entry]);
    });

    return () => {
      unsubHash();
      unsubScan();
      unsubLog();
    };
  }, []);

  useEffect(() => {
    if (logContainerRef.current) {
      logContainerRef.current.scrollTop = logContainerRef.current.scrollHeight;
    }
  }, [logs]);

  const runAction = async (label: string, fn: () => Promise<void>) => {
    setBusyMessage(label);
    try {
      await fn();
      await refreshCoreState();
    } catch (err) {
      setStatusBanner(`Error: ${(err as Error).message}`);
    } finally {
      setBusyMessage(null);
    }
  };

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <h1>Media Symlinker v3</h1>
          <p>DrivePool + qBittorrent Engine</p>
        </div>

        <button
          className={`nav-btn ${activeTab === 'dashboard' ? 'active' : ''}`}
          onClick={() => setActiveTab('dashboard')}
        >
          <span>Dashboard & Pipeline</span>
          <span className="badge blue">{counts.total.toLocaleString()}</span>
        </button>

        <button
          className={`nav-btn ${activeTab === 'workbench' ? 'active' : ''}`}
          onClick={() => {
            setActiveTab('workbench');
            void runAction('Loading pending duplicates...', async () => {
              if (!window.mediaLinker) return;
              const pairs = await window.mediaLinker.getPendingDuplicates();
              setPendingPairs(pairs);
              setSelectedPairIds(new Set(pairs.map((p) => p.downloadFileId)));
            });
          }}
        >
          <span>Dry-Run Workbench</span>
          <span className="badge emerald">{counts.duplicate_found}</span>
        </button>

        <button
          className={`nav-btn ${activeTab === 'healer' ? 'active' : ''}`}
          onClick={() => {
            setActiveTab('healer');
            void runAction('Scanning symlinks...', async () => {
              if (!window.mediaLinker) return;
              setBrokenSymlinks(await window.mediaLinker.scanBrokenSymlinks());
            });
          }}
        >
          <span>1. Symlink Healer</span>
          <span className="badge amber">P1</span>
        </button>

        <button
          className={`nav-btn ${activeTab === 'vault' ? 'active' : ''}`}
          onClick={() => {
            setActiveTab('vault');
            void runAction('Listing .bak vault...', async () => {
              if (!window.mediaLinker) return;
              setBakItems(await window.mediaLinker.listBakFiles());
            });
          }}
        >
          <span>2. .bak Safety Vault</span>
          <span className="badge emerald">P2</span>
        </button>

        <button
          className={`nav-btn ${activeTab === 'orphans' ? 'active' : ''}`}
          onClick={() => {
            setActiveTab('orphans');
            void runAction('Scanning orphaned downloads...', async () => {
              if (!window.mediaLinker) return;
              setOrphanItems(await window.mediaLinker.findOrphanedDownloads());
            });
          }}
        >
          <span>3. Orphaned Downloads</span>
          <span className="badge blue">P3</span>
        </button>

        <button
          className={`nav-btn ${activeTab === 'target_tester' ? 'active' : ''}`}
          onClick={() => setActiveTab('target_tester')}
        >
          <span>4. Target Mode Tester</span>
          <span className="badge blue">P4</span>
        </button>

        <button
          className={`nav-btn ${activeTab === 'intramedia_catalog' ? 'active' : ''}`}
          onClick={() => {
            setActiveTab('intramedia_catalog');
            void runAction('Loading Media duplicates & Drive catalog...', async () => {
              if (!window.mediaLinker) return;
              const [groups, drives] = await Promise.all([
                window.mediaLinker.findIntraMediaDuplicates(),
                window.mediaLinker.getDriveCatalogSummary(),
              ]);
              setIntraGroups(groups);
              setDriveSummaries(drives);
            });
          }}
        >
          <span>5. Intra-Media & Catalog</span>
          <span className="badge rose">P5</span>
        </button>
      </aside>

      <main className="main-content">
        {busyMessage && <div className="banner">⏳ {busyMessage}</div>}
        {statusBanner && (
          <div className="banner" onClick={() => setStatusBanner(null)}>
            ℹ️ {statusBanner} (click to dismiss)
          </div>
        )}

        <div className="stat-grid">
          <div className="stat-card">
            <div className="label">Total Indexed</div>
            <div className="value">{counts.total.toLocaleString()}</div>
          </div>
          <div className="stat-card">
            <div className="label">New / Unhashed</div>
            <div className="value">{counts.new.toLocaleString()}</div>
          </div>
          <div className="stat-card">
            <div className="label">Sparse Hashed</div>
            <div className="value">{counts.sparse_hashed.toLocaleString()}</div>
          </div>
          <div className="stat-card">
            <div className="label">Full xxh128 Hashed</div>
            <div className="value">{counts.hashed.toLocaleString()}</div>
          </div>
          <div className="stat-card">
            <div className="label">Duplicates Ready</div>
            <div className="value" style={{ color: 'var(--accent-emerald)' }}>
              {counts.duplicate_found.toLocaleString()}
            </div>
          </div>
          <div className="stat-card">
            <div className="label">Active Symlinks</div>
            <div className="value" style={{ color: 'var(--accent-blue)' }}>
              {counts.symlinked.toLocaleString()}
            </div>
          </div>
        </div>

        {activeTab === 'dashboard' && (
          <>
            <div className="card">
              <h3>Pipeline Controls</h3>
              <div className="btn-row">
                <button
                  className="btn primary"
                  disabled={!!busyMessage}
                  onClick={() =>
                    void runAction('Scanning all PoolPart drives via Everything SDK...', async () => {
                      const res = (await window.mediaLinker?.runScan({
                        useEverythingSdk: true,
                        pruneMissing: true,
                      })) as { totalAddedOrUpdated?: number; totalPruned?: number };
                      setStatusBanner(
                        `Scan complete: ${res?.totalAddedOrUpdated ?? 0} files indexed, ${res?.totalPruned ?? 0} dead records pruned.`,
                      );
                    })
                  }
                >
                  1. Scan Drives (Everything SDK)
                </button>

                <button
                  className="btn primary"
                  disabled={!!busyMessage}
                  onClick={() =>
                    void runAction('Hashing candidate files across drives...', async () => {
                      await window.mediaLinker?.runHash({ strategy: 'smart_candidates' });
                      setStatusBanner('Smart Candidate Hashing complete.');
                    })
                  }
                >
                  2A. Hash Candidates (Fast)
                </button>

                <button
                  className="btn"
                  disabled={!!busyMessage}
                  onClick={() =>
                    void runAction('Hashing entire library for disaster recovery...', async () => {
                      await window.mediaLinker?.runHash({ strategy: 'full_library' });
                      setStatusBanner('Full Library Disaster Recovery Hashing complete.');
                    })
                  }
                >
                  2B. Hash Full Library (Catalog)
                </button>

                <button
                  className="btn"
                  disabled={!!busyMessage}
                  onClick={() =>
                    void runAction('Syncing qBittorrent torrents & files...', async () => {
                      const res = (await window.mediaLinker?.syncTorrents()) as {
                        torrentsSynced?: number;
                        totalDownloadFilesLinked?: number;
                      };
                      setStatusBanner(
                        `Synced ${res?.torrentsSynced ?? 0} torrents (${res?.totalDownloadFilesLinked ?? 0} download files linked).`,
                      );
                    })
                  }
                >
                  3. Sync qBittorrent
                </button>

                <button
                  className="btn success"
                  disabled={!!busyMessage}
                  onClick={() =>
                    void runAction('Finding & linking duplicates...', async () => {
                      const res = (await window.mediaLinker?.findDuplicates()) as {
                        duplicatesLinked?: number;
                        reclaimableBytes?: number;
                      };
                      setStatusBanner(
                        `Linked ${res?.duplicatesLinked ?? 0} duplicates (${formatBytes(res?.reclaimableBytes ?? 0)} reclaimable).`,
                      );
                    })
                  }
                >
                  4. Identify Duplicates
                </button>

                {busyMessage && (
                  <button
                    className="btn danger"
                    onClick={() => void window.mediaLinker?.cancelHash()}
                  >
                    Stop Hashing
                  </button>
                )}
              </div>
            </div>

            {hashProgress && (
              <div className="card">
                <h3>
                  Live Per-Drive Hashing Telemetry —{' '}
                  {formatBytes(hashProgress.aggregateSpeedBytesPerSec)}/s
                </h3>
                <div className="drives-grid">
                  {Object.values(hashProgress.drives).map((d) => {
                    const pct =
                      d.bytesTotal > 0
                        ? Math.min(100, Math.round((d.bytesCompleted / d.bytesTotal) * 100))
                        : 100;
                    return (
                      <div className="drive-card" key={d.drive}>
                        <div className="drive-header">
                          <span style={{ color: d.colorHsl }}>Drive {d.drive}:</span>
                          <span>
                            {d.filesCompleted}/{d.filesTotal} ({pct}%)
                          </span>
                        </div>
                        <div className="progress-track">
                          <div
                            className="progress-fill"
                            style={{ width: `${pct}%`, background: d.colorHsl }}
                          />
                        </div>
                        <div className="mono" style={{ color: 'var(--text-secondary)' }}>
                          {formatBytes(d.bytesCompleted)} / {formatBytes(d.bytesTotal)} •{' '}
                          {formatBytes(d.speedBytesPerSec)}/s
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </>
        )}

        {activeTab === 'workbench' && (() => {
          const query = workbenchSearch.trim().toLowerCase();
          const filteredPairs = query
            ? pendingPairs.filter(
                (p) =>
                  p.downloadFullPath.toLowerCase().includes(query) ||
                  p.mediaFullPath.toLowerCase().includes(query) ||
                  (p.torrentName && p.torrentName.toLowerCase().includes(query)),
              )
            : pendingPairs;
          const totalPages = Math.max(1, Math.ceil(filteredPairs.length / workbenchPageSize));
          const safePage = Math.min(Math.max(1, workbenchPage), totalPages);
          const startIdx = (safePage - 1) * workbenchPageSize;
          const pagePairs = filteredPairs.slice(startIdx, startIdx + workbenchPageSize);
          const allPageSelected =
            pagePairs.length > 0 && pagePairs.every((p) => selectedPairIds.has(p.downloadFileId));
          const selectedBytes = pendingPairs.reduce(
            (sum, p) => (selectedPairIds.has(p.downloadFileId) ? sum + p.fileSize : sum),
            0,
          );

          return (
            <div className="card">
              <div className="header-bar">
                <h3 id="workbench-table-heading">
                  Dry-Run Symlink Workbench ({pendingPairs.length.toLocaleString()} Ready —{' '}
                  {formatBytes(pendingPairs.reduce((s, p) => s + p.fileSize, 0))} Reclaimable)
                </h3>
                <div className="btn-row">
                  <button
                    className="btn"
                    disabled={filteredPairs.length === 0 || !!busyMessage}
                    onClick={() => {
                      const next = new Set(selectedPairIds);
                      for (const p of filteredPairs) next.add(p.downloadFileId);
                      setSelectedPairIds(next);
                    }}
                  >
                    Select All ({filteredPairs.length.toLocaleString()})
                  </button>
                  <button
                    className="btn"
                    disabled={selectedPairIds.size === 0 || !!busyMessage}
                    onClick={() => setSelectedPairIds(new Set())}
                  >
                    Clear Selection
                  </button>
                  <button
                    className="btn success"
                    disabled={selectedPairIds.size === 0 || !!busyMessage}
                    onClick={() =>
                      void runAction('Creating symlinks & verifying torrents...', async () => {
                        const res = (await window.mediaLinker?.processDuplicates({
                          fileIds: Array.from(selectedPairIds),
                          targetMode: config?.symlinkTargetMode ?? 'virtual',
                        })) as { succeeded?: number; bytesReclaimed?: number };
                        setStatusBanner(
                          `Created ${res?.succeeded ?? 0} symlinks (${formatBytes(res?.bytesReclaimed ?? 0)} reclaimed).`,
                        );
                        const updated = (await window.mediaLinker?.getPendingDuplicates()) ?? [];
                        setPendingPairs(updated);
                        setSelectedPairIds(new Set(updated.map((p) => p.downloadFileId)));
                      })
                    }
                  >
                    Execute Selected ({selectedPairIds.size.toLocaleString()} —{' '}
                    {formatBytes(selectedBytes)})
                  </button>
                </div>
              </div>

              <div className="pagination-bar">
                <div className="pagination-left">
                  <input
                    type="search"
                    className="input-box"
                    style={{ width: 280 }}
                    placeholder="Filter by file path or torrent..."
                    value={workbenchSearch}
                    onChange={(e) => {
                      setWorkbenchSearch(e.target.value);
                      setWorkbenchPage(1);
                    }}
                  />
                  <span className="pagination-info">
                    Showing{' '}
                    {filteredPairs.length === 0
                      ? '0'
                      : `${(startIdx + 1).toLocaleString()}–${Math.min(
                          startIdx + workbenchPageSize,
                          filteredPairs.length,
                        ).toLocaleString()}`}{' '}
                    of {filteredPairs.length.toLocaleString()} pairs
                  </span>
                </div>

                <div className="pagination-controls">
                  <label className="pagination-info">
                    Rows:
                    <select
                      className="input-box"
                      style={{ width: 80, marginLeft: 6 }}
                      value={workbenchPageSize}
                      onChange={(e) => {
                        setWorkbenchPageSize(Number(e.target.value));
                        setWorkbenchPage(1);
                      }}
                    >
                      <option value={25}>25</option>
                      <option value={50}>50</option>
                      <option value={100}>100</option>
                      <option value={250}>250</option>
                    </select>
                  </label>
                  <button
                    className="btn"
                    disabled={safePage <= 1}
                    onClick={() => setWorkbenchPage(1)}
                  >
                    « First
                  </button>
                  <button
                    className="btn"
                    disabled={safePage <= 1}
                    onClick={() => setWorkbenchPage((p) => Math.max(1, p - 1))}
                  >
                    ‹ Prev
                  </button>
                  <span className="pagination-info">
                    Page <strong>{safePage}</strong> of <strong>{totalPages}</strong>
                  </span>
                  <button
                    className="btn"
                    disabled={safePage >= totalPages}
                    onClick={() => setWorkbenchPage((p) => Math.min(totalPages, p + 1))}
                  >
                    Next ›
                  </button>
                  <button
                    className="btn"
                    disabled={safePage >= totalPages}
                    onClick={() => setWorkbenchPage(totalPages)}
                  >
                    Last »
                  </button>
                </div>
              </div>

              <div
                tabIndex={0}
                role="region"
                aria-labelledby="workbench-table-heading"
                className="table-wrapper"
              >
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>
                        <input
                          type="checkbox"
                          title="Select/deselect current page"
                          checked={allPageSelected}
                          onChange={(e) => {
                            const next = new Set(selectedPairIds);
                            if (e.target.checked) {
                              for (const p of pagePairs) next.add(p.downloadFileId);
                            } else {
                              for (const p of pagePairs) next.delete(p.downloadFileId);
                            }
                            setSelectedPairIds(next);
                          }}
                        />
                      </th>
                      <th>Download File</th>
                      <th>Proposed Target ({config?.symlinkTargetMode ?? 'virtual'})</th>
                      <th>Size</th>
                      <th>Torrent</th>
                    </tr>
                  </thead>
                  <tbody>
                    {pagePairs.map((p) => (
                      <tr key={p.downloadFileId}>
                        <td>
                          <input
                            type="checkbox"
                            checked={selectedPairIds.has(p.downloadFileId)}
                            onChange={(e) => {
                              const next = new Set(selectedPairIds);
                              if (e.target.checked) next.add(p.downloadFileId);
                              else next.delete(p.downloadFileId);
                              setSelectedPairIds(next);
                            }}
                          />
                        </td>
                        <td className="mono">{p.downloadFullPath}</td>
                        <td className="mono">
                          {config?.symlinkTargetMode === 'physical'
                            ? p.proposedTargetPhysical
                            : p.proposedTargetVirtual}
                        </td>
                        <td style={{ whiteSpace: 'nowrap' }}>{formatBytes(p.fileSize)}</td>
                        <td>
                          {p.torrentName ? (
                            <span className="badge emerald">{p.torrentName}</span>
                          ) : (
                            <span className="badge amber">Untracked</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {totalPages > 1 && (
                <div className="pagination-bar" style={{ marginTop: 12, marginBottom: 0 }}>
                  <span className="pagination-info">
                    Selected: <strong>{selectedPairIds.size.toLocaleString()}</strong> files (
                    {formatBytes(selectedBytes)})
                  </span>
                  <div className="pagination-controls">
                    <button
                      className="btn"
                      disabled={safePage <= 1}
                      onClick={() => setWorkbenchPage(1)}
                    >
                      « First
                    </button>
                    <button
                      className="btn"
                      disabled={safePage <= 1}
                      onClick={() => setWorkbenchPage((p) => Math.max(1, p - 1))}
                    >
                      ‹ Prev
                    </button>
                    <span className="pagination-info">
                      Page <strong>{safePage}</strong> of <strong>{totalPages}</strong>
                    </span>
                    <button
                      className="btn"
                      disabled={safePage >= totalPages}
                      onClick={() => setWorkbenchPage((p) => Math.min(totalPages, p + 1))}
                    >
                      Next ›
                    </button>
                    <button
                      className="btn"
                      disabled={safePage >= totalPages}
                      onClick={() => setWorkbenchPage(totalPages)}
                    >
                      Last »
                    </button>
                  </div>
                </div>
              )}
            </div>
          );
        })()}

        {activeTab === 'healer' && (
          <div className="card">
            <div className="header-bar">
              <h3>
                Priority #1: Broken Symlink Detector & Auto-Healer ({brokenSymlinks.length} Found)
              </h3>
              <div className="btn-row">
                <button
                  className="btn"
                  onClick={() =>
                    void runAction('Scanning symlinks...', async () => {
                      if (!window.mediaLinker) return;
                      setBrokenSymlinks(await window.mediaLinker.scanBrokenSymlinks());
                    })
                  }
                >
                  Re-Scan Symlinks
                </button>
                <button
                  className="btn success"
                  disabled={!brokenSymlinks.some((b) => b.canAutoHeal) || !!busyMessage}
                  onClick={() =>
                    void runAction('Auto-healing broken symlinks...', async () => {
                      if (!window.mediaLinker) return;
                      const res = (await window.mediaLinker.healBrokenSymlinks(
                        brokenSymlinks.filter((b) => b.canAutoHeal),
                        config?.symlinkTargetMode ?? 'virtual',
                      )) as { healed?: number; restoredFromBak?: number };
                      setStatusBanner(
                        `Healed ${res?.healed ?? 0} symlinks and restored ${res?.restoredFromBak ?? 0} from .bak.`,
                      );
                      setBrokenSymlinks(await window.mediaLinker.scanBrokenSymlinks());
                    })
                  }
                >
                  Auto-Heal All Repairable (
                  {brokenSymlinks.filter((b) => b.canAutoHeal).length})
                </button>
              </div>
            </div>

            <table className="data-table">
              <thead>
                <tr>
                  <th>Symlink Path</th>
                  <th>Issue Classification</th>
                  <th>Broken Target</th>
                  <th>Proposed Heal Target</th>
                </tr>
              </thead>
              <tbody>
                {brokenSymlinks.map((b) => (
                  <tr key={b.symlinkPath}>
                    <td className="mono">{b.symlinkPath}</td>
                    <td>
                      <span
                        className={`badge ${
                          b.classification === 'drivepool_rebalanced'
                            ? 'blue'
                            : b.classification === 'covefs_0byte_corrupted'
                              ? 'rose'
                              : 'amber'
                        }`}
                      >
                        {b.classification}
                      </span>
                    </td>
                    <td className="mono">{b.currentTarget}</td>
                    <td className="mono">
                      {b.proposedTargetVirtual ??
                        b.proposedTargetPhysical ??
                        (b.hasBackupFile ? 'Restore .bak' : 'Unrecoverable')}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {activeTab === 'vault' && (
          <div className="card">
            <div className="header-bar">
              <h3>
                Priority #2: .bak Safety Vault & One-Click Undo ({bakItems.length} Backups —{' '}
                {formatBytes(bakItems.reduce((s, b) => s + b.fileSize, 0))})
              </h3>
              <div className="btn-row">
                <button
                  className="btn danger"
                  disabled={!bakItems.some((b) => b.safeToDeleteBak) || !!busyMessage}
                  onClick={() =>
                    void runAction('Purging verified .bak files...', async () => {
                      if (!window.mediaLinker) return;
                      const res = (await window.mediaLinker.cleanupBakFiles({
                        requireHealthySymlink: true,
                      })) as { deleted?: number; bytesReclaimed?: number };
                      setStatusBanner(
                        `Purged ${res?.deleted ?? 0} verified .bak files (${formatBytes(res?.bytesReclaimed ?? 0)} freed).`,
                      );
                      setBakItems(await window.mediaLinker.listBakFiles());
                    })
                  }
                >
                  Purge All Verified .bak Files (
                  {bakItems.filter((b) => b.safeToDeleteBak).length})
                </button>
              </div>
            </div>

            <table className="data-table">
              <thead>
                <tr>
                  <th>Backup File (.bak)</th>
                  <th>Size</th>
                  <th>Symlink & Target Status</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                {bakItems.map((b) => (
                  <tr key={b.backupPath}>
                    <td className="mono">{b.backupPath}</td>
                    <td>{formatBytes(b.fileSize)}</td>
                    <td>
                      {b.safeToDeleteBak ? (
                        <span className="badge emerald">Verified Healthy</span>
                      ) : (
                        <span className="badge rose">Target Unhealthy — Keep .bak</span>
                      )}
                    </td>
                    <td>
                      <button
                        className="btn"
                        onClick={() =>
                          void runAction('Restoring .bak file...', async () => {
                            if (!window.mediaLinker) return;
                            await window.mediaLinker.restoreBakFiles([b.backupPath]);
                            setBakItems(await window.mediaLinker.listBakFiles());
                          })
                        }
                      >
                        Undo (Restore Original)
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {activeTab === 'orphans' && (
          <div className="card">
            <div className="header-bar">
              <h3>
                Priority #3: Orphaned Downloads Finder ({orphanItems.length} Untracked Files —{' '}
                {formatBytes(orphanItems.reduce((s, o) => s + o.fileSize, 0))})
              </h3>
              <div className="btn-row">
                <button
                  className="btn danger"
                  disabled={
                    !orphanItems.some((o) => o.classification === 'already_in_media') ||
                    !!busyMessage
                  }
                  onClick={() =>
                    void runAction(
                      'Deleting orphaned downloads that already exist in Media...',
                      async () => {
                        if (!window.mediaLinker) return;
                        const safeIds = orphanItems
                          .filter((o) => o.classification === 'already_in_media')
                          .map((o) => o.fileId);
                        const res = (await window.mediaLinker.deleteOrphanedFiles(safeIds)) as {
                          deleted?: number;
                          bytesReclaimed?: number;
                        };
                        setStatusBanner(
                          `Deleted ${res?.deleted ?? 0} redundant orphaned downloads (${formatBytes(res?.bytesReclaimed ?? 0)} reclaimed).`,
                        );
                        setOrphanItems(await window.mediaLinker.findOrphanedDownloads());
                      },
                    )
                  }
                >
                  Delete All &quot;Already in Media&quot; (
                  {orphanItems.filter((o) => o.classification === 'already_in_media').length})
                </button>
              </div>
            </div>

            <table className="data-table">
              <thead>
                <tr>
                  <th>Download Path</th>
                  <th>Size</th>
                  <th>Status</th>
                  <th>Matching Media File</th>
                </tr>
              </thead>
              <tbody>
                {orphanItems.map((o) => (
                  <tr key={o.fileId}>
                    <td className="mono">{o.fullPath}</td>
                    <td>{formatBytes(o.fileSize)}</td>
                    <td>
                      {o.classification === 'already_in_media' ? (
                        <span className="badge emerald">Already in Media (Safe Delete)</span>
                      ) : (
                        <span className="badge amber">Unique to Downloads (Unimported)</span>
                      )}
                    </td>
                    <td className="mono">{o.matchingMediaPath ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {activeTab === 'target_tester' && (
          <div className="card">
            <h3>Priority #4: Symlink Target Mode Toggle & Live DrivePool Tester</h3>
            <p style={{ color: 'var(--text-secondary)', marginBottom: 14 }}>
              Choose whether symlinks created on physical PoolPart drives point their target to the{' '}
              <strong>Virtual DrivePool path (M:\Media\...)</strong> (survives DrivePool
              rebalancing) or the <strong>Physical PoolPart path (X:\PoolPart...\Media\...)</strong>
              .
            </p>
            <div className="btn-row" style={{ marginBottom: 16 }}>
              <button
                className={`btn ${config?.symlinkTargetMode === 'virtual' ? 'primary' : ''}`}
                onClick={() =>
                  void runAction('Switching to Virtual Target Mode...', async () => {
                    if (!window.mediaLinker) return;
                    setConfig(
                      await window.mediaLinker.updateConfig({ symlinkTargetMode: 'virtual' }),
                    );
                  })
                }
              >
                Use Virtual Target (M:\Media\...) [Recommended]
              </button>

              <button
                className={`btn ${config?.symlinkTargetMode === 'physical' ? 'primary' : ''}`}
                onClick={() =>
                  void runAction('Switching to Physical Target Mode...', async () => {
                    if (!window.mediaLinker) return;
                    setConfig(
                      await window.mediaLinker.updateConfig({ symlinkTargetMode: 'physical' }),
                    );
                  })
                }
              >
                Use Physical Target (X:\PoolPart...\Media\...)
              </button>

              <button
                className="btn success"
                onClick={() =>
                  void runAction('Running live symlink sandbox test...', async () => {
                    if (!window.mediaLinker) return;
                    setSandboxResult(await window.mediaLinker.runTargetSandboxTest());
                  })
                }
              >
                Run Sandbox & Rebalance Test
              </button>

              <button
                className="btn"
                onClick={() =>
                  void runAction('Converting existing symlinks to Virtual M:\\ targets...', async () => {
                    if (!window.mediaLinker) return;
                    const res = (await window.mediaLinker.convertExistingTargets('virtual')) as {
                      converted?: number;
                    };
                    setStatusBanner(
                      `Converted ${res?.converted ?? 0} existing symlinks to Virtual M:\\ targets.`,
                    );
                  })
                }
              >
                Convert Existing Symlinks → Virtual M:\
              </button>
            </div>

            {sandboxResult && (
              <div className="drive-card">
                <div className="drive-header">Sandbox Verification Results</div>
                <ul style={{ paddingLeft: 18 }}>
                  <li>
                    NTFS Symlink Creation:{' '}
                    <strong>{sandboxResult.canCreateSymlinks ? 'PASSED' : 'FAILED'}</strong>
                  </li>
                  <li>
                    Virtual Target Read & Hash Verification:{' '}
                    <strong>{sandboxResult.hashVerificationPassed ? 'PASSED' : 'FAILED'}</strong>
                  </li>
                  <li>
                    Virtual Target Survives DrivePool Rebalance:{' '}
                    <strong>
                      {sandboxResult.virtualSurvivesRebalance ? 'YES (Survived)' : 'NO'}
                    </strong>
                  </li>
                  <li>
                    Physical Target Breaks on DrivePool Rebalance:{' '}
                    <strong>
                      {sandboxResult.physicalBreaksOnRebalance
                        ? 'CONFIRMED (Breaks when moved)'
                        : 'NO'}
                    </strong>
                  </li>
                  {sandboxResult.summaryNotes.map((note, idx) => (
                    <li key={idx} style={{ color: 'var(--text-secondary)', marginTop: 4 }}>
                      {note}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}

        {activeTab === 'intramedia_catalog' && (
          <>
            <div className="card">
              <h3>
                Priority #5: Intra-Media Duplicate Manager ({intraGroups.length} Duplicate Sets in
                M:\Media — {formatBytes(intraGroups.reduce((s, g) => s + g.wastedBytes, 0))}{' '}
                Wasted)
              </h3>
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Primary File Kept</th>
                    <th>Redundant Copies</th>
                    <th>Wasted Space</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {intraGroups.slice(0, 100).map((g) => {
                    const keepFile =
                      g.files.find((f) => f.id === g.recommendedKeepId) ?? g.files[0];
                    const redundantIds = g.files
                      .filter((f) => f.id !== keepFile.id)
                      .map((f) => f.id);
                    return (
                      <tr key={g.xxh128Hash}>
                        <td className="mono">{keepFile.fullPath}</td>
                        <td>{g.copyCount - 1} extra copy/copies</td>
                        <td>{formatBytes(g.wastedBytes)}</td>
                        <td className="btn-row">
                          <button
                            className="btn primary"
                            onClick={() =>
                              void runAction('Symlinking redundant Media copy...', async () => {
                                if (!window.mediaLinker) return;
                                await window.mediaLinker.resolveIntraMediaSet(
                                  keepFile.id,
                                  redundantIds,
                                  'symlink',
                                );
                                setIntraGroups(
                                  await window.mediaLinker.findIntraMediaDuplicates(),
                                );
                              })
                            }
                          >
                            Symlink Extra Copies
                          </button>
                          <button
                            className="btn danger"
                            onClick={() =>
                              void runAction('Deleting redundant Media copy...', async () => {
                                if (!window.mediaLinker) return;
                                await window.mediaLinker.resolveIntraMediaSet(
                                  keepFile.id,
                                  redundantIds,
                                  'delete',
                                );
                                setIntraGroups(
                                  await window.mediaLinker.findIntraMediaDuplicates(),
                                );
                              })
                            }
                          >
                            Delete Extra Copies
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <div className="card">
              <div className="header-bar">
                <h3>Drive Disaster Recovery Catalog (Per-Drive Hash Coverage)</h3>
                <button
                  className="btn primary"
                  onClick={() =>
                    void runAction('Exporting full pool recovery manifest...', async () => {
                      await window.mediaLinker?.exportDriveManifest('ALL');
                      setStatusBanner('Exported full pool disaster recovery manifest.');
                    })
                  }
                >
                  Export Full Pool Catalog (JSON)
                </button>
              </div>
              <div className="drives-grid">
                {driveSummaries.map((d) => (
                  <div className="drive-card" key={d.drive}>
                    <div className="drive-header">
                      <span style={{ color: d.colorHsl }}>Drive {d.drive}:</span>
                      <span>{d.coveragePercent}% Hashed</span>
                    </div>
                    <div className="progress-track">
                      <div
                        className="progress-fill"
                        style={{ width: `${d.coveragePercent}%`, background: d.colorHsl }}
                      />
                    </div>
                    <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                      {d.totalFiles.toLocaleString()} files ({formatBytes(d.totalBytes)}) •{' '}
                      <strong>{d.uniqueFilesAtRisk.toLocaleString()}</strong> unique to this drive
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </>
        )}

        <div className="log-console">
          <div className="log-console-header">
            <span>
              Live Activity Log ({config?.logFilePath ?? 'media_linker_v3.log'})
            </span>
            <button
              className="btn"
              style={{ padding: '3px 9px', fontSize: 11 }}
              onClick={() => setLogs([])}
            >
              Clear View
            </button>
          </div>
          <div className="log-entries" ref={logContainerRef}>
            {logs.length === 0 ? (
              <div style={{ color: '#64748b' }}>Ready. Waiting for actions...</div>
            ) : (
              logs.map((l) => (
                <div className="log-line" key={l.id}>
                  <span className="log-time">{l.timestamp}</span>
                  <span className={`log-level ${l.level}`}>{l.level}</span>
                  <span className="log-source">[{l.source}]</span>
                  <span>{l.message}</span>
                </div>
              ))
            )}
          </div>
        </div>
      </main>
    </div>
  );
}
