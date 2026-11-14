import { describe, expect, it } from 'vitest';
import {
  createDefaultConfig,
  discoverDrivePoolPaths,
  extractPhysicalDriveLetter,
  extractRelativePoolPath,
  formatDisplayPoolPath,
  formatSize,
  getHslColorForBar,
  parseSize,
  physicalToVirtualPath,
  truncatePath,
  virtualToPhysicalPath,
} from '../src/core';

describe('utils.ts & config.ts', () => {
  it('formats byte sizes into human-readable IEC strings', () => {
    expect(formatSize(0)).toBe('0 B');
    expect(formatSize(-10)).toBe('0 B');
    expect(formatSize(512)).toBe('512 B');
    expect(formatSize(1024)).toBe('1.00 KiB');
    expect(formatSize(1024 * 1024)).toBe('1.00 MiB');
    expect(formatSize(2.5 * 1024 * 1024 * 1024)).toBe('2.50 GiB');
  });

  it('parses human-readable size strings into bytes', () => {
    expect(parseSize(4096)).toBe(4096);
    expect(parseSize('1024')).toBe(1024);
    expect(parseSize('10 KB')).toBe(10 * 1024);
    expect(parseSize('5 MiB')).toBe(5 * 1024 * 1024);
    expect(parseSize('2 GiB')).toBe(2 * 1024 * 1024 * 1024);
    expect(parseSize('1.5 TiB')).toBe(Math.round(1.5 * Math.pow(1024, 4)));
    expect(parseSize('invalid')).toBeNull();
  });

  it('truncates long paths while preserving prefix and suffix', () => {
    const short = 'M:\\Media\\Show.mkv';
    expect(truncatePath(short, 40)).toBe(short);

    const longPath =
      'U:\\PoolPart.6610f243-02f1-4552-ae81-c9fdae7722fe\\Media\\TV\\LongSeriesName\\Season 01\\Episode.mkv';
    const truncated = truncatePath(longPath, 35);
    expect(truncated.length).toBe(35);
    expect(truncated).toContain('...');
    expect(truncated.endsWith('Episode.mkv')).toBe(true);
  });

  it('generates deterministic HSL colors per physical drive letter', () => {
    const colorD = getHslColorForBar('D');
    const colorZ = getHslColorForBar('Z');
    expect(colorD).toMatch(/^hsl\(\d+, 75%, 55%\)$/);
    expect(colorZ).toMatch(/^hsl\(\d+, 75%, 55%\)$/);
    expect(colorD).not.toBe(colorZ);
    expect(getHslColorForBar('D:\\')).toBe(colorD);
  });

  it('converts between physical PoolPart paths and virtual M:\\ paths accurately', () => {
    const phys =
      'U:\\PoolPart.6610f243-02f1-4552-ae81-c9fdae7722fe\\Media\\Movies\\Film (2024)\\Film.mkv';
    expect(extractRelativePoolPath(phys, 'M:\\')).toBe(
      'Media\\Movies\\Film (2024)\\Film.mkv',
    );
    expect(physicalToVirtualPath(phys, 'M:\\')).toBe(
      'M:\\Media\\Movies\\Film (2024)\\Film.mkv',
    );
    expect(formatDisplayPoolPath(phys)).toBe(
      'U:\\...\\Media\\Movies\\Film (2024)\\Film.mkv',
    );
    expect(
      formatDisplayPoolPath(
        'V:\\PoolPart.cd8bed16-b13c-4f35-967a-1abb245bc3eb\\Downloads\\Release\\Movie.mkv',
      ),
    ).toBe('V:\\...\\Downloads\\Release\\Movie.mkv');
    expect(extractPhysicalDriveLetter(phys)).toBe('U');

    const map = {
      D: 'D:\\PoolPart.bff64b92-d745-4ff9-933b-ae092c32cfc7',
      U: 'U:\\PoolPart.6610f243-02f1-4552-ae81-c9fdae7722fe',
    };
    const resolvedPhys = virtualToPhysicalPath(
      'M:\\Media\\Movies\\Film (2024)\\Film.mkv',
      map,
      'M:\\',
      (candidate) => candidate.startsWith('U:\\'),
    );
    expect(resolvedPhys).toBe(phys);
  });

  it('creates default config and discovers PoolPart directories using mock fs', () => {
    const cfg = createDefaultConfig('C:\\temp');
    expect(cfg.virtualPoolRoot).toBe('M:\\');
    expect(cfg.symlinkTargetMode).toBe('virtual');
    expect(cfg.hashStrategy).toBe('smart_candidates');

    const discovered = discoverDrivePoolPaths(['D', 'E', 'X'], {
      existsSync: (p) => String(p) === 'D:\\' || String(p) === 'E:\\',
      readdirSync: ((p: string) => {
        if (p === 'D:\\') {
          return [
            {
              name: 'PoolPart.bff64b92-d745-4ff9-933b-ae092c32cfc7',
              isDirectory: () => true,
            },
          ];
        }
        return [{ name: 'NormalFolder', isDirectory: () => true }];
      }) as unknown as typeof import('node:fs').readdirSync,
    });

    expect(discovered).toEqual({
      D: 'D:\\PoolPart.bff64b92-d745-4ff9-933b-ae092c32cfc7',
    });
  });
});
