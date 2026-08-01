import { NextResponse } from 'next/server';
import { adapter, oauthApp, redirectUri, saveAccount } from '@/server/publish';
import { PLATFORMS } from '@/lib/catalog';
import type { PlatformId } from '@/lib/types';

const VALID = new Set(PLATFORMS.map((p) => p.id));

/** Where the platform sends the user back to. */
function settingsUrl(request: Request, params: Record<string, string>): URL {
  const url = new URL('/settings', new URL(request.url).origin);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return url;
}

export async function GET(request: Request, { params }: { params: Promise<{ platform: string }> }) {
  const { platform } = await params;
  if (!VALID.has(platform as PlatformId)) {
    return NextResponse.json({ error: 'Unknown platform' }, { status: 404 });
  }

  const id = platform as PlatformId;
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const denied = url.searchParams.get('error');

  // The user pressed Cancel on the platform's consent screen.
  if (denied) {
    return NextResponse.redirect(settingsUrl(request, { connected: 'cancelled' }));
  }

  const expected = request.headers
    .get('cookie')
    ?.split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`oauth_state_${id}=`))
    ?.split('=')[1];

  if (!code || !state || !expected || state !== expected) {
    return NextResponse.redirect(
      settingsUrl(request, { connected: 'failed', reason: 'The authorisation could not be verified' }),
    );
  }

  const app = oauthApp(id);
  if (!app) {
    return NextResponse.redirect(
      settingsUrl(request, { connected: 'failed', reason: 'Credentials are not configured' }),
    );
  }

  try {
    const account = await adapter(id).exchangeCode(app, code, redirectUri(id));
    await saveAccount(account);
    const response = NextResponse.redirect(settingsUrl(request, { connected: id }));
    response.cookies.delete(`oauth_state_${id}`);
    return response;
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.redirect(settingsUrl(request, { connected: 'failed', reason }));
  }
}
