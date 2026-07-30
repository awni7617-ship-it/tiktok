import { NextResponse } from 'next/server';
import { z } from 'zod';
import { generateContent } from '@/server/ai/generate';
import { NICHES } from '@/server/ai/schemas';
import { AiError } from '@/server/ai/types';
import { RATE_LIMITS, clientIp, rateLimit } from '@/server/security/rateLimit';
import { logger } from '@/server/obs/logger';

const log = logger.child({ route: 'ai/generate' });

const bodySchema = z.object({
  prompt: z.string().min(4).max(20000),
  niche: z.enum(NICHES).optional(),
  platform: z
    .enum(['tiktok', 'youtube', 'instagram', 'facebook', 'linkedin', 'pinterest', 'x'])
    .optional(),
  targetDurationSec: z.number().int().min(5).max(600).optional(),
  tone: z.string().max(200).optional(),
  useAsScript: z.boolean().optional(),
  language: z.string().max(20).optional(),
});

/**
 * Generate a content package from a prompt or script.
 *
 * Rate-limited per client because generation is the most expensive endpoint in
 * the product, and validated with a schema so a malformed request fails at the
 * boundary rather than inside a provider call.
 */
export async function POST(request: Request): Promise<Response> {
  const limit = await rateLimit(`ai:${clientIp(request.headers)}`, RATE_LIMITS.aiGenerate);
  if (!limit.allowed) {
    return NextResponse.json(
      { error: 'Too many generation requests. Try again shortly.' },
      { status: 429, headers: { 'Retry-After': String(limit.retryAfterSec) } },
    );
  }

  let parsed;
  try {
    parsed = bodySchema.parse(await request.json());
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof z.ZodError ? error.issues[0]?.message ?? 'Invalid request' : 'Invalid JSON' },
      { status: 400 },
    );
  }

  try {
    const result = await generateContent(parsed);
    return NextResponse.json({
      content: result.content,
      provider: result.provider,
      usage: result.usage,
    });
  } catch (error) {
    log.error('generation failed', { error });

    if (error instanceof AiError) {
      // A refusal or validation failure is the caller's problem to see; an
      // upstream outage is ours, and the status codes should say which.
      return NextResponse.json({ error: error.message }, { status: error.retryable ? 503 : 422 });
    }

    return NextResponse.json({ error: 'Generation failed. Please try again.' }, { status: 500 });
  }
}
