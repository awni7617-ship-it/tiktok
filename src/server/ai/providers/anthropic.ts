import Anthropic from '@anthropic-ai/sdk';
import { config } from '@/server/config';
import { logger } from '@/server/obs/logger';
import {
  AiError,
  type LlmJsonRequest,
  type LlmProvider,
  type LlmRequest,
  type LlmResponse,
  type LlmUsage,
} from '../types';

const log = logger.child({ module: 'ai:anthropic' });

/**
 * Anthropic Claude provider.
 *
 * Uses structured outputs for JSON generation rather than prompting for JSON
 * and parsing — the schema is enforced by the API, so malformed output stops
 * being a failure mode. Adaptive thinking is enabled because script writing
 * and optimization analysis both benefit from reasoning, and effort is
 * configurable so cost can be tuned per deployment.
 */
export class AnthropicProvider implements LlmProvider {
  readonly name = 'anthropic';
  private readonly client: Anthropic;
  private readonly model: string;

  constructor(apiKey?: string, model?: string) {
    const key = apiKey ?? config.ANTHROPIC_API_KEY;
    if (!key) {
      throw new AiError('ANTHROPIC_API_KEY is required for the anthropic provider', this.name, false);
    }
    this.client = new Anthropic({ apiKey: key, maxRetries: 3 });
    this.model = model ?? config.ANTHROPIC_MODEL;
  }

  async complete(request: LlmRequest): Promise<LlmResponse> {
    try {
      const response = await this.client.messages.create({
        model: this.model,
        max_tokens: request.maxTokens ?? 8000,
        system: this.buildSystem(request),
        messages: request.messages,
        thinking: { type: 'adaptive' },
        output_config: { effort: config.ANTHROPIC_EFFORT },
      });

      // Safety classifiers can decline; check before reading content.
      if (response.stop_reason === 'refusal') {
        log.warn('model declined request', { model: this.model });
        return {
          text: '',
          usage: toUsage(response.usage),
          model: response.model,
          refused: true,
        };
      }

      const text = response.content
        .filter((block): block is Anthropic.TextBlock => block.type === 'text')
        .map((block) => block.text)
        .join('\n')
        .trim();

      return { text, usage: toUsage(response.usage), model: response.model, refused: false };
    } catch (error) {
      throw wrapError(error, this.name);
    }
  }

  async completeJson<T>(request: LlmJsonRequest<T>): Promise<{ value: T; usage: LlmUsage }> {
    try {
      const response = await this.client.messages.create({
        model: this.model,
        max_tokens: request.maxTokens ?? 8000,
        system: this.buildSystem(request),
        messages: request.messages,
        thinking: { type: 'adaptive' },
        output_config: {
          effort: config.ANTHROPIC_EFFORT,
          format: { type: 'json_schema', schema: request.schema },
        },
      });

      if (response.stop_reason === 'refusal') {
        throw new AiError('Model declined to generate this content', this.name, false);
      }
      if (response.stop_reason === 'max_tokens') {
        // Structured output truncated mid-object is unparseable; retrying with
        // the same budget would truncate again, so surface it as fatal.
        throw new AiError(
          'Response hit the token limit before completing; raise maxTokens',
          this.name,
          false,
        );
      }

      const raw = response.content
        .filter((block): block is Anthropic.TextBlock => block.type === 'text')
        .map((block) => block.text)
        .join('');

      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        throw new AiError('Model returned unparseable JSON', this.name, true);
      }

      return { value: request.parse(parsed), usage: toUsage(response.usage) };
    } catch (error) {
      throw wrapError(error, this.name);
    }
  }

  async stream(request: LlmRequest, onDelta: (text: string) => void): Promise<LlmResponse> {
    try {
      const stream = this.client.messages.stream({
        model: this.model,
        max_tokens: request.maxTokens ?? 16000,
        system: this.buildSystem(request),
        messages: request.messages,
        thinking: { type: 'adaptive' },
        output_config: { effort: config.ANTHROPIC_EFFORT },
      });

      stream.on('text', onDelta);
      const message = await stream.finalMessage();

      if (message.stop_reason === 'refusal') {
        return { text: '', usage: toUsage(message.usage), model: message.model, refused: true };
      }

      const text = message.content
        .filter((block): block is Anthropic.TextBlock => block.type === 'text')
        .map((block) => block.text)
        .join('\n')
        .trim();

      return { text, usage: toUsage(message.usage), model: message.model, refused: false };
    } catch (error) {
      throw wrapError(error, this.name);
    }
  }

  /**
   * System prompts are stable across calls of the same kind, so marking them
   * cacheable turns the largest part of each request into a ~0.1x cache read.
   */
  private buildSystem(request: LlmRequest): Anthropic.TextBlockParam[] | undefined {
    if (!request.system) return undefined;
    return [
      {
        type: 'text',
        text: request.system,
        ...(request.cacheSystem ? { cache_control: { type: 'ephemeral' as const } } : {}),
      },
    ];
  }
}

function toUsage(usage: Anthropic.Usage): LlmUsage {
  return {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    cacheReadTokens: usage.cache_read_input_tokens ?? 0,
    cacheWriteTokens: usage.cache_creation_input_tokens ?? 0,
  };
}

/** Map SDK errors onto `AiError`, marking the retryable ones as such. */
function wrapError(error: unknown, provider: string): AiError {
  if (error instanceof AiError) return error;

  if (error instanceof Anthropic.RateLimitError) {
    return new AiError('Rate limited by Anthropic', provider, true, error);
  }
  if (error instanceof Anthropic.APIConnectionError) {
    return new AiError('Could not reach Anthropic', provider, true, error);
  }
  if (error instanceof Anthropic.APIError) {
    const retryable = typeof error.status === 'number' && error.status >= 500;
    return new AiError(`Anthropic API error ${error.status}: ${error.message}`, provider, retryable, error);
  }

  return new AiError(
    error instanceof Error ? error.message : 'Unknown provider error',
    provider,
    false,
    error,
  );
}
