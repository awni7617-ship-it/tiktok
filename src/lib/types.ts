/**
 * Core domain types shared by the edit engines, render pipeline, API layer and UI.
 *
 * Everything here is plain data: no classes, no framework imports. The edit
 * engines are pure functions over these shapes, which is what makes the whole
 * analysis pipeline unit-testable without ffmpeg, a database or a network.
 *
 * Time is *always* expressed in seconds as a float, relative to the start of the
 * source media, unless a field name says otherwise.
 */

// ---------------------------------------------------------------------------
// Media
// ---------------------------------------------------------------------------

export interface MediaProbe {
  durationSec: number;
  width: number;
  height: number;
  fps: number;
  hasAudio: boolean;
  audioChannels: number;
  audioSampleRate: number;
  videoCodec: string | null;
  audioCodec: string | null;
  bitrateKbps: number | null;
}

/** A half-open time range `[start, end)`. */
export interface TimeRange {
  start: number;
  end: number;
}

// ---------------------------------------------------------------------------
// Transcript
// ---------------------------------------------------------------------------

export interface TranscriptWord {
  /** Raw token as spoken, punctuation included. */
  text: string;
  start: number;
  end: number;
  /** ASR confidence in `[0, 1]`. */
  confidence: number;
  /** Diarization label, when the provider supports it. */
  speaker?: string;
}

export interface TranscriptSegment {
  start: number;
  end: number;
  text: string;
  words: TranscriptWord[];
  speaker?: string;
}

export interface Transcript {
  language: string;
  durationSec: number;
  segments: TranscriptSegment[];
  /** Flattened convenience view; always sorted by `start`. */
  words: TranscriptWord[];
}

// ---------------------------------------------------------------------------
// Audio analysis
// ---------------------------------------------------------------------------

/** One RMS/peak sample of the audio track, produced by `ffmpeg astats`. */
export interface LoudnessFrame {
  time: number;
  /** Momentary loudness in dBFS. Silence is around -70 and below. */
  db: number;
}

export interface AudioAnalysis {
  frames: LoudnessFrame[];
  /** Integrated loudness (LUFS) of the whole programme. */
  integratedLufs: number;
  /** Loudness range (LU). */
  loudnessRangeLu: number;
  /** True peak in dBTP. */
  truePeakDb: number;
  /** Estimated noise floor in dBFS, used to decide whether to denoise. */
  noiseFloorDb: number;
}

// ---------------------------------------------------------------------------
// Cut plan
// ---------------------------------------------------------------------------

export type CutReason =
  | 'silence'
  | 'filler'
  | 'repetition'
  | 'false-start'
  | 'long-pause'
  | 'manual'
  | 'low-energy';

/** A region the editor proposes to remove from the source. */
export interface Cut {
  start: number;
  end: number;
  reason: CutReason;
  /** How sure the engine is that this cut improves the video, in `[0, 1]`. */
  confidence: number;
  /** Human-readable justification surfaced in the review UI. */
  note?: string;
  /** User decision. `undefined` means "not reviewed yet". */
  accepted?: boolean;
}

/** The segments that survive after cuts are applied, in output order. */
export interface KeptSegment {
  sourceStart: number;
  sourceEnd: number;
  /** Position of this segment on the output timeline. */
  outputStart: number;
  /** Playback rate applied for pacing (1 = untouched). */
  speed: number;
}

export interface CutPlan {
  cuts: Cut[];
  kept: KeptSegment[];
  sourceDurationSec: number;
  outputDurationSec: number;
  /** Seconds removed, i.e. `sourceDuration - outputDuration` before retiming. */
  removedSec: number;
}

// ---------------------------------------------------------------------------
// Moments & clips
// ---------------------------------------------------------------------------

export type MomentSignal =
  | 'hook'
  | 'question'
  | 'emphasis'
  | 'story-beat'
  | 'payoff'
  | 'list'
  | 'contrast'
  | 'number'
  | 'energy'
  | 'laughter';

export interface Moment {
  start: number;
  end: number;
  /** Composite engagement score in `[0, 1]`. */
  score: number;
  signals: MomentSignal[];
  text: string;
  /** Per-signal contributions, for the "why?" tooltip in the UI. */
  breakdown: Record<string, number>;
}

export interface ClipVariation {
  id: string;
  label: string;
  range: TimeRange;
  score: number;
  /** Why this variation exists, e.g. "tightest 22s cut around the payoff". */
  rationale: string;
  /** Ranked hook line candidates for this specific clip. */
  hookText: string | null;
}

// ---------------------------------------------------------------------------
// Reframing
// ---------------------------------------------------------------------------

/** A detected region of interest in one video frame, in normalized [0,1] coords. */
export interface RegionOfInterest {
  time: number;
  x: number;
  y: number;
  width: number;
  height: number;
  /** Detector confidence in `[0, 1]`. */
  confidence: number;
  kind: 'face' | 'person' | 'object' | 'saliency' | 'motion';
  /** Stable identity across frames when the detector tracks subjects. */
  trackId?: string;
}

/** One keyframe of the animated crop window, in source pixel coordinates. */
export interface CropKeyframe {
  time: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ReframePlan {
  targetAspect: number;
  sourceWidth: number;
  sourceHeight: number;
  keyframes: CropKeyframe[];
  /** True when no ROI was found and the plan falls back to a static centre crop. */
  isStaticFallback: boolean;
}

// ---------------------------------------------------------------------------
// Captions
// ---------------------------------------------------------------------------

export type CaptionAnimation = 'none' | 'pop' | 'fade' | 'slide-up' | 'typewriter' | 'karaoke';

export interface CaptionToken {
  text: string;
  start: number;
  end: number;
  /** Rendered in the accent colour and scaled up when true. */
  highlight: boolean;
}

export interface CaptionCue {
  index: number;
  start: number;
  end: number;
  text: string;
  tokens: CaptionToken[];
}

export interface CaptionStyle {
  fontFamily: string;
  fontSizePx: number;
  primaryColor: string;
  highlightColor: string;
  outlineColor: string;
  outlineWidth: number;
  shadow: number;
  bold: boolean;
  uppercase: boolean;
  /** Vertical placement as a fraction of frame height from the top. */
  positionY: number;
  animation: CaptionAnimation;
  maxCharsPerLine: number;
  maxLines: number;
}

// ---------------------------------------------------------------------------
// Motion, transitions, music
// ---------------------------------------------------------------------------

export type MotionKind = 'none' | 'zoom-in' | 'zoom-out' | 'push' | 'ken-burns' | 'shake';
export type TransitionKind = 'cut' | 'fade' | 'dip-to-black' | 'whip' | 'slide' | 'zoom-blur';

export interface MotionCue {
  start: number;
  end: number;
  kind: MotionKind;
  /** Peak scale factor, e.g. 1.08 for a subtle 8% push. */
  intensity: number;
  reason: string;
}

export interface TransitionCue {
  /** Output-timeline position of the boundary this transition covers. */
  at: number;
  kind: TransitionKind;
  durationSec: number;
}

export interface MusicCue {
  trackId: string;
  title: string;
  /** Licence identifier; the library only ships copyright-safe tracks. */
  license: string;
  startAt: number;
  gainDb: number;
  /** Sidechain ducking depth in dB applied while narration is present. */
  duckDb: number;
  fadeInSec: number;
  fadeOutSec: number;
}

// ---------------------------------------------------------------------------
// Audio & video enhancement
// ---------------------------------------------------------------------------

export interface AudioPlan {
  denoise: boolean;
  denoiseStrength: number;
  /** Target integrated loudness in LUFS. -14 suits most social platforms. */
  targetLufs: number;
  targetTruePeakDb: number;
  loudnessRangeLu: number;
  deEss: boolean;
  highPassHz: number | null;
  compressorRatio: number | null;
  notes: string[];
}

export interface VideoEnhancePlan {
  denoise: boolean;
  sharpen: number;
  saturation: number;
  contrast: number;
  brightness: number;
  /** Upscale target, or null to keep the source resolution. */
  upscaleTo: { width: number; height: number } | null;
  notes: string[];
}

// ---------------------------------------------------------------------------
// The assembled edit plan
// ---------------------------------------------------------------------------

export interface EditPlan {
  version: 1;
  sourceDurationSec: number;
  cutPlan: CutPlan;
  moments: Moment[];
  variations: ClipVariation[];
  reframe: ReframePlan | null;
  captions: CaptionCue[];
  captionStyle: CaptionStyle;
  motion: MotionCue[];
  transitions: TransitionCue[];
  music: MusicCue | null;
  audio: AudioPlan;
  video: VideoEnhancePlan;
}

// ---------------------------------------------------------------------------
// Export presets
// ---------------------------------------------------------------------------

export type AspectRatio = '9:16' | '1:1' | '4:5' | '16:9';

export interface ExportPreset {
  id: string;
  label: string;
  aspect: AspectRatio;
  width: number;
  height: number;
  fps: number;
  videoBitrateKbps: number;
  audioBitrateKbps: number;
  container: 'mp4' | 'webm' | 'mov';
  videoCodec: 'h264' | 'hevc' | 'vp9';
  /** Constant Rate Factor; lower means higher quality. */
  crf: number;
}

// ---------------------------------------------------------------------------
// Generated content
// ---------------------------------------------------------------------------

export type ContentNiche =
  | 'scary-story'
  | 'mystery'
  | 'reddit-story'
  | 'educational'
  | 'motivational'
  | 'gaming'
  | 'football'
  | 'history'
  | 'finance'
  | 'business'
  | 'technology'
  | 'science'
  | 'documentary'
  | 'product-review'
  | 'news-summary'
  | 'storytelling';

export interface ScriptScene {
  index: number;
  /** Narration for this scene, already tuned for spoken delivery. */
  narration: string;
  /** What should be on screen; drives B-roll and image generation. */
  visual: string;
  /** Search terms for the stock library. */
  brollQueries: string[];
  estimatedDurationSec: number;
  /** Optional on-screen text overlay for this beat. */
  overlayText?: string;
}

export interface GeneratedContent {
  title: string;
  /** Alternative titles the user can swap in. */
  titleVariants: string[];
  hook: string;
  hookVariants: string[];
  script: string;
  scenes: ScriptScene[];
  description: string;
  hashtags: string[];
  callToAction: string;
  /** Suggested thumbnail concepts, described for a human or an image model. */
  thumbnailIdeas: string[];
  estimatedDurationSec: number;
  niche: ContentNiche;
}

// ---------------------------------------------------------------------------
// Viral optimizer
// ---------------------------------------------------------------------------

export type OptimizationArea =
  | 'hook'
  | 'pacing'
  | 'retention'
  | 'captions'
  | 'audio'
  | 'visual'
  | 'title'
  | 'thumbnail'
  | 'hashtags'
  | 'cta'
  | 'length'
  | 'accessibility';

export type SuggestionImpact = 'high' | 'medium' | 'low';

export interface Suggestion {
  id: string;
  area: OptimizationArea;
  title: string;
  detail: string;
  impact: SuggestionImpact;
  /** Estimated score delta in points if applied, in `[0, 100]` space. */
  scoreDelta: number;
  /** Machine-applicable change, when the suggestion can be auto-applied. */
  action?: SuggestionAction;
  /** Where in the timeline this applies, when it is time-bound. */
  range?: TimeRange;
  /** Evidence the rule fired on, shown to keep the AI transparent. */
  evidence: string[];
}

export type SuggestionAction =
  | { kind: 'replace-title'; value: string }
  | { kind: 'replace-hook'; value: string }
  | { kind: 'set-cta'; value: string }
  | { kind: 'set-hashtags'; value: string[] }
  | { kind: 'trim-to'; value: number }
  | { kind: 'set-caption-style'; value: Partial<CaptionStyle> }
  | { kind: 'add-cut'; value: TimeRange }
  | { kind: 'set-speed'; value: number };

export interface OptimizationReport {
  /** Overall readiness score in `[0, 100]`. */
  score: number;
  subScores: Record<OptimizationArea, number>;
  suggestions: Suggestion[];
  /** Plain-language summary of the biggest wins. */
  summary: string;
  generatedAt: string;
}

// ---------------------------------------------------------------------------
// Social platforms
// ---------------------------------------------------------------------------

export type PlatformId =
  | 'tiktok'
  | 'youtube'
  | 'instagram'
  | 'facebook'
  | 'linkedin'
  | 'pinterest'
  | 'x';

export interface PlatformCapabilities {
  maxDurationSec: number;
  minDurationSec: number;
  maxFileBytes: number;
  aspectRatios: AspectRatio[];
  maxTitleChars: number | null;
  maxDescriptionChars: number;
  maxHashtags: number;
  supportsScheduling: boolean;
  supportsDrafts: boolean;
  /** Whether the platform's public API exposes per-post analytics. */
  supportsAnalytics: boolean;
  containers: string[];
}

export type PostStatus =
  | 'draft'
  | 'queued'
  | 'scheduled'
  | 'uploading'
  | 'processing'
  | 'published'
  | 'failed'
  | 'cancelled';

// ---------------------------------------------------------------------------
// Analytics
// ---------------------------------------------------------------------------

export interface PostMetrics {
  views: number;
  likes: number;
  comments: number;
  shares: number;
  saves: number;
  /** Total watch time in seconds across all viewers. */
  watchTimeSec: number;
  averageViewDurationSec: number;
  /** Fraction of viewers who reached the end, in `[0, 1]`. */
  completionRate: number;
  followersGained: number;
  impressions: number;
  /** Retention sampled at deciles of the video, each in `[0, 1]`. */
  retentionCurve: number[];
}

export interface MetricPoint {
  date: string;
  value: number;
}
