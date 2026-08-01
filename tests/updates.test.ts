import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  assetNameFor,
  checkForUpdate,
  compareVersions,
  downloadUpdate,
  isNewer,
  parseChecksums,
  parseVersionInfo,
} from '../desktop/updates.js';

/**
 * The update check is the one piece of the desktop app that decides, on its
 * own, to interrupt someone. Getting it wrong is either a missed update or a
 * dialog that will not go away, so the comparison and the failure handling
 * are tested directly.
 */

describe('version comparison', () => {
  it('orders builds by their numeric parts', () => {
    expect(compareVersions('0.1.2', '0.1.10')).toBeLessThan(0);
    expect(compareVersions('0.2.0', '0.1.99')).toBeGreaterThan(0);
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0);
  });

  it('treats a missing segment as zero rather than as newer', () => {
    expect(compareVersions('0.1', '0.1.0')).toBe(0);
    expect(compareVersions('0.1', '0.1.1')).toBeLessThan(0);
  });

  it('ignores pre-release suffixes', () => {
    expect(isNewer('0.1.5', '0.1.5-beta.2')).toBe(false);
    expect(isNewer('0.1.5-beta.2', '0.1.6')).toBe(true);
  });

  it('never reports an older or equal build as an update', () => {
    expect(isNewer('0.1.9', '0.1.8')).toBe(false);
    expect(isNewer('0.1.9', '0.1.9')).toBe(false);
    expect(isNewer('0.1.9', '0.1.10')).toBe(true);
  });
});

describe('version file parsing', () => {
  it('reads a published descriptor', () => {
    const info = parseVersionInfo('{"version":"0.1.42","publishedAt":"2026-01-01T00:00:00Z"}');
    expect(info?.version).toBe('0.1.42');
    expect(info?.publishedAt).toBe('2026-01-01T00:00:00Z');
  });

  it('rejects anything malformed instead of inventing a version', () => {
    expect(parseVersionInfo('not json')).toBeNull();
    expect(parseVersionInfo('{"version":42}')).toBeNull();
    expect(parseVersionInfo('{}')).toBeNull();
  });
});

describe('checkForUpdate', () => {
  const respond = (body: string, ok = true) =>
    (async () =>
      ({ ok, status: ok ? 200 : 404, text: async () => body }) as unknown as Response) as typeof fetch;

  it('reports an update when the published build is newer', async () => {
    const result = await checkForUpdate({
      currentVersion: '0.1.3',
      fetchImpl: respond('{"version":"0.1.7"}'),
    });

    expect(result.status).toBe('update');
    if (result.status === 'update') {
      expect(result.latest.version).toBe('0.1.7');
      expect(result.releasesUrl).toContain('/releases/latest');
    }
  });

  it('stays quiet when the installed build is current', async () => {
    const result = await checkForUpdate({
      currentVersion: '0.1.7',
      fetchImpl: respond('{"version":"0.1.7"}'),
    });
    expect(result.status).toBe('current');
  });

  it('does not prompt when the check fails', async () => {
    const offline = (async () => {
      throw new Error('getaddrinfo ENOTFOUND github.com');
    }) as unknown as typeof fetch;

    const result = await checkForUpdate({ currentVersion: '0.1.1', fetchImpl: offline });
    expect(result.status).toBe('unknown');
    if (result.status === 'unknown') expect(result.reason).toContain('ENOTFOUND');
  });

  it('treats a missing version file as unknown, not as an update', async () => {
    const result = await checkForUpdate({
      currentVersion: '0.1.1',
      fetchImpl: respond('Not Found', false),
    });
    expect(result.status).toBe('unknown');
  });
});

describe('installer selection', () => {
  it('picks the right file for each platform', () => {
    expect(assetNameFor({ platform: 'win32', arch: 'x64', version: '0.1.12' })).toBe(
      'Phantom-Setup-0.1.12.exe',
    );
    expect(assetNameFor({ platform: 'darwin', arch: 'arm64', version: '0.1.12' })).toBe(
      'Phantom-0.1.12-arm64.dmg',
    );
    expect(assetNameFor({ platform: 'darwin', arch: 'x64', version: '0.1.12' })).toBe(
      'Phantom-0.1.12.dmg',
    );
    expect(assetNameFor({ platform: 'linux', arch: 'x64', version: '0.1.12' })).toBe(
      'Phantom-0.1.12.AppImage',
    );
  });

  it('parses sha256sum output', () => {
    const table = parseChecksums(
      `${'a'.repeat(64)}  Phantom-0.1.12.AppImage\n${'b'.repeat(64)}  SHA256SUMS.txt\n`,
    );
    expect(table.get('Phantom-0.1.12.AppImage')).toBe('a'.repeat(64));
    expect(table.size).toBe(2);
  });
});

describe('downloadUpdate', () => {
  const payload = Buffer.from('pretend installer bytes');
  const digest = createHash('sha256').update(payload).digest('hex');

  const server = (body: Buffer, hash: string): typeof fetch =>
    (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('SHA256SUMS.txt')) {
        return new Response(`${hash}  Phantom-0.1.12.AppImage\n`);
      }
      return new Response(new Uint8Array(body), {
        headers: { 'content-length': String(body.length) },
      });
    }) as unknown as typeof fetch;

  it('writes the installer and reports progress', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'phantom-update-'));
    const progress: number[] = [];

    const result = await downloadUpdate({
      version: '0.1.12',
      targetDir: dir,
      platform: 'linux',
      arch: 'x64',
      fetchImpl: server(payload, digest),
      onProgress: (fraction) => progress.push(fraction),
    });

    expect(result.asset).toBe('Phantom-0.1.12.AppImage');
    expect(await readFile(result.path)).toEqual(payload);
    expect(progress.at(-1)).toBe(1);

    // Downloaded AppImages are not executable, which makes a double-click
    // silently do nothing.
    const mode = (await stat(result.path)).mode & 0o777;
    expect(mode & 0o111).toBeGreaterThan(0);

    await rm(dir, { recursive: true, force: true });
  });

  it('deletes a file whose checksum does not match, and refuses to return it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'phantom-update-'));
    const tampered = Buffer.from('malicious installer bytes');

    await expect(
      downloadUpdate({
        version: '0.1.12',
        targetDir: dir,
        platform: 'linux',
        arch: 'x64',
        // Serves the tampered payload while advertising the good hash.
        fetchImpl: server(tampered, digest),
      }),
    ).rejects.toThrow(/checksum/i);

    await expect(stat(join(dir, 'Phantom-0.1.12.AppImage'))).rejects.toThrow();
    await rm(dir, { recursive: true, force: true });
  });

  it('refuses to download an asset with no published checksum', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'phantom-update-'));

    await expect(
      downloadUpdate({
        version: '0.1.12',
        targetDir: dir,
        platform: 'win32',
        arch: 'x64',
        fetchImpl: server(payload, digest),
      }),
    ).rejects.toThrow(/no published checksum/i);

    await rm(dir, { recursive: true, force: true });
  });
});
