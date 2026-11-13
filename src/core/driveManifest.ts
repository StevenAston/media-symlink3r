import fs from 'node:fs';
import { AppConfig } from './config';
import { withDatabase } from './database';
import { getHslColorForBar } from './utils';

export interface DriveRecoverySummary {
  drive: string;
  colorHsl: string;
  totalFiles: number;
  totalBytes: number;
  hashedFiles: number;
  hashedBytes: number;
  coveragePercent: number;
  uniqueFilesAtRisk: number;
  duplicatedOnOtherDriveFiles: number;
}

export interface DriveManifestFileEntry {
  id: number;
  fullPath: string;
  virtualPath: string | null;
  physicalDrive: string;
  scanSource: string;
  filename: string;
  fileSize: number;
  xxh128Hash: string | null;
  torrentHash: string | null;
  torrentName: string | null;
  hasBackupOnAnotherDrive: boolean;
}

export function getDriveRecoveryCatalogSummary(config: AppConfig): DriveRecoverySummary[] {
  return withDatabase(config.dbFilePath, (db) => {
    const rows = db
      .prepare(
        `SELECT
           COALESCE(physical_drive, 'OTHER') AS drive,
           COUNT(*) AS totalFiles,
           COALESCE(SUM(file_size), 0) AS totalBytes,
           SUM(CASE WHEN xxh128_hash IS NOT NULL THEN 1 ELSE 0 END) AS hashedFiles,
           COALESCE(SUM(CASE WHEN xxh128_hash IS NOT NULL THEN file_size ELSE 0 END), 0) AS hashedBytes
         FROM files
         WHERE is_symlink = 0
         GROUP BY COALESCE(physical_drive, 'OTHER')
         ORDER BY drive ASC`,
      )
      .all() as Array<{
      drive: string;
      totalFiles: number;
      totalBytes: number;
      hashedFiles: number;
      hashedBytes: number;
    }>;

    const duplicatedCheckStmt = db.prepare(`
      SELECT COUNT(*) AS dupCount
      FROM files f1
      WHERE f1.is_symlink = 0
        AND COALESCE(f1.physical_drive, 'OTHER') = ?
        AND f1.xxh128_hash IS NOT NULL
        AND f1.file_size > 0
        AND EXISTS (
          SELECT 1
          FROM files f2
          WHERE f2.is_symlink = 0
            AND COALESCE(f2.physical_drive, 'OTHER') != COALESCE(f1.physical_drive, 'OTHER')
            AND f2.file_size = f1.file_size
            AND f2.xxh128_hash = f1.xxh128_hash
        )
    `);

    return rows.map((r) => {
      const dupRow = duplicatedCheckStmt.get(r.drive) as { dupCount: number } | undefined;
      const duplicatedCount = Number(dupRow?.dupCount ?? 0);
      const totalFiles = Number(r.totalFiles ?? 0);
      const totalBytes = Number(r.totalBytes ?? 0);
      const hashedFiles = Number(r.hashedFiles ?? 0);
      const hashedBytes = Number(r.hashedBytes ?? 0);
      const coveragePercent =
        totalBytes > 0 ? Math.min(100, Number(((hashedBytes / totalBytes) * 100).toFixed(2))) : 100;

      return {
        drive: r.drive,
        colorHsl: getHslColorForBar(r.drive),
        totalFiles,
        totalBytes,
        hashedFiles,
        hashedBytes,
        coveragePercent,
        uniqueFilesAtRisk: Math.max(0, totalFiles - duplicatedCount),
        duplicatedOnOtherDriveFiles: duplicatedCount,
      };
    });
  });
}

export function exportDriveDisasterRecoveryManifest(
  config: AppConfig,
  driveLetter: string,
  outputPath: string,
): {
  drive: string;
  totalExported: number;
  uniqueAtRiskCount: number;
  outputPath: string;
} {
  const normalizedDrive = driveLetter.toUpperCase();

  return withDatabase(config.dbFilePath, (db) => {
    const whereDrive =
      normalizedDrive === 'ALL' ? '' : `AND UPPER(COALESCE(f1.physical_drive, 'OTHER')) = ?`;
    const params = normalizedDrive === 'ALL' ? [] : [normalizedDrive];

    const rows = db
      .prepare(
        `SELECT
           f1.id AS id,
           f1.full_path AS fullPath,
           f1.virtual_path AS virtualPath,
           COALESCE(f1.physical_drive, 'OTHER') AS physicalDrive,
           f1.scan_source AS scanSource,
           f1.filename AS filename,
           f1.file_size AS fileSize,
           f1.xxh128_hash AS xxh128Hash,
           f1.torrent_hash AS torrentHash,
           f1.torrent_name AS torrentName,
           CASE WHEN f1.xxh128_hash IS NOT NULL AND f1.file_size > 0 AND EXISTS (
             SELECT 1 FROM files f2
             WHERE f2.is_symlink = 0
               AND COALESCE(f2.physical_drive, 'OTHER') != COALESCE(f1.physical_drive, 'OTHER')
               AND f2.file_size = f1.file_size
               AND f2.xxh128_hash = f1.xxh128_hash
           ) THEN 1 ELSE 0 END AS hasOtherDriveCopy
         FROM files f1
         WHERE f1.is_symlink = 0 ${whereDrive}
         ORDER BY f1.physical_drive ASC, f1.virtual_path ASC, f1.full_path ASC`,
      )
      .all(...params) as Array<{
      id: number;
      fullPath: string;
      virtualPath: string | null;
      physicalDrive: string;
      scanSource: string;
      filename: string;
      fileSize: number;
      xxh128Hash: string | null;
      torrentHash: string | null;
      torrentName: string | null;
      hasOtherDriveCopy: number;
    }>;

    const entries: DriveManifestFileEntry[] = rows.map((r) => ({
      id: r.id,
      fullPath: r.fullPath,
      virtualPath: r.virtualPath,
      physicalDrive: r.physicalDrive,
      scanSource: r.scanSource,
      filename: r.filename,
      fileSize: r.fileSize,
      xxh128Hash: r.xxh128Hash,
      torrentHash: r.torrentHash,
      torrentName: r.torrentName,
      hasBackupOnAnotherDrive: r.hasOtherDriveCopy === 1,
    }));

    const uniqueAtRiskCount = entries.filter((e) => !e.hasBackupOnAnotherDrive).length;

    const payload = {
      generatedAt: new Date().toISOString(),
      drive: normalizedDrive,
      totalFiles: entries.length,
      uniqueAtRiskCount,
      files: entries,
    };

    fs.writeFileSync(outputPath, JSON.stringify(payload, null, 2), 'utf8');

    return {
      drive: normalizedDrive,
      totalExported: entries.length,
      uniqueAtRiskCount,
      outputPath,
    };
  });
}
