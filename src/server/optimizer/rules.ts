import type {
  EditPlan,
  GeneratedContent,
  OptimizationArea,
  PlatformId,
  PostMetrics,
  Suggestion,
  Transcript,
} from '@/lib/types';
import { clamp, round } from '@/lib/time';
import { wordCount } from '@/lib/text';
import { shortHash } from '@/lib/id';
import { analyzePacing } from '@/server/edit/pacing';

/**
 * Deterministic optimization rules.
 *
 * These run before (and independently of) any LLM call. They are cheap,
 * explainable, and grounded in the actual measurements from the edit plan
 * rather than in a model's opinion — every suggestion carries the evidence
 * that triggered it, which is what lets a user judge whether to accept it.
 */

export interface OptimizerInput {
  plan?: EditPlan;
  transcript?: Transcript;
  content?: Partial<GeneratedContent>;
  platform?: PlatformId;
  /** Historical performance, when the project has published before. */
  history?: PostMetrics[];
}

export interface Rule {
  id: string;
  area: OptimizationArea;
  /** Returns a suggestion when the rule fires, or null when it does not. */
  evaluate(input: OptimizerInput): Suggestion | null;
}

function suggestion(
  partial: Omit<Suggestion, 'id'> & { id?: string },
): Suggestion {
  return {
    ...partial,
    id: partial.id ?? `sug_${shortHash(`${partial.area}:${partial.title}`)}`,
  };
}

/** Platform-specific sweet spots for total length, in seconds. */
const LENGTH_TARGETS: Record<PlatformId, { min: number; ideal: number; max: number }> = {
  tiktok: { min: 8, ideal: 27, max: 90 },
  youtube: { min: 15, ideal: 35, max: 60 },
  instagram: { min: 8, ideal: 25, max: 90 },
  facebook: { min: 10, ideal: 35, max: 90 },
  linkedin: { min: 20, ideal: 60, max: 180 },
  pinterest: { min: 15, ideal: 30, max: 60 },
  x: { min: 8, ideal: 40, max: 140 },
};

export const RULES: Rule[] = [
  // --- Hook -------------------------------------------------------------
  {
    id: 'hook-length',
    area: 'hook',
    evaluate({ content }) {
      const hook = content?.hook;
      if (!hook) return null;

      const words = wordCount(hook);
      if (words <= 14) return null;

      return suggestion({
        area: 'hook',
        title: 'Shorten the hook',
        detail: `The hook is ${words} words — roughly ${(words / 2.5).toFixed(
          1,
        )}s spoken. Viewers decide in about two seconds, so the promise needs to land inside the first sentence.`,
        impact: 'high',
        scoreDelta: 8,
        evidence: [`Hook length: ${words} words`],
      });
    },
  },
  {
    id: 'hook-slow-start',
    area: 'hook',
    evaluate({ plan, transcript }) {
      if (!transcript) return null;

      const firstWord = transcript.words[0];
      const leadIn = firstWord?.start ?? 0;
      if (leadIn < 0.6) return null;

      return suggestion({
        area: 'hook',
        title: 'Cut the dead air before you speak',
        detail: `There is ${leadIn.toFixed(
          1,
        )}s of silence before the first word. On a vertical feed that reads as a mistake and costs you the swipe.`,
        impact: 'high',
        scoreDelta: 6,
        range: { start: 0, end: leadIn },
        action: { kind: 'add-cut', value: { start: 0, end: Math.max(0, leadIn - 0.1) } },
        evidence: [
          `First spoken word at ${leadIn.toFixed(2)}s`,
          plan ? `Plan currently removes ${plan.cutPlan.removedSec}s total` : '',
        ].filter(Boolean),
      });
    },
  },
  {
    id: 'hook-weak-opener',
    area: 'hook',
    evaluate({ content }) {
      const hook = content?.hook;
      if (!hook) return null;

      const weak = /^(hi|hey|hello|welcome|what'?s up|in this video|today (i|we))/i;
      if (!weak.test(hook.trim())) return null;

      return suggestion({
        area: 'hook',
        title: 'Replace the greeting opener',
        detail:
          'Opening with a greeting or "in this video" spends your only guaranteed two seconds on nothing. Lead with the claim, the question or the payoff instead.',
        impact: 'high',
        scoreDelta: 10,
        evidence: [`Hook starts with: "${hook.slice(0, 40)}…"`],
      });
    },
  },

  // --- Pacing & retention ------------------------------------------------
  {
    id: 'pacing-slow-sections',
    area: 'pacing',
    evaluate({ transcript }) {
      if (!transcript) return null;

      const pacing = analyzePacing(transcript);
      if (pacing.slowSections.length === 0) return null;

      const worst = pacing.slowSections.reduce((a, b) => (a.wpm < b.wpm ? a : b));
      return suggestion({
        area: 'pacing',
        title: `Tighten the slow stretch at ${Math.round(worst.start)}s`,
        detail: `Delivery drops to ${Math.round(worst.wpm)} words per minute between ${Math.round(
          worst.start,
        )}s and ${Math.round(worst.end)}s, against an average of ${Math.round(
          pacing.averageWpm,
        )}. Trim the pauses or speed this section slightly.`,
        impact: pacing.slowSections.length > 2 ? 'high' : 'medium',
        scoreDelta: 6,
        range: { start: worst.start, end: worst.end },
        action: { kind: 'set-speed', value: 1.1 },
        evidence: [
          `${pacing.slowSections.length} section(s) below 72% of target pace`,
          `Average ${pacing.averageWpm} wpm, variability ${pacing.variability}`,
        ],
      });
    },
  },
  {
    id: 'retention-long-silences',
    area: 'retention',
    evaluate({ plan }) {
      if (!plan) return null;

      const longPauses = plan.cutPlan.cuts.filter(
        (cut) => cut.reason === 'long-pause' && cut.accepted === false,
      );
      if (longPauses.length === 0) return null;

      const totalSec = longPauses.reduce((sum, cut) => sum + (cut.end - cut.start), 0);
      return suggestion({
        area: 'retention',
        title: 'Reconsider the pauses you kept',
        detail: `You rejected ${longPauses.length} pause cut${
          longPauses.length === 1 ? '' : 's'
        } totalling ${totalSec.toFixed(1)}s. Long silences are the most common drop-off point in short-form.`,
        impact: 'medium',
        scoreDelta: 5,
        evidence: longPauses
          .slice(0, 3)
          .map((cut) => `${cut.start.toFixed(1)}s–${cut.end.toFixed(1)}s (${cut.note ?? 'pause'})`),
      });
    },
  },
  {
    id: 'length-off-target',
    area: 'length',
    evaluate({ plan, platform }) {
      if (!plan) return null;

      const target = LENGTH_TARGETS[platform ?? 'tiktok'];
      const duration = plan.cutPlan.outputDurationSec;

      if (duration >= target.min && duration <= target.max) {
        // Inside the allowed window, but is it near the sweet spot?
        if (Math.abs(duration - target.ideal) < target.ideal * 0.6) return null;
      }

      const tooLong = duration > target.ideal;
      return suggestion({
        area: 'length',
        title: tooLong ? 'Consider a tighter cut' : 'This may be too short to land',
        detail: tooLong
          ? `The edit runs ${Math.round(duration)}s. Completion rate is the strongest ranking signal you control, and it falls sharply past ${Math.round(
              target.ideal,
            )}s on ${platform ?? 'tiktok'}. A tighter cut of the same material usually outperforms.`
          : `The edit runs ${Math.round(duration)}s. Below about ${Math.round(
              target.min,
            )}s there is rarely enough setup for the payoff to register.`,
        impact: duration > target.max || duration < target.min ? 'high' : 'medium',
        scoreDelta: 5,
        action: tooLong ? { kind: 'trim-to', value: target.ideal } : undefined,
        evidence: [
          `Output duration: ${Math.round(duration)}s`,
          `Target for ${platform ?? 'tiktok'}: ${target.min}–${target.max}s, ideal ~${target.ideal}s`,
        ],
      });
    },
  },

  // --- Captions & accessibility -----------------------------------------
  {
    id: 'captions-missing',
    area: 'captions',
    evaluate({ plan }) {
      if (!plan || plan.captions.length > 0) return null;

      return suggestion({
        area: 'captions',
        title: 'Add captions',
        detail:
          'This edit has no captions. A large share of feed viewing happens with sound off, and burned-in captions are the single highest-leverage addition for watch time.',
        impact: 'high',
        scoreDelta: 12,
        evidence: ['0 caption cues in the current plan'],
      });
    },
  },
  {
    id: 'captions-too-dense',
    area: 'captions',
    evaluate({ plan }) {
      if (!plan || plan.captions.length === 0) return null;

      const dense = plan.captions.filter((cue) => cue.text.length > 52);
      if (dense.length < Math.max(2, plan.captions.length * 0.15)) return null;

      return suggestion({
        area: 'captions',
        title: 'Break up the longest captions',
        detail: `${dense.length} cue${
          dense.length === 1 ? '' : 's'
        } exceed 52 characters. At full-screen size that pushes to three lines and covers the subject.`,
        impact: 'medium',
        scoreDelta: 4,
        action: { kind: 'set-caption-style', value: { maxCharsPerLine: 20, maxLines: 2 } },
        evidence: [`Longest cue: ${Math.max(...plan.captions.map((c) => c.text.length))} characters`],
      });
    },
  },
  {
    id: 'accessibility-contrast',
    area: 'accessibility',
    evaluate({ plan }) {
      if (!plan || plan.captions.length === 0) return null;
      if (plan.captionStyle.outlineWidth >= 3) return null;

      return suggestion({
        area: 'accessibility',
        title: 'Strengthen the caption outline',
        detail:
          'A thin outline makes captions unreadable over bright or busy footage. An outline of 3–4px keeps them legible on every background.',
        impact: 'medium',
        scoreDelta: 3,
        action: { kind: 'set-caption-style', value: { outlineWidth: 4, shadow: 2 } },
        evidence: [`Current outline width: ${plan.captionStyle.outlineWidth}px`],
      });
    },
  },

  // --- Audio & visual ----------------------------------------------------
  {
    id: 'audio-quiet',
    area: 'audio',
    evaluate({ plan }) {
      if (!plan) return null;

      const gap = plan.audio.targetLufs - (plan.audio.targetLufs ?? -14);
      if (Math.abs(gap) < 3 && plan.audio.denoise === false) return null;
      if (!plan.audio.denoise) return null;

      return suggestion({
        area: 'audio',
        title: 'Noisy source detected',
        detail: plan.audio.notes.join(' '),
        impact: 'medium',
        scoreDelta: 4,
        evidence: plan.audio.notes,
      });
    },
  },
  {
    id: 'visual-static',
    area: 'visual',
    evaluate({ plan }) {
      if (!plan || plan.motion.length > 0) return null;
      if (plan.cutPlan.outputDurationSec < 12) return null;

      return suggestion({
        area: 'visual',
        title: 'Add subtle movement',
        detail: `${Math.round(
          plan.cutPlan.outputDurationSec,
        )}s of static framing with no motion cues. A slow push on the key moments keeps the frame alive without being distracting.`,
        impact: 'low',
        scoreDelta: 3,
        evidence: ['0 motion cues planned'],
      });
    },
  },

  // --- Metadata ----------------------------------------------------------
  {
    id: 'title-length',
    area: 'title',
    evaluate({ content }) {
      const title = content?.title;
      if (!title) return null;
      if (title.length <= 70) return null;

      return suggestion({
        area: 'title',
        title: 'Shorten the title',
        detail: `At ${title.length} characters the title truncates in most feed layouts. Front-load the hook so the visible portion still works.`,
        impact: 'medium',
        scoreDelta: 4,
        evidence: [`Title length: ${title.length} characters`],
      });
    },
  },
  {
    id: 'hashtags-count',
    area: 'hashtags',
    evaluate({ content }) {
      const hashtags = content?.hashtags;
      if (!hashtags) return null;
      if (hashtags.length >= 3 && hashtags.length <= 8) return null;

      const tooFew = hashtags.length < 3;
      return suggestion({
        area: 'hashtags',
        title: tooFew ? 'Add a few more hashtags' : 'Trim the hashtag list',
        detail: tooFew
          ? `Only ${hashtags.length} hashtag${
              hashtags.length === 1 ? '' : 's'
            }. Three to eight — one broad, the rest specific — gives the ranker enough signal without looking spammy.`
          : `${hashtags.length} hashtags reads as spam and dilutes the topical signal. Keep the three to eight most relevant.`,
        impact: 'low',
        scoreDelta: 2,
        action: tooFew ? undefined : { kind: 'set-hashtags', value: hashtags.slice(0, 8) },
        evidence: [`${hashtags.length} hashtags`],
      });
    },
  },
  {
    id: 'cta-missing',
    area: 'cta',
    evaluate({ content }) {
      if (content?.callToAction && content.callToAction.trim().length > 0) return null;

      return suggestion({
        area: 'cta',
        title: 'Add a call to action',
        detail:
          'The video ends without asking for anything. One specific line — a follow, a comment prompt, or a part-two tease — measurably lifts engagement.',
        impact: 'medium',
        scoreDelta: 6,
        action: { kind: 'set-cta', value: 'Follow for part two.' },
        evidence: ['No call to action set'],
      });
    },
  },
  {
    id: 'thumbnail-missing',
    area: 'thumbnail',
    evaluate({ content, platform }) {
      // Only platforms with a real thumbnail surface benefit from this.
      if (platform && !['youtube', 'pinterest', 'facebook'].includes(platform)) return null;
      if (content?.thumbnailIdeas && content.thumbnailIdeas.length > 0) return null;

      return suggestion({
        area: 'thumbnail',
        title: 'Design a deliberate thumbnail',
        detail:
          'No thumbnail concept is set. On surfaces with a browsable grid, the thumbnail decides the click before the hook ever plays.',
        impact: 'medium',
        scoreDelta: 5,
        evidence: ['No thumbnail concepts recorded'],
      });
    },
  },
];

/** Run every rule and return the suggestions that fired, strongest first. */
export function runRules(input: OptimizerInput): Suggestion[] {
  const results: Suggestion[] = [];

  for (const rule of RULES) {
    try {
      const result = rule.evaluate(input);
      if (result) results.push(result);
    } catch {
      // A single broken rule must never take down the whole report.
      continue;
    }
  }

  const impactOrder = { high: 0, medium: 1, low: 2 } as const;
  return results.sort(
    (a, b) => impactOrder[a.impact] - impactOrder[b.impact] || b.scoreDelta - a.scoreDelta,
  );
}

/**
 * Score each area out of 100 by subtracting the impact of every suggestion
 * that fired against it. An area with no findings scores 100.
 */
export function scoreAreas(suggestions: Suggestion[]): Record<OptimizationArea, number> {
  const areas: OptimizationArea[] = [
    'hook', 'pacing', 'retention', 'captions', 'audio', 'visual',
    'title', 'thumbnail', 'hashtags', 'cta', 'length', 'accessibility',
  ];

  const scores = {} as Record<OptimizationArea, number>;
  for (const area of areas) {
    const penalty = suggestions
      .filter((s) => s.area === area)
      .reduce((sum, s) => sum + s.scoreDelta * 2.2, 0);
    scores[area] = round(clamp(100 - penalty, 0, 100), 1);
  }

  return scores;
}

/**
 * Weighted overall score.
 *
 * The weights reflect what actually moves distribution: the hook and captions
 * dominate, metadata matters least. They are exposed as a constant so a
 * deployment can tune them against its own performance data.
 */
export const AREA_WEIGHTS: Record<OptimizationArea, number> = {
  hook: 0.2,
  retention: 0.15,
  captions: 0.14,
  pacing: 0.12,
  length: 0.1,
  audio: 0.07,
  visual: 0.06,
  cta: 0.05,
  title: 0.05,
  hashtags: 0.02,
  thumbnail: 0.02,
  accessibility: 0.02,
};

export function overallScore(subScores: Record<OptimizationArea, number>): number {
  let total = 0;
  let weightSum = 0;

  for (const [area, weight] of Object.entries(AREA_WEIGHTS) as [OptimizationArea, number][]) {
    total += (subScores[area] ?? 100) * weight;
    weightSum += weight;
  }

  return round(weightSum > 0 ? total / weightSum : 0, 1);
}
