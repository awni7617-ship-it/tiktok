import { describe, expect, it } from 'vitest';
import { checkForUpdate, compareVersions, isNewer, parseVersionInfo } from '../desktop/updates.js';

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
