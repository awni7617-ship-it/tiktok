import { config } from '@/server/config';
import { logger } from '@/server/obs/logger';
import { credential } from '@/server/settings/store';
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
 * A key is a decision. If a creator has pasted an Anthropic key into
 * Settings, they want Claude writing their scripts — not a mock, and not a
 * second environment variable saying so. So the best available provider is
 * selected by what is actually configured, and `AI_*_PROVIDER` only matters
 * when it forces something *off*.
 *
 * The deterministic mocks remain the floor: missing credentials degrade the
 * output, never break the pipeline, and CI never needs secrets.
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

  const key = credential('anthropicApiKey', config.ANTHROPIC_API_KEY);
  const model = credential('anthropicModel', config.ANTHROPIC_MODEL);

  if (key) {
    try {
      llm = new AnthropicProvider(key, model);
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

  const openaiKey = credential('openaiApiKey', config.OPENAI_API_KEY);

  switch (openaiKey ? 'openai' : config.AI_ASR_PROVIDER) {
    case 'openai':
      asr = openaiKey
        ? new OpenAiAsrProvider(openaiKey)
        : fallback('asr', 'openai', 'no OpenAI key', new MockAsrProvider());
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

  const openaiKey = credential('openaiApiKey', config.OPENAI_API_KEY);

  switch (openaiKey ? 'openai' : config.AI_TTS_PROVIDER) {
    case 'openai':
      tts = openaiKey
        ? new OpenAiTtsProvider(openaiKey)
        : fallback('tts', 'openai', 'no OpenAI key', new MockTtsProvider());
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

  const openaiKey = credential('openaiApiKey', config.OPENAI_API_KEY);
  image = openaiKey ? new OpenAiImageProvider(openaiKey) : new MockImageProvider();

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
    llm: { configured: credential('anthropicApiKey', config.ANTHROPIC_API_KEY) ? 'anthropic' : 'mock', active: getLlm().name },
    asr: { configured: credential('openaiApiKey', config.OPENAI_API_KEY) ? 'openai' : 'mock', active: getAsr().name },
    tts: { configured: credential('openaiApiKey', config.OPENAI_API_KEY) ? 'openai' : 'mock', active: getTts().name },
    image: { configured: credential('openaiApiKey', config.OPENAI_API_KEY) ? 'openai' : 'mock', active: getImage().name },
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
