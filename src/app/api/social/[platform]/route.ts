import { removeAccount } from '@/server/publish';
import { PLATFORMS } from '@/lib/catalog';
import { handle, notFound } from '@/server/http';
import type { PlatformId } from '@/lib/types';

const VALID = new Set(PLATFORMS.map((p) => p.id));

/** Disconnect an account. Local only — the platform still lists the app. */
export async function DELETE(_request: Request, { params }: { params: Promise<{ platform: string }> }) {
  return handle(async () => {
    const { platform } = await params;
    if (!VALID.has(platform as PlatformId)) throw notFound('Unknown platform');
    await removeAccount(platform as PlatformId);
    return { ok: true };
  });
}
