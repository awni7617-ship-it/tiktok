import { NextResponse } from 'next/server';
import { z } from 'zod';
import type { EditPlan } from '@/lib/types';
import { applyDecisions } from '@/server/edit/cutplan';
import { demoEditPlan } from '@/server/demo/data';
import { summarizePlan } from '@/server/edit/plan';
import { logger } from '@/server/obs/logger';

const log = logger.child({ route: 'projects/plan' });

const decisionsSchema = z.object({
  decisions: z.record(z.string(), z.boolean()),
});

/** Return the current edit plan for a project. */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  const { plan, summary } = await demoEditPlan(id);
  return NextResponse.json({ plan, summary });
}

/**
 * Apply the user's accept/reject decisions and return the recomputed plan.
 *
 * The recomputation runs server-side so the plan the user sees is produced by
 * exactly the same code the renderer will consume — a client-side
 * approximation could disagree with the final export.
 */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;

  let parsed;
  try {
    parsed = decisionsSchema.parse(await request.json());
  } catch {
    return NextResponse.json({ error: 'Invalid decisions payload' }, { status: 400 });
  }

  try {
    const { plan } = await demoEditPlan(id);
    const cutPlan = applyDecisions(plan.cutPlan, parsed.decisions);
    const updated: EditPlan = { ...plan, cutPlan };

    return NextResponse.json({ plan: updated, summary: summarizePlan(updated) });
  } catch (error) {
    log.error('failed to apply decisions', { projectId: id, error });
    return NextResponse.json({ error: 'Could not update the plan' }, { status: 500 });
  }
}
