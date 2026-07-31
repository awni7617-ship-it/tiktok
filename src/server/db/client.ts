import { PrismaClient } from '@prisma/client';
import { config } from '@/server/config';
import { hyperdriveUrl, isWorkers } from '@/server/cloudflare/env';

/**
 * Prisma client.
 *
 * Two connection strategies, chosen at runtime:
 *
 *   - **Node / container**: the standard client over `DATABASE_URL`, with its
 *     own pool. Cached on `globalThis` so Next.js hot reloads do not open a new
 *     pool on every edit until Postgres refuses connections.
 *
 *   - **Cloudflare Workers**: a driver adapter over Hyperdrive. A Worker cannot
 *     hold a TCP pool between requests, so Hyperdrive owns the pooling and the
 *     Worker gets a connection string pointing at it. Without this, every
 *     request would pay a fresh Postgres handshake — or fail outright.
 *
 * The Workers path needs an `await` (to read the binding) before a client
 * exists, which is awkward for the dozens of call sites written against a
 * plain `prisma.model.method()`. The exported `prisma` is therefore a lazy
 * proxy: on Node it forwards straight to the real client, and on Workers it
 * resolves the client on first use and forwards to it. Callers are identical
 * in both runtimes.
 */

const globalForPrisma = globalThis as unknown as {
  prisma?: PrismaClient;
  prismaWorkers?: Promise<PrismaClient>;
};

function createNodeClient(): PrismaClient {
  return new PrismaClient({
    log:
      config.NODE_ENV === 'development'
        ? [{ level: 'warn', emit: 'stdout' }, { level: 'error', emit: 'stdout' }]
        : [{ level: 'error', emit: 'stdout' }],
  });
}

async function createWorkersClient(): Promise<PrismaClient> {
  const connectionString = (await hyperdriveUrl()) ?? config.DATABASE_URL;

  const { PrismaPg } = await import('@prisma/adapter-pg');
  const adapter = new PrismaPg({ connectionString });

  return new PrismaClient({ adapter } as ConstructorParameters<typeof PrismaClient>[0]);
}

/**
 * Resolve a client for the current runtime.
 *
 * On Workers the client is cached per isolate rather than per request: the
 * adapter's pool lives in Hyperdrive, so reusing the client across requests in
 * the same isolate is both safe and cheaper than rebuilding it each time.
 */
export async function getPrisma(): Promise<PrismaClient> {
  if (!isWorkers()) {
    globalForPrisma.prisma ??= createNodeClient();
    return globalForPrisma.prisma;
  }

  globalForPrisma.prismaWorkers ??= createWorkersClient();
  return globalForPrisma.prismaWorkers;
}

/**
 * Build a proxy that defers every call until the async client is ready.
 *
 * Two levels: the outer proxy resolves a model (or a `$`-prefixed client
 * method), the inner one resolves the method itself. Every leaf returns a
 * promise, which is what Prisma's API returns anyway — so nothing downstream
 * can tell the difference.
 */
function createLazyProxy(): PrismaClient {
  const cache = new Map<string, unknown>();

  return new Proxy({} as PrismaClient, {
    get(_target, property) {
      if (typeof property !== 'string') return undefined;

      const cached = cache.get(property);
      if (cached) return cached;

      // Client-level methods (`$queryRaw`, `$transaction`, `$disconnect`) are
      // called directly rather than through a model.
      if (property.startsWith('$')) {
        const method = (...args: unknown[]) =>
          getPrisma().then((client) => {
            const fn = (client as unknown as Record<string, ((...a: unknown[]) => unknown) | undefined>)[
              property
            ];
            if (typeof fn !== 'function') {
              throw new Error(`Prisma client has no method "${property}"`);
            }
            return fn.apply(client, args);
          });
        cache.set(property, method);
        return method;
      }

      const model = new Proxy(
        {},
        {
          get(_modelTarget, methodName) {
            if (typeof methodName !== 'string') return undefined;

            return (...args: unknown[]) =>
              getPrisma().then((client) => {
                const delegate = (client as unknown as Record<string, Record<string, (...a: unknown[]) => unknown>>)[
                  property
                ];
                const fn = delegate?.[methodName];
                if (typeof fn !== 'function') {
                  throw new Error(`Prisma has no "${property}.${methodName}"`);
                }
                return fn.apply(delegate, args);
              });
          },
        },
      );

      cache.set(property, model);
      return model as unknown;
    },
  });
}

/**
 * The client every repository uses.
 *
 * On Node this is the real client (kept synchronous so tests and scripts that
 * inspect it behave exactly as before). On Workers it is the lazy proxy.
 */
export const prisma: PrismaClient = isWorkers()
  ? createLazyProxy()
  : (globalForPrisma.prisma ??= createNodeClient());

if (config.NODE_ENV !== 'production' && !isWorkers()) {
  globalForPrisma.prisma = prisma;
}

/** Liveness probe used by the health endpoint and the worker's startup check. */
export async function checkDatabase(): Promise<boolean> {
  try {
    const client = await getPrisma();
    await client.$queryRaw`SELECT 1`;
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
