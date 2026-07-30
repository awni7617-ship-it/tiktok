import type { Transcript } from '@/lib/types';

/**
 * Provider-agnostic AI interfaces.
 *
 * Every AI capability the product uses is expressed as a narrow interface with
 * at least two implementations: a real vendor client and a deterministic mock.
 * The mock is not a test double bolted on afterwards — it is a first-class
 * provider that lets the entire platform run offline, in CI, and in local
 * development without an API key, which is what makes the pipeline testable
 * end to end.
 */

export class AiError extends Error {
  constructor(
    message: string,
    readonly provider: string,
    readonly retryable: boolean,
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'AiError';
  }
}

// ---------------------------------------------------------------------------
// Language model
// ---------------------------------------------------------------------------

export interface LlmMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface LlmRequest {
  system?: string;
  messages: LlmMessage[];
  maxTokens?: number;
  /** Cache the system prompt across calls where the provider supports it. */
  cacheSystem?: boolean;
}

export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface LlmResponse {
  text: string;
  usage: LlmUsage;
  model: string;
  /** True when the provider declined to answer, so callers can fall back. */
  refused: boolean;
}

export interface LlmJsonRequest<T> extends LlmRequest {
  /** JSON Schema the response must satisfy. */
  schema: Record<string, unknown>;
  /** Parses and validates the provider's raw JSON into the domain type. */
  parse: (value: unknown) => T;
}

export interface LlmProvider {
  readonly name: string;
  complete(request: LlmRequest): Promise<LlmResponse>;
  /** Structured generation. Providers without native support fall back to prompting. */
  completeJson<T>(request: LlmJsonRequest<T>): Promise<{ value: T; usage: LlmUsage }>;
  /** Token-by-token streaming, used by the interactive script editor. */
  stream(request: LlmRequest, onDelta: (text: string) => void): Promise<LlmResponse>;
}

// ---------------------------------------------------------------------------
// Speech recognition
// ---------------------------------------------------------------------------

export interface AsrRequest {
  /** Local path or readable URL to the media. */
  source: string;
  /** ISO language hint; `null` asks the provider to detect. */
  language: string | null;
  /** Ask for speaker labels where supported. */
  diarize: boolean;
}

export interface AsrProvider {
  readonly name: string;
  transcribe(request: AsrRequest): Promise<Transcript>;
}

// ---------------------------------------------------------------------------
// Speech synthesis
// ---------------------------------------------------------------------------

export interface Voice {
  id: string;
  name: string;
  /** `en-US`, `en-GB`, … */
  locale: string;
  gender: 'male' | 'female' | 'neutral';
  /** Short description shown in the voice picker. */
  style: string;
  previewUrl?: string;
}

export interface TtsRequest {
  text: string;
  voiceId: string;
  /** 1 is the voice's natural pace. */
  speed: number;
  /** Output file path the provider should write to. */
  outputPath: string;
  format: 'mp3' | 'wav';
}

export interface TtsResult {
  path: string;
  durationSec: number;
  /** Word timings when the provider returns them; enables exact caption sync. */
  words?: { text: string; start: number; end: number }[];
}

export interface TtsProvider {
  readonly name: string;
  listVoices(): Promise<Voice[]>;
  synthesize(request: TtsRequest): Promise<TtsResult>;
}

// ---------------------------------------------------------------------------
// Image generation & stock media
// ---------------------------------------------------------------------------

export interface ImageRequest {
  prompt: string;
  width: number;
  height: number;
  outputPath: string;
  /** Style hint passed through to providers that accept one. */
  style?: string;
}

export interface ImageResult {
  path: string;
  width: number;
  height: number;
}

export interface ImageProvider {
  readonly name: string;
  generate(request: ImageRequest): Promise<ImageResult>;
}

export interface StockAsset {
  id: string;
  kind: 'video' | 'image';
  title: string;
  url: string;
  thumbnailUrl: string;
  durationSec: number | null;
  width: number;
  height: number;
  license: string;
  attribution: string | null;
}

export interface StockProvider {
  readonly name: string;
  search(query: string, options: { kind?: 'video' | 'image'; limit?: number }): Promise<StockAsset[]>;
}

// ---------------------------------------------------------------------------
// Vision / region detection
// ---------------------------------------------------------------------------

export interface RoiDetector {
  readonly name: string;
  /**
   * Detect faces and salient regions across a video.
   * `sampleFps` controls the trade-off between tracking accuracy and cost.
   */
  detect(source: string, options: { sampleFps: number; durationSec: number }): Promise<
    import('@/lib/types').RegionOfInterest[]
  >;
}
