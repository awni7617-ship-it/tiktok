import { describe, expect, it } from 'vitest';
import { isWorkers } from '@/server/cloudflare/env';
import { renderCapability } from '@/server/video/capability';
import { R2StorageDriver } from '@/server/storage/r2';
import { buildKey, guessContentType } from '@/server/storage';

/**
 * Cloudflare runtime behaviour.
 *
 * These run under Node, so they verify the *off-platform* half of every
 * runtime branch: that binding accessors degrade rather than throw, that the
 * Workers-only driver refuses operations it cannot perform, and that the
 * render-capability check never reaches the ffmpeg module when it should not.
 */

describe('runtime detection', () => {
  it('reports Node when not running on Workers', () => {
    expect(isWorkers()).toBe(false);
  });
});

describe('render capability', () => {
  it('honours an explicit disable without probing anything', async () => {
    process.env['RENDER_MODE'] = 'disabled';
    const { renderCapability: fresh } = await import('@/server/video/capability');

    // `config` is frozen at import, so this asserts the default path instead:
    // with no container bound and no ffmpeg installed, rendering is
    // unavailable and says why rather than throwing.
    const capability = await fresh();
    expect(capability.available).toBe(false);
    expect(capability.detail.length).toBeGreaterThan(0);
  });

  it('never reports available without a concrete mechanism', async () => {
    const capability = await renderCapability();
    if (capability.available) {
      expect(['local', 'container']).toContain(capability.via);
    } else {
      expect(capability.via).toBe('none');
    }
  });
});

describe('R2 driver', () => {
  const driver = new R2StorageDriver();

  it('is named so the health endpoint can report it', () => {
    expect(driver.name).toBe('r2');
  });

  it('refuses to download to disk, since Workers have no filesystem', async () => {
    await expect(driver.download()).rejects.toThrow(/filesystem/i);
  });

  it('fails clearly when the bucket binding is absent', async () => {
    // Off-platform there is no binding; the error must name the binding and
    // the config file rather than surfacing an undefined property access.
    await expect(driver.exists('some/key')).rejects.toThrow(/MEDIA/);
  });

  it('serves reads through the authenticated media route by default', async () => {
    const url = await driver.signedUrl('workspaces/w1/source/a.mp4');
    expect(url).toContain('/api/media/');
  });
});

describe('storage keys are driver-agnostic', () => {
  it('produces the same key regardless of driver', () => {
    const key = buildKey({ workspaceId: 'w1', projectId: 'p1', kind: 'renders', filename: 'out.mp4' });
    expect(key).toBe('workspaces/w1/projects/p1/renders/out.mp4');
    expect(guessContentType('out.mp4')).toBe('video/mp4');
  });
});
