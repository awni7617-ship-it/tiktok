import type { Script } from '@/lib/types';

/**
 * Provider interfaces.
 *
 * Every capability has an offline implementation that produces genuine output
 * — a parseable script, a real WAV, a real PNG — so the whole pipeline runs
 * end to end before any key is configured. That is what makes "install it and
 * press go" work, and it is also what lets the test suite exercise the real
 * code path instead of a mock of it.
 */

export interface ScriptRequest {
  /** The topic. Either the user's idea or one autopilot picked. */
  idea: string;
  /** Niche brief, steering subject matter and tone. */
  brief: string;
  /** Seconds of finished video to aim for. */
  targetSeconds: number;
}

export interface ScriptProvider {
  readonly name: string;
  write(request: ScriptRequest): Promise<Script>;
}

export interface VoiceRequest {
  text: string;
  /** Catalog voice id, mapped to the provider's own voice name. */
  voiceId: string;
  /** Absolute path to write the audio to. */
  outFile: string;
}

export interface VoiceProvider {
  readonly name: string;
  /** Writes audio to `outFile` and returns its measured duration in seconds. */
  speak(request: VoiceRequest): Promise<number>;
}

export interface ImageRequest {
  prompt: string;
  /** Art-style suffix appended to the prompt. */
  style: string;
  /** Absolute path to write the PNG to. */
  outFile: string;
  /** Deterministic offline output needs a seed; real models ignore it. */
  seed: number;
}

export interface ImageProvider {
  readonly name: string;
  draw(request: ImageRequest): Promise<void>;
}

/** Vertical short-form, the only aspect these platforms take full-screen. */
export const FRAME_WIDTH = 1080;
export const FRAME_HEIGHT = 1920;
