import { cookies } from 'next/headers';
import { prisma } from '@/server/db/client';
import { newId } from '@/lib/id';
import { generateToken, hashToken } from '@/server/security/crypto';
import { config } from '@/server/config';
import type { Role } from '@prisma/client';

/**
 * Session management.
 *
 * Sessions are opaque random tokens stored hashed in Postgres, not stateless
 * JWTs. The trade-off is deliberate: this platform can post to a creator's
 * real social accounts, so being able to revoke a session immediately — on
 * logout, on password change, on a suspicious login — matters more than
 * avoiding a database read per request.
 */

export const SESSION_COOKIE = 'phantom_session';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export interface AuthenticatedUser {
  id: string;
  email: string;
  name: string;
  avatarUrl: string | null;
}

export interface SessionContext {
  user: AuthenticatedUser;
  sessionId: string;
  memberships: { workspaceId: string; workspaceName: string; workspaceSlug: string; role: Role }[];
}

export async function createSession(
  userId: string,
  context: { userAgent?: string; ipAddress?: string } = {},
): Promise<{ token: string; expiresAt: Date }> {
  const token = generateToken(32);
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);

  await prisma.session.create({
    data: {
      id: newId('ses'),
      userId,
      tokenHash: hashToken(token),
      userAgent: context.userAgent?.slice(0, 500) ?? null,
      ipAddress: context.ipAddress ?? null,
      expiresAt,
    },
  });

  return { token, expiresAt };
}

/** Resolve the current request's session, or null when unauthenticated. */
export async function getSession(): Promise<SessionContext | null> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (!token) return null;

  return resolveSessionToken(token);
}

/** Token → session lookup, shared by the cookie path and API-key auth. */
export async function resolveSessionToken(token: string): Promise<SessionContext | null> {
  const record = await prisma.session.findUnique({
    where: { tokenHash: hashToken(token) },
    include: {
      user: {
        include: {
          memberships: { include: { workspace: true } },
        },
      },
    },
  });

  if (!record || record.revokedAt || record.expiresAt < new Date()) return null;

  return {
    sessionId: record.id,
    user: {
      id: record.user.id,
      email: record.user.email,
      name: record.user.name,
      avatarUrl: record.user.avatarUrl,
    },
    memberships: record.user.memberships.map((membership) => ({
      workspaceId: membership.workspaceId,
      workspaceName: membership.workspace.name,
      workspaceSlug: membership.workspace.slug,
      role: membership.role,
    })),
  };
}

export async function revokeSession(sessionId: string): Promise<void> {
  await prisma.session.update({
    where: { id: sessionId },
    data: { revokedAt: new Date() },
  });
}

/** Revoke every session for a user — used on password change and on demand. */
export async function revokeAllSessions(userId: string): Promise<number> {
  const result = await prisma.session.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  return result.count;
}

export async function setSessionCookie(token: string, expiresAt: Date): Promise<void> {
  const store = await cookies();
  store.set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: config.NODE_ENV === 'production',
    // `lax` still sends the cookie on top-level navigations, which OAuth
    // callbacks rely on, while blocking cross-site subrequests.
    sameSite: 'lax',
    path: '/',
    expires: expiresAt,
  });
}

export async function clearSessionCookie(): Promise<void> {
  const store = await cookies();
  store.delete(SESSION_COOKIE);
}

/** Remove expired and revoked sessions. Run periodically by the worker. */
export async function pruneSessions(): Promise<number> {
  const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const result = await prisma.session.deleteMany({
    where: {
      OR: [{ expiresAt: { lt: new Date() } }, { revokedAt: { lt: cutoff } }],
    },
  });
  return result.count;
}
