import Anthropic from '@anthropic-ai/sdk';
import { parseScript } from './schema';
import { scriptSystemPrompt, scriptUserPrompt } from './prompts';
import type { ScriptProvider, ScriptRequest } from './types';
import type { Script } from '@/lib/types';

/**
 * Script generation via Claude.
 *
 * Sonnet rather than Opus: these are short, tightly specified scripts produced
 * several times a day, and the brief does most of the heavy lifting. Override
 * with `ANTHROPIC_MODEL` if you want something else.
 */
const DEFAULT_MODEL = 'claude-sonnet-5';

export class AnthropicScriptProvider implements ScriptProvider {
  readonly name = 'anthropic';
  private readonly client: Anthropic;
  private readonly model: string;

  constructor(apiKey: string) {
    this.client = new Anthropic({ apiKey });
    this.model = process.env.ANTHROPIC_MODEL?.trim() || DEFAULT_MODEL;
  }

  async write(request: ScriptRequest): Promise<Script> {
    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: 2000,
      system: scriptSystemPrompt(),
      messages: [{ role: 'user', content: scriptUserPrompt(request) }],
    });

    const text = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === 'text')
      .map((block) => block.text)
      .join('');

    if (!text.trim()) throw new Error('Claude returned an empty response');

    return parseScript(text);
  }
}
