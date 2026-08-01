import { NextResponse } from 'next/server';
import { z } from 'zod';
import { NICHES, parseGeneratedContent } from '@/server/ai/schemas';
import { renderCapability } from '@/server/video/capability';
import { RATE_LIMITS, clientIp, rateLimit } from '@/server/security/rateLimit';
import { listProductions, startProduction } from '@/server/studio/jobs';
import { logger } from '@/server/obs/logger';

const log = logger.child({ route: 'studio/produce' });

const bodySchema = z.object({
  prompt: z.string().min(4).max(20000),
  niche: z.enum(NICHES).optional(),
  platform: z
    .enum(['tiktok', 'youtube', 'instagram', 'facebook', 'linkedin', 'pinterest', 'x'])
    .optional(),
  targetDurationSec: z.number().int().min(5).max(600).optional(),
  tone: z.string().max(200).optional(),
  voiceId: z.string().max(80).optional(),
  speed: z.number().min(0.5).max(2).optional(),
  captions: z.boolean().optional(),
  kenBurns: z.boolean().optional(),
  // 1080x1920 is the default; the other presets are the same pipeline at a
  // different frame size.
  width: z.number().int().min(240).max(3840).optional(),
  height: z.number().int().min(240).max(3840).optional(),
  /** An already-generated package, so the video matches what was reviewed. */
  content: z.unknown().optional(),
});

/**
 * Produce a finished video from an idea.
 *
 * Returns as soon as the work starts: production takes minutes, and holding a
 * request open for that long fails on every proxy and every laptop lid. The
 * client polls the job.
 */
export async function POST(request: Request): Promise<Response> {
  const limit = await rateLimit(`studio:${clientIp(request.headers)}`, RATE_LIMITS.aiGenerate);
  if (!limit.allowed) {
    return NextResponse.json(
      { error: 'Too many productions started. Try again shortly.' },
      { status: 429, headers: { 'Retry-After': String(limit.retryAfterSec) } },
    );
  }

  // Rendering needs ffmpeg. Saying so here — with the reason — beats a job
  // that starts, spends a minute writing narration, and then dies.
  const capability = await renderCapability();
  if (!capability.available) {
    return NextResponse.json(
      { error: capability.detail ?? 'Video rendering is unavailable in this deployment.' },
      { status: 503 },
    );
  }

  let parsed;
  try {
    parsed = bodySchema.parse(await request.json());
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof z.ZodError
            ? (error.issues[0]?.message ?? 'Invalid request')
            : 'Invalid JSON',
      },
      { status: 400 },
    );
  }

  let content;
  if (parsed.content !== undefined) {
    try {
      content = parseGeneratedContent(parsed.content);
    } catch {
      return NextResponse.json({ error: 'That script package is not valid.' }, { status: 400 });
    }
  }

  try {
    const job = await startProduction({ ...parsed, content });
    log.info('production started', { id: job.id, niche: parsed.niche });
    return NextResponse.json({ id: job.id, status: job.status, progress: job.progress }, { status: 202 });
  } catch (error) {
    log.error('could not start production', {
      error: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json({ error: 'Could not start the production.' }, { status: 500 });
  }
}

/** Recent productions, so a reloaded page does not lose a running render. */
export async function GET(): Promise<Response> {
  return NextResponse.json({
    productions: listProductions().map((job) => ({
      id: job.id,
      status: job.status,
      progress: job.progress,
      title: job.title,
      durationSec: job.durationSec,
      error: job.error,
    })),
  });
}
