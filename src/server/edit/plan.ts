import type {
  AudioAnalysis,
  CaptionStyle,
  Cut,
  EditPlan,
  MediaProbe,
  RegionOfInterest,
  Transcript,
} from '@/lib/types';
import { round } from '@/lib/time';
import { buildCutPlan, mapSourceToOutput, type CutPlanOptions } from './cutplan';
import { detectSilence, type SilenceOptions } from './silence';
import { detectFalseStarts, detectFillers, type FillerOptions } from './fillers';
import { analyzePacing, applyPacing, type PacingOptions } from './pacing';
import { buildVariations, detectMoments, type MomentOptions } from './moments';
import { planReframe, type ReframeOptions } from './reframe';
import {
  buildCaptions,
  DEFAULT_CAPTION_STYLE,
  retimeCues,
  type CaptionOptions,
} from './captions';
import { planAudio, type AudioPlanOptions } from './audio';
import { planEnhancement, type EnhanceOptions } from './enhance';
import {
  estimateEnergy,
  planMotion,
  planTransitions,
  selectMusic,
  type MotionOptions,
  type MusicOptions,
  type TransitionOptions,
} from './motion';

/**
 * The edit orchestrator.
 *
 * Order matters and is load-bearing:
 *   1. detect what to remove (silence, fillers, false starts)
 *   2. resolve those into a cut plan
 *   3. retime for pacing — this changes the output timeline
 *   4. everything downstream (captions, motion, transitions) is expressed on
 *      the *output* timeline, so it must run after retiming
 *
 * Every stage is individually switchable, because a user who only wants
 * captions should not have their pauses removed as a side effect.
 */

export interface EditPipelineOptions {
  removeSilence: boolean;
  removeFillers: boolean;
  removeFalseStarts: boolean;
  improvePacing: boolean;
  generateCaptions: boolean;
  autoReframe: boolean;
  addMotion: boolean;
  addTransitions: boolean;
  addMusic: boolean;
  enhanceAudio: boolean;
  enhanceVideo: boolean;

  silence: Partial<SilenceOptions>;
  fillers: Partial<FillerOptions>;
  pacing: Partial<PacingOptions>;
  cutPlan: Partial<CutPlanOptions>;
  moments: Partial<MomentOptions>;
  reframe: Partial<ReframeOptions>;
  captions: Partial<CaptionOptions>;
  captionStyle: Partial<CaptionStyle>;
  audio: Partial<AudioPlanOptions>;
  enhance: Partial<EnhanceOptions>;
  motion: Partial<MotionOptions>;
  transitions: Partial<TransitionOptions>;
  music: Partial<MusicOptions>;

  /** Cuts the user added or edited by hand; merged with detected ones. */
  manualCuts: Cut[];
}

export const DEFAULT_PIPELINE_OPTIONS: EditPipelineOptions = {
  removeSilence: true,
  removeFillers: true,
  removeFalseStarts: true,
  improvePacing: true,
  generateCaptions: true,
  autoReframe: true,
  addMotion: true,
  addTransitions: true,
  addMusic: false,
  enhanceAudio: true,
  enhanceVideo: true,

  silence: {},
  fillers: {},
  pacing: {},
  cutPlan: {},
  moments: {},
  reframe: {},
  captions: {},
  captionStyle: {},
  audio: {},
  enhance: {},
  motion: {},
  transitions: {},
  music: {},

  manualCuts: [],
};

export interface EditPipelineInput {
  probe: MediaProbe;
  transcript?: Transcript;
  audio?: AudioAnalysis;
  regions?: RegionOfInterest[];
}

/**
 * Run the full analysis pipeline.
 *
 * Pure and synchronous: everything expensive (ASR, ROI detection, loudness
 * measurement) happens upstream and arrives as data. That keeps the whole
 * creative logic testable in milliseconds, and means re-running with different
 * options never re-does the expensive work.
 */
export function buildEditPlan(
  input: EditPipelineInput,
  options: Partial<EditPipelineOptions> = {},
): EditPlan {
  const opts = { ...DEFAULT_PIPELINE_OPTIONS, ...options };
  const { probe, transcript, audio, regions } = input;
  const durationSec = probe.durationSec;

  // --- 1. What should come out -------------------------------------------
  const detected: Cut[] = [];

  if (opts.removeSilence) {
    detected.push(...detectSilence({ transcript, audio, durationSec }, opts.silence));
  }
  if (opts.removeFillers && transcript) {
    detected.push(...detectFillers(transcript, opts.fillers));
  }
  if (opts.removeFalseStarts && transcript) {
    detected.push(...detectFalseStarts(transcript));
  }

  // --- 2. Resolve into an edit decision list ------------------------------
  let cutPlan = buildCutPlan([...detected, ...opts.manualCuts], durationSec, opts.cutPlan);

  // --- 3. Retime for pacing ----------------------------------------------
  const pacing = transcript ? analyzePacing(transcript, opts.pacing) : null;
  if (opts.improvePacing && pacing) {
    cutPlan = applyPacing(cutPlan, pacing, opts.pacing);
  }

  // --- 4. Creative layers, all on the output timeline ---------------------
  const moments = transcript ? detectMoments(transcript, audio, opts.moments) : [];
  const variations = transcript ? buildVariations(moments, transcript) : [];

  const captionStyle: CaptionStyle = { ...DEFAULT_CAPTION_STYLE, ...opts.captionStyle };
  const captions =
    opts.generateCaptions && transcript
      ? retimeCues(buildCaptions(transcript, opts.captions), (time) =>
          mapSourceToOutput(cutPlan, time),
        )
      : [];

  const reframe =
    opts.autoReframe && probe.width > 0 && probe.height > 0
      ? planReframe(regions ?? [], {
          width: probe.width,
          height: probe.height,
          durationSec,
        }, opts.reframe)
      : null;

  const motion = opts.addMotion ? planMotion(cutPlan, moments, opts.motion) : [];
  const transitions = opts.addTransitions ? planTransitions(cutPlan, opts.transitions) : [];

  const cutsPerMinute =
    cutPlan.outputDurationSec > 0
      ? (cutPlan.kept.length / cutPlan.outputDurationSec) * 60
      : 0;
  const energy = estimateEnergy(pacing?.averageWpm ?? 140, cutsPerMinute);
  const music = opts.addMusic
    ? selectMusic(cutPlan.outputDurationSec, energy, opts.music)
    : null;

  const audioPlan = opts.enhanceAudio
    ? planAudio(audio ?? emptyAnalysis(), probe, opts.audio)
    : disabledAudioPlan();

  const videoPlan = opts.enhanceVideo
    ? planEnhancement(probe, opts.enhance)
    : planEnhancement(probe, { ...opts.enhance, intensity: 0 });

  return {
    version: 1,
    sourceDurationSec: round(durationSec),
    cutPlan,
    moments,
    variations,
    reframe,
    captions,
    captionStyle,
    motion,
    transitions,
    music,
    audio: audioPlan,
    video: videoPlan,
  };
}

/** Headline numbers for the review UI. */
export function summarizePlan(plan: EditPlan): {
  removedSec: number;
  removedPercent: number;
  cutCount: number;
  appliedCutCount: number;
  captionCount: number;
  outputDurationSec: number;
  topMomentScore: number;
} {
  const applied = plan.cutPlan.sourceDurationSec - plan.cutPlan.outputDurationSec;
  return {
    removedSec: round(applied),
    removedPercent:
      plan.cutPlan.sourceDurationSec > 0
        ? round((applied / plan.cutPlan.sourceDurationSec) * 100, 1)
        : 0,
    cutCount: plan.cutPlan.cuts.length,
    appliedCutCount: plan.cutPlan.cuts.filter((cut) => cut.accepted !== false).length,
    captionCount: plan.captions.length,
    outputDurationSec: plan.cutPlan.outputDurationSec,
    topMomentScore: plan.moments[0]?.score ?? 0,
  };
}

function emptyAnalysis(): AudioAnalysis {
  return {
    frames: [],
    integratedLufs: -23,
    loudnessRangeLu: 7,
    truePeakDb: -3,
    noiseFloorDb: -60,
  };
}

function disabledAudioPlan() {
  return {
    denoise: false,
    denoiseStrength: 0,
    targetLufs: -14,
    targetTruePeakDb: -1,
    loudnessRangeLu: 11,
    deEss: false,
    highPassHz: null,
    compressorRatio: null,
    notes: ['Audio processing disabled.'],
  };
}
