import { Role } from '@prisma/client';
import type { SessionContext } from './session';

/**
 * Role-based access control.
 *
 * Permissions are enumerated rather than derived from role comparisons, so a
 * new role slots in by listing what it can do instead of by finding the right
 * place in a hierarchy. Publishing is deliberately restricted: posting to a
 * creator's real accounts is the highest-consequence action in the product.
 */

export const PERMISSIONS = [
  'project:read',
  'project:write',
  'project:delete',
  'render:create',
  'comment:create',
  'comment:resolve',
  'social:connect',
  'social:disconnect',
  'post:draft',
  'post:schedule',
  'post:publish',
  'analytics:read',
  'template:write',
  'brandkit:write',
  'member:invite',
  'member:remove',
  'workspace:settings',
  'workspace:delete',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  OWNER: PERMISSIONS,
  ADMIN: PERMISSIONS.filter((permission) => permission !== 'workspace:delete'),
  EDITOR: [
    'project:read',
    'project:write',
    'project:delete',
    'render:create',
    'comment:create',
    'comment:resolve',
    'post:draft',
    'post:schedule',
    'analytics:read',
    'template:write',
    'brandkit:write',
  ],
  REVIEWER: ['project:read', 'comment:create', 'comment:resolve', 'analytics:read'],
  VIEWER: ['project:read', 'analytics:read'],
};

export function permissionsFor(role: Role): readonly Permission[] {
  return ROLE_PERMISSIONS[role] ?? [];
}

export function roleCan(role: Role, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role]?.includes(permission) ?? false;
}

/** The caller's role in a workspace, or null when they are not a member. */
export function roleInWorkspace(session: SessionContext, workspaceId: string): Role | null {
  return session.memberships.find((m) => m.workspaceId === workspaceId)?.role ?? null;
}

export function can(
  session: SessionContext,
  workspaceId: string,
  permission: Permission,
): boolean {
  const role = roleInWorkspace(session, workspaceId);
  return role !== null && roleCan(role, permission);
}

export class AuthorizationError extends Error {
  readonly status = 403;

  constructor(
    readonly permission: Permission,
    readonly workspaceId: string,
  ) {
    super(`Missing permission "${permission}" in this workspace`);
    this.name = 'AuthorizationError';
  }
}

/** Throwing guard for use at the top of API route handlers. */
export function requirePermission(
  session: SessionContext,
  workspaceId: string,
  permission: Permission,
): Role {
  const role = roleInWorkspace(session, workspaceId);
  if (role === null || !roleCan(role, permission)) {
    throw new AuthorizationError(permission, workspaceId);
  }
  return role;
}

/** Roles ordered most to least privileged, for member-management UI. */
export const ROLE_ORDER: Role[] = [Role.OWNER, Role.ADMIN, Role.EDITOR, Role.REVIEWER, Role.VIEWER];

export const ROLE_DESCRIPTIONS: Record<Role, string> = {
  OWNER: 'Full control, including billing and deleting the workspace.',
  ADMIN: 'Manage members, connected accounts and everything below.',
  EDITOR: 'Create and edit projects, render, schedule posts. Cannot publish.',
  REVIEWER: 'View projects, leave comments and resolve threads.',
  VIEWER: 'Read-only access to projects and analytics.',
};

/**
 * Only owners and admins may publish. Editors can schedule into the queue,
 * which an approver then releases — that separation is what makes an
 * accidental or unreviewed post to a live account hard to do.
 */
export function canPublish(session: SessionContext, workspaceId: string): boolean {
  return can(session, workspaceId, 'post:publish');
}
