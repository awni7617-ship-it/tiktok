import { createReadStream } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Transcript, TranscriptSegment, TranscriptWord } from '@/lib/types';
import { round } from '@/lib/time';
import { config } from '@/server/config';
import { credential } from '@/server/settings/store';
import {
  AiError,
  type AsrProvider,
  type AsrRequest,
  type ImageProvider,
  type ImageRequest,
  type ImageResult,
  type TtsProvider,
  type TtsRequest,
  type TtsResult,
  type Voice,
} from '../types';

/**
 * OpenAI-compatible providers for speech-to-text, text-to-speech and images.
 *
 * Written against the OpenAI REST shape rather than the SDK so it also works
 * with the many compatible endpoints (Groq, local Whisper servers, LiteLLM)
 * by changing `OPENAI_BASE_URL` alone.
 */

function requireKey(explicit?: string): string {
  // Settings first: a key pasted into the app is the user's current intent,
  // and it must win over whatever the environment was started with.
  const key = explicit ?? credential('openaiApiKey', config.OPENAI_API_KEY);
  if (!key) throw new AiError('An OpenAI API key is required', 'openai', false);
  return key;
}

async function request(endpoint: string, init: RequestInit, key?: string): Promise<Response> {
  const response = await fetch(`${config.OPENAI_BASE_URL}${endpoint}`, {
    ...init,
    headers: { Authorization: `Bearer ${requireKey(key)}`, ...(init.headers ?? {}) },
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    // 408/409/429 and 5xx are worth another attempt; 4xx generally is not.
    const retryable = response.status === 429 || response.status >= 500;
    throw new AiError(
      `OpenAI ${endpoint} failed with ${response.status}: ${body.slice(0, 400)}`,
      'openai',
      retryable,
    );
  }

  return response;
}

export class OpenAiAsrProvider implements AsrProvider {
  /** Key from the settings screen, when the registry has one. */
  constructor(private readonly apiKey?: string) {}

  readonly name = 'openai';

  /**
   * Transcribe with word-level timestamps.
   *
   * `verbose_json` + `timestamp_granularities[]=word` is what gives us the
   * per-word timings the caption builder and silence detector depend on; the
   * plain `json` response format is not sufficient.
   */
  async transcribe(req: AsrRequest): Promise<Transcript> {
    const form = new FormData();
    const file = await fileFromPath(req.source);
    form.append('file', file);
    form.append('model', 'whisper-1');
    form.append('response_format', 'verbose_json');
    form.append('timestamp_granularities[]', 'word');
    form.append('timestamp_granularities[]', 'segment');
    if (req.language) form.append('language', req.language);

    const response = await request('/audio/transcriptions', { method: 'POST', body: form }, this.apiKey);
    return parseWhisperResponse(await response.json());
  }
}

/** Convert Whisper's `verbose_json` into our transcript shape. */
export function parseWhisperResponse(payload: unknown): Transcript {
  const data = payload as {
    language?: string;
    duration?: number;
    text?: string;
    words?: { word: string; start: number; end: number }[];
    segments?: { start: number; end: number; text: string }[];
  };

  const words: TranscriptWord[] = (data.words ?? []).map((word) => ({
    text: word.word,
    start: round(word.start),
    end: round(word.end),
    // Whisper does not return per-word confidence; assume high and let the
    // downstream filters rely on timing rather than confidence.
    confidence: 0.9,
  }));

  const segments: TranscriptSegment[] = (data.segments ?? []).map((segment) => ({
    start: round(segment.start),
    end: round(segment.end),
    text: segment.text.trim(),
    words: words.filter((word) => word.start >= segment.start - 0.01 && word.end <= segment.end + 0.01),
  }));

  // Some compatible servers omit segments; fall back to one segment per file.
  if (segments.length === 0 && data.text) {
    segments.push({
      start: 0,
      end: data.duration ?? (words[words.length - 1]?.end ?? 0),
      text: data.text.trim(),
      words,
    });
  }

  return {
    language: data.language ?? 'en',
    durationSec: round(data.duration ?? words[words.length - 1]?.end ?? 0),
    segments,
    words,
  };
}

const OPENAI_VOICES: Voice[] = [
  { id: 'alloy', name: 'Alloy', locale: 'en-US', gender: 'neutral', style: 'Balanced, neutral' },
  { id: 'echo', name: 'Echo', locale: 'en-US', gender: 'male', style: 'Clear, measured' },
  { id: 'fable', name: 'Fable', locale: 'en-GB', gender: 'neutral', style: 'Expressive storyteller' },
  { id: 'onyx', name: 'Onyx', locale: 'en-US', gender: 'male', style: 'Deep, authoritative' },
  { id: 'nova', name: 'Nova', locale: 'en-US', gender: 'female', style: 'Bright, energetic' },
  { id: 'shimmer', name: 'Shimmer', locale: 'en-US', gender: 'female', style: 'Soft, warm' },
];

export class OpenAiTtsProvider implements TtsProvider {
  /** Key from the settings screen, when the registry has one. */
  constructor(private readonly apiKey?: string) {}

  readonly name = 'openai';

  async listVoices(): Promise<Voice[]> {
    return OPENAI_VOICES;
  }

  async synthesize(req: TtsRequest): Promise<TtsResult> {
    const response = await request('/audio/speech', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'tts-1-hd',
        input: req.text,
        voice: req.voiceId,
        speed: Math.min(4, Math.max(0.25, req.speed)),
        response_format: req.format === 'wav' ? 'wav' : 'mp3',
      }),
    }, this.apiKey);

    const buffer = Buffer.from(await response.arrayBuffer());
    await mkdir(path.dirname(req.outputPath), { recursive: true });
    await writeFile(req.outputPath, buffer);

    // The endpoint returns no duration; the caller probes the file instead.
    return { path: req.outputPath, durationSec: 0 };
  }
}

export class OpenAiImageProvider implements ImageProvider {
  /** Key from the settings screen, when the registry has one. */
  constructor(private readonly apiKey?: string) {}

  readonly name = 'openai';

  async generate(req: ImageRequest): Promise<ImageResult> {
    const response = await request('/images/generations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-image-1',
        prompt: req.style ? `${req.prompt}. Style: ${req.style}` : req.prompt,
        size: nearestSupportedSize(req.width, req.height),
        n: 1,
      }),
    }, this.apiKey);

    const payload = (await response.json()) as { data?: { b64_json?: string; url?: string }[] };
    const entry = payload.data?.[0];
    if (!entry) throw new AiError('Image provider returned no data', 'openai', true);

    const buffer = entry.b64_json
      ? Buffer.from(entry.b64_json, 'base64')
      : Buffer.from(await (await fetch(entry.url!)).arrayBuffer());

    await mkdir(path.dirname(req.outputPath), { recursive: true });
    await writeFile(req.outputPath, buffer);

    return { path: req.outputPath, width: req.width, height: req.height };
  }
}

/** The API only accepts a fixed set of sizes; choose the closest aspect. */
export function nearestSupportedSize(width: number, height: number): string {
  const target = width / height;
  const options: [string, number][] = [
    ['1024x1024', 1],
    ['1024x1536', 1024 / 1536],
    ['1536x1024', 1536 / 1024],
  ];

  return options.reduce((best, option) =>
    Math.abs(option[1] - target) < Math.abs(best[1] - target) ? option : best,
  )[0];
}

async function fileFromPath(source: string): Promise<File> {
  if (/^https?:\/\//.test(source)) {
    const response = await fetch(source);
    if (!response.ok) {
      throw new AiError(`Could not fetch media from ${source}`, 'openai', true);
    }
    return new File([await response.arrayBuffer()], path.basename(new URL(source).pathname) || 'audio');
  }

  const chunks: Buffer[] = [];
  for await (const chunk of createReadStream(source)) {
    chunks.push(chunk as Buffer);
  }
  return new File([Buffer.concat(chunks)], path.basename(source));
}
