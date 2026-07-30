import { describe, expect, it } from 'vitest';
import type { AudioAnalysis, Cut, MediaProbe, RegionOfInterest, Transcript } from '@/lib/types';
import { mergeRanges, subtractRanges, totalDuration } from '@/lib/time';
import { detectSilence, detectSilenceFromEnvelope, estimateNoiseFloor, intersectRanges } from '@/server/edit/silence';
import { detectFalseStarts, detectFillers, isHardFiller } from '@/server/edit/fillers';
import {
  buildCutPlan,
  dedupeCuts,
  mapOutputToSource,
  mapSourceToOutput,
  projectRange,
} from '@/server/edit/cutplan';
import { analyzePacing, applyPacing } from '@/server/edit/pacing';
import { buildVariations, detectMoments, scoreText } from '@/server/edit/moments';
import { cropSize, dropRedundantKeyframes, planReframe, sampleCrop, selectSubject } from '@/server/edit/reframe';
import { buildCaptions, groupWordsIntoCues, selectHighlights, toAss, toAssColor, toSrt, wrapCue, DEFAULT_CAPTION_STYLE } from '@/server/edit/captions';
import { estimateSnr, parseAstats, parseLoudnorm, planAudio } from '@/server/edit/audio';
import { bitsPerPixel, planEnhancement } from '@/server/edit/enhance';
import { estimateEnergy, planMotion, planTransitions, selectMusic } from '@/server/edit/motion';
import { buildEditPlan, summarizePlan } from '@/server/edit/plan';
import { buildMockTranscript } from '@/server/ai/providers/mock';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function words(entries: [string, number, number][], confidence = 0.95) {
  return entries.map(([text, start, end]) => ({ text, start, end, confidence }));
}

function transcriptFrom(entries: [string, number, number][], durationSec?: number): Transcript {
  const list = words(entries);
  return {
    language: 'en',
    durationSec: durationSec ?? (list[list.length - 1]?.end ?? 0) + 0.5,
    words: list,
    segments: [
      {
        start: list[0]?.start ?? 0,
        end: list[list.length - 1]?.end ?? 0,
        text: list.map((w) => w.text).join(' '),
        words: list,
      },
    ],
  };
}

const PROBE: MediaProbe = {
  durationSec: 60,
  width: 1920,
  height: 1080,
  fps: 30,
  hasAudio: true,
  audioChannels: 2,
  audioSampleRate: 48000,
  videoCodec: 'h264',
  audioCodec: 'aac',
  bitrateKbps: 6000,
};

// ---------------------------------------------------------------------------
// Range maths
// ---------------------------------------------------------------------------

describe('range utilities', () => {
  it('merges overlapping and adjacent ranges', () => {
    const merged = mergeRanges([
      { start: 0, end: 2 },
      { start: 1.5, end: 3 },
      { start: 5, end: 6 },
    ]);
    expect(merged).toEqual([
      { start: 0, end: 3 },
      { start: 5, end: 6 },
    ]);
  });

  it('joins ranges separated by less than the gap tolerance', () => {
    const merged = mergeRanges(
      [
        { start: 0, end: 1 },
        { start: 1.04, end: 2 },
      ],
      0.05,
    );
    expect(merged).toEqual([{ start: 0, end: 2 }]);
  });

  it('subtracts holes and drops zero-length remnants', () => {
    const result = subtractRanges({ start: 0, end: 10 }, [
      { start: 2, end: 4 },
      { start: 4, end: 5 },
      { start: 9.999999, end: 10 },
    ]);
    expect(result).toEqual([
      { start: 0, end: 2 },
      { start: 5, end: 9.999999 },
    ]);
  });

  it('counts overlapping ranges once', () => {
    expect(
      totalDuration([
        { start: 0, end: 5 },
        { start: 2, end: 8 },
      ]),
    ).toBe(8);
  });
});

// ---------------------------------------------------------------------------
// Silence
// ---------------------------------------------------------------------------

describe('silence detection', () => {
  const analysis: AudioAnalysis = {
    frames: [
      { time: 0, db: -60 }, { time: 0.5, db: -58 }, { time: 1, db: -20 },
      { time: 1.5, db: -18 }, { time: 2, db: -19 }, { time: 2.5, db: -62 },
      { time: 3, db: -61 }, { time: 3.5, db: -60 }, { time: 4, db: -22 },
      { time: 4.5, db: -20 },
    ],
    integratedLufs: -20,
    loudnessRangeLu: 8,
    truePeakDb: -3,
    noiseFloorDb: -60,
  };

  it('estimates the noise floor from a low percentile, not the minimum', () => {
    const floor = estimateNoiseFloor([
      { time: 0, db: -100 },
      ...Array.from({ length: 20 }, (_, i) => ({ time: i + 1, db: -50 })),
    ]);
    expect(floor).toBeGreaterThan(-100);
  });

  it('finds quiet runs in the loudness envelope', () => {
    const ranges = detectSilenceFromEnvelope(analysis, { minSilenceSec: 0.4 });
    expect(ranges.length).toBeGreaterThan(0);
    // The 2.5s–4s stretch is the clearest silence in the fixture.
    expect(ranges.some((r) => r.start <= 2.5 && r.end >= 3.5)).toBe(true);
  });

  it('does not treat quietly-delivered speech as silence when a transcript disagrees', () => {
    const transcript = transcriptFrom([
      ['Words', 2.5, 3.0],
      ['here', 3.0, 3.5],
    ], 5);

    const cuts = detectSilence({ transcript, audio: analysis, durationSec: 5 });
    // The envelope says 2.5-4 is quiet, but the transcript has words there,
    // so intersecting the two sources protects the line.
    const covering = cuts.filter((cut) => cut.start < 3.4 && cut.end > 2.6);
    expect(covering).toHaveLength(0);
  });

  it('pads cuts so speech is not clipped', () => {
    const transcript = transcriptFrom([
      ['One', 0, 0.5],
      ['two', 3, 3.5],
    ], 4);

    const cuts = detectSilence({ transcript, durationSec: 4 }, { paddingSec: 0.1 });
    const gap = cuts.find((cut) => cut.start > 0.4);
    expect(gap).toBeDefined();
    expect(gap!.start).toBeGreaterThan(0.5);
    expect(gap!.end).toBeLessThan(3);
  });

  it('labels long gaps distinctly and trusts them more', () => {
    const transcript = transcriptFrom([
      ['Start', 0, 0.5],
      ['end', 4, 4.5],
    ], 5);

    const cuts = detectSilence({ transcript, durationSec: 5 });
    const long = cuts.find((cut) => cut.reason === 'long-pause');
    expect(long).toBeDefined();
    expect(long!.confidence).toBeGreaterThan(0.9);
  });

  it('intersects two range sets', () => {
    expect(
      intersectRanges(
        [{ start: 0, end: 5 }, { start: 7, end: 10 }],
        [{ start: 3, end: 8 }],
      ),
    ).toEqual([
      { start: 3, end: 5 },
      { start: 7, end: 8 },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Fillers
// ---------------------------------------------------------------------------

describe('filler removal', () => {
  it('recognises disfluencies regardless of punctuation and case', () => {
    expect(isHardFiller('Um,')).toBe(true);
    expect(isHardFiller('UH')).toBe(true);
    expect(isHardFiller('umbrella')).toBe(false);
  });

  it('cuts standalone disfluencies with high confidence', () => {
    const transcript = transcriptFrom([
      ['So', 0, 0.3],
      ['um,', 0.3, 0.6],
      ['here', 0.6, 0.9],
    ]);

    const cuts = detectFillers(transcript);
    expect(cuts).toHaveLength(1);
    expect(cuts[0]!.confidence).toBeGreaterThan(0.9);
    expect(cuts[0]!.start).toBeCloseTo(0.3);
  });

  it('never removes a meaningful "like" by default', () => {
    const transcript = transcriptFrom([
      ['I', 0, 0.2],
      ['like', 0.2, 0.5],
      ['this', 0.5, 0.8],
    ]);
    expect(detectFillers(transcript)).toHaveLength(0);
  });

  it('removes a discourse-marker "like" only at a clause boundary with a pause', () => {
    const transcript = transcriptFrom([
      ['Anyway.', 0, 0.4],
      ['like', 0.8, 1.1],
      ['this', 1.5, 1.8],
    ]);

    const off = detectFillers(transcript, { removeSoftFillers: false });
    expect(off.filter((cut) => cut.note?.includes('like'))).toHaveLength(0);

    const on = detectFillers(transcript, { removeSoftFillers: true });
    expect(on.some((cut) => cut.note?.includes('like'))).toBe(true);
  });

  it('matches multi-word filler phrases as one unit', () => {
    const transcript = transcriptFrom([
      ['It', 0, 0.2],
      ['is,', 0.2, 0.4],
      ['you', 0.4, 0.55],
      ['know,', 0.55, 0.75],
      ['fine', 0.75, 1.1],
    ]);

    const cuts = detectFillers(transcript);
    const phrase = cuts.find((cut) => cut.note?.includes('you know'));
    expect(phrase).toBeDefined();
    expect(phrase!.start).toBeCloseTo(0.4);
    expect(phrase!.end).toBeCloseTo(0.75);
  });

  it('ignores low-confidence tokens', () => {
    const transcript: Transcript = {
      language: 'en',
      durationSec: 1,
      words: [{ text: 'um', start: 0, end: 0.2, confidence: 0.2 }],
      segments: [],
    };
    expect(detectFillers(transcript)).toHaveLength(0);
  });

  it('cuts the first half of a stuttered repeat', () => {
    const transcript = transcriptFrom([
      ['I', 0, 0.2],
      ['want', 0.2, 0.5],
      ['I', 0.55, 0.7],
      ['want', 0.7, 1.0],
      ['this', 1.0, 1.3],
    ]);

    const cuts = detectFalseStarts(transcript);
    expect(cuts).toHaveLength(1);
    expect(cuts[0]!.reason).toBe('false-start');
    expect(cuts[0]!.start).toBeCloseTo(0);
    expect(cuts[0]!.end).toBeCloseTo(0.55);
  });

  it('keeps a deliberate rhetorical repeat with a beat between halves', () => {
    const transcript = transcriptFrom([
      ['Never.', 0, 0.5],
      ['Never.', 1.4, 1.9],
    ]);
    expect(detectFalseStarts(transcript)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Cut plan
// ---------------------------------------------------------------------------

describe('cut plan', () => {
  it('resolves overlapping proposals in favour of the more confident one', () => {
    const cuts: Cut[] = [
      { start: 0, end: 2, reason: 'silence', confidence: 0.6 },
      { start: 1, end: 3, reason: 'filler', confidence: 0.9 },
    ];
    const deduped = dedupeCuts(cuts);

    const total = deduped.reduce((sum, cut) => sum + (cut.end - cut.start), 0);
    expect(total).toBeCloseTo(3);
    // No overlap survives.
    for (let i = 1; i < deduped.length; i++) {
      expect(deduped[i]!.start).toBeGreaterThanOrEqual(deduped[i - 1]!.end - 1e-9);
    }
  });

  it('applies confident cuts and lays out the survivors contiguously', () => {
    const plan = buildCutPlan(
      [{ start: 2, end: 4, reason: 'silence', confidence: 0.9 }],
      10,
    );

    expect(plan.kept).toHaveLength(2);
    expect(plan.kept[0]).toMatchObject({ sourceStart: 0, sourceEnd: 2, outputStart: 0 });
    expect(plan.kept[1]).toMatchObject({ sourceStart: 4, sourceEnd: 10, outputStart: 2 });
    expect(plan.outputDurationSec).toBe(8);
    expect(plan.removedSec).toBe(2);
  });

  it('keeps low-confidence cuts as suggestions without applying them', () => {
    const plan = buildCutPlan(
      [{ start: 2, end: 4, reason: 'silence', confidence: 0.3 }],
      10,
    );
    expect(plan.cuts).toHaveLength(1);
    expect(plan.outputDurationSec).toBe(10);
  });

  it('honours an explicit user rejection of a confident cut', () => {
    const plan = buildCutPlan(
      [{ start: 2, end: 4, reason: 'silence', confidence: 0.99, accepted: false }],
      10,
    );
    expect(plan.outputDurationSec).toBe(10);
  });

  it('honours an explicit user acceptance of a low-confidence cut', () => {
    const plan = buildCutPlan(
      [{ start: 2, end: 4, reason: 'silence', confidence: 0.1, accepted: true }],
      10,
    );
    expect(plan.outputDurationSec).toBe(8);
  });

  it('refuses to remove more than the configured fraction of the source', () => {
    const cuts: Cut[] = Array.from({ length: 9 }, (_, i) => ({
      start: i,
      end: i + 0.9,
      reason: 'silence' as const,
      confidence: 0.9,
    }));

    const plan = buildCutPlan(cuts, 10, { maxRemovedFraction: 0.5 });
    expect(plan.removedSec).toBeLessThanOrEqual(5.1);
  });

  it('maps times between the source and output timelines', () => {
    const plan = buildCutPlan([{ start: 2, end: 4, reason: 'silence', confidence: 0.9 }], 10);

    expect(mapSourceToOutput(plan, 1)).toBe(1);
    expect(mapSourceToOutput(plan, 5)).toBe(3);
    // A moment inside a removed region has no output position.
    expect(mapSourceToOutput(plan, 3)).toBeNull();
    expect(mapOutputToSource(plan, 3)).toBe(5);
  });

  it('closes the gap when a source range straddles a cut', () => {
    const plan = buildCutPlan([{ start: 2, end: 4, reason: 'silence', confidence: 0.9 }], 10);
    // Source 1-5 loses 2-4; the surviving halves are adjacent on the output,
    // so a caption covering them should play as one continuous cue.
    expect(projectRange(plan, { start: 1, end: 5 })).toEqual([{ start: 1, end: 3 }]);
  });

  it('drops a range that falls entirely inside a cut', () => {
    const plan = buildCutPlan([{ start: 2, end: 6, reason: 'silence', confidence: 0.9 }], 10);
    expect(projectRange(plan, { start: 3, end: 5 })).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Pacing
// ---------------------------------------------------------------------------

describe('pacing', () => {
  it('measures speaking rate and flags slow stretches', () => {
    // 0-10s fast, 10-20s slow.
    const entries: [string, number, number][] = [];
    for (let i = 0; i < 40; i++) entries.push([`word${i}`, i * 0.25, i * 0.25 + 0.2]);
    for (let i = 0; i < 8; i++) entries.push([`slow${i}`, 10 + i * 1.25, 10 + i * 1.25 + 0.3]);

    const analysis = analyzePacing(transcriptFrom(entries, 20));
    expect(analysis.averageWpm).toBeGreaterThan(0);
    expect(analysis.slowSections.length).toBeGreaterThan(0);
    expect(analysis.slowSections[0]!.start).toBeGreaterThanOrEqual(8);
  });

  it('caps retiming within the configured bounds', () => {
    const entries: [string, number, number][] = Array.from({ length: 10 }, (_, i) => [
      `w${i}`,
      i * 2,
      i * 2 + 0.4,
    ]);
    const transcript = transcriptFrom(entries, 20);

    const plan = buildCutPlan([], 20);
    const retimed = applyPacing(plan, analyzePacing(transcript), { maxSpeed: 1.15, minSpeed: 0.92 });

    for (const segment of retimed.kept) {
      expect(segment.speed).toBeLessThanOrEqual(1.15);
      expect(segment.speed).toBeGreaterThanOrEqual(0.92);
    }
  });

  it('shortens the output when it speeds a segment up', () => {
    const entries: [string, number, number][] = Array.from({ length: 12 }, (_, i) => [
      `w${i}`,
      i * 1.5,
      i * 1.5 + 0.3,
    ]);
    const plan = buildCutPlan([], 18);
    const analysis = analyzePacing(transcriptFrom(entries, 18));
    const retimed = applyPacing(plan, analysis);

    expect(retimed.outputDurationSec).toBeLessThanOrEqual(plan.outputDurationSec + 0.01);
  });

  it('returns a neutral analysis for an empty transcript', () => {
    const analysis = analyzePacing({ language: 'en', durationSec: 0, words: [], segments: [] });
    expect(analysis.samples).toHaveLength(0);
    expect(analysis.score).toBe(50);
  });
});

// ---------------------------------------------------------------------------
// Moments
// ---------------------------------------------------------------------------

describe('moment detection', () => {
  it('scores hooks, questions and numbers', () => {
    const hits = scoreText("Here's why most people never finish. Is that 90% figure real?");
    const signals = hits.map((hit) => hit.signal);

    expect(signals).toContain('hook');
    expect(signals).toContain('question');
    expect(signals).toContain('number');
  });

  it('scores flat prose low', () => {
    const hits = scoreText('The object was placed on the table near the window in the room.');
    const total = hits.reduce((sum, hit) => sum + hit.weight, 0);
    expect(total).toBeLessThan(0.2);
  });

  it('surfaces the strongest moment first and explains why', () => {
    const transcript: Transcript = {
      language: 'en',
      durationSec: 40,
      words: [],
      segments: [
        { start: 0, end: 8, text: 'So we drove out to the site in the afternoon.', words: [] },
        {
          start: 8,
          end: 18,
          text: "Here's why nobody tells you this. The number one mistake is insane.",
          words: [],
        },
        { start: 18, end: 30, text: 'And then we went home for dinner.', words: [] },
      ],
    };

    const moments = detectMoments(transcript);
    expect(moments.length).toBeGreaterThan(0);
    expect(moments[0]!.start).toBeGreaterThanOrEqual(0);
    expect(Object.keys(moments[0]!.breakdown).length).toBeGreaterThan(0);
    expect(moments[0]!.score).toBeGreaterThan(0.28);
  });

  it('builds one variation per target length, all within bounds', () => {
    const transcript: Transcript = {
      language: 'en',
      durationSec: 120,
      words: [],
      segments: Array.from({ length: 12 }, (_, i) => ({
        start: i * 10,
        end: i * 10 + 10,
        text:
          i === 5
            ? "Here's the thing nobody tells you. The number one mistake is insane."
            : 'We kept going for a while and nothing much happened.',
        words: [],
      })),
    };

    const moments = detectMoments(transcript);
    const variations = buildVariations(moments, transcript, {
      targetLengthsSec: [15, 30, 45],
      count: 5,
    });

    expect(variations.length).toBeGreaterThanOrEqual(3);
    for (const variation of variations) {
      const length = variation.range.end - variation.range.start;
      expect(length).toBeGreaterThan(0);
      expect(variation.range.end).toBeLessThanOrEqual(transcript.durationSec);
      expect(variation.rationale.length).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// Reframe
// ---------------------------------------------------------------------------

describe('auto-reframe', () => {
  it('computes a full-height crop for a vertical target from landscape source', () => {
    const size = cropSize(1920, 1080, 9 / 16);
    expect(size.height).toBe(1080);
    expect(size.width).toBe(608);
  });

  it('prefers a face over a saliency region', () => {
    const regions: RegionOfInterest[] = [
      { time: 0, x: 0.1, y: 0.1, width: 0.5, height: 0.5, confidence: 0.99, kind: 'saliency' },
      { time: 0, x: 0.6, y: 0.3, width: 0.1, height: 0.12, confidence: 0.7, kind: 'face' },
    ];
    expect(selectSubject(regions, true)!.kind).toBe('face');
  });

  it('falls back to a static centre crop with no detections', () => {
    const plan = planReframe([], { width: 1920, height: 1080, durationSec: 10 });
    expect(plan.isStaticFallback).toBe(true);
    expect(plan.keyframes).toHaveLength(1);
    expect(plan.keyframes[0]!.x).toBe(Math.round((1920 - 608) / 2));
  });

  it('keeps the crop window inside the frame at all times', () => {
    const regions: RegionOfInterest[] = Array.from({ length: 40 }, (_, i) => ({
      time: i * 0.1,
      // Subject pinned to the far right edge.
      x: 0.95,
      y: 0.5,
      width: 0.1,
      height: 0.12,
      confidence: 0.9,
      kind: 'face' as const,
    }));

    const plan = planReframe(regions, { width: 1920, height: 1080, durationSec: 4 });
    for (const frame of plan.keyframes) {
      expect(frame.x).toBeGreaterThanOrEqual(0);
      expect(frame.x + frame.width).toBeLessThanOrEqual(1920);
      expect(frame.y).toBeGreaterThanOrEqual(0);
      expect(frame.y + frame.height).toBeLessThanOrEqual(1080);
    }
  });

  it('smooths rather than snapping to each detection', () => {
    const regions: RegionOfInterest[] = [
      ...Array.from({ length: 10 }, (_, i) => ({
        time: i * 0.1, x: 0.2, y: 0.5, width: 0.1, height: 0.12, confidence: 0.9, kind: 'face' as const,
      })),
      ...Array.from({ length: 10 }, (_, i) => ({
        // A 0.3 jump — under the cut threshold, so it should pan, not teleport.
        time: 1 + i * 0.1, x: 0.5, y: 0.5, width: 0.1, height: 0.12, confidence: 0.9, kind: 'face' as const,
      })),
    ];

    const plan = planReframe(regions, { width: 1920, height: 1080, durationSec: 2 });
    const positions = plan.keyframes.map((frame) => frame.x);
    const biggestStep = Math.max(
      ...positions.slice(1).map((x, i) => Math.abs(x - positions[i]!)),
    );

    // A hard snap would move ~576px in one 100ms step.
    expect(biggestStep).toBeLessThan(200);
  });

  it('frames two faces as a group rather than picking one', () => {
    const regions: RegionOfInterest[] = [
      { time: 0, x: 0.35, y: 0.4, width: 0.08, height: 0.1, confidence: 0.9, kind: 'face' },
      { time: 0, x: 0.5, y: 0.4, width: 0.08, height: 0.1, confidence: 0.9, kind: 'face' },
    ];

    const plan = planReframe(regions, { width: 1920, height: 1080, durationSec: 1 });
    const centre = plan.keyframes[0]!.x + plan.keyframes[0]!.width / 2;
    const expected = ((0.35 + 0.58) / 2) * 1920;

    expect(Math.abs(centre - expected)).toBeLessThan(120);
  });

  it('collapses a static shot to a minimal keyframe set', () => {
    const flat = Array.from({ length: 50 }, (_, i) => ({
      time: i * 0.1, x: 100, y: 0, width: 608, height: 1080,
    }));
    expect(dropRedundantKeyframes(flat).length).toBeLessThan(5);
  });

  it('interpolates the crop between keyframes', () => {
    const plan = {
      targetAspect: 9 / 16,
      sourceWidth: 1920,
      sourceHeight: 1080,
      isStaticFallback: false,
      keyframes: [
        { time: 0, x: 0, y: 0, width: 608, height: 1080 },
        { time: 2, x: 200, y: 0, width: 608, height: 1080 },
      ],
    };
    expect(sampleCrop(plan, 1).x).toBe(100);
    expect(sampleCrop(plan, 5).x).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Captions
// ---------------------------------------------------------------------------

describe('captions', () => {
  it('breaks cues at sentence ends', () => {
    const groups = groupWordsIntoCues(
      words([
        ['Hello', 0, 0.3],
        ['there.', 0.3, 0.6],
        ['Next', 0.65, 0.9],
        ['line', 0.9, 1.2],
      ]),
    );
    expect(groups).toHaveLength(2);
    expect(groups[0]!.map((w) => w.text).join(' ')).toBe('Hello there.');
  });

  it('breaks on a long pause', () => {
    const groups = groupWordsIntoCues(
      words([
        ['One', 0, 0.3],
        ['two', 1.2, 1.5],
      ]),
      { breakOnPauseSec: 0.4 },
    );
    expect(groups).toHaveLength(2);
  });

  it('respects the word budget', () => {
    const groups = groupWordsIntoCues(
      words(Array.from({ length: 12 }, (_, i) => [`w${i}`, i * 0.2, i * 0.2 + 0.15] as [string, number, number])),
      { maxWordsPerCue: 4 },
    );
    for (const group of groups) expect(group.length).toBeLessThanOrEqual(4);
  });

  it('highlights content words and never stop words', () => {
    const cueWords = words([
      ['the', 0, 0.1],
      ['revenue', 0.1, 0.5],
      ['was', 0.5, 0.6],
      ['400%', 0.6, 1.0],
    ]);

    const highlights = selectHighlights(cueWords, new Set(['revenue']));
    expect(highlights.has(0)).toBe(false);
    expect(highlights.has(2)).toBe(false);
    expect(highlights.size).toBeGreaterThan(0);
  });

  it('caps highlighting at the configured ratio', () => {
    const cueWords = words([
      ['revenue', 0, 0.3],
      ['profit', 0.3, 0.6],
      ['margin', 0.6, 0.9],
      ['growth', 0.9, 1.2],
    ]);
    const highlights = selectHighlights(cueWords, new Set(), { maxHighlightRatio: 0.25 });
    expect(highlights.size).toBeLessThanOrEqual(1);
  });

  it('builds cues with sequential indices and non-empty tokens', () => {
    const cues = buildCaptions(buildMockTranscript('caption-test'));
    expect(cues.length).toBeGreaterThan(0);
    cues.forEach((cue, index) => {
      expect(cue.index).toBe(index + 1);
      expect(cue.tokens.length).toBeGreaterThan(0);
      expect(cue.end).toBeGreaterThan(cue.start);
    });
  });

  it('balances wrapped lines instead of orphaning a word', () => {
    const lines = wrapCue('one two three four five six seven', {
      ...DEFAULT_CAPTION_STYLE,
      maxCharsPerLine: 18,
      maxLines: 2,
    });
    expect(lines).toHaveLength(2);
    const [first, second] = lines;
    expect(Math.abs(first!.length - second!.length)).toBeLessThan(10);
  });

  it('converts hex to the reversed ASS colour format', () => {
    expect(toAssColor('#FFFFFF')).toBe('&H00FFFFFF');
    expect(toAssColor('#7C5CFF')).toBe('&H00FF5C7C');
  });

  it('emits valid SRT with comma decimal separators', () => {
    const srt = toSrt([
      { index: 1, start: 1.5, end: 3.25, text: 'Hello', tokens: [] },
    ]);
    expect(srt).toContain('00:00:01,500 --> 00:00:03,250');
  });

  it('emits an ASS file with a style block and karaoke timing', () => {
    const cues = buildCaptions(buildMockTranscript('ass-test')).slice(0, 3);
    const ass = toAss(cues, DEFAULT_CAPTION_STYLE, { width: 1080, height: 1920 });

    expect(ass).toContain('[V4+ Styles]');
    expect(ass).toContain('PlayResX: 1080');
    expect(ass).toContain('Dialogue: 0,');
    expect(ass).toMatch(/\\k\d+/);
  });

  it('escapes ASS braces so text cannot inject override tags', () => {
    const ass = toAss(
      [
        {
          index: 1,
          start: 0,
          end: 1,
          text: '{\\fs99}',
          tokens: [{ text: '{\\fs99}', start: 0, end: 1, highlight: false }],
        },
      ],
      DEFAULT_CAPTION_STYLE,
      { width: 1080, height: 1920 },
    );
    expect(ass).toContain('\\{');
  });
});

// ---------------------------------------------------------------------------
// Audio & enhancement
// ---------------------------------------------------------------------------

describe('audio planning', () => {
  const clean: AudioAnalysis = {
    frames: Array.from({ length: 100 }, (_, i) => ({ time: i * 0.1, db: i < 10 ? -70 : -18 })),
    integratedLufs: -20,
    loudnessRangeLu: 6,
    truePeakDb: -2,
    noiseFloorDb: -70,
  };

  const noisy: AudioAnalysis = {
    ...clean,
    frames: Array.from({ length: 100 }, (_, i) => ({ time: i * 0.1, db: i < 10 ? -34 : -22 })),
    noiseFloorDb: -34,
  };

  it('measures signal-to-noise ratio', () => {
    expect(estimateSnr(clean)).toBeGreaterThan(30);
    expect(estimateSnr(noisy)).toBeLessThan(20);
  });

  it('denoises only when the measurement calls for it', () => {
    expect(planAudio(clean, PROBE).denoise).toBe(false);
    expect(planAudio(noisy, PROBE).denoise).toBe(true);
  });

  it('scales denoise strength with how bad the noise is', () => {
    const plan = planAudio(noisy, PROBE);
    expect(plan.denoiseStrength).toBeGreaterThan(0);
    expect(plan.denoiseStrength).toBeLessThanOrEqual(18);
  });

  it('targets the loudness the destination expects', () => {
    expect(planAudio(clean, PROBE, { target: 'tiktok' }).targetLufs).toBe(-14);
    expect(planAudio(clean, PROBE, { target: 'broadcast' }).targetLufs).toBe(-23);
  });

  it('explains every decision it makes', () => {
    const plan = planAudio(noisy, PROBE);
    expect(plan.notes.length).toBeGreaterThan(0);
    expect(plan.notes.join(' ')).toMatch(/SNR|LUFS|noise/i);
  });

  it('parses the astats envelope, mapping -inf to a floor', () => {
    const frames = parseAstats(`
      frame:0 pts:0 pts_time:0
      lavfi.astats.Overall.RMS_level=-23.4
      frame:1 pts:1024 pts_time:0.05
      lavfi.astats.Overall.RMS_level=-inf
    `);
    expect(frames).toHaveLength(2);
    expect(frames[0]).toEqual({ time: 0, db: -23.4 });
    expect(frames[1]!.db).toBe(-100);
  });

  it('parses the loudnorm JSON block', () => {
    const parsed = parseLoudnorm(`
      [Parsed_loudnorm_0 @ 0x1]
      {
        "input_i" : "-23.45",
        "input_tp" : "-2.10",
        "input_lra" : "7.20",
        "input_thresh" : "-33.90",
        "target_offset" : "0.45"
      }
    `);
    expect(parsed).not.toBeNull();
    expect(parsed!.integratedLufs).toBeCloseTo(-23.45);
    expect(parsed!.truePeakDb).toBeCloseTo(-2.1);
  });

  it('returns null for malformed loudnorm output', () => {
    expect(parseLoudnorm('no json here')).toBeNull();
  });
});

describe('video enhancement', () => {
  it('computes bits per pixel', () => {
    const bpp = bitsPerPixel(PROBE);
    expect(bpp).not.toBeNull();
    expect(bpp!).toBeGreaterThan(0);
  });

  it('leaves a well-encoded source alone', () => {
    const plan = planEnhancement({ ...PROBE, bitrateKbps: 12000 });
    expect(plan.denoise).toBe(false);
    expect(plan.upscaleTo).toBeNull();
  });

  it('denoises a heavily compressed source', () => {
    const plan = planEnhancement({ ...PROBE, bitrateKbps: 800 });
    expect(plan.denoise).toBe(true);
    expect(plan.sharpen).toBeGreaterThan(0);
  });

  it('upscales a low-resolution source to even dimensions', () => {
    const plan = planEnhancement({ ...PROBE, width: 640, height: 480 });
    expect(plan.upscaleTo).not.toBeNull();
    expect(plan.upscaleTo!.height).toBe(720);
    expect(plan.upscaleTo!.width % 2).toBe(0);
  });

  it('disables everything at zero intensity', () => {
    const plan = planEnhancement(PROBE, { intensity: 0 });
    expect(plan.sharpen).toBe(0);
    expect(plan.saturation).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Motion, transitions, music
// ---------------------------------------------------------------------------

describe('motion and music', () => {
  it('budgets motion to a fraction of the timeline', () => {
    const plan = buildCutPlan([], 60);
    const cues = planMotion(plan, [], { maxCoverage: 0.3 });
    const covered = cues.reduce((sum, cue) => sum + (cue.end - cue.start), 0);
    expect(covered).toBeLessThanOrEqual(60 * 0.3 + 0.01);
  });

  it('skips motion on segments that are too short', () => {
    const plan = buildCutPlan(
      [
        { start: 2, end: 2.5, reason: 'silence', confidence: 0.9 },
        { start: 4, end: 4.5, reason: 'silence', confidence: 0.9 },
      ],
      6,
    );
    const cues = planMotion(plan, [], { minSegmentSec: 5 });
    expect(cues).toHaveLength(0);
  });

  it('keeps most boundaries as hard cuts', () => {
    const cuts: Cut[] = Array.from({ length: 5 }, (_, i) => ({
      start: i * 4 + 1,
      end: i * 4 + 1.2,
      reason: 'silence' as const,
      confidence: 0.9,
    }));
    const plan = buildCutPlan(cuts, 30);
    const transitions = planTransitions(plan);

    expect(transitions.every((t) => t.kind === 'cut')).toBe(true);
  });

  it('decorates boundaries that removed a lot of time', () => {
    const plan = buildCutPlan([{ start: 2, end: 12, reason: 'long-pause', confidence: 0.95 }], 30);
    const transitions = planTransitions(plan);
    expect(transitions[0]!.kind).toBe('dip-to-black');
  });

  it('matches music to the requested mood before the energy', () => {
    const scary = selectMusic(30, 0.9, { moods: ['scary'] });
    expect(scary).not.toBeNull();
    expect(scary!.trackId).toBe('trk_hollow');
  });

  it('only returns copyright-safe tracks', () => {
    const cue = selectMusic(30, 0.5, { moods: ['business'] });
    expect(cue!.license).toBe('CC0-1.0');
  });

  it('estimates energy from pace and cut density', () => {
    expect(estimateEnergy(90, 2)).toBeLessThan(estimateEnergy(190, 25));
  });
});

// ---------------------------------------------------------------------------
// Full pipeline
// ---------------------------------------------------------------------------

describe('edit pipeline', () => {
  const transcript = buildMockTranscript('pipeline-test');
  const probe: MediaProbe = { ...PROBE, durationSec: transcript.durationSec };

  it('produces a coherent plan from a transcript alone', () => {
    const plan = buildEditPlan({ probe, transcript });

    expect(plan.version).toBe(1);
    expect(plan.cutPlan.kept.length).toBeGreaterThan(0);
    expect(plan.cutPlan.outputDurationSec).toBeGreaterThan(0);
    expect(plan.cutPlan.outputDurationSec).toBeLessThanOrEqual(plan.sourceDurationSec);
    expect(plan.captions.length).toBeGreaterThan(0);
    expect(plan.reframe).not.toBeNull();
  });

  it('keeps captions inside the output timeline after cuts', () => {
    const plan = buildEditPlan({ probe, transcript });
    for (const cue of plan.captions) {
      expect(cue.start).toBeGreaterThanOrEqual(0);
      expect(cue.end).toBeLessThanOrEqual(plan.cutPlan.outputDurationSec + 0.5);
      expect(cue.end).toBeGreaterThan(cue.start);
    }
  });

  it('honours every feature toggle', () => {
    const plan = buildEditPlan(
      { probe, transcript },
      {
        removeSilence: false,
        removeFillers: false,
        removeFalseStarts: false,
        improvePacing: false,
        generateCaptions: false,
        autoReframe: false,
        addMotion: false,
        addTransitions: false,
      },
    );

    expect(plan.cutPlan.cuts).toHaveLength(0);
    expect(plan.captions).toHaveLength(0);
    expect(plan.reframe).toBeNull();
    expect(plan.motion).toHaveLength(0);
    expect(plan.cutPlan.outputDurationSec).toBeCloseTo(probe.durationSec, 1);
  });

  it('removes filler words when enabled', () => {
    const plan = buildEditPlan({ probe, transcript });
    expect(plan.cutPlan.cuts.some((cut) => cut.reason === 'filler')).toBe(true);
  });

  it('adds music only when asked', () => {
    expect(buildEditPlan({ probe, transcript }).music).toBeNull();
    expect(buildEditPlan({ probe, transcript }, { addMusic: true }).music).not.toBeNull();
  });

  it('is deterministic for the same input', () => {
    const a = buildEditPlan({ probe, transcript });
    const b = buildEditPlan({ probe, transcript });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('summarises the plan for the review UI', () => {
    const summary = summarizePlan(buildEditPlan({ probe, transcript }));
    expect(summary.removedSec).toBeGreaterThanOrEqual(0);
    expect(summary.removedPercent).toBeLessThan(100);
    expect(summary.captionCount).toBeGreaterThan(0);
  });

  it('survives a video with no transcript at all', () => {
    const plan = buildEditPlan({ probe });
    expect(plan.captions).toHaveLength(0);
    expect(plan.cutPlan.outputDurationSec).toBeCloseTo(probe.durationSec, 1);
  });
});
