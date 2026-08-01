import { getSettings } from '../store/db';
import { artStyle } from '@/lib/catalog';
import { AnthropicScriptProvider } from './anthropic';
import { OfflineImageProvider, OfflineScriptProvider, OfflineVoiceProvider } from './offline';
import { OpenAIImageProvider, OpenAIVoiceProvider } from './openai';
import type { ImageProvider, ScriptProvider, VoiceProvider } from './types';

/**
 * Which provider serves each capability.
 *
 * Resolution is per-call rather than cached at boot, so adding a key in
 * Settings takes effect on the next video with no restart. Stored keys win
 * over environment variables — the UI is the thing a user can actually reach.
 */

function anthropicKey(settings: { anthropicApiKey: string | null }): string | null {
  return settings.anthropicApiKey?.trim() || process.env.ANTHROPIC_API_KEY?.trim() || null;
}

function openaiKey(settings: { openaiApiKey: string | null }): string | null {
  return settings.openaiApiKey?.trim() || process.env.OPENAI_API_KEY?.trim() || null;
}

export async function scriptProvider(): Promise<ScriptProvider> {
  const settings = await getSettings();
  const key = anthropicKey(settings);
  return key ? new AnthropicScriptProvider(key) : new OfflineScriptProvider();
}

export async function voiceProvider(): Promise<VoiceProvider> {
  const settings = await getSettings();
  const key = openaiKey(settings);
  return key ? new OpenAIVoiceProvider(key) : new OfflineVoiceProvider();
}

export async function imageProvider(styleId: string): Promise<ImageProvider> {
  const settings = await getSettings();
  const key = openaiKey(settings);
  if (key) return new OpenAIImageProvider(key);
  const style = artStyle(styleId);
  return new OfflineImageProvider(style?.gradient ?? ['#1b2735', '#4a6fa5']);
}

/** Names only, for the settings screen. */
export async function providerNames(): Promise<{ script: string; voice: string; image: string }> {
  const settings = await getSettings();
  const hasAnthropic = Boolean(anthropicKey(settings));
  const hasOpenAI = Boolean(openaiKey(settings));
  return {
    script: hasAnthropic ? 'anthropic' : 'offline',
    voice: hasOpenAI ? 'openai' : 'offline',
    image: hasOpenAI ? 'openai' : 'offline',
  };
}
