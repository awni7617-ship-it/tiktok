import { randomBytes } from 'node:crypto';
import { NextResponse } from 'next/server';
import { adapter, oauthApp, redirectUri, requiredEnvFor } from '@/server/publish';
import { PLATFORMS } from '@/lib/catalog';
import type { PlatformId } from '@/lib/types';

const VALID = new Set(PLATFORMS.map((p) => p.id));

/** Start the OAuth handshake for a platform. */
export async function GET(_request: Request, { params }: { params: Promise<{ platform: string }> }) {
  const { platform } = await params;
  if (!VALID.has(platform as PlatformId)) {
    return NextResponse.json({ error: 'Unknown platform' }, { status: 404 });
  }

  const id = platform as PlatformId;
  const app = oauthApp(id);
  if (!app) {
    const env = requiredEnvFor(id);
    return NextResponse.json(
      { error: `Set ${env.id} and ${env.secret} before connecting ${id}` },
      { status: 400 },
    );
  }

  // Random state, echoed back by the platform and compared on return. Stored
  // in an httpOnly cookie so a page that can read `document.cookie` cannot
  // forge one.
  const state = randomBytes(24).toString('hex');
  const response = NextResponse.redirect(adapter(id).authorizeUrl(app, redirectUri(id), state));

  response.cookies.set(`oauth_state_${id}`, state, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    maxAge: 600,
    secure: process.env.NODE_ENV === 'production',
  });

  return response;
}
