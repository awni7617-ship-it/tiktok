import { NextResponse } from 'next/server';
import { PLATFORM_IDS, getPlatform, isPlatformConfigured } from '@/server/social/platforms';
import { OAuthError, beginAuthorization } from '@/server/social/oauth';
import { getSession } from '@/server/auth/session';
import { can } from '@/server/auth/rbac';
import { RATE_LIMITS, clientIp, rateLimit } from '@/server/security/rateLimit';
import type { PlatformId } from '@/lib/types';
import { logger } from '@/server/obs/logger';

const log = logger.child({ route: 'social/authorize' });

/**
 * Start an account connection.
 *
 * Three gates before a redirect is issued: the caller must be signed in, must
 * hold `social:connect` in the target workspace, and the platform must be
 * configured on this deployment. Connecting an account is a grant of posting
 * rights, so none of these is optional.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ platform: string }> },
): Promise<Response> {
  const { platform } = await params;

  if (!PLATFORM_IDS.includes(platform as PlatformId)) {
    return NextResponse.json({ error: 'Unknown platform' }, { status: 404 });
  }

  const limit = await rateLimit(`oauth:${clientIp(request.headers)}`, RATE_LIMITS.oauth);
  if (!limit.allowed) {
    return NextResponse.json({ error: 'Too many attempts' }, { status: 429 });
  }

  const session = await getSession();
  if (!session) {
    return NextResponse.redirect(new URL('/login', request.url));
  }

  const url = new URL(request.url);
  const workspaceId = url.searchParams.get('workspaceId') ?? session.memberships[0]?.workspaceId;

  if (!workspaceId || !can(session, workspaceId, 'social:connect')) {
    return NextResponse.json(
      { error: 'You do not have permission to connect accounts in this workspace' },
      { status: 403 },
    );
  }

  if (!isPlatformConfigured(platform as PlatformId)) {
    const definition = getPlatform(platform)!;
    return NextResponse.json(
      {
        error: `${definition.name} is not configured on this deployment.`,
        hint: `Set ${definition.oauth.clientIdEnv} and ${definition.oauth.clientSecretEnv}.`,
      },
      { status: 501 },
    );
  }

  try {
    const { url: authorizeUrl } = await beginAuthorization({
      platformId: platform as PlatformId,
      workspaceId,
      userId: session.user.id,
      returnTo: url.searchParams.get('returnTo') ?? '/settings',
    });

    return NextResponse.redirect(authorizeUrl);
  } catch (error) {
    log.error('could not start authorization', { platform, error });
    return NextResponse.json(
      { error: error instanceof OAuthError ? error.message : 'Could not start authorization' },
      { status: 500 },
    );
  }
}
