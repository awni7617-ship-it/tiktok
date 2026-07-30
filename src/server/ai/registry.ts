import { config } from '@/server/config';
import { logger } from '@/server/obs/logger';
import { AiError, type AsrProvider, type ImageProvider, type LlmProvider, type RoiDetector, type StockProvider, type TtsProvider } from './types';
import {
  MockAsrProvider,
  MockImageProvider,
  MockLlmProvider,
  MockRoiDetector,
  MockStockProvider,
  MockTtsProvider,
} from './providers/mock';
import { AnthropicProvider } from './providers/anthropic';
import { OpenAiAsrProvider, OpenAiImageProvider, OpenAiTtsProvider } from './providers/openai';

const log = logger.child({ module: 'ai:registry' });

/**
 * Provider registry.
 *
 * Resolves the configured provider for each capability, falling back to the
 * deterministic mock when credentials are missing. The fallback is logged
 * loudly but never throws: a creator who has not configured a transcription
 * key should still be able to explore the whole product, and CI should never
 * need secrets.
 */

let llm: LlmProvider | null = null;
let asr: AsrProvider | null = null;
let tts: TtsProvider | null = null;
let image: ImageProvider | null = null;
let stock: StockProvider | null = null;
let roi: RoiDetector | null = null;

function fallback<T>(capability: string, requested: string, reason: string, mock: T): T {
  log.warn('falling back to the mock provider', { capability, requested, reason });
  return mock;
}

export function getLlm(): LlmProvider {
  if (llm) return llm;

  if (config.AI_LLM_PROVIDER === 'anthropic') {
    try {
      llm = new AnthropicProvider();
    } catch (error) {
      llm = fallback(
        'llm',
        'anthropic',
        error instanceof AiError ? error.message : 'initialisation failed',
        new MockLlmProvider(),
      );
    }
  } else {
    llm = new MockLlmProvider();
  }

  return llm;
}

export function getAsr(): AsrProvider {
  if (asr) return asr;

  switch (config.AI_ASR_PROVIDER) {
    case 'openai':
      asr = config.OPENAI_API_KEY
        ? new OpenAiAsrProvider()
        : fallback('asr', 'openai', 'OPENAI_API_KEY not set', new MockAsrProvider());
      break;
    case 'deepgram':
      // Deepgram is configured but not yet implemented; the mock keeps the
      // pipeline running rather than failing the whole upload.
      asr = fallback('asr', 'deepgram', 'provider not implemented', new MockAsrProvider());
      break;
    default:
      asr = new MockAsrProvider();
  }

  return asr;
}

export function getTts(): TtsProvider {
  if (tts) return tts;

  switch (config.AI_TTS_PROVIDER) {
    case 'openai':
      tts = config.OPENAI_API_KEY
        ? new OpenAiTtsProvider()
        : fallback('tts', 'openai', 'OPENAI_API_KEY not set', new MockTtsProvider());
      break;
    case 'elevenlabs':
      tts = fallback('tts', 'elevenlabs', 'provider not implemented', new MockTtsProvider());
      break;
    default:
      tts = new MockTtsProvider();
  }

  return tts;
}

export function getImage(): ImageProvider {
  if (image) return image;

  image =
    config.AI_IMAGE_PROVIDER === 'openai' && config.OPENAI_API_KEY
      ? new OpenAiImageProvider()
      : new MockImageProvider();

  return image;
}

export function getStock(): StockProvider {
  stock ??= new MockStockProvider();
  return stock;
}

export function getRoiDetector(): RoiDetector {
  roi ??= new MockRoiDetector();
  return roi;
}

/** Reset cached providers. Used by tests and by the settings screen. */
export function resetProviders(): void {
  llm = null;
  asr = null;
  tts = null;
  image = null;
  stock = null;
  roi = null;
}

/** Allow tests and self-hosted deployments to inject their own implementations. */
export function registerProviders(overrides: {
  llm?: LlmProvider;
  asr?: AsrProvider;
  tts?: TtsProvider;
  image?: ImageProvider;
  stock?: StockProvider;
  roi?: RoiDetector;
}): void {
  if (overrides.llm) llm = overrides.llm;
  if (overrides.asr) asr = overrides.asr;
  if (overrides.tts) tts = overrides.tts;
  if (overrides.image) image = overrides.image;
  if (overrides.stock) stock = overrides.stock;
  if (overrides.roi) roi = overrides.roi;
}

/** Which provider is actually serving each capability, for the settings UI. */
export function describeProviders(): Record<string, { configured: string; active: string }> {
  return {
    llm: { configured: config.AI_LLM_PROVIDER, active: getLlm().name },
    asr: { configured: config.AI_ASR_PROVIDER, active: getAsr().name },
    tts: { configured: config.AI_TTS_PROVIDER, active: getTts().name },
    image: { configured: config.AI_IMAGE_PROVIDER, active: getImage().name },
  };
}

/**
 * Retry helper for AI calls.
 *
 * Only retries errors the provider marked retryable — a schema validation
 * failure or a refusal will never succeed on a second attempt, and retrying
 * them just burns quota and latency.
 */
export async function withRetry<T>(
  operation: () => Promise<T>,
  options: { attempts?: number; baseDelayMs?: number; label?: string } = {},
): Promise<T> {
  const attempts = options.attempts ?? 3;
  const baseDelay = options.baseDelayMs ?? 500;
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      const retryable = error instanceof AiError ? error.retryable : false;
      if (!retryable || attempt === attempts) break;

      // Exponential backoff with jitter so retries do not synchronise.
      const delay = baseDelay * 2 ** (attempt - 1) * (0.7 + Math.random() * 0.6);
      log.warn('retrying AI call', {
        label: options.label,
        attempt,
        delayMs: Math.round(delay),
      });
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  throw lastError;
}
