import fs from 'node:fs';
import path from 'node:path';

/**
 * Formats byte count into a human-readable IEC string (B, KiB, MiB, GiB, TiB, PiB).
 */
export function formatSize(sizeBytes: number): string {
  if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) {
    return '0 B';
  }
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'];
  const i = Math.min(Math.floor(Math.log(sizeBytes) / Math.log(1024)), units.length - 1);
  if (i === 0) {
    return `${Math.round(sizeBytes)} B`;
  }
  const p = Math.pow(1024, i);
  return `${(sizeBytes / p).toFixed(2)} ${units[i]}`;
}

/**
 * Parses a human-readable size string (e.g. '100M', '2.5GiB', '1024') or number into bytes.
 * Returns null for invalid or empty input.
 */
export function parseSize(sizeInput?: string | number | null): number | null {
  if (typeof sizeInput === 'number') {
    return Number.isFinite(sizeInput) && sizeInput >= 0 ? Math.floor(sizeInput) : null;
  }
  if (!sizeInput || typeof sizeInput !== 'string') return null;
  const trimmed = sizeInput.trim().toLowerCase();
  if (!trimmed) return null;

  const match = trimmed.match(/^(\d+(?:\.\d+)?)\s*([a-z]+)?$/);
  if (!match) {
    return null;
  }

  const value = parseFloat(match[1]);
  const unit = match[2] || '';

  const units: Record<string, number> = {
    '': 1,
    b: 1,
    k: 1024,
    kb: 1024,
    ki: 1024,
    kib: 1024,
    m: 1024 ** 2,
    mb: 1024 ** 2,
    mi: 1024 ** 2,
    mib: 1024 ** 2,
    g: 1024 ** 3,
    gb: 1024 ** 3,
    gi: 1024 ** 3,
    gib: 1024 ** 3,
    t: 1024 ** 4,
    tb: 1024 ** 4,
    ti: 1024 ** 4,
    tib: 1024 ** 4,
    p: 1024 ** 5,
    pb: 1024 ** 5,
    pi: 1024 ** 5,
    pib: 1024 ** 5,
  };

  if (!(unit in units)) {
    return null;
  }

  return Math.round(value * units[unit]);
}

/**
 * Truncates a long file path to fit in a fixed character budget, preserving prefix and suffix.
 */
export function truncatePath(filePath: string, maxLen = 80): string {
  if (filePath.length <= maxLen) return filePath;
  if (maxLen <= 3) return '.'.repeat(Math.max(0, maxLen));

  const ellipsis = '...';
  const remaining = maxLen - ellipsis.length;
  const headLen = Math.ceil(remaining * 0.4);
  const tailLen = remaining - headLen;
  return `${filePath.slice(0, headLen)}${ellipsis}${filePath.slice(filePath.length - tailLen)}`;
}

/**
 * Generates a deterministic HSL color string for a drive letter ('D', 'D:\\') or bar index.
 */
export function getHslColorForBar(
  barIndexOrDrive: number | string,
  totalBars = 10,
): string {
  if (typeof barIndexOrDrive === 'string') {
    const clean = barIndexOrDrive.trim().toUpperCase();
    const code = clean.charCodeAt(0) || 68;
    const hue = ((code - 65) * 37) % 360;
    return `hsl(${hue}, 75%, 55%)`;
  }
  const safeTotal = Math.max(1, totalBars);
  const hue = Math.round(((barIndexOrDrive % safeTotal) / safeTotal) * 360);
  return `hsl(${hue}, 75%, 55%)`;
}

/**
 * Normalizes a Windows path (backslashes, trimmed trailing slash except drive root).
 */
export function normalizeWinPath(inputPath: string): string {
  const replaced = String(inputPath).replace(/\//g, '\\').trim();
  if (/^[A-Za-z]:\\?$/.test(replaced)) {
    return `${replaced[0].toUpperCase()}:\\`;
  }
  return replaced.replace(/\\+$/, '');
}

const POOLPART_CAPTURE_REGEX = /^(?:([A-Za-z]):\\(?:.*\\)?)?PoolPart\.[^\\]+\\(.*)$/i;

/**
 * Extracts the pool-relative path (e.g. 'Downloads\\moistbox\\file.mkv') from either
 * a physical PoolPart path ('Z:\\PoolPart.guid\\Downloads\\...') or a virtual pool path ('M:\\Downloads\\...').
 */
export function extractRelativePoolPath(
  anyPath: string,
  virtualPoolRoot = 'M:\\',
): string | null {
  const norm = normalizeWinPath(anyPath);
  const poolMatch = norm.match(POOLPART_CAPTURE_REGEX);
  if (poolMatch) {
    return poolMatch[2];
  }

  const normRoot = normalizeWinPath(virtualPoolRoot);
  if (norm.toLowerCase().startsWith(normRoot.toLowerCase())) {
    const rest = norm.slice(normRoot.length).replace(/^\\+/, '');
    return rest || null;
  }

  return null;
}

/**
 * Converts a physical StableBit DrivePool path ('Z:\\PoolPart.guid\\Downloads\\a.mkv')
 * into its virtual pool path ('M:\\Downloads\\a.mkv').
 */
export function physicalToVirtualPath(
  physicalPath: string,
  virtualPoolRoot = 'M:\\',
): string | null {
  const rel = extractRelativePoolPath(physicalPath, virtualPoolRoot);
  if (!rel) return null;
  const root = normalizeWinPath(virtualPoolRoot);
  return root.endsWith('\\') ? `${root}${rel}` : `${root}\\${rel}`;
}

/**
 * Resolves a virtual pool path ('M:\\Media\\Movies\\a.mkv') into a physical PoolPart path.
 * Supports either:
 *   virtualToPhysicalPath(virtualPath, physicalDrivePaths, virtualPoolRoot?, existsCheck?)
 * or:
 *   virtualToPhysicalPath(virtualPath, driveLetter, physicalDrivePaths, virtualPoolRoot?)
 */
export function virtualToPhysicalPath(
  virtualPath: string,
  driveOrMap: string | Record<string, string>,
  mapOrRoot?: Record<string, string> | string,
  rootOrExistsCheck?: string | ((candidate: string) => boolean),
): string | null {
  if (typeof driveOrMap === 'string') {
    const driveLetter = driveOrMap;
    const physicalDrivePaths = (mapOrRoot as Record<string, string>) ?? {};
    const virtualPoolRoot =
      typeof rootOrExistsCheck === 'string' ? rootOrExistsCheck : 'M:\\';
    const rel = extractRelativePoolPath(virtualPath, virtualPoolRoot);
    const poolPartRoot = physicalDrivePaths[driveLetter.toUpperCase()];
    if (!rel || !poolPartRoot) return null;
    return `${normalizeWinPath(poolPartRoot)}\\${rel}`;
  }

  const physicalDrivePaths = driveOrMap;
  const virtualPoolRoot = typeof mapOrRoot === 'string' ? mapOrRoot : 'M:\\';
  const existsCheck: (candidate: string) => boolean =
    typeof rootOrExistsCheck === 'function' ? rootOrExistsCheck : fs.existsSync;

  const rel = extractRelativePoolPath(virtualPath, virtualPoolRoot);
  if (!rel) return null;

  for (const poolPartRoot of Object.values(physicalDrivePaths)) {
    const candidate = `${normalizeWinPath(poolPartRoot)}\\${rel}`;
    if (existsCheck(candidate)) {
      return candidate;
    }
  }
  return null;
}

/**
 * Extracts the physical drive letter from a PoolPart path (including sandbox DriveX\PoolPart paths).
 */
export function extractPhysicalDriveLetter(filePath: string): string | null {
  const norm = normalizeWinPath(filePath);
  const sandboxDriveMatch = norm.match(/\\Drive([A-Za-z])\\PoolPart\./i);
  if (sandboxDriveMatch) {
    return sandboxDriveMatch[1].toUpperCase();
  }
  const directPoolMatch = norm.match(/^([A-Za-z]):\\PoolPart\./i);
  if (directPoolMatch) {
    return directPoolMatch[1].toUpperCase();
  }
  const anyDriveMatch = norm.match(/^([A-Za-z]):\\/);
  return anyDriveMatch ? anyDriveMatch[1].toUpperCase() : null;
}
