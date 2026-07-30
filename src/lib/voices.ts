import type { Voice } from '@/server/ai/types';

/**
 * Voice catalogue.
 *
 * Lives in `lib` rather than beside the TTS provider because the voice picker
 * is a client component: importing it from the provider module would drag
 * `node:zlib` and friends into the browser bundle.
 */
export const VOICES: Voice[] = [
  { id: 'voice_atlas', name: 'Atlas', locale: 'en-US', gender: 'male', style: 'Deep, documentary narrator' },
  { id: 'voice_nova', name: 'Nova', locale: 'en-US', gender: 'female', style: 'Bright, conversational' },
  { id: 'voice_ember', name: 'Ember', locale: 'en-GB', gender: 'female', style: 'Warm, storytelling' },
  { id: 'voice_slate', name: 'Slate', locale: 'en-GB', gender: 'male', style: 'Calm, explainer' },
  { id: 'voice_pulse', name: 'Pulse', locale: 'en-US', gender: 'neutral', style: 'Fast, high-energy' },
  { id: 'voice_hollow', name: 'Hollow', locale: 'en-US', gender: 'male', style: 'Low, unsettling' },
];
