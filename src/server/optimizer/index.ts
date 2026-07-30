import type { OptimizationReport, Suggestion } from '@/lib/types';
import { shortHash } from '@/lib/id';
import { getLlm, withRetry } from '@/server/ai/registry';
import { llmSuggestionsSchema, toJsonSchema } from '@/server/ai/schemas';
import { logger } from '@/server/obs/logger';
import { overallScore, runRules, scoreAreas, type OptimizerInput } from './rules';

const log = logger.child({ module: 'optimizer' });

/**
 * The viral optimization assistant.
 *
 * Deterministic rules run first and always produce a report. The LLM pass is
 * additive and best-effort: it contributes the judgement calls a rule cannot
 * make (is this hook actually interesting?) but its failure never blocks the
 * report, and its suggestions are clearly attributed so the user knows which
 * findings are measured and which are opinion.
 */

const SYSTEM_PROMPT = `You are a short-form video strategist reviewing a creator's draft before they publish. You give specific, actionable notes.

Rules:
- Every suggestion names the exact problem and the exact fix. "Improve the hook" is useless; "the hook buries the claim behind eight words of setup — open on 'nobody tells you this'" is useful.
- Where a rewrite would help, provide the actual replacement text, not a description of it.
- Do not repeat findings the automated analysis already covers; add what measurement cannot see.
- Never promise virality, guarantee views, or predict specific numbers. Talk about what improves the odds.
- If the draft is genuinely strong in an area, say so and move on rather than inventing a problem.
- At most six suggestions. Fewer, better notes beat a long list.`;

export interface OptimizeOptions extends OptimizerInput {
  /** Skip the LLM pass — used in tests and when the user opts out. */
  rulesOnly?: boolean;
}

export async function optimize(options: OptimizeOptions): Promise<OptimizationReport> {
  const ruleSuggestions = runRules(options);
  let suggestions = ruleSuggestions;
  let summary = buildDeterministicSummary(ruleSuggestions);

  if (!options.rulesOnly) {
    try {
      const ai = await generateAiSuggestions(options, ruleSuggestions);
      suggestions = [...ruleSuggestions, ...ai.suggestions];
      if (ai.summary) summary = ai.summary;
    } catch (error) {
      // The report is still useful without the AI layer.
      log.warn('AI optimization pass failed; returning rule-based report only', { error });
    }
  }

  const subScores = scoreAreas(suggestions);

  return {
    score: overallScore(subScores),
    subScores,
    suggestions,
    summary,
    generatedAt: new Date().toISOString(),
  };
}

async function generateAiSuggestions(
  options: OptimizeOptions,
  existing: Suggestion[],
): Promise<{ suggestions: Suggestion[]; summary: string }> {
  const llm = getLlm();

  const result = await withRetry(
    () =>
      llm.completeJson({
        system: SYSTEM_PROMPT,
        cacheSystem: true,
        maxTokens: 4000,
        messages: [{ role: 'user', content: buildReviewPrompt(options, existing) }],
        schema: toJsonSchema(llmSuggestionsSchema),
        parse: (value) => llmSuggestionsSchema.parse(value),
      }),
    { label: 'optimize', attempts: 2 },
  );

  const suggestions: Suggestion[] = result.value.suggestions.map((item) => ({
    id: `sug_ai_${shortHash(`${item.area}:${item.title}`)}`,
    area: item.area,
    title: item.title,
    detail: item.detail,
    impact: item.impact,
    scoreDelta: item.impact === 'high' ? 7 : item.impact === 'medium' ? 4 : 2,
    evidence: ['AI review of the script and edit plan'],
    action: item.replacement ? toAction(item.area, item.replacement) : undefined,
  }));

  return { suggestions, summary: result.value.summary };
}

function toAction(area: Suggestion['area'], replacement: string): Suggestion['action'] {
  switch (area) {
    case 'hook':
      return { kind: 'replace-hook', value: replacement };
    case 'title':
      return { kind: 'replace-title', value: replacement };
    case 'cta':
      return { kind: 'set-cta', value: replacement };
    default:
      return undefined;
  }
}

export function buildReviewPrompt(options: OptimizeOptions, existing: Suggestion[]): string {
  const parts: string[] = ['Review this short-form video draft.', ''];

  if (options.content?.title) parts.push(`Title: ${options.content.title}`);
  if (options.content?.hook) parts.push(`Hook: ${options.content.hook}`);
  if (options.content?.callToAction) parts.push(`CTA: ${options.content.callToAction}`);
  if (options.platform) parts.push(`Platform: ${options.platform}`);

  if (options.plan) {
    parts.push(
      `Duration after edit: ${options.plan.cutPlan.outputDurationSec}s (from ${options.plan.sourceDurationSec}s)`,
      `Cuts applied: ${options.plan.cutPlan.cuts.length}`,
      `Caption cues: ${options.plan.captions.length}`,
    );
  }

  const script = options.content?.script ?? options.transcript?.segments.map((s) => s.text).join(' ');
  if (script) {
    parts.push('', 'Script / transcript:', script.slice(0, 6000));
  }

  if (existing.length > 0) {
    parts.push(
      '',
      'The automated analysis already flagged these — do not repeat them:',
      ...existing.map((item) => `- [${item.area}] ${item.title}`),
    );
  }

  if (options.history && options.history.length > 0) {
    const avgCompletion =
      options.history.reduce((sum, m) => sum + m.completionRate, 0) / options.history.length;
    parts.push(
      '',
      `For context, this creator's recent posts average a ${(avgCompletion * 100).toFixed(
        0,
      )}% completion rate.`,
    );
  }

  return parts.join('\n');
}

function buildDeterministicSummary(suggestions: Suggestion[]): string {
  if (suggestions.length === 0) {
    return 'No issues found. The hook, pacing, captions and metadata all check out against the automated review.';
  }

  const high = suggestions.filter((s) => s.impact === 'high');
  const areas = [...new Set(suggestions.map((s) => s.area))];

  if (high.length > 0) {
    return `${high.length} high-impact issue${high.length === 1 ? '' : 's'} found, concentrated in ${areas
      .slice(0, 3)
      .join(', ')}. Start with "${high[0]!.title}" — it is the one most likely to change how this performs.`;
  }

  return `${suggestions.length} refinement${
    suggestions.length === 1 ? '' : 's'
  } available across ${areas.slice(0, 3).join(', ')}. Nothing here is blocking; these are polish.`;
}

/**
 * Editable end-screen prompts.
 *
 * Offered as starting points only — every one is presented as editable text in
 * the UI, and none is applied without an explicit user action.
 */
export const CTA_LIBRARY = [
  { id: 'part-2', label: 'Come back for Part 2', text: 'Come back tomorrow for part two.' },
  { id: 'follow', label: 'Follow for more', text: 'Follow for more like this.' },
  { id: 'comment-opinion', label: 'Comment your opinion', text: 'Comment your take — I read them all.' },
  { id: 'what-next', label: 'What would you do next?', text: 'What would you have done? Tell me below.' },
  { id: 'save', label: 'Save for later', text: 'Save this so you have it when you need it.' },
  { id: 'share', label: 'Send to a friend', text: 'Send this to someone who needs to hear it.' },
  { id: 'question', label: 'Ask a question', text: 'Ask me anything about this in the comments.' },
  { id: 'series', label: 'Watch the series', text: 'Part one is on my profile.' },
] as const;

export type CtaTemplate = (typeof CTA_LIBRARY)[number];
