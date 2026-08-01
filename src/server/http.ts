import { NextResponse } from 'next/server';
import { z } from 'zod';

/**
 * Route-handler plumbing.
 *
 * Handlers return data or throw; this turns either into a response. The point
 * is that a handler never has to remember to catch, and an unexpected error
 * can never leak a stack trace to the browser.
 */

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export const badRequest = (message: string) => new HttpError(400, message);
export const notFound = (message = 'Not found') => new HttpError(404, message);

export function json<T>(data: T, status = 200): NextResponse {
  return NextResponse.json(data, { status });
}

export async function handle<T>(fn: () => Promise<T>): Promise<NextResponse> {
  try {
    return json(await fn());
  } catch (error) {
    if (error instanceof HttpError) {
      return json({ error: error.message }, error.status);
    }
    if (error instanceof z.ZodError) {
      const issue = error.issues[0];
      const where = issue?.path.join('.');
      return json({ error: where ? `${where}: ${issue?.message}` : 'Invalid request' }, 400);
    }
    console.error('[api]', error);
    return json({ error: 'Something went wrong. Check the server logs.' }, 500);
  }
}

/** Parse a JSON body against a schema, with a readable message when it is not JSON at all. */
export async function body<S extends z.ZodTypeAny>(
  request: Request,
  schema: S,
): Promise<z.infer<S>> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    throw badRequest('Expected a JSON body');
  }
  return schema.parse(raw);
}
