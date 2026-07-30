import { PrismaClient } from '@prisma/client';
import { config } from '@/server/config';

/**
 * Prisma client singleton.
 *
 * Next.js hot-reloads modules in development, which would otherwise open a new
 * connection pool on every edit until Postgres refuses connections. Caching on
 * `globalThis` survives module reloads.
 */

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma: PrismaClient =
  globalForPrisma.prisma ??
  new PrismaClient({
    log:
      config.NODE_ENV === 'development'
        ? [{ level: 'warn', emit: 'stdout' }, { level: 'error', emit: 'stdout' }]
        : [{ level: 'error', emit: 'stdout' }],
  });

if (config.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma;
}

/** Liveness probe used by the health endpoint and the worker's startup check. */
export async function checkDatabase(): Promise<boolean> {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return true;
  } catch {
    return false;
  }
}

/**
 * JSON columns come back as Prisma's `JsonValue`. Casting is unavoidable at the
 * boundary; centralising it here keeps the assertion in one reviewed place
 * instead of scattered through every repository.
 */
export function fromJson<T>(value: unknown): T | null {
  return (value ?? null) as T | null;
}

export function toJson<T>(value: T): object {
  return value as unknown as object;
}
