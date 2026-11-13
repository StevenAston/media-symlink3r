# Media Symlinker v3 (`media-symlink3r`)

Ground-up Electron + TypeScript rebuild of **Media Symlinker** for **StableBit DrivePool (`CoveFS`)** and **qBittorrent**.

Deduplicates files across `M:\Downloads` and `M:\Media` across all physical `PoolPart.*` drives by replacing duplicate download files with NTFS symlinks while keeping torrents seeding at 100%.

---

## Key Improvements Over Legacy `v1` / `v2`

1. **Zero 0-Byte Collision Bug & Full `CoveFS` Reparse Awareness**:
   - Explicitly excludes `file_size = 0` from duplicate linking and detects StableBit DrivePool `CoveFS` virtual symlink stubs (`inspectSymlinkState`), preventing the legacy bug where 0-byte `CoveFS` stubs were matched to a 0-byte `.srt` file.
2. **Smart Candidate Hashing + Full Library Disaster Recovery Catalog**:
   - **Smart Candidate Mode (Default)**: Filters by byte-size intersection $\rightarrow$ 3-point sparse `xxh128` hash (`1 MiB` head/mid/tail) $\rightarrow$ full `xxh128` hash on collisions.
   - **Full Library Catalog Mode**: Hashes every file per physical drive (`D:`–`Z:`) and exports per-drive disaster recovery manifests (`driveManifest.ts`) so you always know which files were on a failed drive and whether a copy exists elsewhere in the pool.
3. **Priority Features**:
   - **Priority #1 — Broken Symlink Detector & Auto-Healer (`brokenSymlinkHealer.ts`)**: Automatically detects and repairs symlinks broken by DrivePool rebalancing, 0-byte CoveFS stub corruption, or renamed/moved targets.
   - **Priority #2 — `.bak` Safety Vault & One-Click Undo (`bakVault.ts`)**: Tracks every `.bak` backup in `symlink_history`, verifies active symlink target health + qBittorrent recheck completion before allowing `.bak` deletion, and supports 1-click Undo/Restore.
   - **Priority #3 — Orphaned Downloads Finder (`orphanFinder.ts`)**: Identifies untracked files in `Downloads` (`torrent_hash IS NULL`) and classifies them into *Already in Media (Safe to Delete)* vs *Unique to Downloads (Unimported)*.
   - **Priority #4 — Symlink Target Mode Toggle, Sandbox Tester & Batch Converter (`symlinkTargetTester.ts`)**: Switch between **Virtual Target Mode (`M:\Media\...`)** (survives DrivePool rebalancing) and **Physical Target Mode (`X:\PoolPart...\Media\...`)**, run live rebalance simulations, and batch-convert existing symlinks.
   - **Priority #5 — Intra-Media Duplicate Manager (`intraMediaManager.ts`)**: Finds and resolves duplicate files inside `M:\Media` itself (via symlink or deletion).

---

## Quick Start

```powershell
cd v3
npm install
npm test          # Run Vitest unit & integration test suite
npm run build     # Build React renderer + Electron main/preload
npm start         # Launch Electron desktop app
```
